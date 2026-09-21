import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'js', 'chip-annotator.js'), 'utf8');
const { ChipAnnotator } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
assert.equal(typeof ChipAnnotator.prototype.isChipSelectable, 'function');

const makeChip = gridMode => Object.assign(Object.create(ChipAnnotator.prototype), {
    viewer: { gridMode },
    chips: [{ x_abs: 1, y_abs: 1 }, { x_abs: 2, y_abs: 2 }],
    selectedChips: new Set([0]),
    selectedChipsOrder: [0],
    isChipSelectable: () => true,
    render() {},
    updateSelectedChipsList() {},
});

const makeTarget = ({ tagName = 'DIV', isContentEditable = false } = {}) => ({
    tagName,
    isContentEditable,
    matches(selector) {
        const selectors = selector.split(',').map(value => value.trim());
        return selectors.includes(tagName.toLowerCase()) ||
            (isContentEditable && selectors.includes('[contenteditable="true"]'));
    },
    closest() { return null; },
});

const dispatchCtrlA = (annotator, target) => {
    let defaultPrevented = false;
    annotator._handleKeyDown({
        ctrlKey: true,
        metaKey: false,
        key: 'a',
        target,
        preventDefault() { defaultPrevented = true; },
    });
    return { defaultPrevented, selected: [...annotator.selectedChips].sort((a, b) => a - b) };
};

for (const gridMode of [false, true]) {
    for (const target of [
        makeTarget({ tagName: 'INPUT' }),
        makeTarget({ tagName: 'TEXTAREA' }),
        makeTarget({ tagName: 'SELECT' }),
        makeTarget({ isContentEditable: true }),
    ]) {
        const annotator = makeChip(gridMode);
        const result = dispatchCtrlA(annotator, target);
        assert.equal(result.defaultPrevented, false);
        assert.deepEqual(result.selected, [0]);
    }
}

const annotator = makeChip(false);
const result = dispatchCtrlA(annotator, makeTarget());
assert.equal(result.defaultPrevented, true);
assert.deepEqual(result.selected, [0, 1]);

console.log(JSON.stringify({ success: true, checks: 9 }));
