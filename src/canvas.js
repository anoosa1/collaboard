import { TOOLS } from './tools.js';

export class Canvas {
    constructor(canvasElement, socket, onZoomChange) {
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        this.socket = socket;
        this.onZoomChange = onZoomChange;

        // Drawing state
        this.isDrawing = false;
        this.currentTool = TOOLS.PENCIL;
        this.color = '#000000';
        this.size = 5;
        this.startX = 0;
        this.startY = 0;
        this.snapshot = null;

        // Pan and Zoom state
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.isPanning = false;
        this.lastPanX = 0;
        this.lastPanY = 0;
        this.spacePressed = false;

        // Virtual canvas (larger than viewport for drawing)
        this.virtualWidth = 3000;
        this.virtualHeight = 2000;

        // Drawing history for redraw on resize
        this.drawingActions = [];

        this.canvasBg = '#ffffff';
        this.canvasDot = '#d0d0d0';

        // Per-user remote drawing paths (keyed by userId)
        this.remoteUserPaths = new Map();

        this.setupCanvas();
        this.bindEvents();
    }

    setupCanvas() {
        this.canvas.width = this.virtualWidth;
        this.canvas.height = this.virtualHeight;
        this.drawBackground();
        this.centerCanvas();
    }

    drawBackground() {
        const bgColor = this.canvasBg;
        const dotColor = this.canvasDot;

        this.ctx.fillStyle = bgColor;
        this.ctx.fillRect(0, 0, this.virtualWidth, this.virtualHeight);

        // Draw dot grid
        const dotSpacing = 20;
        const dotRadius = 1;
        this.ctx.fillStyle = dotColor;

        for (let x = dotSpacing; x < this.virtualWidth; x += dotSpacing) {
            for (let y = dotSpacing; y < this.virtualHeight; y += dotSpacing) {
                this.ctx.beginPath();
                this.ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }
    }

    get bgColor() {
        return this.canvasBg;
    }

    centerCanvas() {
        const container = this.canvas.parentElement;
        this.offsetX = (container.clientWidth - this.virtualWidth * this.scale) / 2;
        this.offsetY = (container.clientHeight - this.virtualHeight * this.scale) / 2;
        this.updateCanvasTransform();
    }

    updateCanvasTransform() {
        this.canvas.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
        this.canvas.style.transformOrigin = '0 0';
        if (this.onZoomChange) {
            this.onZoomChange(Math.round(this.scale * 100));
        }
    }

    bindEvents() {
        // Drawing events
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('mouseleave', this.handleMouseUp.bind(this));

        // Touch support
        this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
        this.canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
        this.canvas.addEventListener('touchend', this.handleTouchEnd.bind(this));

        // Zoom with mouse wheel
        this.canvas.parentElement.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });

        // Space key for panning (ignore when typing in inputs)
        document.addEventListener('keydown', (e) => {
            if (e.target.closest('input, textarea, select, button, [contenteditable]')) return;
            if (e.code === 'Space' && !this.spacePressed) {
                e.preventDefault();
                this.spacePressed = true;
                this.canvas.classList.add('panning');
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.spacePressed = false;
                if (this.currentTool !== TOOLS.PAN) this.canvas.classList.remove('panning');
            }
        });

