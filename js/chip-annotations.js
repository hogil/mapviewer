const STATUS_TEXT = {
    idle: 'Idle',
    loading: 'Loading…',
    ready: 'Ready',
    error: 'Unavailable',
    saving: 'Saving…',
    dirty: 'Unsaved changes',
    cropping: 'Saving crops…',
};

const CLASS_COLOR_CACHE = new Map();

function classToColor(className) {
    if (!className) return 'rgba(255,255,255,0.25)';
    if (CLASS_COLOR_CACHE.has(className)) return CLASS_COLOR_CACHE.get(className);
    let hash = 0;
    for (let i = 0; i < className.length; i += 1) {
        hash = ((hash << 5) - hash) + className.charCodeAt(i);
        hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    const color = `hsla(${hue}, 72%, 57%, 0.5)`;
    CLASS_COLOR_CACHE.set(className, color);
    return color;
}

function findEdgeIndex(value, edges) {
    if (!Array.isArray(edges) || edges.length === 0) return -1;
    for (let i = 1; i < edges.length; i += 1) {
        if (value < edges[i]) return i - 1;
    }
    return edges.length - 2;
}

function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
}

export class ChipAnnotationController {
    constructor(viewer) {
        this.viewer = viewer;
        this.positions = null;
        this.annotations = null;
        this.chipLookup = new Map();
        this.markedById = new Map();
        this.selectedChipIds = new Set();
        this.hoveredChipId = null;
        this.visible = true;
        this.isDirty = false;
        this.currentImagePath = null;
        this.savedPreviews = [];
        this.tooltip = document.getElementById('chip-tooltip');
        this.overlayCanvas = this.viewer?.dom?.overlayCanvas || null;
        this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null;
        this.dragSelecting = false;
        this.dragMode = 'add';
        this.dragStart = null;
        this.dragCurrent = null;

        this.cacheDom();
        this.bindUi();
        this.bindPointerEvents();
    }

    cacheDom() {
        this.ui = {
            status: document.getElementById('chip-annotation-status'),
            toggle: document.getElementById('chip-grid-toggle-btn'),
            assign: document.getElementById('chip-assign-class-btn'),
            save: document.getElementById('chip-save-btn'),
            clear: document.getElementById('chip-clear-btn'),
            saveCrops: document.getElementById('chip-save-crops-btn'),
            imageLabel: document.getElementById('chip-annotation-image-label'),
            counts: document.getElementById('chip-annotation-counts'),
            selected: document.getElementById('chip-selected-chip'),
            classList: document.getElementById('chip-class-distribution'),
            currentClass: document.getElementById('chip-current-class'),
            preview: document.getElementById('chip-crop-preview'),
        };
    }

    bindUi() {
        if (this.ui.toggle) {
            this.ui.toggle.addEventListener('click', () => {
                this.visible = !this.visible;
                this.updateUi();
                this.viewer?.scheduleDraw();
            });
        }
        if (this.ui.assign) {
            this.ui.assign.addEventListener('click', () => this.applyClassToSelection());
        }
        if (this.ui.save) {
            this.ui.save.addEventListener('click', () => this.handleSave());
        }
        if (this.ui.clear) {
            this.ui.clear.addEventListener('click', () => this.resetLocalChanges());
        }
        if (this.ui.saveCrops) {
            this.ui.saveCrops.addEventListener('click', () => this.handleSaveCrops());
        }
    }

    bindPointerEvents() {
        const container = this.viewer?.dom?.viewerContainer;
        if (!container) return;
        container.addEventListener('mousemove', (evt) => this.handlePointerMove(evt));
        container.addEventListener('mouseleave', () => this.handlePointerLeave());
        container.addEventListener('click', (evt) => this.handleClick(evt));
        container.addEventListener('mousedown', (evt) => this.handleDragStart(evt), true);
        window.addEventListener('mousemove', (evt) => this.handleDragMove(evt));
        window.addEventListener('mouseup', (evt) => this.handleDragEnd(evt));
    }

    getFolderPrefix() {
        return this.viewer?.currentFolderPrefix ?? '';
    }

