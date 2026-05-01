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

    // 🔥 Wafer 추출 개선: parts[2] 우선, 없으면 W로 시작하는 부분 찾기
    let wafer = "";
    if (parts.length > 2) {
        wafer = parts[2];
    } else if (parts.length > 1) {
        // parts[2]가 없으면 W로 시작하는 부분을 역순으로 찾기 (예: ABC123_W01 → W01)
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (part && (part[0] === 'W' || part[0] === 'w')) {
                wafer = part;
                break;
            }
        }
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
        this.renameGroupBtn = document.getElementById('my-lot-rename-group-btn');
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
        this.manualAddRowBtn = document.getElementById('my-lot-manual-add-row');
        this.manualDeleteRowBtn = document.getElementById('my-lot-manual-delete-row');
        this.manualSubmitBtn = document.getElementById('my-lot-manual-submit');
        
        this.manualRows = [];
        this.manualSearchTimers = new Map(); // LOT 입력 중 검색 디바운스 타이머
        this.activeManualCell = null; // { rowIndex, cellType: 'lot'|'wafer' }
        this.selectedManualCells = new Set(); // 다중 선택된 셀들 "rowIndex_cellType"
        this.lastManualCellIndex = null; // Shift 범위 선택용
        this.tempGroup = null; // 임시 그룹명 (저장 안 하면 삭제)

        this.data = null;
        this.activeMode = "lot";
        this.activeGroup = null;
        this.selectedKeys = new Set();
        this.currentEntries = [];
        this.lastSelectedIndex = null;
        this.dragSelectActive = false;
        this.pendingPaths = []; // Context Menu에서 추가할 경로들
        this.updatedGroups = new Set(); // 🔥 세션 당 그룹별 업데이트 여부 추적
        this.pendingSearchRows = new Set(); // 🔥 배치 검색 대상 행
        this.batchSearchTimer = null;
        this.batchSearchPromise = null;
        this.batchSearchPromiseResolve = null;

        // 🔥 Excel 스타일 키보드 핸들링
        this.isEditMode = false; // 편집 모드 상태
        
        this.boundKeyHandler = (event) => {
            // 입력 필드에서는 특정 키만 처리
            if (event.target.matches('input, textarea')) {
                if (event.key === 'Escape') {
                    event.target.blur();
                    this.isEditMode = false;
                    return;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.target.blur();
                    this.isEditMode = false;
                    // Enter: 아래 셀로 이동
                    this.moveCellSelection(1, 0);
                    return;
                }
                if (event.key === 'Tab') {
                    event.preventDefault();
                    event.target.blur();
                    this.isEditMode = false;
                    // Tab: 오른쪽 셀로 이동 (Shift+Tab: 왼쪽)
                    this.moveCellSelection(0, event.shiftKey ? -1 : 1);
                    return;
                }
                return; // 다른 키는 input에서 기본 동작
            }
            
            if (event.key === 'Escape') {
                this.close();
                return;
            }

            // 🔥 F2: 편집 모드 진입 (기존 내용 유지)
            if (event.key === 'F2' && this.activeManualCell) {
                event.preventDefault();
                this.isEditMode = true;
                const row = this.manualRows[this.activeManualCell.rowIndex];
                const value = row ? (row[this.activeManualCell.cellType] || '') : '';
                this.startManualCellEdit(value);
                return;
            }

            // 🔥 Arrow Keys: 셀 이동 (Shift: 범위 선택)
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault();
                const dr = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                const dc = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
                this.moveCellSelection(dr, dc, event.shiftKey);
                return;
            }

            // 🔥 Enter: 선택 확정, Shift+Enter: 아래 줄 추가
            if (event.key === 'Enter' && this.activeManualCell) {
                event.preventDefault();
                if (event.shiftKey) {
                    this.moveCellSelection(1, 0);
                }
                // Enter만: 아무 동작 없음 (선택 유지)
                return;
            }

            // 🔥 Tab: 오른쪽 셀로 이동 (Shift+Tab: 왼쪽)
            if (event.key === 'Tab' && this.activeManualCell) {
                event.preventDefault();
                this.moveCellSelection(0, event.shiftKey ? -1 : 1);
                return;
            }

            // 🔥 Ctrl+C: 복사
            if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
                event.preventDefault();
                if (this.selectedManualCells.size > 0) {
                    this.copySelectedManualCells();
                } else {
                    this.handleKeyboardCopy();
                }
                return;
            }

            // 🔥 Ctrl+V: 붙여넣기
            if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
                event.preventDefault();
                this.handleKeyboardPaste();
                return;
            }

            // 🔥 Delete: 선택된 행 삭제
            if (event.key === 'Delete') {
                event.preventDefault();
                if (this.selectedManualCells.size > 0) {
                    this.deleteSelectedManualRows();
                } else {
                    this.handleDeleteSelection();
                }
                return;
            }

            // 🔥 Backspace: 선택된 셀 내용만 삭제
            if (event.key === 'Backspace') {
                event.preventDefault();
                if (this.selectedManualCells.size > 0) {
                    this.deleteSelectedManualCells();
                }
                return;
            }

            // 🔥 문자 입력: 기존 내용 지우고 편집 모드 (Excel처럼)
            if (this.activeManualCell && !event.ctrlKey && !event.metaKey && !event.altKey) {
                if (event.key.length === 1) {
                    event.preventDefault();
                    this.isEditMode = true;
                    this.startManualCellEdit(event.key);
                    return;
                }
            }
        };
        this.boundWindowResize = () => this.ensureWindowBounds();
        this.boundStopDragSelection = () => this.stopDragSelection();

        this.bindEvents();
        this.setupDragging();
        window.addEventListener('resize', this.boundWindowResize);
        document.addEventListener('mouseup', this.boundStopDragSelection);

        // 🔥 모달 오픈 시 딜레이를 없애기 위해 데이터 미리 불러오기
        this.refreshData().catch(err => console.warn('[MyLotModal] prefetch failed:', err));
    }

    /** LoginId URL 파라미터 반환 (SAML 로그인 사용자 식별용) */
    get _loginParam() {
        const id = String(this.viewer?.getCurrentLoginId?.() || this.viewer?.currentUser || '').trim();
        if (!id) return '';
        return `?LoginId=${encodeURIComponent(id)}`;
    }

    /** LoginId를 URL에 추가 (기존 쿼리스트링 고려) */
    _withLogin(url) {
        // SAML 리다이렉트 URL의 LoginId를 우선 사용 (viewer 초기화 전에도 실제 ID 전달)
        const urlLoginId = new URLSearchParams(window.location.search).get('LoginId');
        const viewerId = String(this.viewer?.getCurrentLoginId?.() || this.viewer?.currentUser || '').trim();
        const invalidIds = {'': 1, 'guest': 1, 'notsaml': 1, 'default': 1, 'anon': 1, 'anonymous': 1};
        const id = (viewerId && !invalidIds[viewerId]) ? viewerId : (urlLoginId || viewerId);
        if (!id) return url;
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}LoginId=${encodeURIComponent(id)}`;
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
        this.groupSelect?.addEventListener('change', async () => {
            const newGroup = this.groupSelect.value || null;
            
            // 그룹 변경 시 임시 그룹 삭제
            await this.deleteTempGroupIfExists();
            
            this.activeGroup = newGroup;
            this.clearSelection(true);
            // 그룹 변경 시 임시 입력 초기화
            this.manualRows = [];
            this.manualSearchTimers.clear();
            this.activeManualCell = null;
            this.selectedManualCells.clear();
            this.lastManualCellIndex = null;

            // 선택한 그룹의 엔트리만 서버에서 로드 후 렌더링
            await this.loadActiveGroupEntriesAndRender();
        });
        this.newGroupBtn?.addEventListener('click', () => this.handleCreateGroup());
        this.renameGroupBtn?.addEventListener('click', () => this.handleRenameGroup());
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
        this.manualAddRowBtn?.addEventListener('click', () => this.addManualRow());
        this.manualDeleteRowBtn?.addEventListener('click', () => this.deleteManualRow());
        this.manualSubmitBtn?.addEventListener('click', () => this.handleManualSubmit());

        if (this.entriesContainer) {
            this.entriesContainer.addEventListener('click', (event) => this.handleEntriesClick(event));
            this.entriesContainer.addEventListener('dblclick', (event) => this.handleEntryDoubleClick(event));
            this.entriesContainer.addEventListener('mousedown', (event) => this.handleEntryMouseDown(event));
            this.entriesContainer.addEventListener('mouseover', (event) => this.handleEntryMouseOver(event));
        }
    }

    ensureMyLotPage() {
        if (this.viewer?.ensurePageForRole) {
            const forceNew = this.viewer.activePageRole !== 'mylot';
            this.viewer.ensurePageForRole('mylot', { forceNew, skipPersist: true });
        }
    }

    ensureManualRows(reset = false) {
        if (reset) {
            this.manualRows = [];
            this.manualSearchTimers.clear();
        }
    }

    async addManualRow() {
        // 그룹이 선택되지 않았으면 임시 그룹 생성
        if (!this.activeGroup) {
            await this.createTempGroup();
        }
        this.manualRows.push({ lot: '', wafer: '' });
        const newIndex = this.manualRows.length - 1;
        this.activeManualCell = { rowIndex: newIndex, cellType: 'lot' };
        this.selectedManualCells.clear();
        this.selectedManualCells.add(`${newIndex}_lot`);
        this.lastManualCellIndex = newIndex;
        this.renderEntries();
        
        // 🔥 셀 선택만 (파란색 테두리), 문자 입력 시 편집 모드 진입
        requestAnimationFrame(() => {
            this.updateManualCellStyles();
        });
    }

    deleteManualRow() {
        if (this.manualRows.length === 0) return;

        // 선택된 셀이 있으면 해당 행 삭제, 없으면 마지막 행 삭제
        const selectedRowIndices = new Set();
        if (this.selectedManualCells.size > 0) {
            for (const key of this.selectedManualCells) {
                const idx = parseInt(key.split('_')[0], 10);
                if (!isNaN(idx)) selectedRowIndices.add(idx);
            }
        } else if (this.activeManualCell) {
            selectedRowIndices.add(this.activeManualCell.rowIndex);
        }

        if (selectedRowIndices.size > 0) {
            // 인덱스를 역순으로 삭제 (앞 인덱스 영향 방지)
            const sorted = Array.from(selectedRowIndices).sort((a, b) => b - a);
            for (const idx of sorted) {
                if (idx >= 0 && idx < this.manualRows.length) {
                    this.manualRows.splice(idx, 1);
                }
            }
        } else {
            this.manualRows.pop();
        }

        this.manualSearchTimers.clear();
        this.activeManualCell = null;
        this.selectedManualCells.clear();
        this.lastManualCellIndex = null;
        this.renderEntries();
    }

    /**
     * 🔥 클립보드 붙여넣기 (Excel 스타일)
     * - 선택된 셀이 있으면 그 다음 행부터 추가
     * - 기존 행이 있으면 그 뒤에 추가 (덮어쓰기 X)
     */
    async handleManualPaste(text, clearExisting = false) {
        const lines = (text || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        if (!lines.length) return;
        
        // 현재 시간
        const now = new Date();
        const timestamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        
        if (clearExisting) {
            this.manualRows = [];
        }
        this.manualSearchTimers.clear();
        
        // 🔥 선택된 셀이 있으면 그 다음 행부터 추가 (기존 행 유지)
        let insertIndex = this.manualRows.length; // 기본: 맨 끝
        if (this.activeManualCell) {
            // 선택된 셀의 다음 행부터 삽입
            insertIndex = this.activeManualCell.rowIndex + 1;
        }
        
        // 🔥 기존 행의 키 수집 (중복 제거용)
        const existingKeys = new Set();
        for (const row of this.manualRows) {
            if (row.lot) {
                const key = this.activeMode === 'wafer'
                    ? `${row.lot.trim().toLowerCase()}_${(row.wafer || '').trim().toLowerCase()}`
                    : row.lot.trim().toLowerCase();
                existingKeys.add(key);
            }
        }

        const newRowIndices = [];
        let dupSkipped = 0;
        let offsetAdjust = 0;
        lines.forEach((line) => {
            const parts = line.split(/\t|\s+/).map(p => p.trim()).filter(Boolean);
            const lot = (parts[0] || '').replace(/\..+$/, '');
            const wafer = parts.length > 1 ? (parts[1] || '').replace(/\..+$/, '') : '';
            if (!lot) return;

            // 중복 체크
            const key = this.activeMode === 'wafer'
                ? `${lot.toLowerCase()}_${wafer.toLowerCase()}`
                : lot.toLowerCase();
            if (existingKeys.has(key)) {
                dupSkipped++;
                return;
            }
            existingKeys.add(key);

            // LOT 모드에서는 wafer 값 무시 (LOT 단위 관리이므로 wafer 필터 불필요)
            const rowWafer = this.activeMode === 'wafer' ? wafer : '';
            const newRow = { lot, wafer: rowWafer, saved_at: timestamp, path: null, searchResults: [] };

            // 🔥 기존 행 사이에 삽입
            const targetIndex = insertIndex + offsetAdjust;
            this.manualRows.splice(targetIndex, 0, newRow);
            newRowIndices.push(targetIndex);
            offsetAdjust++;
        });
        if (dupSkipped > 0) {
            this.viewer?.showToast?.(`${dupSkipped}개 중복 항목 제외됨`, 1500);
        }
        
        this.renderEntries();
        
        // 새로 붙여넣은 첫 행을 활성 셀로 설정
        if (newRowIndices.length > 0) {
            this.activeManualCell = { rowIndex: newRowIndices[0], cellType: 'lot' };
            this.selectedManualCells.clear();
            // 모든 새 행 선택
            newRowIndices.forEach(idx => this.selectedManualCells.add(`${idx}_lot`));
            this.lastManualCellIndex = newRowIndices[newRowIndices.length - 1];
            this.updateManualCellStyles();
            this.updateManualRowPreview(newRowIndices[0]);
        }
        
        // 🔥🔥🔥 배치 검색: 모든 LOT을 한번에 검색하여 초고속 처리
        this.viewer?.showToast?.(`${newRowIndices.length}개 LOT 검색 중...`, 1500);
        
        // 검색할 행 정보 수집
        const searchRows = newRowIndices.map(rowIndex => ({
            rowIndex,
            lot: this.manualRows[rowIndex]?.lot || '',
            wafer: this.manualRows[rowIndex]?.wafer || ''
        })).filter(r => r.lot);

        if (searchRows.length > 0) {
            // 한번의 API 호출로 모든 LOT 검색
            const resultMap = await this.searchImagesByLotsBatch(searchRows);
            
            // 결과를 각 행에 적용
            let totalFound = 0;
            for (const [rowIndex, result] of resultMap) {
                if (this.manualRows[rowIndex]) {
                    this.manualRows[rowIndex].searchResults = result.paths;
                    this.manualRows[rowIndex].path = result.previewPath;
                    totalFound += result.paths.length;
                }
            }
            
            this.viewer?.showToast?.(`검색 완료: ${totalFound}개 이미지 발견`, 2000);
        } else {
            this.viewer?.showToast?.('검색할 LOT이 없습니다.', 1500);
        }
        
        this.renderEntries(); // 검색 결과 개수 반영
    }
    
    handleManualCellClick(rowIndex, cellType, event) {
        const cellKey = `${rowIndex}_${cellType}`;
        
        // Shift 클릭 시 텍스트 선택 방지
        if (event.shiftKey) {
            event.preventDefault();
        }
        
        if (event.ctrlKey || event.metaKey) {
            // Ctrl 클릭: 토글 선택
            if (this.selectedManualCells.has(cellKey)) {
                this.selectedManualCells.delete(cellKey);
            } else {
                this.selectedManualCells.add(cellKey);
            }
            this.lastManualCellIndex = rowIndex;
        } else if (event.shiftKey && this.lastManualCellIndex !== null) {
            // Shift 클릭: 범위 선택
            this.selectedManualCells.clear();
            const start = Math.min(this.lastManualCellIndex, rowIndex);
            const end = Math.max(this.lastManualCellIndex, rowIndex);
            for (let i = start; i <= end; i++) {
                this.selectedManualCells.add(`${i}_${cellType}`);
            }
        } else {
            // 일반 클릭: 단일 선택
            this.selectedManualCells.clear();
            this.selectedManualCells.add(cellKey);
            this.lastManualCellIndex = rowIndex;
        }
        
        this.activeManualCell = { rowIndex, cellType };
        this.updateManualCellStyles();
        
        // 🔥 미리보기 업데이트: 해당 행의 이미지 표시
        this.updateManualRowPreview(rowIndex);
    }

    findManualRowByEntry(entry) {
        if (!entry) return null;
        const lot = (entry.lot || '').trim();
        const wafer = (entry.wafer || '').trim();
        if (!lot) return null;
        const key = this.activeMode === 'wafer' ? `${lot}_${wafer}` : lot;
        return this.manualRows.find(row => {
            const rLot = (row.lot || '').trim();
            const rWafer = (row.wafer || '').trim();
            const rKey = this.activeMode === 'wafer' ? `${rLot}_${rWafer}` : rLot;
            return rKey === key;
        }) || null;
    }

    /**
     * 🔥 Excel 스타일 셀 이동 (Arrow keys, Enter, Tab)
     * @param {number} dr 행 이동 (-1: 위, 1: 아래)
     * @param {number} dc 열 이동 (-1: 왼쪽, 1: 오른쪽)
     * @param {boolean} extendSelection Shift 누른 상태 (범위 선택)
     */
    moveCellSelection(dr, dc, extendSelection = false) {
        // 🔥 manualRows가 비어있으면 새 행 추가
        if (this.manualRows.length === 0) {
            this.manualRows.push({ lot: '', wafer: '', searchResults: [] });
        }
        
        // 셀이 선택되지 않았으면 첫 번째 셀 선택
        if (!this.activeManualCell) {
            this.activeManualCell = { rowIndex: 0, cellType: 'lot' };
            this.selectedManualCells.clear();
            this.selectedManualCells.add('0_lot');
            this.lastManualCellIndex = 0;
            this.renderEntries();
            requestAnimationFrame(() => this.updateManualCellStyles());
            return;
        }
        
        let { rowIndex, cellType } = this.activeManualCell;
        const cellTypes = this.activeMode === 'wafer' ? ['lot', 'wafer'] : ['lot'];
        let colIndex = cellTypes.indexOf(cellType);
        
        // 새 위치 계산
        let newRow = rowIndex + dr;
        let newCol = colIndex + dc;
        
        // 열 범위 벗어나면 행 이동
        if (newCol < 0) {
            newCol = cellTypes.length - 1;
            newRow--;
        } else if (newCol >= cellTypes.length) {
            newCol = 0;
            newRow++;
        }
        
        // 행 범위 체크
        if (newRow < 0) newRow = 0;
        
        let needsRerender = false;
        if (newRow >= this.manualRows.length) {
            // 마지막 행 넘어가면 새 행 추가
            if (dr > 0) {
                this.manualRows.push({ lot: '', wafer: '', searchResults: [] });
                needsRerender = true;
            } else {
                newRow = this.manualRows.length - 1;
            }
        }
        
        const newCellType = cellTypes[newCol];
        const newCellKey = `${newRow}_${newCellType}`;
        
        if (extendSelection) {
            // Shift 범위 선택
            this.selectedManualCells.add(newCellKey);
        } else {
            // 단일 선택
            this.selectedManualCells.clear();
            this.selectedManualCells.add(newCellKey);
            this.lastManualCellIndex = newRow;
        }
        
        this.activeManualCell = { rowIndex: newRow, cellType: newCellType };
        
        if (needsRerender) {
            this.renderEntries();
            // 🔥 renderEntries 후 셀 스타일 업데이트
            requestAnimationFrame(() => this.updateManualCellStyles());
        } else {
            this.updateManualCellStyles();
        }
        
        this.updateManualRowPreview(newRow);
    }

    updateManualCellStyles() {
        // 모든 수동 입력 행의 셀에서 선택 스타일 제거
        const inputRows = this.entriesContainer?.querySelectorAll('.my-lot-input-row');
        if (!inputRows) return;
        
        inputRows.forEach(row => {
            row.querySelectorAll('td[data-cell-type]').forEach(cell => {
                cell.style.outline = '';
                cell.style.outlineOffset = '';
                cell.style.backgroundColor = '';
            });
        });
        
        // 🔥 선택된 셀: 파란색 테두리만 (Excel 스타일)
        this.selectedManualCells.forEach(cellKey => {
            const [rowIndex, cellType] = cellKey.split('_');
            const targetRow = Array.from(inputRows).find(
                row => Number(row.dataset.manualIndex) === Number(rowIndex)
            );
            if (targetRow) {
                const targetCell = targetRow.querySelector(`td[data-cell-type="${cellType}"]`);
                if (targetCell) {
                    // 활성 셀만 진한 파란색 테두리
                    const isActive = this.activeManualCell && 
                        this.activeManualCell.rowIndex === Number(rowIndex) &&
                        this.activeManualCell.cellType === cellType;
                    
                    targetCell.style.outline = isActive ? '2px solid #3b82f6' : '1px solid #60a5fa';
                    targetCell.style.outlineOffset = '-1px';
                    // 배경색 없음 (파란색 테두리만)
                }
            }
        });
    }

    /**
     * 🔥 수동 입력 행의 미리보기 업데이트
     */
    updateManualRowPreview(rowIndex) {
        if (rowIndex < 0 || rowIndex >= this.manualRows.length) {
            return;
        }
        
        const row = this.manualRows[rowIndex];
        if (!row) {
            return;
        }
        
        // path가 있고 placeholder가 아니면 미리보기 표시
        if (row.path && !row.path.includes('_placeholders') && !row.path.includes('placeholder.png')) {
            const entry = {
                path: row.path,
                value: row.lot,
                filename: row.lot,
            };
            this.updatePreview(entry);
        } else {
            // 이미지가 없으면 빈 미리보기 표시
            this.updatePreview(null);
        }
    }

    updateManualPreviewForActiveRow() {
        if (!this.manualRows.length) return;
        if (this.selectedKeys && this.selectedKeys.size > 0) return; // 기존 선택 미리보기 우선

        let targetIdx = null;
        if (this.activeManualCell && Number.isInteger(this.activeManualCell.rowIndex)) {
            targetIdx = this.activeManualCell.rowIndex;
        } else if (this.selectedManualCells.size > 0) {
            const first = Array.from(this.selectedManualCells)[0];
            const [rowIndex] = first.split('_');
            targetIdx = Number(rowIndex);
        }

        if (targetIdx != null && targetIdx >= 0 && targetIdx < this.manualRows.length) {
            this.updateManualRowPreview(targetIdx);
        }
    }

    deleteSelectedManualCells() {
        if (this.selectedManualCells.size === 0) return;
        
        this.selectedManualCells.forEach(cellKey => {
            const [rowIndex, cellType] = cellKey.split('_');
            const idx = Number(rowIndex);
            if (this.manualRows[idx]) {
                this.manualRows[idx][cellType] = '';
                // saved_at도 제거
                delete this.manualRows[idx].saved_at;
            }
        });
        
        this.renderEntries();
        this.viewer?.showToast?.(`${this.selectedManualCells.size}개 셀 내용 삭제`, 1500);
    }

    deleteSelectedManualRows() {
        if (this.selectedManualCells.size === 0) return;
        
        // 선택된 셀들의 행 인덱스 추출 (중복 제거)
        const rowIndices = new Set();
        this.selectedManualCells.forEach(cellKey => {
            const [rowIndex] = cellKey.split('_');
            rowIndices.add(Number(rowIndex));
        });
        
        // 인덱스를 내림차순 정렬하여 뒤에서부터 삭제 (인덱스 충돌 방지)
        const sortedIndices = Array.from(rowIndices).sort((a, b) => b - a);
        
        sortedIndices.forEach(idx => {
            if (idx >= 0 && idx < this.manualRows.length) {
                this.manualRows.splice(idx, 1);
            }
        });
        this.manualSearchTimers.clear();
        
        this.selectedManualCells.clear();
        this.activeManualCell = null;
        this.lastManualCellIndex = null;
        this.renderEntries();
        this.viewer?.showToast?.(`${sortedIndices.length}개 행 삭제`, 1500);
    }

    copySelectedManualCells() {
        if (this.selectedManualCells.size === 0) return;
        
        const values = [];
        const sortedCells = Array.from(this.selectedManualCells).sort();
        
        sortedCells.forEach(cellKey => {
            const [rowIndex, cellType] = cellKey.split('_');
            const idx = Number(rowIndex);
            if (this.manualRows[idx]) {
                values.push(this.manualRows[idx][cellType] || '');
            }
        });
        
        const text = values.join('\n');
        this.copyToClipboard(text, `${values.length}개 셀 복사됨`);
    }

    /**
     * 🔥 특정 행/셀 편집 모드 진입 (행 추가 시 자동 호출)
     */
    startManualCellEditByIndex(rowIndex, cellType, initialText = '') {
        this.activeManualCell = { rowIndex, cellType };
        this.selectedManualCells.clear();
        this.selectedManualCells.add(`${rowIndex}_${cellType}`);
        this.updateManualCellStyles();
        this.startManualCellEdit(initialText);
    }

    startManualCellEdit(initialText = '') {
        if (!this.activeManualCell) return;

        const inputRows = this.entriesContainer?.querySelectorAll('.my-lot-input-row');
        if (!inputRows) return;

        const targetRow = Array.from(inputRows).find(
            row => Number(row.dataset.manualIndex) === this.activeManualCell.rowIndex
        );
        if (!targetRow) return;

        const targetCell = targetRow.querySelector(`td[data-cell-type="${this.activeManualCell.cellType}"]`);
        if (!targetCell) return;

        const index = this.activeManualCell.rowIndex;
        const cellType = this.activeManualCell.cellType;

        // input 생성
        const input = document.createElement('input');
        input.type = 'text';
        input.value = initialText;
        input.style.cssText = `
            width: 100%;
            height: 100%;
            background: transparent;
            border: none;
            outline: none;
            color: #f3f3f3;
            padding: 0;
            margin: 0;
            font-size: inherit;
            font-family: inherit;
            caret-color: #3b82f6;
            box-sizing: border-box;
        `;
        input.addEventListener('input', () => {
            this.manualRows[index][cellType] = input.value;
            if (input.value) {
                const now = new Date();
                const year = String(now.getFullYear()).slice(2);
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(now.getDate()).padStart(2, '0');
                const hour = String(now.getHours()).padStart(2, '0');
                const minute = String(now.getMinutes()).padStart(2, '0');
                const second = String(now.getSeconds()).padStart(2, '0');
                this.manualRows[index].saved_at = `${year}${month}${day}_${hour}${minute}${second}`;
                
                // 🔥 즉시 검색 (300ms 디바운스 적용)
                this.scheduleManualRowSearch(index, 300);
            } else {
                delete this.manualRows[index].saved_at;
                if (cellType === 'lot') {
                    this.manualRows[index].path = null;
                    this.manualRows[index].searchResults = [];
                    this.updateManualRowPreview(index);
                }
            }
        });

        targetCell.textContent = '';
        targetCell.appendChild(input);
        input.focus();

        const finishEdit = async () => {
            this.manualRows[index][cellType] = input.value;
            if (input.value) {
                // 입력 시 현재 시간으로 saved_at 설정
                const now = new Date();
                const year = String(now.getFullYear()).slice(2);
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(now.getDate()).padStart(2, '0');
                const hour = String(now.getHours()).padStart(2, '0');
                const minute = String(now.getMinutes()).padStart(2, '0');
                const second = String(now.getSeconds()).padStart(2, '0');
                this.manualRows[index].saved_at = `${year}${month}${day}_${hour}${minute}${second}`;
                
                // 🔥 LOT 또는 Wafer 입력 시 자동으로 이미지 검색
                await this.searchAndUpdateManualRowImage(index);
                this.updateManualRowPreview(index);
            }
            this.renderEntries();
            // 🔥 renderEntries 후 셀 스타일 복원
            requestAnimationFrame(() => this.updateManualCellStyles());
        };

        input.addEventListener('blur', finishEdit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit();
                if (e.shiftKey) {
                    // 🔥 Shift+Enter: 아래 줄 추가하며 내려가기
                    this.moveCellSelection(1, 0);
                }
                // 🔥 Enter만: 수정 완료 (이동 없음)
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                finishEdit();
                // Tab: 오른쪽 셀로 이동
                this.moveCellSelection(0, e.shiftKey ? -1 : 1);
            }
        });
    }

    collectManualEntries() {
        const entries = [];
        this.manualRows.forEach((row) => {
            const lot = (row.lot || '').trim();
            const wafer = (row.wafer || '').trim();
            if (lot || wafer) {
                entries.push({ lot, wafer });
            }
        });
        return entries;
    }

    normalizeManualEntries(entries) {
        const result = [];
        const seen = new Set();
        entries.forEach((entry) => {
            const lot = (entry?.lot || '').trim();
            const wafer = (entry?.wafer || '').trim();
            if (!lot) return;
            const key = this.activeMode === 'wafer' ? `${lot}_${wafer || ''}` : lot;
            if (seen.has(key)) return;
            seen.add(key);
            result.push({ lot, wafer });
        });
        return result;
    }

    getLotsFromPaths(paths = []) {
        const lots = new Set();
        if (!paths || !paths.length) return lots;
        paths.forEach((path) => {
            const tokens = this.viewer?.extractLotTokensFromPath?.(path);
            const filename = (path || '').split(/[\\/]/).pop() || '';
            const parsed = splitLotWaferValue(filename);
            const lot = tokens?.lotValue || parsed.lot;
            const wafer = tokens?.waferValue || parsed.wafer || '';
            if (!lot) return;
            const key = this.activeMode === 'wafer' ? `${lot}_${wafer}` : lot;
            lots.add(key);
        });
        return lots;
    }

    /**
     * 🔥 저장 버튼 클릭 - 검색된 모든 이미지를 my-lot 폴더에 복사 (리팩토링)
     */
    async handleManualSubmit() {
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }

        // 유효한 LOT가 입력된 행만 필터링 + 그룹 내 중복 제거
        const seen = new Set();
        const validRows = [];
        let dupCount = 0;
        for (const row of this.manualRows) {
            if (!row.lot || !row.lot.trim()) continue;
            const key = this.activeMode === 'wafer'
                ? `${row.lot.trim().toLowerCase()}_${(row.wafer || '').trim().toLowerCase()}`
                : row.lot.trim().toLowerCase();
            if (seen.has(key)) {
                dupCount++;
                continue;
            }
            seen.add(key);
            validRows.push(row);
        }
        if (validRows.length === 0) {
            this.viewer?.showToast?.('입력된 내용이 없습니다.', 1800);
            return;
        }
        if (dupCount > 0) {
            console.log(`[MyLotModal] 중복 제거: ${dupCount}개 항목 제외`);
        }

        this.viewer?.showToast?.('저장 중...', 1500);

        try {
            // 🔥 모든 행의 검색 결과 수집 + 파일명 기준 중복 제거 + LOT/Wafer 매핑
            const allPaths = [];
            const pathLotWaferMap = {};  // path → { lot, wafer }
            const rowsWithoutImages = [];
            const seenFilenames = new Set();  // 파일명 기준 중복 제거

            for (const row of validRows) {
                const lot = (row.lot || '').trim();
                const wafer = (row.wafer || '').trim();
                if (row.searchResults && row.searchResults.length > 0) {
                    row.searchResults.forEach(p => {
                        const fname = p.split('/').pop().split('\\').pop();
                        if (seenFilenames.has(fname)) return;
                        seenFilenames.add(fname);
                        allPaths.push(p);
                        pathLotWaferMap[p] = { lot, wafer };
                    });
                } else if (row.path) {
                    const fname = row.path.split('/').pop().split('\\').pop();
                    if (!seenFilenames.has(fname)) {
                        seenFilenames.add(fname);
                        allPaths.push(row.path);
                        pathLotWaferMap[row.path] = { lot, wafer };
                    }
                } else {
                    rowsWithoutImages.push(row);
                }
            }

            let successCount = 0;
            let errors = [];

            // 1. 🔥 검색된 모든 이미지를 my-lot 폴더에 복사 (batch API, 중복 제거 안 함)
            if (allPaths.length > 0) {
                const pathsArray = allPaths;
                console.log(`[MyLotModal] 저장할 이미지: ${pathsArray.length}개`);
                
                const res = await fetch(this._withLogin('/api/my-lot/batch'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mode: this.activeMode,
                        group: this.activeGroup,
                        paths: pathsArray,
                        path_lot_wafer: pathLotWaferMap,
                    }),
                });
                
                if (res.ok) {
                    const result = await res.json();
                    successCount += (result.success_count || 0);
                    if (result.errors && result.errors.length > 0) errors.push(...result.errors);
                    console.log(`[MyLotModal] 이미지 저장 완료: 성공=${result.success_count}, 중복=${result.duplicate_count || 0}`);
                } else {
                    const errorText = await this.parseErrorResponse(res);
                    errors.push({ reason: errorText });
                }
            }

            // 2. 이미지 없는 항목: LOT 폴더만 생성 (manual API)
            if (rowsWithoutImages.length > 0) {
                const promises = rowsWithoutImages.map(row => 
                    fetch(this._withLogin('/api/my-lot/manual'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            mode: this.activeMode,
                            group: this.activeGroup,
                            lot: row.lot,
                            wafer: row.wafer || ""
                        }),
                    }).then(res => {
                        if (res.ok) return { success: true };
                        return res.text().then(text => ({ success: false, error: text }));
                    })
                );
                
                const results = await Promise.all(promises);
                results.forEach(r => {
                    if (r.success) successCount++;
                    else errors.push({ reason: r.error });
                });
            }

            // 결과 처리
            // 임시 그룹에 저장이 완료되었으므로 자동 삭제 대상에서 제외
            this.tempGroup = null;

            // 입력창 초기화
            this.manualRows = [];
            this.activeManualCell = null;
            this.selectedManualCells.clear();
            this.lastManualCellIndex = null;

            // 서버 데이터 동기화 후 엔트리 렌더링
            await this.refreshData();
            await this.loadActiveGroupEntriesAndRender();

            if (errors.length > 0) {
                console.warn('[MyLotModal] 일부 항목 저장 실패:', errors);
                this.viewer?.showToast?.(`${successCount}개 저장됨 (실패 ${errors.length}개)`, 2500);
            } else {
                this.viewer?.showToast?.(`${successCount}개 항목이 저장되었습니다.`, 2000);
            }

        } catch (error) {
            console.error('[MyLotModal] manual submit failed:', error);
            const message = error?.message || '저장에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
        }
    }

    /**
     * 🔥 LOT 값들로 이미지 검색 (리팩토링)
     * @param {Array<string>} lotValues LOT 값 배열
     * @param {string} waferFilter 선택적 Wafer 필터 (있으면 파일명에 포함된 것만 반환)
     * @returns {Promise<Array<string>>} 검색된 이미지 경로 배열
     */
    async searchImagesByLots(lotValues, waferFilter = '') {
        if (!lotValues || lotValues.length === 0) {
            return [];
        }

        // 대소문자 구분 없이 검색
        const normalizedLots = lotValues.map(lot => (lot || '').trim().toLowerCase()).filter(Boolean);
        if (normalizedLots.length === 0) return [];
        
        const searchParams = new URLSearchParams();
        searchParams.set('lot_multi', normalizedLots.join(','));
        searchParams.set('limit', '10000');
        const folderParam = this.viewer?.getSearchFolderParam?.() || '';
        searchParams.set('folder', folderParam);
        const searchUrl = `/api/search?${searchParams.toString()}`;

        console.log(`[MyLotModal] 이미지 검색: LOT=[${normalizedLots.join(', ')}], Wafer=${waferFilter || '없음'}`);

        const searchRes = await fetch(searchUrl);
        if (!searchRes.ok) {
            throw new Error(`검색 API 오류: ${searchRes.status}`);
        }

        const searchData = await searchRes.json();
        if (!searchData || !searchData.success || !Array.isArray(searchData.results)) {
            throw new Error('검색 응답 형식이 올바르지 않습니다.');
        }

        let results = searchData.results;

        // 🔥 Wafer 필터가 있으면 파일명에 wafer 값이 포함된 것만 필터링
        if (waferFilter) {
            const waferLower = waferFilter.trim().toLowerCase();
            results = results.filter(path => {
                const filename = path.split('/').pop().split('\\').pop().toLowerCase();
                return filename.includes(waferLower);
            });
            console.log(`[MyLotModal] Wafer 필터 적용 후: ${results.length}개`);
        }

        console.log(`[MyLotModal] 검색 결과: ${results.length}개`);

        return results;
    }

    extractWaferTokenFromPath(path) {
        const normalizedPath = String(path || '');
        if (!normalizedPath) return '';

        const tokenFromViewer = this.viewer?.extractLotTokensFromPath?.(normalizedPath)?.waferValue;
        if (tokenFromViewer) {
            return String(tokenFromViewer).trim();
        }

        const filename = normalizedPath.split('/').pop()?.split('\\').pop() || '';
        const parsed = splitLotWaferValue(filename);
        if (parsed.wafer) {
            return String(parsed.wafer).trim();
        }

        const m = filename.match(/(?:^|_)(W[0-9A-Z]{1,5})(?:_|\.|$)/i);
        return m ? m[1].toUpperCase() : '';
    }

    buildWaferCandidates(paths = []) {
        const seen = new Map();
        for (const path of paths || []) {
            const wafer = this.extractWaferTokenFromPath(path);
            if (!wafer) continue;
            const key = wafer.toLowerCase();
            if (!seen.has(key)) {
                seen.set(key, wafer);
            }
        }
        return Array.from(seen.values()).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        );
    }

    /**
     * 🔥🔥🔥 다중 LOT 배치 검색 - 모든 LOT을 한번에 검색하여 초고속 처리
     * @param {Array<{lot: string, wafer?: string, rowIndex: number}>} rows 검색할 행 정보
     * @returns {Promise<Map<number, {paths: Array<string>, previewPath: string|null}>>} rowIndex -> 검색 결과 매핑
     */
    async searchImagesByLotsBatch(rows) {
        if (!rows || rows.length === 0) {
            return new Map();
        }

        const uniqueLots = [...new Set(rows.map(r => (r.lot || '').trim().toLowerCase()).filter(Boolean))];
        if (uniqueLots.length === 0) {
            return new Map();
        }

        const startTime = performance.now();
        const isWaferMode = this.activeMode === 'wafer';

        try {
            // 다중검색과 동일: q 파라미터 + lot_multi로 토큰 인덱스 경로 사용
            const params = new URLSearchParams();
            // q에 LOT을 OR로 연결 → search_index_slice_parallel (토큰 인덱스) 경로
            params.set('q', uniqueLots.join(' or '));
            params.set('lot_multi', uniqueLots.join(','));
            if (isWaferMode) {
                const pairs = [];
                for (const row of rows) {
                    const lot = (row.lot || '').trim().toLowerCase();
                    const wafer = (row.wafer || '').trim().toLowerCase();
                    if (lot && wafer) pairs.push(`${lot}:${wafer}`);
                }
                if (pairs.length > 0) params.set('lot_wafer', pairs.join(','));
            }
            params.set('limit', '10000');
            const folderParam = this.viewer?.getSearchFolderParam?.() || '';
            params.set('folder', folderParam);

            console.log(`[MyLotModal] 배치 검색: ${uniqueLots.length}개 LOT, mode=${this.activeMode}`);
            const res = await fetch(`/api/search?${params.toString()}`);
            if (!res.ok) throw new Error(`API 오류: ${res.status}`);
            const data = await res.json();
            if (!data?.success || !Array.isArray(data.results)) {
                throw new Error('검색 결과가 없습니다.');
            }

            let allResults = data.results.filter(p =>
                p && !p.includes('_placeholders') && !p.includes('placeholder.png')
            );

            console.log(`[MyLotModal] API 응답: ${allResults.length}개 이미지 (${(performance.now() - startTime).toFixed(0)}ms)`);

            // LOT별 결과 분류 (파일명 기준 중복 제거 — 여러 폴더에 같은 파일이 있을 수 있음)
            const lotResultsMap = new Map();
            const seenFilenames = new Set();
            for (const path of allResults) {
                const filename = path.split('/').pop().split('\\').pop().toLowerCase();
                if (seenFilenames.has(filename)) continue;
                seenFilenames.add(filename);
                const lotToken = filename.split('_')[0];
                if (!lotResultsMap.has(lotToken)) lotResultsMap.set(lotToken, []);
                lotResultsMap.get(lotToken).push(path);
            }

            // 각 행에 결과 분배
            const resultMap = new Map();
            for (const row of rows) {
                const lotLower = (row.lot || '').trim().toLowerCase();
                const waferFilter = (row.wafer || '').trim().toLowerCase();
                let paths = lotResultsMap.get(lotLower) || [];
                if (!paths.length) {
                    paths = [];
                    for (const [lotKey, lotPaths] of lotResultsMap.entries()) {
                        if (lotKey.startsWith(lotLower)) {
                            paths.push(...lotPaths);
                        }
                    }
                }

                // Wafer 필터 (서버에서 이미 필터링하지만 클라이언트에서도 보장)
                if (waferFilter && paths.length > 0) {
                    paths = paths.filter(p => {
                        const fn = p.split('/').pop().split('\\').pop().toLowerCase();
                        const tokens = fn.replace(/\.[^.]+$/, '').split('_');
                        return tokens.some(t => t === waferFilter || t.startsWith(waferFilter));
                    });
                }

                resultMap.set(row.rowIndex, { paths, previewPath: paths[0] || null });
            }

            console.log(`[MyLotModal] 배치 검색 완료: ${(performance.now() - startTime).toFixed(0)}ms`);
            return resultMap;
        } catch (error) {
            console.error('[MyLotModal] 배치 검색 실패:', error);
            const emptyMap = new Map();
            for (const row of rows) {
                emptyMap.set(row.rowIndex, { paths: [], previewPath: null });
            }
            return emptyMap;
        }
    }

    /**
     * 🔥 단일 행 검색 및 이미지 연결 (LOT + Wafer)
     * @param {number} rowIndex 행 인덱스
     * @returns {Promise<{paths: Array<string>, previewPath: string|null}>}
     */
    async searchRowImages(rowIndex) {
        const row = this.manualRows[rowIndex];
        if (!row || !row.lot) {
            return { paths: [], previewPath: null };
        }

        const lot = row.lot.trim();
        const wafer = (row.wafer || '').trim();

        try {
            // lot 기준으로 먼저 검색 후 wafer 필터는 클라이언트에서 적용
            const results = await this.searchImagesByLots([lot], '');

            // Placeholder 제외한 유효한 이미지 필터링
            const validPaths = results.filter(p =>
                p && !p.includes('_placeholders') && !p.includes('placeholder.png')
            );
            const waferCandidates = this.buildWaferCandidates(validPaths);
            this.manualRows[rowIndex].waferCandidates = waferCandidates;

            if (this.activeMode === 'wafer' && !wafer) {
                // wafer 모드에서는 lot만으로는 보기/미리보기 확정 금지
                this.manualRows[rowIndex].searchResults = validPaths;
                this.manualRows[rowIndex].path = null;
                return {
                    paths: [],
                    previewPath: null,
                    requiresWaferSelection: true,
                    candidateWafers: waferCandidates,
                    lotMatchCount: validPaths.length,
                };
            }

            let filteredPaths = validPaths;
            if (wafer) {
                const waferLower = wafer.toLowerCase();
                filteredPaths = validPaths.filter((p) => {
                    const fn = p.split('/').pop()?.split('\\').pop()?.toLowerCase() || '';
                    const tokens = fn.replace(/\.[^.]+$/, '').split('_');
                    return tokens.some(t => t === waferLower || t.startsWith(waferLower));
                });
            }

            // 첫 번째 이미지를 미리보기용으로 선택
            const previewPath = filteredPaths.length > 0 ? filteredPaths[0] : null;

            // 행에 검색 결과 저장
            this.manualRows[rowIndex].searchResults = filteredPaths;
            this.manualRows[rowIndex].path = previewPath;

            console.log(`[MyLotModal] 행 ${rowIndex} 검색 완료: LOT="${lot}", Wafer="${wafer}", 결과=${filteredPaths.length}개`);
            return {
                paths: filteredPaths,
                previewPath,
                candidateWafers: waferCandidates,
                lotMatchCount: validPaths.length,
            };
        } catch (error) {
            console.error(`[MyLotModal] 행 ${rowIndex} 검색 실패:`, error);
            this.manualRows[rowIndex].searchResults = [];
            this.manualRows[rowIndex].path = null;
            this.manualRows[rowIndex].waferCandidates = [];
            return { paths: [], previewPath: null };
        }
    }

    /**
     * 이미지 없이 LOT 목록만 생성
     * @param {Array<string>} lotValues LOT 값 배열
     * @returns {{successCount: number, errors: Array<{lot: string, reason: string}>}}
     */
    async createManualLotEntries(lotValues = []) {
        // LOT 탭에서만 동작
        if (this.activeMode !== 'lot') {
            return { successCount: 0, errors: [] };
        }
        const uniqueLots = Array.from(new Set(
            (lotValues || []).map(v => (v || '').trim()).filter(Boolean)
        ));
        if (!uniqueLots.length) {
            return { successCount: 0, errors: [] };
        }
        let successCount = 0;
        const errors = [];

        for (const lot of uniqueLots) {
            try {
                const res = await fetch(this._withLogin('/api/my-lot/manual'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'lot',
                        group: this.activeGroup,
                        lot,
                        wafer: ""
                    }),
                });
                if (!res.ok) {
                    const reason = await this.parseErrorResponse(res);
                    errors.push({ lot, reason });
                    continue;
                }
                successCount += 1;
            } catch (error) {
                errors.push({ lot, reason: error?.message || '알 수 없는 오류' });
            }
        }

        return { successCount, errors };
    }

    scheduleManualRowSearch(rowIndex, delay = 0) {
        if (rowIndex == null || rowIndex < 0 || rowIndex >= this.manualRows.length) {
            return;
        }
        if (this.manualSearchTimers.has(rowIndex)) {
            clearTimeout(this.manualSearchTimers.get(rowIndex));
        }
        const timer = setTimeout(async () => {
            this.manualSearchTimers.delete(rowIndex);
            await this.searchAndUpdateManualRowImage(rowIndex);
            this.updateManualRowPreview(rowIndex);
        }, delay);
        this.manualSearchTimers.set(rowIndex, timer);
    }

    /**
     * 🔥 행 검색 및 미리보기 업데이트 (리팩토링)
     */
    async searchAndUpdateManualRowImage(rowIndex) {
        if (!this.manualRows[rowIndex]) {
            console.warn(`[MyLotModal] manualRows[${rowIndex}] 없음`);
            return;
        }
        
        const row = this.manualRows[rowIndex];
        if (!row.lot) {
            row.path = null;
            row.searchResults = [];
            row.waferCandidates = [];
            this.updateManualRowPreview(rowIndex);
            this.updateManualRowSearchCount(rowIndex, 0);
            return;
        }

        // 🔥 검색 시작 즉시 "..." 표시
        this.updateManualRowSearchBadge(rowIndex, '...');

        // 🔥 새로운 검색 함수 사용 (LOT + Wafer 필터)
        const result = await this.searchRowImages(rowIndex);
        const paths = result?.paths || [];

        if (result?.requiresWaferSelection) {
            const waferCount = (result?.candidateWafers || []).length;
            this.updateManualRowPreview(rowIndex);
            this.updateManualRowSearchBadge(rowIndex, waferCount > 0 ? `Wafer ${waferCount}` : 'Wafer 0');
            return;
        }

        // UI 업데이트 (즉시)
        this.updateManualRowPreview(rowIndex);
        this.updateManualRowSearchCount(rowIndex, paths.length);
    }

    /**
     * 🔥 검색 중 배지 즉시 업데이트
     */
    updateManualRowSearchBadge(rowIndex, text) {
        const inputRows = this.entriesContainer?.querySelectorAll('.my-lot-input-row');
        if (!inputRows) return;
        
        const targetRow = Array.from(inputRows).find(
            r => Number(r.dataset.manualIndex) === rowIndex
        );
        if (!targetRow) return;

        const lotCell = targetRow.querySelector('td[data-cell-type="lot"]');
        if (!lotCell) return;

        lotCell.style.position = 'relative';

        let countBadge = lotCell.querySelector('.search-count-badge');
        if (!countBadge) {
            countBadge = document.createElement('span');
            countBadge.className = 'search-count-badge';
            countBadge.style.cssText = `
                position: absolute;
                right: 4px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 10px;
                padding: 1px 4px;
                border-radius: 3px;
                pointer-events: none;
                white-space: nowrap;
            `;
            lotCell.appendChild(countBadge);
        }
        
        countBadge.textContent = text;
        countBadge.style.background = 'rgba(156, 163, 175, 0.2)';
        countBadge.style.color = '#9ca3af';
    }

    /**
     * 🔥 행의 검색 결과 개수 표시 업데이트 (셀 내부 우측 끝에 작게)
     */
    updateManualRowSearchCount(rowIndex, count) {
        const inputRows = this.entriesContainer?.querySelectorAll('.my-lot-input-row');
        if (!inputRows) return;
        
        const targetRow = Array.from(inputRows).find(
            r => Number(r.dataset.manualIndex) === rowIndex
        );
        if (!targetRow) return;

        const lotCell = targetRow.querySelector('td[data-cell-type="lot"]');
        if (!lotCell) return;

        // 셀에 position: relative 설정 (이미 있어도 무방)
        lotCell.style.position = 'relative';

        // 검색 결과 개수 표시 요소 찾기 또는 생성
        let countBadge = lotCell.querySelector('.search-count-badge');
        if (!countBadge) {
            countBadge = document.createElement('span');
            countBadge.className = 'search-count-badge';
            countBadge.style.cssText = `
                position: absolute;
                right: 4px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 10px;
                padding: 1px 4px;
                border-radius: 3px;
                pointer-events: none;
                white-space: nowrap;
            `;
            lotCell.appendChild(countBadge);
        }
        
        // 🔥 즉시 업데이트 (requestAnimationFrame 없이)
        if (count > 0) {
            countBadge.textContent = `${count}`;
            countBadge.style.background = 'rgba(74, 222, 128, 0.2)';
            countBadge.style.color = '#4ade80';
        } else {
            countBadge.textContent = '0';
            countBadge.style.background = 'rgba(239, 68, 68, 0.2)';
            countBadge.style.color = '#ef4444';
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
            this.ensureManualRows(true);
            // 🔥 모달 열 때 그룹 선택 초기화 (이전 그룹이 남지 않도록)
            this.activeGroup = null;

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
        
        // 임시 그룹 삭제 (백그라운드에서 실행)
        this.deleteTempGroupIfExists().catch(err => {
            console.warn('[MyLotModal] temp group cleanup failed:', err);
        });
        
        this.windowEl.classList.remove('is-open');
        this.windowEl.style.display = 'none';
        document.removeEventListener('keydown', this.boundKeyHandler);
        this.stopDragSelection();
        // 대기 중인 경로 초기화
        this.pendingPaths = [];
        this.updatePendingButtonVisibility();
        // 닫을 때 임시 입력 초기화
        this.manualRows = [];
        this.activeManualCell = null;
        this.selectedManualCells.clear();
        this.lastManualCellIndex = null;
    }

    async refreshData() {
        // 경량 그룹 목록만 가져오는 엔드포인트 사용
        const res = await fetch(this._withLogin('/api/my-lot/groups'), { cache: 'no-store' });
        if (!res.ok) {
            throw new Error(await res.text());
        }
        this.data = await res.json();
        if (this.loginLabel && this.data?.login_id) {
            this.loginLabel.textContent = `Login: ${this.data.login_id}`;
        }
        // 임시 그룹 삭제 - fire-and-forget (refreshData 완료를 막지 않음)
        if (this.tempGroup) {
            this.deleteTempGroupIfExists().catch(() => {});
        }
    }

    /**
     * 현재 activeMode / activeGroup에 대한 엔트리를 서버에서 로드한 뒤 렌더링.
     * - 그룹 목록은 /api/my-lot/groups 로 미리 가져오고
     * - 실제 파일 스캔은 선택된 그룹에 대해서만 /api/my-lot/entries 로 수행
     */
    async loadActiveGroupEntriesAndRender() {
        if (!this.activeGroup) {
            this.renderEntries();
            return;
        }

        // 로딩 상태를 간단히 표시
        if (this.entriesContainer) {
            this.entriesContainer.innerHTML = '<div class="empty-msg" style="color:#aaa;padding:16px;text-align:center;">데이터를 불러오는 중입니다...</div>';
        }

        try {
            const url = this._withLogin(`/api/my-lot/entries?mode=${encodeURIComponent(this.activeMode)}&group=${encodeURIComponent(this.activeGroup)}`);
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            const entries = await res.json();

            // this.data 구조 내 해당 그룹의 entries를 갱신
            if (this.data) {
                const modeKey = this.activeMode === 'wafer' ? 'wafer' : 'lot';
                const modeData = this.data[modeKey];
                if (modeData && Array.isArray(modeData.groups)) {
                    const groupObj = modeData.groups.find(g => g.name === this.activeGroup);
                    if (groupObj) {
                        groupObj.entries = entries || [];
                    }
                }
            }

            // 기존 테이블 렌더링 로직 재사용
            this.renderEntries();
        } catch (error) {
            console.error('[MyLotModal] loadActiveGroupEntriesAndRender failed:', error);
            if (this.entriesContainer) {
                this.entriesContainer.innerHTML = '<div class="empty-msg" style="color:red;padding:16px;text-align:center;">데이터를 불러오지 못했습니다.</div>';
            }
        }
    }

    async setMode(mode) {
        if (!MODES.includes(mode)) {
            mode = "lot";
        }
        
        // 모드 변경 시 임시 그룹 삭제
        await this.deleteTempGroupIfExists();
        
        this.activeMode = mode;
        this.modeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.myLotMode === mode);
        });
        // 모드 변경 시 임시 입력 초기화
        this.manualRows = [];
        this.activeManualCell = null;
        this.selectedManualCells.clear();
        this.lastManualCellIndex = null;
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
            emptyRow.style.border = 'none';
            const emptyCell = document.createElement('td');
            emptyCell.colSpan = headers.length;
            emptyCell.textContent = '그룹을 선택해주세요.';
            emptyCell.style.textAlign = 'center';
            emptyCell.style.padding = '40px 20px';
            emptyCell.style.color = '#777';
            emptyCell.style.fontSize = '13px';
            emptyCell.style.border = 'none';
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

            // 기존 항목 표시
            this.currentEntries.forEach((entry, index) => {
                const row = this.buildEntryRow(entry, index);
                tbody.appendChild(row);
            });

            // 수동 입력 행 추가 (맨 아래)
            if (this.activeGroup && this.manualRows.length > 0) {
                this.manualRows.forEach((data, idx) => {
                    const row = this.buildManualRow(data, idx);
                    tbody.appendChild(row);
                });
            }

            // 항목도 없고 수동 입력 행도 없을 때만 빈 메시지 표시
            if (!this.currentEntries.length && this.manualRows.length === 0) {
                const emptyRow = document.createElement('tr');
                emptyRow.style.border = 'none';
                const emptyCell = document.createElement('td');
                emptyCell.colSpan = headers.length;
                emptyCell.textContent = '저장된 항목이 없습니다.';
                emptyCell.style.textAlign = 'center';
                emptyCell.style.padding = '40px 20px';
                emptyCell.style.color = '#777';
                emptyCell.style.fontSize = '13px';
                emptyCell.style.border = 'none';
                emptyRow.appendChild(emptyCell);
                tbody.appendChild(emptyRow);
                this.updatePreview(null);
                this.updateActionButtonStates();
            }
        }

        table.appendChild(tbody);
        this.entriesContainer.appendChild(table);

        if (this.activeGroup) {
            this.updateSelectionStyles();
            this.updatePreviewForSelection();
            // 🔥 셀 스타일은 DOM이 완전히 렌더링된 후 적용
            requestAnimationFrame(() => {
                this.updateManualCellStyles();
                this.updateManualPreviewForActiveRow();
            });
        }
        this.updateActionButtonStates();
    }

    buildEntryRow(entry, index) {
        const row = document.createElement('tr');
        row.className = 'my-lot-entry-row';
        row.dataset.index = String(index);
        row.dataset.value = entry.value || '';
        row.dataset.path = entry.path || '';

        // LOT/Wafer: 서버 entry의 root/wafer 필드 우선, 없으면 파일명 파싱 fallback
        const parsed = splitLotWaferValue(entry.value || entry.filename || '');
        const lot = entry.root || parsed.lot;
        const wafer = entry.wafer || parsed.wafer;
        
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

    buildManualRow(data, index) {
        const row = document.createElement('tr');
        row.className = 'my-lot-input-row';
        row.dataset.manualIndex = String(index);

        // LOT 셀
        const lotCell = document.createElement('td');
        lotCell.textContent = data.lot || '(LOT 입력)';
        lotCell.style.cursor = 'text';
        lotCell.style.color = data.lot ? '#f3f3f3' : '#777';
        lotCell.style.fontStyle = data.lot ? 'normal' : 'italic';
        lotCell.dataset.cellType = 'lot';
        
        // 한 번 클릭으로 셀 선택
        lotCell.addEventListener('click', (e) => {
            this.handleManualCellClick(index, 'lot', e);
        });
        
        // 더블 클릭으로 편집 모드 (기존 내용 유지)
        lotCell.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.type = 'text';
            input.value = data.lot || '';
            input.style.cssText = `
                width: 100%;
                height: 100%;
                background: transparent;
                border: none;
                outline: none;
                color: #f3f3f3;
                padding: 0;
                margin: 0;
                font-size: inherit;
                font-family: inherit;
                caret-color: #3b82f6;
                box-sizing: border-box;
            `;
            input.addEventListener('input', () => {
                this.manualRows[index].lot = input.value;
                if (input.value) {
                    const now = new Date();
                    const year = String(now.getFullYear()).slice(2);
                    const month = String(now.getMonth() + 1).padStart(2, '0');
                    const day = String(now.getDate()).padStart(2, '0');
                    const hour = String(now.getHours()).padStart(2, '0');
                    const minute = String(now.getMinutes()).padStart(2, '0');
                    const second = String(now.getSeconds()).padStart(2, '0');
                    this.manualRows[index].saved_at = `${year}${month}${day}_${hour}${minute}${second}`;
                    this.scheduleManualRowSearch(index);
                } else {
                    this.manualRows[index].path = null;
                    delete this.manualRows[index].saved_at;
                    this.updateManualRowPreview(index);
                }
            });
            
            lotCell.textContent = '';
            lotCell.appendChild(input);
            input.focus();
            input.select();
            
            const finishEdit = async () => {
                this.manualRows[index].lot = input.value;
                if (input.value) {
                    // 입력 시 현재 시간으로 saved_at 설정
                    const now = new Date();
                    const year = String(now.getFullYear()).slice(2);
                    const month = String(now.getMonth() + 1).padStart(2, '0');
                    const day = String(now.getDate()).padStart(2, '0');
                    const hour = String(now.getHours()).padStart(2, '0');
                    const minute = String(now.getMinutes()).padStart(2, '0');
                    const second = String(now.getSeconds()).padStart(2, '0');
                    this.manualRows[index].saved_at = `${year}${month}${day}_${hour}${minute}${second}`;
                    
                    // LOT 입력 시 자동으로 이미지 검색 (fallback: path가 없으면 null 상태로라도 저장 가능해야 함)
                    await this.searchAndUpdateManualRowImage(index);
                    this.updateManualRowPreview(index);
                    this.renderEntries();
                } else {
                    lotCell.textContent = '(LOT 입력)';
                    lotCell.style.color = '#777';
                    lotCell.style.fontStyle = 'italic';
                }
            };
            
            input.addEventListener('blur', finishEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    finishEdit();
                    if (e.shiftKey) {
                        // 🔥 Shift+Enter: 아래 줄 추가하며 내려가기
                        this.moveCellSelection(1, 0);
                    }
                    // 🔥 Enter만: 수정 완료 (이동 없음)
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    finishEdit();
                } else if (e.key === 'Tab') {
                    e.preventDefault();
                    finishEdit();
                    this.moveCellSelection(0, e.shiftKey ? -1 : 1);
                }
            });
        });
        
        row.appendChild(lotCell);

        // Wafer 셀 (wafer 모드일 때만)
        if (this.activeMode === 'wafer') {
            const waferCell = document.createElement('td');
            waferCell.textContent = data.wafer || '(Wafer)';
            waferCell.style.cursor = 'text';
            waferCell.style.color = data.wafer ? '#f3f3f3' : '#777';
            waferCell.style.fontStyle = data.wafer ? 'normal' : 'italic';
            waferCell.dataset.cellType = 'wafer';
            
            // 한 번 클릭으로 셀 선택
            waferCell.addEventListener('click', (e) => {
                this.handleManualCellClick(index, 'wafer', e);
            });
            
            waferCell.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.value = data.wafer || '';
                input.style.cssText = `
                    width: 100%;
                    height: 100%;
                    background: transparent;
                    border: none;
                    outline: none;
                    color: #f3f3f3;
                    padding: 0;
                    margin: 0;
                    font-size: inherit;
                    font-family: inherit;
                    caret-color: #3b82f6;
                    box-sizing: border-box;
                `;
                input.addEventListener('input', () => {
                    this.manualRows[index].wafer = input.value;
                    if (input.value) {
                        const now = new Date();
                        const year = String(now.getFullYear()).slice(2);
                        const month = String(now.getMonth() + 1).padStart(2, '0');
                        const day = String(now.getDate()).padStart(2, '0');
                        const hour = String(now.getHours()).padStart(2, '0');
                        const minute = String(now.getMinutes()).padStart(2, '0');
                        const second = String(now.getSeconds()).padStart(2, '0');
                        this.manualRows[index].saved_at = `${year}${month}${day}_${hour}${minute}${second}`;
                    } else {
                        delete this.manualRows[index].saved_at;
                    }
                });
                
                waferCell.textContent = '';
                waferCell.appendChild(input);
                input.focus();
                input.select();
                
                const finishEdit = async () => {
                    this.manualRows[index].wafer = input.value;
                    if (input.value) {
                        // 입력 시 현재 시간으로 saved_at 설정
                        const now = new Date();
                        const year = String(now.getFullYear()).slice(2);
                        const month = String(now.getMonth() + 1).padStart(2, '0');
                        const day = String(now.getDate()).padStart(2, '0');
                        const hour = String(now.getHours()).padStart(2, '0');
                        const minute = String(now.getMinutes()).padStart(2, '0');
                        const second = String(now.getSeconds()).padStart(2, '0');
                        this.manualRows[index].saved_at = `${year}${month}${day}_${hour}${minute}${second}`;
                        
                        // 🔥 Wafer 입력 시 재검색 (LOT + Wafer 필터)
                        if (this.manualRows[index].lot) {
                            await this.searchAndUpdateManualRowImage(index);
                        }
                        this.renderEntries();
                    } else {
                        waferCell.textContent = '(Wafer)';
                        waferCell.style.color = '#777';
                        waferCell.style.fontStyle = 'italic';
                    }
                };
                
                input.addEventListener('blur', finishEdit);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        finishEdit();
                        if (e.shiftKey) {
                            // 🔥 Shift+Enter: 아래 줄 추가하며 내려가기
                            this.moveCellSelection(1, 0);
                        }
                        // 🔥 Enter만: 수정 완료 (이동 없음)
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        finishEdit();
                    } else if (e.key === 'Tab') {
                        e.preventDefault();
                        finishEdit();
                        this.moveCellSelection(0, e.shiftKey ? -1 : 1);
                    }
                });
            });
            
            row.appendChild(waferCell);
        }

        // 등록일시
        const dateCell = document.createElement('td');
        if (data.saved_at) {
            const savedAt = data.saved_at;
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
        dateCell.style.color = '#555';
        dateCell.style.fontSize = '11px';
        row.appendChild(dateCell);

        // 동작 (삭제 버튼)
        const actionCell = document.createElement('td');
        actionCell.style.padding = '6px 10px';
        actionCell.style.whiteSpace = 'nowrap';
        const actions = document.createElement('div');
        actions.className = 'my-lot-entry-actions';
        actions.style.display = 'flex';
        actions.style.gap = '4px';
        actions.style.flexWrap = 'nowrap';
        actions.style.justifyContent = 'flex-start';

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '삭제';
        deleteBtn.className = 'grid-btn';
        deleteBtn.style.minWidth = '42px';
        deleteBtn.addEventListener('click', () => {
            this.manualRows.splice(index, 1);
            this.manualSearchTimers.clear();
            this.renderEntries();
        });

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
                    // Placeholder 제외
                    paths = entry.all_paths.filter(p => 
                        p && !p.includes('_placeholders') && !p.includes('placeholder.png')
                    );
                } else if (entry.path && !entry.path.includes('_placeholders') && !entry.path.includes('placeholder.png')) {
                    paths = [entry.path];
                }

                if (paths.length > 0) {
                    if (this.viewer?.showGrid) {
                        // 🔥 Explorer 하이라이트 격리
                        this.viewer.selectedFolders = new Set();
                        this.viewer.lastSelectedFolder = null;
                        const _nav = document.querySelector('nav[aria-label="폴더 및 파일 목록"]');
                        if (_nav) _nav.querySelectorAll('summary.selected').forEach(s => s.classList.remove('selected'));
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
                // Wafer 탭: 단일 이미지로 표시 (Placeholder 제외)
                if (entry.path && !entry.path.includes('_placeholders') && !entry.path.includes('placeholder.png')) {
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
        
        // Placeholder 이미지는 미리보기에서 제외
        if (!entry || !entry.path || 
            entry.path.includes('_placeholders') || 
            entry.path.includes('placeholder.png')) {
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

    /**
     * 🔥 Ctrl+C: 선택된 항목을 클립보드에 복사 (현재 모드에 맞게)
     */
    handleKeyboardCopy() {
        const entries = this.getSelectedEntries();
        if (!entries.length) {
            this.viewer?.showToast?.('선택된 항목이 없습니다.', 1700);
            return;
        }

        // 현재 모드에 따라 복사 형식 결정
        if (this.activeMode === 'lot') {
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
            this.copyToClipboard(text, `${payload.length}개 LOT 복사했습니다.`);
        } else {
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
            this.copyToClipboard(text, `${payload.length}개 항목 복사했습니다.`);
        }
    }

    async handleSave() {
        if (!this.activeGroup) {
            this.viewer?.showToast?.('먼저 그룹을 선택해주세요.', 2000);
            return;
        }

        // 🔥 1번 요구사항: 선택된 모든 이미지 수집
        let paths = [];
        if (this.viewer) {
            const imageList = this.viewer.currentGridImages || this.viewer.gridViewImageList || this.viewer.images || [];
            let selectedIdxs = [];
            
            if (this.viewer.gridSelectedIdxs) {
                // Set인 경우와 Array인 경우 모두 안전하게 처리
                selectedIdxs = this.viewer.gridSelectedIdxs instanceof Set ? 
                               Array.from(this.viewer.gridSelectedIdxs) : 
                               this.viewer.gridSelectedIdxs;
            }

            if (selectedIdxs.length > 0 && imageList.length > 0) {
                paths = selectedIdxs.map(idx => imageList[idx]).filter(Boolean);
            }
        }

        // 다중 선택이 없으면 현재 화면에 띄워진 이미지 1개로 폴백
        if (paths.length === 0) {
            const candidate = this.viewer?.getMyLotCandidate?.();
            if (candidate && candidate.path) {
                paths = [candidate.path];
            }
        }

        if (paths.length === 0) {
            this.viewer?.showToast?.('선택된 이미지가 없습니다.', 1800);
            return;
        }

        // 🔥 3번 요구사항: WAFER 모드 (검색 없이 선택된 이미지 수백/수천개라도 그대로 즉시 등록)
        if (this.activeMode === 'wafer') {
            try {
                this.viewer?.showToast?.(`WAFER 모드: 이미지 ${paths.length}개 저장 중...`, 1500);
                const res = await fetch(this._withLogin('/api/my-lot/batch'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: this.activeMode, group: this.activeGroup, paths: paths })
                });
                if (!res.ok) throw new Error(await this.parseErrorResponse(res));

                this.viewer?.showToast?.(`Wafer 이미지 ${paths.length}개 저장 완료!`, 2000);
                this.refreshData().then(() => this.loadActiveGroupEntriesAndRender()).catch(() => {});
            } catch (error) {
                console.error('[MyLotModal] wafer save failed:', error);
                this.viewer?.showToast?.('저장에 실패했습니다.', 2000);
            }
            return;
        }

        // 🔥 2번 요구사항: LOT 모드 (LOT ID 모아서 중복제거 후 다중 검색 -> 연관 Wafer 모두 등록)
        try {
            const lotSet = new Set();
            for (const path of paths) {
                let targetLot = null;
                const tokens = this.viewer?.extractLotTokensFromPath?.(path);
                if (tokens && tokens.lotValue) {
                    targetLot = tokens.lotValue;
                } else {
                    const filename = path.split(/[\\/]/).pop() || '';
                    if (typeof splitLotWaferValue === 'function') {
                        const parsed = splitLotWaferValue(filename);
                        if (parsed.lot) targetLot = parsed.lot;
                    }
                }
                if (targetLot) lotSet.add(targetLot);
            }

            const targetLots = Array.from(lotSet);
            if (targetLots.length === 0) {
                this.viewer?.showToast?.('LOT 정보를 추출할 수 없습니다.', 2000);
                return;
            }

            this.viewer?.showToast?.(`${targetLots.length}개 LOT 다중 검색 및 저장 중...`, 1500);

            let searchResults = [];
            try {
                if (typeof this.searchImagesByLots === 'function') {
                    searchResults = await this.searchImagesByLots(targetLots);
                }
            } catch (err) {
                console.warn('[MyLotModal] LOT 검색 실패:', err);
            }

            if (searchResults.length === 0) {
                this.viewer?.showToast?.('해당 LOT에 대한 이미지를 찾을 수 없습니다.', 2000);
                return;
            }

            // 검색된 전체 결과에서 경로 중복 제거
            const uniqueResults = Array.from(new Set(searchResults));

            const res = await fetch(this._withLogin('/api/my-lot/batch'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: this.activeMode, group: this.activeGroup, paths: uniqueResults })
            });

            if (!res.ok) throw new Error(await this.parseErrorResponse(res));
            const result = await res.json();

            const msgs = [];
            if (result.success_count > 0) msgs.push(`${result.success_count}개 저장`);
            if (result.duplicate_count > 0) msgs.push(`${result.duplicate_count}개 중복`);
            this.viewer?.showToast?.(`LOT 저장 완료: ${msgs.join(', ')}`, 2500);
            this.refreshData().then(() => this.loadActiveGroupEntriesAndRender()).catch(() => {});

        } catch (error) {
            console.error('[MyLotModal] lot save failed:', error);
            this.viewer?.showToast?.('LOT 저장에 실패했습니다.', 2000);
        }
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
                    // Placeholder 제외
                    paths = entry.all_paths.filter(p => 
                        p && !p.includes('_placeholders') && !p.includes('placeholder.png')
                    );
                } else if (entry.path && !entry.path.includes('_placeholders') && !entry.path.includes('placeholder.png')) {
                    paths = [entry.path];
                }

                if (paths.length > 0) {
                    if (this.viewer?.showGrid) {
                        // 🔥 Explorer 하이라이트 격리
                        this.viewer.selectedFolders = new Set();
                        this.viewer.lastSelectedFolder = null;
                        const _nav = document.querySelector('nav[aria-label="폴더 및 파일 목록"]');
                        if (_nav) _nav.querySelectorAll('summary.selected').forEach(s => s.classList.remove('selected'));
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
                // Wafer 탭: 단일 이미지로 표시 (Placeholder 제외)
                if (entry.path && !entry.path.includes('_placeholders') && !entry.path.includes('placeholder.png')) {
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
        
        // Placeholder 이미지는 미리보기에서 제외
        if (!entry || !entry.path || 
            entry.path.includes('_placeholders') || 
            entry.path.includes('placeholder.png')) {
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

    /**
     * 🔥 Ctrl+C: 선택된 항목을 클립보드에 복사 (현재 모드에 맞게)
     */
    handleKeyboardCopy() {
        const entries = this.getSelectedEntries();
        if (!entries.length) {
            this.viewer?.showToast?.('선택된 항목이 없습니다.', 1700);
            return;
        }

        // 현재 모드에 따라 복사 형식 결정
        if (this.activeMode === 'lot') {
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
            this.copyToClipboard(text, `${payload.length}개 LOT 복사했습니다.`);
        } else {
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
            this.copyToClipboard(text, `${payload.length}개 항목 복사했습니다.`);
        }
    }

    /**
     * 🔥 Ctrl+V: 클립보드에서 붙여넣기 (수동 입력 행에 추가)
     */
    async handleKeyboardPaste() {
        // 그룹이 선택되지 않았으면 임시 그룹 생성
        if (!this.activeGroup) {
            await this.createTempGroup();
        }

        try {
            // 클립보드에서 텍스트 읽기
            let clipboardText = '';

            if (navigator.clipboard && navigator.clipboard.readText) {
                clipboardText = await navigator.clipboard.readText();
            } else {
                this.viewer?.showToast?.('클립보드 읽기를 지원하지 않는 브라우저입니다.', 2000);
                return;
            }

            if (!clipboardText || !clipboardText.trim()) {
                this.viewer?.showToast?.('클립보드가 비어있습니다.', 1700);
                return;
            }

            // 수동 입력 행에 바로 추가
            await this.handleManualPaste(clipboardText, false);
            this.viewer?.showToast?.('입력 행에 추가되었습니다. 이미지 검색 중...', 2000);

        } catch (error) {
            console.error('[MyLotModal] handleKeyboardPaste failed:', error);
            const message = error?.message || '붙여넣기에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
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
                    // LOT 폴더 내 모든 이미지 경로 추가 (placeholder 제외)
                    const validPaths = entry.all_paths.filter(p => 
                        p && !p.includes('_placeholders') && !p.includes('placeholder.png')
                    );
                    paths.push(...validPaths);
                } else if (entry.path && !entry.path.includes('_placeholders') && !entry.path.includes('placeholder.png')) {
                    // all_paths가 없으면 대표 이미지만 추가 (placeholder 제외)
                    paths.push(entry.path);
                }
            });

            console.log(`[MyLotModal] LOT Grid 보기: ${entries.length}개 LOT, 총 ${paths.length}개 이미지 표시`);
        } else {
            // Wafer 탭일 경우: 선택된 항목의 all_paths (해당 wafer 이미지들) 사용
            entries.forEach(entry => {
                if (entry.all_paths && Array.isArray(entry.all_paths) && entry.all_paths.length > 0) {
                    const validPaths = entry.all_paths.filter(p =>
                        p && !p.includes('_placeholders') && !p.includes('placeholder.png')
                    );
                    paths.push(...validPaths);
                } else if (entry.path && !entry.path.includes('_placeholders') && !entry.path.includes('placeholder.png')) {
                    paths.push(entry.path);
                }
            });
        }

        if (!paths.length) {
            this.viewer?.showToast?.('표시할 이미지가 없습니다.', 1700);
            return;
        }
        
        // 일반 폴더 선택과 동일하게 처리 (Measure/Composite/컬럼조절 등 모든 기능 사용 가능)
        if (this.viewer?.showGrid) {
            // currentFolderPath를 my-lot 그룹 경로로 설정
            const groupPath = `my-lot/notsaml/${this.activeMode}/${this.activeGroup}`;
            this.viewer.currentFolderPath = groupPath;
            this.viewer.selectedImages = [];
            this.viewer._lastGridScrollTop = null;
            if (this.viewer.savedViewState) {
                this.viewer.savedViewState.scrollTop = 0;
            }
            // 🔥 Explorer 하이라이트 격리: MY LOT 그리드 진입 시 Explorer 선택 상태 초기화
            this.viewer.selectedFolders = new Set();
            this.viewer.lastSelectedFolder = null;
            this.viewer.lastSelectedFolderPath = null;
            const nav = document.querySelector('nav[aria-label="폴더 및 파일 목록"]');
            if (nav) nav.querySelectorAll('summary.selected').forEach(s => s.classList.remove('selected'));
            this.viewer.showGrid(paths);
            return;
        }

        // fallback: 그리드가 없으면 첫 번째 이미지만이라도 연다
        const loadImage = this.viewer?.loadImage?.bind(this.viewer);
        if (loadImage && paths.length > 0) {
            try {
                await loadImage(paths[0]);
                if (paths.length > 1) {
                    this.viewer?.showToast?.('그리드가 없어 첫 번째 이미지만 열었습니다.', 2000);
                }
            } catch (error) {
                console.error('[MyLotModal] loadImage fallback failed:', error);
                this.viewer?.showToast?.('이미지를 열지 못했습니다.', 2000);
            }
            return;
        }

        this.viewer?.showToast?.('그리드/이미지 보기 기능을 사용할 수 없습니다.', 2000);
    }

    async handleCreateGroup() {
        const name = prompt('새 그룹 이름을 입력하세요.');
        if (!name) {
            return;
        }
        try {
            const res = await fetch(this._withLogin('/api/my-lot/group'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: this.activeMode, group: name }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }
            // 낙관적 업데이트: 서버 재조회 없이 즉시 로컬 state 반영
            const safeName = name.replace(/[^0-9A-Za-z_\-\.]+/g, "_") || name;
            if (!this.data) {
                this.data = { login_id: '', lot: { mode: 'lot', groups: [] }, wafer: { mode: 'wafer', groups: [] } };
            }
            const modeKey = this.activeMode === 'wafer' ? 'wafer' : 'lot';
            if (!this.data[modeKey]) this.data[modeKey] = { mode: this.activeMode, groups: [] };
            if (!Array.isArray(this.data[modeKey].groups)) this.data[modeKey].groups = [];
            if (!this.data[modeKey].groups.find(g => g.name === safeName)) {
                this.data[modeKey].groups.push({ name: safeName, entries: [] });
                this.data[modeKey].groups.sort((a, b) => a.name.localeCompare(b.name));
            }
            this.activeGroup = safeName;
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('그룹을 생성했습니다.', 1600);
            // 백그라운드 동기화
            this.refreshData().catch(err => console.warn('[MyLotModal] bg refresh after create:', err));
        } catch (error) {
            console.error('[MyLotModal] create group failed:', error);
            const message = error?.message || '그룹 생성에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
        }
    }

    async createTempGroup() {
        // 임시 그룹명 생성
        const now = new Date();
        const year = String(now.getFullYear()).slice(2);
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        const tempName = `temp_${year}${month}${day}_${hour}${minute}${second}`;

        try {
            const res = await fetch(this._withLogin('/api/my-lot/group'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: this.activeMode, group: tempName }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }
            // 낙관적 업데이트
            if (!this.data) {
                this.data = { login_id: '', lot: { mode: 'lot', groups: [] }, wafer: { mode: 'wafer', groups: [] } };
            }
            const modeKey = this.activeMode === 'wafer' ? 'wafer' : 'lot';
            if (!this.data[modeKey]) this.data[modeKey] = { mode: this.activeMode, groups: [] };
            if (!Array.isArray(this.data[modeKey].groups)) this.data[modeKey].groups = [];
            if (!this.data[modeKey].groups.find(g => g.name === tempName)) {
                this.data[modeKey].groups.push({ name: tempName, entries: [] });
            }
            this.activeGroup = tempName;
            this.tempGroup = tempName;
            this.renderGroups();
            this.viewer?.showToast?.(`임시 그룹 "${tempName}" 생성됨`, 1600);
        } catch (error) {
            console.error('[MyLotModal] create temp group failed:', error);
            const message = error?.message || '임시 그룹 생성에 실패했습니다.';
            this.viewer?.showToast?.(message, 2200);
        }
    }

    async deleteTempGroupIfExists() {
        if (!this.tempGroup) return;

        try {
            const res = await fetch(this._withLogin('/api/my-lot/group'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.tempGroup,
                }),
            });
            if (res.ok) {
                console.log(`[MyLotModal] 임시 그룹 "${this.tempGroup}" 삭제됨`);
            }
        } catch (error) {
            console.warn('[MyLotModal] temp group delete failed:', error);
        } finally {
            this.tempGroup = null;
        }
    }

    async handleRenameGroup() {
        if (!this.activeGroup) {
            this.viewer?.showToast?.('변경할 그룹을 선택해주세요.', 1800);
            return;
        }
        const newName = prompt(`새 그룹 이름을 입력하세요.`, this.activeGroup);
        if (!newName || newName === this.activeGroup) {
            return;
        }
        try {
            const res = await fetch(this._withLogin('/api/my-lot/group/rename'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    old_name: this.activeGroup,
                    new_name: newName,
                }),
            });
            if (!res.ok) {
                throw new Error(await this.parseErrorResponse(res));
            }
            // 낙관적 업데이트
            const safeName = newName.replace(/[^0-9A-Za-z_\-\.]+/g, "_") || newName;
            if (this.data) {
                const modeKey = this.activeMode === 'wafer' ? 'wafer' : 'lot';
                if (this.data[modeKey]?.groups) {
                    const group = this.data[modeKey].groups.find(g => g.name === this.activeGroup);
                    if (group) {
                        group.name = safeName;
                        this.data[modeKey].groups.sort((a, b) => a.name.localeCompare(b.name));
                    }
                }
            }
            this.activeGroup = safeName;
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('그룹 이름을 변경했습니다.', 1600);
            this.refreshData().catch(err => console.warn('[MyLotModal] bg refresh after rename:', err));
        } catch (error) {
            console.error('[MyLotModal] rename group failed:', error);
            const message = error?.message || '그룹 이름 변경에 실패했습니다.';
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
        
        const deletingGroup = this.activeGroup;
        
        // 🔥 낙관적 업데이트: 먼저 UI 즉시 반영
        this.activeGroup = null;
        this.manualRows = [];
        this.selectedManualCells.clear();
        this.activeManualCell = null;
        
        // 로컬 데이터에서 그룹 제거
        if (this.data) {
            const modeData = this.activeMode === 'lot' ? this.data.lot : this.data.wafer;
            if (modeData?.groups) {
                modeData.groups = modeData.groups.filter(g => g.name !== deletingGroup);
            }
        }
        
        this.renderGroups();
        this.renderEntries();
        this.viewer?.showToast?.('그룹을 삭제했습니다.', 1600);
        
        // 🔥 백그라운드에서 서버 요청
        try {
            const res = await fetch(this._withLogin('/api/my-lot/group'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: deletingGroup,
                }),
            });
            if (!res.ok) {
                console.error('[MyLotModal] delete group failed:', await res.text());
                // 실패 시 데이터 새로고침
                await this.refreshData();
                this.renderGroups();
                this.renderEntries();
            }
        } catch (error) {
            console.error('[MyLotModal] delete group failed:', error);
        }
    }

    async handleDelete(value) {
        if (!this.activeGroup) return;
        if (!confirm('선택한 항목을 삭제할까요?')) {
            return;
        }

        // 🔥 낙관적 업데이트: 즉시 UI 반영
        if (this.data) {
            const modeData = this.activeMode === 'lot' ? this.data.lot : this.data.wafer;
            if (modeData?.groups) {
                const group = modeData.groups.find(g => g.name === this.activeGroup);
                if (group?.entries) {
                    group.entries = group.entries.filter(e => e.value !== value && e.filename !== value);
                }
            }
        }
        this.renderGroups();
        this.renderEntries();
        this.viewer?.showToast?.('삭제했습니다.', 1600);

        // 🔥 백그라운드 서버 요청
        try {
            const res = await fetch(this._withLogin('/api/my-lot'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                    value,
                }),
            });
            if (!res.ok) {
                console.error('[MyLotModal] delete failed:', await res.text());
                this.refreshData().then(() => { this.renderGroups(); this.renderEntries(); }).catch(() => {});
            }
        } catch (error) {
            console.error('[MyLotModal] delete failed:', error);
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
        
        // 파일명 목록 추출
        const filenames = entries.map(entry => entry.value || entry.filename).filter(Boolean);
        if (!filenames.length) {
            this.viewer?.showToast?.('삭제할 파일명이 없습니다.', 1800);
            return;
        }

        const deletingFilenames = new Set(filenames);
        
        // 🔥 낙관적 업데이트: 먼저 UI 즉시 반영
        if (this.data) {
            const modeData = this.activeMode === 'lot' ? this.data.lot : this.data.wafer;
            if (modeData?.groups) {
                const group = modeData.groups.find(g => g.name === this.activeGroup);
                if (group?.entries) {
                    group.entries = group.entries.filter(e => 
                        !deletingFilenames.has(e.value) && !deletingFilenames.has(e.filename)
                    );
                }
            }
        }
        
        this.clearSelection(true);
        this.renderEntries();
        this.viewer?.showToast?.(`${entries.length}개 삭제`, 1600);
        
        // 🔥 백그라운드에서 서버 요청
        try {
            const res = await fetch(this._withLogin('/api/my-lot/batch'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,
                    group: this.activeGroup,
                    filenames: filenames,
                }),
            });
            if (!res.ok) {
                console.error('[MyLotModal] delete selection failed:', await res.text());
                // 실패 시 데이터 새로고침
                await this.refreshData();
                this.renderEntries();
            }
        } catch (error) {
            console.error('[MyLotModal] delete selection failed:', error);
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
            const res = await fetch(this._withLogin('/api/my-lot'), {
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

            // 🔥 낙관적 업데이트: 즉시 UI 반영
            if (this.data) {
                const modeKey = this.activeMode === 'wafer' ? 'wafer' : 'lot';
                if (this.data[modeKey]?.groups) {
                    const group = this.data[modeKey].groups.find(g => g.name === this.activeGroup);
                    if (group) {
                        if (!Array.isArray(group.entries)) group.entries = [];
                        const alreadyExists = group.entries.some(e => e.value === value || e.filename === value);
                        if (!alreadyExists) group.entries.push({ value });
                    }
                }
            }
            this.renderGroups();
            this.renderEntries();
            this.viewer?.showToast?.('MY LOT에 저장했습니다.', 1600);
            // 🔥 백그라운드에서 그룹 목록 + 현재 그룹 entries 동시 갱신 (저장 직후 Grid 보기 가능)
            this.refreshData().then(() => this.loadActiveGroupEntriesAndRender()).catch(err => console.warn('[MyLotModal] bg refresh after save:', err));
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

                // 서버 검색 API 호출 (공통 함수 사용)
                try {
                    finalPaths = await this.searchImagesByLots(lotList);
                } catch (searchError) {
                    console.warn('[MyLotModal] LOT 검색 실패, 이미지 없이 목록만 생성:', searchError);
                    finalPaths = [];
                }

                if (finalPaths.length === 0) {
                    // 검색 결과가 없으면 이미지 없이 LOT 폴더만 생성
                    const manualResult = await this.createManualLotEntries(lotList);
                    this.refreshData().then(() => this.loadActiveGroupEntriesAndRender()).catch(() => {});

                    if (manualResult.successCount > 0) {
                        const message = `${manualResult.successCount}개 LOT을 이미지 없이 저장했습니다.`;
                        this.viewer?.showToast?.(message, 2500);
                    } else {
                        const reason = manualResult.errors[0]?.reason || '저장할 LOT이 없습니다.';
                        this.viewer?.showToast?.(reason, 2200);
                    }
                    return;
                }

                console.log(`[MyLotModal] LOT 검색 완료: ${lotList.length}개 LOT, ${finalPaths.length}개 이미지`);

            } else {
                // Wafer Tab: 선택한 이미지 모두 저장 (중복 제거 안 함)
                finalPaths = paths.filter(path => {
                    const tokens = this.viewer?.extractLotTokensFromPath?.(path);
                    return tokens != null;
                });
            }

            if (finalPaths.length === 0) {
                this.viewer?.showToast?.('추가할 항목이 없습니다.', 1800);
                return;
            }

            // batch API 사용하여 일괄 등록
            const res = await fetch(this._withLogin('/api/my-lot/batch'), {
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

            // 결과 메시지 표시 (동기화 + 엔트리 로드)
            this.refreshData().then(() => this.loadActiveGroupEntriesAndRender()).catch(() => {});

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
                const count = this.pendingPaths.length; // 중복 포함 그대로 표시
                this.savePendingBtn.style.display = 'block';
                this.savePendingBtn.textContent = `선택 항목 저장 (${count}개)`;
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

        // 중복 제거 없이 원본 길이 반환
        return paths.length;
    }

    /**
     * 특정 그룹의 항목들을 업데이트 (단일 그룹 대상, LOT/Wafer 모드 모두 지원)
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

            // 해당 그룹의 LOT 값들 추출 (LOT/Wafer 모드 모두 LOT 기준으로 검색)
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

            // 서버 검색 API 호출 (공통 함수 사용)
            const lotList = Array.from(groupLots);
            let searchResults = [];

            try {
                searchResults = await this.searchImagesByLots(lotList);
            } catch (searchError) {
                console.warn(`[MyLotModal] 그룹 "${groupName}" 검색 실패:`, searchError);
                return;  // 검색 실패 시 조용히 종료
            }

            if (searchResults.length === 0) {
                return;
            }

            // batch API로 업데이트 (현재 모드에 맞게 저장)
            const res = await fetch(this._withLogin('/api/my-lot/batch'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: this.activeMode,  // 🔥 현재 모드 사용 (lot/wafer)
                    group: groupName,
                    paths: searchResults,
                }),
            });

            if (!res.ok) {
                throw new Error(`그룹 "${groupName}" 업데이트 실패: ${res.status}`);
            }

            const result = await res.json();
            console.log(`[MyLotModal] [${this.activeMode}] 그룹 "${groupName}" 업데이트: ${result.success_count || 0}개 추가, ${result.duplicate_count || 0}개 중복`);

            // 데이터 새로고침 및 UI 업데이트 (현재 보고 있는 그룹일 경우에만)
            await this.refreshData();
            if (this.activeGroup === groupName) {
                await this.loadActiveGroupEntriesAndRender();
            }
        } catch (error) {
            console.error(`[MyLotModal] 그룹 "${groupName}" 업데이트 실패:`, error);
        }
    }
}
