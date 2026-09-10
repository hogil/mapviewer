const { randomUUID } = require('crypto');

module.exports = async function auditRegressions({ page, expect }) {
  const suffix = randomUUID().replace(/-/g, '');
  const originalGroup = `e2e_audit_${suffix}`;
  const renamedGroup = `${originalGroup}_renamed`;
  const detail = { endpoints: {}, invalidGroups: {} };
  const loginId = await page.evaluate(() => window.viewer.getCurrentLoginId());
  const api = async (url, method = 'GET', body = null) => page.evaluate(async (args) => {
    const target = new URL(args.url, location.origin);
    target.searchParams.set('LoginId', args.loginId);
    const response = await fetch(target, {
      method: args.method,
      headers: args.body ? { 'Content-Type': 'application/json' } : undefined,
      body: args.body ? JSON.stringify(args.body) : undefined,
      cache: 'no-store',
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, { url, method, body, loginId });

  // HEAD avoids transferring raw logs/source. Traversal probes never read a body.
  for (const url of ['/logs/stats.json', '/logs/access.log', '/static/api/full_app.py', '/static/AGENTS.md',
    '/static/cert/server.key', '/static/.git/config', '/js/%2e%2e%2fcert%2fserver.key', '/css/%2e%2e%2fcert%2fserver.key']) {
    const status = await page.evaluate(async (target) => (await fetch(target, {
      method: target.startsWith('/js/') || target.startsWith('/css/') ? 'GET' : 'HEAD',
    })).status, url);
    detail.endpoints[url] = status;
    expect(status === 404, `Private static route exposed: ${url} status=${status}`);
  }
  for (const url of ['/logs/color-legends.json', '/js/main.js']) {
    const status = await page.evaluate(async (target) => (await fetch(target, { cache: 'no-store' })).status, url);
    detail.endpoints[url] = status;
    expect(status === 200, `Public asset unavailable: ${url} status=${status}`);
  }
  const missing = await api(`/api/image?path=${encodeURIComponent(`unknown/e2e_missing_${suffix}.png`)}`);
  detail.endpoints.missingImage = missing.status;
  expect(missing.status === 404, `Missing image status=${missing.status}`);
  for (const group of ['.', '..']) {
    const result = await api(`/api/my-lot/entries?mode=wafer&group=${encodeURIComponent(group)}`);
    detail.invalidGroups[group] = result.status;
    expect(result.status === 400, `Invalid MY LOT group ${JSON.stringify(group)} status=${result.status}`);
  }

  const candidates = await page.evaluate(() => (window.viewer.currentGridImages || [])
    .filter(imagePath => String(imagePath).replace(/\\/g, '/').startsWith('unknown/')).slice(0, 12));
  let sourcePath = null;
  let expectedChips = 0;
  for (const candidate of candidates) {
    const positions = await api(`/api/chip-positions?path=${encodeURIComponent(candidate)}&include_fq=0&include_grade=1`);
    const chips = positions.data?.chips || [];
    if (positions.status === 200 && chips.length > 0) {
      sourcePath = candidate;
      expectedChips = new Set(chips.map(chip => `${Number(chip.x_abs)},${Number(chip.y_abs)}`)).size;
      break;
    }
  }
  expect(!!sourcePath, 'No real unknown image with chip positions in first 12 candidates');

  const openAndInspect = async (imagePath) => {
    await page.evaluate(async target => window.viewer.enterSingleViewMode(target), imagePath);
    await page.waitForFunction(({ target, count }) => {
      const viewer = window.viewer;
      const canvas = viewer?.dom?.imageCanvas;
      if (!canvas || viewer.gridMode || viewer.selectedImagePath !== target || viewer.chipAnnotator?.chips?.length !== count) return false;
      const rect = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
      const sample = document.createElement('canvas');
      sample.width = sample.height = 32;
      const context = sample.getContext('2d');
      context.drawImage(canvas, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3]) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      }
      return colors.size > 1;
    }, { target: imagePath, count: expectedChips });
    return page.evaluate(() => {
      const viewer = window.viewer;
      const canvas = viewer.dom.imageCanvas;
      const rect = canvas.getBoundingClientRect();
      return { chipCount: viewer.chipAnnotator.chips.length, canvasWidth: canvas.width, canvasHeight: canvas.height, visibleWidth: rect.width, visibleHeight: rect.height };
    });
  };

  let created = false;
  await page.evaluate(() => {
    const viewer = window.viewer;
    window.__auditRegressionRestore = { ...viewer.pageManager.getActivePage(), state: viewer.captureActivePageState() };
  });
  try {
    detail.before = await openAndInspect(sourcePath);
    const create = await api('/api/my-lot/group', 'POST', { mode: 'wafer', group: originalGroup });
    expect(create.status === 200 && create.data?.success, `MY LOT fixture creation failed: ${JSON.stringify(create)}`);
    created = true;
    const save = await api('/api/my-lot', 'POST', { mode: 'wafer', group: originalGroup, path: sourcePath });
    expect(save.status === 200 && save.data?.success, `MY LOT fixture save failed: ${JSON.stringify(save)}`);
    const rename = await api('/api/my-lot/group/rename', 'PUT', { mode: 'wafer', old_name: originalGroup, new_name: renamedGroup });
    expect(rename.status === 200 && rename.data?.success, `MY LOT rename failed: ${JSON.stringify(rename)}`);
    const entries = await api(`/api/my-lot/entries?mode=wafer&group=${encodeURIComponent(renamedGroup)}`);
    expect(entries.status === 200 && entries.data?.length === 1, `Renamed MY LOT entries incorrect: ${JSON.stringify(entries)}`);
    const renamedPath = entries.data[0].path;
    expect(renamedPath.split('/').includes(renamedGroup), 'Renamed entry does not belong to the temporary group');
    detail.after = await openAndInspect(renamedPath);
    expect(detail.after.chipCount === detail.before.chipCount, 'MY LOT rename lost chip positions');
    return detail;
  } finally {
    const cleanupErrors = [];
    if (created) {
      for (const group of [originalGroup, renamedGroup]) {
        try {
          const result = await api('/api/my-lot/group', 'DELETE', { mode: 'wafer', group });
          if (![200, 404].includes(result.status)) cleanupErrors.push(`Temporary group cleanup status=${result.status}`);
        } catch (error) {
          cleanupErrors.push(`Temporary group cleanup: ${error.message}`);
        }
      }
    }
    await page.evaluate(async () => {
      const snapshot = window.__auditRegressionRestore;
      delete window.__auditRegressionRestore;
      if (snapshot) {
        await window.viewer.applyPageState(snapshot);
        window.viewer.persistActivePageState();
      }
    });
    expect(cleanupErrors.length === 0, cleanupErrors.join('; '));
  }
};
