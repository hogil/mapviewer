const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288'];
const DEFAULT_SCHEME = {
    top: {
        Grade0: '#FF1493',
        Grade1: '#00CED1',
        Grade2: '#FFD700',
        Grade3: '#8A2BE2',
        Grade4: '#FFD700',
        Grade5: '#FF4500',
        Grade6: '#32CD32',
        Grade7: '#4B0082',
    },
    bottom: {
        Normal: '#2F4F4F',
        Invalid: '#8B4513',
        B285: '#FF69B4',
        B286: '#00FA9A',
        B287: '#FF6347',
        B288: '#4169E1',
    },
    background: '#FEFEFE',
};

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
        this.errorEl = this.modal ? this.modal.querySelector('#color-editor-error') : null;
        this.schemeLabel = this.modal ? this.modal.querySelector('#color-editor-scheme-label') : null;
        this.schemeSearchInput = this.modal ? this.modal.querySelector('#color-editor-scheme-search') : null;
        this.schemeLoadBtn = this.modal ? this.modal.querySelector('#color-editor-scheme-load-btn') : null;
        this.schemeDropdown = this.modal ? this.modal.querySelector('#color-editor-scheme-dropdown') : null;
        this.boundKeyHandler = this.handleKeyDown.bind(this);
        this.boundOutsideClick = this.handleOutsideClick.bind(this);
        this.activeSchemeOptions = [];
        this.rows = [];
        this.setup();
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
            this.applyBtn.addEventListener('click', () => {
                this.viewer?.showToast?.('개인색 적용 기능은 준비 중입니다.', 1800);
                this.close();
            });
        }
        if (this.modal) {
            this.modal.addEventListener('click', (event) => {
                if (event.target === this.modal) {
                    this.close();
                }
            });
        }
        if (this.schemeLoadBtn) {
            this.schemeLoadBtn.addEventListener('click', () => this.handleSchemeLoad());
        }
        if (this.schemeSearchInput) {
            this.schemeSearchInput.addEventListener('input', () => this.populateDropdown());
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
            hexTd.className = 'color-editor-hex';
            const hexInput = document.createElement('input');
            hexInput.type = 'text';
            hexInput.maxLength = 7;
            hexInput.placeholder = '#RRGGBB';
            const hexPasteBtn = document.createElement('button');
            hexPasteBtn.type = 'button';
            hexPasteBtn.className = 'color-editor-copy-btn';
            hexPasteBtn.textContent = '붙여넣기';
            hexTd.appendChild(hexInput);
            hexTd.appendChild(hexPasteBtn);

            const rgbTd = document.createElement('td');
            rgbTd.className = 'color-editor-rgb';
            const rgbInputs = ['R', 'G', 'B'].map((label) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.min = '0';
                input.max = '255';
                input.placeholder = label;
                rgbTd.appendChild(input);
                return input;
            });
            const rgbPasteBtn = document.createElement('button');
            rgbPasteBtn.type = 'button';
            rgbPasteBtn.className = 'color-editor-copy-btn';
            rgbPasteBtn.textContent = '붙여넣기';
            rgbTd.appendChild(rgbPasteBtn);

            const previewTd = document.createElement('td');
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'color-editor-preview';
            colorInput.value = '#000000';
            previewTd.appendChild(colorInput);

            const copyTd = document.createElement('td');
            const copyGroup = document.createElement('div');
            copyGroup.className = 'color-editor-copy-group';
            const copyHexBtn = document.createElement('button');
            copyHexBtn.type = 'button';
            copyHexBtn.className = 'color-editor-copy-btn';
            copyHexBtn.textContent = 'HEX 복사';
            const copyRgbBtn = document.createElement('button');
            copyRgbBtn.type = 'button';
            copyRgbBtn.className = 'color-editor-copy-btn';
            copyRgbBtn.textContent = 'RGB 복사';
            const copyAllBtn = document.createElement('button');
            copyAllBtn.type = 'button';
            copyAllBtn.className = 'color-editor-copy-btn';
            copyAllBtn.textContent = '전체 복사';
            copyGroup.appendChild(copyHexBtn);
            copyGroup.appendChild(copyRgbBtn);
            copyGroup.appendChild(copyAllBtn);
            copyTd.appendChild(copyGroup);

            tr.appendChild(labelTd);
            tr.appendChild(hexTd);
            tr.appendChild(rgbTd);
            tr.appendChild(previewTd);
            tr.appendChild(copyTd);
            this.tableBody.appendChild(tr);

            const row = {
                section,
                key,
                hexInput,
                rgbInputs,
                colorInput,
                copyHexBtn,
                copyRgbBtn,
                copyAllBtn,
            };

            hexInput.addEventListener('change', () => this.syncFromHex(row));
            hexInput.addEventListener('input', () => this.clearError());
            rgbInputs.forEach((input) => {
                input.addEventListener('change', () => this.syncFromRgb(row));
                input.addEventListener('input', () => this.clearError());
            });
            colorInput.addEventListener('input', () => this.syncFromPicker(row));
            hexPasteBtn.addEventListener('click', () => this.pasteHex(row));
            rgbPasteBtn.addEventListener('click', () => this.pasteRgb(row));
            copyHexBtn.addEventListener('click', () => this.copyHex(row));
            copyRgbBtn.addEventListener('click', () => this.copyRgb(row));
            copyAllBtn.addEventListener('click', () => this.copyRow(row));
            rows.push(row);
        };

        TOP_KEYS.forEach((key) => buildRow('top', key));
        BOTTOM_KEYS.forEach((key) => buildRow('bottom', key));
        buildRow('background', 'Background');

        this.rows = rows;
    }

    open() {
        if (!this.modal) return;
        const legends = this.viewer?.colorLegends || {};
        let schemeName = this.viewer?.currentUser || 'change';
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
        const schemeData = legends[schemeName] || DEFAULT_SCHEME;
        this.populateSchemeOptions();
        this.applySchemeToRows(schemeData);
        this.updateSchemeLabel(schemeName);
        this.clearError();
        this.modal.classList.add('is-open');
        this.modal.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', this.boundKeyHandler);
        document.addEventListener('mousedown', this.boundOutsideClick);
    }

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('is-open');
        this.modal.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', this.boundKeyHandler);
        document.removeEventListener('mousedown', this.boundOutsideClick);
        this.clearError();
    }

    handleKeyDown(event) {
        if (event.key === 'Escape') {
            this.close();
        }
    }

    handleOutsideClick(event) {
        if (!this.dialog) return;
        if (!this.dialog.contains(event.target)) {
            this.close();
        }
    }

    handleSchemeLoad(name) {
        const legends = this.viewer?.colorLegends || {};
        const target =
            name ||
            this.schemeSearchInput?.value?.trim() ||
            this.currentSchemeName ||
            'change';
        if (!legends[target]) {
            this.showError('해당하는 스킴을 찾을 수 없습니다.');
            return;
        }
        this.currentSchemeName = target;
        this.applySchemeToRows(legends[target]);
        this.updateSchemeLabel(target);
        this.hideDropdown();
    }

    populateSchemeOptions() {
        if (!this.schemeDropdown) return;
        const legends = this.viewer?.colorLegends || {};
        const filter = this.schemeSearchInput?.value?.trim().toLowerCase() || '';
        const entries = Object.keys(legends);
        const matches = entries.filter((name) =>
            name.toLowerCase().includes(filter)
        );
        this.schemeDropdown.innerHTML = '';
        matches.forEach((name) => {
            const item = document.createElement('div');
            item.className = 'color-editor-dropdown-item';
            item.textContent = name;
            item.dataset.name = name;
            item.addEventListener('click', () => this.handleSchemeLoad(name));
            this.schemeDropdown.appendChild(item);
        });
        if (matches.length > 0) {
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
    }

    applySchemeToRows(scheme) {
        const top = scheme.top || DEFAULT_SCHEME.top;
        const bottom = scheme.bottom || DEFAULT_SCHEME.bottom;
        const background = scheme.background || DEFAULT_SCHEME.background;

        this.rows.forEach((row) => {
            let hex;
            if (row.section === 'top') {
                hex = top[row.key];
            } else if (row.section === 'bottom') {
                hex = bottom[row.key];
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

    async pasteHex(row) {
        if (!navigator.clipboard?.readText) {
            this.viewer?.showToast?.('클립보드에서 읽을 수 없습니다.', 1600);
            return;
        }
        try {
            const text = await navigator.clipboard.readText();
            const hex = normalizeHex(text);
            if (!hex) {
                row.hexInput.classList.add('invalid');
                this.showError('HEX 색상은 #RRGGBB 형식이어야 합니다.');
                return;
            }
            row.hexInput.classList.remove('invalid');
            this.setRowHex(row, hex);
            this.clearError();
        } catch (error) {
            console.warn('[ColorEditor] pasteHex 실패:', error);
            this.showError('클립보드에서 HEX를 읽지 못했습니다.');
        }
    }

    async pasteRgb(row) {
        if (!navigator.clipboard?.readText) {
            this.viewer?.showToast?.('클립보드에서 읽을 수 없습니다.', 1600);
            return;
        }
        try {
            const text = await navigator.clipboard.readText();
            const matches = text.trim().split(/[^0-9]+/).filter(Boolean);
            if (matches.length < 3) {
                this.showError('RGB 값은 "255, 128, 0" 형태여야 합니다.');
                row.rgbInputs.forEach((input) => input.classList.add('invalid'));
                return;
            }
            const [r, g, b] = matches.slice(0, 3).map((value) => {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : NaN;
            });
            if ([r, g, b].some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
                this.showError('RGB 값은 0~255 사이의 숫자여야 합니다.');
                row.rgbInputs.forEach((input) => input.classList.add('invalid'));
                return;
            }
            row.rgbInputs.forEach((input, index) => {
                input.value = [r, g, b][index];
                input.classList.remove('invalid');
            });
            this.syncFromRgb(row);
            this.clearError();
        } catch (error) {
            console.warn('[ColorEditor] pasteRgb 실패:', error);
            this.showError('클립보드에서 RGB를 읽지 못했습니다.');
        }
    }

    async copyHex(row) {
        const hex = normalizeHex(row.hexInput.value);
        if (!hex) {
            row.hexInput.classList.add('invalid');
            this.showError('HEX 색상을 먼저 입력하세요.');
            return;
        }
        row.hexInput.classList.remove('invalid');
        await this.copyToClipboard(hex, `${row.key} HEX 복사됨`);
    }

    async copyRgb(row) {
        const values = row.rgbInputs.map((input) => Number(input.value));
        if (values.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
            row.rgbInputs.forEach((input) => input.classList.add('invalid'));
            this.showError('RGB 값은 0~255 범위여야 합니다.');
            return;
        }
        row.rgbInputs.forEach((input) => input.classList.remove('invalid'));
        const payload = values.map((value) => String(Math.round(value))).join(', ');
        await this.copyToClipboard(payload, `${row.key} RGB 복사됨`);
    }

    async copyRow(row) {
        const hex = normalizeHex(row.hexInput.value);
        if (!hex) return;
        const rgb = hexToRgb(hex);
        const payload = `${row.key}: ${hex} (${rgb.r}, ${rgb.g}, ${rgb.b})`;
        await this.copyToClipboard(payload, `${row.key} 색상 복사됨`);
    }

    async copyToClipboard(text, successMessage) {
        if (!navigator.clipboard?.writeText) {
            this.viewer?.showToast?.('클립보드 API를 사용할 수 없습니다.', 1600);
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            if (successMessage) {
                this.viewer?.showToast?.(successMessage, 1600);
            }
        } catch (error) {
            console.warn('[ColorEditor] copyToClipboard 실패:', error);
            this.viewer?.showToast?.('클립보드 복사에 실패했습니다.', 1600);
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
