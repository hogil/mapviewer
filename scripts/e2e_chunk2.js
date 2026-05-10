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
        Array.from(document.querySelectorAll(
          '#file-explorer .folder, #file-explorer .folder-item'
        )).some((node) => (node.textContent || '').includes('unknown')),
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
    }, folder);
    await page.waitForFunction(
      (folderName) => {
        const v = window.viewer;
        const normalized = String(folderName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const prefix = normalized ? `${normalized}/` : '';
        const images = Array.isArray(v?.currentGridImages) ? v.currentGridImages : [];
        return (
          !!v &&
          v.gridMode &&
          images.length > 0 &&
          images.some((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith(prefix)) &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0
        );
      },
      folder,
      { timeout: 90000 }
    );
    await sleep(800);
    const state = await page.evaluate(() => ({
      prefix: window.viewer.currentFolderPrefix || '',
      count: window.viewer.currentGridImages?.length || 0,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      firstPath: window.viewer.currentGridImages?.[0] || '',
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

  async function selectWaferExplorerFolder(folder) {
    const folderSelector = `#file-explorer summary.folder[data-path="${folder.replace(/"/g, '\\"')}"]`;
    await page.waitForSelector(folderSelector, { timeout: 30000 });
    await page.locator(folderSelector).click({ modifiers: ['Control'] });
    await page.waitForFunction(
      (folderName) => {
        const v = window.viewer;
        const selectedSummary = Array.from(document.querySelectorAll('#file-explorer summary.folder.selected'))
          .some((summary) => summary.dataset.path === folderName);
        return (
          v?.selectedFolders?.has(folderName) &&
          selectedSummary &&
          v.gridMode === true &&
          (v.currentGridImages?.length || 0) > 0 &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0
        );
      },
      folder,
      { timeout: 60000 }
    );
    await sleep(900);
  }

  async function openExplorerForCurrentGridImage() {
    return await page.evaluate(async () => {
      const v = window.viewer;
      const explorer = document.getElementById('file-explorer');
      const firstPath = (Array.isArray(v.currentGridImages) ? v.currentGridImages : [])
        .find((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/'));
      if (!explorer || !firstPath) {
        return { firstPath: firstPath || null, folderPath: null, linkFound: false };
      }

      const normalized = String(firstPath).replace(/\\/g, '/');
      const segments = normalized.split('/').slice(0, -1);
      let currentPath = '';
      for (const segment of segments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const summary = Array.from(document.querySelectorAll('#file-explorer summary.folder'))
          .find((node) => node.dataset.path === currentPath);
        if (!summary) continue;
        const details = summary.parentElement;
        const content = summary.nextElementSibling;
        if (content && details?.dataset.loaded !== 'true') {
          await v.loadDirectoryContents(currentPath, content);
          details.dataset.loaded = 'true';
        }
        if (details) details.open = true;
      }

      v.restoreFolderSelection?.();
      const link = Array.from(document.querySelectorAll('#file-explorer a[data-path]'))
        .find((node) => node.dataset.path === normalized);
      return {
        firstPath: normalized,
        folderPath: segments.join('/'),
        linkFound: !!link,
        explorerScrollable: explorer.scrollHeight > explorer.clientHeight,
      };
    });
  }

  async function getExplorerSelectionState(label = '') {
    return await page.evaluate((stateLabel) => {
      const v = window.viewer;
      const grid = document.getElementById('image-grid');
      const gridWrapper = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement || null;
      const canvas = document.getElementById('image-canvas');
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      const gridStyle = grid ? getComputedStyle(grid) : null;
      const wrapperStyle = gridWrapper ? getComputedStyle(gridWrapper) : null;
      return {
        label: stateLabel,
        gridMode: !!v?.gridMode,
        viewMode: v?.viewMode || null,
        selectedFolders: [...(v?.selectedFolders || [])],
        selectedImagesLen: v?.selectedImages?.length || 0,
        currentGridImagesLen: v?.currentGridImages?.length || 0,
        selectedImagePath: v?.selectedImagePath || null,
        folderSelectedPaths: Array.from(document.querySelectorAll('#file-explorer summary.folder.selected'))
          .map((summary) => summary.dataset.path),
        fileSelectedPaths: Array.from(document.querySelectorAll('#file-explorer a.selected'))
          .map((link) => link.dataset.path),
        explorerScrollTop: document.getElementById('file-explorer')?.scrollTop || 0,
        gridDisplay: gridStyle?.display || null,
        wrapperDisplay: wrapperStyle?.display || null,
        gridWraps: grid?.querySelectorAll('.grid-thumb-wrap').length || 0,
        canvasVisible:
          !!canvas &&
          canvasStyle?.display !== 'none' &&
          canvas.getBoundingClientRect().width > 0 &&
          canvas.getBoundingClientRect().height > 0,
      };
    }, label);
  }

  async function dragWaferExplorerScrollbar() {
    return await page.evaluate(async () => {
      const explorer = document.getElementById('file-explorer');
      if (!explorer) return { ok: false, reason: 'missing explorer' };
      const rect = explorer.getBoundingClientRect();
      const startY = rect.top + Math.min(80, Math.max(10, rect.height * 0.25));
      const endY = Math.min(rect.bottom - 4, startY + Math.min(260, rect.height * 0.5));
      const clientX = rect.right - 2;
      const beforeTop = explorer.scrollTop;
      const maxTop = Math.max(0, explorer.scrollHeight - explorer.clientHeight);

      const mouseEvent = (type, target, clientY, buttons) => {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons,
          clientX,
          clientY,
        }));
      };

      mouseEvent('mousedown', explorer, startY, 1);
      explorer.scrollTop = Math.min(maxTop, beforeTop + Math.max(120, Math.round(explorer.clientHeight * 0.8)));
      explorer.dispatchEvent(new Event('scroll', { bubbles: true }));
      mouseEvent('mousemove', document, endY, 1);
      mouseEvent('mouseup', document, endY, 0);
      await new Promise((resolve) => setTimeout(resolve, 180));

      return {
        ok: true,
        beforeTop,
        afterTop: explorer.scrollTop,
        maxTop,
        scrollHeight: explorer.scrollHeight,
        clientHeight: explorer.clientHeight,
      };
    });
  }

  async function getVisibleGridThumbSummary() {
    return await page.evaluate(() => {
      const PLACEHOLDER =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const grid = document.getElementById('image-grid');
      const scrollWrapper = grid?.parentElement;
      if (!grid || !scrollWrapper) {
        return {
          scrollTop: 0,
          visibleCount: 0,
          loadedCount: 0,
          loadedRatio: 0,
          badCount: 0,
          bad: [],
        };
      }

      const wrapperRect = scrollWrapper.getBoundingClientRect();
      const wraps = Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
      const visibleThumbs = wraps
        .map((wrap, idx) => {
          const rect = wrap.getBoundingClientRect();
          if (rect.bottom <= wrapperRect.top || rect.top >= wrapperRect.bottom) {
            return null;
          }
          const img = wrap.querySelector('img.grid-thumb-img');
          if (!img) {
            return {
              idx,
              path: wrap.dataset.path || '',
              src: '',
              loading: 'false',
              gridLoaded: 'false',
              naturalWidth: 0,
              complete: false,
              isLoaded: false,
            };
          }
          const src = img.currentSrc || img.src || '';
          const isLoaded =
            img.dataset.gridLoaded === 'true' &&
            img.complete === true &&
            img.naturalWidth > 1 &&
            src !== PLACEHOLDER;
          return {
            idx,
            path: wrap.dataset.path || '',
            src,
            loading: img.dataset.loading || 'false',
            gridLoaded: img.dataset.gridLoaded || 'false',
            naturalWidth: img.naturalWidth,
            complete: img.complete,
            isLoaded,
          };
        })
        .filter(Boolean);

      const loadedCount = visibleThumbs.filter((item) => item.isLoaded).length;
      const bad = visibleThumbs.filter((item) => !item.isLoaded);
      return {
        scrollTop: scrollWrapper.scrollTop || 0,
        visibleCount: visibleThumbs.length,
        loadedCount,
        loadedRatio:
          visibleThumbs.length > 0 ? loadedCount / visibleThumbs.length : 0,
        badCount: bad.length,
        bad: bad.slice(0, 8),
      };
    });
  }

  async function waitForVisibleGridThumbsLoaded(timeoutMs = 4000, settleMs = 250) {
    const startedAt = Date.now();
    let lastSummary = null;
    while (Date.now() - startedAt < timeoutMs) {
      lastSummary = await getVisibleGridThumbSummary();
      if (lastSummary.visibleCount > 0 && lastSummary.badCount === 0) {
        await sleep(settleMs);
        const settledSummary = await getVisibleGridThumbSummary();
        if (settledSummary.visibleCount > 0 && settledSummary.badCount === 0) {
          return settledSummary;
        }
        lastSummary = settledSummary;
      }
      await sleep(250);
    }
    return lastSummary;
  }

  async function roundTripGridImageByDblClick(index = 0) {
    await page.locator('#image-grid .grid-thumb-wrap').nth(index).dblclick();
    await page.waitForFunction(
      () => !!window.viewer && window.viewer.viewMode === 'gridImage',
      null,
      { timeout: 30000 }
    );
    await sleep(800);
    await page.locator('#viewer-container').dblclick();
    await page.waitForFunction(
      () =>
        !!window.viewer &&
        window.viewer.gridMode === true &&
        window.viewer.viewMode !== 'gridImage',
      null,
      { timeout: 30000 }
    );
  }

  async function scrollGridToRatio(ratio) {
    await page.evaluate(async (value) => {
      const scrollWrapper = document.querySelector('#image-grid')?.parentElement;
      if (!scrollWrapper) return;
      const maxScrollTop = Math.max(
        0,
        scrollWrapper.scrollHeight - scrollWrapper.clientHeight
      );
      scrollWrapper.scrollTop = Math.round(maxScrollTop * value);
      scrollWrapper.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      await window.viewer.loadVisibleGridThumbnails?.({ cancelExisting: false });
    }, ratio);
  }

  async function getMiddleVisibleGridIndex() {
    return await page.evaluate(() => {
      const grid = document.getElementById('image-grid');
      const scrollWrapper = grid?.parentElement;
      if (!grid || !scrollWrapper) return 0;
      const wrapperRect = scrollWrapper.getBoundingClientRect();
      const visible = Array.from(grid.querySelectorAll('.grid-thumb-wrap'))
        .map((wrap, idx) => {
          const rect = wrap.getBoundingClientRect();
          if (rect.bottom <= wrapperRect.top || rect.top >= wrapperRect.bottom) {
            return null;
          }
          return idx;
        })
        .filter((idx) => idx !== null);
      if (visible.length === 0) return 0;
      return visible[Math.floor(visible.length / 2)];
    });
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

    await loadFolder('unknown');
    const searchBefore = await page.evaluate(() => ({
      gridMode: !!window.viewer.gridMode,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      count: window.viewer.currentGridImages?.length || 0,
    }));
    let noResultDialog = '';
    page.once('dialog', async (dialog) => {
      noResultDialog = dialog.message();
      await dialog.accept();
    });
    await page.fill('#file-search', 'ZZZ_NO_RESULT_TOKEN_123456789');
    await page.click('#search-btn');
    await sleep(1200);
    const searchAfter = await page.evaluate(() => ({
      gridMode: !!window.viewer.gridMode,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      count: window.viewer.currentGridImages?.length || 0,
    }));

    await page.evaluate(() => window.viewer.openMultiSearchModal?.());
    await sleep(300);
    await page.fill('#multi-search-input', 'ZZZ_NO_RESULT_TOKEN_123456789');
    await page.click('#multi-search-apply');
    await sleep(1200);
    const multiNoResult = await page.evaluate(() => {
      const modal = document.getElementById('multi-search-modal');
      const style = modal ? getComputedStyle(modal) : null;
      return {
        modalVisible: !!modal && style.display !== 'none' && style.visibility !== 'hidden',
        error: (document.getElementById('multi-search-error')?.textContent || '').trim(),
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        count: window.viewer.currentGridImages?.length || 0,
      };
    });
    await page.keyboard.press('Escape');
    await sleep(300);

    const multiLotApiNormalization = await page.evaluate(async () => {
      const v = window.viewer;
      const samples = [];
      const seen = new Set();
      for (const imagePath of v.currentGridImages || []) {
        const tokens = v.extractLotTokensFromPath(imagePath);
        const lot = tokens?.lotValue || '';
        const key = lot.toLowerCase();
        if (!lot || seen.has(key)) continue;
        seen.add(key);
        samples.push({
          lot,
          path: String(imagePath || '').replace(/\\/g, '/'),
          filename: String(imagePath || '').replace(/\\/g, '/').split('/').pop(),
        });
        if (samples.length >= 3) break;
      }
      if (samples.length < 3) {
        return { ok: false, error: `samples=${samples.length}` };
      }

      const input = document.getElementById('multi-search-input');
      const originalValue = input?.value || '';
      const originalFetch = window.fetch;
      const captured = [];
      window.fetch = async (...args) => {
        const url = String(args[0] || '');
        if (url.startsWith('/api/search?')) captured.push(url);
        return originalFetch.apply(window, args);
      };

      try {
        input.value = [
          `${samples[0].lot} 05`,
          `${samples[1].path}\tignored-column`,
          `${samples[2].filename}    ignored-column`,
        ].join('\n');
        const parsed = v.parseMultiSearchInput();
        const success = parsed.error
          ? false
          : await v.performSearch({ multiLotList: [...(parsed.lots || [])], suppressAlerts: true });
        const searchUrl = captured.find((url) => url.startsWith('/api/search?')) || '';
        const lotMulti = searchUrl
          ? new URL(searchUrl, window.location.origin).searchParams.get('lot_multi') || ''
          : '';
        const lotParts = lotMulti.split(',').filter(Boolean);
        const expectedLots = samples.map((sample) => sample.lot.toLowerCase());
        const resultLots = Array.from(new Set((v.currentGridImages || [])
          .map((imagePath) => v.extractLotTokensFromPath(imagePath)?.lotValue || '')
          .filter(Boolean)
          .map((lot) => lot.toLowerCase())));
        const serverWhitespaceInput = `${samples[0].lot} ${samples[1].lot}`;
        const serverWhitespaceUrl = `/api/search?q=&limit=10000&folder=unknown&lot_multi=${encodeURIComponent(serverWhitespaceInput)}`;
        const serverResponse = await originalFetch.call(window, serverWhitespaceUrl);
        const serverData = await serverResponse.json();
        const serverWhitespaceLots = Array.from(new Set((serverData.results || [])
          .map((imagePath) => v.extractLotTokensFromPath(imagePath)?.lotValue || '')
          .filter(Boolean)
          .map((lot) => lot.toLowerCase())));
        return {
          ok: success === true,
          parsedLots: parsed.lots || [],
          parsedError: parsed.error || '',
          lotParts,
          expectedLots,
          resultLots,
          resultCount: v.currentGridImages?.length || 0,
          searchUrl,
          serverWhitespaceInput,
          serverWhitespaceUrl,
          serverWhitespaceLots,
        };
      } finally {
        window.fetch = originalFetch;
        if (input) input.value = originalValue;
      }
    });

    const limitValidation = await page.evaluate(() => {
      const lotInput = Array.from({ length: 301 }, (_, i) => `LOT${String(i).padStart(4, '0')}`).join('\n');
      const wfInput = Array.from({ length: 1001 }, (_, i) => `LOT${String(i).padStart(4, '0')} ${String(i % 25).padStart(2, '0')}`).join('\n');
      const originalLot = window.viewer.dom.multiSearchInput.value;
      const originalWf = window.viewer.dom.wfSearchInput.value;
      window.viewer.dom.multiSearchInput.value = lotInput;
      const lotParsed = window.viewer.parseMultiSearchInput();
      window.viewer.dom.wfSearchInput.value = wfInput;
      const wfParsed = window.viewer.parseWfSearchInput();
      window.viewer.dom.multiSearchInput.value = originalLot;
      window.viewer.dom.wfSearchInput.value = originalWf;
      return {
        lotError: lotParsed.error || '',
        wfError: wfParsed.error || '',
      };
    });

    await page.evaluate(() => window.viewer.openPermissionEditorModal());
    await sleep(1200);
    const permissionVisible = await visible('#permission-editor-modal');
    await page.click('#permission-add-row-btn');
    await sleep(300);
    const permRows = await page.locator('#permission-registration-tbody tr').count();
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
    expect(noResultDialog === '검색 결과가 없습니다.', `noResultDialog=${noResultDialog}`);
    expect(searchAfter.gridMode === searchBefore.gridMode, `search gridMode ${searchBefore.gridMode}->${searchAfter.gridMode}`);
    expect(searchAfter.wraps === searchBefore.wraps, `search wraps ${searchBefore.wraps}->${searchAfter.wraps}`);
    expect(searchAfter.count === searchBefore.count, `search count ${searchBefore.count}->${searchAfter.count}`);
    expect(multiNoResult.modalVisible, 'multi-search no-result modal hidden');
    expect(multiNoResult.error.length > 0, 'multi-search no-result error missing');
    expect(multiNoResult.wraps === searchBefore.wraps, `multi-search wraps ${searchBefore.wraps}->${multiNoResult.wraps}`);
    expect(multiNoResult.count === searchBefore.count, `multi-search count ${searchBefore.count}->${multiNoResult.count}`);
    expect(multiLotApiNormalization.ok, `multi LOT normalization failed ${JSON.stringify(multiLotApiNormalization)}`);
    expect(
      JSON.stringify(multiLotApiNormalization.lotParts) === JSON.stringify(multiLotApiNormalization.expectedLots),
      `lot_multi=${JSON.stringify(multiLotApiNormalization.lotParts)} expected=${JSON.stringify(multiLotApiNormalization.expectedLots)}`
    );
    expect(
      !multiLotApiNormalization.lotParts.includes('05'),
      `wafer/index token leaked into lot_multi=${JSON.stringify(multiLotApiNormalization.lotParts)}`
    );
    expect(
      multiLotApiNormalization.expectedLots.every((lot) => multiLotApiNormalization.resultLots.includes(lot)),
      `resultLots=${JSON.stringify(multiLotApiNormalization.resultLots)} expected=${JSON.stringify(multiLotApiNormalization.expectedLots)}`
    );
    expect(
      multiLotApiNormalization.serverWhitespaceLots.includes(multiLotApiNormalization.expectedLots[0]) &&
        !multiLotApiNormalization.serverWhitespaceLots.includes(multiLotApiNormalization.expectedLots[1]),
      `server whitespace lot_multi leaked second token: ${JSON.stringify(multiLotApiNormalization)}`
    );
    expect(limitValidation.lotError.includes('최대 300개'), `lotError=${limitValidation.lotError}`);
    expect(limitValidation.wfError.includes('최대 1000개'), `wfError=${limitValidation.wfError}`);
    expect(permissionVisible, 'permission modal hidden');
    expect(permRows >= 1, `permRows=${permRows}`);
    return {
      beforePages,
      afterPages,
      multiVisible,
      multiError,
      noResultDialog,
      searchBefore,
      searchAfter,
      multiNoResult,
      multiLotApiNormalization,
      limitValidation,
      permissionVisible,
      permRows,
    };
  });

  await record('22,23,28,29', 'Navigator / Minimap / 반복 진입 복귀', async () => {
    await boot('chunk2-nav');
    await loadFolder('unknown');
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

    await boot('chunk2-grid-restore');
    await loadFolder('unknown');
    const explorerDirectTarget = await page.evaluate(async () => {
      const v = window.viewer;
      const firstPath = (Array.isArray(v.currentGridImages) ? v.currentGridImages : [])
        .find((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/'));
      if (!firstPath) {
        return { firstPath: null, folderPath: null, linkFound: false };
      }
      const normalized = String(firstPath).replace(/\\/g, '/');
      const folderPath = normalized.split('/').slice(0, -1).join('/');
      const rootSummary = document.querySelector('summary.folder[data-path="unknown"]');
      if (rootSummary) {
        const rootDetails = rootSummary.parentElement;
        const rootContent = rootSummary.nextElementSibling;
        if (rootContent && rootDetails?.dataset.loaded !== 'true') {
          await v.loadDirectoryContents('unknown', rootContent);
          rootDetails.dataset.loaded = 'true';
        }
        if (rootDetails) {
          rootDetails.open = true;
        }
      }
      const folderSummary = Array.from(document.querySelectorAll('summary.folder'))
        .find((summary) => summary.dataset.path === folderPath);
      if (folderSummary) {
        const folderDetails = folderSummary.parentElement;
        const folderContent = folderSummary.nextElementSibling;
        if (folderContent && folderDetails?.dataset.loaded !== 'true') {
          await v.loadDirectoryContents(folderPath, folderContent);
          folderDetails.dataset.loaded = 'true';
        }
        if (folderDetails) {
          folderDetails.open = true;
        }
      }
      const fileLink = Array.from(document.querySelectorAll('#file-explorer a[data-path]'))
        .find((link) => link.dataset.path === normalized);
      return { firstPath: normalized, folderPath, linkFound: !!fileLink };
    });
    expect(
      explorerDirectTarget.linkFound,
      `unknown explorer file link missing=${JSON.stringify(explorerDirectTarget)}`
    );
    const explorerDirectRoundTrip = await page.evaluate(async (targetPath) => {
      const v = window.viewer;
      const fileLink = Array.from(document.querySelectorAll('#file-explorer a[data-path]'))
        .find((link) => link.dataset.path === targetPath);
      const before = {
        gridMode: v.gridMode,
        viewMode: v.viewMode,
        count: v.currentGridImages?.length || 0,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        firstPath: targetPath,
      };
      fileLink?.click();
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (v.viewMode === 'single' && v.selectedImagePath === targetPath) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const single = {
        gridMode: v.gridMode,
        viewMode: v.viewMode,
        savedType: v.savedViewState?.type || null,
        returnType: v.singleViewReturnState?.type || null,
        selectedImagePath: v.selectedImagePath || null,
      };
      return { before, single };
    }, explorerDirectTarget.firstPath);
    await backToGrid();
    await sleep(1000);
    explorerDirectRoundTrip.after = await page.evaluate(() => ({
      gridMode: window.viewer.gridMode,
      viewMode: window.viewer.viewMode,
      savedType: window.viewer.savedViewState?.type || null,
      count: window.viewer.currentGridImages?.length || 0,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      gridDisplay: getComputedStyle(document.getElementById('image-grid')).display,
    }));
    expect(
      explorerDirectRoundTrip.single.viewMode === 'single',
      `explorer single viewMode=${JSON.stringify(explorerDirectRoundTrip)}`
    );
    expect(
      explorerDirectRoundTrip.single.returnType === 'grid',
      `explorer return state missing=${JSON.stringify(explorerDirectRoundTrip)}`
    );
    expect(
      explorerDirectRoundTrip.after.gridMode === true,
      `explorer after gridMode=${JSON.stringify(explorerDirectRoundTrip.after)}`
    );
    expect(
      explorerDirectRoundTrip.after.savedType === 'grid',
      `explorer after savedType=${JSON.stringify(explorerDirectRoundTrip.after)}`
    );
    expect(
      explorerDirectRoundTrip.after.count === explorerDirectRoundTrip.before.count,
      `explorer count ${explorerDirectRoundTrip.before.count}->${explorerDirectRoundTrip.after.count}`
    );
    expect(
      explorerDirectRoundTrip.after.wraps > 0 &&
        explorerDirectRoundTrip.after.gridDisplay !== 'none',
      `explorer grid hidden=${JSON.stringify(explorerDirectRoundTrip.after)}`
    );

    await boot('chunk2-explorer-scrollbar-selection');
    await selectWaferExplorerFolder('unknown');
    const explorerOpen = await openExplorerForCurrentGridImage();
    expect(explorerOpen.linkFound, `explorer current file link missing=${JSON.stringify(explorerOpen)}`);

    const folderGridBeforeScrollbar = await getExplorerSelectionState('folder-grid-before-scrollbar');
    const folderGridScrollbarDrag = await dragWaferExplorerScrollbar();
    await sleep(500);
    const folderGridAfterScrollbar = await getExplorerSelectionState('folder-grid-after-scrollbar');
    expect(
      folderGridAfterScrollbar.gridMode === true &&
        folderGridAfterScrollbar.currentGridImagesLen === folderGridBeforeScrollbar.currentGridImagesLen &&
        folderGridAfterScrollbar.selectedImagesLen === folderGridBeforeScrollbar.selectedImagesLen,
      `Explorer scrollbar changed grid selection=${JSON.stringify({ before: folderGridBeforeScrollbar, after: folderGridAfterScrollbar, drag: folderGridScrollbarDrag })}`
    );
    expect(
      folderGridAfterScrollbar.selectedFolders.includes('unknown') &&
        folderGridAfterScrollbar.folderSelectedPaths.includes('unknown'),
      `Explorer scrollbar lost folder selection=${JSON.stringify({ before: folderGridBeforeScrollbar, after: folderGridAfterScrollbar, drag: folderGridScrollbarDrag })}`
    );

    await enterSingle(0);
    await sleep(500);
    const folderSingleBeforeScrollbar = await getExplorerSelectionState('folder-single-before-scrollbar');
    expect(
      folderSingleBeforeScrollbar.viewMode === 'gridImage' &&
        folderSingleBeforeScrollbar.selectedFolders.includes('unknown') &&
        folderSingleBeforeScrollbar.folderSelectedPaths.includes('unknown') &&
        folderSingleBeforeScrollbar.fileSelectedPaths.length === 0,
      `folder single explorer selection degraded=${JSON.stringify(folderSingleBeforeScrollbar)}`
    );
    const folderSingleScrollbarDrag = await dragWaferExplorerScrollbar();
    await sleep(500);
    const folderSingleAfterScrollbar = await getExplorerSelectionState('folder-single-after-scrollbar');
    expect(
      folderSingleAfterScrollbar.viewMode === 'gridImage' &&
        folderSingleAfterScrollbar.selectedImagePath === folderSingleBeforeScrollbar.selectedImagePath &&
        folderSingleAfterScrollbar.canvasVisible,
      `Explorer scrollbar hid single image=${JSON.stringify({ before: folderSingleBeforeScrollbar, after: folderSingleAfterScrollbar, drag: folderSingleScrollbarDrag })}`
    );
    expect(
      folderSingleAfterScrollbar.selectedFolders.includes('unknown') &&
        folderSingleAfterScrollbar.folderSelectedPaths.includes('unknown') &&
        folderSingleAfterScrollbar.fileSelectedPaths.length === 0,
      `Explorer scrollbar changed single explorer selection=${JSON.stringify({ before: folderSingleBeforeScrollbar, after: folderSingleAfterScrollbar, drag: folderSingleScrollbarDrag })}`
    );
    await backToGrid();

    await boot('chunk2-grid-restore');
    await loadFolder('unknown');
    const gridRoundTrips = [];
    for (let i = 0; i < 4; i += 1) {
      await roundTripGridImageByDblClick(0);
      const summary = await waitForVisibleGridThumbsLoaded(12000, 500);
      gridRoundTrips.push(summary);
      expect(summary.visibleCount > 0, `restore visibleCount=${summary.visibleCount}`);
      expect(summary.badCount === 0, `restore badCount=${summary.badCount}`);
    }

    await boot('chunk2-grid-restore-scrolled');
    await loadFolder('unknown');
    await scrollGridToRatio(0.82);
    await sleep(1200);
    const scrolledRoundTrips = [];
    for (let i = 0; i < 2; i += 1) {
      const targetIndex = await getMiddleVisibleGridIndex();
      await roundTripGridImageByDblClick(targetIndex);
      const summary = await waitForVisibleGridThumbsLoaded(12000, 500);
      scrolledRoundTrips.push({
        targetIndex,
        ...summary,
      });
      expect(summary.scrollTop > 0, `scrolled restore scrollTop=${summary.scrollTop}`);
      expect(summary.visibleCount > 0, `scrolled restore visibleCount=${summary.visibleCount}`);
      expect(summary.badCount === 0, `scrolled restore badCount=${summary.badCount}`);
    }

    await boot('chunk2-grid-scroll-stop');
    await loadFolder('unknown');
    await page.evaluate(async () => {
      const scrollWrapper = document.querySelector('#image-grid')?.parentElement;
      if (!scrollWrapper) return;
      const maxScrollTop = Math.max(
        0,
        scrollWrapper.scrollHeight - scrollWrapper.clientHeight
      );
      for (const ratio of [0.25, 0.5, 0.75, 0.9]) {
        scrollWrapper.scrollTop = Math.round(maxScrollTop * ratio);
        scrollWrapper.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 35));
      }
    });
    await sleep(300);
    const scrollEarly = await getVisibleGridThumbSummary();
    const scrollSettled = await waitForVisibleGridThumbsLoaded(12000, 500);
    expect(scrollEarly.visibleCount > 0, `scroll visibleCount=${scrollEarly.visibleCount}`);
    expect(
      scrollEarly.loadedCount > 0 || scrollEarly.bad.some((item) => item.loading === 'true'),
      `scroll early no loading progress: ${JSON.stringify(scrollEarly)}`
    );
    expect(scrollSettled.badCount === 0, `scroll settled badCount=${scrollSettled.badCount}`);

    return {
      loops,
      explorerDirectRoundTrip,
      explorerScrollbarSelection: {
        explorerOpen,
        folderGridBeforeScrollbar,
        folderGridScrollbarDrag,
        folderGridAfterScrollbar,
        folderSingleBeforeScrollbar,
        folderSingleScrollbarDrag,
        folderSingleAfterScrollbar,
      },
      gridRoundTrips,
      scrolledRoundTrips,
      scrollStop: {
        early: scrollEarly,
        settled: scrollSettled,
      },
    };
  });

  await record('30,33,34,35,39', 'Measure 다중선택 / Measure 탭 / 범례', async () => {
    await boot('chunk2-measure');
    await loadFolder('unknown');
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
    await loadFolder('unknown');
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
    expect(data.count === 5000, `count=${data.count}`);
    expect(data.wraps === 5000, `wraps=${data.wraps}`);
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
