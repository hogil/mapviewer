const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288'];

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
    }

    open() {
        console.log('🎨 [DEBUG] ColorSchemeEditor.open() 호출됨');
        // 모달이 없으면 다시 찾기 시도
        if (!this.modal) {
            this.modal = document.getElementById('color-editor-modal');
            if (!this.modal) {
                console.error('❌ [DEBUG] color-editor-modal을 찾을 수 없습니다.');
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
        console.log('✅ [DEBUG] modal 발견됨, 모달 열기 시작');
        const legends = this.viewer?.colorLegends || {};
        // LoginId가 있으면 해당 scheme 사용, 없으면 'change' 사용
        let schemeName = this.viewer?.currentUser;
        
        // LoginId가 null이거나 undefined이면 'change' 사용
        if (!schemeName || schemeName === 'null' || schemeName === 'undefined') {
            schemeName = 'change';
        }
        
        // 해당 scheme이 없으면 fallback
        if (!legends[schemeName]) {
            if (legends.change) {
                schemeName = 'change';
            } else {
                const keys = Object.keys(legends);
                if (keys.length > 0) {
                    schemeName = keys[0];
                } else {
                    schemeName = 'change';
                }
            }
        }
        this.currentSchemeName = schemeName;
        const schemeData = legends[schemeName] || getDefaultScheme(legends);
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
        this.modal.classList.add('is-open');
        this.modal.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', this.boundKeyHandler);
        document.addEventListener('mousedown', this.boundOutsideClick);
        console.log('✅ [DEBUG] 모달 표시 완료', {
            hasModal: !!this.modal,
            hasOpenClass: this.modal.classList.contains('is-open'),
            display: window.getComputedStyle(this.modal).display
        });
    }

    async close() {
        if (!this.modal) return;
        
        // 🔥 취소 시 원래 색상으로 되돌리기
        if (this.viewer && !this.viewer.gridMode && this.viewer.selectedImagePath) {
            // 실시간 미리보기 타임아웃 취소
            if (this._realtimeUpdateTimeout) {
                clearTimeout(this._realtimeUpdateTimeout);
                this._realtimeUpdateTimeout = null;
            }
            
            // 원래 색상으로 되돌리기
            try {
                // 원래 색상 스킴으로 이미지 다시 로드
                if (this.originalSchemeData && this.currentSchemeName) {
                    // 원래 색상 스킴을 프론트엔드 캐시에 복원
                    if (this.viewer.colorLegends) {
                        this.viewer.colorLegends[this.currentSchemeName] = JSON.parse(JSON.stringify(this.originalSchemeData));
                    }
                    
                    // 원래 색상 스킴을 서버에 복원 (임시 preview 스킴 대신 원래 스킴 사용)
                    try {
                        await fetch('/api/color-scheme', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                schemeName: this.currentSchemeName,
                                schemeData: JSON.parse(JSON.stringify(this.originalSchemeData)),
                            }),
                        });
                    } catch (e) {
                        console.warn('[ColorEditor] 원래 색상 스킴 복원 실패 (무시 가능):', e);
                    }
                    
                    // 피라미드 레벨 캐시 초기화
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
                    
                    // 캐시 버스터 추가하여 강제 새로고침
                    this.viewer._personalizedColorCacheBuster = Date.now();
                    
                    // 원래 설정으로 이미지 다시 로드 (체크박스 상태도 복원)
                    const originalUser = this.viewer.currentUser;
                    
                    // 🔥 체크박스 상태 복원 (모달 열 때 저장한 상태로)
                    if (this.originalCheckboxState !== null && this.viewer.dom?.personalizedColorCheckbox) {
                        this.viewer.dom.personalizedColorCheckbox.checked = this.originalCheckboxState;
                    }
                    this.viewer.personalizedColorEnabled = this.originalCheckboxState !== null ? this.originalCheckboxState : this.viewer.personalizedColorEnabled;
                    
                    // 원래 색상 스킴으로 이미지 로드
                    this.viewer.currentUser = originalUser;
                    
                    // 이미지 다시 로드 (원래 색상)
                    await this.viewer.loadImage(this.viewer.selectedImagePath);
                    
                    // Legend도 업데이트
                    this.viewer.renderColorLegends();
                    this.viewer.showColorLegends();
                }
            } catch (error) {
                console.error('[ColorEditor] 취소 시 원래 색상으로 되돌리기 실패:', error);
            }
        }
        
        this.modal.classList.remove('is-open');
        this.modal.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', this.boundKeyHandler);
        document.removeEventListener('mousedown', this.boundOutsideClick);
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
     * 실시간 미리보기 업데이트 (단일 이미지 모드에서만)
     */
    updatePreviewRealtime() {
        if (!this.viewer || this.viewer.gridMode || !this.viewer.selectedImagePath) {
            return;
        }

        // 디바운싱: 너무 자주 호출되지 않도록 (500ms 지연)
        if (this._realtimeUpdateTimeout) {
            clearTimeout(this._realtimeUpdateTimeout);
        }

        this._realtimeUpdateTimeout = setTimeout(async () => {
            try {
                // 현재 색상 스킴을 임시로 적용
                const schemeData = this.getCurrentSchemeData();
                const schemeName = this.currentSchemeName;
                
                if (schemeName && schemeData) {
                    // 프론트엔드 캐시에 임시로 저장 (실시간 미리보기용)
                    if (!this.viewer.colorLegends) {
                        this.viewer.colorLegends = {};
                    }
                    this.viewer.colorLegends[schemeName] = schemeData;
                    
                    // 🔥 임시 색상 스킴을 서버에 전달하여 실시간 미리보기
                    // 서버에 POST 요청으로 임시 스킴 저장 (실시간 미리보기용)
                    const tempSchemeName = `_preview_${schemeName}`;
                    try {
                        await fetch('/api/color-scheme', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                schemeName: tempSchemeName,
                                schemeData: schemeData,
                            }),
                        });
                    } catch (e) {
                        console.warn('[ColorEditor] 임시 스킴 저장 실패 (무시 가능):', e);
                    }
                    
                    // 캐시 버스팅을 위한 타임스탬프 추가
                    this.viewer._personalizedColorCacheBuster = Date.now();
                    
                    // 이미지 다시 로드 (임시 스킴 사용)
                    const originalEnabled = this.viewer.personalizedColorEnabled;
                    const originalUser = this.viewer.currentUser;
                    this.viewer.personalizedColorEnabled = true;
                    this.viewer.currentUser = tempSchemeName; // 임시 스킴 사용
                    
                    // 피라미드 레벨 캐시 초기화
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
                    
                    await this.viewer.loadImage(this.viewer.selectedImagePath);
                    
                    // Legend도 업데이트
                    this.viewer.renderColorLegends();
                    
                    // 원래 상태로 복원
                    this.viewer.personalizedColorEnabled = originalEnabled;
                    this.viewer.currentUser = originalUser;
                }
            } catch (error) {
                console.error('[ColorEditor] 실시간 업데이트 오류:', error);
            }
        }, 500); // 500ms 디바운싱
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
                // 프론트엔드 캐시 갱신
                if (this.viewer) {
                    // colorLegends 캐시 갱신
                    if (!this.viewer.colorLegends) {
                        this.viewer.colorLegends = {};
                    }
                    this.viewer.colorLegends[schemeName] = schemeData;
                    
                    // 🎨 currentUser 업데이트 (색상 스킴 저장 시 현재 scheme으로 설정)
                    // 이렇게 하면 getPersonalizedParams()에서 올바른 scheme을 사용할 수 있음
                    this.viewer.currentUser = schemeName;
                    
                    // 초기 상태 업데이트 (저장된 데이터로)
                    this.originalSchemeData = JSON.parse(JSON.stringify(schemeData));
                    this.updateApplyButtonState(false);
                    
                    // 썸네일 캐시 클리어 (색상 변경 후 강제 새로고침)
                    if (this.viewer.thumbnailManager) {
                        this.viewer.thumbnailManager.cache.clear();
                    }
                    
                    // UI 새로고침
                    this.viewer.renderColorLegends();
                    this.viewer.showColorLegends();
                    
                    // 🎨 색상 스킴 저장 후에는 항상 해당 scheme으로 썸네일을 재생성해야 함
                    // personalizedColorEnabled가 false여도 저장된 scheme으로 썸네일을 재생성하도록
                    // 임시로 personalizedColorEnabled를 true로 설정하고, 그리드/이미지를 다시 로드
                    // 🔥 적용 전 체크박스 상태 저장 (체크박스 상태 유지용)
                    const originalPersonalizedEnabled = this.viewer.personalizedColorEnabled;
                    const originalCheckboxState = this.viewer.dom.personalizedColorCheckbox 
                        ? this.viewer.dom.personalizedColorCheckbox.checked 
                        : originalPersonalizedEnabled;
                    const shouldUsePersonalized = true; // 색상 변경 후에는 항상 personalized 사용
                    
                    try {
                        // 임시로 personalizedColorEnabled 활성화 (썸네일 재생성용)
                        this.viewer.personalizedColorEnabled = shouldUsePersonalized;
                        
                        // 캐시 버스팅을 위한 타임스탬프 추가
                        this.viewer._personalizedColorCacheBuster = Date.now();
                        
                        // 🔥 피라미드 레벨 캐시 완전 초기화 (개인색 변경 시 모든 레벨 재로드 필요)
                        if (this.viewer.pyramidLevels) {
                            this.viewer.pyramidLevels = {};
                        }
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
                        
                        // 현재 화면 새로고침
                        if (this.viewer.gridMode) {
                            // 그리드 모드인 경우: 그리드 다시 로드
                            const currentImages = Array.from(document.querySelectorAll('.grid-thumb-wrap'))
                                .map(item => item.dataset.path)
                                .filter(Boolean);
                            if (currentImages.length === 0) {
                                // grid-thumb-wrap이 없으면 selectedImages 사용
                                const selectedImages = this.viewer.selectedImages || [];
                                if (selectedImages.length > 0) {
                                    await this.viewer.showGrid(selectedImages, false);
                                }
                            } else {
                                // 캐시 버스팅을 위해 타임스탬프 추가하고 그리드 다시 로드
                                await this.viewer.showGrid(currentImages, false);
                            }
                        } else if (this.viewer.selectedImagePath) {
                            // 단일 이미지 모드인 경우: 이미지 다시 로드
                            await this.viewer.loadImage(this.viewer.selectedImagePath);
                            // 🔥 Legend 다시 렌더링
                            this.viewer.renderColorLegends();
                            this.viewer.showColorLegends();
                        }
                    } finally {
                        // 🔥 legend를 먼저 렌더링 (저장된 scheme을 사용)
                        // currentUser는 이미 저장된 schemeName으로 설정되어 있음
                        this.viewer.renderColorLegends();
                        this.viewer.showColorLegends();
                        
                        // 🔥 원래 상태로 복원 (체크박스 상태 포함)
                        // 적용 전 체크박스 상태를 그대로 유지
                        this.viewer.personalizedColorEnabled = originalCheckboxState;
                        // 체크박스 상태도 원래대로 복원
                        if (this.viewer.dom.personalizedColorCheckbox) {
                            this.viewer.dom.personalizedColorCheckbox.checked = originalCheckboxState;
                        }
                        // currentUser는 이미 저장된 schemeName으로 설정되어 있으므로 유지
                    }
                }
                
                this.viewer?.showToast?.('색상 스킴이 저장되었습니다.', 1800);
                this.close();
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
}