        // Window resize - no need to redraw since canvas is fixed size
        window.addEventListener('resize', () => {
            // Just recenter if needed
        });
    }

    getCanvasCoords(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left) / this.scale,
            y: (clientY - rect.top) / this.scale
        };
    }

    handleMouseDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        const pos = this.getCanvasCoords(e.clientX, e.clientY);

        // Panning mode
        if (this.spacePressed || this.currentTool === TOOLS.PAN) {
            this.isPanning = true;
            this.lastPanX = e.clientX;
            this.lastPanY = e.clientY;
            this.canvas.classList.add('panning');
            return;
        }

        this.isDrawing = true;
        this.startX = pos.x;
        this.startY = pos.y;
        this.lastDrawX = pos.x;
        this.lastDrawY = pos.y;
        this.ctx.beginPath();
        this.ctx.moveTo(this.startX, this.startY);

        if (this.currentTool === TOOLS.LINE || this.currentTool === TOOLS.RECTANGLE || this.currentTool === TOOLS.CIRCLE) {
            this.snapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        } else if (this.currentTool === TOOLS.PENCIL || this.currentTool === TOOLS.ERASER) {
            const action = {
                type: 'start',
                x: this.startX,
                y: this.startY,
                color: this.currentTool === TOOLS.ERASER ? this.bgColor : this.color,
                size: this.size,
                tool: this.currentTool
            };
            this.socket.emitDraw(action);
            this.drawingActions.push(action);
        } else if (this.currentTool === TOOLS.TEXT) {
            this.handleTextTool(pos.x, pos.y);
            this.isDrawing = false;
        }
    }

    handleMouseMove(e) {
        const pos = this.getCanvasCoords(e.clientX, e.clientY);

        // Panning
        if (this.isPanning) {
            const dx = e.clientX - this.lastPanX;
            const dy = e.clientY - this.lastPanY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastPanX = e.clientX;
            this.lastPanY = e.clientY;
            this.updateCanvasTransform();
            return;
        }

        // Emit cursor position for remote users (always, not just while drawing)
        this.socket.emitCursorMove(pos);

        if (!this.isDrawing) return;

        if (this.currentTool === TOOLS.PENCIL || this.currentTool === TOOLS.ERASER) {
            this.ctx.lineWidth = this.size;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.strokeStyle = this.currentTool === TOOLS.ERASER ? this.bgColor : this.color;

            // Remote strokes share this context, so each local segment needs its own path.
            this.ctx.beginPath();
            this.ctx.moveTo(this.lastDrawX, this.lastDrawY);
            this.ctx.lineTo(pos.x, pos.y);
            this.ctx.stroke();
            this.lastDrawX = pos.x;
            this.lastDrawY = pos.y;

            const action = { type: 'draw', x: pos.x, y: pos.y };
            this.socket.emitDraw(action);
            this.drawingActions.push(action);
        } else if (this.currentTool === TOOLS.LINE) {
            this.ctx.putImageData(this.snapshot, 0, 0);
            this.ctx.beginPath();
            this.ctx.moveTo(this.startX, this.startY);
            this.ctx.lineTo(pos.x, pos.y);
            this.ctx.strokeStyle = this.color;
            this.ctx.lineWidth = this.size;
            this.ctx.lineCap = 'round';
            this.ctx.stroke();
        } else if (this.currentTool === TOOLS.RECTANGLE) {
            this.ctx.putImageData(this.snapshot, 0, 0);
            this.ctx.beginPath();
            this.ctx.rect(this.startX, this.startY, pos.x - this.startX, pos.y - this.startY);
            this.ctx.strokeStyle = this.color;
            this.ctx.lineWidth = this.size;
            this.ctx.stroke();
        } else if (this.currentTool === TOOLS.CIRCLE) {
            this.ctx.putImageData(this.snapshot, 0, 0);
            this.ctx.beginPath();
            const radius = Math.sqrt(Math.pow(pos.x - this.startX, 2) + Math.pow(pos.y - this.startY, 2));
            this.ctx.arc(this.startX, this.startY, radius, 0, 2 * Math.PI);
            this.ctx.strokeStyle = this.color;
            this.ctx.lineWidth = this.size;
            this.ctx.stroke();
        }
    }

    handleMouseUp(e) {
        if (this.isPanning) {
            this.isPanning = false;
            if (!this.spacePressed && this.currentTool !== TOOLS.PAN) {
                this.canvas.classList.remove('panning');
            }
            return;
        }

        if (!this.isDrawing) return;
        this.isDrawing = false;

        const pos = this.getCanvasCoords(e.clientX, e.clientY);

        if (this.currentTool === TOOLS.LINE || this.currentTool === TOOLS.RECTANGLE || this.currentTool === TOOLS.CIRCLE) {
            const action = {
                type: 'shape',
                tool: this.currentTool,
                start: { x: this.startX, y: this.startY },
                end: { x: pos.x, y: pos.y },
                color: this.color,
                size: this.size
            };
            this.socket.emitDraw(action);
            this.drawingActions.push(action);
        } else if (this.currentTool === TOOLS.PENCIL || this.currentTool === TOOLS.ERASER) {
            const action = { type: 'end' };
            this.socket.emitDraw(action);
            this.drawingActions.push(action);
            this.ctx.beginPath();
        }
    }

    // Touch handlers
    handleTouchStart(e) {
        e.preventDefault();
        if (e.touches.length === 1) {
            // Don't draw if mobile panel is open
            const toolbar = document.getElementById('toolbar');
            if (toolbar && toolbar.classList.contains('open')) return;

            const touch = e.touches[0];
            this.handleMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
        } else if (e.touches.length === 2) {
            // Emit end for any in-progress stroke before switching to pinch
            if (this.isDrawing && (this.currentTool === TOOLS.PENCIL || this.currentTool === TOOLS.ERASER)) {
                const endAction = { type: 'end' };
                this.socket.emitDraw(endAction);
                this.drawingActions.push(endAction);
                this.ctx.beginPath();
            }
            this.isDrawing = false;
            this.isPinching = true;
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            this.pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            this.pinchStartScale = this.scale;
            this.pinchCenterX = (t1.clientX + t2.clientX) / 2;
            this.pinchCenterY = (t1.clientY + t2.clientY) / 2;
            this.lastPinchCenterX = this.pinchCenterX;
            this.lastPinchCenterY = this.pinchCenterY;
        }
    }

    handleTouchMove(e) {
        e.preventDefault();
        if (e.touches.length === 2 && this.isPinching) {
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            const centerX = (t1.clientX + t2.clientX) / 2;
            const centerY = (t1.clientY + t2.clientY) / 2;

            // Pinch zoom
            const scaleFactor = dist / this.pinchStartDist;
            const newScale = Math.min(Math.max(this.pinchStartScale * scaleFactor, 0.1), 5);

            const container = this.canvas.parentElement;
            const rect = container.getBoundingClientRect();
            const mouseX = this.pinchCenterX - rect.left;
            const mouseY = this.pinchCenterY - rect.top;

            this.offsetX = mouseX - (mouseX - this.offsetX) * (newScale / this.scale);
            this.offsetY = mouseY - (mouseY - this.offsetY) * (newScale / this.scale);
            this.scale = newScale;

            // Two-finger pan
            const dx = centerX - this.lastPinchCenterX;
            const dy = centerY - this.lastPinchCenterY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastPinchCenterX = centerX;
            this.lastPinchCenterY = centerY;

            this.updateCanvasTransform();
        } else if (e.touches.length === 1 && !this.isPinching) {
            const touch = e.touches[0];
            this.handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
        }
    }

    handleTouchEnd(e) {
        if (this.isPinching) {
            this.isPinching = false;
            return;
        }
        // Use last known touch position for accurate end coords
        if (e.changedTouches && e.changedTouches.length > 0) {
            const touch = e.changedTouches[0];
            this.handleMouseUp({ clientX: touch.clientX, clientY: touch.clientY });
        } else {
            this.handleMouseUp({ clientX: 0, clientY: 0 });
        }
    }

    handleWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this.zoom(delta, e.clientX, e.clientY);
    }

    zoom(factor, centerX, centerY) {
        const newScale = Math.min(Math.max(this.scale * factor, 0.1), 5);

        // Zoom toward mouse position
        const container = this.canvas.parentElement;
        const rect = container.getBoundingClientRect();
        const mouseX = centerX - rect.left;
        const mouseY = centerY - rect.top;

        // Calculate new offset to keep zoom centered on mouse
        this.offsetX = mouseX - (mouseX - this.offsetX) * (newScale / this.scale);
        this.offsetY = mouseY - (mouseY - this.offsetY) * (newScale / this.scale);

        this.scale = newScale;
        this.updateCanvasTransform();
    }

    zoomIn() {
        const container = this.canvas.parentElement;
        const rect = container.getBoundingClientRect();
        this.zoom(1.2, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    zoomOut() {
        const container = this.canvas.parentElement;
        const rect = container.getBoundingClientRect();
        this.zoom(0.8, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    resetView() {
        this.scale = 1;
        this.centerCanvas();
    }

    handleTextTool(x, y) {
        // Store position for when text is confirmed
        this.pendingTextX = x;
        this.pendingTextY = y;

        // Show text input overlay
        const overlay = document.getElementById('text-input-overlay');
        const input = document.getElementById('text-input');
        const confirmBtn = document.getElementById('text-confirm');
        const cancelBtn = document.getElementById('text-cancel');

        overlay.classList.remove('hidden');
        input.value = '';
        input.focus();

        // Cleanup function
        const cleanup = () => {
            overlay.classList.add('hidden');
            input.removeEventListener('keydown', handleKeydown);
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
        };

        const handleConfirm = () => {
            const text = input.value.trim();
            if (text) {
                this.drawText(text, this.pendingTextX, this.pendingTextY, this.color, this.size);
                const action = {
                    type: 'text',
                    text,
                    x: this.pendingTextX,
                    y: this.pendingTextY,
                    color: this.color,
                    size: this.size
                };
                this.socket.emitDraw(action);
                this.drawingActions.push(action);
            }
            cleanup();
        };

        const handleCancel = () => {
            cleanup();
        };

        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirm();
            } else if (e.key === 'Escape') {
                handleCancel();
            }
        };

        input.addEventListener('keydown', handleKeydown);
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
    }

    drawRemote(data) {
        const { type, x, y, start, end, color, size, tool, text, userId } = data;
        // Use a fallback userId for legacy actions without one
        const uid = userId || '__legacy__';

        if (type === 'start') {
            // Initialize per-user path state
            this.remoteUserPaths.set(uid, { lastX: x, lastY: y, color, size, tool });
        } else if (type === 'draw') {
            const userPath = this.remoteUserPaths.get(uid);
            if (userPath) {
                // Draw an independent segment (no shared path accumulation)
                this.ctx.beginPath();
                this.ctx.lineWidth = userPath.size;
                this.ctx.lineCap = 'round';
                this.ctx.lineJoin = 'round';

                this.ctx.strokeStyle = userPath.color;
                this.ctx.moveTo(userPath.lastX, userPath.lastY);
                this.ctx.lineTo(x, y);
                this.ctx.stroke();
                // Update last position
                userPath.lastX = x;
                userPath.lastY = y;
            }
        } else if (type === 'end') {
            this.remoteUserPaths.delete(uid);
        } else if (type === 'shape') {
            this.ctx.beginPath();
            this.ctx.lineWidth = size;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.strokeStyle = color;
            if (tool === TOOLS.LINE) {
                this.ctx.moveTo(start.x, start.y);
                this.ctx.lineTo(end.x, end.y);
            } else if (tool === TOOLS.RECTANGLE) {
                this.ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
            } else if (tool === TOOLS.CIRCLE) {
                const radius = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
                this.ctx.arc(start.x, start.y, radius, 0, 2 * Math.PI);
            }
            this.ctx.stroke();
        } else if (type === 'text') {
            this.drawText(text, x, y, color, size);
        } else if (type === 'image') {
            // Image handled async — push after load, then return early
            return this.drawImageOnCanvas(data.dataUrl, data.x, data.y, data.width, data.height)
                .then(() => { this.drawingActions.push(data); });
        }

        // Store for potential replay (sync actions only — image returns above)
        this.drawingActions.push(data);
    }

    drawText(text, x, y, color, size) {
        this.ctx.font = `${Math.max(size * 3, 16)}px Inter, sans-serif`;
        this.ctx.fillStyle = color;
        this.ctx.fillText(text, x, y);
    }

    drawImageOnCanvas(dataUrl, x, y, width, height) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                this.ctx.drawImage(img, x, y, width, height);
                resolve();
            };
            img.onerror = () => resolve(); // Don't block on broken images
            img.src = dataUrl;
        });
    }

    importImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const originalDataUrl = e.target.result;
                const img = new Image();
                img.onload = () => {
                    // Scale image to fit reasonably on canvas (max 600px wide/tall)
                    let width = img.width;
                    let height = img.height;
                    const maxDim = 600;
                    if (width > maxDim || height > maxDim) {
                        const ratio = Math.min(maxDim / width, maxDim / height);
                        width = Math.round(width * ratio);
                        height = Math.round(height * ratio);
                    }

                    // Compress via off-screen canvas → JPEG at 60% quality
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = width;
                    tempCanvas.height = height;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.drawImage(img, 0, 0, width, height);
                    const compressedDataUrl = tempCanvas.toDataURL('image/jpeg', 0.6);

                    // Safety check: reject if still too large (> 500 KB)
                    const sizeKB = Math.round((compressedDataUrl.length * 3) / 4 / 1024);
                    if (sizeKB > 500) {
                        reject(new Error('Image too large'));
                        return;
                    }

                    // Center on the visible viewport area
                    const container = this.canvas.parentElement;
                    const containerRect = container.getBoundingClientRect();
                    const centerX = (containerRect.width / 2 - this.offsetX) / this.scale;
                    const centerY = (containerRect.height / 2 - this.offsetY) / this.scale;
                    const x = centerX - width / 2;
                    const y = centerY - height / 2;

                    // Draw on canvas
                    this.ctx.drawImage(img, x, y, width, height);

                    // Create and emit action with compressed data
                    const action = {
                        type: 'image',
                        dataUrl: compressedDataUrl,
                        x, y, width, height
                    };
                    this.socket.emitDraw(action);
                    this.drawingActions.push(action);
                    resolve();
                };
                img.onerror = reject;
                img.src = originalDataUrl;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    exportAsImage() {
        const link = document.createElement('a');
        link.download = 'whiteboard.png';
        link.href = this.canvas.toDataURL('image/png');
        link.click();
    }

    clear() {
        this.drawBackground();
        this.drawingActions = [];
        this.remoteUserPaths.clear();
        this.isDrawing = false;
        this.snapshot = null;
        this.ctx.beginPath();
    }

    async reloadFromState(drawings) {
        this.clear();
        for (const d of drawings) {
            await this.drawRemote(d);
        }
    }

    resizeCanvas(width, height) {
        // Save current canvas content
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        // Update dimensions
        this.virtualWidth = width;
        this.virtualHeight = height;
        this.canvas.width = width;
        this.canvas.height = height;

        // Redraw background
        this.drawBackground();

        // Restore previous content (as much as fits)
        this.ctx.putImageData(imageData, 0, 0);

        // Recenter canvas
        this.centerCanvas();
    }
}