    async handleImageChanged(imagePath) {
        this.currentImagePath = imagePath;
        this.positions = null;
        this.annotations = null;
        this.markedById.clear();
        this.selectedChipIds.clear();
        this.hoveredChipId = null;
        this.isDirty = false;
        this.savedPreviews = [];
        this.updateUi('loading');
        this.hideTooltip();

        try {
            const encoded = encodeURIComponent(imagePath);
            const annotationParams = new URLSearchParams();
            annotationParams.set('path', imagePath);
            annotationParams.set('folder', this.getFolderPrefix());
            const [posRes, annRes] = await Promise.all([
                fetch(`/api/chip-positions?path=${encoded}`),
                fetch(`/api/chip-annotations?${annotationParams.toString()}`),
            ]);
            if (!posRes.ok) throw new Error(await posRes.text());
            if (!annRes.ok) throw new Error(await annRes.text());
            this.positions = await posRes.json();
            this.annotations = await annRes.json();
            this.buildLookup();
            this.setMarkedFromServer();
            this.updateUi('ready');
            this.viewer?.scheduleDraw();
        } catch (error) {
            console.error('Chip annotation load failed:', error);
            this.updateUi('error');
        }
    }

    buildLookup() {
        this.chipLookup.clear();
        this.gridEdges = {
            xs: this.positions?.coord?.grid_edges?.xs || [],
            ys: this.positions?.coord?.grid_edges?.ys || [],
        };
        (this.positions?.chips || []).forEach((chip) => {
            if (!chip?.chip_id) return;
            this.chipLookup.set(chip.chip_id, chip);
            const key = this.keyForChip(chip);
            this.chipLookup.set(key, chip);
        });
    }

    keyForChip(chip) {
        if (chip.row !== undefined && chip.col !== undefined) {
            return `grid:${chip.row}:${chip.col}`;
        }
        return `abs:${chip.x_abs}:${chip.y_abs}`;
    }

    setMarkedFromServer() {
        this.markedById.clear();
        (this.annotations?.marked_chips || []).forEach((entry) => {
            if (!entry?.chip_id) return;
            this.markedById.set(entry.chip_id, { ...entry });
        });
    }

    screenToImagePoint(evt) {
        if (!this.viewer?.dom?.imageCanvas) return null;
        const rect = this.viewer.dom.imageCanvas.getBoundingClientRect();
        const canvasX = evt.clientX - rect.left;
        const canvasY = evt.clientY - rect.top;
        const x = (canvasX - this.viewer.transform.dx) / (this.viewer.transform.scale || 1);
        const y = (canvasY - this.viewer.transform.dy) / (this.viewer.transform.scale || 1);
        if (x < 0 || y < 0 || x > this.viewer.originalWidth || y > this.viewer.originalHeight) return null;
        return { x, y };
    }

    getChipFromPoint(point) {
        if (!point || !this.positions) return null;
        const xs = this.gridEdges?.xs;
        const ys = this.gridEdges?.ys;
        if (xs?.length > 1 && ys?.length > 1) {
            const col = findEdgeIndex(point.x, xs);
            const row = findEdgeIndex(point.y, ys);
            const chip = this.chipLookup.get(`grid:${row}:${col}`);
            if (chip) return chip;
        }
        return (this.positions?.chips || []).find((chip) => {
            const rect = chip.rect;
            return rect && point.x >= rect.x0 && point.x <= rect.x1 && point.y >= rect.y0 && point.y <= rect.y1;
        }) || null;
    }

    handlePointerMove(evt) {
        if (!this.visible || this.viewer?.gridMode) return;
        const point = this.screenToImagePoint(evt);
        if (!point) {
            this.hoveredChipId = null;
            this.hideTooltip();
            this.viewer?.scheduleDraw();
            return;
        }
        const chip = this.getChipFromPoint(point);
        if (chip?.chip_id !== this.hoveredChipId) {
            this.hoveredChipId = chip?.chip_id || null;
            this.updateSelectedInfo();
            this.viewer?.scheduleDraw();
        }
        if (chip) this.showTooltip(chip, evt.clientX, evt.clientY);
        else this.hideTooltip();
    }

    handlePointerLeave() {
        this.hoveredChipId = null;
        this.hideTooltip();
        this.viewer?.scheduleDraw();
    }

    handleClick(evt) {
        if (!this.positions || this.viewer?.gridMode || this.viewer?.isPanning || this.dragSelecting) return;
        const point = this.screenToImagePoint(evt);
        if (!point) return;
        const chip = this.getChipFromPoint(point);
        if (!chip) return;

        if (evt.altKey) {
            this.updateChipClass(chip, null);
            return;
        }

        const selectedClass = this.viewer?.selectedClass;
        if (selectedClass && !evt.ctrlKey && !evt.shiftKey) {
            this.updateChipClass(chip, selectedClass);
            this.viewer?.showToast?.(`'${selectedClass}' applied to ${chip.chip_id}`);
            return;
        }

        if (evt.ctrlKey || evt.metaKey) {
            if (this.selectedChipIds.has(chip.chip_id)) this.selectedChipIds.delete(chip.chip_id);
            else this.selectedChipIds.add(chip.chip_id);
        } else if (evt.shiftKey) {
            this.selectedChipIds.add(chip.chip_id);
        } else {
            this.selectedChipIds.clear();
            this.selectedChipIds.add(chip.chip_id);
        }
        this.updateSelectedInfo();
        this.viewer?.scheduleDraw();
    }

