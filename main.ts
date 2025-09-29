// main.ts - Enhanced Viwoods Notes Importer Plugin for Obsidian

import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    Notice,
    TFile,
    TFolder,
    normalizePath,
    Modal,
    DropdownComponent,
    TextComponent,
    ButtonComponent
} from 'obsidian';

// Import JSZip - you'll need to add this to your package.json
declare global {
    interface Window {
        JSZip: any;
    }
}

// ============================================================================
// INTERFACES AND TYPES
// ============================================================================

// Update the ImportManifest interface to store original hashes
interface ImportManifest {
    bookName: string;
    totalPages: number;
    importedPages: {
        [pageNumber: number]: {
            fileName: string;
            importDate: string;
            imageHash: string; // This is the hash of the ORIGINAL unprocessed image
            displayImageHash?: string; // Optional: hash of the processed display image
            geminiProcessed: boolean;
            hasAudio?: boolean;
            lastModified?: string;
            size?: number;
            backgroundColor?: string; // Track what background was applied
        }
    };
    lastImport: string;
    sourceFile: string;
    version: string;
    history?: ImportHistory[];
}

interface ImportHistory {
    date: string;
    action: 'import' | 'update' | 'delete';
    pages: number[];
    summary: string;
}

interface PageData {
    pageNum: number;
    image: {
        blob: Blob;
        hash: string;
    };
    stroke?: any;
    audio?: {
        blob: Blob;
        originalName: string;
        name: string;
    };
}

interface BookResult {
    bookName: string;
    metadata: any;
    pages: PageData[];
    thumbnail: Blob | null;
}

interface PageChange {
    pageNum: number;
    type: 'new' | 'modified' | 'unchanged' | 'deleted';
    oldHash?: string;
    newHash?: string;
    hasAudioChange?: boolean;
}

interface ImportSummary {
    totalPages: number;
    newPages: number[];
    modifiedPages: number[];
    unchangedPages: number[];
    deletedPages: number[];
    errors: { page: number; error: string }[];
}

interface ViwoodsSettings {
    notesFolder: string;
    imagesFolder: string;
    audioFolder: string;
    outputFormat: 'png' | 'svg' | 'both';
    backgroundColor: string;
    includeMetadata: boolean;
    includeTimestamps: boolean;
    includeThumbnails: boolean;
    createIndex: boolean;
    dateFormat: 'iso' | 'us' | 'eu';
    filePrefix: string;
    processWithGemini: boolean;
    organizationMode: 'flat' | 'book';
    skipDuplicates: boolean;
    overwriteExisting: boolean;
    createBackups: boolean;
    batchSize: number;
    enableProgressBar: boolean;
    autoDetectChanges: boolean;
    keepHistory: boolean;
    maxHistoryEntries: number;
}

const DEFAULT_SETTINGS: ViwoodsSettings = {
    notesFolder: 'Viwoods Notes',
    imagesFolder: 'Images',
    audioFolder: 'Audio',
    outputFormat: 'png',
    backgroundColor: '#FFFFFF',
    includeMetadata: true,
    includeTimestamps: true,
    includeThumbnails: false,
    createIndex: true,
    dateFormat: 'iso',
    filePrefix: '',
    processWithGemini: false,
    organizationMode: 'book',
    skipDuplicates: true,
    overwriteExisting: false,
    createBackups: true,
    batchSize: 10,
    enableProgressBar: true,
    autoDetectChanges: true,
    keepHistory: true,
    maxHistoryEntries: 50
};

// ============================================================================
// MODAL CLASSES (Must be defined before the main plugin class)
// ============================================================================

// Enhanced Import Modal with search and filtering
class EnhancedImportModal extends Modal {
    bookResult: BookResult;
    existingManifest: ImportManifest | null;
    analysis: { changes: PageChange[], summary: ImportSummary } | null;
    settings: ViwoodsSettings;
    onChoose: (pages: number[]) => void;
    checkboxes: Map<number, HTMLInputElement> = new Map();
    
    constructor(
        app: App, 
        bookResult: BookResult, 
        existingManifest: ImportManifest | null,
        analysis: { changes: PageChange[], summary: ImportSummary } | null,
        settings: ViwoodsSettings
    ) {
        super(app);
        this.bookResult = bookResult;
        this.existingManifest = existingManifest;
        this.analysis = analysis;
        this.settings = settings;
        this.onChoose = () => {};
    }
    
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.classList.add('viwoods-import-modal');
        
        this.titleEl.setText(`Import: ${this.bookResult.bookName}`);
        
        // Show analysis if available
        if (this.analysis) {
            const analysisDiv = contentEl.createDiv({ cls: 'import-analysis' });
            analysisDiv.style.cssText = 'padding: 15px; background: var(--background-secondary); border-radius: 8px; margin-bottom: 15px;';
            
            analysisDiv.innerHTML = `
                <h3>📊 Change Analysis</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
                    <div>🆕 New pages: <strong>${this.analysis.summary.newPages.length}</strong></div>
                    <div>🔄 Modified pages: <strong>${this.analysis.summary.modifiedPages.length}</strong></div>
                    <div>✓ Unchanged pages: <strong>${this.analysis.summary.unchangedPages.length}</strong></div>
                    <div>❌ Deleted pages: <strong>${this.analysis.summary.deletedPages.length}</strong></div>
                </div>
            `;
            
            if (this.analysis.summary.deletedPages.length > 0) {
                analysisDiv.createEl('p', {
                    text: `⚠️ Note: ${this.analysis.summary.deletedPages.length} pages exist locally but not in this import file.`,
                    cls: 'mod-warning'
                });
            }
        } else {
            // Basic statistics
            const stats = contentEl.createDiv({ cls: 'import-stats' });
            stats.style.cssText = 'padding: 15px; background: var(--background-secondary); border-radius: 8px; margin-bottom: 15px;';
            
            const existingPages = this.existingManifest 
                ? Object.keys(this.existingManifest.importedPages).length 
                : 0;
            
            stats.innerHTML = `
                <h3>📚 ${this.bookResult.bookName}</h3>
                <p>📄 Total pages in file: ${this.bookResult.pages.length}</p>
                <p>✅ Already imported: ${existingPages}</p>
                <p>🎙️ Pages with audio: ${this.bookResult.pages.filter(p => p.audio).length}</p>
            `;
        }
        
        // Import mode selector
        const modeContainer = contentEl.createDiv();
        modeContainer.createEl('label', { text: 'Import mode:' });
        
        const importMode = modeContainer.createEl('select', { cls: 'dropdown' }) as HTMLSelectElement;
        importMode.style.cssText = 'width: 100%; margin: 10px 0;';
        
        // Determine default selection based on what changed
        let defaultMode = 'all';
        
        if (this.analysis) {
            const hasNew = this.analysis.summary.newPages.length > 0;
            const hasModified = this.analysis.summary.modifiedPages.length > 0;
            
            if (hasNew && hasModified) {
                defaultMode = 'new-and-modified';
            } else if (hasNew) {
                defaultMode = 'new';
            } else if (hasModified) {
                defaultMode = 'modified';
            } else {
                // Nothing changed - don't default to importing everything
                defaultMode = 'none';
            }
        }
        
        // Add options based on what's available
        if (this.analysis && this.analysis.summary.newPages.length > 0) {
            const option = importMode.createEl('option', { 
                value: 'new', 
                text: `Import new pages only (${this.analysis.summary.newPages.length} pages)` 
            });
            if (defaultMode === 'new') option.selected = true;
        }
        
        if (this.analysis && this.analysis.summary.modifiedPages.length > 0) {
            const option = importMode.createEl('option', { 
                value: 'modified', 
                text: `Import modified pages only (${this.analysis.summary.modifiedPages.length} pages)` 
            });
            if (defaultMode === 'modified') option.selected = true;
        }
        
        if (this.analysis && (this.analysis.summary.newPages.length > 0 || this.analysis.summary.modifiedPages.length > 0)) {
            const option = importMode.createEl('option', { 
                value: 'new-and-modified', 
                text: `Import new & modified pages (${this.analysis.summary.newPages.length + this.analysis.summary.modifiedPages.length} pages)` 
            });
            if (defaultMode === 'new-and-modified') option.selected = true;
        }
        
        // Always add "all" option, but don't select it by default unless it's first import
        const allOption = importMode.createEl('option', { 
            value: 'all', 
            text: `Import all pages (${this.bookResult.pages.length} pages)` 
        });
        
        // Only select "all" if this is first import or nothing else is selected
        if (!this.existingManifest || (defaultMode === 'all' && importMode.options.length === 1)) {
            allOption.selected = true;
        }
        
        importMode.createEl('option', { value: 'range', text: 'Import page range...' });
        importMode.createEl('option', { value: 'select', text: 'Select specific pages...' });
        
        // If nothing to import, add a "none" option and select it
        if (defaultMode === 'none' && this.analysis) {
            const noneOption = importMode.createEl('option', { 
                value: 'none', 
                text: 'No changes to import' 
            });
            noneOption.selected = true;
        }
        
        // Page range selector
        const rangeContainer = contentEl.createDiv();
        rangeContainer.style.cssText = 'display: none; margin: 10px 0;';
        
        rangeContainer.createEl('label', { text: 'Page range: ' });
        const rangeFrom = rangeContainer.createEl('input', { type: 'number' }) as HTMLInputElement;
        rangeFrom.style.cssText = 'width: 60px;';
        rangeFrom.min = '1';
        rangeFrom.max = this.bookResult.pages.length.toString();
        rangeFrom.value = '1';
        
        rangeContainer.createEl('span', { text: ' to ' });
        
        const rangeTo = rangeContainer.createEl('input', { type: 'number' }) as HTMLInputElement;
        rangeTo.style.cssText = 'width: 60px;';
        rangeTo.min = '1';
        rangeTo.max = this.bookResult.pages.length.toString();
        rangeTo.value = Math.min(10, this.bookResult.pages.length).toString();
        
        // Page selector with search
        const pageSelector = contentEl.createDiv();
        pageSelector.style.display = 'none';
        
        pageSelector.createEl('p', { text: 'Select pages to import:' });
        
