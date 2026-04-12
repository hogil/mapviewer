const { createRunner } = require('./e2e_playwright_session');

(async () => {
  const holdMs = Number(process.env.E2E_SMOKE_HOLD_MS || 10000);
  const {
    base,
    page,
    expect,
    sleep,
    append,
    focusWindow,
    close,
  } = await createRunner(__filename);

  try {
    append(`[SMOKE] goto ${base}\n`);
    await page.goto(`${base}/?visible-smoke=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await focusWindow();
    await page.waitForFunction(
      () => !!window.viewer && window.__l3FullViewerReady === true,
      null,
      { timeout: 90000 }
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '#file-explorer .folder, #file-explorer .folder-item'
        ).length > 10,
      null,
      { timeout: 90000 }
    );

    await page.evaluate(async () => {
      await window.viewer.loadImagesInFolderAndShowGrid('palette_3k');
    });
    await page.waitForFunction(
      () =>
        !!window.viewer &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) > 0 &&
        document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0,
      null,
      { timeout: 90000 }
    );

    await focusWindow();
    await page.locator('#image-grid .grid-thumb-wrap').first().click();
    await sleep(1200);

    const state = await page.evaluate(() => ({
      title: document.title,
      folder: window.viewer.currentFolderPrefix || '',
      gridCount: window.viewer.currentGridImages?.length || 0,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
    }));
    expect(state.title === 'Wafer Map Viewer', `title=${state.title}`);
    expect(state.gridCount > 0, `gridCount=${state.gridCount}`);

    console.log(JSON.stringify({ status: 'PASS', holdMs, ...state }, null, 2));
    append(`[SMOKE_PASS] ${JSON.stringify(state)}\n`);
    await sleep(holdMs);
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    console.error(detail);
    append(`[SMOKE_FAIL] ${detail}\n`);
    await focusWindow();
    await sleep(holdMs);
    process.exitCode = 2;
  } finally {
    await close();
  }
})();
