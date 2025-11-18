const QUANTILE_KEY_PATTERN = /^quantile(\d{1,3})$/;

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
        this.boundOnKey = this.handleKeyEvents.bind(this);

        if (this.modal) {
            this.bindEvents();
        }
    }

    bindEvents() {
        this.closeBtn?.addEventListener('click', () => this.close());
        this.cancelBtn?.addEventListener('click', () => this.close());
        this.resetBtn?.addEventListener('click', () => this.restoreDefaults());
        this.applyBtn?.addEventListener('click', () => this.handleApply());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.close();
            }
        });
    }

    handleKeyEvents(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            this.close();
        }
    }

    async open() {
        if (!this.modal) return;
        try {
            await this.loadConfig();
            this.renderTable();
            this.updateInputs();
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
            const labelValue = match ? `${match[1]}%` : key;
            labelTd.textContent = labelValue;
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
                    this.showError('HEX 형식은 #RRGGBB 이어야 합니다.');
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

    updateInputs() {
        if (!this.rows.length) return;
        this.rows.forEach((row, idx) => {
            const value = this.colors[idx] || '#FFFFFF';
            row.colorInput.value = value;
            row.hexInput.value = value;
        });
        this.setDirty(false);
        this.clearError();
    }

    updateColor(index, value) {
        if (this.colors[index] !== value) {
            this.colors[index] = value;
            this.setDirty(true);
        }
    }

    restoreDefaults() {
        this.colors = [...this.defaultColors];
        this.updateInputs();
        this.setDirty(true);
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
            this.updateInputs();
            this.viewer?.showToast?.('Composite 색상을 저장했습니다.', 2000);
            this.close();
        } catch (error) {
            console.error('[CompositeColorModal] handleApply failed:', error);
            this.showError('Composite 색상을 저장하지 못했습니다.');
        }
    }
}