        // Search bar
        const searchContainer = pageSelector.createDiv();
        searchContainer.style.cssText = 'margin: 10px 0;';
        
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search pages (e.g., "1-10", "audio", "new")...'
        }) as HTMLInputElement;
        searchInput.style.cssText = 'width: 100%; padding: 5px;';
        
        // Filter buttons
        const filterButtons = pageSelector.createDiv();
        filterButtons.style.cssText = 'margin: 10px 0; display: flex; gap: 5px; flex-wrap: wrap;';
        
        const selectAllBtn = filterButtons.createEl('button', { text: 'Select All' });
        const selectNoneBtn = filterButtons.createEl('button', { text: 'Select None' });
        const selectNewBtn = filterButtons.createEl('button', { text: 'Select New' });
        const selectModifiedBtn = filterButtons.createEl('button', { text: 'Select Modified' });
        const selectAudioBtn = filterButtons.createEl('button', { text: 'Select Audio' });
        
        // Page grid
        const pageGrid = pageSelector.createDiv();
        pageGrid.style.cssText = 'display: grid; grid-template-columns: repeat(10, 1fr); gap: 5px; max-height: 300px; overflow-y: auto; padding: 10px; background: var(--background-primary); border-radius: 5px;';
        
        for (const page of this.bookResult.pages) {
            const pageDiv = pageGrid.createDiv();
            pageDiv.style.cssText = 'text-align: center; padding: 5px;';
            
            const change = this.analysis?.changes.find(c => c.pageNum === page.pageNum);
            
            const checkbox = pageDiv.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
            checkbox.id = `page-${page.pageNum}`;
            checkbox.checked = change?.type === 'new' || change?.type === 'modified' || false;
            this.checkboxes.set(page.pageNum, checkbox);
            
            const label = pageDiv.createEl('label');
            label.setAttribute('for', `page-${page.pageNum}`);
            label.style.cssText = 'display: block; font-size: 11px; cursor: pointer;';
            
            let labelText = `${page.pageNum}`;
            if (page.audio) labelText += '🎙️';
            
            if (change) {
                switch (change.type) {
                    case 'new':
                        labelText += '🆕';
                        label.style.color = 'var(--text-accent)';
                        break;
                    case 'modified':
                        labelText += '🔄';
                        label.style.color = 'var(--text-warning)';
                        break;
                    case 'unchanged':
                        labelText += '✓';
                        label.style.opacity = '0.6';
                        break;
                }
            }
            
            label.textContent = labelText;
            
            // Add data attributes for filtering
            pageDiv.dataset.pageNum = page.pageNum.toString();
            pageDiv.dataset.hasAudio = page.audio ? 'true' : 'false';
            if (change) pageDiv.dataset.changeType = change.type;
        }
        
        // Search functionality
        searchInput.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value.toLowerCase();
            
            this.checkboxes.forEach((checkbox, pageNum) => {
                const pageDiv = checkbox.parentElement;
                if (!pageDiv) return;
                
                let visible = false;
                
                // Check page number
                if (pageNum.toString().includes(query)) {
                    visible = true;
                }
                
                // Check for ranges (e.g., "1-10")
                const rangeMatch = query.match(/(\d+)-(\d+)/);
                if (rangeMatch) {
                    const start = parseInt(rangeMatch[1]);
                    const end = parseInt(rangeMatch[2]);
                    if (pageNum >= start && pageNum <= end) {
                        visible = true;
                    }
                }
                
                // Check for keywords
                if (query.includes('audio') && pageDiv.dataset.hasAudio === 'true') {
                    visible = true;
                }
                if (query.includes('new') && pageDiv.dataset.changeType === 'new') {
                    visible = true;
                }
                if (query.includes('modified') && pageDiv.dataset.changeType === 'modified') {
                    visible = true;
                }
                
                (pageDiv as HTMLElement).style.display = visible || query === '' ? 'block' : 'none';
            });
        });
        
        // Filter button handlers
        selectAllBtn.onclick = () => {
            this.checkboxes.forEach(cb => cb.checked = true);
        };
        
        selectNoneBtn.onclick = () => {
            this.checkboxes.forEach(cb => cb.checked = false);
        };
        
        selectNewBtn.onclick = () => {
            this.checkboxes.forEach((cb, pageNum) => {
                const change = this.analysis?.changes.find(c => c.pageNum === pageNum);
                cb.checked = change?.type === 'new' || false;
            });
        };
        
        selectModifiedBtn.onclick = () => {
            this.checkboxes.forEach((cb, pageNum) => {
                const change = this.analysis?.changes.find(c => c.pageNum === pageNum);
                cb.checked = change?.type === 'modified' || false;
            });
        };
        
        selectAudioBtn.onclick = () => {
            this.checkboxes.forEach((cb, pageNum) => {
                const page = this.bookResult.pages.find(p => p.pageNum === pageNum);
                cb.checked = !!page?.audio;
            });
        };
        
        // Mode change handler
        importMode.addEventListener('change', () => {
            rangeContainer.style.display = importMode.value === 'range' ? 'block' : 'none';
            pageSelector.style.display = importMode.value === 'select' ? 'block' : 'none';
        });
        
        // Buttons
        const buttonContainer = contentEl.createDiv();
        buttonContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;';
        
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        const importBtn = buttonContainer.createEl('button', { text: 'Import', cls: 'mod-cta' });
        
        importBtn.onclick = () => {
            let pagesToImport: number[] = [];
            
            switch (importMode.value) {
                case 'new':
                    pagesToImport = this.analysis?.summary.newPages || [];
                    break;
                case 'modified':
                    pagesToImport = this.analysis?.summary.modifiedPages || [];
                    break;
                case 'new-and-modified':
                    pagesToImport = [
                        ...(this.analysis?.summary.newPages || []),
                        ...(this.analysis?.summary.modifiedPages || [])
                    ];
                    break;
                case 'all':
                    pagesToImport = this.bookResult.pages.map(p => p.pageNum);
                    break;
                case 'range':
                    const from = parseInt(rangeFrom.value);
                    const to = parseInt(rangeTo.value);
                    for (let i = from; i <= to && i <= this.bookResult.pages.length; i++) {
                        pagesToImport.push(i);
                    }
                    break;
                case 'select':
                    this.checkboxes.forEach((checkbox, pageNum) => {
                        if (checkbox.checked) {
                            pagesToImport.push(pageNum);
                        }
                    });
                    break;
                case 'none':
                    // Import nothing
                    break;
            }
            
            this.close();
            this.onChoose(pagesToImport);
        };
        
        cancelBtn.onclick = () => {
            this.close();
            this.onChoose([]);
        };
    }
}

// Progress Modal with feedback
class ProgressModal extends Modal {
    progressBar: HTMLProgressElement;
    statusText: HTMLElement;
    totalPages: number;
    
    constructor(app: App, totalPages: number) {
        super(app);
        this.totalPages = totalPages;
    }
    
    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Importing Pages' });
        
        this.statusText = contentEl.createEl('p', { text: 'Starting import...' });
        
        this.progressBar = contentEl.createEl('progress') as HTMLProgressElement;
        this.progressBar.style.cssText = 'width: 100%; height: 20px;';
        this.progressBar.max = this.totalPages;
        this.progressBar.value = 0;
        
        const progressText = contentEl.createDiv();
        progressText.style.cssText = 'text-align: center; margin-top: 10px;';
        progressText.textContent = `0 / ${this.totalPages}`;
    }
    
    updateProgress(current: number, message: string) {
        if (!this.progressBar) return;
        
        this.progressBar.value = current;
        this.statusText.textContent = message;
        
        const progressText = this.contentEl.querySelector('div');
        if (progressText) {
            progressText.textContent = `${current} / ${this.totalPages}`;
        }
    }
}

// Import Summary Modal to show results
class ImportSummaryModal extends Modal {
    summary: ImportSummary;
    backupPath: string | null;
    
    constructor(app: App, summary: ImportSummary, backupPath: string | null) {
        super(app);
        this.summary = summary;
        this.backupPath = backupPath;
    }
    
    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Import Complete' });
        
        const summaryDiv = contentEl.createDiv({ cls: 'import-summary' });
        summaryDiv.style.cssText = 'padding: 15px; background: var(--background-secondary); border-radius: 8px;';
        
        let summaryHTML = '<h3>📊 Import Summary</h3>';
        summaryHTML += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">';
        
        if (this.summary.newPages.length > 0) {
            summaryHTML += `<div>🆕 New pages: <strong>${this.summary.newPages.length}</strong></div>`;
        }
        if (this.summary.modifiedPages.length > 0) {
            summaryHTML += `<div>🔄 Modified pages: <strong>${this.summary.modifiedPages.length}</strong></div>`;
        }
        if (this.summary.unchangedPages.length > 0) {
            summaryHTML += `<div>✓ Unchanged pages: <strong>${this.summary.unchangedPages.length}</strong></div>`;
        }
        if (this.summary.errors.length > 0) {
            summaryHTML += `<div style="color: var(--text-error);">❌ Errors: <strong>${this.summary.errors.length}</strong></div>`;
        }
        
        summaryHTML += '</div>';
        summaryDiv.innerHTML = summaryHTML;
        
        // Show errors if any
        if (this.summary.errors.length > 0) {
            const errorDiv = contentEl.createDiv({ cls: 'import-errors' });
            errorDiv.style.cssText = 'margin-top: 15px; padding: 10px; background: var(--background-secondary-alt); border-radius: 5px;';
            
            errorDiv.createEl('h4', { text: 'Import Errors:' });
            const errorList = errorDiv.createEl('ul');
            
            this.summary.errors.forEach(error => {
                errorList.createEl('li', { 
                    text: `Page ${error.page}: ${error.error}` 
                });
            });
        }
        
        // Backup info
        if (this.backupPath) {
            const backupDiv = contentEl.createDiv();
            backupDiv.style.cssText = 'margin-top: 15px; padding: 10px; background: var(--background-modifier-success); border-radius: 5px;';
            backupDiv.createEl('p', { 
                text: `✅ Manifest backup created: ${this.backupPath.split('/').pop()}` 
            });
        }
        
