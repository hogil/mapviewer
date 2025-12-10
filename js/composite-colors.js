const QUANTILE_KEY_PATTERN = /^quantile(\d{1,3})$/;
const LIVE_PREVIEW_DEBOUNCE = 250;

const ensureHex = (value) => {
    if (!value) return null;
    let hex = value.trim();
    if (!hex) return null;
    if (!hex.startsWith('#')) {
        hex = `#${hex}`;
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
        return null;
    }
    return hex.toUpperCase();
};

const clampChannel = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return null;
    }
    return Math.min(255, Math.max(0, Math.round(num)));
};

const hexToRgb = (hex) => {
    const normalized = ensureHex(hex);
    if (!normalized) return null;
    return {
        r: parseInt(normalized.slice(1, 3), 16),
        g: parseInt(normalized.slice(3, 5), 16),
        b: parseInt(normalized.slice(5, 7), 16),
    };
};

const rgbToHex = (r, g, b) => {
    const rr = clampChannel(r);
    const gg = clampChannel(g);
    const bb = clampChannel(b);
    if (rr == null || gg == null || bb == null) return null;
    const toHex = (val) => val.toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(rr)}${toHex(gg)}${toHex(bb)}`;
};

export class CompositeColorModal {
    constructor(viewer) {
        this.viewer = viewer;
        this.modal = document.getElementById('composite-color-modal');
        this.tableBody = this.modal?.querySelector('#composite-color-table-body') || null;
        this.closeBtn = this.modal?.querySelector('#composite-color-close-btn') || null;
        this.cancelBtn = this.modal?.querySelector('#composite-color-cancel-btn') || null;
        this.applyBtn = this.modal?.querySelector('#composite-color-apply-btn') || null;
        this.resetBtn = this.modal?.querySelector('#composite-color-reset-btn') || null;
        this.restoreBtn = this.modal?.querySelector('#composite-color-restore-btn') || null;
        this.errorEl = this.modal?.querySelector('#composite-color-error') || null;
        this.schemeLabel = this.modal?.querySelector('#composite-color-scheme-label') || null;
        this.schemeSearchInput = this.modal?.querySelector('#composite-color-scheme-search') || null;
        this.schemeLoadBtn = this.modal?.querySelector('#composite-color-scheme-load-btn') || null;
        this.schemeDropdown = this.modal?.querySelector('#composite-color-scheme-dropdown') || null;

        this.keys = [];
        this.quantiles = [];
        this.colors = [];
        this.defaultColors = [];
        this.rows = [];
        this.isOpen = false;
        this.isDirty = false;

        this.originalColors = [];
        this.sessionContext = null;
        this.livePreviewEnabled = false;
        this.previewTimer = null;
        this.previewBusy = false;
        this.previewQueued = false;
        this.previewApplied = false;
        this.previewAbortController = null;
        this.lastPreviewKey = null;

        this.boundOnKey = this.handleKeyEvents.bind(this);
        
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

        if (this.modal) {
            this.bindEvents();
        }
    }

    bindEvents() {
        this.closeBtn?.addEventListener('click', () => this.handleCancel());
        this.cancelBtn?.addEventListener('click', () => this.handleCancel());
        this.resetBtn?.addEventListener('click', () => this.restoreDefaults());
        this.restoreBtn?.addEventListener('click', () => this.handleRestore());
        this.applyBtn?.addEventListener('click', () => this.handleApply());
        // 바깥쪽 클릭으로 닫히지 않도록 제거
    }

    handleKeyEvents(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            this.handleCancel();
        }
    }

    async open(previewContext = null) {
        if (!this.modal) return;
        try {
            await this.loadConfig();
            this.sessionContext = previewContext || (this.viewer?.isCompositeMode ? this.viewer?.compositeSession : null);
            const schemeName = this.viewer?.currentUser || 'change';
            this.schemeName = schemeName;
            if (this.schemeLabel) {
                this.schemeLabel.textContent = schemeName ? `- ${schemeName}` : '';
            }

            this.livePreviewEnabled = !!(
                this.viewer?.isCompositeMode &&
                this.sessionContext?.outputDir &&
                Array.isArray(this.sessionContext?.sumMaps) &&
                this.sessionContext.sumMaps.length > 0
            );

            if (this.viewer?.isCompositeMode && !this.livePreviewEnabled) {
                this.viewer?.showToast?.('이번 Composite Map에서는 실시간 색상 미리보기를 사용할 수 없습니다. 새로 생성하면 사용할 수 있습니다.', 2400);
            }
            this.renderTable();
            this.updateInputs();
            this.originalColors = [...this.colors];
            this.previewApplied = false;
            if (this.previewAbortController) {
                this.previewAbortController.abort();
                this.previewAbortController = null;
            }
            this.lastPreviewKey = null;
            
            // tableBody가 생성된 후 컨텍스트 메뉴 이벤트 리스너 등록
            if (this.modal && !this._contextMenuBound) {
                this.modal.addEventListener('contextmenu', (e) => this.handleContextMenu(e), true);
                this._contextMenuBound = true;
            }
            if (this.tableBody && !this._contextMenuBound) {
                this.tableBody.addEventListener('contextmenu', (e) => this.handleContextMenu(e), true);
                this._contextMenuBound = true;
            }
            
            this.show();
        } catch (error) {
            console.error('[CompositeColorModal] loadConfig failed:', error);
            this.showError('Composite 색상 정보를 불러오지 못했습니다.');
        }
    }

    show() {
        if (!this.modal) return;
        this.modal.classList.add('is-open');
        this.modal.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', this.boundOnKey);
        this.isOpen = true;
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('is-open');
        this.modal.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', this.boundOnKey);
        if (this.modal) {
            this.modal.removeEventListener('mousemove', this.boundCellMouseMove);
            this.modal.removeEventListener('mouseup', this.boundCellMouseUp);
            this.modal.removeEventListener('keydown', this.boundCellKeyDown);
        }
        this.clearPreviewTimer();
        if (this.previewAbortController) {
            this.previewAbortController.abort();
            this.previewAbortController = null;
        }
        this.lastPreviewKey = null;
        this.previewBusy = false;
        this.previewQueued = false;
        this.isOpen = false;
        this.selectedCells.clear();
        this.updateCellSelection();
        this.hideContextMenu();
        this.clearError();
        this.setDirty(false);
    }

    async loadConfig() {
        const response = await fetch('/api/composite-colors', { cache: 'no-store' });
        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || 'Failed to load composite colors');
        }
        const payload = await response.json();
        this.keys = payload.keys || [];
        this.quantiles = payload.quantiles || [];
        this.colors = payload.colors || [];
        this.defaultColors = payload.defaultColors || [];
    }

    renderTable() {
        if (!this.tableBody) return;
        this.tableBody.innerHTML = '';
        this.rows = this.keys.map((key, idx) => {
            const tr = document.createElement('tr');

            const labelTd = document.createElement('td');
            labelTd.className = 'color-editor-label';
            const match = key.match(QUANTILE_KEY_PATTERN);
            labelTd.textContent = match ? `${match[1]}%` : key;
            tr.appendChild(labelTd);

            const hexTd = document.createElement('td');
            const hexContainer = document.createElement('div');
            hexContainer.className = 'color-editor-hex';
            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.maxLength = 7;
            hexInput.placeholder = '#RRGGBB';
            hexInput.dataset.index = String(idx);
            const hexCellId = `hex-${this.cellIdCounter++}`;
            hexInput.dataset.cellId = hexCellId;
            hexInput.dataset.cellType = 'hex';
            hexInput.dataset.rowIndex = String(idx);
            hexInput.addEventListener('paste', (e) => this.handleHexPaste(e, idx));
            hexInput.addEventListener('mousedown', (e) => this.handleCellMouseDown(e, hexCellId, 'hex'));
            hexInput.addEventListener('keydown', (e) => this.handleInputKeyDown(e, hexCellId, 'hex'), true);
            hexContainer.appendChild(hexInput);
            hexTd.appendChild(hexContainer);
            tr.appendChild(hexTd);

            const rgbTd = document.createElement('td');
            const rgbContainer = document.createElement('div');
            rgbContainer.className = 'color-editor-rgb';
            const rgbInputs = ['R', 'G', 'B'].map((placeholder, rgbIdx) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.min = '0';
                input.max = '255';
                input.placeholder = placeholder;
                input.dataset.channel = ['r', 'g', 'b'][rgbIdx];
                const rgbCellId = `rgb-${this.cellIdCounter++}`;
                input.dataset.cellId = rgbCellId;
                input.dataset.cellType = 'rgb';
                input.dataset.channelIndex = String(rgbIdx);
                input.dataset.rowIndex = String(idx);
                input.addEventListener('paste', (e) => this.handleRgbPaste(e, idx));
                input.addEventListener('mousedown', (e) => this.handleCellMouseDown(e, rgbCellId, 'rgb'));
                input.addEventListener('keydown', (e) => this.handleInputKeyDown(e, rgbCellId, 'rgb'), true);
                input.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
                rgbContainer.appendChild(input);
                return input;
            });
            rgbTd.appendChild(rgbContainer);
            tr.appendChild(rgbTd);

            const pickerTd = document.createElement('td');
            pickerTd.className = 'color-editor-picker';
            const colorPreview = document.createElement('div');
            colorPreview.className = 'color-editor-preview';
            colorPreview.style.width = '48px';
            colorPreview.style.height = '24px';
            colorPreview.style.backgroundColor = '#000000';
            colorPreview.style.border = '1px solid #444';
            colorPreview.style.borderRadius = '4px';
            colorPreview.style.flexShrink = '0';
            colorPreview.style.cursor = 'pointer';

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
            colorInput.dataset.index = String(idx);

            const pickerWrapper = document.createElement('div');
            pickerWrapper.style.position = 'relative';
            pickerWrapper.style.display = 'inline-block';
            pickerWrapper.appendChild(colorPreview);
            pickerWrapper.appendChild(colorInput);

            colorPreview.addEventListener('click', (event) => {
                event.stopPropagation();
                colorInput.click();
            });

            pickerTd.appendChild(pickerWrapper);
            tr.appendChild(pickerTd);

            this.tableBody.appendChild(tr);

            const row = { colorInput, hexInput, rgbInputs, colorPreview };

            const revertValue = () => {
                const fallback = this.colors[idx] || '#FFFFFF';
                this.applyRowColor(row, fallback);
            };

            colorInput.addEventListener('input', (event) => {
                const value = ensureHex(event.target.value);
                if (!value) {
                    return;
                }
                this.applyRowColor(row, value);
                this.updateColor(idx, value);
            });

            hexInput.addEventListener('change', (event) => {
                const value = ensureHex(event.target.value);
                if (!value) {
                    this.showError('HEX 값은 #RRGGBB 형식이어야 합니다.');
                    revertValue();
                    return;
                }
                this.applyRowColor(row, value);
                this.updateColor(idx, value);
            });
            hexInput.addEventListener('input', () => {
                this.clearError();
            });

            rgbInputs.forEach((input) => {
                input.addEventListener('change', () => {
                    const values = rgbInputs.map((el) => el.value);
                    if (values.some((val) => val === '')) {
                        this.showError('RGB 값은 0~255 범위의 숫자여야 합니다.');
                        input.classList.add('invalid');
                        revertValue();
                        return;
                    }
                    const hex = rgbToHex(values[0], values[1], values[2]);
                    if (!hex) {
                        this.showError('RGB 값은 0~255 범위의 숫자여야 합니다.');
                        input.classList.add('invalid');
                        revertValue();
                        return;
                    }
                    rgbInputs.forEach((el) => el.classList.remove('invalid'));
                    this.applyRowColor(row, hex);
                    this.updateColor(idx, hex);
                });
                input.addEventListener('input', () => {
                    input.classList.remove('invalid');
                    this.clearError();
                });
            });

            return row;
        });
        
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

    applyRowColor(row, hex) {
        const safeHex = ensureHex(hex) || '#FFFFFF';
        if (row.hexInput) {
            row.hexInput.value = safeHex;
        }
        if (row.colorInput) {
            row.colorInput.value = safeHex;
        }
        if (row.colorPreview) {
            row.colorPreview.style.backgroundColor = safeHex;
        }
        if (row.rgbInputs && row.rgbInputs.length === 3) {
            const rgb = hexToRgb(safeHex);
            if (rgb) {
                row.rgbInputs[0].value = rgb.r;
                row.rgbInputs[1].value = rgb.g;
                row.rgbInputs[2].value = rgb.b;
            } else {
                row.rgbInputs.forEach((input) => {
                    input.value = '';
                });
            }
        }
    }

    updateInputs(resetDirty = true) {
        if (!this.rows.length) return;
        this.rows.forEach((row, idx) => {
            const value = this.colors[idx] || '#FFFFFF';
            this.applyRowColor(row, value);
        });
        if (resetDirty) {
            this.setDirty(false);
        }
        this.clearError();
    }

    updateColor(index, value) {
        if (this.colors[index] !== value) {
            this.colors[index] = value;
            this.setDirty(true);
            this.scheduleLivePreview();
        }
    }

    handleHexPaste(event, startIndex) {
        const text = event.clipboardData?.getData('text') || '';
        if (!text) return;
        const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
        if (parts.length <= 1) return; // 기본 붙여넣기 허용

        event.preventDefault();
        let changed = false;
        parts.forEach((raw, offset) => {
            const idx = startIndex + offset;
            if (idx >= this.colors.length) return;
            const normalized = ensureHex(raw);
            if (!normalized) return;
            if (this.colors[idx] !== normalized) {
                this.colors[idx] = normalized;
                changed = true;
            }
        });
        if (changed) {
            this.updateInputs(false);
            this.setDirty(true);
            this.scheduleLivePreview();
        }
    }

    handleRgbPaste(event, startIndex) {
        const text = event.clipboardData?.getData('text') || '';
        if (!text) return;
        const lines = text.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length <= 1 && !lines[0]?.includes(',')) return; // 기본 붙여넣기 허용

        event.preventDefault();
        let changed = false;
        lines.forEach((line, offset) => {
            const idx = startIndex + offset;
            if (idx >= this.colors.length) return;
            const tokens = line.trim().replace(/#/g, '').split(/[\s,;]+/).filter(Boolean);
            let rgb = null;
            if (tokens.length === 1) {
                const hex = ensureHex(tokens[0]);
                rgb = hex ? hexToRgb(hex) : null;
            } else if (tokens.length >= 3) {
                const [r, g, b] = tokens.slice(0, 3).map(Number);
                if ([r, g, b].every(v => Number.isFinite(v))) {
                    rgb = { r: Math.max(0, Math.min(255, Math.round(r))), g: Math.max(0, Math.min(255, Math.round(g))), b: Math.max(0, Math.min(255, Math.round(b))) };
                }
            }
            if (!rgb) return;
            const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
            if (hex && this.colors[idx] !== hex) {
                this.colors[idx] = hex;
                changed = true;
            }
        });
        if (changed) {
            this.updateInputs(false);
            this.setDirty(true);
            this.scheduleLivePreview();
        }
    }

    restoreDefaults() {
        this.colors = [...this.defaultColors];
        this.updateInputs(false);
        this.setDirty(true);
        this.scheduleLivePreview();
    }

    handleRestore() {
        if (!this.originalColors?.length) {
            this.viewer?.showToast?.('복원할 색상 정보가 없습니다.', 1800);
            return;
        }
        this.colors = [...this.originalColors];
        this.updateInputs(false);
        this.setDirty(false);
        this.scheduleLivePreview();
    }

    setDirty(isDirty) {
        this.isDirty = isDirty;
        if (this.applyBtn) {
            this.applyBtn.disabled = !isDirty;
        }
    }

    clearError() {
        if (this.errorEl) {
            this.errorEl.textContent = '';
            this.errorEl.style.display = 'none';
        }
    }

    showError(message) {
        if (this.errorEl) {
            this.errorEl.textContent = message;
            this.errorEl.style.display = 'block';
        } else {
            this.viewer?.showToast?.(message, 2000);
        }
    }

    clearPreviewTimer() {
        if (this.previewTimer) {
            clearTimeout(this.previewTimer);
            this.previewTimer = null;
        }
    }

    scheduleLivePreview() {
        if (!this.livePreviewEnabled || !this.viewer?.refreshCompositeSumMaps || !this.isOpen) {
            return;
        }
        this.clearPreviewTimer();
        this.previewTimer = setTimeout(() => {
            this.previewTimer = null;
            this.triggerLivePreview();
        }, LIVE_PREVIEW_DEBOUNCE);
    }

    async triggerLivePreview() {
        if (!this.livePreviewEnabled || !this.viewer?.refreshCompositeSumMaps) {
            return;
        }

        const key = JSON.stringify(this.colors);
        if (this.lastPreviewKey === key && this.previewApplied) {
            return;
        }
        this.lastPreviewKey = key;

        if (this.previewBusy) {
            this.previewQueued = true;
            return;
        }

        // 이전 요청이 있으면 즉시 취소 (느린 리컬러 큐 적체 방지)
        if (this.previewAbortController) {
            this.previewAbortController.abort();
        }
        this.previewAbortController = new AbortController();

        this.previewBusy = true;
        try {
            await this.viewer.refreshCompositeSumMaps({
                colors: this.colors,
                silent: true,
                skipOverlay: true,
                signal: this.previewAbortController.signal,
            });
            this.previewApplied = true;
        } catch (error) {
            if (error?.name === 'AbortError') {
                // 최신 요청으로 대체되었으므로 조용히 무시
                return;
            }
            console.error('[CompositeColorModal] triggerLivePreview failed:', error);
            this.livePreviewEnabled = false;
            this.viewer?.showToast?.('Composite Sum Map 원본 데이터를 찾을 수 없습니다. 새로 생성한 뒤 다시 시도하세요.', 2400);
        } finally {
            this.previewAbortController = null;
            this.previewBusy = false;
            if (this.previewQueued) {
                this.previewQueued = false;
                this.triggerLivePreview();
            }
        }
    }

    async handleCancel() {
        if (!this.isOpen) {
            return;
        }
        this.clearPreviewTimer();
        const needRevert = this.previewApplied && this.livePreviewEnabled && this.viewer?.refreshCompositeSumMaps;
        const revertColors = [...this.originalColors];
        this.colors = revertColors;
        this.updateInputs(false);
        this.previewApplied = false;
        if (this.previewAbortController) {
            this.previewAbortController.abort();
            this.previewAbortController = null;
        }
        this.lastPreviewKey = null;
        if (needRevert) {
            try {
                await this.viewer.refreshCompositeSumMaps({ colors: revertColors, silent: true, skipOverlay: true });
            } catch (error) {
                console.warn('[CompositeColorModal] handleCancel revert failed:', error);
            }
        }
        this.close();
    }

    async handleApply() {
        if (!this.isOpen) return;
        this.clearError();
        const colorsToUse = [...this.colors];
        const shouldPersist = this.isDirty;

        // UI 즉시 반응: 먼저 닫기
        this.close();

        try {
            if (shouldPersist) {
                const response = await fetch('/api/composite-colors', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ colors: colorsToUse }),
                });
                if (!response.ok) {
                    const message = await response.text();
                    throw new Error(message || 'Failed to save composite colors');
                }
                const payload = await response.json();
                this.colors = payload.colors || colorsToUse;
                this.defaultColors = payload.defaultColors || this.defaultColors;
                this.originalColors = [...this.colors];
                this.updateInputs(true);
            }

            this.previewApplied = false;
            if (this.previewAbortController) {
                this.previewAbortController.abort();
                this.previewAbortController = null;
            }
            this.lastPreviewKey = null;

            if (this.viewer?.refreshCompositeSumMaps) {
                await this.viewer.refreshCompositeSumMaps({
                    colors: colorsToUse,
                    silent: true,
                    skipOverlay: false,
                    overlayMessage: '색상 변경 중입니다...',
                });
            } else {
                this.viewer?.showToast?.('Composite 색상을 저장했습니다.', 2000);
            }
        } catch (error) {
            console.error('[CompositeColorModal] handleApply failed:', error);
            this.viewer?.showToast?.('색상 적용에 실패했습니다.', 2000);
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
        // 포커스를 명시적으로 이동시켜서 Ctrl+C/V 키 이벤트가 모달로 전달되도록 한다
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
            navigator.clipboard.writeText(text).catch(() => {
                // Fallback
                const textarea = document.createElement('textarea');
                textarea.value = text;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            });
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

        // 선택 목록에서 앵커 타입과 다른 셀은 무시
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
                const hex = ensureHex(line);
                if (hex) {
                    this.applyRowColor(row, hex);
                    this.updateColor(rowIndex, hex);
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
                        const hex = rgbToHex(r, g, b);
                        if (hex) {
                            this.applyRowColor(row, hex);
                            this.updateColor(rowIndex, hex);
                            successCount++;
                        }
                    }
                }
            }
        });

        if (successCount > 0) {
            this.setDirty(true);
            this.scheduleLivePreview();
        }
    }
}

