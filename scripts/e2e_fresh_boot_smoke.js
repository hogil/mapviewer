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
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];

  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || consoleMessages.length < 20) {
      consoleMessages.push(`${message.type()}: ${text}`.slice(0, 500));
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String(error?.stack || error?.message || error).slice(0, 1000));
  });
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`.slice(0, 500));
  });
  let stage = 'start';

  try {
    append(`[BOOT_SMOKE] goto ${base}\n`);
    const navStartedAt = Date.now();
    stage = 'goto';
    await page.goto(`${base}/?fresh-boot-smoke=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    const domLoadedMs = Date.now() - navStartedAt;

    await focusWindow();
    stage = 'viewer-ready';
    await page.waitForFunction(
      () => !!window.viewer && window.__l3FullViewerReady === true,
      null,
      { timeout: 90000 }
    );
    const viewerReadyMs = Date.now() - navStartedAt;

    stage = 'explorer-ready';
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '#file-explorer .folder, #file-explorer .folder-item'
        ).length > 10,
      null,
      { timeout: 90000 }
    );
    const explorerReadyMs = Date.now() - navStartedAt;

    stage = 'load-unknown';
    await page.evaluate(async (folderName) => {
      const v = window.viewer;
      v.selectedImages = [];
      v.selectedFolders = new Set([folderName]);
      v.lastSelectedFolderPath = folderName;
      v._unfilteredGridImages = [];
      const applied = await v.selectAllFolderFiles(folderName);
      if (applied && Array.isArray(v.selectedImages) && v.selectedImages.length > 0) {
        v.showGrid(v.selectedImages);
      } else {
        await v.loadImagesInFolderAndShowGrid(folderName);
      }
    }, 'unknown');
    stage = 'grid-ready';
    await page.waitForFunction(
      () =>
        !!window.viewer &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) > 0 &&
        window.viewer.currentGridImages.some((imagePath) =>
          String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/')
        ) &&
        document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0,
      null,
      { timeout: 90000 }
    );

    stage = 'thumbnail-ready';
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
    append(`[PASS] fresh-boot Fresh boot page and grid readiness :: ${JSON.stringify(result)}\n`);
    append(`[BOOT_SMOKE_PASS] ${JSON.stringify(result)}\n`);
    append('[DONE] total=1\n');
  } catch (err) {
    const state = await page.evaluate(() => ({
      href: location.href,
      title: document.title,
      ready: window.__l3FullViewerReady === true,
      hasViewer: !!window.viewer,
      viewerType: window.viewer?.constructor?.name || typeof window.viewer,
      currentGridImagesLen: window.viewer?.currentGridImages?.length || 0,
      gridMode: window.viewer?.gridMode === true,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      mainImportState: window.__l3MainImportState || null,
      mainImportError: window.__l3MainImportError || null,
      fullViewerError: window.__l3FullViewerError || null,
      folderCount: document.querySelectorAll('#file-explorer .folder, #file-explorer .folder-item').length,
      bodyText: document.body?.innerText?.slice(0, 200) || '',
    })).catch((stateErr) => ({ evaluateError: String(stateErr?.message || stateErr) }));
    const detail = `stage=${stage} ${String(err && err.message ? err.message : err)} state=${JSON.stringify(state)} console=${JSON.stringify(consoleMessages.slice(-10))} pageErrors=${JSON.stringify(pageErrors.slice(-5))} requestFailures=${JSON.stringify(requestFailures.slice(-10))}`;
    console.error(detail);
    append(`[FAIL] fresh-boot Fresh boot page and grid readiness :: ${detail}\n`);
    append(`[BOOT_SMOKE_FAIL] ${detail}\n`);
    finalExitCode = 2;
  } finally {
    await close();
  }

  process.exit(finalExitCode);
})();