        // OK button
        const buttonDiv = contentEl.createDiv();
        buttonDiv.style.cssText = 'display: flex; justify-content: center; margin-top: 20px;';
        
        const okBtn = buttonDiv.createEl('button', { text: 'OK', cls: 'mod-cta' });
        okBtn.onclick = () => this.close();
    }
}

// Export Modal for exporting books
class ExportModal extends Modal {
    plugin: ViwoodsImporterPlugin;
    
    constructor(app: App, plugin: ViwoodsImporterPlugin) {
        super(app);
        this.plugin = plugin;
    }
    
    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Export Viwoods Book' });
        
        contentEl.createEl('p', { 
            text: 'Select a book and export format. This will create a package with all pages and media.' 
        });
        
        // Book selector
        const bookSelect = contentEl.createEl('select', { cls: 'dropdown' }) as HTMLSelectElement;
        bookSelect.style.cssText = 'width: 100%; margin: 10px 0;';
        
        // Get all books
        const booksFolder = this.app.vault.getAbstractFileByPath(this.plugin.settings.notesFolder);
        if (booksFolder instanceof TFolder) {
            for (const child of booksFolder.children) {
                if (child instanceof TFolder) {
                    bookSelect.createEl('option', { 
                        value: child.path, 
                        text: child.name 
                    });
                }
            }
        }
        
        // Format selector
        const formatLabel = contentEl.createEl('label', { text: 'Export format:' });
        const formatSelect = contentEl.createEl('select', { cls: 'dropdown' }) as HTMLSelectElement;
        formatSelect.style.cssText = 'width: 100%; margin: 10px 0;';
        formatSelect.createEl('option', { value: 'markdown', text: 'Markdown with media (ZIP)' });
        formatSelect.createEl('option', { value: 'pdf', text: 'PDF (single file)' });
        formatSelect.createEl('option', { value: 'html', text: 'HTML (standalone)' });
        
        // Options
        const optionsDiv = contentEl.createDiv();
        optionsDiv.style.cssText = 'margin: 15px 0;';
        
        const includeAudioCheck = optionsDiv.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
        includeAudioCheck.id = 'include-audio';
        includeAudioCheck.checked = true;
        
        const includeAudioLabel = optionsDiv.createEl('label');
        includeAudioLabel.setAttribute('for', 'include-audio');
        includeAudioLabel.textContent = ' Include audio recordings';
        
        optionsDiv.createEl('br');
        
        const includeGeminiCheck = optionsDiv.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
        includeGeminiCheck.id = 'include-gemini';
        includeGeminiCheck.checked = true;
        
        const includeGeminiLabel = optionsDiv.createEl('label');
        includeGeminiLabel.setAttribute('for', 'include-gemini');
        includeGeminiLabel.textContent = ' Include Gemini transcriptions';
        
        // Buttons
        const buttonDiv = contentEl.createDiv();
        buttonDiv.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;';
        
        const cancelBtn = buttonDiv.createEl('button', { text: 'Cancel' });
        const exportBtn = buttonDiv.createEl('button', { text: 'Export', cls: 'mod-cta' });
        
        exportBtn.onclick = async () => {
            const bookPath = bookSelect.value;
            const format = formatSelect.value;
            const includeAudio = includeAudioCheck.checked;
            const includeGemini = includeGeminiCheck.checked;
            
            this.close();
            
            try {
                await this.exportBook(bookPath, format as any, includeAudio, includeGemini);
                new Notice('Export completed successfully!');
            } catch (error: any) {
                console.error('Export failed:', error);
                new Notice('Export failed: ' + error.message);
            }
        };
        
        cancelBtn.onclick = () => this.close();
    }
    
    async exportBook(bookPath: string, format: 'markdown' | 'pdf' | 'html', includeAudio: boolean, includeGemini: boolean) {
        // Implementation would go here - simplified for brevity
        new Notice(`Export functionality for ${format} format would be implemented here`);
        
        // Basic structure:
        // 1. Load manifest
        // 2. Gather all pages
        // 3. Create export based on format
        // 4. Save to downloads or offer download
    }
}

// Import Modal
class ImportModal extends Modal {
    plugin: ViwoodsImporterPlugin;
    fileInput: HTMLInputElement;

    constructor(app: App, plugin: ViwoodsImporterPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.createEl('h2', { text: 'Import Viwoods Note' });
        
        contentEl.createEl('p', { 
            text: 'Select .note files to import. Each file may contain multiple pages that will be organized into a book structure.' 
        });
        
        // Recent imports section
        const recentDiv = contentEl.createDiv();
        recentDiv.style.cssText = 'margin: 15px 0; padding: 10px; background: var(--background-secondary); border-radius: 5px;';
        
        recentDiv.createEl('h3', { text: 'Recent Books' });
        
        const booksFolder = this.app.vault.getAbstractFileByPath(this.plugin.settings.notesFolder);
        if (booksFolder instanceof TFolder) {
            const recentBooks = booksFolder.children
                .filter(child => child instanceof TFolder)
                .slice(0, 5);
            
            if (recentBooks.length > 0) {
                const bookList = recentDiv.createEl('ul');
                bookList.style.cssText = 'list-style: none; padding: 0;';
                
                for (const book of recentBooks) {
                    const li = bookList.createEl('li');
                    li.style.cssText = 'padding: 3px 0;';
                    li.textContent = `📚 ${book.name}`;
                }
            } else {
                recentDiv.createEl('p', { 
                    text: 'No books imported yet.',
                    cls: 'mod-muted' 
                });
            }
        }
        
        // File input
        contentEl.createEl('h3', { text: 'Select Files' });
        
        this.fileInput = contentEl.createEl('input', {
            type: 'file',
            attr: {
                multiple: true,
                accept: '.note,.zip'
            }
        }) as HTMLInputElement;
        
        this.fileInput.style.marginBottom = '20px';
        
        // Drag and drop area
        const dropArea = contentEl.createDiv({ cls: 'drop-area' });
        dropArea.style.cssText = 'border: 2px dashed var(--background-modifier-border); border-radius: 8px; padding: 30px; text-align: center; margin: 15px 0;';
        dropArea.createEl('p', { text: '📥 Drag and drop .note files here' });
        
        dropArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropArea.style.borderColor = 'var(--interactive-accent)';
        });
        
        dropArea.addEventListener('dragleave', () => {
            dropArea.style.borderColor = 'var(--background-modifier-border)';
        });
        
        dropArea.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropArea.style.borderColor = 'var(--background-modifier-border)';
            
            const files = Array.from(e.dataTransfer?.files || [])
                .filter(f => f.name.endsWith('.note') || f.name.endsWith('.zip'));
            
            if (files.length > 0) {
                this.close();
                for (const file of files) {
                    await this.plugin.processNoteFile(file);
                }
            }
        });
        
        // Buttons
        const buttonDiv = contentEl.createDiv();
        buttonDiv.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;';
        
        const cancelBtn = buttonDiv.createEl('button', { text: 'Cancel' });
        const importBtn = buttonDiv.createEl('button', { text: 'Import', cls: 'mod-cta' });
        
        importBtn.addEventListener('click', async () => {
            const files = Array.from(this.fileInput.files || []);
            if (files.length > 0) {
                this.close();
                for (const file of files) {
                    await this.plugin.processNoteFile(file);
                }
            } else {
                new Notice('Please select files to import');
            }
        });
        
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// Settings Tab
class ViwoodsSettingTab extends PluginSettingTab {
    plugin: ViwoodsImporterPlugin;

