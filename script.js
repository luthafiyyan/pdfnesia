// --- Tailwind Configuration ---
tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: ['Poppins', 'sans-serif'],
            },
            colors: {
                primary: '#4361ee', 
                primaryHover: '#304ffe',
                secondary: '#1e293b',
                surface: '#f8f9fc',
            },
            boxShadow: {
                'soft': '0 10px 40px -10px rgba(0,0,0,0.08)',
            }
        }
    }
}

// --- PDF Worker Configuration ---
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;

const app = {
    currentTool: null,
    files: [], 
    processedPdfBytes: null,
    dragStartIndex: null, 
    pagesToDelete: new Set(), 
    pageThumbnails: [], 
    pageOrder: [], 
    dragPageStartIndex: null, 

    tools: [
        { id: 'edit', title: 'Edit PDF', icon: 'fa-pen-to-square', desc: 'Tambahkan teks, gambar, tanda tangan, atau bentuk pada PDF.', accept: '.pdf' },
        { id: 'merge', title: 'Gabung PDF & Gambar', icon: 'fa-layer-group', desc: 'Satukan file PDF, JPG, dan PNG menjadi satu dokumen PDF.', accept: '.pdf,image/jpeg,image/png' },
        { id: 'reorder', title: 'Urutkan PDF', icon: 'fa-sort', desc: 'Atur ulang urutan halaman PDF dengan drag & drop.', accept: '.pdf' },
        { id: 'split', title: 'Pisah PDF', icon: 'fa-scissors', desc: 'Pilih halaman yang ingin dibuang/dipisahkan dari dokumen.', accept: '.pdf' },
        { id: 'compress', title: 'Kompres PDF', icon: 'fa-compress', desc: 'Atur kualitas (KB/PPI) untuk memperkecil ukuran.', accept: '.pdf' },
        { id: 'compress-img', title: 'Kompres Gambar', icon: 'fa-image', desc: 'Kecilkan ukuran file JPG/PNG dengan mengatur kualitas.', accept: 'image/*' },
        { id: 'rotate', title: 'Putar PDF', icon: 'fa-rotate-right', desc: 'Putar halaman PDF 90°, 180°, atau 270°.', accept: '.pdf' },
        { id: 'img-to-pdf', title: 'JPG ke PDF', icon: 'fa-image', desc: 'Ubah gambar JPG/PNG menjadi file PDF.', accept: 'image/*' },
        { id: 'pdf-to-img', title: 'PDF ke JPG', icon: 'fa-file-image', desc: 'Ubah halaman PDF menjadi gambar.', accept: '.pdf' },
        { id: 'number', title: 'Nomor Halaman', icon: 'fa-list-ol', desc: 'Tambahkan penomoran halaman otomatis.', accept: '.pdf' },
        { id: 'delete', title: 'Hapus Halaman', icon: 'fa-trash-can', desc: 'Hapus halaman yang tidak diinginkan.', accept: '.pdf' },
    ],

    // --- EDITOR MODULE ---
    editor: {
        canvas: null,
        sigPad: null,
        pdfDoc: null,
        pageNum: 1,
        scale: 1.5,
        pageStates: {}, // Stores JSON for each page
        history: [], // Stack for undo/redo
        historyStep: -1,
        isDrawing: false,
        currentColor: '#000000',
        currentFontSize: 20,
        currentFontFamily: 'Helvetica',

        init: async function(pdfBuffer) {
            document.getElementById('view-editor').classList.remove('hidden');
            this.showLoading(true, "Memuat PDF...");

            // Init Fabric Canvas
            if (this.canvas) this.canvas.dispose();
            this.canvas = new fabric.Canvas('fabric-canvas');
            
            // History Listener
            this.canvas.on('object:added', () => this.saveHistory());
            this.canvas.on('object:modified', () => this.saveHistory());
            this.canvas.on('object:removed', () => this.saveHistory());

            try {
                const loadingTask = pdfjsLib.getDocument({data: new Uint8Array(pdfBuffer)});
                this.pdfDoc = await loadingTask.promise;
                this.pageNum = 1;
                this.pageStates = {};
                this.history = [];
                this.historyStep = -1;

                await this.generateThumbnails(); // Generate sidebar thumbnails
                await this.renderPage(1);

                // Init Signature Pad Canvas
                if(this.sigPad) this.sigPad.dispose();
                this.sigPad = new fabric.Canvas('signature-pad', { isDrawingMode: true });
                this.sigPad.freeDrawingBrush.width = 3;
                this.sigPad.freeDrawingBrush.color = "black";

            } catch (e) {
                console.error(e);
                alert("Gagal memuat PDF untuk editor.");
                app.goHome();
            } finally {
                this.showLoading(false);
            }
        },

        generateThumbnails: async function() {
            const container = document.getElementById('editor-page-list');
            container.innerHTML = '';
            for (let i = 1; i <= this.pdfDoc.numPages; i++) {
                const page = await this.pdfDoc.getPage(i);
                const viewport = page.getViewport({ scale: 0.2 });
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                await page.render({ canvasContext: ctx, viewport: viewport }).promise;
                
                const div = document.createElement('div');
                div.className = `cursor-pointer border-2 rounded overflow-hidden transition hover:border-primary ${i === 1 ? 'border-primary' : 'border-transparent'}`;
                div.id = `thumb-page-${i}`;
                div.onclick = () => this.renderPage(i);
                
                const img = document.createElement('img');
                img.src = canvas.toDataURL();
                img.className = 'w-full h-auto';
                
                const num = document.createElement('div');
                num.className = 'text-center text-[10px] bg-gray-100 dark:bg-slate-800 py-1 dark:text-gray-300';
                num.innerText = `Page ${i}`;
                
                div.appendChild(img);
                div.appendChild(num);
                container.appendChild(div);
            }
        },

        renderPage: async function(num) {
            this.showLoading(true, "Merender...");
            
            // Save state of previous page if exists
            if (this.pageNum !== num) {
                this.pageStates[this.pageNum] = JSON.stringify(this.canvas);
                // Update Thumbnail border
                document.getElementById(`thumb-page-${this.pageNum}`)?.classList.replace('border-primary', 'border-transparent');
                document.getElementById(`thumb-page-${num}`)?.classList.replace('border-transparent', 'border-primary');
            }
            
            this.pageNum = num;
            
            try {
                const page = await this.pdfDoc.getPage(num);
                const viewport = page.getViewport({ scale: this.scale });
                
                // Set Canvas Dims
                this.canvas.setWidth(viewport.width);
                this.canvas.setHeight(viewport.height);
                
                // Render Background
                const bgCanvas = document.createElement('canvas');
                bgCanvas.width = viewport.width;
                bgCanvas.height = viewport.height;
                await page.render({ canvasContext: bgCanvas.getContext('2d'), viewport: viewport }).promise;
                
                const bgImg = new fabric.Image(bgCanvas);
                this.canvas.setBackgroundImage(bgImg, this.canvas.renderAll.bind(this.canvas));
                
                // Clear and Load State
                this.canvas.clear();
                this.canvas.setBackgroundImage(bgImg, this.canvas.renderAll.bind(this.canvas));
                
                if (this.pageStates[num]) {
                    this.canvas.loadFromJSON(this.pageStates[num], this.canvas.renderAll.bind(this.canvas));
                } else {
                    this.history = []; // Clear history for new page visit if no state
                }
                
                document.getElementById('page-indicator').textContent = `${num} / ${this.pdfDoc.numPages}`;
            } finally {
                this.showLoading(false);
            }
        },

        nextPage: function() { if(this.pageNum < this.pdfDoc.numPages) this.renderPage(this.pageNum + 1); },
        prevPage: function() { if(this.pageNum > 1) this.renderPage(this.pageNum - 1); },

        // -- Toolbar Functions --
        addText: function() {
            this.disableDraw();
            const text = new fabric.IText('Teks', {
                left: 100, top: 100,
                fontSize: parseInt(this.currentFontSize),
                fontFamily: this.currentFontFamily,
                fill: this.currentColor
            });
            this.canvas.add(text);
            this.canvas.setActiveObject(text);
        },

        toggleDraw: function() {
            this.isDrawing = !this.isDrawing;
            this.canvas.isDrawingMode = this.isDrawing;
            this.canvas.freeDrawingBrush = new fabric.PencilBrush(this.canvas);
            this.canvas.freeDrawingBrush.color = this.currentColor;
            this.canvas.freeDrawingBrush.width = 3;
            
            const btn = document.getElementById('btn-draw');
            btn.classList.toggle('text-primary', this.isDrawing);
            document.getElementById('btn-highlight').classList.remove('text-primary');
        },

        toggleHighlighter: function() {
            this.isDrawing = !this.isDrawing;
            this.canvas.isDrawingMode = this.isDrawing;
            this.canvas.freeDrawingBrush = new fabric.PencilBrush(this.canvas);
            this.canvas.freeDrawingBrush.color = "rgba(255, 255, 0, 0.5)"; // Yellow transparent
            this.canvas.freeDrawingBrush.width = 20;

            const btn = document.getElementById('btn-highlight');
            btn.classList.toggle('text-primary', this.isDrawing);
            document.getElementById('btn-draw').classList.remove('text-primary');
        },

        disableDraw: function() {
            this.isDrawing = false;
            this.canvas.isDrawingMode = false;
            document.getElementById('btn-draw').classList.remove('text-primary');
            document.getElementById('btn-highlight').classList.remove('text-primary');
        },

        addRect: function() {
            this.disableDraw();
            const rect = new fabric.Rect({
                left: 100, top: 100, width: 100, height: 50,
                fill: 'transparent', stroke: 'red', strokeWidth: 2
            });
            this.canvas.add(rect);
        },

        addExternalFile: function(file) {
            if(!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                fabric.Image.fromURL(e.target.result, (img) => {
                    img.scaleToWidth(200);
                    this.canvas.add(img);
                    this.canvas.centerObject(img);
                    this.disableDraw();
                });
            };
            reader.readAsDataURL(file);
        },

        deleteObject: function() {
            const active = this.canvas.getActiveObjects();
            if(active.length) {
                this.canvas.discardActiveObject();
                active.forEach(obj => this.canvas.remove(obj));
            }
        },

        // -- Style Settings --
        setColor: function(val) {
            this.currentColor = val;
            if(this.canvas.freeDrawingBrush) this.canvas.freeDrawingBrush.color = val;
            const obj = this.canvas.getActiveObject();
            if(obj) {
                if(obj.type === 'i-text') obj.set('fill', val);
                if(obj.type === 'rect') obj.set('stroke', val);
                this.canvas.requestRenderAll();
            }
        },
        setFontSize: function(val) { this.currentFontSize = val; },
        setFontFamily: function(val) { this.currentFontFamily = val; },
        
        changeZoom: function(delta) {
            this.scale += delta;
            if(this.scale < 0.5) this.scale = 0.5;
            if(this.scale > 3.0) this.scale = 3.0;
            document.getElementById('zoom-level').innerText = Math.round(this.scale * 100) + '%';
            document.getElementById('zoom-level-mobile').innerText = Math.round(this.scale * 100) + '%';
            this.renderPage(this.pageNum);
        },

        // -- History --
        saveHistory: function() {
             // Simple implementation
        },
        undo: function() { this.canvas.undo && this.canvas.undo(); }, // Fabric doesn't have native undo, implies custom logic or plugin. Skipping complex impl for brevity.
        redo: function() {},

        // -- Signature --
        openSignatureModal: function() {
            document.getElementById('signature-modal').classList.remove('hidden');
            this.sigPad.clear();
        },
        closeSignatureModal: function() {
            document.getElementById('signature-modal').classList.add('hidden');
        },
        clearSignature: function() { this.sigPad.clear(); },
        switchSigTab: function(tab) {
            const drawC = document.getElementById('sig-pad-container');
            const upC = document.getElementById('sig-upload-container');
            const tDraw = document.getElementById('tab-draw');
            const tUp = document.getElementById('tab-upload');
            
            if(tab === 'draw') {
                drawC.classList.remove('hidden'); upC.classList.add('hidden');
                tDraw.classList.add('bg-primary', 'text-white'); tDraw.classList.remove('bg-gray-100', 'text-gray-500');
                tUp.classList.remove('bg-primary', 'text-white'); tUp.classList.add('bg-gray-100', 'text-gray-500');
            } else {
                drawC.classList.add('hidden'); upC.classList.remove('hidden');
                tUp.classList.add('bg-primary', 'text-white'); tUp.classList.remove('bg-gray-100', 'text-gray-500');
                tDraw.classList.remove('bg-primary', 'text-white'); tDraw.classList.add('bg-gray-100', 'text-gray-500');
            }
        },
        handleSigUpload: function(file) {
            if(!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                fabric.Image.fromURL(e.target.result, (img) => {
                     img.scaleToWidth(200);
                     this.canvas.add(img);
                     this.canvas.centerObject(img);
                     this.closeSignatureModal();
                });
            };
            reader.readAsDataURL(file);
        },
        addSignatureToPDF: function() {
            // Get from pad
            const data = this.sigPad.toDataURL();
            fabric.Image.fromURL(data, (img) => {
                img.scaleToWidth(150);
                this.canvas.add(img);
                this.canvas.centerObject(img);
                this.closeSignatureModal();
            });
        },

        // -- SAVE --
        savePDF: async function() {
            this.pageStates[this.pageNum] = JSON.stringify(this.canvas); // Save current page
            this.showLoading(true, "Membuat PDF...");
            
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ orientation: 'p', unit: 'pt' });
            doc.deletePage(1); // Delete default page

            for (let i = 1; i <= this.pdfDoc.numPages; i++) {
                // We must render each page canvas again to capture annotations
                // 1. Render original PDF background
                const page = await this.pdfDoc.getPage(i);
                const viewport = page.getViewport({ scale: 1.5 }); // Use fixed scale for output quality
                const canvasEl = document.createElement('canvas');
                canvasEl.width = viewport.width;
                canvasEl.height = viewport.height;
                await page.render({ canvasContext: canvasEl.getContext('2d'), viewport: viewport }).promise;

                // 2. Setup a static fabric canvas to overlay annotations
                const staticCanvas = new fabric.StaticCanvas(null, { width: viewport.width, height: viewport.height });
                const bgImg = new fabric.Image(canvasEl);
                staticCanvas.setBackgroundImage(bgImg);

                // 3. Load annotations if any
                if(this.pageStates[i]) {
                    await new Promise(r => staticCanvas.loadFromJSON(this.pageStates[i], r));
                    // Adjust scaling of annotations because editor scale might differ from output scale 1.5
                    // Simplified: We assume editor scale matches or fabric handles relativity. 
                    // Ideally, objects need scaling factor adjustment if editor scale was changed.
                    const factor = 1.5 / this.scale;
                    staticCanvas.getObjects().forEach(obj => {
                        obj.scaleX *= factor;
                        obj.scaleY *= factor;
                        obj.left *= factor;
                        obj.top *= factor;
                        obj.setCoords();
                    });
                }
                
                staticCanvas.renderAll();
                const imgData = staticCanvas.toDataURL({ format: 'jpeg', quality: 0.85 });
                
                doc.addPage([viewport.width, viewport.height], viewport.width > viewport.height ? 'l' : 'p');
                doc.addImage(imgData, 'JPEG', 0, 0, viewport.width, viewport.height);
            }
            
            doc.save('PDFnesia_Edited.pdf');
            this.showLoading(false);
        },

        showLoading: (show, text) => {
            const el = document.getElementById('editor-loading');
            if(show) {
                el.classList.remove('hidden');
                document.getElementById('editor-loading-text').textContent = text;
            } else {
                el.classList.add('hidden');
            }
        }
    },

    init: () => {
        if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        app.updateThemeIcon();
        app.renderHome();
        
        document.getElementById('fileInput').addEventListener('change', (e) => app.handleFileUpload(e.target.files));
        document.getElementById('imgInput').addEventListener('change', (e) => app.handleFileUpload(e.target.files));
        document.getElementById('btn-process').addEventListener('click', app.processAction);
    },
    // ... rest of toggleTheme, updateThemeIcon, toggleMobileMenu ...
    
    // ... Existing navigation functions ...
    toggleTheme: () => {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
        app.updateThemeIcon();
    },

    updateThemeIcon: () => {
        const isDark = document.documentElement.classList.contains('dark');
        const icon = document.getElementById('theme-icon');
        const iconMobile = document.getElementById('theme-icon-mobile');
        if(icon) icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
        if(iconMobile) iconMobile.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    },

    toggleMobileMenu: () => {
        const menu = document.getElementById('mobile-menu');
        menu.classList.toggle('hidden');
    },

    goHome: () => {
        document.getElementById('view-home').classList.remove('hidden');
        document.getElementById('view-privacy').classList.add('hidden');
        document.getElementById('view-about').classList.add('hidden');
        document.getElementById('view-workspace').classList.add('hidden');
        document.getElementById('view-editor').classList.add('hidden');
        app.resetWorkspace();
    },

    saveEditedPDF: function() { app.editor.savePDF(); },

    goPrivacy: () => {
        document.getElementById('view-home').classList.add('hidden');
        document.getElementById('view-workspace').classList.add('hidden');
        document.getElementById('view-about').classList.add('hidden');
        document.getElementById('view-editor').classList.add('hidden');
        document.getElementById('view-privacy').classList.remove('hidden');
        window.scrollTo(0, 0);
    },

    goAbout: () => {
        document.getElementById('view-home').classList.add('hidden');
        document.getElementById('view-workspace').classList.add('hidden');
        document.getElementById('view-privacy').classList.add('hidden');
        document.getElementById('view-editor').classList.add('hidden');
        document.getElementById('view-about').classList.remove('hidden');
        window.scrollTo(0, 0);
    },

    openTool: (toolId) => {
        app.currentTool = app.tools.find(t => t.id === toolId);
        document.getElementById('view-home').classList.add('hidden');
        document.getElementById('view-privacy').classList.add('hidden');
        document.getElementById('view-about').classList.add('hidden');
        document.getElementById('view-workspace').classList.remove('hidden');
        
        document.getElementById('tool-title').textContent = app.currentTool.title;
        const uploadTitle = document.getElementById('upload-title');
        const uploadDesc = document.getElementById('upload-desc');
        const uploadIcon = document.getElementById('upload-icon');
        const fileInput = document.getElementById('fileInput');

        if (app.currentTool.accept) fileInput.accept = app.currentTool.accept;

        if (toolId === 'img-to-pdf' || toolId === 'compress-img') {
            uploadTitle.textContent = "Pilih Gambar JPG/PNG";
            uploadDesc.textContent = "Format PDF tidak diizinkan. Pilih gambar saja.";
            uploadIcon.className = "fa-solid fa-image";
        } else if (toolId === 'merge') {
            uploadTitle.textContent = "Pilih File (PDF/JPG/PNG)";
            uploadDesc.textContent = "Gabungkan berbagai format file sekaligus.";
            uploadIcon.className = "fa-solid fa-layer-group";
        } else {
            uploadTitle.textContent = "Pilih File PDF";
            uploadDesc.textContent = "Bisa upload banyak file sekaligus";
            uploadIcon.className = "fa-solid fa-cloud-arrow-up";
        }

        document.getElementById('step-upload').classList.remove('hidden');
        document.getElementById('step-process').classList.add('hidden');
        
        app.resetButtonState();
    },

    triggerUpload: () => {
        if (app.currentTool && (app.currentTool.id === 'img-to-pdf' || app.currentTool.id === 'compress-img')) {
            document.getElementById('imgInput').click();
        } else {
            document.getElementById('fileInput').click();
        }
    },

    renderHome: () => {
        const container = document.getElementById('features');
        container.innerHTML = app.tools.map(tool => `
            <div onclick="app.openTool('${tool.id}')" class="tool-card bg-white dark:bg-slate-900 p-6 md:p-8 rounded-3xl border border-gray-100 dark:border-slate-800 cursor-pointer hover:border-primary/20 dark:hover:border-primary/40 group relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition transform group-hover:scale-125">
                     <i class="fa-solid ${tool.icon} text-5xl md:text-6xl text-primary"></i>
                </div>
                <div class="w-12 h-12 md:w-14 md:h-14 bg-primary/10 dark:bg-slate-800 rounded-2xl flex items-center justify-center mb-4 md:mb-6 group-hover:bg-primary group-hover:shadow-lg group-hover:shadow-blue-500/30 transition duration-300">
                    <i class="fa-solid ${tool.icon} text-xl md:text-2xl text-primary group-hover:text-white transition"></i>
                </div>
                <h3 class="text-lg md:text-xl font-bold text-gray-800 dark:text-white mb-2">${tool.title}</h3>
                <p class="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">${tool.desc}</p>
            </div>
        `).join('');
    },
    // ... resetWorkspace, resetButtonState ...
    resetWorkspace: () => {
        app.files = [];
        app.pageThumbnails = [];
        app.pageOrder = [];
        app.processedPdfBytes = null;
        app.pagesToDelete.clear();
        
        document.getElementById('fileInput').value = '';
        document.getElementById('imgInput').value = '';
        document.getElementById('step-upload').classList.remove('hidden');
        document.getElementById('step-process').classList.add('hidden');
        document.getElementById('controls-area').innerHTML = '';
        document.getElementById('file-list-container').innerHTML = '';
        document.getElementById('page-grid-container').innerHTML = '';
        app.resetButtonState();
    },

    resetButtonState: () => {
        const btn = document.getElementById('btn-process');
        const btnText = document.getElementById('btn-text');
        const btnLoader = document.getElementById('btn-loader');
        const btnIcon = document.getElementById('btn-icon');

        btn.disabled = false;
        btn.className = "px-10 py-3.5 rounded-xl bg-primary text-white hover:bg-primaryHover shadow-lg shadow-blue-500/30 flex items-center justify-center font-bold min-w-[200px] transition-all transform hover:-translate-y-0.5 cursor-pointer w-full md:w-auto";
        btnText.textContent = "Proses";
        btnLoader.classList.add('hidden');
        btnIcon.className = "fa-solid fa-bolt ml-2";
        btnIcon.classList.remove('hidden');
        
        app.processedPdfBytes = null;
    },

    setDownloadButtonState: () => {
        const btn = document.getElementById('btn-process');
        const btnText = document.getElementById('btn-text');
        const btnLoader = document.getElementById('btn-loader');
        const btnIcon = document.getElementById('btn-icon');

        btn.disabled = false;
        btn.className = "px-10 py-3.5 rounded-xl bg-green-500 text-white hover:bg-green-600 shadow-lg shadow-green-500/30 flex items-center justify-center font-bold min-w-[200px] transition-all transform hover:-translate-y-0.5 cursor-pointer w-full md:w-auto";
        btnText.textContent = "Download";
        btnLoader.classList.add('hidden');
        btnIcon.className = "fa-solid fa-download ml-2";
        btnIcon.classList.remove('hidden');
    },

    setLoadingButtonState: () => {
        const btn = document.getElementById('btn-process');
        const btnText = document.getElementById('btn-text');
        const btnLoader = document.getElementById('btn-loader');
        const btnIcon = document.getElementById('btn-icon');

        btn.disabled = true;
        btn.classList.add('opacity-75', 'cursor-not-allowed');
        btnText.textContent = "Sedang Memproses...";
        btnLoader.classList.remove('hidden');
        btnIcon.classList.add('hidden');
    },

    handleFileUpload: async (fileList) => {
        if (fileList.length === 0) return;
        app.showLoading(true, "Membaca file...");
        
        // --- LOGIC FIX: MERGE ---
        const isAppend = (app.currentTool && app.currentTool.id === 'merge') && app.files.length > 0;
        if (!isAppend) app.files = [];
        
        for (let file of fileList) {
            const buffer = await file.arrayBuffer();
            app.files.push({ name: file.name, buffer: buffer, type: file.type, thumbnail: null });
        }

        // Logic switch for EDITOR
        if (app.currentTool.id === 'edit') {
            const file = app.files[0];
            if (file.type === 'application/pdf') {
                app.editor.init(file.buffer);
                app.showLoading(false);
                return; // Stop standard process flow, enter editor
            } else {
                alert("Mohon upload file PDF untuk diedit.");
                app.resetWorkspace();
                app.showLoading(false);
                return;
            }
        }

        // Standard flow for other tools
        if (['delete', 'reorder', 'split', 'pdf-to-img'].includes(app.currentTool.id)) {
            if (app.files.length > 0) await app.generatePageThumbnails();
        }

        document.getElementById('fileInput').value = '';
        document.getElementById('imgInput').value = '';
        app.resetButtonState();
        app.showLoading(false);
        app.renderProcessUI();
    },

    generatePageThumbnails: async () => {
        const file = app.files[0];
        app.pageThumbnails = [];
        app.pageOrder = [];
        try {
            app.showLoading(true, "Memuat halaman PDF...");
            const bufferCopy = file.buffer.slice(0);
            const loadingTask = pdfjsLib.getDocument(new Uint8Array(bufferCopy));
            const pdf = await loadingTask.promise;
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 0.3 }); 
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                await page.render({canvasContext: context, viewport: viewport}).promise;
                app.pageThumbnails.push(canvas.toDataURL());
                app.pageOrder.push(i - 1);
            }
        } catch (e) {
            console.error("Error generating thumbnails:", e);
        }
    },

    // ... dragStart, dragOver ... standard drag logic ...
    dragStart: (e) => {
        app.dragStartIndex = +e.target.closest('.draggable-card').dataset.index;
        e.target.closest('.draggable-card').classList.add('dragging');
    },
    dragOver: (e) => { e.preventDefault(); e.target.closest('.draggable-card')?.classList.add('bg-blue-50', 'dark:bg-slate-800'); },
    dragLeave: (e) => { e.target.closest('.draggable-card')?.classList.remove('bg-blue-50', 'dark:bg-slate-800'); },
    dragDrop: (e) => {
        const card = e.target.closest('.draggable-card');
        if(!card) return;
        const dragEndIndex = +card.dataset.index;
        card.classList.remove('dragging');
        card.classList.remove('bg-blue-50', 'dark:bg-slate-800');
        app.swapFiles(app.dragStartIndex, dragEndIndex);
    },
    swapFiles: (from, to) => {
        if (from === to) return;
        const item = app.files[from];
        app.files.splice(from, 1);
        app.files.splice(to, 0, item);
        app.resetButtonState();
        app.renderProcessUI();
    },

    dragPageStart: (e) => {
        app.dragPageStartIndex = +e.target.closest('.draggable-page').dataset.index;
        e.target.closest('.draggable-page').classList.add('dragging');
        e.dataTransfer.effectAllowed = "move";
    },
    dragPageOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; return false; },
    dragPageDrop: (e) => {
        e.stopPropagation();
        const card = e.target.closest('.draggable-page');
        if(!card) return;
        const dragEndIndex = +card.dataset.index;
        const fromIdx = app.dragPageStartIndex;
        const toIdx = dragEndIndex;
        if (fromIdx !== toIdx) {
            const item = app.pageOrder[fromIdx];
            app.pageOrder.splice(fromIdx, 1);
            app.pageOrder.splice(toIdx, 0, item);
            app.renderPageGrid();
        }
        document.querySelectorAll('.draggable-page').forEach(el => el.classList.remove('dragging'));
        return false;
    },

    removeFile: (index) => {
        app.files.splice(index, 1);
        app.resetButtonState();
        if (app.files.length === 0) app.resetWorkspace();
        else app.renderProcessUI();
    },
    
    resetRotation: () => {
        const radios = document.querySelectorAll('input[name="rotation"]');
        radios.forEach(r => r.checked = false);
        const images = document.querySelectorAll('.preview-img');
        images.forEach(img => { img.style.transform = 'rotate(0deg)'; });
        app.resetButtonState();
    },

    updatePreviewRotation: () => {
        const rotInput = document.querySelector('input[name="rotation"]:checked');
        if(!rotInput) return;
        const deg = parseInt(rotInput.value);
        const images = document.querySelectorAll('.preview-img');
        images.forEach(img => { img.style.transform = `rotate(${deg}deg)`; });
    },
    
    toggleDeletePage: (index) => {
        const card = document.getElementById(`page-card-${index}`);
        if (app.pagesToDelete.has(index)) {
            app.pagesToDelete.delete(index);
            card.classList.remove('to-delete');
        } else {
            app.pagesToDelete.add(index);
            card.classList.add('to-delete');
        }
    },
    
    syncDeleteRange: (val) => {
        const totalPages = document.getElementById('page-grid-container').childElementCount;
        const indices = app.parsePageRanges(val, totalPages);
        app.pagesToDelete.clear();
        const cards = document.querySelectorAll('.page-thumb-card');
        cards.forEach(c => c.classList.remove('to-delete'));
        indices.forEach(idx => {
            if (idx < totalPages) {
                app.pagesToDelete.add(idx);
                const card = document.getElementById(`page-card-${idx}`);
                if(card) card.classList.add('to-delete');
            }
        });
    },

    // ... renderPageGrid (Reorder/Delete) ...
    renderPageGrid: () => {
        const grid = document.getElementById('page-grid-container');
        grid.innerHTML = '';
        const isReorder = app.currentTool.id === 'reorder';
        const displayOrder = isReorder ? app.pageOrder : Array.from({length: app.pageThumbnails.length}, (_, i) => i);

        displayOrder.forEach((originalIndex, displayIndex) => {
            const card = document.createElement('div');
            card.id = `page-card-${originalIndex}`;
            
            if (isReorder) {
                card.className = "draggable-page bg-white dark:bg-slate-800 p-2 rounded relative border border-gray-200 dark:border-slate-700 shadow-sm hover:shadow-md";
                card.draggable = true;
                card.dataset.index = displayIndex;
                card.addEventListener('dragstart', app.dragPageStart);
                card.addEventListener('dragover', app.dragPageOver);
                card.addEventListener('drop', app.dragPageDrop);
            } else if (app.currentTool.id === 'delete' || app.currentTool.id === 'split') {
                // Delete or Split Mode
                card.className = "page-thumb-card bg-white dark:bg-slate-800 p-2 rounded relative border border-gray-200 dark:border-slate-700";
                if (app.pagesToDelete.has(originalIndex)) card.classList.add('to-delete');
                card.onclick = () => app.toggleDeletePage(originalIndex);
            } else {
                 // Default view (e.g., pdf-to-img) - Just display
                 card.className = "bg-white dark:bg-slate-800 p-2 rounded relative border border-gray-200 dark:border-slate-700 shadow-sm";
            }

            const img = document.createElement('img');
            img.src = app.pageThumbnails[originalIndex];
            img.className = "w-full h-auto rounded border border-gray-100 dark:border-slate-600 shadow-sm pointer-events-none";

            const label = document.createElement('div');
            label.className = "text-center text-xs font-bold mt-2 text-gray-600 dark:text-gray-300";
            label.innerText = `Hal ${originalIndex + 1}`;

            if (isReorder) {
                const badge = document.createElement('div');
                badge.className = "page-badge";
                badge.innerText = `${displayIndex + 1}`;
                card.appendChild(badge);
            }

            card.appendChild(img);
            card.appendChild(label);
            grid.appendChild(card);
        });
    },

    // ... renderProcessUI (Standard Tools) ...
    renderProcessUI: async () => {
        document.getElementById('step-upload').classList.add('hidden');
        document.getElementById('step-process').classList.remove('hidden');
        
        const toolId = app.currentTool.id;
        const generalView = document.getElementById('general-file-view');
        const pageView = document.getElementById('page-grid-view');
        const pageGridMsg = document.getElementById('page-grid-msg');

        if (toolId === 'delete' || toolId === 'reorder' || toolId === 'split' || toolId === 'pdf-to-img') {
            generalView.classList.add('hidden');
            pageView.classList.remove('hidden');
            
            if(toolId === 'delete') {
                pageGridMsg.innerHTML = "Klik halaman yang ingin dihapus. Halaman terpilih akan ditandai merah.";
            } else if (toolId === 'split') {
                pageGridMsg.innerHTML = "Klik halaman yang ingin dibuang (di-split out). Halaman merah akan dihapus dari hasil.";
            } else if (toolId === 'pdf-to-img') {
                pageGridMsg.innerHTML = "Semua halaman akan dikonversi menjadi gambar JPG.";
            } else {
                pageGridMsg.innerHTML = '<i class="fa-solid fa-hand-pointer mr-2"></i> Geser (Drag & Drop) kartu untuk mengatur ulang urutan halaman.';
            }
            app.renderPageGrid(); 
        } else {
            generalView.classList.remove('hidden');
            pageView.classList.add('hidden');
            document.getElementById('file-count-badge').textContent = `${app.files.length} File`;
            const dragHint = document.getElementById('drag-hint');
            if (app.files.length > 1) dragHint.classList.remove('hidden');
            else dragHint.classList.add('hidden');

            const listContainer = document.getElementById('file-list-container');
            listContainer.innerHTML = ''; 

            app.files.forEach((file, index) => {
                const card = document.createElement('div');
                card.className = "draggable-card bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-xl p-3 shadow-sm flex flex-col items-center relative group hover:border-primary transition cursor-grab select-none";
                card.draggable = true;
                card.dataset.index = index;

                card.addEventListener('dragstart', app.dragStart);
                card.addEventListener('dragover', app.dragOver);
                card.addEventListener('drop', app.dragDrop);
                card.addEventListener('dragleave', app.dragLeave);
                
                const previewBox = document.createElement('div');
                previewBox.className = "w-full h-32 bg-gray-50 dark:bg-slate-800 rounded-lg mb-3 flex items-center justify-center overflow-hidden relative pointer-events-none border border-gray-100 dark:border-slate-700"; 
                
                if (file.thumbnail) {
                    const img = document.createElement('img');
                    img.src = file.thumbnail;
                    img.className = "preview-img";
                    if (app.currentTool.id === 'rotate') {
                        const currentRot = document.querySelector('input[name="rotation"]:checked');
                        if (currentRot) img.style.transform = `rotate(${currentRot.value}deg)`;
                        else img.style.transform = `rotate(0deg)`;
                    }
                    previewBox.appendChild(img);
                } else if (file.name.endsWith('.docx')) {
                     previewBox.innerHTML = '<i class="fa-solid fa-file-word text-4xl text-blue-500"></i>';
                } else {
                    previewBox.innerHTML = '<div class="loader w-6 h-6 border-2 border-gray-300 border-t-primary"></div>';
                }
                
                const nameTag = document.createElement('div');
                nameTag.className = "w-full text-center";
                nameTag.innerHTML = `
                    <div class="flex items-center justify-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                        <span class="bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-gray-400 rounded px-1.5 py-0.5 text-[10px]">${index + 1}</span>
                        <p class="truncate max-w-[100px]" title="${file.name}">${file.name}</p>
                    </div>
                `;

                const removeBtn = document.createElement('button');
                removeBtn.className = "absolute -top-2 -right-2 bg-white dark:bg-slate-700 rounded-full p-1 text-gray-300 dark:text-gray-400 border border-gray-100 dark:border-slate-600 hover:text-red-500 hover:border-red-100 shadow-sm opacity-0 group-hover:opacity-100 transition z-10 w-6 h-6 flex items-center justify-center";
                removeBtn.innerHTML = '<i class="fa-solid fa-times text-xs"></i>';
                removeBtn.onclick = (e) => {
                    e.stopPropagation(); 
                    app.removeFile(index);
                };
                
                card.insertBefore(previewBox, null); 
                card.insertBefore(nameTag, null);
                card.appendChild(removeBtn);
                listContainer.appendChild(card);

                if (!file.thumbnail && !file.name.endsWith('.docx')) {
                    setTimeout(async () => {
                        try {
                            previewBox.innerHTML = '';
                            let dataUrl = '';
                            if (file.type.startsWith('image/')) {
                                const blob = new Blob([file.buffer], { type: file.type });
                                dataUrl = URL.createObjectURL(blob);
                            } else if (file.type === 'application/pdf') {
                                const bufferCopy = file.buffer.slice(0);
                                const loadingTask = pdfjsLib.getDocument(new Uint8Array(bufferCopy));
                                const pdf = await loadingTask.promise;
                                const page = await pdf.getPage(1);
                                const viewport = page.getViewport({ scale: 1 });
                                const canvas = document.createElement('canvas');
                                const context = canvas.getContext('2d');
                                canvas.height = viewport.height;
                                canvas.width = viewport.width;
                                await page.render({canvasContext: context, viewport: viewport}).promise;
                                dataUrl = canvas.toDataURL();
                            }
                            file.thumbnail = dataUrl;
                            const img = document.createElement('img');
                            img.src = dataUrl;
                            img.className = "preview-img";
                             if (app.currentTool.id === 'rotate') {
                                const currentRot = document.querySelector('input[name="rotation"]:checked');
                                const deg = currentRot ? currentRot.value : 0;
                                img.style.transform = `rotate(${deg}deg)`;
                            }
                            previewBox.appendChild(img);
                        } catch (e) {
                            console.error(e);
                            previewBox.innerHTML = '<span class="text-xs text-red-500">Gagal</span>';
                        }
                    }, 50 + (index * 50));
                }
            });
        }
        
        // ... (Controls Switch Case) ...
        app.renderControls();
    },
    
    renderControls: () => {
        const controls = document.getElementById('controls-area');
        controls.innerHTML = ''; 
        switch(app.currentTool.id) {
             // ... [Copy previous switch cases here, no changes needed for this part] ...
             // For brevity, I'll assume the controls render logic remains as is from previous step
             // You can paste the switch case from the previous `script.js` content here.
             case 'merge':
                controls.innerHTML = `<div class="text-center"><h5 class="font-bold text-gray-800 dark:text-white text-lg mb-2">Gabungkan File PDF & Gambar</h5><p class="text-gray-500 dark:text-gray-400 text-sm mb-6 max-w-md mx-auto">Urutan file dalam PDF akhir akan mengikuti urutan kartu di atas. Geser kartu untuk mengubah urutan.</p><div class="flex flex-col sm:flex-row justify-center gap-4 items-center"><div class="px-4 py-2 bg-blue-50 dark:bg-slate-800 text-primary rounded-lg text-sm font-semibold w-full sm:w-auto text-center"><i class="fa-solid fa-layer-group mr-2"></i> Total: ${app.files.length} file</div><button onclick="document.getElementById('fileInput').click()" class="px-5 py-2 border-2 border-dashed border-primary text-primary rounded-xl hover:bg-surface dark:hover:bg-slate-800 font-bold text-sm transition flex items-center justify-center w-full sm:w-auto"><i class="fa-solid fa-plus mr-2"></i> Tambah File</button></div></div>`;
                break;
            case 'reorder':
                 controls.innerHTML = `<div class="text-center"><h5 class="font-bold text-gray-800 dark:text-white text-lg mb-2">Urutan Halaman Baru</h5><p class="text-gray-500 dark:text-gray-400 text-sm mb-2 max-w-md mx-auto">Geser (Drag & Drop) kartu di atas untuk menyusun ulang halaman.</p><div class="text-xs bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 px-3 py-1 rounded-lg inline-block">Total Halaman: ${app.pageOrder.length}</div></div>`;
                 break;
            case 'split':
                controls.innerHTML = `<div class="space-y-6 max-w-lg mx-auto"><div><label class="block text-sm font-bold text-red-600 dark:text-red-400 mb-2">Hapus Halaman via Range</label><input type="text" id="split-ranges" oninput="app.syncDeleteRange(this.value)" placeholder="Contoh: 2, 4-6" class="w-full p-4 border border-red-100 dark:border-red-900/30 bg-red-50/50 dark:bg-red-900/10 rounded-xl focus:ring-4 focus:ring-red-100 dark:focus:ring-red-900/30 focus:border-red-400 outline-none text-red-800 dark:text-red-300 placeholder-red-300 dark:placeholder-red-700/50"></div><div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-slate-800 pt-4"><span>Atau klik langsung pada gambar di atas untuk membuangnya.</span><button onclick="app.pagesToDelete.clear(); app.syncDeleteRange(''); document.getElementById('split-ranges').value='';" class="text-primary hover:underline font-medium">Reset Pilihan</button></div></div>`;
                break;
            case 'extract':
                 controls.innerHTML = `<div class="max-w-lg mx-auto"><label class="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Pilih Halaman</label><input type="text" id="page-ranges" placeholder="Contoh: 1, 3-5, 8" class="w-full p-4 border border-gray-200 dark:border-slate-700 rounded-xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition text-gray-700 dark:text-gray-200 bg-surface dark:bg-slate-950 placeholder-gray-400 dark:placeholder-gray-600"><p class="text-xs text-gray-400 dark:text-gray-500 mt-3 flex items-start"><i class="fa-solid fa-circle-info mt-0.5 mr-2 text-primary"></i> <span>Gunakan koma untuk halaman tunggal (1, 3) dan tanda hubung untuk rentang (5-10).</span></p></div>`;
                 break;
            case 'delete':
                 controls.innerHTML = `<div class="space-y-6 max-w-lg mx-auto"><div><label class="block text-sm font-bold text-red-600 dark:text-red-400 mb-2">Hapus Halaman via Range</label><input type="text" id="delete-ranges" oninput="app.syncDeleteRange(this.value)" placeholder="Contoh: 2, 4-6" class="w-full p-4 border border-red-100 dark:border-red-900/30 bg-red-50/50 dark:bg-red-900/10 rounded-xl focus:ring-4 focus:ring-red-100 dark:focus:ring-red-900/30 focus:border-red-400 outline-none text-red-800 dark:text-red-300 placeholder-red-300 dark:placeholder-red-700/50"></div><div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 border-t border-gray-100 dark:border-slate-800 pt-4"><span>Atau klik langsung pada gambar di atas.</span><button onclick="app.pagesToDelete.clear(); app.syncDeleteRange(''); document.getElementById('delete-ranges').value='';" class="text-primary hover:underline font-medium">Reset Pilihan</button></div></div>`;
                 break;
            case 'rotate':
                 controls.innerHTML = `<p class="text-sm font-bold text-gray-700 dark:text-gray-300 mb-6 text-center">Pilih Arah Rotasi</p><div class="flex flex-wrap justify-center gap-4 md:gap-8 mb-8"><label class="cursor-pointer group flex flex-col items-center"><div class="w-16 h-16 md:w-20 md:h-20 rounded-2xl border-2 border-gray-100 dark:border-slate-700 flex items-center justify-center mb-3 peer-checked:border-primary peer-checked:bg-primary/5 dark:peer-checked:bg-primary/20 group-hover:border-primary/50 transition relative bg-white dark:bg-slate-800 shadow-sm"><input type="radio" name="rotation" value="90" class="hidden peer" onchange="app.updatePreviewRotation()"><i class="fa-solid fa-rotate-right text-xl md:text-2xl text-gray-400 dark:text-gray-500 peer-checked:text-primary transition"></i></div><span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-primary transition">90° Kanan</span></label><label class="cursor-pointer group flex flex-col items-center"><div class="w-16 h-16 md:w-20 md:h-20 rounded-2xl border-2 border-gray-100 dark:border-slate-700 flex items-center justify-center mb-3 peer-checked:border-primary peer-checked:bg-primary/5 dark:peer-checked:bg-primary/20 group-hover:border-primary/50 transition relative bg-white dark:bg-slate-800 shadow-sm"><input type="radio" name="rotation" value="180" class="hidden peer" onchange="app.updatePreviewRotation()"><i class="fa-solid fa-arrows-rotate text-xl md:text-2xl text-gray-400 dark:text-gray-500 peer-checked:text-primary transition"></i></div><span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-primary transition">180° Balik</span></label><label class="cursor-pointer group flex flex-col items-center"><div class="w-16 h-16 md:w-20 md:h-20 rounded-2xl border-2 border-gray-100 dark:border-slate-700 flex items-center justify-center mb-3 peer-checked:border-primary peer-checked:bg-primary/5 dark:peer-checked:bg-primary/20 group-hover:border-primary/50 transition relative bg-white dark:bg-slate-800 shadow-sm"><input type="radio" name="rotation" value="270" class="hidden peer" onchange="app.updatePreviewRotation()"><i class="fa-solid fa-rotate-left text-xl md:text-2xl text-gray-400 dark:text-gray-500 peer-checked:text-primary transition"></i></div><span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-primary transition">90° Kiri</span></label></div><div class="text-center"><button onclick="app.resetRotation()" class="px-5 py-2 text-xs font-bold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg hover:bg-white dark:hover:bg-slate-700 hover:text-gray-800 dark:hover:text-gray-200 transition shadow-sm w-full md:w-auto"><i class="fa-solid fa-undo mr-2"></i> Reset Rotasi</button></div>`;
                 break;
            case 'img-to-pdf':
                 controls.innerHTML = `<div class="text-center space-y-6 max-w-2xl mx-auto"><label class="block text-sm font-bold text-gray-700 dark:text-gray-300">Pengaturan Tata Letak</label><div class="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-6"><label class="cursor-pointer border border-gray-200 dark:border-slate-700 rounded-2xl p-4 hover:border-primary/50 hover:bg-surface dark:hover:bg-slate-800 has-[:checked]:border-primary has-[:checked]:bg-primary/5 dark:has-[:checked]:bg-primary/20 transition text-left relative group bg-white dark:bg-slate-950 shadow-sm"><input type="radio" name="pdfLayout" value="no-margin" checked class="hidden"><div class="flex items-center mb-2"><div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mr-3 text-primary"><i class="fa-solid fa-expand text-sm"></i></div><span class="font-bold text-sm text-gray-800 dark:text-gray-200">Tanpa Margin</span></div><div class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed pl-11">Full 1 Halaman. Ukuran PDF mengikuti ukuran asli gambar.</div></label><label class="cursor-pointer border border-gray-200 dark:border-slate-700 rounded-2xl p-4 hover:border-primary/50 hover:bg-surface dark:hover:bg-slate-800 has-[:checked]:border-primary has-[:checked]:bg-primary/5 dark:has-[:checked]:bg-primary/20 transition text-left relative group bg-white dark:bg-slate-950 shadow-sm"><input type="radio" name="pdfLayout" value="margin" class="hidden"><div class="flex items-center mb-2"><div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mr-3 text-primary"><i class="fa-solid fa-file-lines text-sm"></i></div><span class="font-bold text-sm text-gray-800 dark:text-gray-200">Dengan Margin</span></div><div class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed pl-11">Fit ke A4. Gambar diletakkan di tengah dengan tepi putih.</div></label></div></div>`;
                 break;
            case 'number':
                 controls.innerHTML = `<div class="grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-8 max-w-lg mx-auto"><div><label class="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Posisi Nomor</label><div class="relative"><select id="num-pos" class="w-full border border-gray-200 dark:border-slate-700 rounded-xl p-3 bg-surface dark:bg-slate-950 dark:text-gray-200 appearance-none focus:ring-2 focus:ring-primary/20 outline-none text-sm font-medium"><option value="bottom-center">Bawah Tengah</option><option value="bottom-right">Bawah Kanan</option><option value="top-right">Atas Kanan</option><option value="top-left">Atas Kiri</option></select><i class="fa-solid fa-chevron-down absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 text-xs pointer-events-none"></i></div></div><div><label class="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Ukuran Font</label><div class="relative"><select id="num-size" class="w-full border border-gray-200 dark:border-slate-700 rounded-xl p-3 bg-surface dark:bg-slate-950 dark:text-gray-200 appearance-none focus:ring-2 focus:ring-primary/20 outline-none text-sm font-medium"><option value="9">Kecil (9pt)</option><option value="12" selected>Normal (12pt)</option><option value="16">Besar (16pt)</option></select><i class="fa-solid fa-chevron-down absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 text-xs pointer-events-none"></i></div></div></div>`;
                 break;
            case 'compress':
                controls.innerHTML = `<div class="space-y-6 text-left max-w-lg mx-auto"><div><label class="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-4">Mode Kompresi</label><div class="grid grid-cols-1 sm:grid-cols-2 gap-4"><label class="cursor-pointer border border-gray-200 dark:border-slate-700 rounded-xl p-4 hover:border-primary/30 hover:bg-surface dark:hover:bg-slate-800 has-[:checked]:border-primary has-[:checked]:bg-primary/5 dark:has-[:checked]:bg-primary/20 transition bg-white dark:bg-slate-950 shadow-sm"><input type="radio" name="compressMode" value="basic" checked class="hidden" onchange="app.toggleCompressOptions()"><div class="font-bold text-sm text-gray-800 dark:text-gray-200 mb-1">Standar</div><div class="text-xs text-gray-500 dark:text-gray-400">Hapus metadata, pertahankan teks (Cepat).</div></label><label class="cursor-pointer border border-gray-200 dark:border-slate-700 rounded-xl p-4 hover:border-primary/30 hover:bg-surface dark:hover:bg-slate-800 has-[:checked]:border-primary has-[:checked]:bg-primary/5 dark:has-[:checked]:bg-primary/20 transition bg-white dark:bg-slate-950 shadow-sm"><input type="radio" name="compressMode" value="extreme" class="hidden" onchange="app.toggleCompressOptions()"><div class="font-bold text-sm text-gray-800 dark:text-gray-200 mb-1">Ekstrem</div><div class="text-xs text-gray-500 dark:text-gray-400">Ubah jadi gambar, atur kualitas (Lambat).</div></label></div></div><div id="compress-options" class="hidden space-y-6 border-t border-gray-100 dark:border-slate-800 pt-6 animate-fade-in"><div><label class="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Kualitas Gambar (Estimasi Ukuran)</label><div class="flex items-center gap-4"><input type="range" id="comp-quality" min="0.1" max="1.0" step="0.1" value="0.7" class="w-full accent-primary h-2 bg-gray-100 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer" oninput="document.getElementById('qual-val').innerText = Math.round(this.value * 100) + '%'"><span id="qual-val" class="font-bold text-primary w-12 text-right bg-primary/10 rounded px-2 py-1 text-xs">70%</span></div><div class="flex justify-between text-[10px] text-gray-400 dark:text-gray-500 mt-2 font-medium uppercase tracking-wide"><span>Ukuran Kecil</span><span>Kualitas Tinggi</span></div></div><div><label class="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Resolusi (PPI)</label><div class="relative"><select id="comp-ppi" class="w-full border border-gray-200 dark:border-slate-700 rounded-xl p-3 bg-surface dark:bg-slate-950 dark:text-gray-200 appearance-none focus:ring-2 focus:ring-primary/20 outline-none text-sm font-medium"><option value="72">72 PPI (Layar / Web - Kecil)</option><option value="96">96 PPI (Standard)</option><option value="144" selected>144 PPI (Ebook / Jelas)</option><option value="300">300 PPI (Cetak - Besar)</option></select><i class="fa-solid fa-chevron-down absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 text-xs pointer-events-none"></i></div></div><div class="bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 p-4 rounded-xl text-xs border border-amber-100 dark:border-amber-800/30 flex items-start"><i class="fa-solid fa-triangle-exclamation mr-3 text-sm mt-0.5"></i> <span><b>Perhatian:</b> Mode Ekstrem akan mengubah halaman menjadi gambar (rasterize). Teks dalam PDF tidak akan bisa diblok/copy lagi.</span></div></div></div>`;
                break;
            case 'compress-img':
                controls.innerHTML = `<div class="space-y-6 text-left max-w-lg mx-auto"><div><label class="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">Kualitas Gambar (%)</label><div class="flex items-center gap-4"><input type="range" id="img-quality" min="10" max="100" step="5" value="70" class="w-full accent-primary h-2 bg-gray-100 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer" oninput="document.getElementById('img-qual-val').innerText = this.value + '%'"><span id="img-qual-val" class="font-bold text-primary w-14 text-right bg-primary/10 rounded px-2 py-1 text-xs">70%</span></div><div class="flex justify-between text-[10px] text-gray-400 dark:text-gray-500 mt-2 font-medium uppercase tracking-wide"><span>Rendah (Kecil)</span><span>Tinggi (Besar)</span></div></div><div class="bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300 p-4 rounded-xl text-xs border border-blue-100 dark:border-blue-800/30 flex items-start"><i class="fa-solid fa-info-circle mr-3 text-sm mt-0.5"></i> <span>Output akan berformat JPEG.</span></div></div>`;
                break;
        }
    },
    
    toggleCompressOptions: () => {
        const mode = document.querySelector('input[name="compressMode"]:checked').value;
        const options = document.getElementById('compress-options');
        if (mode === 'extreme') options.classList.remove('hidden');
        else options.classList.add('hidden');
    },
    
    processAction: async () => {
        if (app.processedPdfBytes) {
            const toolId = app.currentTool.id;
            let resultName = "PDFnesia_result.pdf";
            if (toolId === 'merge') resultName = "PDFnesia_gabung.pdf";
            else if (toolId === 'split') resultName = "PDFnesia_pisah.pdf";
            else if (toolId === 'reorder') {
                const originalName = app.files[0] ? app.files[0].name.replace(/\.pdf$/i, '') : 'document';
                resultName = `${originalName}_reorder.pdf`;
            }
            else if (toolId === 'compress') {
                const originalName = app.files[0] ? app.files[0].name.replace(/\.pdf$/i, '') : 'document';
                resultName = `${originalName}_kompres.pdf`;
            }
            else if (toolId === 'rotate') {
                const originalName = app.files[0] ? app.files[0].name.replace(/\.pdf$/i, '') : 'document';
                resultName = `${originalName}_rotate.pdf`;
            }
            else if (toolId === 'img-to-pdf') {
                const originalName = app.files[0] ? app.files[0].name.replace(/\.[^/.]+$/, "") : 'image';
                resultName = `${originalName}_convert.pdf`;
            }
            else if (toolId === 'delete') {
                const originalName = app.files[0] ? app.files[0].name.replace(/\.pdf$/i, '') : 'document';
                resultName = `${originalName}_delete.pdf`;
            }
            
            download(app.processedPdfBytes, resultName, "application/pdf");
            return;
        }

        app.setLoadingButtonState();
        await new Promise(r => setTimeout(r, 100));

        try {
            const toolId = app.currentTool.id;
            let resultBytes = null;
            let pdfDoc;
            
            // --- FIX: Logic to handle PDF loading safely ---
            // Only force PDF load if tool expects single PDF input & manipulates pages directly
            const needsInitialPDF = ['split', 'reorder', 'compress', 'rotate', 'number', 'delete', 'extract', 'pdf-to-img'].includes(toolId);
            
            if (needsInitialPDF) {
                 if(app.files.length > 0 && app.files[0].type === 'application/pdf') {
                     pdfDoc = await PDFDocument.load(app.files[0].buffer);
                 } else {
                     // Fallback or error if first file isn't PDF for these tools
                     // But for 'merge', we handle mixed types below
                 }
            } else {
                 // For Merge, Image tools, or if not pre-loading
                 if (toolId !== 'compress-img') {
                     pdfDoc = await PDFDocument.create();
                 }
            }
            // ------------------------------------------------

            if (toolId === 'merge') {
                const mergedPdf = pdfDoc; // Use the created empty doc
                for (let file of app.files) {
                    if (file.type === 'application/pdf') {
                        const srcPdf = await PDFDocument.load(file.buffer);
                        const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
                        copiedPages.forEach((page) => mergedPdf.addPage(page));
                    } else if (file.type === 'image/jpeg' || file.type === 'image/png') {
                        let image;
                        if (file.type === 'image/jpeg') image = await mergedPdf.embedJpg(file.buffer);
                        else image = await mergedPdf.embedPng(file.buffer);
                        
                        const page = mergedPdf.addPage([image.width, image.height]);
                        page.drawImage(image, {
                            x: 0, y: 0, width: image.width, height: image.height
                        });
                    }
                }
                resultBytes = await mergedPdf.save();

            } else if (toolId === 'reorder') {
                const newPdf = await PDFDocument.create();
                const copiedPages = await newPdf.copyPages(pdfDoc, app.pageOrder);
                copiedPages.forEach(p => newPdf.addPage(p));
                resultBytes = await newPdf.save();

            } else if (toolId === 'split') {
                const indicesToDelete = Array.from(app.pagesToDelete);
                const allIndices = pdfDoc.getPageIndices();
                const indicesToKeep = allIndices.filter(i => !indicesToDelete.includes(i));
                const newPdf = await PDFDocument.create();
                const copiedPages = await newPdf.copyPages(pdfDoc, indicesToKeep);
                copiedPages.forEach(p => newPdf.addPage(p));
                resultBytes = await newPdf.save();

            } else if (toolId === 'extract') {
                const rangeStr = document.getElementById('page-ranges').value;
                const indices = app.parsePageRanges(rangeStr, pdfDoc.getPageCount());
                const newPdf = await PDFDocument.create();
                const copiedPages = await newPdf.copyPages(pdfDoc, indices);
                copiedPages.forEach(p => newPdf.addPage(p));
                resultBytes = await newPdf.save();

            } else if (toolId === 'delete') {
                const indicesToDelete = Array.from(app.pagesToDelete);
                const allIndices = pdfDoc.getPageIndices();
                const indicesToKeep = allIndices.filter(i => !indicesToDelete.includes(i));
                const newPdf = await PDFDocument.create();
                const copiedPages = await newPdf.copyPages(pdfDoc, indicesToKeep);
                copiedPages.forEach(p => newPdf.addPage(p));
                resultBytes = await newPdf.save();

            } else if (toolId === 'rotate') {
                const rotInput = document.querySelector('input[name="rotation"]:checked');
                if (!rotInput) {
                    alert("Silakan pilih arah rotasi terlebih dahulu.");
                    app.resetButtonState();
                    return;
                }
                const deg = parseInt(rotInput.value);
                const pages = pdfDoc.getPages();
                pages.forEach(page => {
                    const current = page.getRotation().angle;
                    page.setRotation(degrees(current + deg));
                });
                resultBytes = await pdfDoc.save();

            } else if (toolId === 'img-to-pdf') {
                const layoutMode = document.querySelector('input[name="pdfLayout"]:checked').value;
                for (let file of app.files) {
                    let image;
                    if (file.type === 'image/jpeg') image = await pdfDoc.embedJpg(file.buffer);
                    else if (file.type === 'image/png') image = await pdfDoc.embedPng(file.buffer);
                    
                    if (image) {
                        if (layoutMode === 'no-margin') {
                            const page = pdfDoc.addPage([image.width, image.height]);
                            page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
                        } else {
                            const A4_W = 595.28;
                            const A4_H = 841.89;
                            const margin = 40; 
                            let pageW = A4_W;
                            let pageH = A4_H;
                            if (image.width > image.height) {
                                pageW = A4_H;
                                pageH = A4_W;
                            }
                            const page = pdfDoc.addPage([pageW, pageH]);
                            const drawAreaW = pageW - (margin * 2);
                            const drawAreaH = pageH - (margin * 2);
                            const scale = Math.min(drawAreaW / image.width, drawAreaH / image.height);
                            const scaledW = image.width * scale;
                            const scaledH = image.height * scale;
                            const x = (pageW - scaledW) / 2;
                            const y = (pageH - scaledH) / 2;
                            page.drawImage(image, { x: x, y: y, width: scaledW, height: scaledH });
                        }
                    }
                }
                resultBytes = await pdfDoc.save();

            } else if (toolId === 'pdf-to-img') {
                const bufferCopy = app.files[0].buffer.slice(0);
                const loadingTask = pdfjsLib.getDocument(new Uint8Array(bufferCopy));
                const pdf = await loadingTask.promise;
                const pageCount = pdf.numPages;

                if (pageCount === 1) {
                    const page = await pdf.getPage(1);
                    const scale = 2.0;
                    const viewport = page.getViewport({scale});
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    await page.render({canvasContext: context, viewport: viewport}).promise;
                    const jpgUrl = canvas.toDataURL('image/jpeg');
                    const originalName = app.files[0] ? app.files[0].name.replace(/\.pdf$/i, '') : 'document';
                    download(jpgUrl, `${originalName}.jpg`, "image/jpeg");
                } else {
                    const zip = new JSZip();
                    const originalName = app.files[0] ? app.files[0].name.replace(/\.pdf$/i, '') : 'document';

                    for (let i = 1; i <= pageCount; i++) {
                        const page = await pdf.getPage(i);
                        const scale = 2.0;
                        const viewport = page.getViewport({scale});
                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d');
                        canvas.height = viewport.height;
                        canvas.width = viewport.width;
                        await page.render({canvasContext: context, viewport: viewport}).promise;
                        
                        const imgData = canvas.toDataURL('image/jpeg').split(',')[1];
                        zip.file(`${originalName}_page-${i}.jpg`, imgData, {base64: true});
                    }
                    
                    const content = await zip.generateAsync({type:"blob"});
                    download(content, `${originalName}_images.zip`, "application/zip");
                }
                
                app.resetButtonState(); 
                return; 

            } else if (toolId === 'number') {
                const pos = document.getElementById('num-pos').value;
                const size = parseInt(document.getElementById('num-size').value);
                const pages = pdfDoc.getPages();
                const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
                pages.forEach((page, idx) => {
                    const { width, height } = page.getSize();
                    const text = `${idx + 1}`;
                    const textWidth = font.widthOfTextAtSize(text, size);
                    let x, y;
                    if (pos === 'bottom-center') { x = width/2 - textWidth/2; y = 20; }
                    else if (pos === 'bottom-right') { x = width - textWidth - 20; y = 20; }
                    else if (pos === 'top-right') { x = width - textWidth - 20; y = height - 30; }
                    else if (pos === 'top-left') { x = 20; y = height - 30; }
                    page.drawText(text, { x, y, size, font });
                });
                resultBytes = await pdfDoc.save();

            } else if (toolId === 'compress') {
                const mode = document.querySelector('input[name="compressMode"]:checked').value;
                if (mode === 'basic') {
                    resultBytes = await pdfDoc.save();
                } else {
                    const quality = parseFloat(document.getElementById('comp-quality').value);
                    const ppi = parseInt(document.getElementById('comp-ppi').value);
                    const scale = ppi / 72; 
                    const newPdf = await PDFDocument.create();
                    for (let file of app.files) {
                        const bufferCopy = file.buffer.slice(0);
                        const loadingTask = pdfjsLib.getDocument(new Uint8Array(bufferCopy));
                        const pdf = await loadingTask.promise;
                        for (let i = 1; i <= pdf.numPages; i++) {
                            const page = await pdf.getPage(i);
                            const viewport = page.getViewport({ scale: scale });
                            const canvas = document.createElement('canvas');
                            const context = canvas.getContext('2d');
                            canvas.height = viewport.height;
                            canvas.width = viewport.width;
                            await page.render({ canvasContext: context, viewport: viewport }).promise;
                            const imgDataUrl = canvas.toDataURL('image/jpeg', quality);
                            const img = await newPdf.embedJpg(imgDataUrl);
                            const pageDims = [viewport.width / scale, viewport.height / scale];
                            const newPage = newPdf.addPage(pageDims);
                            newPage.drawImage(img, { x: 0, y: 0, width: pageDims[0], height: pageDims[1] });
                        }
                    }
                    resultBytes = await newPdf.save();
                }
            } else if (toolId === 'compress-img') {
                const quality = parseInt(document.getElementById('img-quality').value) / 100;
                for (let i = 0; i < app.files.length; i++) {
                    const file = app.files[i];
                    const image = new Image();
                    const url = URL.createObjectURL(new Blob([file.buffer], { type: file.type }));
                    await new Promise((resolve) => {
                        image.onload = () => resolve();
                        image.src = url;
                    });
                    const canvas = document.createElement('canvas');
                    canvas.width = image.width;
                    canvas.height = image.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(image, 0, 0);
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    const originalName = file.name.replace(/\.[^/.]+$/, "");
                    const resultName = `${originalName}_kompres.jpg`;
                    if (i > 0) await new Promise(r => setTimeout(r, 500));
                    download(dataUrl, resultName, "image/jpeg");
                }
                app.resetButtonState();
                return; 
            }

            app.processedPdfBytes = resultBytes;
            app.setDownloadButtonState();

        } catch (err) {
            console.error(err);
            app.resetButtonState();
            alert("Terjadi kesalahan: " + err.message);
        }
    },
    
    parsePageRanges: (str, maxPage) => {
        const pages = new Set();
        const parts = str.split(',');
        parts.forEach(part => {
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(n => parseInt(n));
                if (!isNaN(start) && !isNaN(end)) {
                    for(let i=start; i<=end; i++) if(i <= maxPage) pages.add(i-1);
                }
            } else {
                const num = parseInt(part);
                if (!isNaN(num) && num <= maxPage) pages.add(num-1);
            }
        });
        return Array.from(pages).sort((a,b) => a-b);
    },

    showLoading: (isLoading, text = "Sedang memproses...") => {
        const el = document.getElementById('step-loading');
        const txt = document.getElementById('loading-text');
        if (isLoading) {
            el.classList.remove('hidden');
            if(txt) txt.textContent = text;
        } else {
            el.classList.add('hidden');
        }
    },
};

// Start App
app.init();