    handleDragStart(evt) {
        if (!this.positions || this.viewer?.gridMode) return;
        if (!(evt.ctrlKey || evt.shiftKey) || evt.button !== 0) return;
        const point = this.screenToImagePoint(evt);
        if (!point) return;
        evt.preventDefault();
        this.dragSelecting = true;
        this.dragMode = evt.ctrlKey ? 'toggle' : 'add';
        this.dragStart = point;
        this.dragCurrent = point;
    }

    handleDragMove(evt) {
        if (!this.dragSelecting) return;
        const point = this.screenToImagePoint(evt);
        if (!point) return;
        this.dragCurrent = point;
        this.viewer?.scheduleDraw();
    }

    handleDragEnd(evt) {
        if (!this.dragSelecting) return;
        evt?.preventDefault();
        const rect = this.getDragRect();
        this.dragSelecting = false;
        this.dragStart = null;
        this.dragCurrent = null;
        this.viewer?.scheduleDraw();
        if (!rect) return;
        const chips = this.selectChipsInRect(rect);
        if (!chips.length) return;
        if (this.dragMode === 'toggle') {
            chips.forEach((chipId) => {
                if (this.selectedChipIds.has(chipId)) this.selectedChipIds.delete(chipId);
                else this.selectedChipIds.add(chipId);
            });
        } else {
            chips.forEach((chipId) => this.selectedChipIds.add(chipId));
        }
        this.updateSelectedInfo();
    }

    getDragRect() {
        if (!this.dragStart || !this.dragCurrent) return null;
        const x0 = Math.min(this.dragStart.x, this.dragCurrent.x);
        const y0 = Math.min(this.dragStart.y, this.dragCurrent.y);
        const x1 = Math.max(this.dragStart.x, this.dragCurrent.x);
        const y1 = Math.max(this.dragStart.y, this.dragCurrent.y);
        if (x1 - x0 < 2 || y1 - y0 < 2) return null;
        return { x0, y0, x1, y1 };
    }

    selectChipsInRect(rect) {
        return (this.positions?.chips || [])
            .filter((chip) => {
                const box = chip.rect;
                return box && !(box.x1 < rect.x0 || box.x0 > rect.x1 || box.y1 < rect.y0 || box.y0 > rect.y1);
            })
            .map((chip) => chip.chip_id);
    }

    updateChipClass(chip, className) {
        const chipId = chip.chip_id;
        if (!chipId) return;
        if (!className) {
            this.markedById.delete(chipId);
            this.isDirty = true;
            this.updateUi();
            this.viewer?.scheduleDraw();
            return;
        }
        const entry = this.markedById.get(chipId) || {
            chip_id: chipId,
            x_abs: chip.x_abs,
            y_abs: chip.y_abs,
            row: chip.row,
            col: chip.col,
            bbox: chip.rect,
        };
        entry.class = className;
        this.markedById.set(chipId, entry);
        this.selectedChipIds.add(chipId);
        this.isDirty = true;
        this.viewer?.scheduleDraw();
        this.updateUi();
    }

    applyClassToSelection() {
        if (!this.selectedChipIds.size) {
            alert('먼저 칩을 선택하세요.');
            return;
        }
        const className = this.viewer?.selectedClass;
        if (!className) {
            alert('Fail List에서 클래스를 선택하세요.');
            return;
        }
        this.selectedChipIds.forEach((chipId) => {
            const chip = this.chipLookup.get(chipId);
            if (chip) this.updateChipClass(chip, className);
        });
        this.viewer?.showToast?.(`${this.selectedChipIds.size}개 칩에 '${className}' 적용`);
    }

    resetLocalChanges() {
        if (!this.isDirty) return;
        if (!window.confirm('저장되지 않은 변경을 모두 취소할까요?')) return;
        this.setMarkedFromServer();
        this.isDirty = false;
        this.selectedChipIds.clear();
        this.updateUi();
        this.viewer?.scheduleDraw();
    }

