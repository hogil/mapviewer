/**
 * ChipAnnotator - Chip-level annotation for wafer maps
 *
 * 핵심 기능:
 * - 항상 활성화 (모드 개념 없음)
 * - 마우스 오버 시 chip 좌표 표시
 * - Ctrl/Shift + 클릭으로 chip 선택
 * - Grid overlay
 * - Chip에 class/label 할당
 */

export class ChipAnnotator {
    constructor(canvas, viewer) {
        this.canvas = canvas;
        this.viewer = viewer;
        this.ctx = canvas.getContext('2d');

        // Chip position data
        this.positionsData = null;
        this.chips = [];

        // Annotation data
        this.markedChips = []; // {x_abs, y_abs, class, label, ...}
        this.chipIndexMap = new Map(); // (x_abs,y_abs) -> chip index
        this.selectedChips = new Set(); // Set of chip indices
        this.legendFilterClasses = null;
        this.classColors = new Map();
        this.classColorPalette = [
            [239, 83, 80],
            [255, 160, 67],
            [255, 214, 102],
            [102, 187, 106],
            [38, 166, 154],
            [41, 182, 246],
            [126, 87, 194],
            [171, 71, 188],
            [255, 112, 67],
            [158, 158, 158]
        ];
        this.classColorIndex = 0;

        // UI state
        this.showGrid = false;
        this.hoveredChip = null;

        // Selection state
        this.isDragging = false;
        this.dragStartChip = null;
        this.isMultiSelect = false;
        this.isAltDrag = false;
        this.polygonPath = []; // For Alt+Drag free-form selection
        this.shiftClickPos = null; // For Shift+2-click rectangle selection

        // Colors
        this.gridColor = 'rgba(0, 255, 255, 0.3)';
        this.hoverColor = 'rgba(255, 255, 255, 0.3)';
        this.selectedColor = 'rgba(255, 255, 0, 0.5)';
        this.markedColor = 'rgba(255, 0, 0, 0.4)';

        // Coordinate display elements
        this.coordBox = document.getElementById('chip-coordinate-box');
        this.coordChipAbs = document.getElementById('coord-chip-abs');
        this.coordChipRel = document.getElementById('coord-chip-rel');

        // Current image path
        this.currentImagePath = null;

        // Event handlers (bind once)
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onMouseLeave = this._handleMouseLeave.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);

