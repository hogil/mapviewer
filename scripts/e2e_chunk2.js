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

  async function verifyRapidNextPrevUnknown() {
    const rapidNav = await page.evaluate(async () => {
      const v = window.viewer;
      const waitFor = async (predicate, timeoutMs = 30000, intervalMs = 50) => {
        const startedAt = performance.now();
        while (performance.now() - startedAt < timeoutMs) {
          if (predicate()) return Math.round(performance.now() - startedAt);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return -1;
      };
      const canvasVisible = () => {
        const canvas = document.getElementById('image-canvas');
        if (!canvas) return false;
        const style = getComputedStyle(canvas);
        const rect = canvas.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const files = (Array.isArray(v.currentGridImages) ? v.currentGridImages : [])
        .map((imagePath) => String(imagePath || '').replace(/\\/g, '/'))
        .filter((imagePath, index, arr) => imagePath.startsWith('unknown/') && arr.indexOf(imagePath) === index)
        .slice(0, 80);
      if (files.length < 20) {
        return { ok: false, reason: `unknown files=${files.length}`, filesCount: files.length };
      }

      v.selectedFolders = new Set(['unknown']);
      v.selectedImages = files.slice();
      v.lastSelectedFolderPath = 'unknown';
      v.currentFolderPrefix = 'unknown/';
      v.showGrid(files, true);
      await waitFor(
        () =>
          v.gridMode === true &&
          (v.currentGridImages?.length || 0) === files.length &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0,
        30000
      );

      const runRapid = async (mode, commands) => {
        const steps = [];
        for (const direction of commands) {
          const list = mode === 'gridImage' ? v.gridViewImageList : v.singleViewImageList;
          const beforePath = v.selectedImagePath || '';
          const beforeIndex = list.indexOf(beforePath);
          const startedAt = performance.now();
          if (direction > 0) v.navigateNext();
          else v.navigatePrevious();
          const callMs = performance.now() - startedAt;
          const afterPath = v.selectedImagePath || '';
          const afterIndex = list.indexOf(afterPath);
          steps.push({
            direction,
            beforeIndex,
            afterIndex,
            beforePath,
            afterPath,
            callMs: Math.round(callMs * 10) / 10,
            changed: beforeIndex !== afterIndex,
            unknown: afterPath.startsWith('unknown/'),
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const list = mode === 'gridImage' ? v.gridViewImageList : v.singleViewImageList;
        const expectedIndex = commands.reduce((idx, direction) => {
          const next = idx + direction;
          if (next < 0) return list.length - 1;
          if (next >= list.length) return 0;
          return next;
        }, 0);
        const waitMs = await waitFor(
          () =>
            v._isNavigating === false &&
            v.selectedImagePath === list[expectedIndex] &&
            canvasVisible(),
          30000
        );
        return {
          mode,
          steps,
          expectedIndex,
          finalIndex: list.indexOf(v.selectedImagePath || ''),
          finalPath: v.selectedImagePath || '',
          waitMs,
          immediateChangedEveryClick: steps.every((step) => step.changed && step.unknown && step.callMs < 50),
        };
      };

      v.enterSingleImageMode(0);
      const gridEnterWaitMs = await waitFor(
        () => v.viewMode === 'gridImage' && v.selectedImagePath === files[0] && canvasVisible(),
        30000
      );
      const commands = [1, 1, 1, -1, 1, -1, 1];
      const grid = await runRapid('gridImage', commands);

      if (v.imageLoadAbortController) v.imageLoadAbortController.abort();
      v._isNavigating = false;
      v.viewMode = 'single';
      v.gridMode = false;
      v.singleImageFromGrid = false;
      v.singleViewImageList = files.slice();
      v.singleViewImageIndex = 0;
      await v.loadImage(files[0], false, null, true);
      const singleEnterWaitMs = await waitFor(
        () => v.viewMode === 'single' && v.selectedImagePath === files[0] && canvasVisible(),
        30000
      );
      const single = await runRapid('single', commands);

      return {
        ok: true,
        filesCount: files.length,
        firstPath: files[0],
        gridEnterWaitMs,
        singleEnterWaitMs,
        grid,
        single,
        pendingNavDirection: v._pendingNavDirection || 0,
        isNavigating: !!v._isNavigating,
      };
    });

    append(`[RAPID_NAV_UNKNOWN] ${JSON.stringify(rapidNav)}\n`);
    expect(rapidNav.ok, `rapid nav setup failed=${JSON.stringify(rapidNav)}`);
    expect(
      rapidNav.grid?.immediateChangedEveryClick === true,
      `grid next/prev did not react immediately=${JSON.stringify(rapidNav.grid)}`
    );
    expect(
      rapidNav.single?.immediateChangedEveryClick === true,
      `single next/prev did not react immediately=${JSON.stringify(rapidNav.single)}`
    );
    expect(
      rapidNav.grid?.finalIndex === rapidNav.grid?.expectedIndex && rapidNav.grid?.waitMs >= 0,
      `grid rapid nav final mismatch=${JSON.stringify(rapidNav.grid)}`
    );
    expect(
      rapidNav.single?.finalIndex === rapidNav.single?.expectedIndex && rapidNav.single?.waitMs >= 0,
      `single rapid nav final mismatch=${JSON.stringify(rapidNav.single)}`
    );
    return rapidNav;
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
    const noResultToken = `NOE2ENORESULT${Date.now()}`;
    await page.evaluate(() => {
      window.__e2eSearchUrls = [];
      window.__e2eOriginalFetch = window.fetch;
      window.__e2eAlerts = [];
      window.__e2eOriginalAlert = window.alert;
      window.alert = (message) => {
        window.__e2eAlerts.push(String(message || ''));
      };
      window.fetch = async (...args) => {
        const url = String(args[0] || '');
        if (url.startsWith('/api/search?')) window.__e2eSearchUrls.push(url);
        return window.__e2eOriginalFetch.apply(window, args);
      };
    });
    await page.fill('#file-search', noResultToken);
    await page.click('#search-btn');
    await page.waitForFunction(
      () => {
        const gridText = (document.getElementById('image-grid')?.textContent || '').trim();
        return (
          (window.__e2eSearchUrls || []).some((url) => String(url || '').startsWith('/api/search?')) &&
          (window.viewer?.currentGridImages?.length || 0) === 0 &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length === 0 &&
          gridText.includes('검색 결과가 없습니다')
        );
      },
      null,
      { timeout: 30000 }
    );
    const searchAfter = await page.evaluate(() => ({
      gridMode: !!window.viewer.gridMode,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      count: window.viewer.currentGridImages?.length || 0,
      message: (document.getElementById('image-grid')?.textContent || '').trim(),
      searchUrl: (window.__e2eSearchUrls || []).find((url) => url.startsWith('/api/search?')) || '',
      alerts: [...(window.__e2eAlerts || [])],
      folderParam: (() => {
        const url = (window.__e2eSearchUrls || []).find((item) => item.startsWith('/api/search?')) || '';
        return url ? new URL(url, window.location.origin).searchParams.get('folder') : null;
      })(),
    }));
    await page.evaluate(() => {
      if (window.__e2eOriginalFetch) window.fetch = window.__e2eOriginalFetch;
      if (window.__e2eOriginalAlert) window.alert = window.__e2eOriginalAlert;
      delete window.__e2eOriginalFetch;
      delete window.__e2eOriginalAlert;
      delete window.__e2eSearchUrls;
      delete window.__e2eAlerts;
    });

    await loadFolder('unknown');
    await page.evaluate(() => window.viewer.openMultiSearchModal?.());
    await sleep(300);
    await page.fill('#multi-search-input', noResultToken);
    await page.click('#multi-search-apply');
    await page.waitForFunction(
      () => {
        const error = (document.getElementById('multi-search-error')?.textContent || '').trim();
        const gridText = (document.getElementById('image-grid')?.textContent || '').trim();
        return (
          error.length > 0 &&
          (window.viewer?.currentGridImages?.length || 0) === 0 &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length === 0 &&
          gridText.includes('검색 결과가 없습니다')
        );
      },
      null,
      { timeout: 30000 }
    );
    const multiNoResult = await page.evaluate(() => {
      const modal = document.getElementById('multi-search-modal');
      const style = modal ? getComputedStyle(modal) : null;
      return {
        modalVisible: !!modal && style.display !== 'none' && style.visibility !== 'hidden',
        error: (document.getElementById('multi-search-error')?.textContent || '').trim(),
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        count: window.viewer.currentGridImages?.length || 0,
        message: (document.getElementById('image-grid')?.textContent || '').trim(),
      };
    });
    await page.keyboard.press('Escape');
    await sleep(300);
    await loadFolder('unknown');

    const multiLotApiNormalization = await page.evaluate(async (noResultLot) => {
      const v = window.viewer;
      const samples = [];
      const seen = new Set();
      for (const imagePath of v.currentGridImages || []) {
        const tokens = v.extractLotTokensFromPath(imagePath);
        const lot = tokens?.lotValue || '';
        const wafer = tokens?.waferValue || '';
        const key = lot.toLowerCase();
        if (!lot || !wafer || seen.has(key)) continue;
        seen.add(key);
        samples.push({
          lot,
          wafer,
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
        v.selectedFolders = new Set(['unknown']);
        v.lastLoadedGridFolderPath = 'unknown';
        v.currentFolderPrefix = 'unknown/';
        input.value = [
          `${samples[0].lot} 05`,
          `${samples[1].path}\tignored-column`,
          `${samples[2].filename}    ignored-column`,
        ].join('\n');
        const parsed = v.parseMultiSearchInput();
        const success = parsed.error
          ? false
          : await v.performSearch({ multiLotList: [...(parsed.lots || [])], suppressAlerts: true });
        const lotSearchUrl = captured.find((url) => url.startsWith('/api/search?') && url.includes('lot_multi=')) || '';
        const lotSearchParams = lotSearchUrl ? new URL(lotSearchUrl, window.location.origin).searchParams : null;
        const lotMulti = lotSearchParams
          ? lotSearchParams.get('lot_multi') || ''
          : '';
        const lotParts = lotMulti.split(',').filter(Boolean);
        const expectedLots = samples.map((sample) => sample.lot.toLowerCase());
        const resultLots = Array.from(new Set((v.currentGridImages || [])
          .map((imagePath) => v.extractLotTokensFromPath(imagePath)?.lotValue || '')
          .filter(Boolean)
          .map((lot) => lot.toLowerCase())));
        v.selectedFolders = new Set(['unknown']);
        v.lastLoadedGridFolderPath = 'unknown';
        v.currentFolderPrefix = 'unknown/';
        const pairStr = samples.slice(0, 2).map((sample) => `${sample.lot}:${sample.wafer}`).join(',');
        const wfSuccess = await v.performSearch({ wfPairs: pairStr, suppressAlerts: true });
        const wfSearchUrl = captured.find((url) => url.startsWith('/api/search?') && url.includes('lot_wafer=')) || '';
        const wfSearchParams = wfSearchUrl ? new URL(wfSearchUrl, window.location.origin).searchParams : null;
        const wfNoResultStart = captured.length;
        const wfNoResultSuccess = await v.performSearch({
          wfPairs: `${noResultLot}:99`,
          suppressAlerts: true,
        });
        const wfNoResultUrl = captured
          .slice(wfNoResultStart)
          .find((url) => url.startsWith('/api/search?') && url.includes('lot_wafer=')) || '';
        const wfNoResultParams = wfNoResultUrl ? new URL(wfNoResultUrl, window.location.origin).searchParams : null;
        const wfNoResult = {
          success: wfNoResultSuccess === true,
          wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
          count: v.currentGridImages?.length || 0,
          message: (document.getElementById('image-grid')?.textContent || '').trim(),
          folderParam: wfNoResultParams ? wfNoResultParams.get('folder') : null,
        };
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
          searchUrl: lotSearchUrl,
          lotFolderParam: lotSearchParams ? lotSearchParams.get('folder') : null,
          wfOk: wfSuccess === true,
          wfSearchUrl,
          wfFolderParam: wfSearchParams ? wfSearchParams.get('folder') : null,
          wfNoResult,
          serverWhitespaceInput,
          serverWhitespaceUrl,
          serverWhitespaceLots,
        };
      } finally {
        window.fetch = originalFetch;
        if (input) input.value = originalValue;
      }
    }, noResultToken);

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

    await loadFolder('unknown');
    const searchCtrlAQueryCandidates = await page.evaluate(() => {
      const v = window.viewer;
      const counts = new Map();
      for (const imagePath of v.currentGridImages || []) {
        if (!String(imagePath || '').startsWith('unknown/')) continue;
        const filename = String(imagePath || '').replace(/\\/g, '/').split('/').pop() || '';
        const tokens = filename.replace(/\.[^.]+$/, '').split('_').filter(Boolean);
        for (const token of tokens) {
          if (token.length < 3) continue;
          counts.set(token, (counts.get(token) || 0) + 1);
        }
      }
      const candidates = [...counts.entries()]
        .filter(([, count]) => count >= 5)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const preferred = ['20260501', '010000'];
      return [...new Set([
        ...preferred.filter((token) => counts.has(token)),
        ...candidates.map(([token]) => token),
        ...counts.keys(),
      ])].slice(0, 30);
    });
    expect(searchCtrlAQueryCandidates.length > 0, 'search Ctrl+A sample query missing');
    let searchCtrlASampleQuery = '';
    let searchCtrlASampleCount = 0;
    for (const query of searchCtrlAQueryCandidates) {
      await page.fill('#file-search', query);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => {
          const message = (document.getElementById('image-grid')?.textContent || '').trim();
          return (
            document.activeElement?.id !== 'file-search' &&
            ((window.viewer?.currentGridImages?.length || 0) > 0 || message.includes('검색 결과가 없습니다'))
          );
        },
        null,
        { timeout: 15000 }
      ).catch(() => {});
      const candidateState = await page.evaluate(() => ({
        count: window.viewer?.currentGridImages?.length || 0,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      }));
      if (candidateState.count >= 5 && candidateState.wraps >= 5) {
        searchCtrlASampleQuery = query;
        searchCtrlASampleCount = candidateState.count;
        break;
      }
    }
    expect(
      searchCtrlASampleQuery && searchCtrlASampleCount >= 5,
      `search Ctrl+A query candidates produced fewer than 5 results: ${JSON.stringify({ searchCtrlAQueryCandidates, searchCtrlASampleQuery, searchCtrlASampleCount })}`
    );
    await page.waitForFunction(
      () => (
        !!window.viewer &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) > 0 &&
        document.activeElement?.id !== 'file-search'
      ),
      null,
      { timeout: 30000 }
    );
    await page.keyboard.press('Control+A');
    await sleep(300);
    const searchCtrlA = await page.evaluate(() => ({
      activeElementId: document.activeElement?.id || '',
      selectedCount: window.viewer.gridSelectedIdxs?.length || 0,
      totalCount: window.viewer.currentGridImages?.length || 0,
      selectedWraps: document.querySelectorAll('#image-grid .grid-thumb-wrap.selected').length,
      searchValue: document.getElementById('file-search')?.value || '',
    }));
    await page.evaluate(() => window.viewer.clearGridSelection?.());
    await page.locator('#image-grid .grid-thumb-wrap').nth(0).click();
    await page.locator('#image-grid .grid-thumb-wrap').nth(2).click({ modifiers: ['Control'] });
    await page.locator('#image-grid .grid-thumb-wrap').nth(4).click({ modifiers: ['Shift'] });
    await sleep(300);
    const searchCtrlShift = await page.evaluate(() => ({
      selectedIdxs: [...(window.viewer.gridSelectedIdxs || [])].sort((a, b) => a - b),
      selectedWraps: Array.from(document.querySelectorAll('#image-grid .grid-thumb-wrap.selected'))
        .map((wrap) => Number(wrap.dataset.index))
        .sort((a, b) => a - b),
      totalCount: window.viewer.currentGridImages?.length || 0,
    }));

    await loadFolder('unknown');
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
    expect(searchAfter.alerts.includes('검색 결과가 없습니다.'), `noResultAlert=${JSON.stringify(searchAfter.alerts)}`);
    expect(searchAfter.gridMode === searchBefore.gridMode, `search gridMode ${searchBefore.gridMode}->${searchAfter.gridMode}`);
    expect(searchAfter.wraps === 0, `search no-result should clear wraps ${searchBefore.wraps}->${searchAfter.wraps}`);
    expect(searchAfter.count === 0, `search no-result should clear count ${searchBefore.count}->${searchAfter.count}`);
    expect(searchAfter.message.includes('검색 결과가 없습니다'), `search no-result message=${searchAfter.message}`);
    expect(!searchAfter.folderParam, `file search leaked folder param: ${JSON.stringify(searchAfter)}`);
    expect(multiNoResult.modalVisible, 'multi-search no-result modal hidden');
    expect(multiNoResult.error.length > 0, 'multi-search no-result error missing');
    expect(multiNoResult.wraps === 0, `multi-search no-result should clear wraps ${multiNoResult.wraps}`);
    expect(multiNoResult.count === 0, `multi-search no-result should clear count ${multiNoResult.count}`);
    expect(multiNoResult.message.includes('검색 결과가 없습니다'), `multi-search no-result message=${multiNoResult.message}`);
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
      !multiLotApiNormalization.lotFolderParam,
      `multi LOT search leaked folder param: ${JSON.stringify(multiLotApiNormalization)}`
    );
    expect(
      multiLotApiNormalization.wfOk && !multiLotApiNormalization.wfFolderParam,
      `multi WF search leaked folder param or failed: ${JSON.stringify(multiLotApiNormalization)}`
    );
    expect(
      multiLotApiNormalization.wfNoResult &&
        multiLotApiNormalization.wfNoResult.success === false &&
        multiLotApiNormalization.wfNoResult.wraps === 0 &&
        multiLotApiNormalization.wfNoResult.count === 0 &&
        !multiLotApiNormalization.wfNoResult.folderParam &&
        multiLotApiNormalization.wfNoResult.message.includes('검색 결과가 없습니다'),
      `multi WF no-result should clear stale grid: ${JSON.stringify(multiLotApiNormalization)}`
    );
    expect(
      multiLotApiNormalization.serverWhitespaceLots.includes(multiLotApiNormalization.expectedLots[0]) &&
        !multiLotApiNormalization.serverWhitespaceLots.includes(multiLotApiNormalization.expectedLots[1]),
      `server whitespace lot_multi leaked second token: ${JSON.stringify(multiLotApiNormalization)}`
    );
    expect(limitValidation.lotError.includes('최대 300개'), `lotError=${limitValidation.lotError}`);
    expect(limitValidation.wfError.includes('최대 1000개'), `wfError=${limitValidation.wfError}`);
    expect(
      searchCtrlA.totalCount > 0 &&
        searchCtrlA.selectedCount === searchCtrlA.totalCount &&
        searchCtrlA.selectedWraps === searchCtrlA.totalCount &&
        searchCtrlA.activeElementId !== 'file-search',
      `search Ctrl+A did not select grid: ${JSON.stringify(searchCtrlA)}`
    );
    expect(
      searchCtrlShift.totalCount >= 5 &&
        JSON.stringify(searchCtrlShift.selectedIdxs) === JSON.stringify([0, 2, 3, 4]) &&
        JSON.stringify(searchCtrlShift.selectedWraps) === JSON.stringify([0, 2, 3, 4]),
      `search Ctrl/Shift selection failed: ${JSON.stringify(searchCtrlShift)}`
    );
    expect(permissionVisible, 'permission modal hidden');
    expect(permRows >= 1, `permRows=${permRows}`);
    return {
      beforePages,
      afterPages,
      multiVisible,
      multiError,
      searchBefore,
      searchAfter,
      multiNoResult,
      multiLotApiNormalization,
      limitValidation,
      searchCtrlA,
      searchCtrlShift,
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
    const rapidNextPrevUnknown = await verifyRapidNextPrevUnknown();

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
      rapidNextPrevUnknown,
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

  await record('measure-single-consistency', '단일 Measure 단일선택 / stale render / 네비게이터 동기화', async () => {
    await boot('chunk2-measure-single');
    await loadFolder('unknown');
    const measureSelection = await findCommonMeasureSelection('f', 1, 24);
    await setSelection([measureSelection.indices[0]]);
    await page.evaluate(async (payload) => {
      const v = window.viewer;
      v._measureCheckedItems = [payload.item];
      await v._applyMeasureSelection();
    }, measureSelection);
    await page.waitForFunction(
      () => {
        const v = window.viewer;
        return v.gridMode === false &&
          (v.viewMode === 'single' || v.viewMode === 'gridImage') &&
          v._measureOverlayRendered === true &&
          !!v.currentImageBitmap;
      },
      null,
      { timeout: 90000 }
    );

    const initial = await page.evaluate(async () => {
      const v = window.viewer;
      const bitmap = v.currentImageBitmap;
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = 64;
      sampleCanvas.height = 64;
      const ctx = sampleCanvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, 64, 64);
      const pixels = ctx.getImageData(0, 0, 64, 64).data;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 16) {
        colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      }
      const nav = v.thumbnailNavigator;
      const currentPath = v.selectedImagePath || v.currentImagePath || '';
      const normalized = v.normalizePath(currentPath);
      const expectedIndex = (v.gridViewImageList || []).findIndex((path) => {
        const candidate = v.normalizePath(path);
        return candidate === normalized || candidate.endsWith(`/${normalized}`) || normalized.endsWith(`/${candidate}`);
      });
      const positions = await fetch(
        `/api/chip-positions?path=${encodeURIComponent(currentPath)}&include_fq=1`,
        { cache: 'no-store' }
      ).then((response) => response.ok ? response.json() : null);
      const fKeys = (positions?.ftn_keys || []).map(String);
      const qKeys = (positions?.qtn_keys || []).map(String);
      const field = fKeys.length >= 2 ? 'f' : 'q';
      const keys = field === 'f' ? fKeys.slice(0, 2) : qKeys.slice(0, 2);
      return {
        path: currentPath,
        gridMode: v.gridMode,
        viewMode: v.viewMode,
        measureItems: v._measureCheckedItems.length,
        overlayMode: v.overlayMode,
        measureOverlayRendered: v._measureOverlayRendered,
        bitmapSize: { width: bitmap.width, height: bitmap.height },
        uniqueSampleColors: colors.size,
        navigatorIndex: nav?.currentImageIndex ?? -1,
        expectedNavigatorIndex: expectedIndex,
        field,
        keys,
      };
    });
    expect(initial.gridMode === false, `single gridMode=${initial.gridMode}`);
    expect(initial.measureItems === 1, `single measureItems=${initial.measureItems}`);
    expect(initial.measureOverlayRendered === true, `measure overlay=${initial.measureOverlayRendered}`);
    expect(initial.bitmapSize.width > 0 && initial.bitmapSize.height > 0, `bitmap=${JSON.stringify(initial.bitmapSize)}`);
    expect(initial.uniqueSampleColors > 2, `measure bitmap looks flat/white colors=${initial.uniqueSampleColors}`);
    expect(
      initial.navigatorIndex === initial.expectedNavigatorIndex && initial.navigatorIndex >= 0,
      `navigator=${JSON.stringify({ current: initial.navigatorIndex, expected: initial.expectedNavigatorIndex })}`
    );
    expect(initial.keys.length >= 2, `same-image measure keys=${JSON.stringify(initial)}`);

    let delayedMeasureRequests = 0;
    const measureRoute = '**/api/measure-composite-data';
    await page.route(measureRoute, async (route) => {
      delayedMeasureRequests += 1;
      await sleep(delayedMeasureRequests === 1 ? 450 : 10);
      try {
        await route.continue();
      } catch {
        // The first request may already be stale; the browser abort is the expected path.
      }
    });
    let race;
    try {
      race = await page.evaluate(async ({ field, keys }) => {
        const v = window.viewer;
        const apply = (key) => {
          v._measureCheckedItems = [{ type: field, key, label: `${field}${key}` }];
          v.overlayMode = field;
          v._ratioActiveItemKey = key;
          return v._applyMeasureSelection();
        };
        const first = apply(keys[0]);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const second = apply(keys[1]);
        await Promise.allSettled([first, second]);
        return {
          activeKey: v._ratioActiveItemKey,
          checkedItems: v._measureCheckedItems.length,
          overlayMode: v.overlayMode,
          measureOverlayRendered: v._measureOverlayRendered,
        };
      }, initial);
    } finally {
      await page.unroute(measureRoute);
    }
    expect(race.activeKey === initial.keys[1], `stale measure won=${JSON.stringify(race)}`);
    expect(race.checkedItems === 1 && race.measureOverlayRendered === true, `race state=${JSON.stringify(race)}`);

    const singleSelectionGuard = await page.evaluate(({ field, keys }) => {
      const v = window.viewer;
      const panel = document.getElementById('failbit-panel-filename');
      const list = panel?.querySelector('.failbit-list');
      const measureKeys = field === 'f' ? { f: keys, q: [], bin: [] } : { f: [], q: keys, bin: [] };
      if (!list) return { ok: false, reason: 'measure list missing' };
      v._measureCheckedItems = keys.map((key) => ({ type: field, key, label: `${field}${key}` }));
      v._renderMcList(list, measureKeys, { mode: 'measure' });
      const inputs = Array.from(panel.querySelectorAll('input[type="checkbox"]'))
        .filter((input) => input._measureEntry?.type === field);
      if (inputs.length < 2) {
        return {
          ok: false,
          reason: `measure input count=${inputs.length}`,
          field,
          keys,
          labels: Array.from(panel.querySelectorAll('input[type="checkbox"]')).map((input) => ({
            type: input._measureEntry?.type || null,
            key: input._measureEntry?.key || null,
            label: input.closest('.failbit-item')?.textContent?.trim() || '',
          })),
        };
      }
      const initiallyChecked = inputs.filter((input) => input.checked);
      if (initiallyChecked.length !== 1 || v._measureCheckedItems.length !== 1) {
        return {
          ok: false,
          reason: 'single view render restored multiple Measure items',
          initiallyChecked: initiallyChecked.length,
          measureItems: v._measureCheckedItems.map((item) => `${item.type}:${item.key}`),
        };
      }
      const nextInput = inputs.find((input) => !input.checked);
      if (initiallyChecked.length > 0 && nextInput) {
        // 기존 선택을 유지한 채 새 항목을 선택해야 pinned 영역의 중복 체크를 검출할 수 있다.
        nextInput.click();
      } else {
        inputs[0].click();
        inputs[1].click();
      }
      const checkedInputs = inputs.filter((input) => input.checked).length;
      const checkedItems = v._measureCheckedItems.map((item) => `${item.type}:${item.key}`);
      v._closeFailbitPanels?.();
      return {
        ok: true,
        checkedInputs,
        checkedItems,
        measureItems: v._measureCheckedItems.length,
        gridMode: v.gridMode,
      };
    }, initial);
    expect(singleSelectionGuard.ok === true, JSON.stringify(singleSelectionGuard));
    expect(
      singleSelectionGuard.checkedInputs === 1 &&
        singleSelectionGuard.measureItems === 1 &&
        singleSelectionGuard.gridMode === false,
      `single selection guard=${JSON.stringify(singleSelectionGuard)}`
    );

    await page.evaluate(({ field, key }) => {
      const v = window.viewer;
      v._measureCheckedItems = [{ type: field, key, label: `${field}${key}` }];
      v.overlayMode = field;
      v._ratioActiveItemKey = key;
    }, { field: initial.field, key: initial.keys[1] });
    return { initial, race: { ...race, delayedMeasureRequests }, singleSelectionGuard };
  });

  await record('systematic-measure-single-lot-wafer', 'AAI633 / wafer 08 SYSTEMATIC Measure 단일보기와 네비게이터', async () => {
    const expectedBins = [
      '285', '286', '287', '288', '290', '291',
      '300', '385', '386', '388', '389', '390',
    ];
    const targetFile = 'AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.png';
    await boot('chunk2-systematic-measure-single-lot-wafer');
    await loadFolder('unknown/CenterDonut');

    const target = await page.evaluate(({ targetFile, expectedBins }) => {
      const v = window.viewer;
      const index = (v.currentGridImages || []).findIndex((imagePath) =>
        String(imagePath || '').replace(/\\/g, '/').endsWith(`/CenterDonut/${targetFile}`)
      );
      if (index < 0) {
        return {
          ok: false,
          reason: 'target LOT/Wafer fixture missing',
          gridCount: v.currentGridImages?.length || 0,
          sample: (v.currentGridImages || []).slice(0, 5),
        };
      }
      const imagePath = v.currentGridImages[index];
      const item = {
        type: 'systematic',
        key: null,
        label: 'SYSTEMATIC',
        binTypes: [...expectedBins],
      };
      v.gridSelectedIdxs = [index];
      v.gridSelectedSet = new Set([index]);
      v.selectedImages = [imagePath];
      v._measureCheckedItems = [item];
      return { ok: true, index, imagePath, item };
    }, { targetFile, expectedBins });
    expect(target.ok, JSON.stringify(target));

    await page.evaluate(async () => {
      await window.viewer._applyMeasureSelection();
    });
    await page.waitForFunction(
      ({ imagePath }) => {
        const v = window.viewer;
        return !!v &&
          v.gridMode === false &&
          v.viewMode === 'gridImage' &&
          v.selectedImagePath === imagePath &&
          v.overlayMode === 'bin' &&
          v.chipAnnotator?.overlayMode === 'bin' &&
          v.chipAnnotator?.positionsData &&
          v.chipAnnotator?.binOverlayFilterSet?.size === 12;
      },
      { imagePath: target.imagePath },
      { timeout: 90000 }
    );
    await sleep(1500);

    const data = await page.evaluate(({ expectedBins, imagePath }) => {
      const v = window.viewer;
      const toRgb = (hex) => {
        const value = String(hex || '').replace('#', '');
        if (!/^[0-9a-f]{6}$/i.test(value)) return null;
        return [
          Number.parseInt(value.slice(0, 2), 16),
          Number.parseInt(value.slice(2, 4), 16),
          Number.parseInt(value.slice(4, 6), 16),
        ];
      };
      const selectedColors = expectedBins
        .map((bin) => toRgb(v.chipAnnotator?.binOverlayColors?.get(bin)))
        .filter(Boolean)
        .map((rgb) => rgb.join(','));
      const countSelectedPixels = (canvas) => {
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) return 0;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (selectedColors.includes(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`)) count += 1;
        }
        return count;
      };
      const navImage = document.querySelector('#thumbnail-navigator-list img');
      let navigatorSelectedPixels = 0;
      let navigatorAccentPixels = 0;
      if (navImage?.complete && navImage.naturalWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = navImage.naturalWidth;
        canvas.height = navImage.naturalHeight;
        const navContext = canvas.getContext('2d');
        navContext.drawImage(navImage, 0, 0);
        const navPixels = navContext.getImageData(0, 0, canvas.width, canvas.height).data;
        navigatorSelectedPixels = countSelectedPixels(canvas);
        for (let i = 0; i < navPixels.length; i += 4) {
          const r = navPixels[i];
          const g = navPixels[i + 1];
          const b = navPixels[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max - min >= 90 && max >= 150) navigatorAccentPixels += 1;
        }
      }
      const overlayCanvas = document.getElementById('overlay-canvas');
      const imageCanvas = document.getElementById('image-canvas');
      const selectedItem = v._measureCheckedItems?.[0];
      const navigatorUrl = navImage?.currentSrc || navImage?.src || navImage?.dataset?.src || '';
      const normalizePath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
      const mainFilteredRequest = performance.getEntriesByType('resource').some((entry) => {
        try {
          const url = new URL(entry.name, location.href);
          if (url.pathname !== '/api/image') return false;
          if (normalizePath(url.searchParams.get('path')) !== normalizePath(imagePath)) return false;
          if (url.searchParams.get('bin_overlay') !== '1') return false;
          return url.searchParams.get('bottom_filter') === expectedBins.join(',');
        } catch (_) {
          return false;
        }
      });
      return {
        lot: imagePath.split('/').pop()?.split('_')[0] || '',
        wafer: imagePath.split('/').pop()?.split('_')[2] || '',
        path: v.selectedImagePath,
        gridMode: v.gridMode,
        viewMode: v.viewMode,
        overlayMode: v.overlayMode,
        selectedItem,
        filterBins: [...(v.chipAnnotator?.binOverlayFilterSet || [])],
        filterColor: v.chipAnnotator?.binOverlayFilterColor,
        filteredChipCount: (v.chipAnnotator?.chips || []).filter((chip) =>
          expectedBins.includes(String(v.chipAnnotator._normalizeSystematicBinValue(chip?.b)))
        ).length,
        mainSelectedPixels: countSelectedPixels(imageCanvas),
        overlaySelectedPixels: countSelectedPixels(overlayCanvas),
        navigatorSelectedPixels,
        navigatorAccentPixels,
        mainFilteredRequest,
        mainPyramidCacheKey: String(v.currentPyramidCacheKey || ''),
        navigator: {
          index: v.thumbnailNavigator?.currentImageIndex ?? -1,
          expectedIndex: (v.gridViewImageList || []).findIndex((path) => path === imagePath),
          naturalWidth: navImage?.naturalWidth || 0,
          naturalHeight: navImage?.naturalHeight || 0,
          url: navigatorUrl,
        },
      };
    }, { expectedBins, imagePath: target.imagePath });

    expect(data.lot === 'AAI633' && data.wafer === '08', `LOT/Wafer=${data.lot}/${data.wafer}`);
    expect(data.gridMode === false && data.viewMode === 'gridImage', `single=${JSON.stringify(data)}`);
    expect(data.overlayMode === 'bin', `overlayMode=${data.overlayMode}`);
    expect(data.selectedItem?.type === 'systematic' && data.selectedItem?.label === 'SYSTEMATIC', `item=${JSON.stringify(data.selectedItem)}`);
    expect(JSON.stringify(data.selectedItem?.binTypes) === JSON.stringify(expectedBins), `item bins=${JSON.stringify(data.selectedItem?.binTypes)}`);
    expect(JSON.stringify(data.filterBins) === JSON.stringify(expectedBins), `filter bins=${JSON.stringify(data.filterBins)}`);
    expect(data.filterColor == null, `systematic forced color=${data.filterColor}`);
    expect(data.filteredChipCount >= 3, `filtered chips=${data.filteredChipCount}`);
    expect(data.mainFilteredRequest, `single main image was not filtered=${JSON.stringify(data)}`);
    expect(data.mainPyramidCacheKey.includes('bottom_filter='), `single pyramid cache is raw=${JSON.stringify(data)}`);
    expect(data.overlaySelectedPixels > 0, `single systematic overlay colors=${JSON.stringify(data)}`);
    expect(data.navigator.index === data.navigator.expectedIndex && data.navigator.index >= 0, `navigator index=${JSON.stringify(data.navigator)}`);
    expect(data.navigator.naturalWidth > 0 && data.navigator.naturalHeight > 0, `navigator image=${JSON.stringify(data.navigator)}`);
    expect(data.navigator.url.includes('/api/thumbnail?') && data.navigator.url.includes('bin_overlay=1') && data.navigator.url.includes('bottom_filter='), `navigator url=${data.navigator.url}`);
    expect(!data.navigator.url.includes('/api/bin-map-thumb'), `navigator should use filtered thumbnail=${data.navigator.url}`);
    expect(data.navigatorAccentPixels > 0, `navigator systematic colors=${JSON.stringify(data)}`);

    await page.evaluate(() => {
      const v = window.viewer;
      v._measureCheckedItems = [];
      v.overlayMode = null;
      v._ratioActiveItemKey = null;
      v._gridMeasureMap = null;
      v.chipAnnotator?.setOverlayMode(null);
    });
    return data;
  });

  await record('layout-chip-coordinates', 'P001 layout EDS 매칭 / Chip Coord / Shot 순서 / Shot 토글·선택 / 경계', async () => {
    const targetFile = 'AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.png';
    const folder = 'PW/P001/20260501';
    await boot('chunk2-layout-chip-coordinates');
    await loadFolder(folder);

    const target = await page.evaluate(({ targetFile, folder }) => {
      const v = window.viewer;
      const index = (v.currentGridImages || []).findIndex((imagePath) =>
        String(imagePath || '').replace(/\\/g, '/').endsWith(`${folder}/${targetFile}`)
      );
      if (index < 0) {
        return {
          ok: false,
          reason: 'layout dummy target missing',
          gridCount: v.currentGridImages?.length || 0,
          sample: (v.currentGridImages || []).slice(0, 5),
        };
      }
      return { ok: true, index, imagePath: v.currentGridImages[index] };
    }, { targetFile, folder });
    expect(target.ok, JSON.stringify(target));

    await setSelection([target.index]);
    await enterSingle(target.index);
    await page.waitForFunction(
      () => window.viewer?.chipAnnotator?.layoutProcessId === 'P001' &&
        window.viewer.chipAnnotator.layoutByEdsChip?.size === 833 &&
        window.viewer.chipAnnotator.shotBoundaryGroups?.size === 43 &&
        document.getElementById('single-shot-boundary-btn') &&
        window.viewer.chipAnnotator.shotBoundaryVisible === false,
      null,
      { timeout: 30000 }
    );

    const readShotBoundaryPixels = async () => page.evaluate(() => {
      const annotator = window.viewer?.chipAnnotator;
      annotator?.render();
      const overlay = window.viewer?.dom?.overlayCanvas;
      const pixels = overlay?.width && overlay?.height
        ? overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data
        : null;
      let shotBoundaryPixels = 0;
      if (pixels) {
        for (let index = 0; index < pixels.length; index += 4) {
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          if (red > 100 && blue > 120 && red > green * 1.2 && blue > green * 1.2) {
            shotBoundaryPixels += 1;
          }
        }
      }
      return {
        visible: annotator?.shotBoundaryVisible === true,
        shotBoundaryPixels,
      };
    });

    const boundaryBefore = await readShotBoundaryPixels();
    await page.locator('#single-shot-boundary-btn').click();
    await page.waitForFunction(
      () => window.viewer?.chipAnnotator?.shotBoundaryVisible === true,
      null,
      { timeout: 10000 }
    );
    const boundaryOn = await readShotBoundaryPixels();
    await page.locator('#single-shot-boundary-btn').click();
    await page.waitForFunction(
      () => window.viewer?.chipAnnotator?.shotBoundaryVisible === false,
      null,
      { timeout: 10000 }
    );
    const boundaryAfter = await readShotBoundaryPixels();

    const data = await page.evaluate(({ boundaryBefore, boundaryOn, boundaryAfter }) => {
      const v = window.viewer;
      const chip = (v.chipAnnotator?.chips || []).find((item) =>
        Number(item?.x_abs) === 10 && Number(item?.y_abs) === 0
      );
      v.chipAnnotator?._updateCoordinateBox(0, 0, chip || null);
      const shotBoundaryGroups = Array.from(v.chipAnnotator?.shotBoundaryGroups?.entries?.() || [])
        .map(([shotId, group]) => ({
          shotId,
          chipCount: group.chips.length,
          rect: v.chipAnnotator?._getShotBoundaryRect(group),
          firstChipRect: group.chips[0]?.rect || null,
        }));
      const singleChipBoundary = shotBoundaryGroups.find((group) => group.chipCount === 1);
      const edgeBoundaryMatchesActual = Boolean(
        singleChipBoundary?.rect && singleChipBoundary?.firstChipRect &&
        Math.abs(singleChipBoundary.rect.minX - singleChipBoundary.firstChipRect.x0) < 1e-6 &&
        Math.abs(singleChipBoundary.rect.minY - singleChipBoundary.firstChipRect.y0) < 1e-6 &&
        Math.abs(singleChipBoundary.rect.maxX - singleChipBoundary.firstChipRect.x1) < 1e-6 &&
        Math.abs(singleChipBoundary.rect.maxY - singleChipBoundary.firstChipRect.y1) < 1e-6
      );
      const layoutRequest = performance.getEntriesByType('resource').some((entry) => {
        try {
          const url = new URL(entry.name, location.href);
          return url.pathname === '/api/layout' && url.searchParams.get('process_id') === 'P001';
        } catch (_) {
          return false;
        }
      });
      return {
        path: v.selectedImagePath,
        processId: v.chipAnnotator?.layoutProcessId || null,
        layoutRows: v.chipAnnotator?.layoutByEdsChip?.size || 0,
        shotBoundaryGroupCount: shotBoundaryGroups.length,
        shotBoundaryChipCount: shotBoundaryGroups.reduce((sum, group) => sum + group.chipCount, 0),
        partialShotCount: shotBoundaryGroups.filter((group) => group.chipCount < 24).length,
        edgeBoundaryMatchesActual,
        shotBoundaryPixelsBefore: boundaryBefore.shotBoundaryPixels,
        shotBoundaryPixels: boundaryOn.shotBoundaryPixels,
        shotBoundaryPixelsAfter: boundaryAfter.shotBoundaryPixels,
        shotBoundaryVisibleBefore: boundaryBefore.visible,
        shotBoundaryVisibleOn: boundaryOn.visible,
        shotBoundaryVisibleAfter: boundaryAfter.visible,
        chip: chip ? { x_abs: chip.x_abs, y_abs: chip.y_abs } : null,
        coord: document.getElementById('coord-chip-coord')?.textContent || '',
        rel: document.getElementById('coord-chip-rel')?.textContent || '',
        radious: document.getElementById('coord-radious')?.textContent || '',
        shot: document.getElementById('coord-shot')?.textContent || '',
        oldAbsElement: !!document.getElementById('coord-chip-abs'),
        layoutRequest,
      };
    }, { boundaryBefore, boundaryOn, boundaryAfter });

    expect(data.path.endsWith(`${folder}/${targetFile}`), `path=${data.path}`);
    expect(data.processId === 'P001' && data.layoutRows === 833, `layout=${JSON.stringify(data)}`);
    expect(data.shotBoundaryGroupCount === 43 && data.shotBoundaryChipCount === 833,
      `shot boundaries=${JSON.stringify(data)}`);
    expect(data.partialShotCount > 0 && data.edgeBoundaryMatchesActual,
      `edge shot boundary should use actual chip extents=${JSON.stringify(data)}`);
    expect(!data.shotBoundaryVisibleBefore && data.shotBoundaryVisibleOn && !data.shotBoundaryVisibleAfter,
      `shot toggle=${JSON.stringify(data)}`);
    expect(data.shotBoundaryPixelsBefore < 10 && data.shotBoundaryPixels > 50 && data.shotBoundaryPixelsAfter < 10,
      `shot boundary pixels=${JSON.stringify(data)}`);

    const shotSelectionTarget = await page.evaluate(() => {
      const v = window.viewer;
      const annotator = v.chipAnnotator;
      const group = Array.from(annotator?.shotBoundaryGroups?.values?.() || [])
        .find((candidate) => candidate.chips.length >= 20);
      const chip = group?.chips?.[0];
      const canvas = annotator?.canvas;
      const box = canvas?.getBoundingClientRect?.();
      const transform = v.transform;
      if (!group || !chip || !canvas || !box || !transform) return null;
      const canvasX = ((chip.rect.x0 + chip.rect.x1) / 2) * transform.scale + transform.dx;
      const canvasY = ((chip.rect.y0 + chip.rect.y1) / 2) * transform.scale + transform.dy + (annotator.Y_OFFSET || 0);
      return {
        shotId: group.shotId,
        expectedChipCount: group.indices?.length || group.chips.length,
        chipKey: `${chip.x_abs}:${chip.y_abs}`,
        boundary: annotator._getShotBoundaryRect(group),
        x: box.left + (canvasX / canvas.width) * box.width,
        y: box.top + (canvasY / canvas.height) * box.height,
      };
    });
    expect(!!shotSelectionTarget, 'shot selection target missing');
    await page.mouse.click(shotSelectionTarget.x, shotSelectionTarget.y, { button: 'right' });
    await page.waitForFunction(
      () => !!document.querySelector('#chip-context-menu #chip-selection-mode-shot'),
      null,
      { timeout: 10000 }
    );
    const shotMenuText = await page.locator('#chip-context-menu').innerText();
    await page.locator('#chip-context-menu #chip-selection-mode-shot').click();
    await page.waitForFunction(
      () => window.viewer?.chipAnnotator?.selectionMode === 'shot',
      null,
      { timeout: 10000 }
    );

    const shotInteriorBefore = await page.evaluate((target) => {
      const annotator = window.viewer?.chipAnnotator;
      const canvas = annotator?.canvas;
      const transform = window.viewer?.transform;
      const boundary = target?.boundary;
      if (!canvas || !transform || !boundary) return null;
      const x = Math.round(((boundary.minX + boundary.maxX) / 2) * transform.scale + transform.dx);
      const y = Math.round(((boundary.minY + boundary.maxY) / 2) * transform.scale + transform.dy + (annotator.Y_OFFSET || 0));
      const pixel = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      return { x, y, pixel: Array.from(pixel) };
    }, shotSelectionTarget);
    await page.mouse.move(shotSelectionTarget.x, shotSelectionTarget.y);
    await page.waitForFunction(
      (expectedChipKey) => {
        const annotator = window.viewer?.chipAnnotator;
        const chip = annotator?.hoveredChip;
        return chip && `${chip.x_abs}:${chip.y_abs}` === expectedChipKey;
      },
      shotSelectionTarget.chipKey,
      { timeout: 10000 }
    );
    const shotHover = await page.evaluate(() => {
      const annotator = window.viewer.chipAnnotator;
      const group = annotator._getShotGroupForChip(annotator.hoveredChip);
      return {
        hoverSelectionCount: annotator._getSelectionIndicesForChip(annotator.hoveredChip).length,
        hoverBoundary: annotator._getShotBoundaryRect(group),
        hoverMode: annotator.selectionMode,
        selectedColor: annotator.selectedColor,
        previewColor: annotator.selectionPreviewColor,
        hoverColor: annotator.hoverColor,
      };
    });
    expect(shotHover.hoverMode === 'shot' &&
      shotHover.hoverSelectionCount === shotSelectionTarget.expectedChipCount &&
      shotHover.hoverBoundary?.width > 0 && shotHover.hoverBoundary?.height > 0,
      `shot hover=${JSON.stringify({ shotSelectionTarget, shotHover })}`);
    const shotInteriorAfter = await page.evaluate((probe) => {
      if (!probe) return null;
      const canvas = window.viewer?.chipAnnotator?.canvas;
      if (!canvas) return null;
      const pixel = canvas.getContext('2d').getImageData(probe.x, probe.y, 1, 1).data;
      return Array.from(pixel);
    }, shotInteriorBefore);
    expect(shotInteriorBefore?.pixel?.join(',') === shotInteriorAfter?.join(','),
      `shot interior was filled=${JSON.stringify({ shotInteriorBefore, shotInteriorAfter })}`);
    expect(![shotHover.selectedColor, shotHover.previewColor, shotHover.hoverColor]
      .some((color) => String(color).includes('255, 255, 0')),
    `selection colors must not be yellow=${JSON.stringify(shotHover)}`);
    expect(shotHover.selectedColor === shotHover.hoverColor,
      `selected/hover colors differ=${JSON.stringify(shotHover)}`);
    expect(shotHover.selectedColor === 'rgba(238, 238, 238, 0.55)',
      `selection highlight is too opaque=${JSON.stringify(shotHover)}`);

    await page.mouse.click(shotSelectionTarget.x, shotSelectionTarget.y);
    await page.waitForTimeout(100);
    const plainClickSelection = await page.evaluate(() => ({
      selectedCount: window.viewer?.chipAnnotator?.selectedChips?.size || 0,
      selectedOrderCount: window.viewer?.chipAnnotator?.selectedChipsOrder?.length || 0,
    }));
    expect(plainClickSelection.selectedCount === 0 && plainClickSelection.selectedOrderCount === 0,
      `plain click changed selection=${JSON.stringify(plainClickSelection)}`);

    await page.keyboard.down('Control');
    try {
      await page.mouse.click(shotSelectionTarget.x, shotSelectionTarget.y);
    } finally {
      await page.keyboard.up('Control');
    }
    await page.waitForFunction(
      (expectedCount) => window.viewer?.chipAnnotator?.selectedChips?.size === expectedCount,
      shotSelectionTarget.expectedChipCount,
      { timeout: 10000 }
    );
    const shotSelection = await page.evaluate(() => {
      const annotator = window.viewer.chipAnnotator;
      const selected = Array.from(annotator.selectedChips);
      const selectedShotIds = new Set(selected.map((index) => {
        const row = annotator.getLayoutRowForChip(annotator.chips[index]);
        return row?.shot_id == null ? null : String(row.shot_id);
      }).filter(Boolean));
      return {
        mode: annotator.selectionMode,
        selectedCount: selected.length,
        selectedShotIds: Array.from(selectedShotIds),
      };
    });
    expect(shotMenuText.includes('Shot 선택') && shotSelection.mode === 'shot',
      `shot menu/mode=${JSON.stringify({ shotMenuText, shotSelection })}`);
    expect(shotSelection.selectedCount === shotSelectionTarget.expectedChipCount &&
      shotSelection.selectedShotIds.length === 1 &&
      shotSelection.selectedShotIds[0] === shotSelectionTarget.shotId,
      `shot selection=${JSON.stringify({ shotSelectionTarget, shotSelection })}`);

    await page.mouse.click(shotSelectionTarget.x, shotSelectionTarget.y);
    await page.waitForFunction(
      () => window.viewer?.chipAnnotator?.selectedChips?.size === 0 &&
        window.viewer.chipAnnotator.selectedChipsOrder?.length === 0,
      null,
      { timeout: 10000 }
    );
    const plainClickClearSelection = await page.evaluate(() => ({
      selectedCount: window.viewer?.chipAnnotator?.selectedChips?.size || 0,
      selectedOrderCount: window.viewer?.chipAnnotator?.selectedChipsOrder?.length || 0,
    }));
    expect(plainClickClearSelection.selectedCount === 0 && plainClickClearSelection.selectedOrderCount === 0,
      `plain click did not clear selection=${JSON.stringify(plainClickClearSelection)}`);

    await page.mouse.click(shotSelectionTarget.x, shotSelectionTarget.y, { button: 'right' });
    await page.waitForFunction(
      () => !!document.querySelector('#chip-context-menu #chip-selection-mode-chip'),
      null,
      { timeout: 10000 }
    );
    await page.locator('#chip-context-menu #chip-selection-mode-chip').click();
    await page.waitForFunction(
      () => window.viewer?.chipAnnotator?.selectionMode === 'chip' &&
        window.viewer.chipAnnotator.selectedChips?.size === 0,
      null,
      { timeout: 10000 }
    );
    const chipModeAfter = await page.evaluate(() => ({
      mode: window.viewer?.chipAnnotator?.selectionMode || null,
      selectedCount: window.viewer?.chipAnnotator?.selectedChips?.size || 0,
    }));
    expect(data.chip?.x_abs === 10 && data.chip?.y_abs === 0, `chip=${JSON.stringify(data.chip)}`);
    expect(data.coord === '(-27.50, 77.50)', `coord=${data.coord}`);
    expect(data.rel === '(-5, -16)', `rel=${data.rel}`);
    expect(data.radious === '82.23', `radious=${data.radious}`);
    expect(data.shot === '(-2, 3)', `shot=${data.shot}`);
    expect(!data.oldAbsElement && data.layoutRequest, `layout display/request=${JSON.stringify(data)}`);
    return {
      ...data,
      shotSelectionTarget,
      shotMenuText,
      shotHover,
      shotInteriorBefore,
      shotInteriorAfter,
      plainClickSelection,
      shotSelection,
      plainClickClearSelection,
      chipModeAfter,
    };
  });

  await record('36,37,38,40', '성능 / 이미지 무결성 / 인덱스', async () => {
    await boot('chunk2-perf');
    const t0 = Date.now();
    await loadFolder('unknown');
    const loadMs = Date.now() - t0;
    const data = await page.evaluate(async () => {
      const wrapper = document.querySelector('.grid-scroll-wrapper');
      const wrapperRect = wrapper?.getBoundingClientRect();
      const imgs = Array.from(document.querySelectorAll('#image-grid img'))
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          const style = getComputedStyle(img);
          const viewport = wrapperRect || {
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
            left: 0,
          };
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom &&
            rect.right > viewport.left &&
            rect.left < viewport.right
          );
        })
        .slice(0, 40);
      const status = await fetch('/api/index-status', { cache: 'no-store' }).then((r) => r.json());
      return {
        broken: imgs.filter((img) => !img.complete || img.naturalWidth === 0).length,
        visibleImages: imgs.length,
        loadedVisible: imgs.filter((img) => img.complete && img.naturalWidth > 0).length,
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
