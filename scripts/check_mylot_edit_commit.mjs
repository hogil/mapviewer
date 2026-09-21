import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'js', 'my-lot.js'), 'utf8');
const { MyLotModal } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const runKeyPath = async key => {
    let currentInput = null;
    const documentListeners = new Map();
    const documentStub = {
        createElement(tag) {
            if (tag !== 'input') return { style: {}, addEventListener() {} };
            const listeners = new Map();
            currentInput = {
                value: '',
                style: {},
                matches: selector => selector.includes('input'),
                addEventListener(type, listener) {
                    const list = listeners.get(type) || [];
                    list.push(listener);
                    listeners.set(type, list);
                },
                focus() {},
                select() {},
                blur() {
                    for (const listener of listeners.get('blur') || []) listener();
                },
                dispatch(type, event) {
                    for (const listener of listeners.get(type) || []) listener(event);
                },
            };
            return currentInput;
        },
        addEventListener(type, listener) {
            const list = documentListeners.get(type) || [];
            list.push(listener);
            documentListeners.set(type, list);
        },
        dispatch(type, event) {
            for (const listener of documentListeners.get(type) || []) listener(event);
        },
    };
    globalThis.document = documentStub;
    globalThis.requestAnimationFrame = callback => callback();

    const cell = { textContent: '', appendChild() {} };
    const row = { dataset: { manualIndex: '0' }, querySelector: () => cell };
    let searches = 0;
    const modal = Object.assign(Object.create(MyLotModal.prototype), {
        entriesContainer: { querySelectorAll: () => [row] },
        manualRows: [{ lot: '' }],
        activeManualCell: { rowIndex: 0, cellType: 'lot' },
        selectedManualCells: new Set(['0_lot']),
        viewer: { showToast() {} },
        scheduleManualRowSearch() {},
        updateManualRowPreview() {},
        updateManualCellStyles() {},
        renderEntries() {},
        moveCellSelection() {},
        searchAndUpdateManualRowImage: async () => { searches += 1; },
    });

    // This mirrors the modal's document-level input branch so the test exercises
    // the real cell keydown listener followed by the bubbling blur path.
    modal.boundKeyHandler = event => {
        if (!event.target.matches('input, textarea')) return;
        if (event.key === 'Escape') {
            event.target.blur();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            event.target.blur();
            modal.moveCellSelection(1, 0);
            return;
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            event.target.blur();
            modal.moveCellSelection(0, event.shiftKey ? -1 : 1);
        }
    };
    documentStub.addEventListener('keydown', modal.boundKeyHandler);
    modal.startManualCellEdit('LOT_A');
    const event = {
        key,
        shiftKey: false,
        target: currentInput,
        preventDefault() {},
    };
    currentInput.dispatch('keydown', event);
    documentStub.dispatch('keydown', event);
    await Promise.resolve();
    return searches;
};

const calls = {};
for (const key of ['Enter', 'Tab', 'Escape']) {
    calls[key] = await runKeyPath(key);
    assert.equal(calls[key], 1, `${key} should commit one manual edit`);
}

console.log(JSON.stringify({ success: true, calls }));
