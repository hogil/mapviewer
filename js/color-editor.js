const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288', 'B290', 'B291',
                     'B300', 'B385', 'B386', 'B388', 'B389', 'B390', 'ETC'];

/**
 * 서버에서 로드한 color-legends.json의 default scheme을 가져옴
 * @param {Object} legends - colorLegends 객체
 * @returns {Object} default scheme 또는 빈 객체
 */
function getDefaultScheme(legends) {
    if (!legends || !legends.default) {
        console.warn('⚠️ [ColorEditor] default scheme을 찾을 수 없습니다. color-legends.json을 확인하세요.');
        return {
            top: {},
            bottom: {},
            background: '#FEFEFE',
            text: '#000001'
        };
    }
    return legends.default;
}

function normalizeHex(value) {
    if (value == null) return null;
    let hex = String(value).trim().toUpperCase();
    if (!hex) return null;
    if (!hex.startsWith('#')) {
        hex = `#${hex}`;
    }
    if (!/^#[0-9A-F]{6}$/.test(hex)) {
        return null;
    }
    return hex;
}

function hexToRgb(hex) {
    const value = normalizeHex(hex);
    if (!value) return null;
    return {
        r: parseInt(value.slice(1, 3), 16),
        g: parseInt(value.slice(3, 5), 16),
        b: parseInt(value.slice(5, 7), 16),
    };
}

