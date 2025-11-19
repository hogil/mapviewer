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

export class CompositeColorModal {
    constructor(viewer) {
        this.viewer = viewer;
        this.modal = document.getElementById('composite-color-modal');
        this.tableBody = this.modal?.querySelector('#composite-color-table-body') || null;
        this.closeBtn = this.modal?.querySelector('#composite-color-close-btn') || null;
        this.cancelBtn = this.modal?.querySelector('#composite-color-cancel-btn') || null;
        this.applyBtn = this.modal?.querySelector('#composite-color-apply-btn') || null;
        this.resetBtn = this.modal?.querySelector('#composite-color-reset-btn') || null;
        this.errorEl = this.modal?.querySelector('#composite-color-error') || null;

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
            const match = key.match(QUANTILE_KEY_PATTERN);
            labelTd.textContent = match ? `${match[1]}%` : key;
            tr.appendChild(labelTd);

            const colorTd = document.createElement('td');
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.dataset.index = String(idx);
            colorTd.appendChild(colorInput);
            tr.appendChild(colorTd);

            const hexTd = document.createElement('td');
            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.maxLength = 7;
            hexInput.placeholder = '#RRGGBB';
            hexInput.dataset.index = String(idx);
            hexTd.appendChild(hexInput);
            tr.appendChild(hexTd);

            colorInput.addEventListener('input', (event) => {
                const value = ensureHex(event.target.value);
                if (!value) {
                    return;
                }
                hexInput.value = value;
                this.updateColor(idx, value);
            });

            hexInput.addEventListener('change', (event) => {
                const value = ensureHex(event.target.value);
                if (!value) {
                    this.showError('HEX 값은 #RRGGBB 형식이어야 합니다.');
                    hexInput.value = this.colors[idx] || '';
                    return;
                }
                colorInput.value = value;
                this.updateColor(idx, value);
            });

            this.tableBody.appendChild(tr);
            return { colorInput, hexInput };
        });
    }

    updateInputs(resetDirty = true) {
        if (!this.rows.length) return;
        this.rows.forEach((row, idx) => {
            const value = this.colors[idx] || '#FFFFFF';
            row.colorInput.value = value;
            row.hexInput.value = value;
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
            await this.viewer.refreshCompositeSumMaps({ colors: this.colors, silent: true });
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
                await this.viewer.refreshCompositeSumMaps({ colors: revertColors, silent: true });
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

            // 🔥 모달을 닫은 후에 이미지 갱신 (Grid가 다시 보이는 상태에서)
            if (this.livePreviewEnabled && this.viewer?.refreshCompositeSumMaps) {
                console.log('  ✅ 모달 닫힌 후 refreshCompositeSumMaps() 호출');
                // 모달 닫기 애니메이션 완료 대기
                await new Promise(resolve => setTimeout(resolve, 100));
                try {
                    await this.viewer.refreshCompositeSumMaps({ colors: this.colors, silent: true });
                    console.log('  ✅ refreshCompositeSumMaps() 성공');
                } catch (error) {
                    console.error('[CompositeColorModal] refresh after apply failed:', error);
                    this.viewer?.showToast?.('Composite 이미지가 갱신되지 않았습니다. 다시 생성해 주세요.', 2200);
                }
            } else {
                console.log('  ❌ refreshCompositeSumMaps() 호출되지 않음');
            }
        } catch (error) {
            console.error('[CompositeColorModal] handleApply failed:', error);
            this.showError('Composite 색상을 저장하지 못했습니다.');
        }
    }
}
