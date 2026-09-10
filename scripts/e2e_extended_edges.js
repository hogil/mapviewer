const { createExtendedRunner } = require('./e2e_extended_common');

(async () => {
  const r = await createExtendedRunner(__filename);
  const { page, expect } = r;
  page.on('dialog', dialog => dialog.dismiss());
  const prepare = async () => {
    await r.boot();
    await r.loadUnknown({ limit: 40 });
    return page.evaluate(() => window.viewer.currentGridImages.slice(0, 8));
  };
  const search = async query => page.evaluate(async value => {
    window.viewer.dom.fileSearch.value = value;
    return window.viewer.performSearch({ suppressAlerts: true });
  }, query);
  const gridState = () => page.evaluate(() => ({
    paths: window.viewer.currentGridImages.slice(),
    busy: window.viewer._searchBusy,
    disabled: window.viewer.dom.searchBtn.disabled,
  }));

  await r.record('edge-search-recovery', 'Search 503, malformed response, retry and visible result recovery', async () => {
    const paths = await prepare();
    const lot = paths[0].split('/').pop().split('_')[0];
    const cases = [];
    for (const failure of [{ status: 503, body: '{"detail":"injected unavailable"}' }, { status: 200, body: '{"success":true,"results":null}' }]) {
      const before = await gridState();
      const handler = route => route.fulfill({ ...failure, contentType: 'application/json' });
      await page.route('**/api/search?**', handler, { times: 1 });
      try {
        expect(await search(lot) === false, 'Invalid search response reported success');
        const failed = await gridState();
        expect(!failed.busy && !failed.disabled, 'Search remains locked after failed response');
        expect(JSON.stringify(failed.paths) === JSON.stringify(before.paths), 'Failed search replaced the existing grid');
        expect(await search(lot), 'Search retry failed');
        const visible = await r.visibleGrid();
        const recovered = await gridState();
        expect(recovered.paths.every(value => value.split('/').pop().startsWith(`${lot}_`)), 'Retry displayed unrelated LOT');
        cases.push({ injectedStatus: failure.status, visible, count: recovered.paths.length });
      } finally { await page.unroute('**/api/search?**', handler); }
    }
    return { lot, cases };
  });

  await r.record('edge-search-order', 'Three rapid searches with a held older real response', async () => {
    const paths = await prepare();
    const lots = [...new Set(paths.map(value => value.split('/').pop().split('_')[0]))].slice(0, 3);
    expect(lots.length === 3, 'Need three distinct real LOTs');
    let release;
    let received;
    const gate = new Promise(resolve => { release = resolve; });
    const held = new Promise(resolve => { received = resolve; });
    const handler = async route => {
      const response = await route.fetch();
      received();
      await gate;
      try { await route.fulfill({ response }); } catch (error) {
        if (!/closed|disposed|cancel|abort/i.test(error.message)) throw error;
      }
    };
    await page.route(`**/api/search?q=${lots[0]}&**`, handler, { times: 1 });
    const first = search(lots[0]);
    try {
      await Promise.race([held, r.sleep(15000).then(() => { throw new Error('Older search was not intercepted'); })]);
      const second = search(lots[1]);
      const third = search(lots[2]);
      await Promise.all([second, third]);
      const beforeRelease = await gridState();
      release();
      await first;
      await page.waitForTimeout(100);
      const afterRelease = await gridState();
      expect(afterRelease.paths.length > 0 && afterRelease.paths.every(value => value.split('/').pop().startsWith(`${lots[2]}_`)), 'Older search replaced latest input results');
      expect(JSON.stringify(beforeRelease.paths) === JSON.stringify(afterRelease.paths), 'Held response changed current search');
      expect(!afterRelease.busy && !afterRelease.disabled, 'Search button not restored');
      return { lots, count: afterRelease.paths.length, visible: await r.visibleGrid() };
    } finally {
      release();
      await first;
      await page.unroute(`**/api/search?q=${lots[0]}&**`, handler);
    }
  });

  await r.record('edge-permission-recovery', 'Permission lookup failure, retry and search clear without changing grants', async () => {
    await prepare();
    await page.evaluate(() => window.viewer.openPermissionEditorModal());
    const handler = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"injected stats failure"}' });
    await page.route('**/api/stats/users', handler, { times: 1 });
    try {
      await page.evaluate(async () => {
        window.viewer.permissionStatsUsers = null;
        window.viewer.dom.permissionSearchInput.value = 'e2eext';
        await window.viewer.handlePermissionSearch();
      });
      const failure = await page.evaluate(() => ({ text: window.viewer.dom.permissionSearchResults.textContent, cache: window.viewer.permissionStatsUsers }));
      expect(failure.text.includes('불러올 수 없습니다') && failure.cache === null, 'Lookup failure was cached as an empty successful list');
      await page.evaluate(() => window.viewer.handlePermissionSearch());
      const retry = await page.evaluate(() => ({ text: window.viewer.dom.permissionSearchResults.textContent, users: window.viewer.permissionStatsUsers?.length }));
      expect(retry.users > 0 && !retry.text.includes('불러올 수 없습니다'), 'Lookup retry did not load real users');
      await page.evaluate(async () => {
        window.viewer.dom.permissionSearchInput.value = '  ';
        await window.viewer.handlePermissionSearch();
      });
      expect(await page.evaluate(() => !window.viewer.dom.permissionSearchResults.classList.contains('is-open')), 'Blank query left stale permission results visible');
      return { failureText: failure.text, userCount: retry.users };
    } finally {
      await page.unroute('**/api/stats/users', handler);
      await page.evaluate(() => window.viewer.closePermissionEditorModal());
    }
  });

  await r.record('edge-invalid-inputs', 'Invalid paths, group names, recolor bodies and chip rectangles preserve the viewer', async () => {
    const paths = await prepare();
    const before = await gridState();
    const cases = [];
    const check = async (name, url, options, allowed) => {
      const result = await r.api(url, options);
      cases.push({ name, status: result.status, elapsedMs: result.elapsedMs });
      expect(allowed.includes(result.status), `${name}: expected ${allowed}, actual ${result.status} ${JSON.stringify(result.data)}`);
    };
    await check('missing-image', '/api/image?path=unknown/e2e_ext_missing.png', {}, [404]);
    for (const group of ['.', '..']) {
      await check(`invalid-group-${group}`, `/api/my-lot/entries?mode=wafer&group=${encodeURIComponent(group)}`, {}, [400]);
    }
    for (const body of [null, [], 'bad', {}, { output_dir: '../outside' }, { output_dir: 'unknown' }, { output_dir: 'composite_map/e2e_absent', colors: {} }]) {
      await check(`recolor-${JSON.stringify(body)}`, '/api/composite-recolor', { method: 'POST', body }, [400]);
    }
    const chip = { x_abs: 0, y_abs: 0, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } };
    for (const value of [
      { ...chip, x_abs: '0' }, { ...chip, y_abs: 1.5 }, { ...chip, bbox: null },
      { ...chip, bbox: { x0: 2, y0: 0, x1: 1, y1: 1 } },
      { ...chip, bbox: { x0: 0, y0: 1, x1: 1, y1: 1 } },
      { ...chip, bbox: { x0: 0, y0: 0, x1: 'x', y1: 1 } },
    ]) {
      await check(`invalid-chip-${cases.length}`, '/api/chip-images/extract', { method: 'POST', body: { image_path: paths[0], class_name: `e2e_invalid_${r.loginId}`, chips: [value] } }, [400]);
    }
    const after = await gridState();
    expect(JSON.stringify(before.paths) === JSON.stringify(after.paths), 'Rejected input changed active grid');
    return { cases, visible: await r.visibleGrid() };
  });

  await r.record('edge-concurrent-reads', 'Eight real image/search requests while grid columns and selection change', async () => {
    const paths = await prepare();
    if (await page.evaluate(() => window.viewer.lotMode)) await page.locator('#lot-mode-btn').click();
    const work = page.evaluate(async sources => {
      const started = performance.now();
      return Promise.all(sources.map(async (source, index) => {
        const url = index % 2 ? `/api/image?path=${encodeURIComponent(source)}` : `/api/search?q=${source.split('/').pop().split('_')[0]}&limit=100`;
        const start = performance.now();
        const response = await fetch(url, { cache: 'no-store' });
        const body = await response.arrayBuffer();
        return { index, kind: index % 2 ? 'image' : 'search', status: response.status, bytes: body.byteLength, requestMs: performance.now() - start, finishMs: performance.now() - started };
      }));
    }, paths);
    const columns = [];
    for (const count of [2, 6, 3, 4]) {
      await page.locator('#grid-cols-input').fill(String(count));
      await page.locator('#grid-cols-input').press('Enter');
      expect(await page.evaluate(expected => window.viewer.gridCols === expected, count), `Column input did not apply ${count}`);
      columns.push({ count, visible: await r.visibleGrid() });
    }
    const responses = await work;
    expect(responses.length === 8 && responses.every(item => item.status === 200 && item.bytes > 0), `Concurrent reads failed: ${JSON.stringify(responses)}`);
    await page.locator('#grid-select-all').click();
    const selected = await page.evaluate(() => window.viewer.gridSelectedIdxs.length);
    expect(selected === 40, `Grid selection lost after concurrent reads: ${selected}`);
    await page.locator('#grid-deselect-all').click();
    expect(await page.evaluate(() => window.viewer.gridSelectedIdxs.length === 0), 'Deselect failed');
    return { responses, columns, selected };
  });
  await r.finish();
})().catch(error => { console.error(error); process.exitCode = 1; });
