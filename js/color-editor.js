const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288', 'B290', 'B291'];

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
        this.schemeDropdown = this.modal ? this.modal.querySelector('#color-editor-scheme-dropdown') : null;
        this.boundKeyHandler = this.handleKeyDown.bind(this);
        this.boundOutsideClick = this.handleOutsideClick.bind(this);
        this.activeSchemeOptions = [];
        this.rows = [];
        this.originalSchemeData = null;
        this._setupDone = false;
        this.selectedSchemeIndex = -1; // 키보드 네비게이션용
        this.originalCheckboxState = null; // 모달 열 때 체크박스 상태 저장용
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
        this._contextMenuBound = false;
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
            // 입력 시에는 리스트를 열지 않음 (엔터나 검색 버튼으로만 열림)
        }
        this.buildRows();
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
            labelTd.textContent = key;

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

        TOP_KEYS.forEach((key) => buildRow('top', key));
        BOTTOM_KEYS.forEach((key) => buildRow('bottom', key));
        buildRow('background', 'Background');
        buildRow('text', 'Text');

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

    open() {
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
            this.schemeDropdown = this.modal.querySelector('#color-editor-scheme-dropdown');
            // 이벤트 리스너가 아직 설정되지 않았으면 설정
            if (!this._setupDone) {
                this.setup();
                this._setupDone = true;
            }
        }
        const legends = this.viewer?.colorLegends || {};
        // LoginId가 있으면 해당 scheme 사용, 없으면 'change' 사용
        let schemeName = this.viewer?.currentUser;
        
        // LoginId가 null이거나 undefined이면 'change' 사용
        if (!schemeName || schemeName === 'null' || schemeName === 'undefined') {
            schemeName = 'change';
        }
        
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
        
        this.populateSchemeOptions();
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
        
        this.modal.classList.add('is-open');
        this.modal.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', this.boundKeyHandler);
        document.addEventListener('mousedown', this.boundOutsideClick);
        // 디버그 로그 제거
    }

    async close() {
        if (!this.modal) return;
        
        // 그리드 모드나 이미지가 없으면 원래 색상 복원 불필요
        if (!this.viewer || (this.viewer.gridMode && !this.viewer.selectedImagePath)) {
            // 모달만 닫기
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

        // 🔥 취소 시 원래 색상으로 되돌리기
        try {
            // 1. 원래 scheme으로 메모리 복원
            if (this.originalSchemeData && this.currentSchemeName) {
                if (this.viewer.colorLegends) {
                    this.viewer.colorLegends[this.currentSchemeName] = 
                        JSON.parse(JSON.stringify(this.originalSchemeData));
                }

                // 2. __preview_ 임시 스킴 삭제 (메모리 + 서버)
                const previewName = `__preview_${this.currentSchemeName}`;
                if (this.viewer.colorLegends) {
                    delete this.viewer.colorLegends[previewName];
                }
                fetch(`/api/color-scheme`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ schemeName: previewName }),
                }).catch(() => {});

                // 3. 캐시 초기화
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
                    await this.viewer.loadImage(this.viewer.selectedImagePath);
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
                    // 🔥 드롭다운이 열려있을 때 Enter: 선택된 항목 로드
                    if (this.selectedSchemeIndex >= 0 && this.selectedSchemeIndex < items.length) {
                        const selectedItem = items[this.selectedSchemeIndex];
                        const schemeName = selectedItem.dataset.name;
                        if (schemeName) {
                            this.handleSchemeLoad(schemeName);
                        }
                    } else if (this.selectedSchemeIndex === -1 && items.length > 0) {
                        // 선택된 항목이 없으면 첫 번째 항목 선택
                        this.selectedSchemeIndex = 0;
                        this.updateSchemeSelection(items);
                        const firstItem = items[0];
                        const schemeName = firstItem.dataset.name;
                        if (schemeName) {
                            this.handleSchemeLoad(schemeName);
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
                !this.schemeLoadBtn?.contains(event.target)) {
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
        const legends = this.viewer?.colorLegends || {};
        const target = name || this.schemeSearchInput?.value?.trim() || 'change';
        
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
        
        // 🔥 미리보기에 적용
        this.updatePreviewRealtime();
    }

    populateSchemeOptions(shouldOpen = false) {
        if (!this.schemeDropdown) return;
        const legends = this.viewer?.colorLegends || {};
        const filter = this.schemeSearchInput?.value?.trim().toLowerCase() || '';
        const entries = Object.keys(legends);
        
        // 'default' 제외하고 필터링 (scheme명, Username, DeptName 모두 검색)
        const matches = entries.filter((name) => {
            if (name === 'default') return false;
            
            const schemeData = legends[name] || {};
            const schemeName = name.toLowerCase();
            const username = (schemeData.Username || '').toLowerCase();
            const deptName = (schemeData.DeptName || '').toLowerCase();
            
            // 필터가 없으면 모두 표시
            if (!filter) return true;
            
            // scheme명, Username, DeptName 중 하나라도 매칭되면 표시
            return schemeName.includes(filter) || 
                   username.includes(filter) || 
                   deptName.includes(filter);
        });
        
        // 최대 10개로 제한
        const limitedMatches = matches.slice(0, 10);
        
        this.schemeDropdown.innerHTML = '';
        this.selectedSchemeIndex = -1; // 리스트 갱신 시 선택 초기화
        
        // 검색 결과 없음 표시
        if (limitedMatches.length === 0) {
            const noResultsItem = document.createElement('div');
            noResultsItem.style.cssText = 'padding: 20px 12px; text-align: center; color: #999; font-size: 13px;';
            noResultsItem.textContent = '검색 결과 없음';
            this.schemeDropdown.appendChild(noResultsItem);
        } else {
            limitedMatches.forEach((name, index) => {
                const schemeData = legends[name] || {};
                const username = schemeData.Username || '';
                const deptName = schemeData.DeptName || '';
                
                const item = document.createElement('div');
                item.className = 'color-editor-scheme-item';
                item.dataset.name = name;
                
                // 제품 선택 디자인 스타일 적용
                item.style.cssText = 'padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #444; transition: background-color 0.15s;';
                
                // 내용 구성 (가로로 배치: scheme명, Username, DeptName)
                const content = document.createElement('div');
                content.style.cssText = 'display: flex; align-items: center; gap: 12px; flex-wrap: nowrap;';
                
                // Scheme명 (굵게) + (default) 표시
                const schemeNameEl = document.createElement('span');
                schemeNameEl.style.cssText = 'font-weight: 600; font-size: 14px; color: #fff; min-width: 80px; flex-shrink: 0;';
                const isModified = schemeData.modified === false; // modified가 false면 default와 동일
                schemeNameEl.textContent = name + (isModified ? ' (default)' : '');
                content.appendChild(schemeNameEl);
                
                // Username과 DeptName (가로로 나란히)
                if (username || deptName) {
                    const infoParts = [];
                    if (username) infoParts.push(`이름: ${username}`);
                    if (deptName) infoParts.push(`부서: ${deptName}`);
                    
                    const infoEl = document.createElement('span');
                    infoEl.style.cssText = 'font-size: 12px; color: #aaa;';
                    infoEl.textContent = infoParts.join(' | ');
                    content.appendChild(infoEl);
                }
                
                item.appendChild(content);
                
                // 호버 효과 및 클릭 이벤트
                item.addEventListener('mouseenter', () => {
                    this.selectedSchemeIndex = index;
                    this.updateSchemeSelection(Array.from(this.schemeDropdown.querySelectorAll('.color-editor-scheme-item')));
                });
                item.addEventListener('mouseleave', () => {
                    // 마우스가 벗어날 때는 선택 상태 유지 (키보드 네비게이션과 충돌 방지)
                });
                item.addEventListener('click', () => {
                    this.handleSchemeLoad(name);
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

    applySchemeToRows(scheme) {
        const legends = this.viewer?.colorLegends || {};
        const defaultScheme = getDefaultScheme(legends);
        const top = scheme.top || defaultScheme.top || {};
        const bottom = scheme.bottom || defaultScheme.bottom || {};
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
            const valid = normalizeHex(hex) || '#000000';
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
        if (!this.originalSchemeData) return;
        
        const currentData = this.getCurrentSchemeData();
        const hasChanges = JSON.stringify(currentData) !== JSON.stringify(this.originalSchemeData);
        this.updateApplyButtonState(hasChanges);
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

                // 1. 메모리 내 colorLegends 업데이트 (즉시 반영)
                if (!this.viewer.colorLegends) {
                    this.viewer.colorLegends = {};
                }
                this.viewer.colorLegends[schemeName] = schemeData;

                // 2. 백엔드에 임시 scheme 저장 (프리뷰용)
                const tempSchemeName = `__preview_${schemeName}`;
                try {
                    await fetch(`/api/color-scheme`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            schemeName: tempSchemeName,
                            schemeData: schemeData,
                        }),
                    });
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
                if (this.viewer.gridMode) {
                    // ✅ 그리드 모드: 썸네일 캐시 클리어 + 썸네일 리로드
                    // 디버그 로그 제거
                    // console.log('ColorEditor: Updating grid thumbnails preview');
                    
                    // 썸네일 캐시 클리어
                    if (this.viewer.thumbnailManager) {
                        this.viewer.thumbnailManager.cache.clear();
                    }
                    
                    // 모든 썸네일 이미지 리로드
                    const grid = document.getElementById('image-grid');
                    if (grid) {
                        const thumbnails = grid.querySelectorAll('.grid-thumb-img');
                        const personalizedParams = this.viewer.getPersonalizedParams();
                        const cacheBuster = this.viewer._personalizedColorCacheBuster || Date.now();
                        
                        thumbnails.forEach(img => {
                            if (img.src && img.src.includes('api/thumbnail')) {
                                try {
                                    const url = new URL(img.src, window.location.origin);
                                    const path = url.searchParams.get('path');
                                    
                                    if (path) {
                                        // 새로운 URL 생성 (캐시 무효화)
                                        const newUrl = `/api/thumbnail?path=${encodeURIComponent(path)}&size=512${personalizedParams}&_t=${cacheBuster}`;
                                        img.src = newUrl;
                                    }
                                } catch (e) {
                                    // URL 파싱 실패 시 무시
                                    console.warn('ColorEditor: Failed to update thumbnail URL', e);
                                }
                            }
                        });
                    }
                } else if (this.viewer.selectedImagePath) {
                    // ✅ 단일 이미지 모드: 이미지 리로드
                    // 디버그 로그 제거
                    // console.log('ColorEditor: Updating single image preview');
                    await this.viewer.loadImage(this.viewer.selectedImagePath);
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
                    
                    // 🔥 피라미드 레벨 캐시 완전 초기화 (저장된 색상 적용을 위해 필수)
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
                        await this.viewer.loadImage(this.viewer.selectedImagePath);
                    }
                    
                    // 9. UI 업데이트
                    this.viewer.renderColorLegends();
                    this.viewer.showColorLegends();
                    
                    this.viewer?.showToast?.("색상이 적용되었습니다.", 1800);
                    this.close();
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
            
            // 스킴 이름은 현재 스킴 이름 유지 (예: 'change')
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
        }
    }

    clearError() {
        if (this.errorEl) {
            this.errorEl.textContent = '';
        }
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
            // Shift 키: 마지막 선택된 셀부터 현재 셀까지 범위 선택
            const startRowIndex = this.lastSelectedCell.rowIndex;
            const endRowIndex = rowIndex;
            const startCellType = this.lastSelectedCell.cellType;
            const startChannelIndex = this.lastSelectedCell.channelIndex;
            
            // 같은 타입의 셀만 선택 (hex끼리, rgb끼리)
            if (startCellType === cellType) {
                const minRow = Math.min(startRowIndex, endRowIndex);
                const maxRow = Math.max(startRowIndex, endRowIndex);
                
                // 범위의 모든 셀 선택
                this.selectedCells.clear();
                for (let i = minRow; i <= maxRow; i++) {
                    if (i >= 0 && i < this.rows.length) {
                        if (cellType === 'hex') {
                            const hexInput = this.rows[i].hexInput;
                            if (hexInput && hexInput.dataset.cellId) {
                                this.selectedCells.add(hexInput.dataset.cellId);
                            }
                        } else if (cellType === 'rgb') {
                            // RGB: 시작 column과 끝 column 사이의 모든 column 선택
                            // 예: R(0)에서 B(2)까지 선택하면 R, G, B 모두 선택
                            // 예: R(0)에서 R(0)까지 선택하면 R만 선택
                            const minChannel = Math.min(startChannelIndex, channelIndex);
                            const maxChannel = Math.max(startChannelIndex, channelIndex);
                            const rgbInputs = this.rows[i].rgbInputs;
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
        
        // 드래그 범위의 모든 셀 선택
        this.selectedCells.clear();
        for (let i = minRow; i <= maxRow; i++) {
            if (i >= 0 && i < this.rows.length) {
                if (startCellType === 'hex') {
                    const hexInput = this.rows[i].hexInput;
                    if (hexInput && hexInput.dataset.cellId) {
                        this.selectedCells.add(hexInput.dataset.cellId);
                    }
                } else if (startCellType === 'rgb') {
                    // RGB: 시작 column과 끝 column 사이의 모든 column 선택
                    // 예: R(0)에서 B(2)까지 선택하면 R, G, B 모두 선택
                    // 예: R(0)에서 R(0)까지 선택하면 R만 선택
                    const minChannel = Math.min(startChannelIndex, endChannelIndex);
                    const maxChannel = Math.max(startChannelIndex, endChannelIndex);
                    const rgbInputs = this.rows[i].rgbInputs;
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
            z-index: 20000;
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
                    this.pasteToSelectedCells(text);
                } catch (err) {
                    // Fallback
                    const textarea = document.createElement('textarea');
                    document.body.appendChild(textarea);
                    textarea.focus();
                    document.execCommand('paste');
                    const text = textarea.value;
                    document.body.removeChild(textarea);
                    if (text) {
                        this.pasteToSelectedCells(text);
                    } else {
                        this.viewer?.showToast?.('클립보드에서 텍스트를 읽을 수 없습니다.', 1500);
                    }
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
            // 마지막 선택된 셀 업데이트
            const input = this.tableBody?.querySelector(`input[data-cell-id="${cellId}"]`);
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
        // 모든 셀에서 선택 클래스 제거
        const allInputs = this.tableBody?.querySelectorAll('input[data-cell-id]') || [];
        allInputs.forEach(input => {
            input.classList.remove('cell-selected');
        });
        
        // 선택된 셀에 클래스 추가
        this.selectedCells.forEach(cellId => {
            const input = this.tableBody?.querySelector(`input[data-cell-id="${cellId}"]`);
            if (input) {
                input.classList.add('cell-selected');
            }
        });
    }

    handleInputKeyDown(e, cellId, cellType) {
        // 입력 필드에서 Ctrl+C: 선택된 셀 복사
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && this.selectedCells.size > 0) {
            // 입력 필드의 텍스트 선택 취소
            if (e.target.setSelectionRange) {
                e.target.setSelectionRange(0, 0);
            }
            // 선택된 셀의 값 복사
            this.copySelectedCells();
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        }
        
        // 입력 필드에서 Ctrl+V: 선택된 셀에 붙여넣기
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && this.selectedCells.size > 0) {
            setTimeout(() => {
                navigator.clipboard.readText().then(text => {
                    this.pasteToSelectedCells(text);
                }).catch(() => {
                    const textarea = document.createElement('textarea');
                    document.body.appendChild(textarea);
                    textarea.focus();
                    document.execCommand('paste');
                    const text = textarea.value;
                    document.body.removeChild(textarea);
                    if (text) {
                        this.pasteToSelectedCells(text);
                    }
                });
            }, 0);
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        }
    }

    handleCellKeyDown(e) {
        // 모달 내부에서 Ctrl+C/V 처리 (입력 필드가 아닌 경우)
        const activeElement = document.activeElement;
        const isInputField = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA');
        const isCellInput = isInputField && activeElement.dataset?.cellId;
        
        // 입력 필드가 아닐 때만 처리 (입력 필드는 handleInputKeyDown에서 처리)
        if (isCellInput) {
            return;
        }
        
        // Ctrl+C: 복사 (선택된 셀이 있을 때만)
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && this.selectedCells.size > 0) {
            this.copySelectedCells();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        
        // Ctrl+V: 붙여넣기 (선택된 셀이 있을 때만)
        if ((e.ctrlKey || e.metaKey) && e.key === 'v' && this.selectedCells.size > 0) {
            setTimeout(() => {
                navigator.clipboard.readText().then(text => {
                    this.pasteToSelectedCells(text);
                }).catch(() => {
                    const textarea = document.createElement('textarea');
                    document.body.appendChild(textarea);
                    textarea.focus();
                    document.execCommand('paste');
                    const text = textarea.value;
                    document.body.removeChild(textarea);
                    if (text) {
                        this.pasteToSelectedCells(text);
                    }
                });
            }, 0);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
    }

    copySelectedCells() {
        if (this.selectedCells.size === 0) {
            console.log('[ColorEditor] 복사할 셀이 선택되지 않았습니다.');
            return;
        }
        
        const sortedCells = Array.from(this.selectedCells).sort((a, b) => {
            const inputA = this.tableBody?.querySelector(`input[data-cell-id="${a}"]`);
            const inputB = this.tableBody?.querySelector(`input[data-cell-id="${b}"]`);
            if (!inputA || !inputB) return 0;
            const rowA = parseInt(inputA.dataset.rowIndex || '0');
            const rowB = parseInt(inputB.dataset.rowIndex || '0');
            if (rowA !== rowB) return rowA - rowB;
            // 같은 행이면 hex가 먼저
            if (inputA.dataset.cellType === 'hex') return -1;
            if (inputB.dataset.cellType === 'hex') return 1;
            return 0;
        });
        
        const values = sortedCells.map(cellId => {
            const input = this.tableBody?.querySelector(`input[data-cell-id="${cellId}"]`);
            if (!input) return '';
            
            if (input.dataset.cellType === 'hex') {
                return input.value || '';
            } else if (input.dataset.cellType === 'rgb') {
                const rowIndex = parseInt(input.dataset.rowIndex || '0');
                const row = this.rows[rowIndex];
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

    pasteToSelectedCells(pastedText) {
        if (!pastedText || !pastedText.trim()) return;
        
        const lines = pastedText.split(/\r?\n/).map(line => line.trim()).filter(line => line);
        if (lines.length === 0) return;

        const sortedCells = Array.from(this.selectedCells).sort((a, b) => {
            const inputA = this.tableBody?.querySelector(`input[data-cell-id="${a}"]`);
            const inputB = this.tableBody?.querySelector(`input[data-cell-id="${b}"]`);
            if (!inputA || !inputB) return 0;
            const rowA = parseInt(inputA.dataset.rowIndex || '0');
            const rowB = parseInt(inputB.dataset.rowIndex || '0');
            if (rowA !== rowB) return rowA - rowB;
            if (inputA.dataset.cellType === 'hex') return -1;
            if (inputB.dataset.cellType === 'hex') return 1;
            return 0;
        });
        const anchorInput = this.tableBody?.querySelector(`input[data-cell-id="${sortedCells[0]}"]`);
        if (!anchorInput) return;
        const anchorType = anchorInput.dataset.cellType;
        const anchorRowIndex = parseInt(anchorInput.dataset.rowIndex || '0');

        // 선택 타입이 다른 셀은 무시
        const filteredCells = sortedCells.map(cellId => this.tableBody?.querySelector(`input[data-cell-id="${cellId}"]`))
            .filter(input => input && input.dataset.cellType === anchorType);

        const getTargetInput = (offset) => {
            if (offset < filteredCells.length) {
                return filteredCells[offset];
            }
            const targetRowIndex = anchorRowIndex + offset;
            const row = this.rows[targetRowIndex];
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
            const row = this.rows[rowIndex];
            if (!row) return;
            
            if (input.dataset.cellType === 'hex') {
                const hex = normalizeHex(line);
                if (hex) {
                    this.setRowHex(row, hex);
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
                        this.syncFromRgb(row);
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
