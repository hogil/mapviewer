// Isolated lifecycle checks; no browser or application data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../js/my-lot.js', import.meta.url), 'utf8');
const { MyLotModal } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const noop = () => {};
globalThis.document = { addEventListener: noop, removeEventListener: noop, querySelector: () => null };
const create = () => {
    const classes = new Set();
    const modal = Object.assign(Object.create(MyLotModal.prototype), {
        windowEl: { style: {}, classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } },
        updatedGroups: new Set(), selectedManualCells: new Set(), activeMode: 'lot',
        ensureManualRows: noop, ensureWindowBounds: noop, updateCurrentValues: noop,
        updatePendingButtonVisibility: noop, updateCopyButtonVisibility: noop,
        stopDragSelection: noop, deleteTempGroupIfExists: async () => {},
        renderGroups: noop, viewer: { showToast: message => { throw Error(message); } },
        modeCalls: [], setMode: async function(mode) { this.modeCalls.push(mode); this.activeMode = mode; },
        loadCalls: [], loadActiveGroupEntriesAndRender: async function() { this.loadCalls.push([this.activeMode, this.activeGroup]); },
    });
    let release;
    modal.refreshData = () => new Promise(resolve => { release = resolve; });
    return { modal, release: () => release() };
};
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const checks = [];
{
    const { modal, release } = create();
    let completed = false;
    const task = modal.open().then(() => { completed = true; });
    await flush();
    assert.equal(completed, false, 'open must await its outstanding refresh');
    assert.equal(modal.windowEl.style.display, 'flex', 'window appears before refresh finishes');
    modal.activeMode = 'wafer'; modal.activeGroup = 'B';
    release(); await task;
    assert.deepEqual(modal.modeCalls, ['lot'], 'late refresh must not reset current selection');
    assert.deepEqual(modal.loadCalls, [['wafer', 'B']], 'current group entries must be reloaded');
    checks.push('open waits for refresh without resetting user mode/group');
}
{
    const { modal, release } = create();
    const task = modal.open(); await flush();
    modal.close(); release(); await task;
    assert.deepEqual(modal.loadCalls, [], 'closed modal must not render or reload from old open');
    checks.push('close invalidates pending open refresh');
}
{
    const { modal } = create();
    modal.activeMode = 'wafer'; modal.activeGroup = 'owned';
    modal.data = { login_id: 'user_b' };
    const imagePath = 'my-lot/user_b/wafer/owned/sample.png';
    modal.getSelectedEntries = () => [{ path: imagePath }];
    modal.ensureMyLotPage = noop;
    modal.viewer = { getCurrentLoginId: () => 'user_b', showGrid: values => { modal.shown = values; } };
    await modal.openSelectionInViewer();
    assert.deepEqual(modal.shown, [imagePath]);
    assert.equal(modal.viewer.currentFolderPath, 'my-lot/user_b/wafer/owned');
    checks.push('group grid scope uses actual owner');
}
console.log(JSON.stringify({ success: true, checks }, null, 2));
