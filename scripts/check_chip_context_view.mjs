import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const start = source.indexOf('        const annotator = this.chipAnnotator;', source.indexOf('    showChipContextMenu('));
const end = source.indexOf('        // 정보 복사 옵션', start);
assert.ok(start > 0 && end > start);
const run = new Function('event', 'selectedChips', 'document', 'menu', source.slice(start, end));
const hit = { x_abs: 8, y_abs: 9 };
const selected = { x_abs: 1, y_abs: 2 };
for (const selection of [[], [selected], [selected, { x_abs: 3, y_abs: 4 }]]) {
    const items = [];
    let opened;
    const viewer = {
        chipAnnotator: {
            canvas: { width: 400, height: 200, getBoundingClientRect: () => ({ left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100 }) },
            findChipAtPixel(x, y) { assert.equal(x, 100); assert.equal(y, 60); return hit; },
        },
        showChipViewModal(chip) { opened = chip; },
    };
    const menu = { appendChild(item) { items.push(item); }, remove() {} };
    run.call(viewer, { clientX: 60, clientY: 50 }, selection, { createElement: () => ({ style: {} }) }, menu);
    assert.equal(items.length, 1);
    assert.equal(items[0].textContent, 'Chip 보기');
    items[0].onclick();
    assert.equal(opened, hit);
    assert.deepEqual(selection, selection.length === 0 ? [] : selection.length === 1 ? [selected] : [selected, { x_abs: 3, y_abs: 4 }]);
}
for (const [selection, expectedCount] of [[[], 0], [[selected], 1]]) {
    const items = [];
    const viewer = { chipAnnotator: { hoveredChip: hit, canvas: { getBoundingClientRect: () => ({ width: 0, height: 0 }) } }, showChipViewModal(chip) { assert.equal(chip, selected); } };
    run.call(viewer, { clientX: 500, clientY: 500 }, selection, { createElement: () => ({ style: {} }) }, { appendChild(item) { items.push(item); }, remove() {} });
    assert.equal(items.length, expectedCount);
    if (items.length) items[0].onclick();
}
console.log('PASS: unselected hover, other selection, multiple selection, CSS scaling, blank/stale hover, selected fallback');
