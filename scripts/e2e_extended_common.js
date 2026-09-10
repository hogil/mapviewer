const fs = require('fs');
const path = require('path');
const { createRunner } = require('./e2e_playwright_session');

async function createExtendedRunner(filename) {
  const runner = await createRunner(filename);
  const script = path.basename(filename, '.js').replace('e2e_extended_', '');
  const loginId = `e2eext_${runner.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-20)}_${script}`;
  const observations = [];
  const observed = new WeakSet();
  function observe(page) {
    if (observed.has(page)) return;
    observed.add(page);
    page.on('pageerror', error => observations.push({ type: 'pageerror', message: error.message, at: Date.now() }));
    page.on('response', response => {
      if (response.status() >= 500) observations.push({ type: 'http5xx', status: response.status(), url: response.url(), at: Date.now() });
    });
  }
  observe(runner.page);

  async function boot({ page = runner.page, loginId: user = loginId } = {}) {
    observe(page);
    const started = Date.now();
    await page.goto(`${runner.base}/?dev_success=true&LoginId=${encodeURIComponent(user)}&Username=${encodeURIComponent(user)}&extended=${Date.now()}`, {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.waitForFunction(() => window.viewer && window.__l3FullViewerReady, null, { timeout: 90000 });
    const actual = await page.evaluate(() => window.viewer.getCurrentLoginId());
    runner.expect(actual === user, `Test identity mismatch expected=${user} actual=${actual}`);
    return { loginId: actual, readyMs: Date.now() - started };
  }

  async function api(url, { method = 'GET', body, page = runner.page, loginId: user = loginId } = {}) {
    return page.evaluate(async args => {
      const target = new URL(args.url, location.origin);
      target.searchParams.set('LoginId', args.user);
      const started = performance.now();
      const response = await fetch(target, {
        method: args.method, cache: 'no-store',
        ...(args.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args.body) } : {}),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
      return { status: response.status, ok: response.ok, data, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
    }, { url, method, body, user });
  }

  async function visibleGrid(page = runner.page) {
    const inspect = () => {
      const viewer = window.viewer;
      const wrapper = document.querySelector('.grid-scroll-wrapper');
      const viewport = wrapper?.getBoundingClientRect();
      if (!viewer?.gridMode || !wrapper || getComputedStyle(wrapper).display === 'none' || !viewport?.width || !viewport?.height) return null;
      const wraps = [...document.querySelectorAll('#image-grid .grid-thumb-wrap')];
      const visible = wraps.filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
      });
      const images = visible.flatMap(element => [...element.querySelectorAll('img')]).filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(image).visibility !== 'hidden';
      });
      const loaded = images.filter(image => image.complete && image.naturalWidth > 1 && !image.currentSrc.startsWith('data:'));
      return {
        count: viewer.currentGridImages?.length || 0, wraps: wraps.length,
        visibleWraps: visible.length, loadedVisible: loaded.length,
        broken: images.length - loaded.length,
        paths: images.slice(0, 8).map(image => image.getAttribute('src')),
        scrollTop: wrapper.scrollTop,
      };
    };
    const poll = new Function(`const state = (${inspect.toString()})(); return state && state.visibleWraps > 0 && state.loadedVisible > 0 && state.broken === 0 ? state : false;`);
    const proof = await page.waitForFunction(poll, null, { timeout: 20000 });
    try { return await proof.jsonValue(); } finally { await proof.dispose(); }
  }

  async function visibleSingle(page = runner.page, expectedPath = null) {
    await page.waitForFunction(expected => {
      const viewer = window.viewer;
      const canvas = viewer?.dom?.imageCanvas;
      if (!canvas || viewer.gridMode || (expected && viewer.selectedImagePath !== expected)) return false;
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') return false;
      const sample = document.createElement('canvas');
      sample.width = sample.height = 32;
      const context = sample.getContext('2d');
      context.drawImage(canvas, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      return colors.size > 1;
    }, expectedPath, { timeout: 20000 });
    return page.evaluate(() => {
      const viewer = window.viewer;
      const canvas = viewer.dom.imageCanvas;
      const rect = canvas.getBoundingClientRect();
      const sample = document.createElement('canvas');
      sample.width = sample.height = 32;
      const context = sample.getContext('2d');
      context.drawImage(canvas, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      let hash = 2166136261;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      return {
        path: viewer.selectedImagePath,
        chipCount: viewer.chipAnnotator?.chips?.length || 0,
        chipCoords: (viewer.chipAnnotator?.chips || []).map(chip => [Number(chip.x_abs), Number(chip.y_abs)]),
        annotatorPath: viewer.chipAnnotator?.currentImagePath,
        canvasWidth: canvas.width, canvasHeight: canvas.height,
        visibleWidth: rect.width, visibleHeight: rect.height,
        colorCount: colors.size, bitmapSignature: hash.toString(16),
      };
    });
  }

  async function loadUnknown({ page = runner.page, limit = 0 } = {}) {
    await page.evaluate(async max => {
      const viewer = window.viewer;
      viewer.selectedImages = [];
      viewer.selectedFolders = new Set(['unknown']);
      viewer.lastSelectedFolderPath = 'unknown';
      viewer._unfilteredGridImages = [];
      const applied = await viewer.selectAllFolderFiles('unknown');
      if (!applied || !viewer.selectedImages.length) throw new Error('Real unknown dataset unavailable');
      const selected = max > 0 ? viewer.selectedImages.slice(0, max) : viewer.selectedImages;
      viewer.selectedImages = selected;
      viewer.showGrid(selected);
    }, limit);
    return visibleGrid(page);
  }

  async function snapshot(page) {
    return page.evaluate(() => {
      const viewer = window.viewer;
      return {
        url: location.href, ready: !!window.__l3FullViewerReady,
        gridMode: viewer?.gridMode, viewMode: viewer?.viewMode,
        selectedImagePath: viewer?.selectedImagePath,
        currentGridImages: viewer?.currentGridImages?.slice(0, 20),
        gridCount: viewer?.currentGridImages?.length,
        activePageId: viewer?.pageManager?.activePageId,
        chipPath: viewer?.chipAnnotator?.currentImagePath,
        chipCount: viewer?.chipAnnotator?.chips?.length,
      };
    });
  }

  async function record(phase, name, fn) {
    const filter = process.env.E2E_EXTENDED_RECORD_FILTER || '';
    if (filter && !filter.split(',').some(value => phase.includes(value.trim()))) return;
    runner.append(`[START] ${phase} ${name}\n`);
    const started = Date.now();
    const observedFrom = observations.length;
    let result;
    try {
      const detail = await fn();
      const uncaught = observations.slice(observedFrom).filter(item => item.type === 'pageerror');
      runner.expect(!uncaught.length, `Uncaught browser errors: ${JSON.stringify(uncaught)}`);
      result = { phase, name, status: 'PASS', detail: { ...detail, elapsedMs: Date.now() - started } };
    } catch (error) {
      result = { phase, name, status: 'FAIL', detail: { error: error.message, stack: error.stack, elapsedMs: Date.now() - started } };
    }
    const artifactName = `${script}-${phase.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    try {
      result.detail.state = await snapshot(runner.page);
      const screenshot = path.join(runner.outputDir, `${artifactName}.png`);
      await runner.page.screenshot({ path: screenshot, timeout: 8000 });
      result.detail.screenshot = screenshot;
    } catch (error) {
      result.detail.diagnosticError = error.message;
    }
    result.detail.observations = observations.slice(observedFrom);
    fs.writeFileSync(path.join(runner.outputDir, `${artifactName}.json`), JSON.stringify(result, null, 2), 'utf8');
    runner.results.push(result);
    runner.append(`[${result.status}] ${phase} ${name} :: ${JSON.stringify(result.detail)}\n`);
  }

  async function finish() {
    console.log(JSON.stringify(runner.results, null, 2));
    await runner.close();
    runner.append(`[DONE] total=${runner.results.length}\n`);
    process.exitCode = runner.results.some(result => result.status === 'FAIL') ? 2 : 0;
  }
  return { ...runner, loginId, boot, api, loadUnknown, visibleGrid, visibleSingle, record, finish };
}

module.exports = { createExtendedRunner };
