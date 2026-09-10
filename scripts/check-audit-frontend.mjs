// Focused regression checks using original methods and mocked I/O, not browser E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => fs.readFileSync(path.join(root, 'js', name), 'utf8');
const imp = name => import('data:text/javascript;base64,' + Buffer.from(source(name)).toString('base64'));
const { MyLotModal } = await imp('my-lot.js');
const { ChipAnnotator } = await imp('chip-annotator.js');
const main = source('main.js');
const method = (name, next) => {
    const start = main.search(new RegExp('^    (?:async )?' + name + '\\(', 'm'));
    const end = main.search(new RegExp('^    (?:async )?' + next + '\\(', 'm'));
    assert.ok(start >= 0 && end > start, `Method boundaries: ${name}`);
    return Function('return ({' + main.slice(start, end) + '})')()[name];
};
const noop = () => {};
const response = data => ({ ok: true, json: async () => data });
let pending;
const deferFetch = () => {
    pending = [];
    globalThis.fetch = (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }));
};
const createChip = () => Object.assign(Object.create(ChipAnnotator.prototype), {
    layoutByChip: new Map(), chipIndexMap: new Map(), shotBoundaryGroups: new Map(),
    _invalidateShotGeometry: noop, _buildChipIndexMap: noop, _buildSpatialGrid: noop,
    _updateMetadataDisplay: noop, _extractMetadataValue: () => null,
    _refreshClassColors: noop, _notifyLegendUpdate: noop, render: noop,
});
const checks = [];
const check = async (name, run) => { await run(); checks.push(name); };
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalConsole = { ...console };
console.log = console.warn = console.error = noop;

