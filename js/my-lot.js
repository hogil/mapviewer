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
    // LOT은 인덱스 0
    const lot = parts[0] || trimmed;
    // Wafer는 인덱스 2 (parts.length > 2일 때만)
    let wafer = "";
    if (parts.length > 2) {
        wafer = parts[2];
    }
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
        this.savePendingBtn = document.getElementById('my-lot-save-pending-btn');
        this.copyLotBtn = document.getElementById('my-lot-copy-lot');
        this.copyWaferBtn = document.getElementById('my-lot-copy-wafer');
        this.copyLotWaferBtn = document.getElementById('my-lot-copy-lot-wafer');
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
        this.pendingPaths = []; // Context Menu에서 추가할 경로들

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
        this.savePendingBtn?.addEventListener('click', () => this.handleSavePending());
        this.copyLotBtn?.addEventListener('click', () => this.copySelection('lot'));
        this.copyWaferBtn?.addEventListener('click', () => this.copySelection('wafer'));
        this.copyLotWaferBtn?.addEventListener('click', () => this.copySelection('lot-wafer'));
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

    async open(pendingPaths = null) {
        if (!this.windowEl) return;
        try {
            // 대기 중인 경로 설정
            if (pendingPaths && pendingPaths.length > 0) {
                this.pendingPaths = [...pendingPaths];
            }
            
            await this.refreshData();
            this.setMode(this.activeMode || "lot");
            this.updateCurrentValues();
            this.updatePendingButtonVisibility();
            this.updateCopyButtonVisibility(); // Tab에 따라 복사 버튼 표시/숨김
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
        // 대기 중인 경로 초기화
        this.pendingPaths = [];
        this.updatePendingButtonVisibility();
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
        this.updatePendingButtonVisibility();
        this.updateCopyButtonVisibility();
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

        // 테이블 생성
        const table = document.createElement('table');
        table.dataset.mode = this.activeMode;
        const thead = document.createElement('thead');
        const tbody = document.createElement('tbody');
        
        // 헤더 생성
        const headerRow = document.createElement('tr');
        const headers = this.activeMode === 'lot' 
            ? ['LOT', '등록일시', '동작']
            : ['LOT', 'Wafer', '등록일시', '동작'];
        headers.forEach(headerText => {
            const th = document.createElement('th');
            th.textContent = headerText;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        if (!this.currentEntries.length) {
            const emptyRow = document.createElement('tr');
            const emptyCell = document.createElement('td');
            emptyCell.colSpan = headers.length;
            emptyCell.textContent = '저장된 항목이 없습니다.';
            emptyCell.style.textAlign = 'center';
            emptyCell.style.padding = '14px 0';
            emptyCell.style.color = '#888';
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
            this.updatePreview(null);
            this.updateActionButtonStates();
        } else {
            this.currentEntries.forEach((entry, index) => {
                const row = this.buildEntryRow(entry, index);
                tbody.appendChild(row);
            });
        }

        table.appendChild(tbody);
        this.entriesContainer.appendChild(table);

        this.updateSelectionStyles();
        this.updatePreviewForSelection();
        this.updateActionButtonStates();
    }

    buildEntryRow(entry, index) {
        const row = document.createElement('tr');
        row.className = 'my-lot-entry-row';
        row.dataset.index = String(index);
        row.dataset.value = entry.value || '';
        row.dataset.path = entry.path || '';

        // LOT/Wafer 파싱
        const { lot, wafer } = splitLotWaferValue(entry.value || entry.filename || '');
        
        // LOT 컬럼
        const lotCell = document.createElement('td');
        lotCell.textContent = lot || '-';
        lotCell.style.padding = '8px 6px';
        lotCell.style.color = '#f3f3f3';
        row.appendChild(lotCell);

        // Wafer 컬럼 (LOT Tab에서는 표시하지 않음)
        if (this.activeMode === 'wafer') {
            const waferCell = document.createElement('td');
            waferCell.textContent = wafer || '-';
            waferCell.style.padding = '8px 6px';
            waferCell.style.color = '#f3f3f3';
            row.appendChild(waferCell);
        }

        // 등록일시 컬럼
        const dateCell = document.createElement('td');
        if (entry.saved_at) {
            // saved_at 형식: "yymmdd_HHMMSS" -> "yy-mm-dd HH:MM:SS"로 변환
            const savedAt = entry.saved_at;
            let formattedDate = savedAt;
            if (savedAt.length >= 13 && savedAt.includes('_')) {
                const [datePart, timePart] = savedAt.split('_');
                if (datePart.length === 6 && timePart.length === 6) {
                    const year = '20' + datePart.substring(0, 2);
                    const month = datePart.substring(2, 4);
                    const day = datePart.substring(4, 6);
                    const hour = timePart.substring(0, 2);
                    const minute = timePart.substring(2, 4);
                    const second = timePart.substring(4, 6);
                    formattedDate = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
                }
            }
            dateCell.textContent = formattedDate;
        } else {
            dateCell.textContent = '-';
        }
        dateCell.style.padding = '8px 6px';
        dateCell.style.color = '#8b8b8b';
        dateCell.style.fontSize = '11px';
        row.appendChild(dateCell);

        // 동작 컬럼 - 액션 버튼들
        const actionCell = document.createElement('td');
        actionCell.style.padding = '8px 6px';
        actionCell.style.whiteSpace = 'nowrap';
        const actions = document.createElement('div');
        actions.className = 'my-lot-entry-actions';
        actions.style.display = 'flex';
        actions.style.gap = '6px';
        actions.style.flexWrap = 'nowrap';

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
        actionCell.appendChild(actions);
        row.appendChild(actionCell);

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
            // 보기 버튼: Wafer Map Explorer에서 이미지 선택과 동일하게 동작
            if (entry.path) {
                // Wafer Map Explorer와 동일하게 selectedImages 설정
                if (this.viewer) {
                    this.viewer.selectedImages = [entry.path];
                    this.viewer.selectedImagePath = entry.path;
                }
                // enterSingleViewMode를 호출하여 Wafer Map Explorer와 동일한 동작 수행
                if (this.viewer?.enterSingleViewMode) {
                    this.viewer.enterSingleViewMode(entry.path).catch((error) => {
                        console.error('[MyLotModal] enterSingleViewMode failed:', error);
                        this.viewer?.showToast?.('이미지 로드에 실패했습니다.', 2000);
                    });
                } else {
                    // fallback: 직접 loadImage 호출
                    this.viewer?.loadImage?.(entry.path).catch((error) => {
                        console.error('[MyLotModal] loadImage failed:', error);
                        this.viewer?.showToast?.('이미지 로드에 실패했습니다.', 2000);
                    });
                }
            } else {
                this.viewer?.showToast?.('경로 정보가 없습니다.', 1700);
            }
        } else if (action === 'copy') {
            // 개별 항목 복사
            const { lot, wafer } = splitLotWaferValue(entry.value || entry.filename || '');
            if (this.activeMode === 'wafer') {
                // Wafer Tab: LOT\tWafer 형식
                const text = `${lot}\t${wafer}`;
                this.copyToClipboard(text, '복사했습니다.');
            } else {
                // LOT Tab: LOT만
                this.copyToClipboard(lot, '복사했습니다.');
            }
        } else if (action === 'delete') {
            this.handleDelete(entry.value || entry.filename);
        }
        event.stopPropagation();
    }

    handleEntryDoubleClick(event) {
        const row = event.target.closest('.my-lot-entry-row');
        if (!row) return;
        const index = Number(row.dataset.index);
        const entry = this.currentEntries[index];
        if (!entry?.path) return;
        // Wafer Map Explorer와 동일하게 selectedImages 설정
        if (this.viewer) {
            this.viewer.selectedImages = [entry.path];
            this.viewer.selectedImagePath = entry.path;
        }
        // Wafer Map Explorer에서 이미지 선택과 동일하게 동작
        if (this.viewer?.enterSingleViewMode) {
            this.viewer.enterSingleViewMode(entry.path).catch((error) => {
                console.error('[MyLotModal] enterSingleViewMode failed:', error);
                this.viewer?.showToast?.('이미지 로드에 실패했습니다.', 2000);
            });
        } else {
            // fallback: 직접 loadImage 호출
            this.viewer?.loadImage?.(entry.path).catch((error) => {
                console.error('[MyLotModal] loadImage failed:', error);
                this.viewer?.showToast?.('이미지 로드에 실패했습니다.', 2000);
            });
        }
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
        const key = entry.value || entry.filename;
        this.selectedKeys.add(key);
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
        const key = entry.value || entry.filename;
        if (this.selectedKeys.has(key)) {
            this.selectedKeys.delete(key);
        } else {
            this.selectedKeys.add(key);
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
        const valid = new Set(
            this.currentEntries.map(entry => entry.value || entry.filename)
        );
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
            const entry = this.currentEntries[Number(row.dataset.index)];
            const filename = entry?.filename || entry?.value || '';
            row.classList.toggle('selected', 
                this.selectedKeys.has(value) || this.selectedKeys.has(filename)
            );
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
        if (this.copyLotWaferBtn) {
            this.copyLotWaferBtn.disabled = !hasSelection;
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

    /**
     * 복사 버튼 표시/숨김 업데이트 (Tab에 따라)
     */
    updateCopyButtonVisibility() {
        if (this.activeMode === 'lot') {
            // LOT Tab: LOT 복사 버튼만 표시
            if (this.copyLotBtn) {
                this.copyLotBtn.style.display = 'inline-block';
            }
            if (this.copyWaferBtn) {
                this.copyWaferBtn.style.display = 'none';
            }
            if (this.copyLotWaferBtn) {
                this.copyLotWaferBtn.style.display = 'none';
            }
        } else {
            // Wafer Tab: LOT and Wafer 복사 버튼만 표시
            if (this.copyLotBtn) {
                this.copyLotBtn.style.display = 'none';
            }
            if (this.copyWaferBtn) {
                this.copyWaferBtn.style.display = 'none';
            }
            if (this.copyLotWaferBtn) {
                this.copyLotWaferBtn.style.display = 'inline-block';
            }
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
        return this.currentEntries.filter(entry => 
            this.selectedKeys.has(entry.value) || this.selectedKeys.has(entry.filename)
        );
    }

    copySelection(type) {
        const entries = this.getSelectedEntries();
        if (!entries.length) {
            this.viewer?.showToast?.('선택된 항목이 없습니다.', 1700);
            return;
        }
        
        if (type === 'lot-wafer') {
            // Wafer Tab: LOT\tWafer 형식으로 복사
            const payload = entries.map(entry => {
                const { lot, wafer } = splitLotWaferValue(entry.value || entry.filename || '');
                return `${lot}\t${wafer}`;
            }).filter(Boolean);
            
            if (!payload.length) {
                this.viewer?.showToast?.('복사할 값이 없습니다.', 1700);
                return;
            }
            const text = payload.join('\n');
            this.copyToClipboard(text, 'LOT and Wafer 복사했습니다.');
        } else if (type === 'lot') {
            // LOT Tab: LOT만 복사
            const payload = entries.map(entry => {
                const { lot } = splitLotWaferValue(entry.value || entry.filename || '');
                return lot || '';
            }).filter(Boolean);
            
            if (!payload.length) {
                this.viewer?.showToast?.('복사할 값이 없습니다.', 1700);
                return;
            }
            const text = payload.join('\n');
            this.copyToClipboard(text, 'LOT 복사했습니다.');
        } else if (type === 'wafer') {
            // Wafer만 복사 (기존 호환성 유지)
            const payload = entries.map(entry => {
                const { wafer } = splitLotWaferValue(entry.value || entry.filename || '');
                return wafer || '';
            }).filter(Boolean);
            
            if (!payload.length) {
                this.viewer?.showToast?.('복사할 값이 없습니다.', 1700);
                return;
            }
            const text = payload.join('\n');
            this.copyToClipboard(text, 'Wafer 복사했습니다.');
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
        if (!candidate.path) {
            this.viewer?.showToast?.('경로 정보가 없습니다.', 2000);
            return;
        }
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }
        
        // value는 백엔드에서 path를 파싱하므로 파일명 사용
        const filename = candidate.filename || candidate.path.split('/').pop() || candidate.path.split('\\').pop() || '';
        if (!filename) {
            this.viewer?.showToast?.('파일명을 추출할 수 없습니다.', 2000);
            return;
        }
        
        try {
            const res = await fetch('/api/my-lot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                    value: filename, // 백엔드에서 path를 파싱하므로 파일명 전달
                    path: candidate.path,
                }),
            });
            if (!res.ok) {
                const errorText = await this.parseErrorResponse(res);
                // 중복 등록 에러 메시지 처리
                if (errorText.includes('이미 등록된 항목')) {
                    this.viewer?.showToast?.('이미 등록된 항목입니다.', 2000);
                } else {
                    throw new Error(errorText);
                }
                return;
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

    async copyToClipboard(value, message = '복사했습니다.') {
        if (!value) return;
        const onSuccess = () => this.viewer?.showToast?.(message, 1400);
        const onFail = () => this.viewer?.showToast?.('클립보드 복사에 실패했습니다.', 1600);
        
        try {
            // 최신 Clipboard API 사용
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(value);
                onSuccess();
                return;
            }
            
            // Fallback: textarea 방식
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            textarea.style.top = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            
            const successful = document.execCommand('copy');
            document.body.removeChild(textarea);
            
            if (successful) {
                onSuccess();
            } else {
                onFail();
            }
        } catch (error) {
            console.error('[MyLotModal] copyToClipboard error:', error);
            onFail();
        }
    }

    /**
     * 특정 경로를 MY LOT에 저장 (Context Menu에서 호출)
     * @param {string} path 저장할 이미지 경로
     */
    async handleSaveFromPath(path) {
        if (!path) {
            this.viewer?.showToast?.('경로 정보가 없습니다.', 1800);
            return;
        }
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }
        
        // 경로에서 LOT/Wafer 값 추출
        const tokens = this.viewer?.extractLotTokensFromPath?.(path);
        if (!tokens) {
            this.viewer?.showToast?.('경로에서 정보를 추출할 수 없습니다.', 2000);
            return;
        }
        
        const value = this.activeMode === 'lot' ? tokens.lotValue : tokens.waferValue;
        if (!value) {
            this.viewer?.showToast?.('LOT/Wafer 값을 추출하지 못했습니다.', 2000);
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
                    path: path,
                }),
            });
            if (!res.ok) {
                const errorText = await this.parseErrorResponse(res);
                // 중복 등록 에러 메시지 처리
                if (errorText.includes('이미 등록된 항목')) {
                    this.viewer?.showToast?.('이미 등록된 항목입니다.', 2000);
                } else {
                    throw new Error(errorText);
                }
                return;
            }
            await this.refreshData();
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('MY LOT에 저장했습니다.', 1600);
        } catch (error) {
            console.error('[MyLotModal] handleSaveFromPath failed:', error);
            const message = error?.message || 'MY LOT 저장에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
        }
    }

    /**
     * 여러 경로를 MY LOT에 일괄 저장 (Context Menu에서 호출)
     * @param {Array<string>} paths 저장할 이미지 경로 배열
     */
    async addMultipleEntries(paths) {
        if (!paths || paths.length === 0) {
            this.viewer?.showToast?.('저장할 이미지가 없습니다.', 1800);
            return;
        }
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }
        
        // 먼저 현재 그룹의 기존 항목들을 가져와서 중복 체크
        const modeData = this.getModeData();
        const currentGroup = this.getActiveGroup();
        const existingEntries = currentGroup?.entries || [];
        
        // 중복 체크를 위한 Set 생성
        const existingKeys = new Set();
        if (this.activeMode === 'lot') {
            // LOT Tab: root만 체크
            existingEntries.forEach(entry => {
                const root = entry.root || entry.value?.split('_')[0] || '';
                if (root) existingKeys.add(root);
            });
        } else {
            // Wafer Tab: root + wafer 조합 체크
            existingEntries.forEach(entry => {
                const root = entry.root || entry.value?.split('_')[0] || '';
                const wafer = entry.wafer || '';
                if (root && wafer) {
                    existingKeys.add(`${root}_${wafer}`);
                }
            });
        }
        
        let successCount = 0;
        let failCount = 0;
        let duplicateCount = 0;
        const duplicatePaths = [];
        const failedPaths = []; // 실패한 경로 저장
        
        for (const path of paths) {
            if (!path) continue;
            
            // 경로에서 LOT/Wafer 값 추출
            const tokens = this.viewer?.extractLotTokensFromPath?.(path);
            if (!tokens) {
                failCount++;
                failedPaths.push({ path, reason: '경로 파싱 실패' });
                continue;
            }
            
            const root = tokens.root || tokens.lotValue || '';
            const wafer = tokens.wafer || '';
            
            // 중복 체크
            let isDuplicate = false;
            if (this.activeMode === 'lot') {
                // LOT Tab: root만 체크
                isDuplicate = existingKeys.has(root);
            } else {
                // Wafer Tab: root + wafer 조합 체크
                if (root && wafer) {
                    isDuplicate = existingKeys.has(`${root}_${wafer}`);
                } else if (!wafer) {
                    // Wafer 값이 없으면 실패로 처리
                    failCount++;
                    const filename = path.split('/').pop() || path.split('\\').pop() || path;
                    failedPaths.push({ path: filename, reason: 'Wafer Tab에는 파일명이 LOT_STEP_WAFER 형식이어야 합니다 (현재: Wafer 값 없음)' });
                    continue;
                }
            }
            
            if (isDuplicate) {
                duplicateCount++;
                duplicatePaths.push(path);
                continue;
            }
            
            // value는 백엔드에서 path를 파싱하므로 파일명 사용 (백엔드 호환성)
            const filename = tokens.filename || path.split('/').pop() || path.split('\\').pop() || '';
            if (!filename) {
                failCount++;
                failedPaths.push({ path, reason: '파일명 추출 실패' });
                continue;
            }
            
            try {
                const res = await fetch('/api/my-lot', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mode: this.activeMode,
                        group: this.activeGroup,
                        value: filename, // 백엔드에서 path를 파싱하므로 파일명 전달
                        path: path,
                    }),
                });
                if (!res.ok) {
                    const errorText = await this.parseErrorResponse(res);
                    if (errorText.includes('이미 등록된 항목')) {
                        duplicateCount++;
                        duplicatePaths.push(path);
                    } else {
                        failCount++;
                        const filename = path.split('/').pop() || path.split('\\').pop() || path;
                        failedPaths.push({ path: filename, reason: errorText || '서버 오류' });
                    }
                } else {
                    successCount++;
                    // 성공한 항목을 existingKeys에 추가 (같은 배치 내 중복 방지)
                    if (this.activeMode === 'lot') {
                        existingKeys.add(root);
                    } else {
                        existingKeys.add(`${root}_${wafer}`);
                    }
                }
            } catch (error) {
                console.error('[MyLotModal] addMultipleEntries failed for path:', path, error);
                failCount++;
                const filename = path.split('/').pop() || path.split('\\').pop() || path;
                failedPaths.push({ path: filename, reason: error?.message || '네트워크 오류' });
            }
        }
        
        // 결과 메시지 표시
        await this.refreshData();
        this.renderGroups();
        this.renderEntries();
        
        const messages = [];
        if (successCount > 0) messages.push(`${successCount}개 저장`);
        if (duplicateCount > 0) {
            const modeText = this.activeMode === 'lot' ? 'LOT' : 'LOT+Wafer';
            messages.push(`${duplicateCount}개 중복 (${modeText} 기준)`);
        }
        if (failCount > 0) {
            messages.push(`${failCount}개 실패`);
            // Wafer Tab에서 실패한 경우 더 자세한 메시지 표시
            if (this.activeMode === 'wafer' && failedPaths.length > 0) {
                const waferFailures = failedPaths.filter(f => f.reason.includes('Wafer'));
                if (waferFailures.length > 0) {
                    console.warn('[MyLotModal] Wafer Tab 등록 실패:', waferFailures);
                    // 첫 번째 실패 사례를 메시지에 포함
                    const firstFailure = waferFailures[0];
                    this.viewer?.showToast?.(`${failCount}개 실패: ${firstFailure.reason}`, 5000);
                } else {
                    this.viewer?.showToast?.(messages.join(', '), 3000);
                }
            } else {
                this.viewer?.showToast?.(messages.join(', '), 3000);
            }
        } else if (messages.length > 0) {
            this.viewer?.showToast?.(messages.join(', '), 3000);
        } else {
            this.viewer?.showToast?.('저장 완료', 1600);
        }
        
        // 대기 중인 경로 초기화
        this.pendingPaths = [];
        this.updatePendingButtonVisibility();
    }

    /**
     * 대기 중인 경로들을 저장 (Context Menu에서 호출된 항목들)
     */
    async handleSavePending() {
        if (this.pendingPaths.length === 0) {
            this.viewer?.showToast?.('저장할 항목이 없습니다.', 1800);
            return;
        }
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }
        
        await this.addMultipleEntries(this.pendingPaths);
    }

    /**
     * 대기 중인 항목 저장 버튼 표시/숨김 업데이트
     */
    updatePendingButtonVisibility() {
        if (this.savePendingBtn) {
            if (this.pendingPaths && this.pendingPaths.length > 0) {
                this.savePendingBtn.style.display = 'block';
                this.savePendingBtn.textContent = `선택 항목 저장 (${this.pendingPaths.length}개)`;
            } else {
                this.savePendingBtn.style.display = 'none';
            }
        }
    }
}
