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

        this.boundOnKey = this.handleKeyEvents.bind(this);

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
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.handleCancel();
            }
        });
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

            // 🔍 디버그 로그
            console.log('[CompositeColorModal] open() debug:');
            console.log('  isCompositeMode:', this.viewer?.isCompositeMode);
            console.log('  sessionContext:', this.sessionContext);
            console.log('  outputDir:', this.sessionContext?.outputDir);
            console.log('  sumMaps:', this.sessionContext?.sumMaps);
            console.log('  sumMaps.length:', this.sessionContext?.sumMaps?.length);

            this.livePreviewEnabled = !!(
                this.viewer?.isCompositeMode &&
                this.sessionContext?.outputDir &&
                Array.isArray(this.sessionContext?.sumMaps) &&
                this.sessionContext.sumMaps.length > 0
            );

            console.log('  livePreviewEnabled:', this.livePreviewEnabled);

            if (this.viewer?.isCompositeMode && !this.livePreviewEnabled) {
                this.viewer?.showToast?.('이번 Composite Map에서는 실시간 색상 미리보기를 사용할 수 없습니다. 새로 생성하면 사용할 수 있습니다.', 2400);
            }
            this.renderTable();
            this.updateInputs();
            this.originalColors = [...this.colors];
            this.previewApplied = false;
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
        this.clearPreviewTimer();
        this.previewBusy = false;
        this.previewQueued = false;
        this.isOpen = false;
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
        if (this.previewBusy) {
            this.previewQueued = true;
            return;
        }
        this.previewBusy = true;
        try {
            await this.viewer.refreshCompositeSumMaps({ colors: this.colors, silent: true, skipOverlay: true });
            this.previewApplied = true;
        } catch (error) {
            console.error('[CompositeColorModal] triggerLivePreview failed:', error);
            this.livePreviewEnabled = false;
            this.viewer?.showToast?.('Composite Sum Map 원본 데이터를 찾을 수 없습니다. 새로 생성한 뒤 다시 시도하세요.', 2400);
        } finally {
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
        if (!this.isDirty) {
            this.close();
            return;
        }
        this.clearError();
        try {
            const response = await fetch('/api/composite-colors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ colors: this.colors }),
            });
            if (!response.ok) {
                const message = await response.text();
                throw new Error(message || 'Failed to save composite colors');
            }
            const payload = await response.json();
            this.colors = payload.colors || this.colors;
            this.defaultColors = payload.defaultColors || this.defaultColors;
            this.updateInputs(true);
            this.originalColors = [...this.colors];
            this.previewApplied = false;

            console.log('[CompositeColorModal] handleApply() - 색상 저장 완료');
            console.log('  livePreviewEnabled:', this.livePreviewEnabled);
            console.log('  refreshCompositeSumMaps 존재:', !!this.viewer?.refreshCompositeSumMaps);

            this.viewer?.showToast?.('Composite 색상을 저장했습니다.', 2000);
            this.close();

            // 🔥 모달을 닫은 후 비동기로 이미지 갱신 (UI 블로킹 방지)
            if (this.livePreviewEnabled && this.viewer?.refreshCompositeSumMaps) {
                console.log('  ✅ 모달 닫힌 후 refreshCompositeSumMaps() 비동기 호출');
                
                // requestAnimationFrame을 사용하여 다음 프레임에서 실행 (UI 렌더링 우선)
                requestAnimationFrame(async () => {
                    try {
                        // skipOverlay: true로 오버레이 없이 백그라운드 갱신
                        await this.viewer.refreshCompositeSumMaps({
                            colors: this.colors,
                            silent: true,
                            skipOverlay: true, 
                        });
                        console.log('  ✅ refreshCompositeSumMaps() 성공');
                    } catch (error) {
                        console.error('[CompositeColorModal] refresh after apply failed:', error);
                    }
                });
            } else {
                console.log('  ❌ refreshCompositeSumMaps() 호출되지 않음');
            }
        } catch (error) {
            console.error('[CompositeColorModal] handleApply failed:', error);
            this.showError('Composite 색상을 저장하지 못했습니다.');
        }
    }
}