try {
    await check('Deferred column rerender cannot replace a new single view or another tab', async () => {
        const originalSetTimeout = globalThis.setTimeout;
        let queued;
        globalThis.setTimeout = callback => { queued = callback; };
        try {
            let renders = 0;
            const viewer = { pageManager: { activePageId: 'A' }, gridMode: true, viewMode: null,
                singleImageFromGrid: false, currentGridImages: ['first.png'], showGrid: () => renders++ };
            const schedule = method('scheduleShowGrid', 'showGridFromLabelExplorer');
            schedule.call(viewer);
            viewer.gridMode = false; viewer.viewMode = 'gridImage'; viewer.singleImageFromGrid = true;
            queued();
            assert.equal(renders, 0);
            assert.equal(viewer._showGridScheduled, false);
            viewer.gridMode = true; viewer.viewMode = null; viewer.singleImageFromGrid = false;
            schedule.call(viewer);
            viewer.pageManager.activePageId = 'B';
            queued();
            assert.equal(renders, 0);
            schedule.call(viewer); queued();
            assert.equal(renders, 1);
        } finally { globalThis.setTimeout = originalSetTimeout; }
    });

    await check('Image load invalidated during runtime bootstrap cannot reopen a closed view', async () => {
        let resolveRuntime;
        const runtime = new Promise(resolve => { resolveRuntime = resolve; });
        const viewer = { _loadImageRequestSeq: 0, singleImageFromGrid: true,
            _primeDeferredUiBootstrap: noop, _ensureViewerRuntime: () => runtime,
            _getChipAnnotator: async () => ({}),
            isLabelExplorerIsolationActive: () => { throw Error('Canceled image resumed after runtime bootstrap'); } };
        const loading = method('loadImage', 'updateWaferMapExplorerHighlight').call(viewer, 'old.png');
        assert.equal(viewer._loadImageRequestSeq, 1);
        viewer._loadImageRequestSeq++;
        resolveRuntime();
        await loading;
    });

    await check('MY LOT group response ownership and stale failure', async () => {
        deferFetch();
        const modal = Object.assign(Object.create(MyLotModal.prototype), {
            activeMode: 'lot', activeGroup: 'A', entriesContainer: { innerHTML: '' },
            data: { lot: { groups: [{ name: 'A', entries: [] }, { name: 'B', entries: [] }] } },
            _withLogin: x => x, renderEntries() { this.entriesContainer.innerHTML = this.activeGroup; },
        });
        const a = modal.loadActiveGroupEntriesAndRender();
        modal.activeGroup = 'B';
        const b = modal.loadActiveGroupEntriesAndRender();
        pending[1].resolve(response([{ value: 'B-row' }])); await b;
        pending[0].resolve(response([{ value: 'A-row' }])); await a;
        assert.deepEqual(modal.data.lot.groups[1].entries, [{ value: 'B-row' }]);
        const old = modal.loadActiveGroupEntriesAndRender();
        const latest = modal.loadActiveGroupEntriesAndRender();
        pending[3].resolve(response([{ value: 'latest' }])); await latest;
        pending[2].reject(Error('old network failure')); await old;
        assert.deepEqual(modal.data.lot.groups[1].entries, [{ value: 'latest' }]);
        assert.equal(modal.entriesContainer.innerHTML, 'B');
    });

    await check('Positions keep latest path and ignore stale failures', async () => {
        for (const failOld of [false, true]) {
            deferFetch();
            const chip = createChip();
            const a = chip.loadPositions(`old-${failOld}`, { loadAnnotations: false, render: false });
            const b = chip.loadPositions(`new-${failOld}`, { loadAnnotations: false, render: false });
            pending[1].resolve(response({ chips: [{ x_abs: 2, y_abs: 2, source: 'B' }] }));
            assert.equal(await b, true);
            if (failOld) pending[0].reject(Error('old network failure'));
            else pending[0].resolve(response({ chips: [{ x_abs: 1, y_abs: 1, source: 'A' }] }));
            assert.equal(await a, false);
            assert.equal(chip.currentImagePath, `new-${failOld}`);
            assert.equal(chip.chips[0].source, 'B');
        }
    });

    await check('Positions guard body decoding and same-path reloads', async () => {
        deferFetch();
        const chip = createChip();
        const a = chip.loadPositions('repeat', { loadAnnotations: false, render: false });
        let finishBody;
        pending[0].resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) });
        await Promise.resolve();
        const b = chip.loadPositions('repeat', { loadAnnotations: false, render: false });
        pending[1].resolve(response({ chips: [{ source: 'latest' }] })); await b;
        finishBody({ chips: [{ source: 'old' }] });
        assert.equal(await a, false);
        assert.equal(chip.chips[0].source, 'latest');
    });

    await check('Positions abort before next image positions request', async () => {
        deferFetch();
        const chip = createChip();
        chip.chips = [{ source: 'unchanged' }];
        const controller = new AbortController();
        const task = chip.loadPositions('aborted', { loadAnnotations: false, render: false, signal: controller.signal });
        assert.equal(pending[0].options.signal, controller.signal);
        controller.abort();
        pending[0].resolve(response({ chips: [{ source: 'old' }] }));
        assert.equal(await task, false);
        assert.equal(chip.chips[0].source, 'unchanged');
    });

    await check('Regenerated Composite paths reload positions while source paths retain cache', async () => {
        const chip = createChip();
        let calls = 0;
        let count = 1;
        globalThis.fetch = async (url, options) => {
            calls++;
            if (url.includes('composite_map')) assert.equal(options.cache, 'no-store');
            return response({ chips: Array.from({ length: count }, (_, x) => ({ x_abs: x, y_abs: 0 })) });
        };
        const options = { loadAnnotations: false, render: false };
        for (const nextCount of [1, 21, 24]) {
            count = nextCount;
            await chip.loadPositions('composite_map/regeneration/Grade_0.png', options);
            assert.equal(chip.chips.length, count);
        }
        assert.equal(calls, 3);
        await chip.loadPositions('unknown/cache-control.png', options);
        await chip.loadPositions('unknown/cache-control.png', options);
        assert.equal(calls, 4, 'Unchanged source positions should still use the cache');
    });

    await check('Annotation ownership across paths, same path, failure and abort', async () => {
        for (const scenario of ['path', 'same-path', 'failure', 'abort', 'folder']) {
            deferFetch();
            const chip = createChip();
            chip.viewer = { currentFolderPrefix: 'folder-a' };
            chip.currentImagePath = 'A';
            const controller = new AbortController();
            const old = chip.loadAnnotations('A', { signal: controller.signal });
            if (scenario === 'path') chip.currentImagePath = 'B';
            if (scenario === 'folder') chip.viewer.currentFolderPrefix = 'folder-b';
            if (scenario === 'abort') {
                chip.markedChips = [{ class: 'latest' }];
                controller.abort();
            } else {
                const latest = chip.loadAnnotations(chip.currentImagePath);
                pending[1].resolve(response({ marked_chips: [{ class: 'latest' }] })); await latest;
            }
            if (scenario === 'failure') pending[0].reject(Error('old network failure'));
            else pending[0].resolve(response({ marked_chips: [{ class: 'old' }] }));
            await old;
            assert.deepEqual(chip.markedChips, [{ class: 'latest' }], scenario);
        }
    });

    await check('Permission search retries transient failure', async () => {
        const viewer = { ensureStatsUsersLoaded: method('ensureStatsUsersLoaded', 'handlePermissionSearch') };
        let calls = 0;
        globalThis.fetch = async () => { calls++; throw Error('temporary offline'); };
        await assert.rejects(viewer.ensureStatsUsersLoaded(), /temporary offline/);
        globalThis.fetch = async () => { calls++; return response({ users: [{ profile: { LoginId: 'recovered' } }] }); };
        await viewer.ensureStatsUsersLoaded();
        assert.equal(calls, 2);
        assert.equal(viewer.permissionStatsUsers[0].loginId, 'recovered');
    });

    let save;
    await check('MY LOT save retains submitted mode and group', async () => {
        let finishSearch, posted;
        globalThis.fetch = async (url, options) => { posted = JSON.parse(options.body); return response({ success_count: 1 }); };
        save = Object.assign(Object.create(MyLotModal.prototype), {
            activeMode: 'lot', activeGroup: 'A',
            viewer: { currentGridImages: ['LOT_test_W01.png'], gridSelectedIdxs: [0], extractLotTokensFromPath: () => ({ lotValue: 'LOT' }), showToast: noop },
            _withLogin: x => x, searchImagesByLots: () => new Promise(resolve => { finishSearch = resolve; }),
            refreshData: async () => {}, loadActiveGroupEntriesAndRender: async () => {},
        });
        const task = save.handleSave();
        save.activeMode = 'wafer'; save.activeGroup = 'B';
        finishSearch(['LOT_test_W01.png']); await task;
        assert.deepEqual(posted, { mode: 'lot', group: 'A', paths: ['LOT_test_W01.png'] });
    });

    await check('MY LOT reports success, duplicates and partial failures in both modes', async () => {
        for (const mode of ['wafer', 'lot']) {
            for (const counts of [{ success_count: 0, duplicate_count: 0, error_count: 1 }, { success_count: 2, duplicate_count: 3, error_count: 1 }]) {
                const messages = [];
                globalThis.fetch = async () => response({ success: true, ...counts });
                save.activeMode = mode;
                save.searchImagesByLots = async () => ['LOT_test_W01.png'];
                save.viewer.showToast = message => messages.push(message);
                await save.handleSave();
                const result = messages.at(-1);
                assert.ok(result.includes(`${counts.success_count}개 저장`), result);
                assert.ok(result.includes('1개 실패'), result);
                if (counts.duplicate_count) assert.ok(result.includes('3개 중복'), result);
            }
        }
    });

    await check('Next/Prev fallback uses index directly and wraps', async () => {
        globalThis.document = { getElementById: () => null };
        const nav = {
            viewMode: 'gridImage', gridViewImageList: ['first.png', 'second.png'], selectedImagePath: 'missing.png', gridViewImageIndex: 0,
            _imageLoadVersion: 0, normalizePath: x => x, showFileName: noop, updatePyramidLevel: noop,
            loadImage: async () => {}, findImageIndexInList: method('findImageIndexInList', 'updateArrowButtonVisibility'),
            navigateSingleImageGrid: method('navigateSingleImageGrid', 'navigateSingleImageMode'),
        };
        nav.navigateSingleImageGrid(1); await Promise.resolve();
        assert.equal(nav.selectedImagePath, 'second.png');
        assert.equal(nav._isNavigating, false);
        nav.navigateSingleImageGrid(1); await Promise.resolve();
        assert.equal(nav.selectedImagePath, 'first.png');
    });

    await check('Delayed scroll restoration belongs to its page', async () => {
        const start = main.indexOf('let lastRestoredScrollTop = this.getGridScrollWrapper()?.scrollTop;');
        const end = main.indexOf('requestAnimationFrame(restorePageGridScroll);', start);
        assert.ok(start >= 0 && end > start);
        const makeCallback = Function('page', 'pageGridScrollTop', main.slice(start, end) + 'return restorePageGridScroll;');
        const scroll = { scrollTop: 20 };
        globalThis.document = { getElementById: () => ({ closest: () => scroll }) };
        const viewer = { gridMode: true, getGridScrollWrapper: () => scroll,
            pageManager: { activePageId: 'B' }, savedViewState: { type: 'grid', scrollTop: 20 } };
        const callback = makeCallback.call(viewer, { id: 'A' }, 500);
        callback();
        assert.equal(scroll.scrollTop, 20);
        assert.equal(viewer.savedViewState.scrollTop, 20);
        viewer.pageManager.activePageId = 'A'; callback();
        assert.equal(scroll.scrollTop, 500);
        assert.equal(viewer.savedViewState.scrollTop, 500);
        scroll.scrollTop = 700;
        callback();
        assert.equal(scroll.scrollTop, 700, 'A new user scroll must cancel delayed restoration');
    });

    await check('Cached scroll restoration respects page ownership and newer scroll', async () => {
        const start = main.indexOf('let lastRestoredScrollTop = scrollWrapper?.scrollTop;');
        const end = main.indexOf('        restoreCachedScroll();', start);
        assert.ok(start >= 0 && end > start);
        const makeCallback = Function('pageId', 'scrollWrapper', 'cachedScrollTop', 'cachedScrollLeft',
            main.slice(start, end) + 'return restoreCachedScroll;');
        const scroll = { scrollTop: 0, scrollLeft: 0 };
        const viewer = { gridMode: true, viewMode: null, getGridScrollWrapper: () => scroll,
            pageManager: { activePageId: 'A' }, savedViewState: { type: 'grid', scrollTop: 0 } };
        const callback = makeCallback.call(viewer, 'A', scroll, 100, 0);
        callback();
        assert.equal(scroll.scrollTop, 100);
        viewer.pageManager.activePageId = 'B';
        scroll.scrollTop = 200;
        callback();
        assert.equal(scroll.scrollTop, 200);
        viewer.pageManager.activePageId = 'A';
        scroll.scrollTop = 700;
        callback();
        assert.equal(scroll.scrollTop, 700);
        scroll.scrollTop = 100;
        callback();
        assert.equal(scroll.scrollTop, 100);
    });
} finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    Object.assign(console, originalConsole);
}
console.log(JSON.stringify({ success: true, checks }, null, 2));
