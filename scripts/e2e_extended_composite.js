const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createExtendedRunner } = require('./e2e_extended_common');

(async () => {
  const r = await createExtendedRunner(__filename);
  const { page, expect, record, boot, api, visibleGrid, visibleSingle, append } = r;
  const owned = new Set();
  const tasks = new Map();
  const prefix = `e2eext_comp_${crypto.createHash('sha256').update(r.loginId).digest('hex').slice(0, 18)}`;
  const actor = (name) => { const id = `${prefix}_${name}`; owned.add(id); return id; };
  const trace = (name, value) => append(`[COMPOSITE_CASE] ${name} :: ${JSON.stringify(value)}\n`);
  const request = (url, options = {}) => api(url, { page, ...options });
  const outputPath = (result) => result?.heatmaps?.[0]?.path || result?.sum_maps?.[0]?.path || result?.sum_map_path;
  const clean = (id, target = page) => request('/api/composite-cleanup', { method: 'POST', loginId: id, page: target });

  async function setup(name, target = page) {
    const id = actor(name);
    await boot({ page: target, loginId: id });
    await target.evaluate(async () => {
      await window.viewer.loadImagesInFolderAndShowGrid('PW/P001/20260501');
      const all = [...window.viewer.currentGridImages];
      const first = all.find((value) => value.endsWith('/AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.png'));
      if (!first) throw new Error('Required real P001 source is missing');
      // P001 intentionally contains three layout fixtures. Two real unknown wafers
      // share its 6400 canvas and 833 chip coordinates; verify them before combining.
      const selected = [first, ...all.filter((value) => value !== first).slice(0, 2),
        'unknown/CrescentArc/AAO270_00C_19_20260501_010000_99.2_1_PT_NORMAL.png',
        'unknown/BrokenRing/AAQ729_00C_20_20260501_010000_83.0_17_PE_ENGINEER.png'];
      if (selected.length !== 5) throw new Error('Three P001 plus two aligned unknown sources are required');
      const positions = await Promise.all(selected.map(async (imagePath) => {
        const response = await fetch(`/api/chip-positions?path=${encodeURIComponent(imagePath)}&include_fq=0`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Fixture positions unavailable ${response.status}: ${imagePath}`);
        return response.json();
      }));
      const signature = (data) => JSON.stringify({ canvas: data.coord?.canvas,
        chips: data.chips.map((c) => [Number(c.x_abs), Number(c.y_abs), c.rect]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) });
      const reference = signature(positions[0]);
      if (!positions.every((data) => signature(data) === reference)) throw new Error('Composite fixture coordinate geometry differs');
      await window.viewer.showGrid(selected, true);
      // LOT grouping legitimately orders cells; subsequent navigation follows that order.
      window.__extendedCompositeSources = [...window.viewer.currentGridImages];
      await window.viewer.enterSingleImageMode(0);
    });
    await target.waitForFunction(() => window.viewer?.chipAnnotator?.layoutProcessId === 'P001' &&
      window.viewer.chipAnnotator.shotBoundaryGroups?.size > 0, null, { timeout: 20000 });
    await visibleSingle(target);
    const fixture = await target.evaluate(() => {
      const v = window.viewer;
      const a = v.chipAnnotator;
      const shape = a.getShotGridShape();
      const total = shape.cols * shape.rows;
      const groups = [...a.shotBoundaryGroups.values()].filter((g) => g.chips?.length);
      const full = groups.find((g) => g.chips.length === total);
      const edge = groups.filter((g) => g.chips.length < total).sort((a, b) => a.chips.length - b.chips.length)[0];
      const pack = (g) => g && ({ shot_id: String(g.shotId), shot_shape: shape,
        chip_coords: g.chips.map((c) => {
          const slot = a._getShotGridSlotInfo(c, shape);
          return { x_abs: Number(c.x_abs), y_abs: Number(c.y_abs), slot_x: slot.slotX, slot_y: slot.slotY };
        }) });
      const chip = a.chips.find((c) => Number(c.x_abs) === 10 && Number(c.y_abs) === 0);
      if (!chip || !full || !edge) throw new Error('Chip/full Shot/edge Shot fixture missing');
      return { sources: window.__extendedCompositeSources, full: pack(full), edge: pack(edge),
        chip: { x_abs: Number(chip.x_abs), y_abs: Number(chip.y_abs) }, shape,
        sourceChipCount: a.chips.length };
    });
    expect(fixture.sources.length === 5 && fixture.edge.chip_coords.length < fixture.full.chip_coords.length,
      `Invalid fixture ${JSON.stringify(fixture)}`);
    trace(`${name}-fixture`, { id, ...fixture });
    return { id, ...fixture };
  }

  function payload(f, count, selection = 'chip') {
    const body = { image_paths: f.sources.slice(0, count) };
    if (selection === 'full') return body;
    body.selection_mode = selection === 'chip' ? 'chip' : 'shot';
    body.selected_chip_coords = selection === 'chip' ? [f.chip] : f[selection].chip_coords;
    if (selection !== 'chip') body.selected_shot_groups = [f[selection]];
    return body;
  }

  async function start(id, body, target = page) {
    trace('start', { id, body });
    const response = await request('/api/composite-map', { method: 'POST', body, loginId: id, page: target });
    expect(response.status === 200 && response.data?.task_id, `Composite start ${JSON.stringify(response)}`);
    const task = { id, taskId: response.data.task_id, target, body, startedAt: Date.now() };
    tasks.set(task.taskId, task);
    return task;
  }

  async function waitTask(task, { requireCompleted = true } = {}) {
    const deadline = Date.now() + 45000;
    let state;
    while (Date.now() < deadline) {
      const response = await request(`/api/composite-map/status/${encodeURIComponent(task.taskId)}`,
        { loginId: task.id, page: task.target });
      expect(response.status === 200, `Status request ${JSON.stringify(response)}`);
      state = response.data;
      if (['completed', 'failed', 'cancelled', 'canceled'].includes(state.status)) {
        tasks.delete(task.taskId);
        trace('task-terminal', { id: task.id, taskId: task.taskId, elapsedMs: Date.now() - task.startedAt, state });
        if (requireCompleted) expect(state.status === 'completed', `Composite failed ${JSON.stringify(state)}`);
        return state;
      }
      await task.target.waitForTimeout(100);
    }
    throw new Error(`Composite did not finish in 45s: ${JSON.stringify({ taskId: task.taskId, state })}`);
  }

  async function generate(f, count = 1, selection = 'chip', target = page) {
    await clean(f.id, target);
    return (await waitTask(await start(f.id, payload(f, count, selection), target))).result;
  }

  async function pixels(imagePath, id, target = page, extra = '') {
    return target.evaluate(async ({ imagePath, id, extra }) => {
      const response = await fetch(`/api/image?path=${encodeURIComponent(imagePath)}&LoginId=${encodeURIComponent(id)}${extra}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Output image ${response.status}: ${imagePath}`);
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((n) => n.toString(16).padStart(2, '0')).join('');
      const bitmap = await createImageBitmap(new Blob([bytes]));
      try {
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0, 64, 64);
        const rgba = context.getImageData(0, 0, 64, 64).data;
        const colors = new Set(); let opaque = 0;
        for (let i = 0; i < rgba.length; i += 4) { colors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`); if (rgba[i + 3]) opaque++; }
        return { width: bitmap.width, height: bitmap.height, bytes: bytes.byteLength, digest, colors: colors.size, opaque };
      } finally { bitmap.close(); }
    }, { imagePath, id, extra });
  }

  async function verifyResult(f, result, { selection = 'chip', target = page, open = true } = {}) {
    expect(result?.output_dir === `composite_map/${f.id}`, `Output escaped actor scope ${JSON.stringify(result)}`);
    const imagePath = outputPath(result);
    expect(imagePath?.startsWith(`${result.output_dir}/`), `Missing scoped output ${JSON.stringify(result)}`);
    // No readiness retry: completion must already have published positions and cache.
    const positions = await request(`/api/chip-positions?path=${encodeURIComponent(imagePath)}&include_fq=0`, { loginId: f.id, page: target });
    const expected = selection === 'chip' ? 1 : selection === 'full' ? f.sourceChipCount : f[selection].chip_coords.length;
    expect(positions.status === 200 && positions.data?.chips?.length === expected,
      `Immediate positions mismatch ${JSON.stringify({ expected, result, positions })}`);
    const bitmap = await pixels(imagePath, f.id, target);
    expect(bitmap.width === result.width && bitmap.height === result.height && bitmap.opaque > 0,
      `Actual output dimensions/pixels disagree ${JSON.stringify({ result, bitmap })}`);
    if (selection !== 'full') expect(bitmap.width < 6400 && bitmap.height < 6400, `Selected result retained full wafer ${JSON.stringify(bitmap)}`);
    let visible;
    if (open) {
      await target.evaluate(async (imagePath) => {
        const v = window.viewer;
        await v.showGrid([imagePath], true);
        await v.enterSingleImageMode(0);
      }, imagePath);
      await target.waitForFunction(({ imagePath, expected }) => {
        const a = window.viewer?.chipAnnotator;
        return a?.currentImagePath === imagePath && a.chips?.length === expected;
      }, { imagePath, expected }, { timeout: 10000 });
      visible = await visibleSingle(target, imagePath);
      expect(visible.chipCount === expected, `Displayed positions mismatch ${JSON.stringify(visible)}`);
    }
    return { imagePath, positions: expected, bitmap, visible };
  }

  async function subset(f, outputDir, grades = [0, 1], target = page) {
    const response = await request('/api/composite-subset', { method: 'POST', loginId: f.id, page: target,
      body: { output_dir: outputDir, selected_grades: grades } });
    expect(response.status === 200 && response.data?.success && response.data.subset_maps?.length === 2,
      `Immediate dependent subset ${JSON.stringify(response)}`);
    const decoded = await pixels(response.data.subset_maps[0].path, f.id, target);
    return { status: response.status, paths: response.data.subset_maps.map((x) => x.path), decoded };
  }

  try {
    await record('composite-ui-chip', 'Real Chip selection context menu → scoped Composite → immediate subset', async () => {
      const f = await setup('ui');
      const point = await page.evaluate((coord) => {
        const v = window.viewer, a = v.chipAnnotator;
        a.setSelectionMode('chip');
        const c = a.chips.find((c) => Number(c.x_abs) === coord.x_abs && Number(c.y_abs) === coord.y_abs);
        const rect = a.canvas.getBoundingClientRect();
        return { x: rect.left + (((c.rect.x0 + c.rect.x1) / 2 * v.transform.scale + v.transform.dx) / a.canvas.width) * rect.width,
          y: rect.top + (((c.rect.y0 + c.rect.y1) / 2 * v.transform.scale + v.transform.dy + (a.Y_OFFSET || 0)) / a.canvas.height) * rect.height };
      }, f.chip);
      await page.keyboard.down('Control');
      try { await page.mouse.click(point.x, point.y); } finally { await page.keyboard.up('Control'); }
      await page.waitForFunction(() => window.viewer.chipAnnotator.selectedChips.size === 1, null, { timeout: 5000 });
      await page.mouse.click(point.x, point.y, { button: 'right' });
      const responsePromise = page.waitForResponse((res) => res.url().includes('/api/composite-map?') && res.request().method() === 'POST', { timeout: 10000 });
      await page.locator('#chip-context-menu #chip-composite-create').click();
      const response = await responsePromise;
      const body = response.request().postDataJSON();
      expect(new URL(response.url()).searchParams.get('LoginId') === f.id, `UI used wrong identity ${response.url()}`);
      expect(body.selection_mode === 'chip' && body.selected_chip_coords.length === 1, `UI payload ${JSON.stringify(body)}`);
      const started = await response.json();
      const task = { id: f.id, taskId: started.task_id, target: page, startedAt: Date.now(), body };
      tasks.set(task.taskId, task);
      const terminal = await waitTask(task);
      const dependent = await subset(f, terminal.result.output_dir);
      await page.waitForFunction((id) => window.viewer.isCompositeMode && window.viewer.compositeSession?.outputDir === `composite_map/${id}`, f.id, { timeout: 15000 });
      return { request: body, dependent, result: await verifyResult(f, terminal.result) };
    });

    await record('composite-source-region-matrix', '1/2/5 sources × Chip/edge Shot/full Shot pixels and positions', async () => {
      const f = await setup('matrix');
      const cases = [];
      for (const count of [1, 2, 5]) for (const selection of ['chip', 'edge', 'fullShot']) {
        const selected = selection === 'fullShot' ? 'fullGroup' : selection;
        const matrixFixture = { ...f, fullGroup: f.full };
        const result = await generate(matrixFixture, count, selected);
        const checked = await verifyResult(matrixFixture, result, { selection: selected, open: count === 5 });
        expect(result.image_count === count, `Wrong source count ${JSON.stringify(result)}`);
        if (selected !== 'chip') {
          expect(result.selected_chip_count === matrixFixture[selected].chip_coords.length &&
            result.selected_shot_shape?.cols === f.shape.cols && result.selected_shot_shape?.rows === f.shape.rows,
          `Shot shape/selection mismatch ${JSON.stringify(result)}`);
        }
        cases.push({ count, selection, selectedChipCount: result.selected_chip_count, ...checked });
        trace('matrix-result', cases[cases.length - 1]);
      }
      return { cases };
    });

    await record('composite-same-user-overlap', 'Same user: active generation → cleanup → newer generation retains valid latest data', async () => {
      const f = await setup('overlap');
      await clean(f.id);
      const first = await start(f.id, payload(f, 5, 'full'));
      await page.waitForFunction(async ({ taskId, id }) => {
        const res = await fetch(`/api/composite-map/status/${taskId}?LoginId=${id}`, { cache: 'no-store' });
        return (await res.json()).status === 'processing';
      }, { taskId: first.taskId, id: f.id }, { timeout: 10000 });
      const cleanup = await clean(f.id);
      const second = await start(f.id, payload(f, 1, 'chip'));
      const terminal = await Promise.all([waitTask(first, { requireCompleted: false }), waitTask(second, { requireCompleted: false })]);
      trace('overlap-terminal', { id: f.id, first: first.body, second: second.body, cleanup, terminal });
      expect(terminal.every((state) => state.status === 'completed'), `Overlapping generations failed ${JSON.stringify(terminal)}`);
      const result = await verifyResult(f, terminal[1].result);
      const dependent = await subset(f, terminal[1].result.output_dir);
      expect(dependent.decoded.width === result.bitmap.width && dependent.decoded.height === result.bitmap.height,
        `Last task image and NPZ disagree ${JSON.stringify({ result, dependent })}`);
      return { cleanup, tasks: terminal, result, dependent };
    });

    await record('composite-two-user-isolation', 'Two users concurrently generate; cleaning A preserves B pixels and subset', async () => {
      const f = await setup('user_a');
      const context = await r.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
      const other = await context.newPage();
      const secondId = actor('user_b');
      try {
        await boot({ page: other, loginId: secondId });
        const g = { ...f, id: secondId, fullGroup: f.full };
        await Promise.all([clean(f.id), clean(g.id, other)]);
        const [a, b] = await Promise.all([start(f.id, payload(f, 1)), start(g.id, payload(g, 2, 'fullGroup'), other)]);
        const [left, right] = await Promise.all([waitTask(a), waitTask(b)]);
        const first = await verifyResult(f, left.result);
        const before = await verifyResult(g, right.result, { selection: 'fullGroup', target: other });
        expect(left.result.output_dir !== right.result.output_dir, 'Two users shared one output directory');
        await clean(f.id);
        const after = await pixels(before.imagePath, g.id, other);
        expect(before.bitmap.digest === after.digest, 'Cleaning user A changed user B output bytes');
        return { first, before, after, dependent: await subset(g, right.result.output_dir, [1, 2], other) };
      } finally {
        // All started B writers must stop before its directory is cleaned or browser closes.
        await Promise.all([...tasks.values()].filter((t) => t.id === secondId).map((t) => waitTask(t, { requireCompleted: false })));
        await clean(secondId, other);
        await context.close();
      }
    });

    await record('composite-recolor-responsive', 'Full Composite recolor runs alongside visible navigation and image requests', async () => {
      const f = await setup('responsive');
      const result = await generate(f, 2, 'full');
      const decoded = await verifyResult(f, result, { selection: 'full', open: false });
      await page.evaluate(async (sources) => { await window.viewer.showGrid(sources, true); await window.viewer.enterSingleImageMode(0); }, f.sources);
      await visibleSingle(page, f.sources[0]);
      const work = page.evaluate(async ({ id, outputDir, source }) => {
        const order = [];
        const timed = async (label, url, init) => {
          const start = performance.now(); const res = await fetch(url, { cache: 'no-store', ...init });
          const bytes = await res.arrayBuffer();
          const entry = { label, status: res.status, bytes: bytes.byteLength, elapsedMs: performance.now() - start };
          order.push(entry); return entry;
        };
        const recolor = timed('recolor', `/api/composite-recolor?LoginId=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ output_dir: outputDir, colors: ['#102030', '#e0b050', '#ffffff'] }) });
        const image = timed('image', `/api/image?path=${encodeURIComponent(source)}&level=0.2&LoginId=${id}`);
        await Promise.all([recolor, image]); return order;
      }, { id: f.id, outputDir: result.output_dir, source: f.sources[1] });
      await page.evaluate(() => window.viewer.navigateSingleImageGrid(1));
      const visible = await visibleSingle(page, f.sources[1]);
      const order = await work;
      trace('recolor-order', { order, visible });
      expect(order.every((entry) => entry.status === 200) && order.findIndex((e) => e.label === 'image') < order.findIndex((e) => e.label === 'recolor'),
        `Image blocked by recolor ${JSON.stringify(order)}`);
      return { decoded, order, visible, subset: await subset(f, result.output_dir, [0, 2, 4]) };
    });

    await record('composite-grade-bin-roundtrip', 'Repeated real Grade/Bottom legend controls restore rendered wafer after clearing', async () => {
      const f = await setup('filters');
      const before = await visibleSingle(page, f.sources[0]);
      const rounds = [];
      for (let round = 0; round < 3; round++) {
        const grade = page.locator('.legend-item[data-section="top"][data-index]').first();
        const bottom = page.locator('.legend-item[data-section="bottom"][data-key]').first();
        await grade.click();
        await bottom.click({ modifiers: ['Control'] });
        const filtered = await page.evaluate(() => ({ grades: [...window.viewer.selectedGrades], bins: [...window.viewer.selectedBottoms] }));
        expect(filtered.grades.length > 0 && filtered.bins.length > 0, `Filter control did not update ${JSON.stringify(filtered)}`);
        rounds.push({ filtered, visible: await visibleSingle(page, f.sources[0]) });
        await page.evaluate(async () => { await window.viewer.clearGradeFilter(); await window.viewer.clearBottomFilter(); });
      }
      await page.evaluate(() => window.viewer.exitSingleImageMode());
      await visibleGrid(page);
      await page.evaluate(() => window.viewer.enterSingleImageMode(0));
      const after = await visibleSingle(page, f.sources[0]);
      const cleared = await page.evaluate(() => ({ grades: [...window.viewer.selectedGrades], bins: [...window.viewer.selectedBottoms] }));
      expect(cleared.grades.length === 0 && cleared.bins.length === 0 && before.chipCount === after.chipCount,
        `Filters/positions leaked after roundtrip ${JSON.stringify({ before, after, cleared })}`);
      return { before, rounds, after, cleared };
    });

    await record('composite-measure-tab-palette', 'F/Q/Failbit selection and color editor survive actual tab round trips', async () => {
      const f = await setup('measure');
      const source = await request(`/api/chip-positions?path=${encodeURIComponent(f.sources[0])}&include_fq=1`, { loginId: f.id });
      expect(source.data?.ftn_keys?.length && source.data?.qtn_keys?.length, 'Fixture needs real F and Q keys');
      await page.evaluate(async (sources) => { await window.viewer.showGrid(sources.slice(0, 2), true); }, f.sources);
      const rounds = [];
      for (const field of ['f', 'q', 'f']) {
        const key = String(source.data[field === 'f' ? 'ftn_keys' : 'qtn_keys'][0]);
        const state = await page.evaluate(async ({ field, key }) => {
          const v = window.viewer;
          v.gridSelectedIdxs = [0, 1]; v.gridSelectedSet = new Set([0, 1]);
          v._measureCheckedItems = [{ type: 'failbit', key: null, label: 'Failbit' }, { type: field, key, label: `${field}:${key}` }];
          await v._applyMeasureSelection();
          const editor = await v._getColorEditor(); await editor.open('measure');
          return { role: v.pageManager.getActivePage().role, id: v.pageManager.activePageId };
        }, { field, key });
        await expectVisibleEditor();
        await page.evaluate(async () => (await window.viewer._getColorEditor()).close());
        const grid = await visibleGrid(page);
        const before = await page.evaluate(() => ({ items: window.viewer._measureCheckedItems, paths: [...window.viewer.currentGridImages], mode: window.viewer.overlayMode }));
        const ids = await page.evaluate(() => window.viewer.pageManager.pages.map((p) => p.id));
        const otherId = ids.find((id) => id !== state.id);
        expect(otherId, 'Measure flow did not retain an origin tab');
        await page.evaluate((id) => window.viewer.pageManager.activatePage(id), otherId);
        await visibleGrid(page);
        await page.evaluate((id) => window.viewer.pageManager.activatePage(id), state.id);
        await visibleGrid(page);
        const after = await page.evaluate(() => ({ items: window.viewer._measureCheckedItems, paths: [...window.viewer.currentGridImages], mode: window.viewer.overlayMode }));
        expect(JSON.stringify(before) === JSON.stringify(after), `Measure/tab mismatch ${JSON.stringify({ before, after })}`);
        rounds.push({ field, key, grid, before, after });
      }
      return { rounds };
    });

    await record('composite-export', 'Composite result UI download matches decoded server PNG exactly', async () => {
      const f = await setup('export');
      const result = await generate(f, 5);
      const verified = await verifyResult(f, result);
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
      await page.evaluate((imagePath) => window.viewer.downloadImage(imagePath), verified.imagePath);
      const download = await downloadPromise;
      const filename = `extended-composite-${prefix}.png`;
      const destination = path.join(r.outputDir, filename);
      await download.saveAs(destination);
      expect(!(await download.failure()), `Download failed ${await download.failure()}`);
      const bytes = fs.readFileSync(destination);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      expect(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && digest === verified.bitmap.digest,
        `Export differs from actual PNG ${JSON.stringify({ digest, expected: verified.bitmap.digest, bytes: bytes.length })}`);
      return { verified, download: { filename, suggestedFilename: download.suggestedFilename(), bytes: bytes.length, digest } };
    });
  } finally {
    // Drain only this script's task IDs; never clean real-user directories or shared input caches.
    const pending = await Promise.allSettled([...tasks.values()].map((task) => waitTask(task, { requireCompleted: false })));
    trace('drain', pending.map((item) => ({ status: item.status, error: item.reason?.message })));
    for (const id of owned) {
      if ([...tasks.values()].some((task) => task.id === id)) { trace('cleanup-deferred-active-task', { id }); continue; }
      try { trace('cleanup', { id, response: await clean(id) }); } catch (error) { trace('cleanup-error', { id, error: error.message }); }
    }
    await r.finish();
  }

  async function expectVisibleEditor() {
    await page.waitForFunction(() => document.getElementById('color-editor-modal')?.classList.contains('is-open') &&
      document.querySelector('#color-editor-tabs .color-editor-tab.active')?.dataset.tab === 'measure', null, { timeout: 5000 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
