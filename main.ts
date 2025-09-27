// main.ts - Viwoods Notes Importer Plugin for Obsidian

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
    DropdownComponent
} from 'obsidian';

// Import JSZip - you'll need to add this to your package.json
declare global {
    interface Window {
        JSZip: any;
    }
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
}

interface Stroke {
    data: number[][];
    pageNum: number;
}

const DEFAULT_SETTINGS: ViwoodsSettings = {
    notesFolder: 'Viwoods Notes',
    imagesFolder: 'Viwoods Notes/Images',
    audioFolder: 'Viwoods Notes/Audio',
    outputFormat: 'png',
    backgroundColor: '#FFFFFF',
    includeMetadata: true,
    includeTimestamps: true,
    includeThumbnails: false,
    createIndex: false,
    dateFormat: 'iso',
    filePrefix: '',
    processWithGemini: false
};

export default class ViwoodsImporterPlugin extends Plugin {
    settings: ViwoodsSettings;

    async onload() {
        await this.loadSettings();

        // Load JSZip library
        await this.loadJSZip();

        // Add ribbon icon
        this.addRibbonIcon('import', 'Import Viwoods Note', async () => {
            new ImportModal(this.app, this).open();
        });

        // Add command
        this.addCommand({
            id: 'import-viwoods-note',
            name: 'Import Viwoods .note file',
            callback: () => {
                new ImportModal(this.app, this).open();
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
            new Notice(`Importing ${noteFiles.length} Viwoods note(s)...`);
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

    async processNoteFile(file: File) {
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
            
            // Process the note
            const result = await this.convertNote(zip, files, file.name, isNewFormat);
            
            // Save files to vault
            await this.saveToVault(result);
            
            new Notice(`Successfully imported: ${result.noteName}`);
        } catch (error) {
            console.error('Error processing note file:', error);
            new Notice(`Failed to import: ${file.name}`);
        }
    }

    async convertNote(zip: any, files: string[], fileName: string, isNewFormat: boolean) {
        let noteName = fileName.replace('.note', '').replace('.zip', '');
        let metadata: any = {};
        const images: any[] = [];
        const strokes: any[] = [];
        const audioFiles: any[] = [];
        
        // Extract audio files
        const audioFolderFiles = files.filter(f => f.startsWith('audio/') && !f.endsWith('/'));
        for (const audioFilePath of audioFolderFiles) {
            const audioFile = await zip.file(audioFilePath).async('blob');
            const audioFileName = audioFilePath.split('/').pop();
            audioFiles.push({
                blob: audioFile,
                originalName: audioFileName,
                name: `${noteName}_${audioFileName}`
            });
        }
        
        if (isNewFormat) {
            // New format processing
            const noteFileInfo = files.find(f => f.includes('NoteFileInfo.json'));
            if (noteFileInfo) {
                metadata = JSON.parse(await zip.file(noteFileInfo).async('string'));
                noteName = this.settings.filePrefix + (metadata.fileName || noteName);
            }
            
            const pageResourceFile = files.find(f => f.includes('PageResource.json'));
            if (pageResourceFile) {
                const pageResource = JSON.parse(await zip.file(pageResourceFile).async('string'));
                
                // Get images
                const mainBmpFiles = pageResource.filter((r: any) => r.fileName?.includes('mainBmp'));
                for (let i = 0; i < mainBmpFiles.length; i++) {
                    const bmpResource = mainBmpFiles[i];
                    const imageFile = files.find(f => f === bmpResource.fileName);
                    if (imageFile) {
                        const blob = await zip.file(imageFile).async('blob');
                        images.push({
                            blob,
                            pageNum: i + 1
                        });
                    }
                }
                
                // Get strokes for SVG generation
                if (this.settings.outputFormat === 'svg' || this.settings.outputFormat === 'both') {
                    const pathFiles = pageResource.filter((r: any) => r.resourceType === 7);
                    for (let i = 0; i < pathFiles.length; i++) {
                        const pathResource = pathFiles[i];
                        const pathFile = files.find(f => f.includes(pathResource.fileName));
                        if (pathFile) {
                            const strokeData = JSON.parse(await zip.file(pathFile).async('string'));
                            strokes.push({
                                data: strokeData,
                                pageNum: i + 1
                            });
                        }
                    }
                }
            }
        } else {
            // Old format processing
            const notesBeanFile = files.find(f => f.includes('NotesBean.json'));
            if (notesBeanFile) {
                metadata = JSON.parse(await zip.file(notesBeanFile).async('string'));
                noteName = this.settings.filePrefix + (metadata.nickname || metadata.noteName || noteName);
            }
            
            const noteListFile = files.find(f => f.includes('NoteList.json'));
            if (noteListFile) {
                const noteList = JSON.parse(await zip.file(noteListFile).async('string'));
                for (let i = 0; i < noteList.length; i++) {
                    const page = noteList[i];
                    const imageFile = files.find(f => f === `${page.pageId}.png`);
                    if (imageFile) {
                        const blob = await zip.file(imageFile).async('blob');
                        images.push({
                            blob,
                            pageNum: i + 1
                        });
                    }
                    
                    // Get strokes for SVG
                    if (this.settings.outputFormat === 'svg' || this.settings.outputFormat === 'both') {
                        const pathFile = files.find(f => f === `PATH_${page.pageId}.json`);
                        if (pathFile) {
                            const strokeData = JSON.parse(await zip.file(pathFile).async('string'));
                            strokes.push({
                                data: strokeData,
                                pageNum: i + 1
                            });
                        }
                    }
                }
            }
        }
        
        // Handle thumbnails if requested
        let thumbnail = null;
        if (this.settings.includeThumbnails) {
            const thumbnailFile = files.find(f => f.includes('Thumbnail') || f.includes('thumbnai'));
            if (thumbnailFile) {
                thumbnail = await zip.file(thumbnailFile).async('blob');
            }
        }
        
        return {
            noteName,
            metadata,
            images,
            strokes,
            audioFiles,
            thumbnail
        };
    }

    async saveToVault(result: any) {
        const { noteName, metadata, images, strokes, audioFiles, thumbnail } = result;
        
        // Ensure folders exist
        await this.ensureFolder(this.settings.notesFolder);
        await this.ensureFolder(this.settings.imagesFolder);
        if (audioFiles.length > 0) {
            await this.ensureFolder(this.settings.audioFolder);
        }
        
        // Generate markdown content
        let markdownContent = '';
        
        // Add frontmatter
        if (this.settings.includeMetadata) {
            markdownContent += '---\n';
            markdownContent += `title: "${noteName}"\n`;
            
            if (this.settings.includeTimestamps) {
                const createTime = metadata.createTime || metadata.creationTime;
                const updateTime = metadata.upTime || metadata.lastModifiedTime;
                if (createTime) markdownContent += `created: ${this.formatDate(createTime)}\n`;
                if (updateTime) markdownContent += `updated: ${this.formatDate(updateTime)}\n`;
            }
            
            if (audioFiles.length > 0) {
                markdownContent += 'has_audio: true\n';
            }
            
            markdownContent += 'tags: [viwoods-import, handwritten]\n';
            markdownContent += '---\n\n';
        }
        
        markdownContent += `# ${noteName}\n\n`;
        
        // Add audio section
        if (audioFiles.length > 0) {
            markdownContent += '## 🎙️ Audio Recordings\n\n';
            for (const audio of audioFiles) {
                const audioPath = `${this.settings.audioFolder}/${audio.name}`;
                await this.app.vault.createBinary(normalizePath(audioPath), await audio.blob.arrayBuffer());
                markdownContent += `![[${audio.name}]]\n`;
                markdownContent += `*Audio: ${audio.originalName}*\n\n`;
            }
            markdownContent += '---\n\n';
        }
        
        // Store image paths for Gemini processing
        const imagePaths: string[] = [];
        const imageFiles: TFile[] = [];
        
        // Process images/SVGs
        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            const pageNum = image.pageNum;
            
            if (images.length > 1) {
                markdownContent += `## Page ${pageNum}\n\n`;
            }
            
            if (this.settings.outputFormat === 'svg' || this.settings.outputFormat === 'both') {
                // Generate and save SVG
                const stroke = strokes.find((s: Stroke) => s.pageNum === pageNum);
                if (stroke) {
                    const svgContent = this.strokesToSVG(stroke.data);
                    const svgName = `${noteName}_page${pageNum}.svg`;
                    const svgPath = `${this.settings.imagesFolder}/${svgName}`;
                    await this.app.vault.create(normalizePath(svgPath), svgContent);
                    markdownContent += `![Page ${pageNum}](${svgName})\n\n`;
                }
            }
            
            if (this.settings.outputFormat === 'png' || this.settings.outputFormat === 'both') {
                // Process and save PNG with background color
                const processedImage = await this.processImage(image.blob);
                const imageName = `${noteName}_page${pageNum}.png`;
                const imagePath = `${this.settings.imagesFolder}/${imageName}`;
                const imageFile = await this.app.vault.createBinary(normalizePath(imagePath), processedImage);
                
                imagePaths.push(imagePath);
                imageFiles.push(imageFile);
                
                if (this.settings.outputFormat === 'png') {
                    markdownContent += `![Page ${pageNum}](${imageName})\n\n`;
                    
                    // Add placeholder for Gemini processing if enabled
                    if (this.settings.processWithGemini) {
                        markdownContent += `<!-- GEMINI_PLACEHOLDER_${pageNum} -->\n\n`;
                    }
                }
            }
        }
        
        // Save thumbnail if included
        if (thumbnail) {
            const thumbnailName = `${noteName}_thumbnail.png`;
            const thumbnailPath = `${this.settings.imagesFolder}/${thumbnailName}`;
            await this.app.vault.createBinary(normalizePath(thumbnailPath), await thumbnail.arrayBuffer());
        }
        
        // Add footer
        markdownContent += '\n---\n\n';
        markdownContent += `📝 *Imported from Viwoods .note format*\n`;
        markdownContent += `🕐 *Import date: ${new Date().toLocaleString()}*\n`;
        
        // Save markdown file
        const mdPath = `${this.settings.notesFolder}/${noteName}.md`;
        const newNoteFile = await this.app.vault.create(normalizePath(mdPath), markdownContent);
        
        // Trigger Gemini processing if enabled
        if (this.settings.processWithGemini && imageFiles.length > 0) {
            await this.processWithGemini(newNoteFile, imageFiles, images);
        }
    }

    async processWithGemini(noteFile: TFile, imageFiles: TFile[], images: any[]) {
        const app = this.app as any;
        
        // Check if Gemini plugin is available
        if (!app.plugins?.enabledPlugins?.has('gemini-note-processor')) {
            new Notice('Gemini Note Processor plugin not found or disabled');
            return;
        }
        
        const geminiPlugin = app.plugins.plugins['gemini-note-processor'];
        if (!geminiPlugin) {
            new Notice('Could not access Gemini plugin');
            return;
        }
        
        new Notice('Processing with Gemini AI...');
        
        // Process each image and collect results
        const processedTexts: Map<number, string> = new Map();
        const allDetectedTags: Set<string> = new Set();
        
        for (let i = 0; i < imageFiles.length; i++) {
            const imageFile = imageFiles[i];
            const pageNum = images[i].pageNum;
            
            try {
                // Read the image data
                const imageData = await this.app.vault.readBinary(imageFile);
                
                // Call Gemini API directly from the plugin
                const resultText = await geminiPlugin.callGeminiAPI(imageData);
                
                if (resultText) {
                    // Process triggers if enabled
                    let processedText = resultText;
                    if (geminiPlugin.settings.enableTriggerWords) {
                        processedText = await geminiPlugin.processTriggersInText(resultText);
                    }
                    
                    processedTexts.set(pageNum, processedText);
                    
                    // Extract detected tags from the response
                    const tagRegex = /### Detected Tags\s*\n(.*?)(?:\n###|$)/s;
                    const match = processedText.match(tagRegex);
                    if (match && match[1] && match[1].toLowerCase().trim() !== 'none identified.') {
                        const tags = match[1].split(',').map((tag: string) => tag.trim()).filter((tag: string) => tag);
                        tags.forEach((tag: string) => allDetectedTags.add(tag));
                    }
                }
                
                // Small delay between processing multiple images
                if (i < imageFiles.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (error) {
                console.error(`Failed to process image ${pageNum} with Gemini:`, error);
                new Notice(`Failed to process page ${pageNum}`);
            }
        }
        
        // Now update the note with the processed text
        if (processedTexts.size > 0) {
            let noteContent = await this.app.vault.read(noteFile);
            
            // Replace placeholders with processed text
            for (const [pageNum, text] of processedTexts) {
                const placeholder = `<!-- GEMINI_PLACEHOLDER_${pageNum} -->`;
                const replacement = `---\n### Gemini Transcription\n${text}\n---`;
                noteContent = noteContent.replace(placeholder, replacement);
            }
            
            // Update the note
            await this.app.vault.modify(noteFile, noteContent);
            
            // Update frontmatter with detected tags and other metadata
            if (allDetectedTags.size > 0 || geminiPlugin.settings.enableLocationTagging) {
                await this.updateNotePropertiesAfterGemini(noteFile, Array.from(allDetectedTags), geminiPlugin);
            }
            
            new Notice(`Gemini processing complete! Processed ${processedTexts.size} pages.`);
            
            // Open the note for viewing
            await this.app.workspace.openLinkText(noteFile.path, '', false);
        }
    }
    
    async updateNotePropertiesAfterGemini(noteFile: TFile, detectedTags: string[], geminiPlugin: any) {
        const currentYear = new Date().getFullYear();
        
        await this.app.fileManager.processFrontMatter(noteFile, (frontmatter) => {
            // Ensure tags array exists
            frontmatter.tags = frontmatter.tags || [];
            if (!Array.isArray(frontmatter.tags)) { 
                frontmatter.tags = [frontmatter.tags]; 
            }
            
            // Add detected tags from Gemini
            for (const tag of detectedTags) {
                if (tag && !frontmatter.tags.includes(tag)) {
                    frontmatter.tags.push(tag);
                }
            }
            
            // Add custom tags from Gemini settings if configured
            if (geminiPlugin.settings.customTags) {
                const customTags = geminiPlugin.settings.customTags.split(',').map((tag: string) => tag.trim()).filter((tag: string) => tag);
                for (const tag of customTags) {
                    if (tag && !frontmatter.tags.includes(tag)) {
                        frontmatter.tags.push(tag);
                    }
                }
            }
            
            // Add current year tag
            const yearTag = `notes${currentYear}`;
            if (!frontmatter.tags.includes(yearTag)) {
                frontmatter.tags.push(yearTag);
            }
            
            // Mark as processed by Gemini
            frontmatter.gemini_processed = true;
            frontmatter.gemini_processed_date = new Date().toISOString();
        });
    }

    async processImage(blob: Blob): Promise<ArrayBuffer> {
        // If background color is transparent or white, return original
        if (this.settings.backgroundColor === 'transparent' || this.settings.backgroundColor === '#FFFFFF') {
            return await blob.arrayBuffer();
        }
        
        // Process image with background color
        return new Promise((resolve) => {
            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d')!;
            
            img.onload = () => {
                canvas.width = img.width;
                canvas.height = img.height;
                
                // Fill background
                ctx.fillStyle = this.settings.backgroundColor;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                // Draw image
                ctx.drawImage(img, 0, 0);
                
                canvas.toBlob(async (processedBlob) => {
                    if (processedBlob) {
                        resolve(await processedBlob.arrayBuffer());
                    }
                }, 'image/png');
            };
            
            img.src = URL.createObjectURL(blob);
        });
    }

    strokesToSVG(strokes: number[][], width = 1440, height = 1920): string {
        if (!strokes || strokes.length === 0) return '';
        
        const paths: number[][][] = [];
        let currentPath: number[][] = [];
        
        for (let i = 0; i < strokes.length; i++) {
            const [x, y, timestamp] = strokes[i];
            
            // Start new path if timestamp gap is large
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

    async ensureFolder(path: string) {
        const folders = path.split('/');
        let currentPath = '';
        
        for (const folder of folders) {
            currentPath = currentPath ? `${currentPath}/${folder}` : folder;
            const folderExists = this.app.vault.getAbstractFileByPath(normalizePath(currentPath));
            if (!folderExists) {
                await this.app.vault.createFolder(normalizePath(currentPath));
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
            text: 'Select .note files to import or drag and drop them into Obsidian.' 
        });
        
        this.fileInput = contentEl.createEl('input', {
            type: 'file',
            attr: {
                multiple: true,
                accept: '.note,.zip'
            }
        });
        
        this.fileInput.style.marginBottom = '20px';
        
        const importBtn = contentEl.createEl('button', { text: 'Import' });
        importBtn.addEventListener('click', async () => {
            const files = Array.from(this.fileInput.files || []);
            if (files.length > 0) {
                this.close();
                new Notice(`Importing ${files.length} file(s)...`);
                for (const file of files) {
                    await this.plugin.processNoteFile(file);
                }
            } else {
                new Notice('Please select files to import');
            }
        });
        
        const cancelBtn = contentEl.createEl('button', { 
            text: 'Cancel',
            attr: { style: 'margin-left: 10px;' }
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

        // Folders Section
        containerEl.createEl('h3', { text: 'Storage Locations' });
        
        new Setting(containerEl)
            .setName('Notes folder')
            .setDesc('Where to save the markdown notes')
            .addText(text => text
                .setPlaceholder('Viwoods Notes')
                .setValue(this.plugin.settings.notesFolder)
                .onChange(async (value) => {
                    this.plugin.settings.notesFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Images folder')
            .setDesc('Where to save images and SVGs')
            .addText(text => text
                .setPlaceholder('Viwoods Notes/Images')
                .setValue(this.plugin.settings.imagesFolder)
                .onChange(async (value) => {
                    this.plugin.settings.imagesFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Audio folder')
            .setDesc('Where to save audio recordings')
            .addText(text => text
                .setPlaceholder('Viwoods Notes/Audio')
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
            .setDesc('Optional prefix for imported files')
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
        
        // Check for Gemini plugin status
        const app = this.plugin.app as any;
        const isGeminiEnabled = app.plugins?.enabledPlugins?.has('gemini-note-processor');
        const geminiPlugin = app.plugins?.plugins?.['gemini-note-processor'];
        
        if (!isGeminiEnabled) {
            containerEl.createEl('p', {
                text: '⚠️ Gemini Note Processor plugin is not installed or enabled. Please install and enable it to use this feature.',
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
            .setDesc('Automatically transcribe handwritten notes using Gemini AI after import (text will be inserted below images)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.processWithGemini)
                .onChange(async (value) => {
                    this.plugin.settings.processWithGemini = value;
                    await this.plugin.saveSettings();
                }));
        
        if (this.plugin.settings.processWithGemini && !isGeminiEnabled) {
            containerEl.createEl('p', {
                text: 'Processing is enabled but the Gemini plugin is not available. Import will continue without AI processing.',
                cls: 'setting-item-description'
            });
        }

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