        this._setupEventListeners();
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
        this.canvas.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        this.canvas.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('mouseleave', this._onMouseLeave);
        document.addEventListener('keydown', this._onKeyDown);
    }

    /**
     * Load chip positions from backend
     */
    async loadPositions(imagePath) {
        try {
            this.currentImagePath = imagePath;
            const response = await fetch(`/api/chip-positions?path=${encodeURIComponent(imagePath)}`);

            if (!response.ok) {
                console.log('No positions found for:', imagePath);
                this.positionsData = null;
                this.chips = [];
                this.chipIndexMap.clear();
                this._notifyLegendUpdate([]);
                return false;
            }

            this.positionsData = await response.json();
            this.chips = this.positionsData.chips || [];
            this._buildChipIndexMap();

            console.log(`✅ Loaded ${this.chips.length} chip positions`);

            // Load existing annotations
            await this.loadAnnotations(imagePath);

            // 🎨 positions 로드 후 즉시 렌더링 (hover, grid 등 표시)
            this.render();

            return true;
        } catch (error) {
            console.error('Error loading chip positions:', error);
            this.positionsData = null;
            this.chips = [];
            this.chipIndexMap.clear();
            this._notifyLegendUpdate([]);
            return false;
        }
    }

    /**
     * Load existing chip annotations from backend
     */
    async loadAnnotations(imagePath = null) {
        const targetPath = imagePath || this.currentImagePath;
        if (!targetPath) {
            this.markedChips = [];
            this._refreshClassColors();
            this._notifyLegendUpdate([]);
            return;
        }

        try {
            const params = new URLSearchParams();
            params.set('path', targetPath);
            const folderPrefix = this.viewer?.currentFolderPrefix ?? '';
            params.set('folder', folderPrefix);
            const response = await fetch(`/api/chip-annotations?${params.toString()}`);

            if (response.ok) {
                const data = await response.json();
                this.markedChips = Array.isArray(data.marked_chips) ? data.marked_chips : [];
            } else if (response.status === 404) {
                this.markedChips = [];
            } else {
                const errorText = await response.text().catch(() => response.statusText);
                throw new Error(`Failed to load chip annotations: ${response.status} ${errorText}`);
            }

            this._refreshClassColors();
            this._notifyLegendUpdate();
            this.render();
        } catch (error) {
            console.error('Error loading chip labels:', error);
            this.markedChips = [];
            this._refreshClassColors();
            this._notifyLegendUpdate([]);
        }
    }

    setLegendFilterClass(className) {
        if (!className) {
            this.legendFilterClasses = null;
        } else {
            this.legendFilterClasses = new Set([className]);
        }
        this.render();
    }

    setLegendFilterClasses(classSet) {
        if (classSet === null || classSet === undefined) {
            this.legendFilterClasses = null;
        } else if (classSet instanceof Set) {
            this.legendFilterClasses = new Set(classSet);
        } else if (Array.isArray(classSet)) {
            this.legendFilterClasses = new Set(classSet);
        } else {
            this.legendFilterClasses = null;
        }
        this.render();
    }

    _refreshClassColors() {
        this.classColors.clear();
        this.classColorIndex = 0;
        const uniqueClasses = Array.from(new Set(this.markedChips
            .map(chip => chip.class || chip.label)
            .filter(Boolean)))
            .sort((a, b) => a.localeCompare(b));
        uniqueClasses.forEach(cls => this._getOrAssignClassColor(cls));
    }

    _getOrAssignClassColor(className) {
        if (!className) {
            return [255, 77, 77];
        }
        if (!this.classColors.has(className)) {
            const paletteColor = this.classColorPalette[this.classColorIndex % this.classColorPalette.length];
            this.classColors.set(className, paletteColor);
            this.classColorIndex += 1;
        }
        return this.classColors.get(className);
    }

    getClassColor(className, alpha = 0.35) {
        const [r, g, b] = this._getOrAssignClassColor(className);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    getClassColorHex(className) {
        const [r, g, b] = this._getOrAssignClassColor(className);
        return `rgb(${r}, ${g}, ${b})`;
    }

    _buildChipIndexMap() {
        this.chipIndexMap.clear();
        if (!Array.isArray(this.chips)) {
            return;
        }
        this.chips.forEach((chip, index) => {
            const key = this._chipKey(chip?.x_abs, chip?.y_abs);
            if (key) {
                this.chipIndexMap.set(key, index);
            }
        });
    }

    _chipKey(x, y) {
        if (typeof x !== 'number' || typeof y !== 'number') {
            return null;
        }
        return `${x},${y}`;
    }

    _getChipIndexFromCoords(x, y) {
        const key = this._chipKey(x, y);
        if (!key) return -1;
        const idx = this.chipIndexMap.get(key);
        return typeof idx === 'number' ? idx : -1;
    }

    _notifyLegendUpdate(chips = null) {
        if (this.viewer && typeof this.viewer.updateChipLabelLegend === 'function') {
            this.viewer.updateChipLabelLegend(Array.isArray(chips) ? chips : this.markedChips || []);
        }
    }

    /**
     * Save chip annotations to backend
     */
    async saveAnnotations() {
        if (!this.currentImagePath) {
            console.warn('No image path set');
            return false;
        }

        try {
            const folderPrefix = this.viewer?.currentFolderPrefix ?? '';
            const response = await fetch('/api/chip-annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_path: this.currentImagePath,
                    marked_chips: this.markedChips,
                    folder_prefix: folderPrefix
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to save annotations: ${response.statusText}`);
            }

            console.log('✅ Annotations saved successfully');
            return true;
        } catch (error) {
            console.error('Error saving annotations:', error);
            return false;
        }
    }

    /**
     * Toggle die grid overlay
     */
    toggleGrid() {
        this.showGrid = !this.showGrid;
        this.render();
    }

    /**
     * Find chip at canvas pixel coordinates
     */
    findChipAtPixel(canvasX, canvasY) {
        if (!this.positionsData || !this.viewer.transform) return null;

        // Convert canvas coordinates to image coordinates
        const imgX = (canvasX - this.viewer.transform.dx) / this.viewer.transform.scale;
        const imgY = (canvasY - this.viewer.transform.dy) / this.viewer.transform.scale;

        // Find chip containing this point
        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            if (imgX >= rect.x0 && imgX <= rect.x1 &&
                imgY >= rect.y0 && imgY <= rect.y1) {
                return { ...chip, index: i };
            }
        }

        return null;
    }

    /**
     * Get chips in rectangle selection (for drag)
     */
    getChipsInRect(chip1, chip2) {
        const minX = Math.min(chip1.x_abs, chip2.x_abs);
        const maxX = Math.max(chip1.x_abs, chip2.x_abs);
        const minY = Math.min(chip1.y_abs, chip2.y_abs);
        const maxY = Math.max(chip1.y_abs, chip2.y_abs);

        const selected = [];

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            if (chip.x_abs >= minX && chip.x_abs <= maxX &&
                chip.y_abs >= minY && chip.y_abs <= maxY) {
                selected.push(i);
            }
        }

        return selected;
    }

    /**
     * Get selected chip coordinates (for label assignment)
     */
    getSelectedChipCoords() {
        const coords = [];
        this.selectedChips.forEach(chipIdx => {
            const chip = this.chips[chipIdx];
            if (chip) {
                coords.push({ x_abs: chip.x_abs, y_abs: chip.y_abs });
            }
        });
        return coords;
    }

    /**
     * Select all chips that match the given class/label
     */
    selectChipsByClass(className) {
        if (!className) {
            this.clearSelection();
            return 0;
        }

        if (!Array.isArray(this.markedChips) || this.markedChips.length === 0) {
            this.clearSelection();
            return 0;
        }

        const nextSelection = [];
        this.markedChips.forEach(marked => {
            const chipClass = marked.class || marked.label;
            if (chipClass === className) {
                const idx = this._getChipIndexFromCoords(marked.x_abs, marked.y_abs);
                if (idx !== -1) {
                    nextSelection.push(idx);
                }
            }
        });

        this.selectedChips = new Set(nextSelection);
        this.render();
        return nextSelection.length;
    }

    /**
     * Clear chip selection
     */
    clearSelection(notifyViewer = true) {
        this.selectedChips.clear();
        this.render();
        if (notifyViewer && this.viewer && typeof this.viewer.handleChipSelectionCleared === 'function') {
            this.viewer.handleChipSelectionCleared();
        }
    }

    /**
     * Render chip annotations overlay
     */
    render() {
        if (!this.positionsData) {
            return;
        }

        if (!this.viewer.transform) {
            console.warn('⚠️ ChipAnnotator: viewer.transform is not available yet');
            return;
        }

        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw grid if enabled
        if (this.showGrid) {
            this._renderGrid();
        }

        const activeSet = this.legendFilterClasses;
        this.markedChips.forEach(markedChip => {
            const chipClass = markedChip.class || markedChip.label;
            const chip = this.chips.find(
                c => c.x_abs === markedChip.x_abs && c.y_abs === markedChip.y_abs
            );
            if (!chip) return;
            const isVisible = !activeSet || activeSet.has(chipClass);
            const alpha = isVisible ? 0.45 : 0;
            if (alpha > 0) {
                const fillColor = this.getClassColor(chipClass, alpha);
                this._drawChipRect(chip, fillColor);
            }
        });

        // Draw selected chips (manual selections override filters)
        if (this.selectedChips.size > 0) {
            this.selectedChips.forEach(chipIdx => {
                const chip = this.chips[chipIdx];
                if (chip) {
                    this._drawChipRect(chip, this.selectedColor);
                }
            });
        }

        // Draw hovered chip
        if (this.hoveredChip) {
            this._drawChipRect(this.hoveredChip, this.hoverColor);
        }

        // Draw Alt+Drag free-form selection polygon
        if (this.isAltDrag && this.polygonPath.length > 0) {
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
            ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
            ctx.lineWidth = 2;

            ctx.beginPath();
            ctx.moveTo(this.polygonPath[0].x, this.polygonPath[0].y);
            for (let i = 1; i < this.polygonPath.length; i++) {
                ctx.lineTo(this.polygonPath[i].x, this.polygonPath[i].y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        // Draw Shift+Click rectangle preview
        if (this.shiftClickPos) {
            const mousePos = this.lastMousePos;
            if (mousePos) {
                const x1 = Math.min(this.shiftClickPos.x, mousePos.x);
                const y1 = Math.min(this.shiftClickPos.y, mousePos.y);
                const x2 = Math.max(this.shiftClickPos.x, mousePos.x);
                const y2 = Math.max(this.shiftClickPos.y, mousePos.y);

                ctx.strokeStyle = 'rgba(0, 153, 255, 0.8)';
                ctx.fillStyle = 'rgba(0, 153, 255, 0.15)';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                ctx.setLineDash([]);
            }
        }
    }

    /**
     * Render die grid
     */
    _renderGrid() {
        if (!this.positionsData || !this.viewer.transform) return;

        const ctx = this.ctx;
        const transform = this.viewer.transform;
        const coord = this.positionsData.coord;

        if (!coord || !coord.grid_edges) return;

        ctx.strokeStyle = this.gridColor;
        ctx.lineWidth = 1;

        // Helper to convert image coords to canvas coords
        const toCanvas = (imgX, imgY) => ({
            x: imgX * transform.scale + transform.dx,
            y: imgY * transform.scale + transform.dy
        });

        // Draw vertical lines
        coord.grid_edges.xs.forEach(x => {
            const start = toCanvas(x, 0);
            const end = toCanvas(x, coord.canvas.height);

            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
        });

        // Draw horizontal lines
        coord.grid_edges.ys.forEach(y => {
            const start = toCanvas(0, y);
            const end = toCanvas(coord.canvas.width, y);

            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
        });
    }

    /**
     * Draw chip rectangle
     */
    _drawChipRect(chip, color) {
        const transform = this.viewer.transform;
        const rect = chip.rect;

        const topLeftX = rect.x0 * transform.scale + transform.dx;
        const topLeftY = rect.y0 * transform.scale + transform.dy;
        const bottomRightX = rect.x1 * transform.scale + transform.dx;
        const bottomRightY = rect.y1 * transform.scale + transform.dy;

        this.ctx.fillStyle = color;
        this.ctx.fillRect(
            topLeftX,
            topLeftY,
            bottomRightX - topLeftX,
            bottomRightY - topLeftY
        );
    }

    /**
     * Update chip coordinate box
     */
    _updateCoordinateBox(imgX, imgY, chip) {
        if (chip) {
            // 절대 좌표
            if (this.coordChipAbs) {
                this.coordChipAbs.textContent = `(${chip.x_abs}, ${chip.y_abs})`;
            }

            // 상대 좌표 (chip 내부)
            if (this.coordChipRel) {
                const rect = chip.rect;
                const relX = Math.round(imgX - rect.x0);
                const relY = Math.round(imgY - rect.y0);
                this.coordChipRel.textContent = `(${relX}, ${relY})`;
            }
        } else {
            // Chip 위에 없으면 "-" 표시
            if (this.coordChipAbs) {
                this.coordChipAbs.textContent = '-';
            }
            if (this.coordChipRel) {
                this.coordChipRel.textContent = '-';
            }
        }
    }

    /**
     * Mouse move handler
     */
    _handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        // Store last mouse position for previews
        this.lastMousePos = { x: canvasX, y: canvasY };

        // Convert to image coordinates
        const imgX = (canvasX - this.viewer.transform.dx) / this.viewer.transform.scale;
        const imgY = (canvasY - this.viewer.transform.dy) / this.viewer.transform.scale;

        // Find chip under cursor
        const chip = this.findChipAtPixel(canvasX, canvasY);

        // Update coordinate box
        this._updateCoordinateBox(imgX, imgY, chip);

        // Handle Alt+Drag free-form polygon selection
        if (this.isAltDrag) {
            // Add points to polygon path as mouse moves
            const lastPoint = this.polygonPath[this.polygonPath.length - 1];
            if (!lastPoint ||
                Math.abs(canvasX - lastPoint.x) > 3 ||
                Math.abs(canvasY - lastPoint.y) > 3) {
                this.polygonPath.push({ x: canvasX, y: canvasY });
            }
            this.render();
            return;
        }

        // Update hover highlight
        if (chip !== this.hoveredChip) {
            this.hoveredChip = chip;
            this.render();
        }

        // Handle Shift+Click rectangle preview
        if (this.shiftClickPos) {
            this.render();
            return;
        }

        // Handle regular drag selection (chip-to-chip)
        if (this.isDragging && this.dragStartChip && chip) {
            const selected = this.getChipsInRect(this.dragStartChip, chip);
            this.selectedChips = new Set(selected);
            this.render();
        }
    }

    /**
     * Mouse down handler
     */
    _handleMouseDown(e) {
        if (e.button !== 0) return; // Left click only

        const rect = this.canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        if ((!this.legendFilterClasses || this.legendFilterClasses.size === 0) && this.viewer && typeof this.viewer.onManualChipSelection === 'function') {
            this.viewer.onManualChipSelection();
        }

        // Alt+Drag: free-form polygon selection
        if (e.altKey) {
            this.isAltDrag = true;
            this.polygonPath = [{ x: canvasX, y: canvasY }];
            e.preventDefault();
            return;
        }

        // Shift+Click: rectangle selection (2-click mode)
        if (e.shiftKey && !this.shiftClickPos) {
            this.shiftClickPos = { x: canvasX, y: canvasY };
            this.render();
            return;
        }

        const chip = this.findChipAtPixel(canvasX, canvasY);

        if (chip) {
            this.isDragging = true;
            this.dragStartChip = chip;

            // Ctrl: toggle selection
            if (e.ctrlKey) {
                if (this.selectedChips.has(chip.index)) {
                    this.selectedChips.delete(chip.index);
                } else {
                    this.selectedChips.add(chip.index);
                }
            }
            // Normal: replace selection
            else {
                this.selectedChips.clear();
                this.selectedChips.add(chip.index);
            }

            this.render();
        }
    }

    /**
     * Mouse up handler
     */
    _handleMouseUp(e) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;

        // Handle Alt+Drag polygon selection
        if (this.isAltDrag && this.polygonPath.length > 2) {
            const selected = this._getChipsInPolygon(this.polygonPath);

            if (e.shiftKey) {
                // Shift: add to selection
                selected.forEach(idx => this.selectedChips.add(idx));
            } else if (e.ctrlKey) {
                // Ctrl: toggle
                selected.forEach(idx => {
                    if (this.selectedChips.has(idx)) {
                        this.selectedChips.delete(idx);
                    } else {
                        this.selectedChips.add(idx);
                    }
                });
            } else {
                // Normal: replace selection
                this.selectedChips = new Set(selected);
            }

            this.isAltDrag = false;
            this.polygonPath = [];
            this.render();
            return;
        }

        // Handle Shift+2-click rectangle selection
        if (this.shiftClickPos) {
            const selected = this._getChipsInCanvasRect(
                this.shiftClickPos.x,
                this.shiftClickPos.y,
                canvasX,
                canvasY
            );

            if (e.ctrlKey) {
                // Ctrl: toggle
                selected.forEach(idx => {
                    if (this.selectedChips.has(idx)) {
                        this.selectedChips.delete(idx);
                    } else {
                        this.selectedChips.add(idx);
                    }
                });
            } else {
                // Normal or Shift: add to selection
                selected.forEach(idx => this.selectedChips.add(idx));
            }

            this.shiftClickPos = null;
            this.render();
            return;
        }

        this.isDragging = false;
        this.dragStartChip = null;
        this.isMultiSelect = false;
        this.isAltDrag = false;
        this.polygonPath = [];
        this.render();
    }

    /**
     * Get chips in canvas rectangle (for Shift+2-click)
     */
    _getChipsInCanvasRect(x1, y1, x2, y2) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);

        const selected = [];
        const transform = this.viewer.transform;

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            // Convert chip center to canvas coordinates
            const chipCenterX = ((rect.x0 + rect.x1) / 2) * transform.scale + transform.dx;
            const chipCenterY = ((rect.y0 + rect.y1) / 2) * transform.scale + transform.dy;

            // Check if chip center is in rectangle
            if (chipCenterX >= minX && chipCenterX <= maxX &&
                chipCenterY >= minY && chipCenterY <= maxY) {
                selected.push(i);
            }
        }

        return selected;
    }

    /**
     * Get chips in polygon (for Alt+Drag free-form selection)
     */
    _getChipsInPolygon(polygon) {
        if (polygon.length < 3) return [];

        const selected = [];
        const transform = this.viewer.transform;

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            // Convert chip center to canvas coordinates
            const chipCenterX = ((rect.x0 + rect.x1) / 2) * transform.scale + transform.dx;
            const chipCenterY = ((rect.y0 + rect.y1) / 2) * transform.scale + transform.dy;

            // Check if chip center is inside polygon
            if (this._isPointInPolygon(chipCenterX, chipCenterY, polygon)) {
                selected.push(i);
            }
        }

        return selected;
    }

    /**
     * Point-in-polygon algorithm (ray casting)
     */
    _isPointInPolygon(x, y, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;

            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /**
     * Mouse leave handler
     */
    _handleMouseLeave(e) {
        // Reset coordinate box
        if (this.coordChipAbs) {
            this.coordChipAbs.textContent = '-';
        }
        if (this.coordChipRel) {
            this.coordChipRel.textContent = '-';
        }

        // Clear hover
        this.hoveredChip = null;
        this.isDragging = false;
        this.dragStartChip = null;
        this.isMultiSelect = false;
        this.render();
    }

    /**
     * Keyboard handler
     */
    _handleKeyDown(e) {
        // ESC: Cancel ongoing selection
        if (e.key === 'Escape') {
            if (this.isAltDrag || this.shiftClickPos) {
                this.isAltDrag = false;
                this.polygonPath = [];
                this.shiftClickPos = null;
                this.render();
                e.preventDefault();
            }
        }
    }

    /**
     * Clear all data (on image unload)
     */
    clear() {
        this.positionsData = null;
        this.chips = [];
        this.chipIndexMap.clear();
        this.markedChips = [];
        this.classColors.clear();
        this.classColorIndex = 0;
        this.legendFilterClasses = null;
        this._notifyLegendUpdate([]);
        this.selectedChips.clear();
        if (this.viewer && typeof this.viewer.handleChipSelectionCleared === 'function') {
            this.viewer.handleChipSelectionCleared();
        }
        this.hoveredChip = null;
        this.currentImagePath = null;

        // Clear selection state
        this.isDragging = false;
        this.dragStartChip = null;
        this.isMultiSelect = false;
        this.isAltDrag = false;
        this.polygonPath = [];
        this.shiftClickPos = null;
        this.lastMousePos = null;

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Reset coordinate box
        if (this.coordChipAbs) {
            this.coordChipAbs.textContent = '-';
        }
        if (this.coordChipRel) {
            this.coordChipRel.textContent = '-';
        }
    }
}