    constructor(app: App, plugin: ViwoodsImporterPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl('h2', { text: 'Viwoods Notes Importer Settings' });

        // Organization Section
        containerEl.createEl('h3', { text: 'Organization' });
        
        new Setting(containerEl)
            .setName('Organization mode')
            .setDesc('How to organize imported notes')
            .addDropdown(dropdown => dropdown
                .addOption('book', 'Book mode (recommended) - One folder per notebook')
                .addOption('flat', 'Flat mode - All pages in one folder')
                .setValue(this.plugin.settings.organizationMode)
                .onChange(async (value: 'book' | 'flat') => {
                    this.plugin.settings.organizationMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Create index')
            .setDesc('Create an index file for each book with links to all pages')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createIndex)
                .onChange(async (value) => {
                    this.plugin.settings.createIndex = value;
                    await this.plugin.saveSettings();
                }));

        // Import Behavior Section
        containerEl.createEl('h3', { text: 'Import Behavior' });
        
        new Setting(containerEl)
            .setName('Auto-detect changes')
            .setDesc('Automatically detect new, modified, and unchanged pages during import')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoDetectChanges)
                .onChange(async (value) => {
                    this.plugin.settings.autoDetectChanges = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Skip duplicates')
            .setDesc('Skip importing pages that already exist with the same content')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.skipDuplicates)
                .onChange(async (value) => {
                    this.plugin.settings.skipDuplicates = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Overwrite existing')
            .setDesc('Overwrite existing pages when importing (only if skip duplicates is off)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.overwriteExisting)
                .onChange(async (value) => {
                    this.plugin.settings.overwriteExisting = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName('Create backups')
            .setDesc('Create backup of manifest before making changes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createBackups)
                .onChange(async (value) => {
                    this.plugin.settings.createBackups = value;
                    await this.plugin.saveSettings();
                }));

        // Performance Section
        containerEl.createEl('h3', { text: 'Performance' });

        new Setting(containerEl)
            .setName('Batch size')
            .setDesc('Number of pages to process simultaneously (higher = faster but more memory)')
            .addSlider(slider => slider
                .setLimits(1, 20, 1)
                .setValue(this.plugin.settings.batchSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.batchSize = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show progress bar')
            .setDesc('Display progress bar during import')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableProgressBar)
                .onChange(async (value) => {
                    this.plugin.settings.enableProgressBar = value;
                    await this.plugin.saveSettings();
                }));

        // History Section
        containerEl.createEl('h3', { text: 'History' });

        new Setting(containerEl)
            .setName('Keep import history')
            .setDesc('Track history of imports and changes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.keepHistory)
                .onChange(async (value) => {
                    this.plugin.settings.keepHistory = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Maximum history entries')
            .setDesc('Number of history entries to keep per book')
            .addSlider(slider => slider
                .setLimits(10, 100, 10)
                .setValue(this.plugin.settings.maxHistoryEntries)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxHistoryEntries = value;
                    await this.plugin.saveSettings();
                }));

        // Folders Section
        containerEl.createEl('h3', { text: 'Storage Locations' });
        
        new Setting(containerEl)
            .setName('Notes folder')
            .setDesc('Root folder for imported notebooks')
            .addText(text => text
                .setPlaceholder('Viwoods Notes')
                .setValue(this.plugin.settings.notesFolder)
                .onChange(async (value) => {
                    this.plugin.settings.notesFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Images subfolder')
            .setDesc('Subfolder name for images within each book (relative to book folder)')
            .addText(text => text
                .setPlaceholder('Images')
                .setValue(this.plugin.settings.imagesFolder)
                .onChange(async (value) => {
                    this.plugin.settings.imagesFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Audio subfolder')
            .setDesc('Subfolder name for audio within each book (relative to book folder)')
            .addText(text => text
                .setPlaceholder('Audio')
                .setValue(this.plugin.settings.audioFolder)
                .onChange(async (value) => {
                    this.plugin.settings.audioFolder = value;
                    await this.plugin.saveSettings();
                }));

        // Output Format Section
        containerEl.createEl('h3', { text: 'Output Settings' });
        
        new Setting(containerEl)
            .setName('Output format')
            .setDesc('Choose how to convert handwritten notes')
            .addDropdown(dropdown => dropdown
                .addOption('png', 'PNG Images')
                .addOption('svg', 'SVG (from strokes)')
                .addOption('both', 'Both PNG and SVG')
                .setValue(this.plugin.settings.outputFormat)
                .onChange(async (value: 'png' | 'svg' | 'both') => {
                    this.plugin.settings.outputFormat = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Background color')
            .setDesc('Background color for PNG images (hex color or "transparent")')
            .addText(text => text
                .setPlaceholder('#FFFFFF')
                .setValue(this.plugin.settings.backgroundColor)
                .onChange(async (value) => {
                    this.plugin.settings.backgroundColor = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('File prefix')
            .setDesc('Optional prefix for book names')
            .addText(text => text
                .setPlaceholder('viwoods_')
                .setValue(this.plugin.settings.filePrefix)
                .onChange(async (value) => {
                    this.plugin.settings.filePrefix = value;
                    await this.plugin.saveSettings();
                }));

        // Metadata Section
        containerEl.createEl('h3', { text: 'Metadata Options' });
        
        new Setting(containerEl)
            .setName('Include metadata')
            .setDesc('Add frontmatter metadata to notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeMetadata)
                .onChange(async (value) => {
                    this.plugin.settings.includeMetadata = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Include timestamps')
            .setDesc('Add creation and modification dates')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeTimestamps)
                .onChange(async (value) => {
                    this.plugin.settings.includeTimestamps = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Include thumbnails')
            .setDesc('Import thumbnail images')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeThumbnails)
                .onChange(async (value) => {
                    this.plugin.settings.includeThumbnails = value;
                    await this.plugin.saveSettings();
                }));

        // Gemini Integration Section
        containerEl.createEl('h3', { text: 'Gemini Integration' });
        
        const app = this.plugin.app as any;
        const isGeminiEnabled = app.plugins?.enabledPlugins?.has('gemini-note-processor');
        
        if (!isGeminiEnabled) {
            containerEl.createEl('p', {
                text: '⚠️ Gemini Note Processor plugin is not installed or enabled.',
                cls: 'setting-item-description mod-warning'
            });
        } else {
            containerEl.createEl('p', {
                text: '✅ Gemini Note Processor plugin is ready',
                cls: 'setting-item-description'
            });
        }
        
        new Setting(containerEl)
            .setName('Process with Gemini AI')
            .setDesc('Automatically transcribe handwritten notes using Gemini AI after import')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.processWithGemini)
                .onChange(async (value) => {
                    this.plugin.settings.processWithGemini = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Date format')
            .setDesc('Format for dates in metadata')
            .addDropdown(dropdown => dropdown
                .addOption('iso', 'ISO (YYYY-MM-DD)')
                .addOption('us', 'US (MM/DD/YYYY)')
                .addOption('eu', 'EU (DD/MM/YYYY)')
                .setValue(this.plugin.settings.dateFormat)
                .onChange(async (value: 'iso' | 'us' | 'eu') => {
                    this.plugin.settings.dateFormat = value;
                    await this.plugin.saveSettings();
                }));
    }
}

// ============================================================================
// MAIN PLUGIN CLASS
// ============================================================================

export default class ViwoodsImporterPlugin extends Plugin {
    settings: ViwoodsSettings;
    importInProgress: boolean = false;

    async onload() {
        await this.loadSettings();

        // Load JSZip library
        await this.loadJSZip();

        // Add ribbon icon
        this.addRibbonIcon('import', 'Import Viwoods Note', async () => {
            if (this.importInProgress) {
                new Notice('Import already in progress');
                return;
            }
            new ImportModal(this.app, this).open();
        });

        // Add commands
        this.addCommand({
            id: 'import-viwoods-note',
            name: 'Import Viwoods .note file',
            callback: () => {
                if (this.importInProgress) {
                    new Notice('Import already in progress');
                    return;
                }
                new ImportModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'export-viwoods-book',
            name: 'Export Viwoods book',
            callback: () => {
                new ExportModal(this.app, this).open();
            }
        });

        // Add this command in the onload() method after the other commands
        this.addCommand({
            id: 'reset-book-hashes',
            name: 'Reset book hashes (fix change detection)',
            callback: async () => {
                // Show book selection dialog
                const booksFolder = this.app.vault.getAbstractFileByPath(this.settings.notesFolder);
                if (!(booksFolder instanceof TFolder)) {
                    new Notice('No books found');
                    return;
                }
                
                const books = booksFolder.children
                    .filter(child => child instanceof TFolder)
                    .map(folder => folder.name);
                
                if (books.length === 0) {
                    new Notice('No books found');
                    return;
                }
                
                // Simple selection modal
                const modal = new Modal(this.app);
                modal.titleEl.setText('Select Book to Reset');
                
                const select = modal.contentEl.createEl('select');
                books.forEach(book => {
                    select.createEl('option', { value: book, text: book });
                });
                
                const buttonDiv = modal.contentEl.createDiv();
                buttonDiv.style.cssText = 'margin-top: 20px; text-align: right;';
                
                const resetBtn = buttonDiv.createEl('button', { 
                    text: 'Reset Hashes', 
                    cls: 'mod-cta' 
                });
                
                resetBtn.onclick = async () => {
                    const bookName = select.value;
                    const manifestPath = `${this.settings.notesFolder}/${bookName}/.import-manifest.json`;
                    const manifest = await this.loadManifest(manifestPath);
                    
                    if (manifest) {
                        // Mark all hashes as needing reset
                        Object.keys(manifest.importedPages).forEach(pageNum => {
                            // Use a special marker that indicates reset needed
                            manifest.importedPages[parseInt(pageNum)].imageHash = 'RESET-' + Date.now();
                        });
                        
                        await this.saveManifest(manifestPath, manifest);
                        new Notice(`Reset hashes for ${bookName}. Next import will update them.`);
                    } else {
                        new Notice('No manifest found for this book');
                    }
                    
                    modal.close();
                };
                
                buttonDiv.createEl('button', { text: 'Cancel' }).onclick = () => modal.close();
                
                modal.open();
            }
        });

        // Register drag and drop handlers
        this.registerDomEvent(document, 'drop', this.handleDrop.bind(this));
        this.registerDomEvent(document, 'dragover', this.handleDragOver.bind(this));

        // Add settings tab
        this.addSettingTab(new ViwoodsSettingTab(this.app, this));
    }

    async loadJSZip() {
        // Load JSZip from CDN or local file
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        script.async = true;
        document.head.appendChild(script);
        
        return new Promise((resolve) => {
            script.onload = resolve;
        });
    }

    handleDragOver(evt: DragEvent) {
        if (evt.dataTransfer && this.hasNoteFile(evt.dataTransfer)) {
            evt.preventDefault();
            evt.dataTransfer.dropEffect = 'copy';
        }
    }

    async handleDrop(evt: DragEvent) {
        if (!evt.dataTransfer || !this.hasNoteFile(evt.dataTransfer)) return;
        
        evt.preventDefault();
        
        const files = Array.from(evt.dataTransfer.files);
        const noteFiles = files.filter(f => f.name.endsWith('.note') || f.name.endsWith('.zip'));
        
        if (noteFiles.length > 0) {
            for (const file of noteFiles) {
                await this.processNoteFile(file);
            }
        }
    }

    hasNoteFile(dataTransfer: DataTransfer | null): boolean {
        if (!dataTransfer) return false;
        
        for (const item of Array.from(dataTransfer.items)) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file && (file.name.endsWith('.note') || file.name.endsWith('.zip'))) {
                    return true;
                }
            }
        }
        return false;
    }

    // Enhanced hash function with chunking for large files
    async hashImageData(blob: Blob): Promise<string> {
        try {
            // Just hash the raw bytes of the file - simple and deterministic
            const buffer = await blob.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            return hashHex.substring(0, 32);
        } catch (error) {
            console.error('Error hashing image:', error);
            // Fallback: use size and type as a simple hash
            return `fallback-${blob.size}`.padEnd(32, '0').substring(0, 32);
        }
    }

    


    // Analyze changes between current and new import
    async analyzeChanges(bookResult: BookResult, existingManifest: ImportManifest | null): Promise<{
        changes: PageChange[];
        summary: ImportSummary;
    }> {
        const changes: PageChange[] = [];
        const summary: ImportSummary = {
            totalPages: bookResult.pages.length,
            newPages: [],
            modifiedPages: [],
            unchangedPages: [],
            deletedPages: [],
            errors: []
        };

        // Get the book folder path
        const bookFolder = `${this.settings.notesFolder}/${bookResult.bookName}`;

        // If no manifest exists, everything is new
        if (!existingManifest) {
            for (const page of bookResult.pages) {
                changes.push({
                    pageNum: page.pageNum,
                    type: 'new',
                    newHash: page.image.hash
                });
                summary.newPages.push(page.pageNum);
            }
            console.log('No existing manifest - all pages are new');
            return { changes, summary };
        }

        // Create a map of existing pages with their actual hashes from files
        const existingMap = new Map<number, { manifestInfo: any, fileHash?: string }>();
        
        // First populate from manifest
        Object.entries(existingManifest.importedPages).forEach(([pageNum, info]) => {
            existingMap.set(parseInt(pageNum), { manifestInfo: info });
        });

        // Now try to read actual hashes from the page files
        for (const [pageNum, data] of existingMap.entries()) {
            const pageFileName = `Page ${String(pageNum).padStart(3, '0')}.md`;
            const pagePath = `${bookFolder}/${pageFileName}`;
            const pageFile = this.app.vault.getAbstractFileByPath(pagePath);
            
            if (pageFile instanceof TFile) {
                try {
                    const content = await this.app.vault.read(pageFile);
                    
                    // Extract the original_image_hash from frontmatter
                    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
                    const match = content.match(frontmatterRegex);
                    
                    if (match) {
                        const frontmatter = match[1];
                        const hashMatch = frontmatter.match(/original_image_hash:\s*"?([a-f0-9]+)"?/);
                        if (hashMatch) {
                            data.fileHash = hashMatch[1];
                            console.log(`Page ${pageNum}: Found hash in file: ${hashMatch[1].substring(0, 8)}...`);
                        }
                    }
                } catch (error) {
                    console.error(`Failed to read hash from page ${pageNum}:`, error);
                }
            }
        }

        // Check each page in the new import
        for (const page of bookResult.pages) {
            const existing = existingMap.get(page.pageNum);
            
            if (!existing) {
                // New page
                changes.push({
                    pageNum: page.pageNum,
                    type: 'new',
                    newHash: page.image.hash
                });
                summary.newPages.push(page.pageNum);
            } else {
                // Prefer the hash from the file over the manifest hash
                const existingHash = existing.fileHash || existing.manifestInfo.imageHash;
                
                // Check if this is a special hash that can't be compared
                const isRecoveredHash = existingHash.startsWith('recovered-');
                const isResetHash = existingHash.startsWith('RESET-');
                const hashesMatch = existingHash === page.image.hash;
                
                if (isRecoveredHash || isResetHash) {
                    // Cannot reliably compare. Treat as 'modified' to force a hash update on re-import.
                    console.log(`Page ${page.pageNum}: Special hash (${isRecoveredHash ? 'recovered' : 'reset'}), treating as modified`);
                    changes.push({
                        pageNum: page.pageNum,
                        type: 'modified',
                        oldHash: existingHash,
                        newHash: page.image.hash,
                        hasAudioChange: !!page.audio !== !!existing.manifestInfo.hasAudio
                    });
                    summary.modifiedPages.push(page.pageNum);
                } else if (!hashesMatch) {
                    // Genuine modification
                    console.log(`Page ${page.pageNum} modified: ${existingHash.substring(0, 8)}... → ${page.image.hash.substring(0, 8)}...`);
                    console.log(`  Source: ${existing.fileHash ? 'file frontmatter' : 'manifest'}`);
                    changes.push({
                        pageNum: page.pageNum,
                        type: 'modified',
                        oldHash: existingHash,
                        newHash: page.image.hash,
                        hasAudioChange: !!page.audio !== !!existing.manifestInfo.hasAudio
                    });
                    summary.modifiedPages.push(page.pageNum);
                } else {
                    // Unchanged page
                    changes.push({
                        pageNum: page.pageNum,
                        type: 'unchanged',
                        oldHash: existingHash,
                        newHash: page.image.hash
                    });
                    summary.unchangedPages.push(page.pageNum);
                }
                
                // Remove from map to track deletions
                existingMap.delete(page.pageNum);
            }
        }

        // Any remaining in existingMap are deleted pages (exist locally but not in import)
        existingMap.forEach((data, pageNum) => {
            const hash = data.fileHash || data.manifestInfo.imageHash;
            changes.push({
                pageNum,
                type: 'deleted',
                oldHash: hash
            });
            summary.deletedPages.push(pageNum);
        });

        // Log summary
        console.log('Change Analysis Summary:', {
            total: bookResult.pages.length,
            new: summary.newPages.length,
            modified: summary.modifiedPages.length,
            unchanged: summary.unchangedPages.length,
            deleted: summary.deletedPages.length
        });

        return { changes, summary };
    }

    // Create backup of manifest before changes
    async createManifestBackup(manifestPath: string): Promise<string | null> {
        if (!this.settings.createBackups) return null;
        
        try {
            const manifestFile = this.app.vault.getAbstractFileByPath(manifestPath);
            if (manifestFile instanceof TFile) {
                const content = await this.app.vault.read(manifestFile);
                const backupPath = manifestPath.replace('.json', `-backup-${Date.now()}.json`);
                await this.app.vault.create(backupPath, content);
                return backupPath;
            }
        } catch (error) {
            console.error('Failed to create manifest backup:', error);
        }
        return null;
    }

    // Add history entry to manifest
    addHistoryEntry(manifest: ImportManifest, action: string, pages: number[], summary: string) {
        if (!this.settings.keepHistory) return;
        
        if (!manifest.history) {
            manifest.history = [];
        }
        
        manifest.history.unshift({
            date: new Date().toISOString(),
            action: action as any,
            pages,
            summary
        });
        
        // Keep only recent history
        if (manifest.history.length > this.settings.maxHistoryEntries) {
            manifest.history = manifest.history.slice(0, this.settings.maxHistoryEntries);
        }
    }

    async recoverManifestFromExistingFiles(bookFolder: string, bookName: string): Promise<ImportManifest | null> {
        console.log(`Attempting to recover manifest for ${bookName}`);
        
        const folder = this.app.vault.getAbstractFileByPath(bookFolder);
        if (!(folder instanceof TFolder)) return null;
        
        const manifest: ImportManifest = {
            bookName: bookName,
            totalPages: 0,
            importedPages: {},
            lastImport: new Date().toISOString(),
            sourceFile: bookName,
            version: '1.1',
            history: []
        };
        
        // Scan for page files
        const pageRegex = /^Page (\d{3})\.md$/;
        let maxPage = 0;
        
        for (const child of folder.children) {
            if (child instanceof TFile) {
                const match = child.name.match(pageRegex);
                if (match) {
                    const pageNum = parseInt(match[1]);
                    maxPage = Math.max(maxPage, pageNum);
                    
                    // Read the file to check for Gemini processing and audio
                    const content = await this.app.vault.read(child);
                    const hasGemini = content.includes('### Gemini Transcription');
                    const hasAudio = content.includes('🎙️ Audio Recording');
                    
                    // Try to find the actual image file to compute its hash
                    let imageHash = 'recovered-unknown-' + pageNum;
                    const imageFileName = `${bookName}_page_${String(pageNum).padStart(3, '0')}.png`;
                    const imagePath = `${bookFolder}/${this.settings.imagesFolder}/${imageFileName}`;
                    const imageFile = this.app.vault.getAbstractFileByPath(imagePath);
                    
                    if (imageFile instanceof TFile) {
                        // CORRECTED: We cannot reliably hash the processed image in the vault,
                        // as it may have a background color.
                        // Instead, use a deterministic placeholder based on file stats.
                        // This special "recovered-" prefix signals to `analyzeChanges`
                        // that the hash needs to be updated from a fresh import.
                        imageHash = `recovered-${imageFile.stat.size}-${imageFile.stat.mtime}`;
                        console.log(`Using recovered placeholder hash for page ${pageNum}: ${imageHash}`);
                    }
                    
                    manifest.importedPages[pageNum] = {
                        fileName: child.name,
                        importDate: new Date(child.stat.mtime).toISOString(),
                        imageHash: imageHash,
                        geminiProcessed: hasGemini,
                        hasAudio: hasAudio,
                        lastModified: new Date(child.stat.mtime).toISOString(),
                        size: child.stat.size
                    };
                }
            }
        }
        
        manifest.totalPages = maxPage;
        
        if (Object.keys(manifest.importedPages).length > 0) {
            console.log(`Recovered manifest with ${Object.keys(manifest.importedPages).length} pages`);
            this.addHistoryEntry(manifest, 'import', Object.keys(manifest.importedPages).map(Number), 'Manifest recovered from existing files');
            
            // Save the recovered manifest
            const manifestPath = `${bookFolder}/.import-manifest.json`;
            try {
                await this.saveManifest(manifestPath, manifest);
            } catch (error) {
                console.error('Failed to save recovered manifest:', error);
                // Return the manifest anyway, it will be saved later
            }
            return manifest;
        }
        
        return null;
    }
    
    async loadManifest(manifestPath: string): Promise<ImportManifest | null> {
        console.log(`Attempting to load manifest from: ${manifestPath}`);
        const manifestFile = this.app.vault.getAbstractFileByPath(manifestPath);
        if (manifestFile instanceof TFile) {
            const content = await this.app.vault.read(manifestFile);
            const manifest = JSON.parse(content);
            console.log(`Loaded manifest with ${Object.keys(manifest.importedPages).length} pages`);
            return manifest;
        }
        console.log('No manifest file found');
        return null;
    }

    async saveManifest(manifestPath: string, manifest: ImportManifest) {
        console.log(`Saving manifest to: ${manifestPath}`);
        console.log(`Manifest contains ${Object.keys(manifest.importedPages).length} pages`);
        
        const manifestFile = this.app.vault.getAbstractFileByPath(manifestPath);
        const content = JSON.stringify(manifest, null, 2);
        
        try {
            if (manifestFile instanceof TFile) {
                await this.app.vault.modify(manifestFile, content);
                console.log('Manifest updated successfully');
            } else {
                await this.app.vault.create(manifestPath, content);
                console.log('Manifest created successfully');
            }
        } catch (error) {
            console.error('Failed to save manifest:', error);
            // Try alternative save method
            try {
                const folder = manifestPath.substring(0, manifestPath.lastIndexOf('/'));
                await this.ensureFolder(folder);
                await this.app.vault.adapter.write(manifestPath, content);
                console.log('Manifest saved using adapter');
            } catch (fallbackError) {
                console.error('Failed to save manifest using fallback:', fallbackError);
            }
        }
    }

    async processNoteFile(file: File) {
        if (this.importInProgress) {
            new Notice('Import already in progress');
            return;
        }
        
        this.importInProgress = true;
        
        try {
            const JSZip = window.JSZip;
            if (!JSZip) {
                new Notice('JSZip library not loaded. Please restart Obsidian.');
                return;
            }

            const zip = await JSZip.loadAsync(file);
            const files = Object.keys(zip.files);
            
            // Detect format
            const isNewFormat = files.some(f => f.includes('NoteFileInfo.json'));
            
            // Convert to book format
            const bookResult = await this.convertNoteToBook(zip, files, file.name, isNewFormat);
            
            // Always load the latest manifest from disk
            const bookFolder = `${this.settings.notesFolder}/${bookResult.bookName}`;
            const manifestPath = `${bookFolder}/.import-manifest.json`;
            let existingManifest = await this.loadManifest(manifestPath);
            
            // If no manifest but folder exists with pages, try to recover
            if (!existingManifest) {
                const folderExists = this.app.vault.getAbstractFileByPath(bookFolder);
                if (folderExists instanceof TFolder) {
                    console.log('Book folder exists but no manifest, attempting recovery...');
                    existingManifest = await this.recoverManifestFromExistingFiles(bookFolder, bookResult.bookName);
                }
            }
            
            // Create backup if updating
            let backupPath: string | null = null;
            if (existingManifest && this.settings.createBackups) {
                backupPath = await this.createManifestBackup(manifestPath);
            }
            
            // Analyze changes if auto-detect is enabled
            let analysis = null;
            if (this.settings.autoDetectChanges && existingManifest) {
                analysis = await this.analyzeChanges(bookResult, existingManifest);
            }
            
            // Show enhanced import dialog
            const pagesToImport = await this.showEnhancedImportDialog(bookResult, existingManifest, analysis);
            
            if (pagesToImport.length === 0) {
                new Notice('Import cancelled or no pages selected');
                return;
            }
            
            // Import selected pages with progress tracking
            const summary = await this.importSelectedPagesWithProgress(bookResult, pagesToImport, existingManifest);
            
            // Show summary
            new ImportSummaryModal(this.app, summary, backupPath).open();
            
        } catch (error: any) {
            console.error('Error processing note file:', error);
            new Notice(`Failed to import: ${file.name}\n${error.message}`);
        } finally {
            this.importInProgress = false;
        }
    }

    async convertNoteToBook(zip: any, files: string[], fileName: string, isNewFormat: boolean): Promise<BookResult> {
        let bookName = fileName.replace('.note', '').replace('.zip', '');
        let metadata: any = {};
        const pages: PageData[] = [];
        
        console.log(`Converting note to book: ${fileName}, format: ${isNewFormat ? 'new' : 'old'}`);
        console.log(`Total files in archive: ${files.length}`);
        
        // Log audio files for debugging
        const allAudioFiles = files.filter(f => f.includes('audio') || f.endsWith('.m4a') || f.endsWith('.mp3'));
        console.log(`Found ${allAudioFiles.length} audio files:`, allAudioFiles);
        
        // Extract metadata
        if (isNewFormat) {
            const noteFileInfo = files.find(f => f.includes('NoteFileInfo.json'));
            if (noteFileInfo) {
                metadata = JSON.parse(await zip.file(noteFileInfo).async('string'));
                bookName = this.settings.filePrefix + (metadata.fileName || bookName);
                console.log(`Book name from metadata: ${bookName}`);
            }
            
            const pageResourceFile = files.find(f => f.includes('PageResource.json'));
            if (pageResourceFile) {
                const pageResource = JSON.parse(await zip.file(pageResourceFile).async('string'));
                
                // Process each page
                const mainBmpFiles = pageResource.filter((r: any) => r.fileName?.includes('mainBmp'));
                console.log(`Processing ${mainBmpFiles.length} pages`);
                
                for (let i = 0; i < mainBmpFiles.length; i++) {
                    const bmpResource = mainBmpFiles[i];
                    const imageFile = files.find(f => f === bmpResource.fileName);
                    if (imageFile) {
                        const blob = await zip.file(imageFile).async('blob');
                        const hash = await this.hashImageData(blob);
                        
                        const pageData: PageData = {
                            pageNum: i + 1,
                            image: { blob, hash }
                        };
                        
                        // Get strokes if needed
                        if (this.settings.outputFormat === 'svg' || this.settings.outputFormat === 'both') {
                            const pathFiles = pageResource.filter((r: any) => r.resourceType === 7);
                            const pathResource = pathFiles[i];
                            if (pathResource) {
                                const pathFile = files.find(f => f.includes(pathResource.fileName));
                                if (pathFile) {
                                    pageData.stroke = JSON.parse(await zip.file(pathFile).async('string'));
                                }
                            }
                        }
                        
                        // Enhanced audio detection
                        const pageNum = i + 1;
                        
                        // Try multiple patterns for audio files
                        const audioPatterns = [
                            `audio/page_${pageNum}`,
                            `audio/Page_${pageNum}`,
                            `page_${pageNum}.m4a`,
                            `Page${String(pageNum).padStart(3, '0')}`,
                            `audio/${pageNum}`,
                            // Generic pattern for files that might be numbered differently
                            (f: string) => {
                                const audioMatch = f.match(/audio[\/\\].*?(\d+)/i);
                                return audioMatch && parseInt(audioMatch[1]) === pageNum;
                            }
                        ];
                        
                        let audioFile = null;
                        for (const pattern of audioPatterns) {
                            if (typeof pattern === 'string') {
                                audioFile = files.find(f => f.includes(pattern));
                            } else if (typeof pattern === 'function') {
                                audioFile = files.find(f => pattern(f));
                            }
                            
                            if (audioFile) {
                                console.log(`Found audio for page ${pageNum} using pattern: ${typeof pattern === 'string' ? pattern : 'function'}`);
                                break;
                            }
                        }
                        
                        // If still no audio found, check if there's a corresponding audio file by index
                        if (!audioFile && allAudioFiles.length > 0) {
                            // Sort audio files to ensure consistent ordering
                            const sortedAudioFiles = allAudioFiles.sort();
                            if (sortedAudioFiles[i]) {
                                audioFile = sortedAudioFiles[i];
                                console.log(`Using audio file by index for page ${pageNum}: ${audioFile}`);
                            }
                        }
                        
                        if (audioFile) {
                            const audioBlob = await zip.file(audioFile).async('blob');
                            const audioFileName = audioFile.split('/').pop() || audioFile.split('\\').pop();
                            pageData.audio = {
                                blob: audioBlob,
                                originalName: audioFileName || '',
                                name: `${bookName}_page_${String(pageNum).padStart(3, '0')}_audio.m4a`
                            };
                            console.log(`Added audio for page ${pageNum}: ${audioFile}`);
                        } else {
                            console.log(`No audio found for page ${pageNum}`);
                        }
                        
                        pages.push(pageData);
                    }
                }
            }
        } else {
            // Old format processing
            const notesBeanFile = files.find(f => f.includes('NotesBean.json'));
            if (notesBeanFile) {
                metadata = JSON.parse(await zip.file(notesBeanFile).async('string'));
                bookName = this.settings.filePrefix + (metadata.nickname || metadata.noteName || bookName);
                console.log(`Book name from old format metadata: ${bookName}`);
            }
            
            const noteListFile = files.find(f => f.includes('NoteList.json'));
            if (noteListFile) {
                const noteList = JSON.parse(await zip.file(noteListFile).async('string'));
                console.log(`Processing ${noteList.length} pages from old format`);
                
                for (let i = 0; i < noteList.length; i++) {
                    const page = noteList[i];
                    const imageFile = files.find(f => f === `${page.pageId}.png`);
                    if (imageFile) {
                        const blob = await zip.file(imageFile).async('blob');
                        const hash = await this.hashImageData(blob);
                        
                        const pageData: PageData = {
                            pageNum: i + 1,
                            image: { blob, hash }
                        };
                        
                        // Check for audio in old format
                        const pageNum = i + 1;
                        const audioFile = files.find(f => 
                            (f.includes('audio') || f.endsWith('.m4a')) && 
                            (f.includes(`${pageNum}`) || f.includes(`page${pageNum}`) || f.includes(`Page${pageNum}`))
                        );
                        
                        if (audioFile) {
                            const audioBlob = await zip.file(audioFile).async('blob');
                            const audioFileName = audioFile.split('/').pop() || audioFile.split('\\').pop();
                            pageData.audio = {
                                blob: audioBlob,
                                originalName: audioFileName || '',
                                name: `${bookName}_page_${String(pageNum).padStart(3, '0')}_audio.m4a`
                            };
                            console.log(`Added audio for page ${pageNum} (old format): ${audioFile}`);
                        }
                        
                        pages.push(pageData);
                    }
                }
            }
        }
        
        // Get thumbnail if needed
        let thumbnail = null;
        if (this.settings.includeThumbnails) {
            const thumbnailFile = files.find(f => f.includes('Thumbnail') || f.includes('thumbnai'));
            if (thumbnailFile) {
                thumbnail = await zip.file(thumbnailFile).async('blob');
                console.log('Found thumbnail');
            }
        }
        
        console.log(`Conversion complete: ${pages.length} pages, ${pages.filter(p => p.audio).length} with audio`);
        
        return {
            bookName,
            metadata,
            pages,
            thumbnail
        };
    }

    async showEnhancedImportDialog(
        bookResult: BookResult, 
        existingManifest: ImportManifest | null,
        analysis: { changes: PageChange[], summary: ImportSummary } | null
    ): Promise<number[]> {
        return new Promise((resolve) => {
            const modal = new EnhancedImportModal(
                this.app, 
                bookResult, 
                existingManifest, 
                analysis,
                this.settings
            );
            
            modal.onChoose = (pages: number[]) => {
                resolve(pages);
            };
            
            modal.open();
        });
    }

    async importSelectedPagesWithProgress(
        bookResult: BookResult, 
        pagesToImport: number[], 
        existingManifest: ImportManifest | null
    ): Promise<ImportSummary> {
        const bookFolder = `${this.settings.notesFolder}/${bookResult.bookName}`;
        await this.ensureFolder(bookFolder);
        
        const imagesFolder = `${bookFolder}/${this.settings.imagesFolder}`;
        await this.ensureFolder(imagesFolder);
        
        const audioFolder = `${bookFolder}/${this.settings.audioFolder}`;
        
        const manifestFilePath = `${bookFolder}/.import-manifest.json`;
        const manifest: ImportManifest = existingManifest || {
            bookName: bookResult.bookName,
            totalPages: 0,
            importedPages: {},
            lastImport: new Date().toISOString(),
            sourceFile: bookResult.bookName,
            version: '1.1',
            history: []
        };
        
        manifest.totalPages = Math.max(manifest.totalPages, bookResult.pages.length);
        
        const summary: ImportSummary = {
            totalPages: pagesToImport.length,
            newPages: [],
            modifiedPages: [],
            unchangedPages: [],
            deletedPages: [],
            errors: []
        };
        
        const progressModal = new ProgressModal(this.app, pagesToImport.length);
        if (this.settings.enableProgressBar) {
            progressModal.open();
        }
        
        const imageFilesToProcess: { file: TFile, pageNum: number }[] = [];
        
        // Process in batches for better performance
        const batchSize = this.settings.batchSize;
        for (let batchStart = 0; batchStart < pagesToImport.length; batchStart += batchSize) {
            const batch = pagesToImport.slice(batchStart, Math.min(batchStart + batchSize, pagesToImport.length));
            
            const batchPromises = batch.map(async (pageNum) => {
                const page = bookResult.pages.find(p => p.pageNum === pageNum);
                if (!page) return;
                
                try {
                    const i = pagesToImport.indexOf(pageNum);
                    progressModal.updateProgress(i + 1, `Processing page ${pageNum}...`);
                    
                    // Determine if this is new or modified
                    const isNew = !existingManifest?.importedPages[pageNum];
                    const isModified = existingManifest?.importedPages[pageNum]?.imageHash !== page.image.hash;
                    
                    if (isNew) summary.newPages.push(pageNum);
                    else if (isModified) summary.modifiedPages.push(pageNum);
                    else summary.unchangedPages.push(pageNum);
                    
                    // Create page markdown file
                    const pageFileName = `Page ${String(pageNum).padStart(3, '0')}.md`;
                    const pagePath = `${bookFolder}/${pageFileName}`;
                    
                    let pageContent = '';
                    
                    // Add frontmatter
                    if (this.settings.includeMetadata) {
                        pageContent += '---\n';
                        pageContent += `book: "${bookResult.bookName}"\n`;
                        pageContent += `page: ${pageNum}\n`;
                        pageContent += `total_pages: ${manifest.totalPages}\n`;
                        pageContent += `original_image_hash: "${page.image.hash}"\n`; 
                        
                        
                        if (this.settings.includeTimestamps) {
                            const createTime = bookResult.metadata.createTime || bookResult.metadata.creationTime;
                            const updateTime = bookResult.metadata.upTime || bookResult.metadata.lastModifiedTime;
                            if (createTime) pageContent += `book_created: ${this.formatDate(createTime)}\n`;
                            if (updateTime) pageContent += `book_updated: ${this.formatDate(updateTime)}\n`;
                        }
                        
                        pageContent += `import_date: ${new Date().toISOString()}\n`;
                        if (isModified) pageContent += `last_modified: ${new Date().toISOString()}\n`;
                        if (page.audio) pageContent += 'has_audio: true\n';

                        const imageName = `${bookResult.bookName}_page_${String(pageNum).padStart(3, '0')}.png`;
                        pageContent += `image: "${imageName}"\n`;
                        
                        // Create book tag from book name (sanitize for use as tag)
                        const bookTag = bookResult.bookName
                            .toLowerCase()
                            .replace(/\s+/g, '-')  // Replace spaces with hyphens
                            .replace(/[^a-z0-9-_]/g, '')  // Remove invalid characters
                            .replace(/-+/g, '-')  // Replace multiple hyphens with single
                            .replace(/^-|-$/g, '');  // Remove leading/trailing hyphens
                        
                        pageContent += 'tags: [viwoods-import, handwritten, ' + bookTag + ']\n';
                        pageContent += '---\n\n';
                    }
                    
                    // Add audio if present
                    if (page.audio) {
                        await this.ensureFolder(audioFolder);
                        const audioPath = `${audioFolder}/${page.audio.name}`;
                        const normalizedAudioPath = normalizePath(audioPath);
                        
                        // Check if audio file exists
                        const existingAudio = this.app.vault.getAbstractFileByPath(normalizedAudioPath);
                        
                        if (existingAudio instanceof TFile) {
                            // Only update if new or modified
                            if (isNew || isModified) {
                                await this.app.vault.delete(existingAudio);
                                await this.app.vault.createBinary(normalizedAudioPath, await page.audio.blob.arrayBuffer());
                            }
                        } else {
                            await this.app.vault.createBinary(normalizedAudioPath, await page.audio.blob.arrayBuffer());
                        }
                        
                        pageContent += `## 🎙️ Audio Recording\n\n`;
                        pageContent += `![[${page.audio.name}]]\n\n`;
                        pageContent += '---\n\n';
                    }
                    
                    // Process and add image
                    if (this.settings.outputFormat === 'png' || this.settings.outputFormat === 'both') {
                        const imageName = `${bookResult.bookName}_page_${String(pageNum).padStart(3, '0')}.png`;
                        const imagePath = `${imagesFolder}/${imageName}`;
                        const normalizedImagePath = normalizePath(imagePath);
                        
                        // Check if image already exists
                        const existingImage = this.app.vault.getAbstractFileByPath(normalizedImagePath);
                        
                        let imageFile: TFile;
                        
                        try {
                            // Determine if we need to update the display image
                            const needsImageUpdate = isNew || isModified;
                            const backgroundChanged = existingManifest?.importedPages[pageNum]?.backgroundColor !== this.settings.backgroundColor;
                            
                            if (existingImage instanceof TFile) {
                                // Image exists - update if needed
                                if (needsImageUpdate || backgroundChanged) {
                                    // Process image with background color if configured
                                    const processedImage = await this.processImageWithBackground(page.image.blob);
                                    
                                    // Delete old image and create new one
                                    await this.app.vault.delete(existingImage);
                                    imageFile = await this.app.vault.createBinary(normalizedImagePath, processedImage);
                                    
                                    console.log(`Updated image for page ${pageNum} (new: ${isNew}, modified: ${isModified}, bg changed: ${backgroundChanged})`);
                                } else {
                                    // Use existing image
                                    imageFile = existingImage;
                                }
                            } else {
                                // Create new image with background if configured
                                const processedImage = await this.processImageWithBackground(page.image.blob);
                                imageFile = await this.app.vault.createBinary(normalizedImagePath, processedImage);
                            }
                            
                            pageContent += `![[${imageName}]]\n\n`;
                            
                            // Add placeholder for Gemini if enabled
                            if (this.settings.processWithGemini && (isNew || isModified)) {
                                pageContent += `<!-- GEMINI_PLACEHOLDER_${pageNum} -->\n\n`;
                                imageFilesToProcess.push({ file: imageFile, pageNum });
                            }
                        } catch (imageError) {
                            console.error(`Failed to process image for page ${pageNum}:`, imageError);
                            pageContent += `*[Image failed to import]*\n\n`;
                        }
                    }
                    
                    // Save SVG if needed
                    if ((this.settings.outputFormat === 'svg' || this.settings.outputFormat === 'both') && page.stroke) {
                        const svgContent = this.strokesToSVG(page.stroke);
                        const svgName = `${bookResult.bookName}_page_${String(pageNum).padStart(3, '0')}.svg`;
                        const svgPath = `${imagesFolder}/${svgName}`;
                        const normalizedSvgPath = normalizePath(svgPath);
                        
                        // Check if SVG exists
                        const existingSvg = this.app.vault.getAbstractFileByPath(normalizedSvgPath);
                        
                        if (existingSvg instanceof TFile) {
                            // Only update if modified
                            if (isNew || isModified) {
                                await this.app.vault.modify(existingSvg, svgContent);
                            }
                        } else {
                            // Create new SVG
                            await this.app.vault.create(normalizedSvgPath, svgContent);
                        }
                        
                        if (this.settings.outputFormat !== 'both') {
                            pageContent += `![Page ${pageNum}](${this.settings.imagesFolder}/${svgName})\n\n`;
                        }
                    }
                    
                    // Save page file
                    const existingFile = this.app.vault.getAbstractFileByPath(pagePath);
                    
                    if (existingFile instanceof TFile) {
                        // File exists - update it
                        await this.app.vault.modify(existingFile, pageContent);
                    } else {
                        // Create new file
                        await this.app.vault.create(pagePath, pageContent);
                    }
                    
                    // Update manifest
                    manifest.importedPages[pageNum] = {
                        fileName: pageFileName,
                        importDate: new Date().toISOString(),
                        imageHash: page.image.hash, // This is the hash of the ORIGINAL image from the .note file
                        geminiProcessed: manifest.importedPages[pageNum]?.geminiProcessed || false,
                        hasAudio: !!page.audio,
                        lastModified: new Date().toISOString(),
                        size: page.image.blob.size,
                        backgroundColor: this.settings.backgroundColor // Track what background was applied
                    };
                    
                } catch (error: any) {
                    console.error(`Failed to import page ${pageNum}:`, error);
                    summary.errors.push({ page: pageNum, error: error.message });
                }
            });
            
            await Promise.all(batchPromises);
            
            // Allow UI to update between batches
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        progressModal.close();
        
        // Add history entry
        const historyMessage = `Imported ${summary.newPages.length} new, ${summary.modifiedPages.length} modified pages`;
        this.addHistoryEntry(manifest, 'import', pagesToImport, historyMessage);
        
        // Create or update index file
        if (this.settings.createIndex) {
            await this.createBookIndex(bookFolder, bookResult.bookName, manifest);
        }
        
        // Save manifest
        await this.saveManifest(manifestFilePath, manifest);
        
        // Process with Gemini if enabled
        if (this.settings.processWithGemini && imageFilesToProcess.length > 0) {
            await this.processWithGemini(bookFolder, imageFilesToProcess, manifest);
        }
        
        return summary;
    }
    
    async processImageWithBackground(blob: Blob): Promise<ArrayBuffer> {
        // If no background color or transparent/white, return original
        if (!this.settings.backgroundColor || 
            this.settings.backgroundColor === 'transparent' || 
            this.settings.backgroundColor === '#FFFFFF') {
            return await blob.arrayBuffer();
        }
        
        // Apply background color
        return new Promise((resolve, reject) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
                reject(new Error('Could not get canvas context'));
                return;
            }
            
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                
                // Fill background
                ctx.fillStyle = this.settings.backgroundColor;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                // Draw image on top
                ctx.drawImage(img, 0, 0);
                
                // Convert to blob
                canvas.toBlob(async (processedBlob) => {
                    if (processedBlob) {
                        resolve(await processedBlob.arrayBuffer());
                    } else {
                        reject(new Error('Failed to process image'));
                    }
                }, 'image/png', 1.0);
            };
            
            img.onerror = () => {
                reject(new Error('Failed to load image'));
            };
            
            img.src = URL.createObjectURL(blob);
        });
    }

    async createBookIndex(bookFolder: string, bookName: string, manifest: ImportManifest) {
        const indexPath = `${bookFolder}/Index.md`;
        
        // Generate the book tag
        const bookTag = bookName
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-_]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        
        // Create minimal index with just the dataview query
        let indexContent = '---\n';
        indexContent += 'cssclasses: cards\n';
        indexContent += '---\n\n';
        
        indexContent += '```dataview\n';
        indexContent += 'TABLE embed(link(image))\n';
        indexContent += `FROM #${bookTag}\n`;
        indexContent += 'SORT page ASC\n';
        indexContent += '```\n';
        
        const existingIndex = this.app.vault.getAbstractFileByPath(indexPath);
        if (existingIndex instanceof TFile) {
            await this.app.vault.modify(existingIndex, indexContent);
        } else {
            await this.app.vault.create(indexPath, indexContent);
        }
    }

    async processWithGemini(bookFolder: string, imageFiles: { file: TFile, pageNum: number }[], manifest: ImportManifest) {
        const app = this.app as any;
        
        if (!app.plugins?.enabledPlugins?.has('gemini-note-processor')) {
            new Notice('Gemini Note Processor plugin not found or disabled');
            return;
        }
        
        const geminiPlugin = app.plugins.plugins['gemini-note-processor'];
        if (!geminiPlugin) {
            new Notice('Could not access Gemini plugin');
            return;
        }
        
        new Notice(`Processing ${imageFiles.length} pages with Gemini AI...`);
        
        for (const { file, pageNum } of imageFiles) {
            try {
                const imageData = await this.app.vault.readBinary(file);
                const resultText = await geminiPlugin.callGeminiAPI(imageData);
                
                if (resultText) {
                    let processedText = resultText;
                    if (geminiPlugin.settings.enableTriggerWords) {
                        processedText = await geminiPlugin.processTriggersInText(resultText);
                    }
                    
                    // Extract tags FOR THIS PAGE ONLY
                    const pageDetectedTags: Set<string> = new Set();
                    
                    const tagRegex = /### Detected Tags\s*\n(.*?)(?:\n###|$)/s;
                    const match = processedText.match(tagRegex);
                    if (match && match[1] && match[1].toLowerCase().trim() !== 'none identified.') {
                        const tags = match[1].split(',').map((tag: string) => tag.trim()).filter((tag: string) => tag);
                        tags.forEach((tag: string) => pageDetectedTags.add(tag));
                    }
                    
                    // Update the page file
                    const pageFileName = `Page ${String(pageNum).padStart(3, '0')}.md`;
                    const pagePath = `${bookFolder}/${pageFileName}`;
                    const pageFile = this.app.vault.getAbstractFileByPath(pagePath);
                    
                    if (pageFile instanceof TFile) {
                        let content = await this.app.vault.read(pageFile);
                        const placeholder = `<!-- GEMINI_PLACEHOLDER_${pageNum} -->`;
                        const replacement = `---\n### Gemini Transcription\n${processedText}\n---`;
                        content = content.replace(placeholder, replacement);
                        await this.app.vault.modify(pageFile, content);
                        
                        // Update page metadata with detected tags FOR THIS PAGE
                        await this.app.fileManager.processFrontMatter(pageFile, (frontmatter) => {
                            frontmatter.tags = frontmatter.tags || [];
                            if (!Array.isArray(frontmatter.tags)) {
                                frontmatter.tags = [frontmatter.tags];
                            }
                            
                            // Create book tag from book name (should already exist but ensure it's there)
                            const bookTag = manifest.bookName
                                .toLowerCase()
                                .replace(/\s+/g, '-')
                                .replace(/[^a-z0-9-_]/g, '')
                                .replace(/-+/g, '-')
                                .replace(/^-|-$/g, '');
                            
                            // Ensure core tags are present
                            const coreTags = ['viwoods-import', 'handwritten', bookTag];
                            coreTags.forEach(tag => {
                                if (!frontmatter.tags.includes(tag)) {
                                    frontmatter.tags.push(tag);
                                }
                            });
                            
                            // Add detected tags FOR THIS PAGE ONLY
                            pageDetectedTags.forEach((tag: string) => {
                                if (!frontmatter.tags.includes(tag)) {
                                    frontmatter.tags.push(tag);
                                }
                            });
                            
                            // Mark as Gemini processed
                            frontmatter.gemini_processed = true;
                            // Ensure original hash is preserved
                            if (!frontmatter.original_image_hash && manifest.importedPages[pageNum]) {
                                frontmatter.original_image_hash = manifest.importedPages[pageNum].imageHash;
                            }
                        });
                        
                        // Update manifest
                        if (manifest.importedPages[pageNum]) {
                            manifest.importedPages[pageNum].geminiProcessed = true;
                        }
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.error(`Failed to process page ${pageNum} with Gemini:`, error);
            }
        }
        
        // Update manifest
        const manifestPath = `${bookFolder}/.import-manifest.json`;
        await this.saveManifest(manifestPath, manifest);
        
        // Update index
        if (this.settings.createIndex) {
            await this.createBookIndex(bookFolder, manifest.bookName, manifest);
        }
        
        new Notice(`Gemini processing complete!`);
    }

    async processImage(blob: Blob): Promise<ArrayBuffer> {
        // Don't modify the original image for storage
        // This ensures hashes remain consistent
        return await blob.arrayBuffer();
    }

    strokesToSVG(strokes: number[][], width = 1440, height = 1920): string {
        if (!strokes || strokes.length === 0) return '';
        
        const paths: number[][][] = [];
        let currentPath: number[][] = [];
        
        for (let i = 0; i < strokes.length; i++) {
            const [x, y, timestamp] = strokes[i];
            
            if (i > 0 && Math.abs(timestamp - strokes[i-1][2]) > 100) {
                if (currentPath.length > 0) {
                    paths.push(currentPath);
                }
                currentPath = [[x, y]];
            } else {
                currentPath.push([x, y]);
            }
        }
        
        if (currentPath.length > 0) {
            paths.push(currentPath);
        }
        
        const svgPaths = paths.map(path => {
            if (path.length < 2) return '';
            
            let d = `M ${path[0][0]} ${path[0][1]}`;
            for (let i = 1; i < path.length; i++) {
                d += ` L ${path[i][0]} ${path[i][1]}`;
            }
            return `<path d="${d}" stroke="black" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        }).join('\n');
        
        return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            ${svgPaths}
        </svg>`;
    }

    formatDate(timestamp: number): string {
        const date = new Date(timestamp);
        switch (this.settings.dateFormat) {
            case 'iso':
                return date.toISOString().split('T')[0];
            case 'us':
                return date.toLocaleDateString('en-US');
            case 'eu':
                return date.toLocaleDateString('en-GB');
            default:
                return date.toISOString();
        }
    }

    async processImageForDisplay(blob: Blob): Promise<ArrayBuffer> {
        // This separate function handles background color for display only
        if (this.settings.backgroundColor === 'transparent' || 
            this.settings.backgroundColor === '#FFFFFF' ||
            !this.settings.backgroundColor) {
            return await blob.arrayBuffer();
        }
        
        return new Promise((resolve) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d')!;
            
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                
                ctx.fillStyle = this.settings.backgroundColor;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                
                canvas.toBlob(async (processedBlob) => {
                    if (processedBlob) {
                        resolve(await processedBlob.arrayBuffer());
                    }
                }, 'image/png', 1.0);
            };
            
            img.src = URL.createObjectURL(blob);
        });
    }

    async ensureFolder(path: string) {
        const folders = path.split('/');
        let currentPath = '';
        
        for (const folder of folders) {
            currentPath = currentPath ? `${currentPath}/${folder}` : folder;
            const normalizedPath = normalizePath(currentPath);
            const folderExists = this.app.vault.getAbstractFileByPath(normalizedPath);
            
            if (!folderExists) {
                try {
                    await this.app.vault.createFolder(normalizedPath);
                } catch (error) {
                    // Folder might have been created by another process or already exists
                    // Just continue if we can't create it
                    const checkAgain = this.app.vault.getAbstractFileByPath(normalizedPath);
                    if (!checkAgain) {
                        console.error(`Failed to create folder ${normalizedPath}:`, error);
                        throw error; // Re-throw if folder really doesn't exist
                    }
                }
            }
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}