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
        this.deleteGroupBtn = document.getElementById('my-lot-delete-group-btn');
        this.saveBtn = document.getElementById('my-lot-save-btn');
        this.savePendingBtn = document.getElementById('my-lot-save-pending-btn');
        this.copyLotBtn = document.getElementById('my-lot-copy-lot');
        this.copyWaferBtn = document.getElementById('my-lot-copy-wafer');
        this.copyLotWaferBtn = document.getElementById('my-lot-copy-lot-wafer');
        this.selectAllBtn = document.getElementById('my-lot-select-all');
        this.clearSelectionBtn = document.getElementById('my-lot-clear-selection');
        this.deleteSelectionBtn = document.getElementById('my-lot-delete-selection');
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
        this.updatedGroups = new Set(); // 🔥 세션 당 그룹별 업데이트 여부 추적

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
            const newGroup = this.groupSelect.value || null;
            this.activeGroup = newGroup;
            this.clearSelection(true);
            this.renderEntries();

            // 🔥 그룹 선택 시 해당 그룹만 업데이트 (세션 당 1회)
            if (newGroup && this.activeMode === 'lot' && !this.updatedGroups.has(newGroup)) {
                this.updatedGroups.add(newGroup);
                this.updateGroupEntries(newGroup);
            }
        });
        this.newGroupBtn?.addEventListener('click', () => this.handleCreateGroup());
        this.deleteGroupBtn?.addEventListener('click', () => this.handleDeleteGroup());
        this.saveBtn?.addEventListener('click', () => this.handleSave());
        this.savePendingBtn?.addEventListener('click', () => this.handleSavePending());
        this.copyLotBtn?.addEventListener('click', () => this.copySelection('lot'));
        this.copyWaferBtn?.addEventListener('click', () => this.copySelection('wafer'));
        this.copyLotWaferBtn?.addEventListener('click', () => this.copySelection('lot-wafer'));
        this.selectAllBtn?.addEventListener('click', () => this.selectAllEntries());
        this.clearSelectionBtn?.addEventListener('click', () => this.clearSelection());
        this.deleteSelectionBtn?.addEventListener('click', () => this.handleDeleteSelection());
        this.gridViewBtn?.addEventListener('click', () => this.openSelectionInViewer());

        if (this.entriesContainer) {
            this.entriesContainer.addEventListener('click', (event) => this.handleEntriesClick(event));
            this.entriesContainer.addEventListener('dblclick', (event) => this.handleEntryDoubleClick(event));
            this.entriesContainer.addEventListener('mousedown', (event) => this.handleEntryMouseDown(event));
            this.entriesContainer.addEventListener('mouseover', (event) => this.handleEntryMouseOver(event));
        }
    }

    ensureMyLotPage() {
        if (this.viewer?.ensurePageForRole) {
            this.viewer.ensurePageForRole('mylot');
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
            
            // 처음 드래그 시작할 때 transform 제거하고 hasBeenDragged 설정
            if (!this.windowEl.dataset.hasBeenDragged) {
                this.windowEl.dataset.hasBeenDragged = 'true';
                this.windowEl.style.transform = 'none';
            }
            
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            const newLeft = Math.min(Math.max(10, startLeft + dx), window.innerWidth - 60);
            const newTop = Math.min(Math.max(10, startTop + dy), window.innerHeight - 60);
            this.windowEl.style.left = `${newLeft}px`;
            this.windowEl.style.top = `${newTop}px`;
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
        
        // 처음 열릴 때는 중앙 정렬 유지 (transform 사용)
        if (!this.windowEl.dataset.hasBeenDragged) {
            // 중앙 정렬은 CSS transform으로 처리되므로 여기서는 아무것도 하지 않음
            return;
        }
        
        // 드래그된 경우에만 위치 조정
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
        this.windowEl.style.transform = 'none';
    }

    async open(pendingPaths = null) {
        if (!this.windowEl) return;
        try {
            // 대기 중인 경로 설정
            if (pendingPaths && pendingPaths.length > 0) {
                this.pendingPaths = [...pendingPaths];
            }

            // 🔥 모달 열 때마다 업데이트 상태 초기화 (매번 접속 시 새로 업데이트하도록)
            this.updatedGroups.clear();

            this.windowEl.style.display = 'flex';
            this.windowEl.classList.add('is-open');
            this.ensureWindowBounds();
            document.addEventListener('keydown', this.boundKeyHandler);

            // 캐시된 데이터로 즉시 렌더 (초기에는 빈 상태라도 모달이 바로 뜸)
            const render = () => {
                this.setMode(this.activeMode || "lot");
                this.updateCurrentValues();
                this.updatePendingButtonVisibility();
                this.updateCopyButtonVisibility(); // Tab에 따라 복사 버튼 표시/숨김
            };
            render();

            // 백그라운드로 최신 데이터 갱신
            this.refreshData()
                .then(() => {
                    render();
                })
                .catch((error) => {
                    console.error('[MyLotModal] open refresh failed:', error);
                    this.viewer?.showToast?.('MY LOT 데이터를 불러오지 못했습니다.', 2200);
                });
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
        
        // 기본 옵션 (그룹 선택)
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '그룹 선택';
        this.groupSelect.appendChild(defaultOption);

        if (!groups.length) {
            this.activeGroup = null;
            this.groupSelect.value = '';
            return;
        }

        groups.forEach(group => {
            const option = document.createElement('option');
            option.value = group.name;
            option.textContent = group.name;
            this.groupSelect.appendChild(option);
        });

        // activeGroup이 유효한지 확인
        if (this.activeGroup && !groups.some(group => group.name === this.activeGroup)) {
            this.activeGroup = null;
        }
        
        // activeGroup이 없으면 '그룹 선택' 상태 유지 (자동 선택 제거)
        this.groupSelect.value = this.activeGroup || '';
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

        if (!this.activeGroup) {
            // 그룹 미선택 시 안내 메시지
            const emptyRow = document.createElement('tr');
            const emptyCell = document.createElement('td');
            emptyCell.colSpan = headers.length;
            emptyCell.textContent = '그룹을 선택해주세요.';
            emptyCell.style.textAlign = 'center';
            emptyCell.style.padding = '40px 20px';
            emptyCell.style.color = '#777';
            emptyCell.style.fontSize = '13px';
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
            
            this.currentEntries = [];
            this.clearSelection(true);
            this.updatePreview(null);
            this.updateActionButtonStates();
        } else {
            const group = this.getActiveGroup();
            this.currentEntries = group?.entries ? [...group.entries] : [];
            this.syncSelectionWithEntries();

            if (!this.currentEntries.length) {
                const emptyRow = document.createElement('tr');
                const emptyCell = document.createElement('td');
                emptyCell.colSpan = headers.length;
                emptyCell.textContent = '저장된 항목이 없습니다.';
                emptyCell.style.textAlign = 'center';
                emptyCell.style.padding = '40px 20px';
                emptyCell.style.color = '#777';
                emptyCell.style.fontSize = '13px';
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
        }

        table.appendChild(tbody);
        this.entriesContainer.appendChild(table);

        if (this.activeGroup) {
            this.updateSelectionStyles();
            this.updatePreviewForSelection();
        }
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
        lotCell.style.padding = '6px 10px';
        lotCell.style.color = '#f3f3f3';
        lotCell.style.fontWeight = '500';
        lotCell.style.overflow = 'hidden';
        lotCell.style.textOverflow = 'ellipsis';
        lotCell.style.whiteSpace = 'nowrap';
        lotCell.title = lot || '';
        row.appendChild(lotCell);

        // Wafer 컬럼 (LOT Tab에서는 표시하지 않음)
        if (this.activeMode === 'wafer') {
            const waferCell = document.createElement('td');
            waferCell.textContent = wafer || '-';
            waferCell.style.padding = '6px 10px';
            waferCell.style.color = '#f3f3f3';
            waferCell.style.fontWeight = '500';
            waferCell.style.textAlign = 'center';
            waferCell.style.overflow = 'hidden';
            waferCell.style.textOverflow = 'ellipsis';
            waferCell.style.whiteSpace = 'nowrap';
            waferCell.title = wafer || '';
            row.appendChild(waferCell);
        }

        // 등록일시 컬럼
        const dateCell = document.createElement('td');
        if (entry.saved_at) {
            // saved_at 형식: "yymmdd_HHMMSS" -> "yy-mm-dd HH:MM"로 변환 (초 제거)
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
                    formattedDate = `${year}-${month}-${day} ${hour}:${minute}`;
                }
            }
            dateCell.textContent = formattedDate;
        } else {
            dateCell.textContent = '-';
        }
        dateCell.style.padding = '6px 10px';
        dateCell.style.color = '#999';
        dateCell.style.fontSize = '11px';
        dateCell.style.overflow = 'hidden';
        dateCell.style.textOverflow = 'ellipsis';
        dateCell.style.whiteSpace = 'nowrap';
        row.appendChild(dateCell);

        // 동작 컬럼 - 액션 버튼들
        const actionCell = document.createElement('td');
        actionCell.style.padding = '6px 10px';
        actionCell.style.whiteSpace = 'nowrap';
        const actions = document.createElement('div');
        actions.className = 'my-lot-entry-actions';
        actions.style.display = 'flex';
        actions.style.gap = '4px';
        actions.style.flexWrap = 'nowrap';
        actions.style.justifyContent = 'flex-start';

        const previewBtn = document.createElement('button');
        previewBtn.textContent = '보기';
        previewBtn.dataset.action = 'preview';
        previewBtn.style.minWidth = '42px';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '복사';
        copyBtn.dataset.action = 'copy';
        copyBtn.style.minWidth = '42px';

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '삭제';
        deleteBtn.dataset.action = 'delete';
        deleteBtn.style.minWidth = '42px';

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
        this.ensureMyLotPage();
        if (action === 'preview') {
            // 보기 버튼: LOT 탭일 경우 그리드로 모든 이미지 표시, Wafer 탭일 경우 단일 이미지 표시
            if (this.activeMode === 'lot') {
                // LOT 탭: 해당 LOT의 모든 이미지를 그리드로 표시
                let paths = [];
                if (entry.all_paths && Array.isArray(entry.all_paths)) {
                    paths = entry.all_paths;
                } else if (entry.path) {
                    paths = [entry.path];
                }

                if (paths.length > 0) {
                    if (this.viewer?.showGrid) {
                        this.viewer.showGrid(paths).catch((error) => {
                            console.error('[MyLotModal] showGrid failed:', error);
                            this.viewer?.showToast?.('그리드 표시에 실패했습니다.', 2000);
                        });
                    } else {
                        this.viewer?.showToast?.('그리드 기능을 사용할 수 없습니다.', 2000);
                    }
                } else {
                    this.viewer?.showToast?.('표시할 이미지가 없습니다.', 1700);
                }
            } else {
                // Wafer 탭: 단일 이미지로 표시
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
        this.ensureMyLotPage();
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
        if (this.deleteSelectionBtn) {
            this.deleteSelectionBtn.disabled = !hasSelection;
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
        
        // 🔥 Personal Colors 및 Cache Buster 적용
        const personalizedParams = this.viewer?.getPersonalizedParams?.() || '';
        const cacheBuster = this.viewer?._personalizedColorCacheBuster || Date.now();

        this.previewImage.onload = () => {
            this.previewImage.style.display = 'block';
            this.previewEmpty.style.display = 'none';
        };
        this.previewImage.onerror = () => {
            this.previewImage.style.display = 'none';
            this.previewEmpty.style.display = 'block';
        };
        this.previewImage.src = `${absolutePath}${separator}t=${cacheBuster}${personalizedParams}`;
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
        this.ensureMyLotPage();
        
        let paths = [];

        // 🔥 LOT 탭일 경우: 선택된 LOT 폴더 내 모든 이미지 경로를 표시 (all_paths 사용)
        if (this.activeMode === 'lot') {
            // 선택된 LOT entry들의 all_paths를 모두 수집
            entries.forEach(entry => {
                if (entry.all_paths && Array.isArray(entry.all_paths)) {
                    // LOT 폴더 내 모든 이미지 경로 추가
                    paths.push(...entry.all_paths);
                } else if (entry.path) {
                    // all_paths가 없으면 대표 이미지만 추가 (fallback)
                    paths.push(entry.path);
                }
            });

            console.log(`[MyLotModal] LOT Grid 보기: ${entries.length}개 LOT, 총 ${paths.length}개 이미지 표시`);
        } else {
            // Wafer 탭일 경우: 선택된 항목의 경로만 보여줌
            paths = entries.map(entry => entry.path).filter(Boolean);
        }

        if (!paths.length) {
            this.viewer?.showToast?.('표시할 이미지가 없습니다.', 1700);
            return;
        }
        
        // 1개여도 그리드로 보여달라는 요구사항 반영
        if (this.viewer?.showGrid) {
            await this.viewer.showGrid(paths);
        } else {
            // fallback
             if (paths.length === 1) {
                this.viewer?.loadImage?.(paths[0]);
                return;
            }
        }
    }

    async handleSave() {
        const candidate = this.viewer?.getMyLotCandidate?.();
        if (!candidate || !candidate.path) {
            this.viewer?.showToast?.('현재 이미지를 찾을 수 없습니다.', 1800);
            return;
        }
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }
        
        const lotValue = candidate.lotValue; // getMyLotCandidate에서 lotValue 반환한다고 가정 (안되면 추출)
        let targetLot = lotValue;

        if (!targetLot) {
            // path에서 추출 시도
            const tokens = this.viewer?.extractLotTokensFromPath?.(candidate.path);
            if (tokens && tokens.lotValue) {
                targetLot = tokens.lotValue;
            }
        }

        if (!targetLot) {
            this.viewer?.showToast?.('LOT 정보를 추출할 수 없습니다.', 2000);
            return;
        }

        try {
            // 1. 해당 LOT으로 전체 이미지 검색 (다중 검색 로직 활용)
            this.viewer?.showToast?.(`'${targetLot}' 관련 이미지 검색 중...`, 1500);
            
            const searchParams = new URLSearchParams();
            searchParams.set('lot_multi', targetLot);
            const searchUrl = `/api/search?${searchParams.toString()}`;

            const searchRes = await fetch(searchUrl);
            if (!searchRes.ok) {
                throw new Error(`검색 API 오류: ${searchRes.status}`);
            }

            const searchData = await searchRes.json();
            if (!searchData || !searchData.success || !Array.isArray(searchData.results)) {
                throw new Error('검색 응답 형식이 올바르지 않습니다.');
            }

            const searchResults = searchData.results;
            
            // 🔥 추가: 현재 이미지와 같은 폴더에 있는 이미지들도 수집 (탐색기 폴더 내 이미지 누락 방지)
            const lastSlash = Math.max(candidate.path.lastIndexOf('/'), candidate.path.lastIndexOf('\\'));
            if (lastSlash > 0) {
                const folderPath = candidate.path.substring(0, lastSlash);
                try {
                    const filesRes = await fetch(`/api/files?path=${encodeURIComponent(folderPath)}`);
                    if (filesRes.ok) {
                        const filesData = await filesRes.json();
                        if (filesData.items && Array.isArray(filesData.items)) {
                            const folderImages = filesData.items
                                .filter(item => item.type === 'file' && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(item.name))
                                .map(item => item.path || `${folderPath}/${item.name}`);
                            
                            if (folderImages.length > 0) {
                                searchResults.push(...folderImages);
                                console.log(`[MyLotModal] 같은 폴더 이미지 ${folderImages.length}개 추가`);
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[MyLotModal] 폴더 검색 실패:', e);
                }
            }
            
            if (searchResults.length === 0) {
                // 검색 결과가 없으면 현재 페이지만이라도 저장 시도 (fallback)
                console.warn('[MyLotModal] LOT 검색 결과 없음, 단일 이미지 저장 시도');
                searchResults.push(candidate.path);
            } else {
                console.log(`[MyLotModal] LOT 검색 완료: ${searchResults.length}개 이미지 발견`);
            }

            // 2. 검색된 이미지 일괄 저장 (batch API)
            const res = await fetch('/api/my-lot/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode, // 현재 탭 모드 (lot/wafer)
                    group: this.activeGroup,
                    paths: searchResults,
                }),
            });

            if (!res.ok) {
                const errorText = await this.parseErrorResponse(res);
                throw new Error(errorText);
            }
            
            const result = await res.json();

            await this.refreshData();
            this.renderEntries();
            
            // 결과 메시지
            const messages = [];
            if (result.success_count > 0) messages.push(`${result.success_count}개 저장`);
            if (result.duplicate_count > 0) messages.push(`${result.duplicate_count}개 중복`);
            
            this.viewer?.showToast?.(`'${targetLot}' 저장 완료: ${messages.join(', ')}`, 2500);

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

    async handleDeleteGroup() {
        if (!this.activeGroup) {
            this.viewer?.showToast?.('삭제할 그룹을 선택해주세요.', 1800);
            return;
        }
        if (!confirm(`"${this.activeGroup}" 그룹과 모든 항목을 삭제할까요?`)) {
            return;
        }
        try {
            const res = await fetch('/api/my-lot/group', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }
            await this.refreshData();
            this.activeGroup = null;
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('그룹을 삭제했습니다.', 1600);
        } catch (error) {
            console.error('[MyLotModal] delete group failed:', error);
            const message = error?.message || '그룹 삭제에 실패했습니다.';
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

    async handleDeleteSelection() {
        if (!this.activeGroup) {
            this.viewer?.showToast?.('그룹을 선택해주세요.', 1800);
            return;
        }
        const entries = this.getSelectedEntries();
        if (!entries.length) {
            this.viewer?.showToast?.('선택된 항목이 없습니다.', 1700);
            return;
        }
        if (!confirm(`선택한 ${entries.length}개 항목을 삭제할까요?`)) {
            return;
        }
        try {
            // 파일명 목록 추출
            const filenames = entries.map(entry => entry.value || entry.filename).filter(Boolean);
            if (!filenames.length) {
                this.viewer?.showToast?.('삭제할 파일명이 없습니다.', 1800);
                return;
            }

            // batch delete API 호출
            const res = await fetch('/api/my-lot/batch', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                    filenames: filenames,
                }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }

            const result = await res.json();
            await this.refreshData();
            this.clearSelection(true);
            this.renderGroups();
            this.renderEntries();

            const messages = [];
            if (result.success_count > 0) messages.push(`${result.success_count}개 삭제`);
            if (result.error_count > 0) messages.push(`${result.error_count}개 실패`);

            if (messages.length > 0) {
                this.viewer?.showToast?.(messages.join(', '), 2000);
            } else {
                this.viewer?.showToast?.('삭제 완료', 1600);
            }
        } catch (error) {
            console.error('[MyLotModal] delete selection failed:', error);
            const message = error?.message || '선택 항목 삭제에 실패했습니다.';
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

        try {
            let finalPaths = [];

            if (this.activeMode === 'lot') {
                // LOT Tab: 검색을 통해 각 LOT의 모든 이미지 찾기
                const lotSet = new Set();

                // 선택한 이미지에서 LOT 값 추출
                for (const path of paths) {
                    const tokens = this.viewer?.extractLotTokensFromPath?.(path);
                    if (tokens && tokens.lotValue) {
                        lotSet.add(tokens.lotValue);
                    }
                }

                if (lotSet.size === 0) {
                    this.viewer?.showToast?.('LOT 정보를 추출할 수 없습니다.', 1800);
                    return;
                }

                const lotList = Array.from(lotSet);
                this.viewer?.showToast?.(`${lotList.length}개 LOT 검색 중...`, 2000);

                // 서버 검색 API 호출 (lot_multi 파라미터 사용)
                const searchParams = new URLSearchParams();
                searchParams.set('lot_multi', lotList.join(','));
                const searchUrl = `/api/search?${searchParams.toString()}`;

                const searchRes = await fetch(searchUrl);
                if (!searchRes.ok) {
                    throw new Error(`검색 API 오류: ${searchRes.status}`);
                }

                const searchData = await searchRes.json();
                if (!searchData || !searchData.success || !Array.isArray(searchData.results)) {
                    throw new Error('검색 응답 형식이 올바르지 않습니다.');
                }

                finalPaths = searchData.results;

                if (finalPaths.length === 0) {
                    this.viewer?.showToast?.('검색된 이미지가 없습니다.', 1800);
                    return;
                }

                console.log(`[MyLotModal] LOT 검색 완료: ${lotList.length}개 LOT, ${finalPaths.length}개 이미지`);

            } else {
                // Wafer Tab: 선택한 이미지만 중복 제거하여 저장
                const uniquePaths = [];
                const seen = new Set();

                for (const path of paths) {
                    const tokens = this.viewer?.extractLotTokensFromPath?.(path);
                    if (!tokens) {
                        continue;
                    }

                    // Wafer Tab: LOT + Wafer 조합으로 중복 제거
                    const key = `${tokens.lotValue || ''}_${tokens.waferValue || ''}`;

                    if (key && !seen.has(key)) {
                        seen.add(key);
                        uniquePaths.push(path);
                    }
                }

                finalPaths = uniquePaths;
            }

            if (finalPaths.length === 0) {
                this.viewer?.showToast?.('추가할 항목이 없습니다.', 1800);
                return;
            }

            // batch API 사용하여 일괄 등록
            const res = await fetch('/api/my-lot/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                    paths: finalPaths,
                }),
            });

            if (!res.ok) {
                const errorText = await this.parseErrorResponse(res);
                throw new Error(errorText);
            }

            const result = await res.json();

            // 결과 메시지 표시
            await this.refreshData();
            this.renderGroups();
            this.renderEntries();

            const messages = [];
            if (result.success_count > 0) messages.push(`${result.success_count}개 저장`);
            if (result.duplicate_count > 0) messages.push(`${result.duplicate_count}개 중복`);
            if (result.error_count > 0) {
                messages.push(`${result.error_count}개 실패`);
                if (result.errors && result.errors.length > 0) {
                    console.warn('[MyLotModal] 일괄 등록 오류:', result.errors);
                }
            }

            if (messages.length > 0) {
                this.viewer?.showToast?.(messages.join(', '), 3000);
            } else {
                this.viewer?.showToast?.('저장 완료', 1600);
            }

        } catch (error) {
            console.error('[MyLotModal] addMultipleEntries failed:', error);
            const message = error?.message || 'MY LOT 일괄 등록에 실패했습니다.';
            this.viewer?.showToast?.(message, 3000);
        } finally {
            // 대기 중인 경로 초기화
            this.pendingPaths = [];
            this.updatePendingButtonVisibility();
        }
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
                // mode 기반 중복 제거 후 실제 저장될 개수 계산
                const uniqueCount = this.calculateUniqueCount(this.pendingPaths);
                this.savePendingBtn.style.display = 'block';
                this.savePendingBtn.textContent = `선택 항목 저장 (${uniqueCount}개)`;
            } else {
                this.savePendingBtn.style.display = 'none';
            }
        }
    }

    /**
     * mode 기반 중복 제거 후 실제 개수 계산
     * @param {Array<string>} paths 경로 배열
     * @returns {number} 중복 제거된 개수
     */
    calculateUniqueCount(paths) {
        if (!paths || paths.length === 0) {
            return 0;
        }

        const seen = new Set();
        for (const path of paths) {
            const tokens = this.viewer?.extractLotTokensFromPath?.(path);
            if (!tokens) {
                continue;
            }

            let key;
            if (this.activeMode === 'lot') {
                // LOT Tab: LOT 값으로 중복 제거
                key = tokens.lotValue || '';
            } else {
                // Wafer Tab: LOT + Wafer 조합으로 중복 제거
                key = `${tokens.lotValue || ''}_${tokens.waferValue || ''}`;
            }

            if (key) {
                seen.add(key);
            }
        }

        return seen.size;
    }

    /**
     * 특정 그룹의 LOT 항목들을 업데이트 (단일 그룹 대상)
     * @param {string} groupName 업데이트할 그룹 이름
     */
    async updateGroupEntries(groupName) {
        if (!groupName) return;

        try {
            const modeData = this.getModeData();
            const groups = modeData.groups || [];
            const group = groups.find(g => g.name === groupName);

            if (!group || !group.entries || group.entries.length === 0) {
                return;
            }

            // 해당 그룹의 LOT 값들 추출
            const groupLots = new Set();
            group.entries.forEach(entry => {
                const { lot } = splitLotWaferValue(entry.value || entry.filename || '');
                if (lot) {
                    groupLots.add(lot);
                }
            });

            if (groupLots.size === 0) {
                return;
            }

            // 서버 검색 API 호출 (lot_multi 파라미터 사용)
            const lotList = Array.from(groupLots);
            const searchParams = new URLSearchParams();
            searchParams.set('lot_multi', lotList.join(','));
            const searchUrl = `/api/search?${searchParams.toString()}`;

            const searchRes = await fetch(searchUrl);
            if (!searchRes.ok) {
                throw new Error(`검색 API 오류: ${searchRes.status}`);
            }

            const searchData = await searchRes.json();
            if (!searchData || !searchData.success || !Array.isArray(searchData.results)) {
                throw new Error('검색 응답 형식이 올바르지 않습니다.');
            }

            const searchResults = searchData.results;
            if (searchResults.length === 0) {
                return;
            }

            // batch API로 업데이트 (기존 항목 덮어쓰기)
            const res = await fetch('/api/my-lot/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'lot',
                    group: groupName,
                    paths: searchResults,
                }),
            });

            if (!res.ok) {
                throw new Error(`그룹 "${groupName}" 업데이트 실패: ${res.status}`);
            }

            const result = await res.json();
            console.log(`[MyLotModal] 그룹 "${groupName}" 업데이트: ${result.success_count || 0}개 성공`);

            // 데이터 새로고침 및 UI 업데이트 (현재 보고 있는 그룹일 경우에만)
            if (this.activeGroup === groupName) {
                await this.refreshData();
                this.renderEntries();
            } else {
                // 백그라운드에서 데이터만 갱신
                await this.refreshData();
            }
        } catch (error) {
            console.error(`[MyLotModal] 그룹 "${groupName}" 업데이트 실패:`, error);
        }
    }
}