    async handleSave() {
        if (!this.currentImagePath) return;
        if (!this.isDirty) {
            this.viewer?.showToast?.('저장할 변경이 없습니다.');
            return;
        }
        this.updateUi('saving');
        try {
            const res = await fetch('/api/chip-annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_path: this.currentImagePath,
                    marked_chips: Array.from(this.markedById.values()),
                    folder_prefix: this.getFolderPrefix(),
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            this.annotations = data.data || data;
            this.setMarkedFromServer();
            this.isDirty = false;
            this.viewer?.showToast?.('Chip annotations saved');
            this.updateUi('ready');
        } catch (error) {
            console.error('Chip annotation save failed:', error);
            alert(`칩 라벨 저장 실패: ${error.message}`);
            this.updateUi('error');
        }
    }

    async handleSaveCrops() {
        if (!this.currentImagePath) return;
        this.updateUi('cropping');
        try {
            const res = await fetch('/api/chip-crops', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_path: this.currentImagePath,
                    chip_ids: Array.from(this.selectedChipIds),
                    include_unlabeled: this.selectedChipIds.size === 0,
                }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            this.savedPreviews = data.items || [];
            this.renderSavedPreviews();
            this.viewer?.showToast?.(`${data.saved_count}개 칩 이미지를 저장했습니다.`);
            this.updateUi('ready');
        } catch (error) {
            console.error('Chip crops failed:', error);
            alert(`칩 이미지 저장 실패: ${error.message}`);
            this.updateUi('error');
        }
    }

    updateUi(stateOverride) {
        const state = stateOverride || (this.isDirty ? 'dirty' : (this.positions ? 'ready' : 'idle'));
        if (this.ui.status) {
            this.ui.status.textContent = STATUS_TEXT[state] || STATUS_TEXT.idle;
            this.ui.status.dataset.state = state;
        }
        if (this.ui.toggle) {
            this.ui.toggle.textContent = this.visible ? 'Hide Grid' : 'Show Grid';
        }
        if (this.ui.save) {
            this.ui.save.disabled = !this.isDirty;
        }
        if (this.ui.clear) {
            this.ui.clear.disabled = !this.isDirty;
        }
        if (this.ui.saveCrops) {
            this.ui.saveCrops.disabled = !this.positions;
        }
        if (this.ui.imageLabel) {
            this.ui.imageLabel.textContent = this.currentImagePath?.split('/').pop() || '-';
        }
        if (this.ui.counts) {
            this.ui.counts.textContent = `${formatNumber(this.markedById.size)} chips selected`;
        }
        if (this.ui.currentClass) {
            this.ui.currentClass.textContent = this.viewer?.selectedClass || 'None';
        }
        this.renderClassDistribution();
        this.renderSavedPreviews();
        this.updateSelectedInfo();
    }

    renderClassDistribution() {
        if (!this.ui.classList) return;
        this.ui.classList.innerHTML = '';
        if (!this.markedById.size) {
            this.ui.classList.textContent = 'No chips labeled yet.';
            return;
        }
        const counts = {};
        this.markedById.forEach((entry) => {
            const cls = entry.class || 'unlabeled';
            counts[cls] = (counts[cls] || 0) + 1;
        });
        Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .forEach(([cls, count]) => {
                const row = document.createElement('div');
                row.className = 'chip-class-row';
                const color = classToColor(cls);
                row.innerHTML = `
                    <span class="chip-class-dot" style="background:${color};"></span>
                    <span class="chip-class-name">${cls}</span>
                    <span class="chip-class-count">${count}</span>
                `;
                this.ui.classList.appendChild(row);
            });
    }

    renderSavedPreviews() {
        if (!this.ui.preview) return;
        this.ui.preview.innerHTML = '';
        if (!this.savedPreviews.length) {
            const span = document.createElement('span');
            span.style.color = '#777';
            span.textContent = 'No crops exported yet.';
            this.ui.preview.appendChild(span);
            return;
        }
        this.savedPreviews.slice(0, 12).forEach((item) => {
            if (!item.preview) return;
            const img = document.createElement('img');
            img.src = item.preview;
            img.alt = item.chip_id;
            img.title = `${item.chip_id} (${item.class})`;
            this.ui.preview.appendChild(img);
        });
    }

    updateSelectedInfo() {
        if (!this.ui.selected) return;
        if (!this.selectedChipIds.size) {
            if (this.hoveredChipId) {
                const chip = this.chipLookup.get(this.hoveredChipId);
                this.ui.selected.textContent = chip
                    ? `${chip.chip_id} • row ${chip.row ?? '-'} col ${chip.col ?? '-'}` : 'Hover chip';
            } else {
                this.ui.selected.textContent = 'Select chip to inspect';
            }
            return;
        }
        if (this.selectedChipIds.size === 1) {
            const id = [...this.selectedChipIds][0];
            const chip = this.chipLookup.get(id);
            const cls = this.markedById.get(id)?.class || 'unlabeled';
            this.ui.selected.textContent = `${id} • ${cls} • row ${chip?.row ?? '-'} col ${chip?.col ?? '-'}`;
            return;
        }
        this.ui.selected.textContent = `${this.selectedChipIds.size} chips selected`;
    }

    showTooltip(chip, clientX, clientY) {
        if (!this.tooltip || !chip) return;
        const rect = chip.rect || {};
        this.tooltip.innerHTML = `
            <div><strong>${chip.chip_id}</strong></div>
            <div>Abs: (${chip.x_abs ?? '-'}, ${chip.y_abs ?? '-'})</div>
            <div>Row/Col: (${chip.row ?? '-'}, ${chip.col ?? '-'})</div>
            <div>Pixels: ${rect.x1 - rect.x0} × ${rect.y1 - rect.y0}</div>
            <div>Bin: ${chip.b || '-'}</div>
        `;
        this.tooltip.dataset.visible = 'true';
        this.tooltip.style.left = `${clientX + 12}px`;
        this.tooltip.style.top = `${clientY + 12}px`;
    }

    hideTooltip() {
        if (this.tooltip) this.tooltip.dataset.visible = 'false';
    }

    renderOverlay() {
        if (!this.overlayCanvas || !this.overlayCtx) return;
        if (!this.visible || !this.positions || this.viewer?.gridMode) {
            this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
            return;
        }
        const width = this.viewer.dom.imageCanvas.width;
        const height = this.viewer.dom.imageCanvas.height;
        if (this.overlayCanvas.width !== width || this.overlayCanvas.height !== height) {
            this.overlayCanvas.width = width;
            this.overlayCanvas.height = height;
        }
        const ctx = this.overlayCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const scale = this.viewer.transform.scale || 1;
        const dx = this.viewer.transform.dx || 0;
        const dy = this.viewer.transform.dy || 0;

        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1;
        if (Array.isArray(this.gridEdges?.xs)) {
            ctx.beginPath();
            this.gridEdges.xs.forEach((edge) => {
                const x = edge * scale + dx;
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
            });
            ctx.stroke();
        }
        if (Array.isArray(this.gridEdges?.ys)) {
            ctx.beginPath();
            this.gridEdges.ys.forEach((edge) => {
                const y = edge * scale + dy;
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
            });
            ctx.stroke();
        }

        this.markedById.forEach((entry, chipId) => {
            const chip = this.chipLookup.get(chipId);
            if (!chip?.rect) return;
            const rect = chip.rect;
            const x0 = rect.x0 * scale + dx;
            const y0 = rect.y0 * scale + dy;
            const w = (rect.x1 - rect.x0) * scale;
            const h = (rect.y1 - rect.y0) * scale;
            ctx.fillStyle = classToColor(entry.class || 'unlabeled');
            ctx.fillRect(x0, y0, w, h);
        });

        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00c2ff';
        this.selectedChipIds.forEach((chipId) => {
            const chip = this.chipLookup.get(chipId);
            if (!chip?.rect) return;
            const rect = chip.rect;
            const x0 = rect.x0 * scale + dx;
            const y0 = rect.y0 * scale + dy;
            const w = (rect.x1 - rect.x0) * scale;
            const h = (rect.y1 - rect.y0) * scale;
            ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
        });

        if (this.hoveredChipId && !this.selectedChipIds.has(this.hoveredChipId)) {
            const chip = this.chipLookup.get(this.hoveredChipId);
            if (chip?.rect) {
                const rect = chip.rect;
                const x0 = rect.x0 * scale + dx;
                const y0 = rect.y0 * scale + dy;
                const w = (rect.x1 - rect.x0) * scale;
                const h = (rect.y1 - rect.y0) * scale;
                ctx.strokeStyle = '#ffdf6d';
                ctx.lineWidth = 2;
                ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
            }
        }

        if (this.dragSelecting && this.dragStart && this.dragCurrent) {
            const rect = this.getDragRect();
            if (rect) {
                ctx.setLineDash([6, 4]);
                ctx.strokeStyle = 'rgba(0, 194, 255, 0.8)';
                ctx.lineWidth = 1.5;
                const x0 = rect.x0 * scale + dx;
                const y0 = rect.y0 * scale + dy;
                const w = (rect.x1 - rect.x0) * scale;
                const h = (rect.y1 - rect.y0) * scale;
                ctx.strokeRect(x0, y0, w, h);
                ctx.setLineDash([]);
            }
        }
    }
}
