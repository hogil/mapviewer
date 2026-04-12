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
    await sleep(1000);
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

  await boot('chunk2');

  await record('21,24,25,26,27', 'PageManager / MultiSearch / Permission / keyboard', async () => {
    const beforePages = await page.evaluate(
      () => window.viewer.pageManager?.pages?.length || 0
    );
    await page.click('#page-add-btn');
    await sleep(500);
    const afterPages = await page.evaluate(
      () => window.viewer.pageManager?.pages?.length || 0
    );

    await page.evaluate(() => window.viewer.openMultiSearchModal?.());
    await sleep(400);
    const multiVisible = await visible('#multi-search-modal');
    await page.evaluate(() => document.getElementById('multi-search-apply')?.click());
    await sleep(300);
    const multiError = await page.evaluate(
      () => (document.getElementById('multi-search-error')?.textContent || '').trim()
    );
    await page.keyboard.press('Escape');
    await sleep(400);

    await page.evaluate(() => window.viewer.openPermissionEditorModal());
    await sleep(1200);
    const permissionVisible = await visible('#permission-editor-modal');
    await page.click('#permission-add-row-btn');
    await sleep(300);
    const permRows = await page.locator('#permission-registration-tbody tr').count();

    await loadFolder('palette_5mb');
    await setSelection([0]);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => !!window.viewer && !window.viewer.gridMode,
      null,
      { timeout: 30000 }
    );
    await sleep(600);
    await backToGrid();

    expect(afterPages === beforePages + 1, `pages ${beforePages}->${afterPages}`);
    expect(multiVisible, 'multi-search hidden');
    expect(multiError.length > 0, 'multi-search empty error missing');
    expect(permissionVisible, 'permission modal hidden');
    expect(permRows >= 1, `permRows=${permRows}`);
    return {
      beforePages,
      afterPages,
      multiVisible,
      multiError,
      permissionVisible,
      permRows,
    };
  });

  await record('22,23,28,29', 'Navigator / Minimap / 반복 진입 복귀', async () => {
    await boot('chunk2-nav');
    await loadFolder('palette_5mb');
    const loops = [];
    for (let i = 0; i < 3; i += 1) {
      await enterSingle(0);
      await page.waitForFunction(
        () => {
          const navigator = document.getElementById('thumbnail-navigator');
          const minimap = document.getElementById('minimap-container');
          if (!navigator || !minimap || !window.viewer?.selectedImagePath) {
            return false;
          }
          const navStyle = getComputedStyle(navigator);
          const miniStyle = getComputedStyle(minimap);
          const navRect = navigator.getBoundingClientRect();
          const miniRect = minimap.getBoundingClientRect();
          return (
            navStyle.display !== 'none' &&
            navStyle.visibility !== 'hidden' &&
            navRect.width > 0 &&
            navRect.height > 0 &&
            miniStyle.display !== 'none' &&
            miniStyle.visibility !== 'hidden' &&
            miniRect.width > 0 &&
            miniRect.height > 0
          );
        },
        null,
        { timeout: 30000 }
      );
      const snap = await page.evaluate(() => ({
        navigatorVisible:
          getComputedStyle(document.getElementById('thumbnail-navigator')).display !==
          'none',
        minimapVisible:
          getComputedStyle(document.getElementById('minimap-container')).display !==
          'none',
        selectedImagePath: window.viewer.selectedImagePath,
      }));
      loops.push(snap);
      await backToGrid();
      const wraps = await page.locator('#image-grid .grid-thumb-wrap').count();
      expect(wraps > 0, `loop ${i} wraps=${wraps}`);
    }
    expect(loops.every((x) => x.navigatorVisible), 'navigator hidden in loop');
    expect(loops.every((x) => x.minimapVisible), 'minimap hidden in loop');
    return { loops };
  });

  await record('30,33,34,35,39', 'Measure 다중선택 / Measure 탭 / 범례', async () => {
    await boot('chunk2-measure');
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
    await sleep(1500);
    const data = await page.evaluate((payload) => ({
      activeRole: window.viewer.pageManager?.getActivePage()?.role || null,
      pageRoles: (window.viewer.pageManager?.pages || []).map((p) => p.role),
      overlayMode: window.viewer.overlayMode,
      measureItems: window.viewer._measureCheckedItems.length,
      gridCount: window.viewer.currentGridImages.length,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      legendTop: (document.getElementById('color-legend-top')?.innerText || '').trim(),
      legendBottom: (document.getElementById('color-legend-bottom')?.innerText || '').trim(),
      selectedMeasure: payload.item,
      selectedIndices: payload.indices,
    }), measureSelection);
    expect(data.pageRoles.includes('measure'), `roles=${data.pageRoles.join(',')}`);
    expect(data.measureItems >= 2, `measureItems=${data.measureItems}`);
    expect(data.gridCount > 0 && data.wraps > 0, `grid=${data.gridCount}/${data.wraps}`);
    return data;
  });

  await record('36,37,38,40', '성능 / 이미지 무결성 / 인덱스', async () => {
    await boot('chunk2-perf');
    const t0 = Date.now();
    await loadFolder('filter_test');
    const loadMs = Date.now() - t0;
    const data = await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('#image-grid img')).slice(0, 40);
      const status = await fetch('/api/index-status', { cache: 'no-store' }).then((r) => r.json());
      return {
        broken: imgs.filter((img) => !img.complete || img.naturalWidth === 0).length,
        count: window.viewer.currentGridImages.length,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        status,
      };
    });
    expect(data.count === 144, `count=${data.count}`);
    expect(data.wraps === 144, `wraps=${data.wraps}`);
    expect(data.broken === 0, `broken=${data.broken}`);
    expect(data.status.ready === true, `status=${JSON.stringify(data.status)}`);
    return { ...data, loadMs };
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
