const fs = require('fs');
const path = require('path');
const { createRunner } = require('./e2e_playwright_session');

(async () => {
  const {
    base,
    page,
    results,
    expect,
    sleep,
    append,
    focusWindow,
    close,
  } = await createRunner(__filename);

  async function boot(tag) {
    append(`[BOOT] ${tag}\n`);
    await focusWindow();
    await page.goto(`${base}/?${tag}=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
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
    await focusWindow();
    await sleep(1200);
  }

  async function record(phase, name, fn) {
    append(`[START] ${phase} ${name}\n`);
    try {
      const detail = await fn();
      results.push({ status: 'PASS', phase, name, detail });
      append(`[PASS] ${phase} ${name} :: ${JSON.stringify(detail)}\n`);
    } catch (err) {
      const detail = String(err && err.message ? err.message : err);
      results.push({ status: 'FAIL', phase, name, detail });
      append(`[FAIL] ${phase} ${name} :: ${detail}\n`);
    }
  }

  async function loadFolder(folder) {
    append(`[LOAD_FOLDER] ${folder}\n`);
    await page.evaluate(async (folderName) => {
      await window.viewer.loadImagesInFolderAndShowGrid(folderName);
    }, folder);
    await page.waitForFunction(
      () =>
        !!window.viewer &&
        window.viewer.gridMode &&
        window.viewer.currentGridImages?.length > 0 &&
        document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0,
      null,
      { timeout: 90000 }
    );
    await sleep(800);
    const state = await page.evaluate(() => ({
      prefix: window.viewer.currentFolderPrefix || '',
      count: window.viewer.currentGridImages?.length || 0,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
    }));
    append(`[LOAD_FOLDER_OK] ${folder} :: ${JSON.stringify(state)}\n`);
  }

  async function setSelection(indices) {
    await page.evaluate((idxs) => {
      const v = window.viewer;
      v.gridSelectedIdxs = [...idxs];
      v.gridSelectedSet = new Set(idxs);
      v.selectedImages = idxs.map((i) => v.currentGridImages[i]).filter(Boolean);
      v.updateGridSelection?.();
      v.flushGridSelectionUpdates?.();
    }, indices);
    await sleep(300);
  }

  async function findCommonMeasureSelection(field = 'f', minCount = 4, sampleLimit = 24) {
    const result = await page.evaluate(async ({ targetField, requiredCount, maxImages }) => {
      const images = Array.isArray(window.viewer?.currentGridImages)
        ? window.viewer.currentGridImages
        : [];
      const keyName = targetField === 'f' ? 'ftn_keys' : 'qtn_keys';
      const keyToIndices = new Map();

      for (let idx = 0; idx < images.length && idx < maxImages; idx += 1) {
        const imagePath = images[idx];
        try {
          const resp = await fetch(
            `/api/chip-positions?path=${encodeURIComponent(imagePath)}&include_fq=1`,
            { cache: 'no-store' }
          );
          if (!resp.ok) continue;
          const data = await resp.json();
          const keys = Array.isArray(data[keyName]) ? data[keyName].map(String) : [];
          for (const key of keys) {
            const indices = keyToIndices.get(key) || [];
            indices.push(idx);
            keyToIndices.set(key, indices);
          }
        } catch {
          // Ignore sparse/broken samples and keep searching.
        }
      }

      const candidates = Array.from(keyToIndices.entries())
        .filter(([, indices]) => indices.length >= requiredCount)
        .sort((a, b) => Number(a[0]) - Number(b[0]));
      if (candidates.length === 0) {
        return null;
      }

      const [key, indices] = candidates[0];
      const padded = /^\d+$/.test(key) ? key.padStart(4, '0') : key;
      return {
        item: {
          type: targetField,
          key,
          label: targetField === 'f' ? `FBT${padded}` : `QVL${padded}`,
        },
        indices: indices.slice(0, requiredCount),
        supportCount: indices.length,
      };
    }, { targetField: field, requiredCount: minCount, maxImages: sampleLimit });

    expect(result, `${field} common key not found`);
    return result;
  }

  async function enterSingle(idx = 0) {
    await page.evaluate((i) => window.viewer.enterSingleImageMode(i), idx);
    await page.waitForFunction(
      () => !!window.viewer && !window.viewer.gridMode && !!window.viewer.selectedImagePath,
      null,
      { timeout: 30000 }
    );
    await sleep(900);
  }

  async function backToGrid() {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(900);
    if (await page.evaluate(() => !window.viewer.gridMode)) {
      await page.evaluate(() => {
        window.viewer.exitSingleImageMode?.();
        window.viewer.exitSingleImageViewMode?.();
      });
      await sleep(1000);
    }
    await page.waitForFunction(
      () => !!window.viewer && window.viewer.gridMode === true,
      null,
      { timeout: 30000 }
    );
  }

  async function visible(selector) {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        cs.display !== 'none' &&
        cs.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    }, selector);
  }

  await boot('chunk3');

  await record('41,42,45,47,48,56', 'Composite / Measure 안정성 / toast / color modal', async () => {
    await loadFolder('filter_test');
    await setSelection([0, 1, 2]);
    await page.evaluate(() => window.viewer.handleCompositeCreate());
    await page.waitForFunction(
      () =>
        !!window.viewer.pageManager &&
        window.viewer.pageManager.getActivePage()?.role === 'composite',
      null,
      { timeout: 30000 }
    );
    await page.waitForFunction(
      () => window.viewer.currentGridImages?.length > 0,
      null,
      { timeout: 30000 }
    );
    const toastSeen = await page.evaluate(() =>
      Array.from(document.body.querySelectorAll('div')).some(
        (el) => el.textContent === '완성'
      )
    );
    await enterSingle(0);
    await backToGrid();

    await boot('chunk3-measure');
    await loadFolder('palette_3k');
    const measureSelection = await findCommonMeasureSelection('f', 4, 24);
    await setSelection(measureSelection.indices);
    await page.evaluate(async (payload) => {
      const v = window.viewer;
      v._measureCheckedItems = [
        { type: 'bin', key: null, label: 'BIN' },
        payload.item,
      ];
      await v._applyMeasureSelection();
    }, measureSelection);
    await sleep(1200);
    await page.evaluate(async () => {
      const editor = await window.viewer._getColorEditor();
      await editor.open('measure');
    });
    await page.waitForFunction(
      () => {
        const modal = document.querySelector('#color-editor-modal');
        if (!modal) return false;
        const style = getComputedStyle(modal);
        return (
          modal.classList.contains('is-open') &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
        );
      },
      null,
      { timeout: 10000 }
    );
    const measureColorVisible = await visible('#color-editor-modal');
    const data = await page.evaluate((toastSeenValue) => ({
      compositeRole: window.viewer.pageManager?.getActivePage()?.role || null,
      measureRole: window.viewer.pageManager?.pages?.some((p) => p.role === 'measure'),
      gridCount: window.viewer.currentGridImages.length,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      toastSeen: toastSeenValue,
    }), toastSeen);
    expect(data.gridCount > 0 && data.wraps > 0, `grid=${data.gridCount}/${data.wraps}`);
    expect(data.measureRole === true, 'measure page missing');
    expect(measureColorVisible, 'measure color modal hidden');
    return { ...data, measureColorVisible };
  });

  await record('43,44,49,50,57,60', 'Label Explorer / WF search / classification consistency', async () => {
    await boot('chunk3-label');
    const labelData = await page.evaluate(async () => {
      await window.viewer.showGridFromClass('asDF');
      await new Promise((r) => setTimeout(r, 800));
      const asdf = {
        count: window.viewer.currentGridImages.length,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      };
      await window.viewer.showGridFromMultipleClasses(['asDF', 'asdfasdf']);
      await new Promise((r) => setTimeout(r, 1000));
      return {
        asdf,
        multi: {
          count: window.viewer.currentGridImages.length,
          wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        },
        lotHeaders: document.querySelectorAll('#image-grid .lot-header').length,
      };
    });

    await page.evaluate(() => window.viewer.openWfSearchModal());
    await sleep(500);
    const wfVisible = await visible('#wf-search-modal');

    expect(labelData.asdf.count === 16, `asDF=${labelData.asdf.count}`);
    expect(labelData.multi.count === 38, `multi=${labelData.multi.count}`);
    expect(labelData.lotHeaders === 0, `lotHeaders=${labelData.lotHeaders}`);
    expect(wfVisible, 'wf modal hidden');
    return { ...labelData, wfVisible };
  });

  await record('46,52,53,54,55,58,59,61,62,63', '캐시 / 성능 / placeholder / highlight / 버전전파', async () => {
    await boot('chunk3-cache');
    const t0 = Date.now();
    await loadFolder('fq_missing_test');
    const fqLoadMs = Date.now() - t0;
    await page.evaluate(() => {
      const w = document.querySelector('#image-grid')?.parentElement;
      if (w) w.scrollTop = w.scrollHeight * 0.5;
    });
    await sleep(800);
    await page.evaluate(() => {
      const w = document.querySelector('#image-grid')?.parentElement;
      if (w) w.scrollTop = w.scrollHeight;
    });
    await sleep(800);

    const data = await page.evaluate(async () => {
      const mainScript = document.querySelector('script[src*="/js/main.js"]')?.src || '/js/main.js?v=' + Date.now();
      const cssHref = document.querySelector('link[href*="/css/style.css"]')?.href || '/css/style.css?v=' + Date.now();
      const mainResp = await fetch(mainScript, { cache: 'no-store' });
      const cssResp = await fetch(cssHref, { cache: 'no-store' });
      const mainText = await mainResp.text();
      const fetchOptResp = await fetch('/js/fetch-optimizer.js?v=' + Date.now(), { cache: 'no-store' });
      const fetchOptText = await fetchOptResp.text();
      const bitmapResp = await fetch('/js/bitmap-loader.js?v=' + Date.now(), { cache: 'no-store' });
      const bitmapText = await bitmapResp.text();
      return {
        fqCount: window.viewer.currentGridImages.length,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        placeholders: document.querySelectorAll('.grid-thumb-placeholder').length,
        highlighted: document.querySelectorAll('#file-explorer .active, #file-explorer .selected').length,
        mainScript,
        cssHref,
        mainEtag: mainResp.headers.get('etag'),
        cssEtag: cssResp.headers.get('etag'),
        mainHasVersionedImports:
          mainText.includes('fetch-optimizer.js?v=') &&
          mainText.includes('bitmap-loader.js?v='),
        fetchOptimizerHasWorkerVersion:
          fetchOptText.includes('?v=') || fetchOptText.includes('new URL('),
        bitmapLoaderHasWorkerVersion:
          bitmapText.includes('?v=') || bitmapText.includes('new URL('),
      };
    });
    expect(data.fqCount === 143, `fqCount=${data.fqCount}`);
    expect(data.wraps === 143, `wraps=${data.wraps}`);
    expect(data.placeholders === 0, `placeholders=${data.placeholders}`);
    expect(!!data.mainEtag && !!data.cssEtag, `etag main=${data.mainEtag} css=${data.cssEtag}`);
    expect(data.mainHasVersionedImports, 'main versioned imports missing');
    return { ...data, fqLoadMs };
  });

  console.log(JSON.stringify(results, null, 2));
  append(`[DONE] total=${results.length}\n`);
  const finalExitCode = results.some((r) => r.status === 'FAIL') ? 2 : 0;
  const forcedExitTimer = setTimeout(() => {
    console.warn('[E2E] force exit after close timeout');
    process.exit(finalExitCode);
  }, 10000);
  forcedExitTimer.unref();
  try {
    await close();
  } catch (error) {
    console.warn('[E2E] close failed:', error);
  }
  clearTimeout(forcedExitTimer);
  process.exit(finalExitCode);
})();
