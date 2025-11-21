const MODES = ["lot", "wafer"];

const LOT_COPY_MESSAGE = {
    lot: "LOT 값이 복사되었습니다.",
    wafer: "LOT 정보가 복사되었습니다.",
};

const WAFER_COPY_MESSAGE = "Wafer 정보가 복사되었습니다.";

function splitLotWaferValue(value = "") {
    const trimmed = (value || "").trim();
    if (!trimmed) {
        return { lot: "", wafer: "" };
    }
    const parts = trimmed.split("_").filter(Boolean);
    const lot = parts[0] || trimmed;
    let waferCode = "";
    if (parts.length > 2) {
        waferCode = parts[2];
    } else if (parts.length > 1) {
        waferCode = parts[1];
    }
    const wafer = waferCode ? `${lot}_${waferCode}` : trimmed;
    return { lot, wafer };
}

function modeMap(data, mode) {
    if (!data) return { groups: [] };
    return mode === "wafer" ? data.wafer || { groups: [] } : data.lot || { groups: [] };
}

export class MyLotModal {
    constructor(viewer) {
        this.viewer = viewer;
        this.windowEl = document.getElementById('my-lot-window');
        if (!this.windowEl) {
            return;
        }

        this.closeBtn = document.getElementById('my-lot-close-btn');
        this.modeButtons = Array.from(this.windowEl.querySelectorAll('[data-my-lot-mode]'));
        this.groupSelect = document.getElementById('my-lot-group-select');
        this.newGroupBtn = document.getElementById('my-lot-new-group-btn');
        this.saveBtn = document.getElementById('my-lot-save-btn');
        this.copyLotBtn = document.getElementById('my-lot-copy-lot');
        this.copyWaferBtn = document.getElementById('my-lot-copy-wafer');
        this.selectAllBtn = document.getElementById('my-lot-select-all');
        this.clearSelectionBtn = document.getElementById('my-lot-clear-selection');
        this.gridViewBtn = document.getElementById('my-lot-grid-view');
        this.entriesContainer = document.getElementById('my-lot-entries');
        this.previewImage = document.getElementById('my-lot-preview-image');
        this.previewEmpty = document.getElementById('my-lot-preview-empty');
        this.loginLabel = document.getElementById('my-lot-login-label');
        this.currentLotEl = document.getElementById('my-lot-current-lot');
        this.currentWaferEl = document.getElementById('my-lot-current-wafer');

        this.data = null;
        this.activeMode = "lot";
        this.activeGroup = null;
        this.selectedKeys = new Set();
        this.currentEntries = [];
        this.lastSelectedIndex = null;
        this.dragSelectActive = false;

        this.boundKeyHandler = (event) => {
            if (event.key === 'Escape') {
                this.close();
            }
        };
        this.boundWindowResize = () => this.ensureWindowBounds();
        this.boundStopDragSelection = () => this.stopDragSelection();

        this.bindEvents();
        this.setupDragging();
        window.addEventListener('resize', this.boundWindowResize);
        document.addEventListener('mouseup', this.boundStopDragSelection);
    }

    async parseErrorResponse(response) {
        const text = await response.text();
        try {
            const data = JSON.parse(text);
            if (data?.detail) {
                return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
            }
            return text || response.statusText;
        } catch {
            return text || response.statusText;
        }
    }