function rgbToHex(r, g, b) {
    const clamp = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.min(255, Math.max(0, Math.round(n)));
    };
    const rr = clamp(r);
    const gg = clamp(g);
    const bb = clamp(b);
    if (rr == null || gg == null || bb == null) return null;
    const toHex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(rr)}${toHex(gg)}${toHex(bb)}`;
}

function formatEditorLabel(key) {
    if (!key) return '';
    if (key.startsWith('Grade')) {
        const n = key.replace('Grade', '');
        return `G${n}`;
    }
    if (key === 'Normal') return 'nor';
    if (key === 'Invalid') return 'invalid';
    if (key === 'background') return 'background';
    if (key === 'text') return 'text';
    if (key === 'ETC') return 'ETC';
    if (key.startsWith('B') && key.length > 1 && /^\d/.test(key[1])) {
        return key.slice(1);
    }
    return key;
}

export class ColorSchemeEditor {
    constructor(viewer) {
        this.viewer = viewer;
        this.modal = document.getElementById('color-editor-modal');
        this.dialog = this.modal ? this.modal.querySelector('.color-editor-dialog') : null;
        this.tableBody = this.modal ? this.modal.querySelector('#color-editor-table-body') : null;
        this.closeBtn = this.modal ? this.modal.querySelector('#color-editor-close-btn') : null;
        this.cancelBtn = this.modal ? this.modal.querySelector('#color-editor-cancel-btn') : null;
        this.applyBtn = this.modal ? this.modal.querySelector('#color-editor-apply-btn') : null;
        this.resetBtn = this.modal ? this.modal.querySelector('#color-editor-reset-btn') : null;
        this.restoreBtn = this.modal ? this.modal.querySelector('#color-editor-restore-btn') : null;
        this.errorEl = this.modal ? this.modal.querySelector('#color-editor-error') : null;
        this.schemeLabel = this.modal ? this.modal.querySelector('#color-editor-scheme-label') : null;
        this.schemeSearchInput = this.modal ? this.modal.querySelector('#color-editor-scheme-search') : null;
        this.schemeLoadBtn = this.modal ? this.modal.querySelector('#color-editor-scheme-load-btn') : null;
        this.schemeApplyBtn = this.modal ? this.modal.querySelector('#color-editor-scheme-apply-btn') : null;
        this.schemeDropdown = this.modal ? this.modal.querySelector('#color-editor-scheme-dropdown') : null;
        this.boundKeyHandler = this.handleKeyDown.bind(this);
        this.boundOutsideClick = this.handleOutsideClick.bind(this);
        this.activeSchemeOptions = [];
        this.rows = [];
        this.originalSchemeData = null;
        this._setupDone = false;
        this.selectedSchemeIndex = -1; // 키보드 네비게이션용
        this.originalCheckboxState = null; // 모달 열 때 체크박스 상태 저장용
        this.pendingSchemeName = ''; // 검색 리스트에서 선택한 임시 스킴명
        this.realtimeUpdateTimeout = null; // 실시간 미리보기 디바운스 타이머
        // 셀 선택 기능
        this.selectedCells = new Set(); // 선택된 셀들 (cellId 문자열)
        this.dragStartCell = null; // 드래그 시작 셀
        this.isDragging = false; // 드래그 중인지
        this.cellIdCounter = 0; // 셀 ID 카운터
        this.lastSelectedCell = null; // Shift 선택을 위한 마지막 선택된 셀 정보
        this.boundCellMouseDown = this.handleCellMouseDown.bind(this);
        this.boundCellMouseMove = this.handleCellMouseMove.bind(this);
        this.boundCellMouseUp = this.handleCellMouseUp.bind(this);
        this.boundCellKeyDown = this.handleCellKeyDown.bind(this);
        this.contextMenu = null;
        this.boundHideContextMenu = () => this.hideContextMenu();
        this._boundPasteHandler = this._handlePasteEvent.bind(this);
        this._contextMenuBound = false;
        // Tab state
        this.activeTab = 'fail';  // 'fail', 'composite', or 'measure'
        // Composite tab state
        this.compositeRows = [];
        this.compositeTableBody = null;
        this.compositeErrorEl = null;
        this.originalCompositeData = null;
        // Measure tab state
        this.measureRows = [];
        this.measureTableBody = null;
        this.measureErrorEl = null;
        this.originalMeasureData = null;
        // Backward compat aliases
        this.ratioRows = this.compositeRows;
        this.ratioTableBody = null;
        this.ratioErrorEl = null;
        this.originalRatioData = null;
        this.setup();
        if (this.modal) {
            this._setupDone = true;
        }
    }

    setup() {
        if (!this.modal) {
            return;
        }
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.close());
        }
        if (this.cancelBtn) {
            this.cancelBtn.addEventListener('click', () => this.close());
        }
        if (this.applyBtn) {
            this.applyBtn.addEventListener('click', () => this.handleApply());
        }
        if (this.resetBtn) {
            this.resetBtn.addEventListener('click', () => this.handleReset());
        }
        if (this.restoreBtn) {
            this.restoreBtn.addEventListener('click', () => this.handleRestore());
        }
        // 🔥 모달 배경 클릭으로 닫기 비활성화 (취소/적용 버튼으로만 닫기)
        // 모달 배경 클릭 시 닫지 않음
        // if (this.modal) {
        //     this.modal.addEventListener('click', (event) => {
        //         if (event.target === this.modal) {
        //             this.close();
        //         }
        //     });
        // }
        if (this.schemeLoadBtn) {
            // 검색 버튼 클릭 시 리스트 표시
            this.schemeLoadBtn.addEventListener('click', () => {
                this.populateSchemeOptions(true);
                // 첫 번째 항목 선택
                this.selectedSchemeIndex = 0;
                setTimeout(() => {
                    const items = Array.from(this.schemeDropdown.querySelectorAll('.color-editor-scheme-item'));
                    if (items.length > 0) {
                        this.updateSchemeSelection(items);
                    }
                }, 0);
            });
        }
        if (this.schemeApplyBtn) {
            this.schemeApplyBtn.addEventListener('click', () => this.applySelectedSchemeCandidate());
            this.schemeApplyBtn.disabled = true;
        }
        if (this.schemeSearchInput) {
            // 엔터 입력 시 리스트 표시
            this.schemeSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    // 🔥 드롭다운이 열려있으면 검색 입력창의 Enter 처리를 하지 않음
                    // (document의 handleKeyDown에서 드롭다운 선택을 처리하도록 함)
                    if (this.schemeDropdown?.classList.contains('is-open')) {
                        // 드롭다운이 열려있으면 이벤트를 전파하여 handleKeyDown에서 처리하도록 함
                        // preventDefault는 호출하지 않아서 이벤트가 document까지 전파됨
                        return;
                    }
                    
                    // 드롭다운이 닫혀있을 때만 리스트 표시
                    e.preventDefault();
                    this.populateSchemeOptions(true);
                    // 첫 번째 항목 선택
                    this.selectedSchemeIndex = 0;
                    setTimeout(() => {
                        const items = Array.from(this.schemeDropdown.querySelectorAll('.color-editor-scheme-item'));
                        if (items.length > 0) {
                            this.updateSchemeSelection(items);
                        }
                    }, 0);
                }
            });
            // 입력 즉시 후보 리스트 표시
            this.schemeSearchInput.addEventListener('input', () => {
                this.pendingSchemeName = '';
                this.setSchemeApplyButtonState(false);
                this.populateSchemeOptions(true);
            });
        }
        this.buildRows();

        // Tab switching
        this.tabBar = this.modal?.querySelector('#color-editor-tabs');
        this.failContent = this.modal?.querySelector('#color-editor-fail-content');
        this.compositeContent = this.modal?.querySelector('#color-editor-composite-content');
        this.measureContent = this.modal?.querySelector('#color-editor-measure-content');
        this.compositeTableBody = this.modal?.querySelector('#color-editor-composite-table-body');
        this.compositeErrorEl = this.modal?.querySelector('#color-editor-composite-error');
        this.measureTableBody = this.modal?.querySelector('#color-editor-measure-table-body');
        this.measureErrorEl = this.modal?.querySelector('#color-editor-measure-error');
        // Backward compat
        this.ratioContent = this.compositeContent;
        this.ratioTableBody = this.compositeTableBody;
        this.ratioErrorEl = this.compositeErrorEl;

        if (this.tabBar) {
            this.tabBar.addEventListener('click', (e) => {
                const btn = e.target.closest('.color-editor-tab');
                if (!btn) return;
                const tab = btn.dataset.tab;
                if (tab) this.switchTab(tab);
            });
        }

        this._buildGradientRows('composite');
        this._buildGradientRows('measure');
    }

    buildRows() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';
        const rows = [];

        const buildRow = (section, key) => {
            const tr = document.createElement('tr');
            tr.dataset.section = section;
            tr.dataset.key = key;

            const labelTd = document.createElement('td');
            labelTd.className = 'color-editor-label';
            labelTd.textContent = formatEditorLabel(key);

            const hexTd = document.createElement('td');
            const hexContainer = document.createElement('div');
            hexContainer.className = 'color-editor-hex';
            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.maxLength = 7;
            hexInput.placeholder = '#RRGGBB';
            const hexCellId = `hex-${this.cellIdCounter++}`;
            hexInput.dataset.cellId = hexCellId;
            hexInput.dataset.cellType = 'hex';
            hexInput.dataset.rowIndex = String(rows.length);
            hexContainer.appendChild(hexInput);
            hexTd.appendChild(hexContainer);

            const rgbTd = document.createElement('td');
            const rgbContainer = document.createElement('div');
            rgbContainer.className = 'color-editor-rgb';
            const rgbInputs = ['R', 'G', 'B'].map((label, idx) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.min = '0';
                input.max = '255';
                input.dataset.channel = ['r', 'g', 'b'][idx];
                input.placeholder = label;
                const rgbCellId = `rgb-${this.cellIdCounter++}`;
                input.dataset.cellId = rgbCellId;
                input.dataset.cellType = 'rgb';
                input.dataset.channelIndex = String(idx);
                input.dataset.rowIndex = String(rows.length);
                rgbContainer.appendChild(input);
                return input;
            });
            
            rgbTd.appendChild(rgbContainer);

            const pickerTd = document.createElement('td');
            pickerTd.className = 'color-editor-picker';
            // 왼쪽 디자인(색상 미리보기)으로 변경
            const colorPreview = document.createElement('div');
            colorPreview.className = 'color-editor-preview';
            colorPreview.style.width = '48px';
            colorPreview.style.height = '24px';
            colorPreview.style.backgroundColor = '#000000';
            colorPreview.style.border = '1px solid #444';
            colorPreview.style.borderRadius = '4px';
            colorPreview.style.flexShrink = '0';
            colorPreview.style.cursor = 'pointer';
            
            // 클릭 시 색상 선택기 열기
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = '#000000';
            colorInput.style.position = 'absolute';
            colorInput.style.opacity = '0';
            colorInput.style.width = '48px';
            colorInput.style.height = '24px';
            colorInput.style.cursor = 'pointer';
            colorInput.style.pointerEvents = 'auto';
            colorInput.style.top = '0';
            colorInput.style.left = '0';
            
            const pickerWrapper = document.createElement('div');
            pickerWrapper.style.position = 'relative';
            pickerWrapper.style.display = 'inline-block';
            pickerWrapper.appendChild(colorPreview);
            pickerWrapper.appendChild(colorInput);
            
            // 미리보기 클릭 시에도 색상 선택기 트리거
            colorPreview.addEventListener('click', (e) => {
                e.stopPropagation();
                colorInput.click();
            });
            
            pickerTd.appendChild(pickerWrapper);

            tr.appendChild(labelTd);
            tr.appendChild(hexTd);
            tr.appendChild(rgbTd);
            tr.appendChild(pickerTd);
            this.tableBody.appendChild(tr);

            const row = {
                section,
                key,
                hexInput,
                rgbInputs,
                colorInput,
                colorPreview,
            };

            hexInput.addEventListener('change', () => {
                this.syncFromHex(row);
                this.checkForChanges();
                this.updatePreviewRealtime();
            });
            hexInput.addEventListener('input', () => {
                this.clearError();
                this.checkForChanges();
                this.updatePreviewRealtime();
            });
            hexInput.addEventListener('paste', (e) => this.handleHexPaste(e, row));
            // 셀 선택 이벤트
            hexInput.addEventListener('mousedown', (e) => this.handleCellMouseDown(e, hexCellId, 'hex'));
            // 키보드 이벤트 (복사/붙여넣기) - capture phase에서 처리
            hexInput.addEventListener('keydown', (e) => this.handleInputKeyDown(e, hexCellId, 'hex'), true);
            rgbInputs.forEach((input, idx) => {
                input.addEventListener('change', () => {
                    this.syncFromRgb(row);
                    this.checkForChanges();
                    this.updatePreviewRealtime();
                });
                input.addEventListener('input', () => {
                    this.clearError();
                    this.checkForChanges();
                    this.updatePreviewRealtime();
                });
                input.addEventListener('paste', (e) => this.handleRgbPaste(e, row, idx));
                // 셀 선택 이벤트
                input.addEventListener('mousedown', (e) => this.handleCellMouseDown(e, input.dataset.cellId, 'rgb'));
                // 키보드 이벤트 (복사/붙여넣기) - capture phase에서 처리
                input.addEventListener('keydown', (e) => this.handleInputKeyDown(e, input.dataset.cellId, 'rgb'), true);
            });
            colorInput.addEventListener('input', () => {
                this.syncFromPicker(row);
                this.checkForChanges();
                this.updatePreviewRealtime();
            });
            colorInput.addEventListener('change', () => {
                this.updatePreviewRealtime();
            });
            rows.push(row);
        };

        // 고정 순서: G0~G7 -> background -> text -> nor/invalid/BIN
        TOP_KEYS.forEach((key) => buildRow('top', key));
        buildRow('background', 'background');
        buildRow('text', 'text');
        BOTTOM_KEYS.forEach((key) => buildRow('bottom', key));

        this.rows = rows;
        
        // 전역 이벤트 리스너 추가 (모달 내부에서만 동작하도록)
        if (this.modal) {
            this.modal.addEventListener('mousemove', this.boundCellMouseMove);
            this.modal.addEventListener('mouseup', this.boundCellMouseUp);
            this.modal.addEventListener('keydown', this.boundCellKeyDown);
            // 모달 전체에 컨텍스트 메뉴 이벤트 추가 (capture phase)
            if (!this._contextMenuBound) {
                this.modal.addEventListener('contextmenu', (e) => this.handleContextMenu(e), true);
                this._contextMenuBound = true;
            }
        }
        if (this.tableBody && !this._contextMenuBound) {
            this.tableBody.addEventListener('contextmenu', (e) => this.handleContextMenu(e), true);
            this._contextMenuBound = true;
        }
    }

    async open(initialTab = 'fail') {
        // 모달이 없으면 다시 찾기 시도
        if (!this.modal) {
            this.modal = document.getElementById('color-editor-modal');
            if (!this.modal) {
                console.error('❌ color-editor-modal을 찾을 수 없습니다.');
                this.viewer?.showToast?.('색상 편집 모달을 찾을 수 없습니다.', 1800);
                return;
            }
            // 모달을 다시 찾았으면 다른 요소들도 다시 찾기
            this.dialog = this.modal.querySelector('.color-editor-dialog');
            this.tableBody = this.modal.querySelector('#color-editor-table-body');
            this.closeBtn = this.modal.querySelector('#color-editor-close-btn');
            this.cancelBtn = this.modal.querySelector('#color-editor-cancel-btn');
            this.applyBtn = this.modal.querySelector('#color-editor-apply-btn');
            this.resetBtn = this.modal.querySelector('#color-editor-reset-btn');
            this.restoreBtn = this.modal.querySelector('#color-editor-restore-btn');
            this.errorEl = this.modal.querySelector('#color-editor-error');
            this.schemeLabel = this.modal.querySelector('#color-editor-scheme-label');
            this.schemeSearchInput = this.modal.querySelector('#color-editor-scheme-search');
            this.schemeLoadBtn = this.modal.querySelector('#color-editor-scheme-load-btn');
            this.schemeApplyBtn = this.modal.querySelector('#color-editor-scheme-apply-btn');
            this.schemeDropdown = this.modal.querySelector('#color-editor-scheme-dropdown');
            // 이벤트 리스너가 아직 설정되지 않았으면 설정
            if (!this._setupDone) {
                this.setup();
                this._setupDone = true;
            }
        }
        const legends = this.viewer?.colorLegends || {};
        // LoginId는 viewer에서 단일 정규화되어 전달됨
        let schemeName = this.viewer?.getCurrentLoginId?.() || this.viewer?.currentUser;
        
        // 해당 scheme이 없으면 default 색상으로 시작 (schemeName은 유지 - 저장 시 올바른 key에 생성)
        this.currentSchemeName = schemeName;
        const schemeData = legends[schemeName] || legends['default'] || getDefaultScheme(legends);
        // 초기 상태 저장 (깊은 복사)
        this.originalSchemeData = JSON.parse(JSON.stringify(schemeData));
        
        // 🔥 모달 열 때 체크박스 상태 저장 (취소 시 복원용)
        if (this.viewer?.dom?.personalizedColorCheckbox) {
            this.originalCheckboxState = this.viewer.dom.personalizedColorCheckbox.checked;
        } else {
            this.originalCheckboxState = this.viewer?.personalizedColorEnabled || false;
        }
        if (this.viewer) {
            this.viewer._previewSchemeOverride = null;
        }
        
        this.resetSchemeSearchState();
        this.populateSchemeOptions(false);
        this.applySchemeToRows(schemeData);
        this.updateSchemeLabel(schemeName);
        this.clearError();
        this.updateApplyButtonState(false);
        
        // tableBody가 다시 찾아졌을 경우 컨텍스트 메뉴 이벤트 리스너 재등록
        if (this.modal && !this._contextMenuBound) {
            this.modal.addEventListener('contextmenu', (e) => this.handleContextMenu(e), true);
            this._contextMenuBound = true;
        }
        if (this.tableBody && !this._contextMenuBound) {
            this.tableBody.addEventListener('contextmenu', (e) => this.handleContextMenu(e), true);
            this._contextMenuBound = true;
        }

        // Load gradient tab data
        this._savedRatioGradientCache = this.viewer?._ratioGradientCache
            ? [...this.viewer._ratioGradientCache] : null;
        await this._loadGradientColors('composite', schemeName);
        this._clearGradientError('composite');
        await this._loadGradientColors('measure', schemeName);
        this._clearGradientError('measure');

        // Switch to requested tab
        this.switchTab(initialTab);

        this.modal.classList.add('is-open');
        this.modal.setAttribute('aria-hidden', 'false');
        if (this.dialog) {
            this.dialog.style.marginLeft = '0px';
            this.dialog.scrollTop = 0;
        }
        const bodyEl = this.modal.querySelector('.color-editor-body');
        if (bodyEl) {
            bodyEl.scrollTop = 0;
        }
        document.addEventListener('keydown', this.boundKeyHandler);
        document.addEventListener('mousedown', this.boundOutsideClick);
        document.addEventListener('paste', this._boundPasteHandler, true);
    }

    async cleanupPreviewSchemeArtifacts() {
        if (!this.currentSchemeName) {
            return;
        }

        const canonicalPreviewName = `__preview_${this.currentSchemeName}`;
        const previewAliases = [
            canonicalPreviewName,
            `_preview_${this.currentSchemeName}`,
            `${this.currentSchemeName}_preview`,
        ];

        if (this.viewer?.colorLegends) {
            previewAliases.forEach((name) => {
                delete this.viewer.colorLegends[name];
            });
        }

        try {
            await fetch(`/api/color-scheme`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schemeName: canonicalPreviewName }),
            });
        } catch (_) {
            // ignore cleanup failures
        }
    }

    async close() {
        if (!this.modal) return;
        
        // viewer가 없으면 복원 로직 대신 __preview_ 정리만 수행
        if (!this.viewer) {
            await this.cleanupPreviewSchemeArtifacts();
            this.modal.classList.remove("is-open");
            this.modal.setAttribute("aria-hidden", "true");
            document.removeEventListener("keydown", this.boundKeyHandler);
            document.removeEventListener("mousedown", this.boundOutsideClick);
            this.clearError();
            return;
        }

        // 실시간 업데이트 타이머 정리
        if (this.realtimeUpdateTimeout) {
            clearTimeout(this.realtimeUpdateTimeout);
            this.realtimeUpdateTimeout = null;
        }
        if (this._gradientPreviewTimeout) {
            clearTimeout(this._gradientPreviewTimeout);
            this._gradientPreviewTimeout = null;
        }
        // Gradient preview 복원 (measure overlay)
        if (this._savedRatioGradientCache) {
            this.viewer._ratioGradientCache = this._savedRatioGradientCache;
            this._savedRatioGradientCache = null;
            if (!this.viewer.gridMode &&
                (this.viewer.overlayMode === 'f' || this.viewer.overlayMode === 'q') &&
                this.viewer.chipAnnotator) {
                this.viewer.chipAnnotator.setOverlayMode(this.viewer.overlayMode, {
                    gradientStops: this.viewer._ratioGradientCache,
                    itemKey: this.viewer._ratioActiveItemKey,
                });
            }
        }
        this.viewer._previewSchemeOverride = null;

        // 🔥 취소 시 원래 색상으로 되돌리기
        try {
            // 1. 원래 scheme으로 메모리 복원
            if (this.originalSchemeData && this.currentSchemeName) {
                if (this.viewer.colorLegends) {
                    this.viewer.colorLegends[this.currentSchemeName] = 
                        JSON.parse(JSON.stringify(this.originalSchemeData));
                }

                // 2. __preview_ 임시 스킴 삭제 (메모리 + 서버)
                await this.cleanupPreviewSchemeArtifacts();

                // 3. 캐시 초기화
                if (typeof this.viewer.hardResetUiCaches === 'function') {
                    await this.viewer.hardResetUiCaches({ clearPersistentStorage: false });
                }
                this.viewer.pyramidLevels = {};
                if (this.viewer._pyramidLoading) {
                    this.viewer._pyramidLoading = new Set();
                }
                if (this.viewer.pyramidLoadingLevels) {
                    this.viewer.pyramidLoadingLevels.clear();
                }
                if (this.viewer.semiconductorRenderer) {
                    this.viewer.semiconductorRenderer.imagePyramid = {};
                    this.viewer.semiconductorRenderer.levelTextures.clear();
                }

                // 4. personalizedColorCacheBuster 업데이트
                this.viewer._personalizedColorCacheBuster = Date.now();
                this.viewer._previewSchemeOverride = null;
                if (this.viewer.thumbnailManager) {
                    this.viewer.thumbnailManager.cache.clear();
                }

                // 5. 원래 설정 복원
                const originalUser = this.viewer.currentUser;
                if (this.originalCheckboxState !== null && this.viewer.dom?.personalizedColorCheckbox) {
                    this.viewer.dom.personalizedColorCheckbox.checked = this.originalCheckboxState;
                }
                this.viewer.personalizedColorEnabled = 
                    this.originalCheckboxState !== null ? this.originalCheckboxState : this.viewer.personalizedColorEnabled;
                this.viewer.currentUser = originalUser;

                // 6. 이미지/그리드 리로드
                if (this.viewer.gridMode) {
                    // 그리드 모드: 현재 그리드 이미지 유지하며 리로드
                    const currentImages = this.viewer.selectedImages || [];
                    if (currentImages.length > 0) {
                        await this.viewer.showGrid(currentImages, false);
                    }
                } else if (this.viewer.selectedImagePath) {
                    // 피라미드 모드: 현재 이미지 유지하며 리로드
                    await this.viewer.loadImage(this.viewer.selectedImagePath, false, null, true);
                }

                // 7. Legend 업데이트
                this.viewer.renderColorLegends();
                this.viewer.showColorLegends();
            }
        } catch (error) {
            console.error("ColorEditor: Restore on cancel failed", error);
        }
        
        this.modal.classList.remove('is-open');
        this.modal.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', this.boundKeyHandler);
        document.removeEventListener('mousedown', this.boundOutsideClick);
        document.removeEventListener('paste', this._boundPasteHandler, true);
        if (this.modal) {
            this.modal.removeEventListener('mousemove', this.boundCellMouseMove);
            this.modal.removeEventListener('mouseup', this.boundCellMouseUp);
            this.modal.removeEventListener('keydown', this.boundCellKeyDown);
        }
        this.selectedCells.clear();
        this.updateCellSelection();
        this.hideContextMenu();
        this.clearError();
    }

    handleKeyDown(event) {
        // 드롭다운이 열려있을 때 키보드 네비게이션 처리 (최우선)
        if (this.schemeDropdown?.classList.contains('is-open')) {
            const items = Array.from(this.schemeDropdown.querySelectorAll('.color-editor-scheme-item'));
            if (items.length > 0) {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.selectedSchemeIndex = Math.min(this.selectedSchemeIndex + 1, items.length - 1);
                    this.updateSchemeSelection(items);
                    return;
                } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.selectedSchemeIndex = Math.max(this.selectedSchemeIndex - 1, -1);
                    this.updateSchemeSelection(items);
                    return;
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    // 드롭다운이 열려있을 때 Enter: 항목 선택만 (적용은 별도 버튼)
                    if (this.selectedSchemeIndex >= 0 && this.selectedSchemeIndex < items.length) {
                        const selectedItem = items[this.selectedSchemeIndex];
                        const schemeName = selectedItem.dataset.name;
                        if (schemeName) {
                            this.selectSchemeCandidate(schemeName, true);
                        }
                    } else if (this.selectedSchemeIndex === -1 && items.length > 0) {
                        // 선택된 항목이 없으면 첫 번째 항목 선택
                        this.selectedSchemeIndex = 0;
                        this.updateSchemeSelection(items);
                        const firstItem = items[0];
                        const schemeName = firstItem.dataset.name;
                        if (schemeName) {
                            this.selectSchemeCandidate(schemeName, true);
                        }
                    }
                    return;
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    this.hideDropdown();
                    this.selectedSchemeIndex = -1;
                    return;
                }
            }
        }
        
        // 검색 입력창에서 Enter 처리: 검색 리스트 표시 (드롭다운이 닫혀있을 때만)
        if (event.target === this.schemeSearchInput && event.key === 'Enter') {
            // 드롭다운이 열려있으면 위에서 이미 처리됨
            // 드롭다운이 닫혀있으면 schemeSearchInput의 이벤트 리스너에서 처리됨
            return;
        }
        
        // Ctrl+C: 셀 복사 (document-level fallback)
        if ((event.ctrlKey || event.metaKey) && event.key === 'c' && this.selectedCells.size > 0) {
            this.copySelectedCells();
            event.preventDefault();
            return;
        }
        // Ctrl+V: native paste 이벤트가 _handlePasteEvent에서 처리 (keydown을 막으면 안 됨)

        // 🔥 ESC 키: 취소 버튼과 동일하게 동작
        if (event.key === 'Escape') {
            event.preventDefault();
            this.close(); // 취소 버튼과 동일
            return;
        }
        
        // 🔥 Enter 키: 적용 버튼과 동일하게 동작 (검색 입력창이나 드롭다운이 아닐 때만)
        if (event.key === 'Enter') {
            // 검색 입력창이나 드롭다운이 활성화되어 있으면 적용 버튼 동작 안 함
            const activeElement = document.activeElement;
            const isSearchInput = activeElement === this.schemeSearchInput;
            const isDropdownOpen = this.schemeDropdown?.classList.contains('is-open');
            
            // 검색 입력창이나 드롭다운이 활성화되어 있지 않을 때만 적용
            if (!isSearchInput && !isDropdownOpen) {
                event.preventDefault();
                if (this.applyBtn && !this.applyBtn.disabled) {
                    this.handleApply();
                }
                return;
            }
        }
    }
    
    updateSchemeSelection(items) {
        items.forEach((item, index) => {
            if (index === this.selectedSchemeIndex) {
                item.style.backgroundColor = '#007acc';
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                item.style.backgroundColor = '';
            }
        });
    }

    handleOutsideClick(event) {
        if (!this.dialog) return;
        // 드롭다운이 열려있으면 먼저 닫기
        if (this.schemeDropdown?.classList.contains('is-open')) {
            // 드롭다운 영역 클릭이 아니면 닫기
            if (!this.schemeDropdown.contains(event.target) && 
                !this.schemeSearchInput?.contains(event.target) &&
                !this.schemeLoadBtn?.contains(event.target) &&
                !this.schemeApplyBtn?.contains(event.target)) {
                this.hideDropdown();
                return;
            }
        }
        // 🔥 외부 클릭으로 모달 닫기 비활성화 (취소/적용 버튼으로만 닫기)
        // 모달 외부 클릭 시 닫지 않음
        // if (!this.dialog.contains(event.target)) {
        //     this.close();
        // }
    }

    handleSchemeLoad(name) {
        // Gradient 탭이면 별도 로직
        if (this.activeTab === 'composite' || this.activeTab === 'measure') {
            this._handleGradientSchemeLoad(name);
            this.hideDropdown();
            this.pendingSchemeName = '';
            this.setSchemeApplyButtonState(false);
            this.clearSearchCaretFocus();
            return;
        }

        const legends = this.viewer?.colorLegends || {};
        const target = name || this.schemeSearchInput?.value?.trim() || this.currentSchemeName || this.viewer?.currentUser;

        if (!legends[target]) {
            this.showError('해당하는 스킴을 찾을 수 없습니다.');
            return;
        }
        
        // 다른 scheme의 색상 값만 가져와서 현재 scheme에 적용
        // scheme 이름은 변경하지 않음 (현재 scheme 유지)
        const sourceSchemeData = legends[target];
        
        // 현재 scheme의 색상만 업데이트 (top, bottom, background, text)
        const defaultScheme = getDefaultScheme(legends);
        const updatedSchemeData = {
            top: sourceSchemeData.top || {},
            bottom: sourceSchemeData.bottom || {},
            background: sourceSchemeData.background || defaultScheme.background || '#FEFEFE',
            text: sourceSchemeData.text || defaultScheme.text || '#000001'
        };
        
        // 현재 scheme에 적용
        this.applySchemeToRows(updatedSchemeData);
        
        // 초기 상태 업데이트 (변경사항 감지용)
        this.originalSchemeData = JSON.parse(JSON.stringify(this.getCurrentSchemeData()));
        
        // 변경사항 있으므로 적용 버튼 활성화
        this.updateApplyButtonState(true);
        this.clearError();
        this.hideDropdown();
        this.pendingSchemeName = '';
        this.setSchemeApplyButtonState(false);
        this.clearSearchCaretFocus();
        
        // 🔥 미리보기에 적용
        this.updatePreviewRealtime();
    }

    populateSchemeOptions(shouldOpen = false) {
        if (!this.schemeDropdown) return;
        const legends = this.viewer?.colorLegends || {};
        const filter = this.schemeSearchInput?.value?.trim().toLowerCase() || '';
        const entries = Object.keys(legends);
        
        // 'default' 제외하고 필터링 (LoginId, Username, DeptName 모두 검색)
        const matches = entries.filter((name) => {
            if (name === 'default') return false;
            
            const schemeData = legends[name] || {};
            const loginId = String(schemeData.LoginId || name || '').toLowerCase();
            const username = (schemeData.Username || '').toLowerCase();
            const deptName = (schemeData.DeptName || '').toLowerCase();
            
            // 필터가 없으면 모두 표시
            if (!filter) return true;
            
            // LoginId, Username, DeptName 중 하나라도 매칭되면 표시
            return loginId.includes(filter) || 
                   username.includes(filter) || 
                   deptName.includes(filter);
        });
        
        // 너무 긴 목록 방지
        const limitedMatches = matches.slice(0, 30);
        
        this.schemeDropdown.innerHTML = '';
        this.selectedSchemeIndex = -1; // 리스트 갱신 시 선택 초기화
        
        // 검색 결과 없음 표시
        if (limitedMatches.length === 0) {
            const noResultsItem = document.createElement('div');
            noResultsItem.style.cssText = 'padding: 20px 12px; text-align: center; color: #999; font-size: 13px;';
            noResultsItem.textContent = '검색 결과 없음';
            this.schemeDropdown.appendChild(noResultsItem);
        } else {
            // 컬럼 헤더
            const headerRow = document.createElement('div');
            headerRow.className = 'color-editor-scheme-head-row';
            ['LoginId', 'UserName', 'DeptName'].forEach((label) => {
                const cell = document.createElement('div');
                cell.className = 'color-editor-scheme-head-cell';
                cell.textContent = label;
                headerRow.appendChild(cell);
            });
            this.schemeDropdown.appendChild(headerRow);

            limitedMatches.forEach((name, index) => {
                const schemeData = legends[name] || {};
                const loginId = String(schemeData.LoginId || name || '');
                const username = String(schemeData.Username || '');
                const deptName = String(schemeData.DeptName || '');
                
                const item = document.createElement('div');
                item.className = 'color-editor-scheme-item color-editor-scheme-row';
                item.dataset.name = name;

                const createCell = (text, color = '#fff', weight = '400') => {
                    const cell = document.createElement('div');
                    cell.className = 'color-editor-scheme-cell';
                    cell.style.color = color;
                    cell.style.fontWeight = weight;
                    cell.textContent = text || '-';
                    return cell;
                };

                // 값만 표시 (prefix 제거)
                item.appendChild(createCell(loginId, '#ffffff', '600'));
                item.appendChild(createCell(username, '#d4d4d4', '400'));
                item.appendChild(createCell(deptName, '#b9b9b9', '400'));
                
                // 호버 효과 및 클릭 이벤트
                item.addEventListener('mouseenter', () => {
                    this.selectedSchemeIndex = index;
                    this.updateSchemeSelection(Array.from(this.schemeDropdown.querySelectorAll('.color-editor-scheme-item')));
                });
                item.addEventListener('mouseleave', () => {
                    // 마우스가 벗어날 때는 선택 상태 유지 (키보드 네비게이션과 충돌 방지)
                });
                item.addEventListener('click', () => {
                    this.selectSchemeCandidate(name, true);
                    this.applySelectedSchemeCandidate();
                });
                
                this.schemeDropdown.appendChild(item);
            });
        }
        
        if (shouldOpen) {
            this.schemeDropdown.classList.add('is-open');
            this.schemeDropdown.setAttribute('aria-expanded', 'true');
        } else {
            this.hideDropdown();
        }
    }

    hideDropdown() {
        if (!this.schemeDropdown) return;
        this.schemeDropdown.classList.remove('is-open');
        this.schemeDropdown.setAttribute('aria-expanded', 'false');
        this.selectedSchemeIndex = -1;
    }

    clearSearchCaretFocus() {
        try {
            const active = document.activeElement;
            if (active && this.modal && this.modal.contains(active) && typeof active.blur === 'function') {
                active.blur();
            }
        } catch (_) {
            // ignore focus errors
        }
    }

    setSchemeApplyButtonState(enabled) {
        if (!this.schemeApplyBtn) return;
        this.schemeApplyBtn.disabled = !enabled;
    }

    resetSchemeSearchState() {
        this.pendingSchemeName = '';
        if (this.schemeSearchInput) {
            this.schemeSearchInput.value = '';
        }
        this.hideDropdown();
        this.setSchemeApplyButtonState(false);
    }

    selectSchemeCandidate(name, closeDropdown = false) {
        if (!name) return;
        this.pendingSchemeName = name;
        if (this.schemeSearchInput) {
            this.schemeSearchInput.value = name;
        }
        this.setSchemeApplyButtonState(true);
        if (closeDropdown) {
            this.hideDropdown();
        }
        this.clearSearchCaretFocus();
    }

    applySelectedSchemeCandidate() {
        const legends = this.viewer?.colorLegends || {};
        const typed = this.schemeSearchInput?.value?.trim() || '';
        let target = this.pendingSchemeName || typed;

        if (target && !legends[target]) {
            const lower = target.toLowerCase();
            const exact = Object.keys(legends).find((name) => name.toLowerCase() === lower);
            if (exact) {
                target = exact;
            }
        }

        if (!target || !legends[target]) {
            this.showError('적용할 사용자를 먼저 선택하세요.');
            return;
        }
        this.handleSchemeLoad(target);
        this.clearSearchCaretFocus();
    }

    applySchemeToRows(scheme) {
        const legends = this.viewer?.colorLegends || {};
        const defaultScheme = getDefaultScheme(legends);
        const defaultTop = defaultScheme.top || {};
        const defaultBottom = defaultScheme.bottom || {};

        const top = {
            ...defaultTop,
            ...(scheme.top || {}),
        };

        // 레거시 호환: 일부 스킴은 bottom.Normal 대신 bottom.Border를 사용
        const sourceBottom = {
            ...(scheme.bottom || {}),
        };
        if (!sourceBottom.Normal && sourceBottom.Border) {
            sourceBottom.Normal = sourceBottom.Border;
        }

        const bottom = {
            ...defaultBottom,
            ...sourceBottom,
        };
        if (!bottom.Normal && defaultBottom.Border) {
            bottom.Normal = defaultBottom.Border;
        }

        const background = scheme.background || defaultScheme.background || '#FEFEFE';
        const text = scheme.text || defaultScheme.text || '#000001';

        this.rows.forEach((row) => {
            let hex;
            if (row.section === 'top') {
                hex = top[row.key];
            } else if (row.section === 'bottom') {
                hex = bottom[row.key];
            } else if (row.section === 'background') {
                hex = background;
            } else if (row.section === 'text') {
                hex = text;
            } else {
                hex = background;
            }

            let fallbackHex = '#000000';
            if (row.section === 'top') {
                fallbackHex = defaultTop[row.key] || fallbackHex;
            } else if (row.section === 'bottom') {
                if (row.key === 'Normal') {
                    fallbackHex = defaultBottom.Normal || defaultBottom.Border || fallbackHex;
                } else {
                    fallbackHex = defaultBottom[row.key] || fallbackHex;
                }
            } else if (row.section === 'background') {
                fallbackHex = defaultScheme.background || fallbackHex;
            } else if (row.section === 'text') {
                fallbackHex = defaultScheme.text || fallbackHex;
            }

            const valid = normalizeHex(hex) || normalizeHex(fallbackHex) || '#000000';
            this.setRowHex(row, valid);
        });
    }

    setRowHex(row, hex) {
        row.hexInput.value = hex;
        row.colorInput.value = hex;
        if (row.colorPreview) {
            row.colorPreview.style.backgroundColor = hex;
        }
        const rgb = hexToRgb(hex);
        if (rgb) {
            row.rgbInputs[0].value = rgb.r;
            row.rgbInputs[1].value = rgb.g;
            row.rgbInputs[2].value = rgb.b;
        } else {
            row.rgbInputs.forEach((input) => (input.value = ''));
        }
    }

    syncFromHex(row) {
        const value = normalizeHex(row.hexInput.value);
        if (!value) {
            row.hexInput.classList.add('invalid');
            this.showError('HEX 색상은 #RRGGBB 형식이어야 합니다.');
            return;
        }
        row.hexInput.classList.remove('invalid');
        this.setRowHex(row, value);
        this.clearError();
    }

    syncFromRgb(row) {
        const [rInput, gInput, bInput] = row.rgbInputs;
        const hex = rgbToHex(rInput.value, gInput.value, bInput.value);
        if (!hex) {
            this.showError('RGB 값은 0~255 사이의 숫자여야 합니다.');
            [rInput, gInput, bInput].forEach((input) => input.classList.add('invalid'));
            return;
        }
        [rInput, gInput, bInput].forEach((input) => input.classList.remove('invalid'));
        this.setRowHex(row, hex);
        this.clearError();
    }

    syncFromPicker(row) {
        const hex = normalizeHex(row.colorInput.value);
        if (!hex) return;
        this.setRowHex(row, hex);
        this.clearError();
    }

    async handleHexPaste(event, startRow) {
        event.preventDefault();
        const pastedText = (event.clipboardData || window.clipboardData).getData('text');
        if (!pastedText) return;

        // 여러 줄로 분리
        const lines = pastedText.split(/\r?\n/).map(line => line.trim()).filter(line => line);
        if (lines.length === 0) return;

        // 현재 행부터 시작
        const startIndex = this.rows.indexOf(startRow);
        if (startIndex === -1) return;

        let successCount = 0;
        lines.forEach((line, idx) => {
            const targetIndex = startIndex + idx;
            if (targetIndex >= this.rows.length) return;

            const hex = normalizeHex(line);
            if (hex) {
                const targetRow = this.rows[targetIndex];
                this.setRowHex(targetRow, hex);
                successCount++;
            }
        });

        if (successCount === 0) {
            this.showError('유효한 HEX 색상 형식을 찾을 수 없습니다.');
        } else {
            this.clearError();
            this.checkForChanges();
        }
    }

    async handleRgbPaste(event, startRow, startChannel) {
        event.preventDefault();
        const pastedText = (event.clipboardData || window.clipboardData).getData('text');
        if (!pastedText) return;

        // 여러 줄로 분리
        const lines = pastedText.split(/\r?\n/).map(line => line.trim()).filter(line => line);
        if (lines.length === 0) return;

        // 현재 행부터 시작
        const startIndex = this.rows.indexOf(startRow);
        if (startIndex === -1) return;

        let successCount = 0;
        lines.forEach((line, lineIdx) => {
            const targetIndex = startIndex + lineIdx;
            if (targetIndex >= this.rows.length) return;

            // RGB 값 파싱 (쉼표, 탭, 공백으로 구분)
            const values = line.split(/[,\s\t]+/).map(v => v.trim()).filter(v => v);
            
            if (values.length >= 3) {
                // 3개 값이 있으면 R, G, B로 처리
                const r = Number(values[0]);
                const g = Number(values[1]);
                const b = Number(values[2]);
                
                if (Number.isFinite(r) && r >= 0 && r <= 255 &&
                    Number.isFinite(g) && g >= 0 && g <= 255 &&
                    Number.isFinite(b) && b >= 0 && b <= 255) {
                    const targetRow = this.rows[targetIndex];
                    targetRow.rgbInputs[0].value = Math.round(r);
                    targetRow.rgbInputs[1].value = Math.round(g);
                    targetRow.rgbInputs[2].value = Math.round(b);
                    targetRow.rgbInputs.forEach(input => input.classList.remove('invalid'));
                    this.syncFromRgb(targetRow);
                    successCount++;
                }
            } else if (startChannel < 3 && values.length > 0) {
                // 일부 채널만 채워지는 경우 (첫 번째 입력 필드에서 붙여넣은 경우)
                const targetRow = this.rows[targetIndex];
                values.forEach((value, valIdx) => {
                    const channelIndex = (startChannel + valIdx) % 3;
                    const num = Number(value);
                    if (Number.isFinite(num) && num >= 0 && num <= 255) {
                        targetRow.rgbInputs[channelIndex].value = Math.round(num);
                        targetRow.rgbInputs[channelIndex].classList.remove('invalid');
                    }
                });
                // 모든 채널이 채워졌는지 확인하고 sync
                if (targetRow.rgbInputs.every(input => input.value)) {
                    this.syncFromRgb(targetRow);
                }
                successCount++;
            }
        });

        if (successCount === 0) {
            this.showError('유효한 RGB 값 형식을 찾을 수 없습니다. (예: 255, 149, 147)');
        } else {
            this.clearError();
            this.checkForChanges();
        }
    }

    getCurrentSchemeData() {
        // 색상 편집에는 top, bottom, background, text만 사용
        const legends = this.viewer?.colorLegends || {};
        const defaultScheme = getDefaultScheme(legends);
        const data = {
            top: {},
            bottom: {},
            background: defaultScheme.background || '#FEFEFE',
            text: defaultScheme.text || '#000001',
        };

        this.rows.forEach((row) => {
            const hex = normalizeHex(row.hexInput.value);
            if (hex) {
                if (row.section === 'top') {
                    data.top[row.key] = hex;
                } else if (row.section === 'bottom') {
                    data.bottom[row.key] = hex;
                } else if (row.section === 'background') {
                    data.background = hex;
                } else if (row.section === 'text') {
                    data.text = hex;
                }
            }
        });

        return data;
    }

    checkForChanges() {
        if (this.activeTab === 'composite' || this.activeTab === 'ratio') {
            if (!this.originalCompositeData) return;
            const currentData = this._getCurrentGradientData('composite');
            const hasChanges = JSON.stringify(currentData) !== JSON.stringify(this.originalCompositeData);
            this.updateApplyButtonState(hasChanges);
        } else if (this.activeTab === 'measure') {
            if (!this.originalMeasureData) return;
            const currentData = this._getCurrentGradientData('measure');
            const hasChanges = JSON.stringify(currentData) !== JSON.stringify(this.originalMeasureData);
            this.updateApplyButtonState(hasChanges);
        } else {
            if (!this.originalSchemeData) return;
            const currentData = this.getCurrentSchemeData();
            const hasChanges = JSON.stringify(currentData) !== JSON.stringify(this.originalSchemeData);
            this.updateApplyButtonState(hasChanges);
        }
    }

    /**
     * 색상 입력 시 즉시 이미지에 반영 (미리보기)
     */
    updatePreviewRealtime() {
        // ✅ 그리드 모드 허용
        if (!this.viewer) {
            return;
        }

        // ✅ 단일 이미지도 없고 그리드 모드도 아니면 리턴
        if (!this.viewer.gridMode && !this.viewer.selectedImagePath) {
            return;
        }

        // 500ms 디바운스
        if (this.realtimeUpdateTimeout) {
            clearTimeout(this.realtimeUpdateTimeout);
        }

        this.realtimeUpdateTimeout = setTimeout(async () => {
            try {
                const schemeData = this.getCurrentSchemeData();
                const schemeName = this.currentSchemeName;
                if (!schemeName || !schemeData) return;
                const tempSchemeName = `__preview_${schemeName}`;

                // 1. 메모리 내 colorLegends 업데이트 (즉시 반영)
                if (!this.viewer.colorLegends) {
                    this.viewer.colorLegends = {};
                }
                this.viewer.colorLegends[schemeName] = schemeData;
                // preview scheme도 메모리에 등록해야 getPersonalizedParams() fallback이 잘 유지됨
                this.viewer.colorLegends[tempSchemeName] = JSON.parse(JSON.stringify(schemeData));

                // 2. 백엔드에 임시 scheme 저장 (프리뷰용)
                try {
                    // 단일 이미지 프리뷰에서는 저장-적용 순서를 보장해 레이스를 방지
                    const previewRes = await fetch(`/api/color-scheme`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            schemeName: tempSchemeName,
                            schemeData: schemeData,
                        }),
                    });
                    if (!previewRes.ok) {
                        console.warn("ColorEditor: Preview scheme save failed", previewRes.status);
                    }
                } catch (e) {
                    console.warn("ColorEditor: Preview scheme save failed", e);
                }

                // 3. personalizedColorCacheBuster 업데이트
                this.viewer._personalizedColorCacheBuster = Date.now();

                // 4. 임시로 currentUser를 변경하여 프리뷰 scheme 사용
                const originalEnabled = this.viewer.personalizedColorEnabled;
                const originalUser = this.viewer.currentUser;
                this.viewer.personalizedColorEnabled = true;
                this.viewer.currentUser = tempSchemeName;
                this.viewer._previewSchemeOverride = tempSchemeName;

                // 5. 캐시 초기화
                this.viewer.pyramidLevels = {};
                if (this.viewer._pyramidLoading) {
                    this.viewer._pyramidLoading = new Set();
                }
                if (this.viewer.pyramidLoadingLevels) {
                    this.viewer.pyramidLoadingLevels.clear();
                }
                if (this.viewer.semiconductorRenderer) {
                    this.viewer.semiconductorRenderer.imagePyramid = {};
                    this.viewer.semiconductorRenderer.levelTextures.clear();
                }

                // ⭐ 6단계: 그리드 모드 vs 단일 이미지 구분
                // mode 플래그가 일시적으로 stale일 수 있어 캔버스 표시 상태 + 현재 경로 기준으로 판별
                const previewImagePath = this.viewer.selectedImagePath || this.viewer.currentImagePath || null;
                const singleCanvasVisible = Boolean(
                    this.viewer.dom?.imageCanvas &&
                    this.viewer.dom.imageCanvas.style.display !== 'none'
                );

                if (previewImagePath && singleCanvasVisible) {
                    // ✅ 단일 이미지 모드: 이미지 리로드
                    // 디버그 로그 제거
                    // console.log('ColorEditor: Updating single image preview');
                    // 같은 경로 재로드가 조기 반환되지 않도록 forceReload=true
                    await this.viewer.loadImage(previewImagePath, false, null, true);
                    this.refreshNavigatorPreview();
                } else if (this.viewer.gridMode) {
                    // ✅ 그리드 모드: 썸네일 캐시 클리어 + 썸네일 리로드
                    // 디버그 로그 제거
                    // console.log('ColorEditor: Updating grid thumbnails preview');
                    if (typeof this.viewer.refreshGridThumbnailsWithCurrentParams === 'function') {
                        this.viewer.refreshGridThumbnailsWithCurrentParams();
                    }

                    // gridImage 단일뷰에서 navigator가 열려 있으면 즉시 갱신
                    this.refreshNavigatorPreview();
                }

                // 7. Legend 업데이트
                this.viewer.renderColorLegends();

                // 8. 원래 설정 복원 (메모리에만, 백엔드는 유지)
                this.viewer.personalizedColorEnabled = originalEnabled;
                this.viewer.currentUser = originalUser;
            } catch (error) {
                console.error("ColorEditor: Realtime preview failed", error);
            }
        }, 500); // 500ms 디바운스
    }

    refreshNavigatorPreview() {
        if (!this.viewer?.thumbnailNavigator) {
            return;
        }

        const navigator = this.viewer.thumbnailNavigator;
        const navigatorContainer =
            navigator.container ||
            document.getElementById('thumbnail-navigator');

        // isVisible 플래그가 stale인 경우(실제 DOM은 visible) 동기화
        if (!navigator.isVisible && navigatorContainer) {
            const style = window.getComputedStyle(navigatorContainer);
            const domVisible = style.display !== 'none' && style.visibility !== 'hidden';
            if (domVisible) {
                navigator.isVisible = true;
            }
        }

        const currentPath = this.viewer.selectedImagePath || this.viewer.currentImagePath || null;
        if (!currentPath) {
            return;
        }

        let sourceList = [];
        if (this.viewer.viewMode === 'gridImage' && Array.isArray(this.viewer.gridViewImageList) && this.viewer.gridViewImageList.length > 0) {
            sourceList = this.viewer.gridViewImageList;
        } else if (Array.isArray(this.viewer.singleViewImageList) && this.viewer.singleViewImageList.length > 0) {
            sourceList = this.viewer.singleViewImageList;
        } else if (Array.isArray(this.viewer.selectedImages) && this.viewer.selectedImages.length > 0) {
            sourceList = this.viewer.selectedImages;
        }

        if (!sourceList.length) {
            return;
        }

        // 이미지 목록이 이미 로드된 경우 DOM 재생성 없이 URL만 갱신 (성능 최적화)
        if (navigator.imageList && navigator.imageList.length > 0) {
            navigator.refreshThumbnailUrls(currentPath);
        } else {
            // 최초 초기화: 전체 렌더링
            navigator.setImages(sourceList, currentPath, true);
        }
    }

    updateApplyButtonState(enabled) {
        if (!this.applyBtn) return;
        if (enabled) {
            this.applyBtn.disabled = false;
            this.applyBtn.removeAttribute('disabled');
        } else {
            this.applyBtn.disabled = true;
            this.applyBtn.setAttribute('disabled', '');
        }
    }

    async handleApply() {
        if (!this.applyBtn || this.applyBtn.disabled) return;

        if (this.activeTab === 'composite' || this.activeTab === 'measure' || this.activeTab === 'ratio') {
            return this._handleApplyGradient(this.activeTab === 'measure' ? 'measure' : 'composite');
        }

        const schemeData = this.getCurrentSchemeData();
        if (!schemeData) {
            this.showError('색상 데이터를 가져올 수 없습니다.');
            return;
        }

        const schemeName = this.currentSchemeName;
        if (!schemeName) {
            this.showError('스킴 이름을 찾을 수 없습니다.');
            return;
        }

        // 버튼 비활성화
        this.applyBtn.disabled = true;
        this.clearError();

        try {
            const response = await fetch('/api/color-scheme', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    schemeName: schemeName,
                    schemeData: schemeData,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `저장 실패 (${response.status})`);
            }

            const result = await response.json();
            if (result.success) {
                // 디버그 로그 제거
                // console.log('✅ [ColorEditor] 색상 스킴 서버 저장 성공:', schemeName);
                
                // 프론트엔드 캐시 갱신
                if (this.viewer) {
                    // ✅ 1단계: colorLegends 업데이트 (메모리)
                    if (!this.viewer.colorLegends) {
                        this.viewer.colorLegends = {};
                    }
                    this.viewer.colorLegends[schemeName] = schemeData;
                    // 디버그 로그 제거
                    // console.log('✅ [ColorEditor] colorLegends 업데이트 완료:', schemeName);
                    
                    // ✅ 2단계: currentUser 변경 금지 (기존 상태 유지)
                    // currentUser는 이미 올바른 값이므로 변경하지 않음
                    // 저장된 색상은 colorLegends에 저장되어 있으므로 getPersonalizedParams()에서 자동으로 사용됨
                    
                    // 초기 상태 업데이트 (저장된 데이터로)
                    this.originalSchemeData = JSON.parse(JSON.stringify(schemeData));
                    this.updateApplyButtonState(false);
                    
                    // 썸네일 캐시 클리어 (색상 변경 후 강제 새로고침)
                    if (this.viewer.thumbnailManager) {
                        this.viewer.thumbnailManager.cache.clear();
                    }

                    // 피라미드 레벨 캐시 완전 초기화 (저장된 색상 적용을 위해 필수)
                    this.viewer.pyramidLevels = {};
                    if (this.viewer._pyramidLoading) {
                        this.viewer._pyramidLoading = new Set();
                    }
                    if (this.viewer.pyramidLoadingLevels) {
                        this.viewer.pyramidLoadingLevels.clear();
                    }
                    // 🔥 GPU 렌더러 캐시도 초기화
                    if (this.viewer.semiconductorRenderer) {
                        this.viewer.semiconductorRenderer.imagePyramid = {};
                        this.viewer.semiconductorRenderer.levelTextures.clear();
                    }
                    
                    // 캐시 버스팅을 위한 타임스탬프 추가
                    this.viewer._personalizedColorCacheBuster = Date.now();
                    this.viewer._previewSchemeOverride = null;
                    
                    // 8. 그리드/이미지 모드 유지하며 리로드 (모드 변경 없음)
                    if (this.viewer.gridMode) {
                        // 그리드 모드: 현재 그리드 유지
                        const currentImages = this.viewer.selectedImages || [];
                        if (currentImages.length > 0) {
                            // 디버그 로그 제거
                            // console.log("ColorEditor: Reloading grid without mode change");
                            await this.viewer.showGrid(currentImages, false);
                        }
                    } else if (this.viewer.selectedImagePath) {
                        // 피라미드 모드: 현재 이미지 유지
                        // 디버그 로그 제거
                        // console.log("ColorEditor: Reloading image without mode change");
                        await this.viewer.loadImage(this.viewer.selectedImagePath, false, null, true);
                        this.refreshNavigatorPreview();
                    }
                    
                    // 9. UI 업데이트
                    this.viewer.renderColorLegends();
                    this.viewer.showColorLegends();
                    
                    this.viewer?.showToast?.("색상이 적용되었습니다.", 1800);
                    await this.close();
                }
            } else {
                throw new Error('저장 실패');
            }
        } catch (error) {
            console.error('[ColorEditor] 저장 오류:', error);
            this.showError(error.message || '색상 스킴 저장 중 오류가 발생했습니다.');
            this.applyBtn.disabled = false;
        }
    }


    async handleReset() {
        if (this.activeTab === 'composite' || this.activeTab === 'measure' || this.activeTab === 'ratio') {
            return this.handleResetRatio();
        }
        // 기본값(default)으로 초기화 - 서버에서 최신 color-legends.json 로드
        try {
            // 서버에서 color-legends.json 다시 로드
            const response = await fetch('/logs/color-legends.json');
            if (!response.ok) {
                throw new Error('색상 스킴 로드 실패');
            }
            const legends = await response.json();
            
            // 프론트엔드 캐시 업데이트
            if (this.viewer) {
                this.viewer.colorLegends = legends;
            }
            
            // 서버에서 로드한 default scheme 사용
            const defaultScheme = getDefaultScheme(legends);
            
            // 스킴 이름은 현재 스킴 이름 유지 (예: 'anonymous')
            // 색상 값만 default scheme의 값으로 변경
            const schemeData = JSON.parse(JSON.stringify(defaultScheme));
            
            // 원래 스킴 데이터를 현재 스킴 이름으로 유지 (변경사항 감지용)
            // 초기화는 변경사항이므로 원래 데이터와 다르게 설정
            const currentOriginalScheme = legends[this.currentSchemeName];
            if (currentOriginalScheme) {
                // 원래 스킴 데이터를 유지 (변경사항 감지용)
                this.originalSchemeData = JSON.parse(JSON.stringify(currentOriginalScheme));
            } else {
                // 원래 스킴이 없으면 현재 default scheme을 원본으로 설정
                this.originalSchemeData = JSON.parse(JSON.stringify(defaultScheme));
            }
            
            // 색상 값만 default scheme으로 적용
            this.applySchemeToRows(schemeData);
            // 스킴 이름은 변경하지 않음 (현재 스킴 이름 유지)
            this.updateSchemeLabel(this.currentSchemeName);
            // 초기화는 변경사항이므로 적용 버튼 활성화
            this.updateApplyButtonState(true);
            this.clearError();
            this.hideDropdown();
            
            // 🔥 미리보기에 적용
            this.updatePreviewRealtime();
        } catch (error) {
            console.error('[ColorEditor] default scheme 로드 실패:', error);
            this.showError('기본 스킴을 불러오는 중 오류가 발생했습니다.');
        }
    }
    
    async handleRestore() {
        if (this.activeTab === 'composite' || this.activeTab === 'measure' || this.activeTab === 'ratio') {
            return this.handleRestoreRatio();
        }
        // color-legends.json에 저장된 scheme 값으로 복원 (서버에서 다시 로드)
        try {
            // 서버에서 color-legends.json 다시 로드
            const response = await fetch('/logs/color-legends.json');
            if (!response.ok) {
                throw new Error('색상 스킴 로드 실패');
            }
            const legends = await response.json();
            
            // 프론트엔드 캐시 업데이트
            if (this.viewer) {
                this.viewer.colorLegends = legends;
            }
            
            const savedSchemeData = legends[this.currentSchemeName];
            
            if (!savedSchemeData) {
                this.showError('저장된 스킴 데이터를 찾을 수 없습니다.');
                return;
            }
            
            // 저장된 scheme의 색상 값만 가져와서 현재 scheme에 적용
            const defaultScheme = getDefaultScheme(legends);
            const restoredSchemeData = {
                top: savedSchemeData.top || {},
                bottom: savedSchemeData.bottom || {},
                background: savedSchemeData.background || defaultScheme.background || '#FEFEFE',
                text: savedSchemeData.text || defaultScheme.text || '#000001'
            };
            
            // 저장된 scheme으로 적용
            this.applySchemeToRows(restoredSchemeData);
            
            // 원래 스킴 데이터를 현재 저장된 값으로 업데이트 (변경사항 감지용)
            this.originalSchemeData = JSON.parse(JSON.stringify(restoredSchemeData));
            
            // 스킴 이름은 변경하지 않음 (현재 스킴 이름 유지)
            this.updateSchemeLabel(this.currentSchemeName);
            
            // 저장된 값으로 복원했으므로 변경사항 없음 (적용 버튼 비활성화)
            this.updateApplyButtonState(false);
            this.clearError();
            this.hideDropdown();
            
            // 🔥 미리보기에 적용
            this.updatePreviewRealtime();
        } catch (error) {
            console.error('[ColorEditor] 저장된 스킴 복원 실패:', error);
            this.showError('저장된 스킴을 불러오는 중 오류가 발생했습니다.');
        }
    }

    updateSchemeLabel(name) {
        if (!this.schemeLabel) return;
        this.schemeLabel.textContent = `- ${name}`;
    }

    showError(message) {
        if (this.errorEl) {
            this.errorEl.textContent = message;
            this.errorEl.style.display = 'block';
        }
    }

    clearError() {
        if (this.errorEl) {
            this.errorEl.textContent = '';
            this.errorEl.style.display = 'none';
        }
    }

    // ========== Tab switching ==========

    switchTab(tab) {
        this.activeTab = tab;
        // Clear selection when switching tabs
        this.selectedCells.clear();
        this.updateCellSelection();
        // Update tab buttons
        const tabs = this.tabBar?.querySelectorAll('.color-editor-tab');
        tabs?.forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        // Update content visibility
        const panels = { fail: this.failContent, composite: this.compositeContent, measure: this.measureContent };
        for (const [key, panel] of Object.entries(panels)) {
            if (panel) {
                panel.style.display = tab === key ? 'block' : 'none';
                panel.classList.toggle('active', tab === key);
            }
        }
        // Check for changes on the active tab
        this.checkForChanges();
    }

    // ========== Ratio tab methods ==========

    /**
     * Load gradient from API for a given tab type.
     * @param {'composite'|'measure'} tabType
     */
    async _loadGradientColors(tabType, schemeName) {
        const apiPath = tabType === 'measure' ? '/api/measure-colors' : '/api/composite-colors';
        const rows = tabType === 'measure' ? this.measureRows : this.compositeRows;
        const originalKey = tabType === 'measure' ? 'originalMeasureData' : 'originalCompositeData';
        try {
            const loginId = schemeName || this.viewer?.getCurrentLoginId?.() || this.viewer?.currentUser || '';
            const resp = await fetch(`${apiPath}?scheme=${encodeURIComponent(loginId)}`);
            if (resp.ok) {
                const data = await resp.json();
                const gradData = {};
                if (data.keys && data.colors) {
                    data.keys.forEach((key, i) => {
                        gradData[key] = data.colors[i] || '#000000';
                    });
                }
                this[originalKey] = JSON.parse(JSON.stringify(gradData));
                this._applyGradientToRows(tabType, gradData);
                return;
            }
        } catch (e) {
            console.warn(`⚠️ ${tabType} colors 로드 실패, fallback:`, e);
        }
        // Fallback
        const legends = this.viewer?.colorLegends || {};
        const gradData = (legends[schemeName] || legends['default'] || {}).ratio || {};
        this[originalKey] = JSON.parse(JSON.stringify(gradData));
        this._applyGradientToRows(tabType, gradData);
    }

    /** Backward compat alias */
    async _loadRatioFromComposite(schemeName) {
        await this._loadGradientColors('composite', schemeName);
    }

    /**
     * Build gradient rows for composite or measure tab.
     * @param {'composite'|'measure'} tabType
     */
    _buildGradientRows(tabType) {
        const tbody = tabType === 'measure' ? this.measureTableBody : this.compositeTableBody;
        if (!tbody) return;
        tbody.innerHTML = '';
        const rows = [];

        for (let step = 0; step <= 100; step += 10) {
            const key = `quantile${step}`;
            const label = `${step}%`;
            const tr = document.createElement('tr');
            tr.dataset.key = key;

            const labelTd = document.createElement('td');
            labelTd.className = 'color-editor-label';
            labelTd.textContent = label;

            const hexTd = document.createElement('td');
            const hexContainer = document.createElement('div');
            hexContainer.className = 'color-editor-hex';
            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.maxLength = 7;
            hexInput.placeholder = '#RRGGBB';
            // Selection support
            const hexCellId = `${tabType}-hex-${this.cellIdCounter++}`;
            hexInput.dataset.cellId = hexCellId;
            hexInput.dataset.cellType = 'hex';
            hexInput.dataset.rowIndex = String(rows.length);
            hexInput.dataset.tabType = tabType;
            hexContainer.appendChild(hexInput);
            hexTd.appendChild(hexContainer);

            const rgbTd = document.createElement('td');
            const rgbContainer = document.createElement('div');
            rgbContainer.className = 'color-editor-rgb';
            const rgbInputs = ['R', 'G', 'B'].map((ch, idx) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.min = '0';
                input.max = '255';
                input.placeholder = ch;
                const rgbCellId = `${tabType}-rgb-${this.cellIdCounter++}`;
                input.dataset.cellId = rgbCellId;
                input.dataset.cellType = 'rgb';
                input.dataset.channelIndex = String(idx);
                input.dataset.rowIndex = String(rows.length);
                input.dataset.tabType = tabType;
                rgbContainer.appendChild(input);
                return input;
            });
            rgbTd.appendChild(rgbContainer);

            const pickerTd = document.createElement('td');
            pickerTd.className = 'color-editor-picker';
            const colorPreview = document.createElement('div');
            colorPreview.className = 'color-editor-preview';
            colorPreview.style.cssText = 'width:48px;height:24px;border:1px solid #444;border-radius:4px;cursor:pointer;';
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = '#000000';
            colorInput.style.cssText = 'position:absolute;opacity:0;width:48px;height:24px;cursor:pointer;pointer-events:auto;top:0;left:0;';
            const pickerWrapper = document.createElement('div');
            pickerWrapper.style.cssText = 'position:relative;display:inline-block;';
            pickerWrapper.appendChild(colorPreview);
            pickerWrapper.appendChild(colorInput);
            colorPreview.addEventListener('click', (e) => { e.stopPropagation(); colorInput.click(); });
            pickerTd.appendChild(pickerWrapper);

            tr.appendChild(labelTd);
            tr.appendChild(hexTd);
            tr.appendChild(rgbTd);
            tr.appendChild(pickerTd);
            tbody.appendChild(tr);

            const row = { key, hexInput, rgbInputs, colorInput, colorPreview };

            hexInput.addEventListener('change', () => { this._syncGradientFromHex(tabType, row); this.checkForChanges(); this._updateGradientPreview(tabType); });
            hexInput.addEventListener('input', () => { this._clearGradientError(tabType); this.checkForChanges(); this._updateGradientPreview(tabType); });
            // Selection events
            hexInput.addEventListener('mousedown', (e) => this.handleCellMouseDown(e, hexCellId, 'hex'));
            hexInput.addEventListener('keydown', (e) => this.handleInputKeyDown(e, hexCellId, 'hex'), true);
            rgbInputs.forEach((input, idx) => {
                input.addEventListener('change', () => { this._syncGradientFromRgb(tabType, row); this.checkForChanges(); this._updateGradientPreview(tabType); });
                input.addEventListener('input', () => { this._clearGradientError(tabType); this.checkForChanges(); this._updateGradientPreview(tabType); });
                input.addEventListener('mousedown', (e) => this.handleCellMouseDown(e, input.dataset.cellId, 'rgb'));
                input.addEventListener('keydown', (e) => this.handleInputKeyDown(e, input.dataset.cellId, 'rgb'), true);
            });
            colorInput.addEventListener('input', () => { this._syncGradientFromPicker(tabType, row); this.checkForChanges(); this._updateGradientPreview(tabType); });
            colorInput.addEventListener('change', () => { this.checkForChanges(); this._updateGradientPreview(tabType); });

            rows.push(row);
        }
        if (tabType === 'measure') {
            this.measureRows = rows;
        } else {
            this.compositeRows = rows;
            this.ratioRows = rows; // backward compat
        }
    }

    /** Backward compat */
    buildRatioRows() { this._buildGradientRows('composite'); }

    _setGradientRowHex(row, hex) {
        row.hexInput.value = hex;
        row.colorInput.value = hex;
        if (row.colorPreview) {
            row.colorPreview.style.backgroundColor = hex;
        }
        const rgb = hexToRgb(hex);
        if (rgb) {
            row.rgbInputs[0].value = rgb.r;
            row.rgbInputs[1].value = rgb.g;
            row.rgbInputs[2].value = rgb.b;
        } else {
            row.rgbInputs.forEach(i => (i.value = ''));
        }
    }

    _syncGradientFromHex(tabType, row) {
        const value = normalizeHex(row.hexInput.value);
        if (!value) {
            this._showGradientError(tabType, 'HEX 색상은 #RRGGBB 형식이어야 합니다.');
            return;
        }
        this._setGradientRowHex(row, value);
        this._clearGradientError(tabType);
    }

    _syncGradientFromRgb(tabType, row) {
        const hex = rgbToHex(row.rgbInputs[0].value, row.rgbInputs[1].value, row.rgbInputs[2].value);
        if (!hex) {
            this._showGradientError(tabType, 'RGB 값은 0~255 사이의 숫자여야 합니다.');
            return;
        }
        this._setGradientRowHex(row, hex);
        this._clearGradientError(tabType);
    }

    _syncGradientFromPicker(tabType, row) {
        const hex = normalizeHex(row.colorInput.value);
        if (!hex) return;
        this._setGradientRowHex(row, hex);
        this._clearGradientError(tabType);
    }

    _getGradientErrorEl(tabType) {
        return tabType === 'measure' ? this.measureErrorEl : this.compositeErrorEl;
    }

    _showGradientError(tabType, msg) {
        const el = this._getGradientErrorEl(tabType);
        if (el) { el.textContent = msg; el.style.display = 'block'; }
    }

    _clearGradientError(tabType) {
        const el = this._getGradientErrorEl(tabType);
        if (el) { el.textContent = ''; el.style.display = 'none'; }
    }

    _applyGradientToRows(tabType, gradData) {
        const defaults = {
            "quantile0": "#0000FF", "quantile10": "#0066FF", "quantile20": "#00CCFF",
            "quantile30": "#00FFCC", "quantile40": "#00FF00", "quantile50": "#66FF00",
            "quantile60": "#CCFF00", "quantile70": "#FFCC00", "quantile80": "#FF6600",
            "quantile90": "#FF3300", "quantile100": "#FF0000"
        };
        const rows = tabType === 'measure' ? this.measureRows : this.compositeRows;
        const data = gradData || {};
        rows.forEach(row => {
            const hex = normalizeHex(data[row.key]) || normalizeHex(defaults[row.key]) || '#000000';
            this._setGradientRowHex(row, hex);
        });
    }

    _getCurrentGradientData(tabType) {
        const rows = tabType === 'measure' ? this.measureRows : this.compositeRows;
        const data = {};
        rows.forEach(row => {
            const hex = normalizeHex(row.hexInput.value);
            if (hex) data[row.key] = hex;
        });
        return data;
    }

    // Backward compat aliases
    setRatioRowHex(row, hex) { this._setGradientRowHex(row, hex); }
    syncRatioFromHex(row) { this._syncGradientFromHex('composite', row); }
    syncRatioFromRgb(row) { this._syncGradientFromRgb('composite', row); }
    syncRatioFromPicker(row) { this._syncGradientFromPicker('composite', row); }
    showRatioError(msg) { this._showGradientError('composite', msg); }
    clearRatioError() { this._clearGradientError('composite'); }
    applyRatioToRows(ratioData) { this._applyGradientToRows('composite', ratioData); }
    getCurrentRatioData() { return this._getCurrentGradientData('composite'); }

    async handleApplyRatio() {
        await this._handleApplyGradient(this.activeTab === 'measure' ? 'measure' : 'composite');
    }

    async _handleApplyGradient(tabType) {
        if (!this.applyBtn || this.applyBtn.disabled) return;

        const gradData = this._getCurrentGradientData(tabType);
        const schemeName = this.currentSchemeName;
        if (!schemeName) {
            this._showGradientError(tabType, '스킴 이름을 찾을 수 없습니다.');
            return;
        }

        const colorsArray = [];
        for (let step = 0; step <= 100; step += 10) {
            const key = `quantile${step}`;
            colorsArray.push(gradData[key] || '#000000');
        }

        this.applyBtn.disabled = true;
        this._clearGradientError(tabType);

        try {
            const apiPath = tabType === 'measure' ? '/api/measure-colors' : '/api/composite-colors';
            const loginId = this.viewer?.getCurrentLoginId?.() || this.viewer?.currentUser || '';
            const response = await fetch(`${apiPath}?LoginId=${encodeURIComponent(loginId)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ colors: colorsArray }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `저장 실패 (${response.status})`);
            }

            const result = await response.json();
            if (result.colors) {
                const originalKey = tabType === 'measure' ? 'originalMeasureData' : 'originalCompositeData';
                this[originalKey] = JSON.parse(JSON.stringify(gradData));
                this.updateApplyButtonState(false);

                if (this.viewer) {
                    this.viewer._ratioGradientCache = null;
                }
                this.viewer._personalizedColorCacheBuster = Date.now();
                if (this.viewer.thumbnailManager) {
                    this.viewer.thumbnailManager.cache.clear();
                }
                if (this.viewer.gridMode) {
                    if (typeof this.viewer.refreshGridThumbnailsWithCurrentParams === 'function') {
                        this.viewer.refreshGridThumbnailsWithCurrentParams();
                    }
                } else if (this.viewer.selectedImagePath) {
                    await this.viewer.loadImage(this.viewer.selectedImagePath, false, null, true);
                }

                const label = tabType === 'measure' ? 'Measure' : 'Composite';
                this.viewer?.showToast?.(`${label} 색상이 적용되었습니다.`, 1800);
                this._savedRatioGradientCache = null; // 복원 방지
                await this.close();
            } else {
                throw new Error('저장 실패');
            }
        } catch (error) {
            console.error(`[ColorEditor] ${tabType} 저장 오류:`, error);
            this._showGradientError(tabType, error.message || '색상 저장 중 오류가 발생했습니다.');
            this.applyBtn.disabled = false;
        }
    }

    async handleResetRatio() {
        const tabType = this.activeTab === 'measure' ? 'measure' : 'composite';
        const defaults = {};
        for (let step = 0; step <= 100; step += 10) {
            const gb = Math.round(255 * (1 - step / 100));
            const hex = gb.toString(16).padStart(2, '0').toUpperCase();
            defaults[`quantile${step}`] = `#FF${hex}${hex}`;
        }
        this._applyGradientToRows(tabType, defaults);
        this.updateApplyButtonState(true);
        this._clearGradientError(tabType);
    }

    async handleRestoreRatio() {
        const tabType = this.activeTab === 'measure' ? 'measure' : 'composite';
        try {
            await this._loadGradientColors(tabType, this.currentSchemeName);
            this.updateApplyButtonState(false);
            this._clearGradientError(tabType);
        } catch (error) {
            this._showGradientError(tabType, '저장된 스킴을 불러오는 중 오류가 발생했습니다.');
        }
    }

    /**
     * Gradient (composite/measure) 실시간 미리보기.
     * measure + 단일 이미지 모드에서 overlay가 활성화되어 있으면 직접 갱신.
     */
    _updateGradientPreview(tabType) {
        if (!this.viewer) return;

        if (this._gradientPreviewTimeout) {
            clearTimeout(this._gradientPreviewTimeout);
        }

        this._gradientPreviewTimeout = setTimeout(() => {
            try {
                const gradData = this._getCurrentGradientData(tabType);
                const colorsArray = [];
                for (let step = 0; step <= 100; step += 10) {
                    colorsArray.push(gradData[`quantile${step}`] || '#000000');
                }

                if (tabType === 'measure') {
                    // 단일 이미지: 클라이언트 overlay 직접 갱신
                    this.viewer._ratioGradientCache = colorsArray;
                    if (!this.viewer.gridMode &&
                        (this.viewer.overlayMode === 'f' || this.viewer.overlayMode === 'q') &&
                        this.viewer.chipAnnotator) {
                        this.viewer.chipAnnotator.setOverlayMode(this.viewer.overlayMode, {
                            gradientStops: colorsArray,
                            itemKey: this.viewer._ratioActiveItemKey,
                        });
                    }
                }
                // composite 미리보기: 서버 recolor가 필요하므로 생략 (적용 후 확인)
            } catch (error) {
                console.warn(`ColorEditor: ${tabType} preview failed`, error);
            }
        }, 500);
    }

    /**
     * Gradient 탭에서 다른 사용자 scheme 적용.
     * Fail 탭의 handleSchemeLoad와 유사하게 동작.
     */
    async _handleGradientSchemeLoad(name) {
        if (!name) return;
        const tabType = this.activeTab;
        if (tabType !== 'composite' && tabType !== 'measure') return;

        try {
            const apiPath = tabType === 'measure' ? '/api/measure-colors' : '/api/composite-colors';
            const resp = await fetch(`${apiPath}?LoginId=${encodeURIComponent(name)}`);
            if (!resp.ok) throw new Error(`API ${resp.status}`);
            const data = await resp.json();
            const gradData = {};
            if (data.keys && data.colors) {
                data.keys.forEach((key, i) => {
                    gradData[key] = data.colors[i] || '#000000';
                });
            }
            this._applyGradientToRows(tabType, gradData);
            this.updateApplyButtonState(true);
            this._clearGradientError(tabType);
            this._updateGradientPreview(tabType);
        } catch (e) {
            this._showGradientError(tabType, '해당 사용자의 색상을 불러올 수 없습니다.');
        }
    }

    // ─── Helpers for active tab rows/tbody ───
    _getActiveRows() {
        if (this.activeTab === 'measure') return this.measureRows;
        if (this.activeTab === 'composite') return this.compositeRows;
        return this.rows; // fail tab
    }

    _getActiveTableBody() {
        if (this.activeTab === 'measure') return this.measureTableBody;
        if (this.activeTab === 'composite') return this.compositeTableBody;
        return this.tableBody; // fail tab
    }

    // 셀 선택 관련 메서드들
    handleCellMouseDown(e, cellId, cellType) {
        if (!e) return;
        
        // 🔥 우클릭 버튼(button === 2)인 경우 셀 선택 변경하지 않음
        if (e.button === 2) {
            return;
        }
        
        const isCtrl = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        const rowIndex = parseInt(e.target.dataset.rowIndex || '0');
        const channelIndex = cellType === 'rgb' ? parseInt(e.target.dataset.channelIndex || '0') : null;
        
        if (isShift && this.lastSelectedCell) {
            const startRowIndex = this.lastSelectedCell.rowIndex;
            const endRowIndex = rowIndex;
            const startCellType = this.lastSelectedCell.cellType;
            const startChannelIndex = this.lastSelectedCell.channelIndex;

            if (startCellType === cellType) {
                const minRow = Math.min(startRowIndex, endRowIndex);
                const maxRow = Math.max(startRowIndex, endRowIndex);
                const activeRows = this._getActiveRows();

                this.selectedCells.clear();
                for (let i = minRow; i <= maxRow; i++) {
                    if (i >= 0 && i < activeRows.length) {
                        if (cellType === 'hex') {
                            const hexInput = activeRows[i].hexInput;
                            if (hexInput && hexInput.dataset.cellId) {
                                this.selectedCells.add(hexInput.dataset.cellId);
                            }
                        } else if (cellType === 'rgb') {
                            const minChannel = Math.min(startChannelIndex, channelIndex);
                            const maxChannel = Math.max(startChannelIndex, channelIndex);
                            const rgbInputs = activeRows[i].rgbInputs;
                            if (rgbInputs) {
                                for (let ch = minChannel; ch <= maxChannel; ch++) {
                                    if (rgbInputs[ch] && rgbInputs[ch].dataset.cellId) {
                                        this.selectedCells.add(rgbInputs[ch].dataset.cellId);
                                    }
                                }
                            }
                        }
                    }
                }
                this.updateCellSelection();
            }
        } else if (!isCtrl && !isShift) {
            // 일반 클릭: 선택 초기화
            this.selectedCells.clear();
            this.updateCellSelection();
        }
        
        if (!isShift) {
            // Shift가 아닐 때만 단일 셀 선택/추가
            this.selectCell(cellId, isCtrl);
        }

        // 마지막 선택된 셀 업데이트
        this.lastSelectedCell = { cellId, cellType, rowIndex, channelIndex };

        this.dragStartCell = { cellId, cellType, rowIndex, channelIndex };
        this.isDragging = true;
        // 포커스를 강제 이동시켜 Ctrl+C/V 키 이벤트가 모달에서 처리되도록 함
        if (e.target && typeof e.target.focus === 'function') {
            e.target.focus();
        }
        e.preventDefault();
    }

    handleCellMouseMove(e) {
        if (!this.isDragging || !this.dragStartCell) return;
        
        // 마우스 위치에서 가장 가까운 셀 찾기
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (!target) return;
        
        // input 요소 또는 그 부모 요소에서 cellId 찾기
        let cellElement = target;
        while (cellElement && !cellElement.dataset?.cellId) {
            cellElement = cellElement.parentElement;
        }
        if (!cellElement || !cellElement.dataset.cellId) return;
        
        const startRowIndex = this.dragStartCell.rowIndex;
        const endRowIndex = parseInt(cellElement.dataset.rowIndex || '0');
        const startCellType = this.dragStartCell.cellType;
        const endCellType = cellElement.dataset.cellType;
        const startChannelIndex = this.dragStartCell.channelIndex;
        const endChannelIndex = endCellType === 'rgb' ? parseInt(cellElement.dataset.channelIndex || '0') : null;
        
        // 같은 타입의 셀만 선택 (hex끼리, rgb끼리)
        if (startCellType !== endCellType) return;
        
        const minRow = Math.min(startRowIndex, endRowIndex);
        const maxRow = Math.max(startRowIndex, endRowIndex);
        
        const activeRows = this._getActiveRows();
        this.selectedCells.clear();
        for (let i = minRow; i <= maxRow; i++) {
            if (i >= 0 && i < activeRows.length) {
                if (startCellType === 'hex') {
                    const hexInput = activeRows[i].hexInput;
                    if (hexInput && hexInput.dataset.cellId) {
                        this.selectedCells.add(hexInput.dataset.cellId);
                    }
                } else if (startCellType === 'rgb') {
                    const minChannel = Math.min(startChannelIndex, endChannelIndex);
                    const maxChannel = Math.max(startChannelIndex, endChannelIndex);
                    const rgbInputs = activeRows[i].rgbInputs;
                    if (rgbInputs) {
                        for (let ch = minChannel; ch <= maxChannel; ch++) {
                            if (rgbInputs[ch] && rgbInputs[ch].dataset.cellId) {
                                this.selectedCells.add(rgbInputs[ch].dataset.cellId);
                            }
                        }
                    }
                }
            }
        }
        this.updateCellSelection();
    }

    handleCellMouseUp(e) {
        if (this.isDragging) {
            this.isDragging = false;
            this.dragStartCell = null;
        }
    }

    handleContextMenu(e) {
        // 모달 내부에서만 처리
        if (!this.modal || !this.modal.contains(e.target)) {
            return;
        }
        
        // 브라우저 기본 컨텍스트 메뉴 방지
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // 🔥 우클릭 시 셀 선택 변경하지 않음 (현재 선택 유지)
        // 셀 선택을 변경하는 코드 없음
        
        console.log('[ColorEditor] 컨텍스트 메뉴 표시:', e.clientX, e.clientY, e.target);
        this.showContextMenu(e.clientX, e.clientY);
    }

    ensureContextMenu() {
        if (this.contextMenu) {
            // 메뉴 항목이 이미 있으면 그대로 반환
            return this.contextMenu;
        }
        
        const menu = document.createElement('div');
        menu.className = 'color-editor-context-menu';
        menu.style.cssText = `
            position: fixed;
            z-index: 30001;
            background: #222;
            color: #fff;
            border: 1px solid #444;
            border-radius: 6px;
            padding: 6px 0;
            min-width: 160px;
            box-shadow: 0 8px 20px rgba(0,0,0,0.35);
            display: none;
            pointer-events: auto;
        `;
        
        // 복사하기 항목
        const copyItem = document.createElement('div');
        copyItem.className = 'context-menu-item';
        copyItem.textContent = '복사하기';
        copyItem.style.cssText = `
            padding: 8px 14px;
            cursor: pointer;
            font-size: 13px;
            user-select: none;
            transition: background-color 0.15s;
        `;
        copyItem.addEventListener('mouseenter', () => {
            copyItem.style.backgroundColor = '#333';
        });
        copyItem.addEventListener('mouseleave', () => {
            copyItem.style.backgroundColor = 'transparent';
        });
        copyItem.addEventListener('click', () => {
            this.hideContextMenu();
            if (this.selectedCells.size > 0) {
                this.copySelectedCells();
            } else {
                this.viewer?.showToast?.('복사할 셀이 선택되지 않았습니다.', 1500);
            }
        });
        menu.appendChild(copyItem);
        
        // 구분선
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px;
            background: #444;
            margin: 4px 0;
        `;
        menu.appendChild(separator);
        
        // 붙여넣기 항목
        const pasteItem = document.createElement('div');
        pasteItem.className = 'context-menu-item';
        pasteItem.textContent = '붙여넣기';
        pasteItem.style.cssText = `
            padding: 8px 14px;
            cursor: pointer;
            font-size: 13px;
            user-select: none;
            transition: background-color 0.15s;
        `;
        pasteItem.addEventListener('mouseenter', () => {
            pasteItem.style.backgroundColor = '#333';
        });
        pasteItem.addEventListener('mouseleave', () => {
            pasteItem.style.backgroundColor = 'transparent';
        });
        pasteItem.addEventListener('click', async () => {
            this.hideContextMenu();
            if (this.selectedCells.size > 0) {
                try {
                    const text = await navigator.clipboard.readText();
                    if (text) this.pasteToSelectedCells(text);
                    else this.viewer?.showToast?.('클립보드가 비어 있습니다.', 1500);
                } catch (err) {
                    this.viewer?.showToast?.('클립보드 접근이 차단되었습니다. Ctrl+V를 사용하세요.', 2000);
                }
            } else {
                this.viewer?.showToast?.('붙여넣을 셀이 선택되지 않았습니다.', 1500);
            }
        });
        menu.appendChild(pasteItem);
        
        document.body.appendChild(menu);
        this.contextMenu = menu;
        return menu;
    }

    showContextMenu(x, y) {
        const menu = this.ensureContextMenu();
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.style.display = 'block';
        console.log('[ColorEditor] 컨텍스트 메뉴 표시됨:', menu.style.display, menu.style.left, menu.style.top);
        setTimeout(() => {
            document.addEventListener('click', this.boundHideContextMenu, { once: true });
            document.addEventListener('contextmenu', this.boundHideContextMenu, { once: true });
        }, 0);
    }

    hideContextMenu() {
        if (this.contextMenu) {
            this.contextMenu.style.display = 'none';
        }
    }

    selectCell(cellId, addToSelection = false) {
        if (!addToSelection) {
            this.selectedCells.clear();
        }
        if (cellId) {
            this.selectedCells.add(cellId);
            const tbody = this._getActiveTableBody();
            const input = tbody?.querySelector(`input[data-cell-id="${cellId}"]`);
            if (input) {
                this.lastSelectedCell = {
                    cellId,
                    cellType: input.dataset.cellType,
                    rowIndex: parseInt(input.dataset.rowIndex || '0')
                };
            }
        }
        this.updateCellSelection();
    }

    updateCellSelection() {
        // Clear all tabs
        for (const tbody of [this.tableBody, this.compositeTableBody, this.measureTableBody]) {
            const allInputs = tbody?.querySelectorAll('input[data-cell-id]') || [];
            allInputs.forEach(input => input.classList.remove('cell-selected'));
        }
        // Apply selection on active tab
        const tbody = this._getActiveTableBody();
        this.selectedCells.forEach(cellId => {
            const input = tbody?.querySelector(`input[data-cell-id="${cellId}"]`);
            if (input) {
                input.classList.add('cell-selected');
            }
        });
    }

    handleInputKeyDown(e, cellId, cellType) {
        // 입력 필드에서 Ctrl+C: 선택된 셀 복사
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && this.selectedCells.size > 0) {
            try { e.target.setSelectionRange?.(0, 0); } catch (_) { /* ignore */ }
            this.copySelectedCells();
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        }

        // Ctrl+V: keydown을 막지 않아야 native paste 이벤트가 발생함
        // _handlePasteEvent에서 처리
    }

    handleCellKeyDown(e) {
        // Ctrl+C: 복사 (선택된 셀이 있을 때만)
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && this.selectedCells.size > 0) {
            this.copySelectedCells();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // Ctrl+V: native paste 이벤트가 _handlePasteEvent에서 처리
    }

    copySelectedCells() {
        if (this.selectedCells.size === 0) {
            console.log('[ColorEditor] 복사할 셀이 선택되지 않았습니다.');
            return;
        }
        const tbody = this._getActiveTableBody();
        const activeRows = this._getActiveRows();

        const sortedCells = Array.from(this.selectedCells).sort((a, b) => {
            const inputA = tbody?.querySelector(`input[data-cell-id="${a}"]`);
            const inputB = tbody?.querySelector(`input[data-cell-id="${b}"]`);
            if (!inputA || !inputB) return 0;
            const rowA = parseInt(inputA.dataset.rowIndex || '0');
            const rowB = parseInt(inputB.dataset.rowIndex || '0');
            if (rowA !== rowB) return rowA - rowB;
            if (inputA.dataset.cellType === 'hex') return -1;
            if (inputB.dataset.cellType === 'hex') return 1;
            return 0;
        });

        const values = sortedCells.map(cellId => {
            const input = tbody?.querySelector(`input[data-cell-id="${cellId}"]`);
            if (!input) return '';

            if (input.dataset.cellType === 'hex') {
                return input.value || '';
            } else if (input.dataset.cellType === 'rgb') {
                const rowIndex = parseInt(input.dataset.rowIndex || '0');
                const row = activeRows[rowIndex];
                if (row && row.rgbInputs) {
                    const r = row.rgbInputs[0]?.value || '';
                    const g = row.rgbInputs[1]?.value || '';
                    const b = row.rgbInputs[2]?.value || '';
                    return `${r},${g},${b}`;
                }
            }
            return '';
        }).filter(v => v);
        
        if (values.length > 0) {
            const text = values.join('\n');
            console.log('[ColorEditor] 복사할 값:', text);
            navigator.clipboard.writeText(text).then(() => {
                console.log('[ColorEditor] 클립보드에 복사 완료');
                this.viewer?.showToast?.(`${values.length}개 셀 복사됨`, 1500);
            }).catch((err) => {
                console.error('[ColorEditor] 클립보드 복사 실패:', err);
                // Fallback
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    document.execCommand('copy');
                    this.viewer?.showToast?.(`${values.length}개 셀 복사됨`, 1500);
                } catch (e) {
                    console.error('[ColorEditor] execCommand 복사 실패:', e);
                }
                document.body.removeChild(textarea);
            });
        } else {
            console.log('[ColorEditor] 복사할 값이 없습니다.');
        }
    }

    /**
     * Native paste event handler.
     * clipboard.readText()는 권한이 필요하지만 paste 이벤트의 clipboardData는 권한 없이 사용 가능.
     */
    _handlePasteEvent(e) {
        if (this.selectedCells.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const text = (e.clipboardData || window.clipboardData)?.getData('text');
        if (text) {
            this.pasteToSelectedCells(text);
        }
    }

    pasteToSelectedCells(pastedText) {
        if (!pastedText || !pastedText.trim()) return;

        const lines = pastedText.split(/\r?\n/).map(line => line.trim()).filter(line => line);
        if (lines.length === 0) return;

        const tbody = this._getActiveTableBody();
        const activeRows = this._getActiveRows();
        const isGradientTab = this.activeTab === 'composite' || this.activeTab === 'measure';

        const sortedCells = Array.from(this.selectedCells).sort((a, b) => {
            const inputA = tbody?.querySelector(`input[data-cell-id="${a}"]`);
            const inputB = tbody?.querySelector(`input[data-cell-id="${b}"]`);
            if (!inputA || !inputB) return 0;
            const rowA = parseInt(inputA.dataset.rowIndex || '0');
            const rowB = parseInt(inputB.dataset.rowIndex || '0');
            if (rowA !== rowB) return rowA - rowB;
            if (inputA.dataset.cellType === 'hex') return -1;
            if (inputB.dataset.cellType === 'hex') return 1;
            return 0;
        });
        const anchorInput = tbody?.querySelector(`input[data-cell-id="${sortedCells[0]}"]`);
        if (!anchorInput) return;
        const anchorType = anchorInput.dataset.cellType;
        const anchorRowIndex = parseInt(anchorInput.dataset.rowIndex || '0');

        // 선택 타입이 다른 셀은 무시
        const filteredCells = sortedCells.map(cellId => tbody?.querySelector(`input[data-cell-id="${cellId}"]`))
            .filter(input => input && input.dataset.cellType === anchorType);

        const getTargetInput = (offset) => {
            if (offset < filteredCells.length) {
                return filteredCells[offset];
            }
            const targetRowIndex = anchorRowIndex + offset;
            const row = activeRows[targetRowIndex];
            if (!row) return null;
            if (anchorType === 'hex') return row.hexInput;
            if (anchorType === 'rgb') return row.rgbInputs?.[0];
            return null;
        };

        let successCount = 0;
        lines.forEach((line, idx) => {
            const input = getTargetInput(idx);
            if (!input) return;

            const rowIndex = parseInt(input.dataset.rowIndex || '0');
            const row = activeRows[rowIndex];
            if (!row) return;

            if (input.dataset.cellType === 'hex') {
                const hex = normalizeHex(line);
                if (hex) {
                    if (isGradientTab) {
                        this._setGradientRowHex(row, hex);
                    } else {
                        this.setRowHex(row, hex);
                    }
                    successCount++;
                }
            } else if (input.dataset.cellType === 'rgb') {
                const values = line.split(/[,\s\t]+/).map(v => v.trim()).filter(v => v);
                if (values.length >= 3) {
                    const r = Number(values[0]);
                    const g = Number(values[1]);
                    const b = Number(values[2]);
                    if (Number.isFinite(r) && r >= 0 && r <= 255 &&
                        Number.isFinite(g) && g >= 0 && g <= 255 &&
                        Number.isFinite(b) && b >= 0 && b <= 255) {
                        row.rgbInputs[0].value = Math.round(r);
                        row.rgbInputs[1].value = Math.round(g);
                        row.rgbInputs[2].value = Math.round(b);
                        if (isGradientTab) {
                            this._syncGradientFromRgb(this.activeTab, row);
                        } else {
                            this.syncFromRgb(row);
                        }
                        successCount++;
                    }
                }
            }
        });

        if (successCount > 0) {
            this.checkForChanges();
            this.updatePreviewRealtime();
        }
    }
}
