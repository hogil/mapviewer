const { createRunner } = require('./e2e_playwright_session');

(async () => {
  const {
    base,
    page,
    expect,
    sleep,
    append,
    focusWindow,
    close,
  } = await createRunner(__filename);
  let finalExitCode = 0;

  try {
    append(`[BOOT_SMOKE] goto ${base}\n`);
    const navStartedAt = Date.now();
    await page.goto(`${base}/?fresh-boot-smoke=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    const domLoadedMs = Date.now() - navStartedAt;

    await focusWindow();
    await page.waitForFunction(
      () => !!window.viewer && window.__l3FullViewerReady === true,
      null,
      { timeout: 90000 }
    );
    const viewerReadyMs = Date.now() - navStartedAt;

    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '#file-explorer .folder, #file-explorer .folder-item'
        ).length > 10,
      null,
      { timeout: 90000 }
    );
    const explorerReadyMs = Date.now() - navStartedAt;

    await page.evaluate(async () => {
      await window.viewer.loadImagesInFolderAndShowGrid('unknown');
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

    await page.waitForFunction(
      () => {
        const grid = document.getElementById('image-grid');
        const wraps = Array.from(grid?.querySelectorAll('.grid-thumb-wrap') || []);
        return wraps.some((wrap) => {
          const img = wrap.querySelector('img.grid-thumb-img');
          return !!img && img.dataset.gridLoaded === 'true' && img.naturalWidth > 0;
        });
      },
      null,
      { timeout: 90000 }
    );
    await sleep(1000);

    const summary = await page.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('#image-grid .grid-thumb-wrap'));
      const loadedVisible = wraps.filter((wrap) => {
        const rect = wrap.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const img = wrap.querySelector('img.grid-thumb-img');
        return !!img && img.dataset.gridLoaded === 'true' && img.naturalWidth > 0;
      }).length;
      return {
        title: document.title,
        gridCount: window.viewer.currentGridImages?.length || 0,
        wraps: wraps.length,
        loadedVisible,
      };
    });
    expect(summary.title === 'Wafer Map Viewer', `title=${summary.title}`);
    expect(summary.gridCount > 0, `gridCount=${summary.gridCount}`);
    expect(summary.wraps > 0, `wraps=${summary.wraps}`);
    expect(summary.loadedVisible > 0, `loadedVisible=${summary.loadedVisible}`);

    const result = {
      status: 'PASS',
      domLoadedMs,
      viewerReadyMs,
      explorerReadyMs,
      ...summary,
    };
    console.log(JSON.stringify(result, null, 2));
    append(`[BOOT_SMOKE_PASS] ${JSON.stringify(result)}\n`);
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    console.error(detail);
    append(`[BOOT_SMOKE_FAIL] ${detail}\n`);
    finalExitCode = 2;
  } finally {
    await close();
  }

  process.exit(finalExitCode);
})();