    bindEvents() {
        this.closeBtn?.addEventListener('click', () => this.close());
        this.modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.myLotMode;
                this.setMode(mode);
            });
        });
        this.groupSelect?.addEventListener('change', () => {
            this.activeGroup = this.groupSelect.value || null;
            this.clearSelection(true);
            this.renderEntries();
        });
        this.newGroupBtn?.addEventListener('click', () => this.handleCreateGroup());
        this.saveBtn?.addEventListener('click', () => this.handleSave());
        this.copyLotBtn?.addEventListener('click', () => this.copySelection('lot'));
        this.copyWaferBtn?.addEventListener('click', () => this.copySelection('wafer'));
        this.selectAllBtn?.addEventListener('click', () => this.selectAllEntries());
        this.clearSelectionBtn?.addEventListener('click', () => this.clearSelection());
        this.gridViewBtn?.addEventListener('click', () => this.openSelectionInViewer());

        if (this.entriesContainer) {
            this.entriesContainer.addEventListener('click', (event) => this.handleEntriesClick(event));
            this.entriesContainer.addEventListener('dblclick', (event) => this.handleEntryDoubleClick(event));
            this.entriesContainer.addEventListener('mousedown', (event) => this.handleEntryMouseDown(event));
            this.entriesContainer.addEventListener('mouseover', (event) => this.handleEntryMouseOver(event));
        }
    }

    setupDragging() {
        if (!this.windowEl || this._dragInitialized) {
            return;
        }
        const header = this.windowEl.querySelector('.my-lot-header');
        if (!header) {
            return;
        }
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        const onMouseMove = (event) => {
            if (!isDragging) return;
            event.preventDefault();
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            const newLeft = Math.min(Math.max(10, startLeft + dx), window.innerWidth - 60);
            const newTop = Math.min(Math.max(10, startTop + dy), window.innerHeight - 60);
            this.windowEl.style.left = `${newLeft}px`;
            this.windowEl.style.top = `${newTop}px`;
            this.windowEl.style.right = 'auto';
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        header.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            if (event.target.closest('button')) return;
            const rect = this.windowEl.getBoundingClientRect();
            isDragging = true;
            startX = event.clientX;
            startY = event.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            event.preventDefault();
        });

        this._dragInitialized = true;
    }

    ensureWindowBounds() {
        if (!this.windowEl) return;
        const rect = this.windowEl.getBoundingClientRect();
        let left = rect.left;
        let top = rect.top;
        if (left + rect.width > window.innerWidth) {
            left = Math.max(20, window.innerWidth - rect.width - 20);
        }
        if (top + rect.height > window.innerHeight) {
            top = Math.max(20, window.innerHeight - rect.height - 20);
        }
        if (left < 10) left = 10;
        if (top < 10) top = 10;
        this.windowEl.style.left = `${left}px`;
        this.windowEl.style.top = `${top}px`;
        this.windowEl.style.right = 'auto';
    }

    async open() {
        if (!this.windowEl) return;
        try {
            await this.refreshData();
            this.setMode(this.activeMode || "lot");
            this.updateCurrentValues();
            this.windowEl.style.display = 'flex';
            this.windowEl.classList.add('is-open');
            this.ensureWindowBounds();
            document.addEventListener('keydown', this.boundKeyHandler);
        } catch (error) {
            console.error('[MyLotModal] open failed:', error);
            this.viewer?.showToast?.('MY LOT 데이터를 불러오지 못했습니다.', 2200);
        }
    }

    close() {
        if (!this.windowEl) return;
        this.windowEl.classList.remove('is-open');
        this.windowEl.style.display = 'none';
        document.removeEventListener('keydown', this.boundKeyHandler);
        this.stopDragSelection();
    }

    async refreshData() {
        const res = await fetch('/api/my-lot', { cache: 'no-store' });
        if (!res.ok) {
            throw new Error(await res.text());
        }
        this.data = await res.json();
        if (this.loginLabel && this.data?.login_id) {
            this.loginLabel.textContent = `Login: ${this.data.login_id}`;
        }
    }

    setMode(mode) {
        if (!MODES.includes(mode)) {
            mode = "lot";
        }
        this.activeMode = mode;
        this.modeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.myLotMode === mode);
        });
        this.renderGroups();
        this.clearSelection(true);
        this.renderEntries();
        this.updateActionButtonStates();
    }

    getModeData() {
        if (!this.data) return { groups: [] };
        return modeMap(this.data, this.activeMode);
    }

    renderGroups() {
        const modeData = this.getModeData();
        const groups = modeData.groups || [];
        if (!this.groupSelect) return;
        this.groupSelect.innerHTML = '';
        if (!groups.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '그룹이 없습니다';
            this.groupSelect.appendChild(option);
            this.activeGroup = null;
            return;
        }
        groups.forEach(group => {
            const option = document.createElement('option');
            option.value = group.name;
            option.textContent = group.name;
            this.groupSelect.appendChild(option);
        });
        if (!this.activeGroup || !groups.some(group => group.name === this.activeGroup)) {
            this.activeGroup = groups[0].name;
        }
        this.groupSelect.value = this.activeGroup;
    }

    getActiveGroup() {
        const modeData = this.getModeData();
        const groups = modeData.groups || [];
        if (!groups.length) {
            return null;
        }
        const found = groups.find(group => group.name === this.activeGroup);
        return found || groups[0];
    }

    renderEntries() {
        if (!this.entriesContainer) return;
        this.entriesContainer.innerHTML = '';
        const group = this.getActiveGroup();
        this.currentEntries = group?.entries ? [...group.entries] : [];
        this.syncSelectionWithEntries();

        if (!this.currentEntries.length) {
            const emptyDiv = document.createElement('div');
            emptyDiv.textContent = '저장된 항목이 없습니다.';
            emptyDiv.style.textAlign = 'center';
            emptyDiv.style.padding = '14px 0';
            emptyDiv.style.color = '#888';
            this.entriesContainer.appendChild(emptyDiv);
            this.updatePreview(null);
            this.updateActionButtonStates();
            return;
        }

        this.currentEntries.forEach((entry, index) => {
            const row = this.buildEntryRow(entry, index);
            this.entriesContainer.appendChild(row);
        });

        this.updateSelectionStyles();
        this.updatePreviewForSelection();
        this.updateActionButtonStates();
    }

    buildEntryRow(entry, index) {
        const row = document.createElement('div');
        row.className = 'my-lot-entry-row';
        row.dataset.index = String(index);
        row.dataset.value = entry.value || '';
        row.dataset.path = entry.path || '';

        const valueWrapper = document.createElement('div');
        valueWrapper.className = 'my-lot-entry-value';
        const valueLabel = document.createElement('div');
        valueLabel.textContent = entry.value || '-';
        const pathLabel = document.createElement('span');
        pathLabel.className = 'my-lot-entry-path';
        pathLabel.textContent = entry.path || '';
        valueWrapper.appendChild(valueLabel);
        valueWrapper.appendChild(pathLabel);

        const actions = document.createElement('div');
        actions.className = 'my-lot-entry-actions';

        const previewBtn = document.createElement('button');
        previewBtn.textContent = '보기';
        previewBtn.dataset.action = 'preview';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '복사';
        copyBtn.dataset.action = 'copy';

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '삭제';
        deleteBtn.dataset.action = 'delete';

        actions.appendChild(previewBtn);
        actions.appendChild(copyBtn);
        actions.appendChild(deleteBtn);

        row.appendChild(valueWrapper);
        row.appendChild(actions);
        return row;
    }

    handleEntriesClick(event) {
        const actionBtn = event.target.closest('button[data-action]');
        if (!actionBtn) {
            return;
        }
        const row = event.target.closest('.my-lot-entry-row');
        if (!row) return;
        const index = Number(row.dataset.index);
        const entry = this.currentEntries[index];
        if (!entry) return;
        const action = actionBtn.dataset.action;
        if (action === 'preview') {
            this.updatePreview(entry);
        } else if (action === 'copy') {
            this.copyToClipboard(entry.value);
        } else if (action === 'delete') {
            this.handleDelete(entry.value);
        }
        event.stopPropagation();
    }

    handleEntryDoubleClick(event) {
        const row = event.target.closest('.my-lot-entry-row');
        if (!row) return;
        const index = Number(row.dataset.index);
        const entry = this.currentEntries[index];
        if (!entry?.path) return;
        this.viewer?.loadImage?.(entry.path);
    }

    handleEntryMouseDown(event) {
        if (event.button !== 0) return;
        if (event.target.closest('button[data-action]')) {
            return;
        }
        const row = event.target.closest('.my-lot-entry-row');
        if (!row) return;
        const index = Number(row.dataset.index);
        if (Number.isNaN(index)) return;

        if (event.shiftKey && this.lastSelectedIndex !== null) {
            this.selectRange(this.lastSelectedIndex, index, event.ctrlKey || event.metaKey);
        } else if (event.ctrlKey || event.metaKey) {
            this.toggleRowSelection(index);
        } else {
            this.clearSelection(true);
            this.selectRow(index, true);
            this.dragSelectActive = true;
        }
        event.preventDefault();
        this.updatePreviewForSelection();
    }

    handleEntryMouseOver(event) {
        if (!this.dragSelectActive) return;
        const row = event.target.closest('.my-lot-entry-row');
        if (!row) return;
        const index = Number(row.dataset.index);
        if (Number.isNaN(index)) return;
        this.selectRow(index, false);
    }

    stopDragSelection() {
        this.dragSelectActive = false;
    }

    selectRow(index, setAnchor = true) {
        const entry = this.currentEntries[index];
        if (!entry) return;
        this.selectedKeys.add(entry.value);
        if (setAnchor) {
            this.lastSelectedIndex = index;
        }
        this.updateSelectionStyles();
    }

    selectRange(start, end, keepExisting = false) {
        if (!keepExisting) {
            this.clearSelection(true);
        }
        const [min, max] = [Math.min(start, end), Math.max(start, end)];
        for (let i = min; i <= max; i += 1) {
            this.selectRow(i, false);
        }
        this.lastSelectedIndex = end;
        this.updateSelectionStyles();
    }

    toggleRowSelection(index) {
        const entry = this.currentEntries[index];
        if (!entry) return;
        if (this.selectedKeys.has(entry.value)) {
            this.selectedKeys.delete(entry.value);
        } else {
            this.selectedKeys.add(entry.value);
            this.lastSelectedIndex = index;
        }
        this.updateSelectionStyles();
        this.updatePreviewForSelection();
    }

    selectAllEntries() {
        if (!this.currentEntries.length) return;
        this.selectedKeys = new Set(this.currentEntries.map(entry => entry.value));
        this.updateSelectionStyles();
        this.updatePreviewForSelection();
    }

    clearSelection(silent = false) {
        if (!this.selectedKeys.size) {
            return;
        }
        this.selectedKeys.clear();
        this.lastSelectedIndex = null;
        this.updateSelectionStyles();
        if (!silent) {
            this.updatePreviewForSelection();
        }
    }

    syncSelectionWithEntries() {
        const valid = new Set(this.currentEntries.map(entry => entry.value));
        let changed = false;
        for (const value of Array.from(this.selectedKeys)) {
            if (!valid.has(value)) {
                this.selectedKeys.delete(value);
                changed = true;
            }
        }
        if (changed) {
            this.updateSelectionStyles();
        }
    }

    updateSelectionStyles() {
        if (!this.entriesContainer) return;
        const rows = this.entriesContainer.querySelectorAll('.my-lot-entry-row');
        rows.forEach(row => {
            const value = row.dataset.value || '';
            row.classList.toggle('selected', this.selectedKeys.has(value));
        });
        this.updateActionButtonStates();
    }

    updateActionButtonStates() {
        const hasSelection = this.selectedKeys.size > 0;
        if (this.copyLotBtn) {
            this.copyLotBtn.disabled = !hasSelection;
        }
        if (this.copyWaferBtn) {
            const canCopyWafer = this.activeMode === 'wafer' && hasSelection;
            this.copyWaferBtn.disabled = !canCopyWafer;
        }
        if (this.clearSelectionBtn) {
            this.clearSelectionBtn.disabled = !hasSelection;
        }
        if (this.gridViewBtn) {
            this.gridViewBtn.disabled = !hasSelection;
        }
        if (this.selectAllBtn) {
            this.selectAllBtn.disabled = !this.currentEntries.length;
        }
    }

    updatePreview(entry) {
        if (!this.previewImage || !this.previewEmpty) return;
        if (!entry || !entry.path) {
            this.previewImage.style.display = 'none';
            this.previewEmpty.style.display = 'block';
            this.previewImage.src = '';
            return;
        }
        const absolutePath = this.viewer?.buildAbsoluteImagePath?.(entry.path);
        if (!absolutePath) {
            this.previewImage.style.display = 'none';
            this.previewEmpty.style.display = 'block';
            this.previewImage.src = '';
            return;
        }
        const separator = absolutePath.includes('?') ? '&' : '?';
        this.previewImage.onload = () => {
            this.previewImage.style.display = 'block';
            this.previewEmpty.style.display = 'none';
        };
        this.previewImage.onerror = () => {
            this.previewImage.style.display = 'none';
            this.previewEmpty.style.display = 'block';
        };
        this.previewImage.src = `${absolutePath}${separator}t=${Date.now()}`;
    }

    updatePreviewForSelection() {
        const selected = this.getSelectedEntries();
        if (selected.length) {
            this.updatePreview(selected[selected.length - 1]);
            return;
        }
        if (this.currentEntries.length) {
            this.updatePreview(this.currentEntries[0]);
        } else {
            this.updatePreview(null);
        }
    }

    getSelectedEntries() {
        if (!this.selectedKeys.size) return [];
        return this.currentEntries.filter(entry => this.selectedKeys.has(entry.value));
    }

    copySelection(type) {
        const entries = this.getSelectedEntries();
        if (!entries.length) {
            this.viewer?.showToast?.('선택된 항목이 없습니다.', 1700);
            return;
        }
        const payload = entries.map(entry => {
            if (type === 'wafer') {
                return this.activeMode === 'lot' ? entry.value : splitLotWaferValue(entry.value).wafer;
            }
            if (this.activeMode === 'wafer') {
                return splitLotWaferValue(entry.value).lot;
            }
            return entry.value;
        }).filter(Boolean);

        if (!payload.length) {
            this.viewer?.showToast?.('복사할 값이 없습니다.', 1700);
            return;
        }
        const text = payload.join('\n');
        if (!text.trim()) {
            this.viewer?.showToast?.('복사할 값이 없습니다.', 1700);
            return;
        }
        if (type === 'wafer') {
            this.copyToClipboard(text, WAFER_COPY_MESSAGE);
        } else {
            const message = LOT_COPY_MESSAGE[this.activeMode] || '복사했습니다.';
            this.copyToClipboard(text, message);
        }
    }

    async openSelectionInViewer() {
        const entries = this.getSelectedEntries();
        if (!entries.length) {
            this.viewer?.showToast?.('선택된 항목이 없습니다.', 1700);
            return;
        }
        const paths = entries.map(entry => entry.path).filter(Boolean);
        if (!paths.length) {
            this.viewer?.showToast?.('경로 정보가 없습니다.', 1700);
            return;
        }
        if (paths.length === 1) {
            this.viewer?.loadImage?.(paths[0]);
            return;
        }
        if (this.viewer?.showGrid) {
            await this.viewer.showGrid(paths);
        }
    }

    async handleSave() {
        const candidate = this.viewer?.getMyLotCandidate?.();
        if (!candidate || !candidate.path) {
            this.viewer?.showToast?.('현재 이미지를 찾을 수 없습니다.', 1800);
            return;
        }
        const value = this.activeMode === 'lot' ? candidate.lotValue : candidate.waferValue;
        if (!value) {
            this.viewer?.showToast?.('LOT/ Wafer 값을 추출하지 못했습니다.', 2000);
            return;
        }
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }
        try {
            const res = await fetch('/api/my-lot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                    value,
                    path: candidate.path,
                }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }
            await this.refreshData();
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('MY LOT에 저장했습니다.', 1600);
        } catch (error) {
            console.error('[MyLotModal] save failed:', error);
            const message = error?.message || 'MY LOT 저장에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
        }
    }

    async handleCreateGroup() {
        const name = prompt('새 그룹 이름을 입력하세요.');
        if (!name) {
            return;
        }
        try {
            const res = await fetch('/api/my-lot/group', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: this.activeMode, group: name }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }
            await this.refreshData();
            this.activeGroup = name.replace(/[^0-9A-Za-z_\-\.]+/g, "_") || name;
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('그룹을 생성했습니다.', 1600);
        } catch (error) {
            console.error('[MyLotModal] create group failed:', error);
            const message = error?.message || '그룹 생성에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
        }
    }

    async handleDelete(value) {
        if (!this.activeGroup) return;
        if (!confirm('선택한 항목을 삭제할까요?')) {
            return;
        }
        try {
            const res = await fetch('/api/my-lot', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                    value,
                }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }
            await this.refreshData();
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('삭제했습니다.', 1600);
        } catch (error) {
            console.error('[MyLotModal] delete failed:', error);
            const message = error?.message || '항목 삭제에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
        }
    }

    updateCurrentValues() {
        const candidate = this.viewer?.getMyLotCandidate?.();
        if (this.currentLotEl) {
            this.currentLotEl.textContent = candidate?.lotValue || '-';
        }
        if (this.currentWaferEl) {
            this.currentWaferEl.textContent = candidate?.waferValue || '-';
        }
    }

    copyToClipboard(value, message = '복사했습니다.') {
        if (!value) return;
        const onSuccess = () => this.viewer?.showToast?.(message, 1400);
        const onFail = () => this.viewer?.showToast?.('클립보드 복사에 실패했습니다.', 1600);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(value).then(onSuccess).catch(onFail);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = value;
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            onSuccess();
        } catch {
            onFail();
        } finally {
            document.body.removeChild(textarea);
        }
    }
}
