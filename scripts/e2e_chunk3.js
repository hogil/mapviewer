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

  const imagesRoot = path.resolve(
    process.env.IMAGES_ROOT || (process.platform === 'win32' ? 'D:/project/data/wm-811k' : '/appdata/appuser/images')
  );
  const compositeInputCacheDir = path.join(imagesRoot, 'composite_cache_v1');
  const COMPOSITE_E2E_TIMEOUT_MS = 90000;

  function removeCompositeInputCacheDir() {
    fs.rmSync(compositeInputCacheDir, { recursive: true, force: true });
  }

  function getCompositeInputCacheState() {
    const exists = fs.existsSync(compositeInputCacheDir);
    return {
      path: compositeInputCacheDir,
      exists,
      entries: exists ? fs.readdirSync(compositeInputCacheDir).slice(0, 12) : [],
    };
  }

  function resolveImageRootPath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return path.join(imagesRoot, ...normalized.split('/').filter(Boolean));
  }

  function getSquareMapsDataState(outputDir) {
    const dir = resolveImageRootPath(outputDir);
    const squareMapsDataPath = path.join(dir, 'square_maps_data.npz');
    const exists = fs.existsSync(squareMapsDataPath);
    return {
      outputDir,
      dir,
      squareMapsDataPath,
      exists,
      size: exists ? fs.statSync(squareMapsDataPath).size : 0,
      files: fs.existsSync(dir) ? fs.readdirSync(dir).slice(0, 24) : [],
    };
  }

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

  async function getPrimaryLabelClass() {
    return await page.evaluate(async () => {
      const readDomClasses = () =>
        Array.from(document.querySelectorAll('.label-explorer-frame li > div'))
          .map((el) => (el.textContent || '').replace(/[▸▾]/g, '').trim())
          .filter(Boolean)
          .filter((value, index, arr) => arr.indexOf(value) === index);

      const pickClass = (classes) => {
        if (!Array.isArray(classes) || classes.length === 0) return null;
        return classes.includes('test') ? 'test' : classes[0];
      };

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const domClass = pickClass(readDomClasses());
        if (domClass) return domClass;

        try {
          const classes = await window.viewer?.getClassList?.(true);
          const className = pickClass(classes);
          if (className) {
            await window.viewer?.refreshLabelExplorer?.();
            return className;
          }
        } catch (_) {
        }

        try {
          const response = await fetch('/api/classes?mode=wafer', { cache: 'no-store' });
          const data = await response.json();
          const className = pickClass(data?.classes);
          if (className) return className;
        } catch (_) {
        }

        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return null;
    });
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

  async function selectWaferExplorerFolder(folder) {
    append(`[SELECT_WAFER_FOLDER] ${folder}\n`);
    const folderSelector = `#file-explorer summary.folder[data-path="${folder.replace(/"/g, '\\"')}"]`;
    await page.waitForSelector(folderSelector, { timeout: 30000 });
    await page.locator(folderSelector).click({ modifiers: ['Control'] });
    await page.waitForFunction(
      (folderName) => {
        const v = window.viewer;
        const selectedSummary = Array.from(document.querySelectorAll('#file-explorer summary.folder.selected'))
          .some((summary) => summary.dataset.path === folderName);
        return (
          v.selectedFolders?.has(folderName) &&
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
    const state = await page.evaluate((folderName) => {
      const v = window.viewer;
      return {
        folder: folderName,
        selectedFolders: [...(v.selectedFolders || [])],
        selectedImagesLen: v.selectedImages?.length || 0,
        currentGridImagesLen: v.currentGridImages?.length || 0,
        selectedFolderPaths: Array.from(document.querySelectorAll('#file-explorer summary.folder.selected'))
          .map((summary) => summary.dataset.path),
        gridMode: !!v.gridMode,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      };
    }, folder);
    append(`[SELECT_WAFER_FOLDER_OK] ${folder} :: ${JSON.stringify(state)}\n`);
    return state;
  }

  async function setSelection(indices) {
    await page.evaluate((idxs) => {
      const v = window.viewer;
      v.gridSelectedIdxs = [...idxs];
      v.gridSelectedSet = new Set(idxs);
      if (Array.isArray(v.currentGridImages) && v.currentGridImages.length > 0) {
        v.selectedImages = [...v.currentGridImages];
      }
      v.updateGridSelection?.();
      v.flushGridSelectionUpdates?.();
    }, indices);
    await sleep(300);
  }

  function isCompositeDoneToast(text) {
    return /Composite Map 생성 완료 \([^)]*\d+images(?: [^)]+)?\)/.test(text || '');
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

  function normalizePathForCompare(value) {
    return String(value || '').replace(/\\/g, '/');
  }

  async function getTabVisualState(label = '') {
    return await page.evaluate((stateLabel) => {
      const v = window.viewer;
      const grid = document.getElementById('image-grid');
      const scrollWrapper = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement || null;
      const canvas = document.getElementById('image-canvas');
      const overlay = document.getElementById('overlay-canvas');
      const gridStyle = grid ? getComputedStyle(grid) : null;
      const wrapperStyle = scrollWrapper ? getComputedStyle(scrollWrapper) : null;
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      const gridActuallyVisible =
        !!grid &&
        !!scrollWrapper &&
        gridStyle?.display !== 'none' &&
        wrapperStyle?.display !== 'none' &&
        grid.getBoundingClientRect().width > 0 &&
        scrollWrapper.getBoundingClientRect().height > 0;
      const visibleGridWraps = gridActuallyVisible
        ? Array.from(grid.querySelectorAll('.grid-thumb-wrap')).filter((wrap) => {
            const rect = wrap.getBoundingClientRect();
            const style = getComputedStyle(wrap);
            return style.display !== 'none' && rect.width > 0 && rect.height > 0;
          }).length
        : 0;
      const activePage = v.pageManager?.getActivePage?.() || null;
      return {
        label: stateLabel,
        activePageId: v.pageManager?.activePageId || null,
        activeTitle: activePage?.title || null,
        role: activePage?.role || null,
        pages: (v.pageManager?.pages || []).map((p) => ({
          id: p.id,
          title: p.title,
          role: p.role,
          hasState: !!p.state,
          stateViewMode: p.state?.viewMode || null,
          stateGridMode: !!p.state?.gridMode,
        })),
        gridMode: !!v.gridMode,
        viewMode: v.viewMode || null,
        singleImageFromGrid: !!v.singleImageFromGrid,
        selectedImagePath: v.selectedImagePath || null,
        currentGridImagesLen: v.currentGridImages?.length || 0,
        selectedImagesLen: v.selectedImages?.length || 0,
        gridSelectedIdxs: [...(v.gridSelectedIdxs || [])],
        selectedFolders: [...(v.selectedFolders || [])],
        waferSelectedFolderPaths: Array.from(document.querySelectorAll('#file-explorer summary.folder.selected'))
          .map((summary) => summary.dataset.path),
        scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0,
        maxScrollTop: scrollWrapper
          ? Math.max(0, scrollWrapper.scrollHeight - scrollWrapper.clientHeight)
          : 0,
        gridDisplay: gridStyle?.display || null,
        wrapperDisplay: wrapperStyle?.display || null,
        canvasDisplay: canvasStyle?.display || null,
        canvasVisible:
          !!canvas &&
          canvasStyle?.display !== 'none' &&
          canvas.getBoundingClientRect().width > 0 &&
          canvas.getBoundingClientRect().height > 0,
        overlayDisplay: overlay ? getComputedStyle(overlay).display : null,
        visibleGridWraps,
        totalGridWraps: grid?.querySelectorAll('.grid-thumb-wrap').length || 0,
        labelSelected: [...(v.labelSelection?.selected || [])],
        labelSelectedClasses: [...(v.labelSelection?.selectedClasses || [])],
        overlayMode: v.overlayMode || null,
        measureCheckedItems: Array.isArray(v._measureCheckedItems)
          ? v._measureCheckedItems.map((item) => ({
              type: item?.type || null,
              key: item?.key ?? null,
              label: item?.label || null,
            }))
          : [],
      };
    }, label);
  }

  async function activatePageById(pageId, waitFor = 'any') {
    await page.evaluate((id) => {
      window.viewer.pageManager.activatePage(id);
    }, pageId);
    if (waitFor === 'grid') {
      await page.waitForFunction(
        (id) => {
          const v = window.viewer;
          const grid = document.getElementById('image-grid');
          const sw = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement;
          return (
            v.pageManager?.activePageId === id &&
            v.gridMode === true &&
            !!grid &&
            !!sw &&
            getComputedStyle(grid).display !== 'none' &&
            getComputedStyle(sw).display !== 'none' &&
            document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0
          );
        },
        pageId,
        { timeout: 30000 }
      );
    } else if (waitFor === 'single') {
      await page.waitForFunction(
        (id) => {
          const v = window.viewer;
          const canvas = document.getElementById('image-canvas');
          return (
            v.pageManager?.activePageId === id &&
            v.gridMode === false &&
            !!v.selectedImagePath &&
            !!canvas &&
            getComputedStyle(canvas).display !== 'none'
          );
        },
        pageId,
        { timeout: 30000 }
      );
    } else {
      await page.waitForFunction(
        (id) => window.viewer.pageManager?.activePageId === id,
        pageId,
        { timeout: 30000 }
      );
    }
    await sleep(900);
  }

  function expectGridPreserved(state, expected = {}) {
    expect(state.gridMode === true, `${state.label} gridMode=${state.gridMode}`);
    expect(state.visibleGridWraps > 0, `${state.label} visibleGridWraps=${state.visibleGridWraps}, display=${state.gridDisplay}/${state.wrapperDisplay}`);
    expect(state.canvasVisible === false, `${state.label} canvas visible in grid=${JSON.stringify(state)}`);
    if (expected.selectedIdxs) {
      expect(
        JSON.stringify(state.gridSelectedIdxs) === JSON.stringify(expected.selectedIdxs),
        `${state.label} selectedIdxs=${JSON.stringify(state.gridSelectedIdxs)} expected=${JSON.stringify(expected.selectedIdxs)}`
      );
    }
    if (expected.scrollTopMin && state.maxScrollTop > 0) {
      expect(state.scrollTop >= expected.scrollTopMin, `${state.label} scrollTop=${state.scrollTop}`);
    }
    if (expected.labelClass) {
      expect(
        state.labelSelectedClasses.includes(expected.labelClass),
        `${state.label} labelSelectedClasses=${JSON.stringify(state.labelSelectedClasses)}`
      );
    }
  }

  function expectSinglePreserved(state, expected = {}) {
    expect(state.gridMode === false, `${state.label} gridMode=${state.gridMode}`);
    expect(
      state.viewMode === 'gridImage' || state.viewMode === 'single',
      `${state.label} viewMode=${state.viewMode}`
    );
    expect(state.canvasVisible === true, `${state.label} canvas hidden=${JSON.stringify(state)}`);
    expect(
      state.visibleGridWraps === 0,
      `${state.label} grid leaked into single view=${JSON.stringify({
        visibleGridWraps: state.visibleGridWraps,
        totalGridWraps: state.totalGridWraps,
        gridDisplay: state.gridDisplay,
        wrapperDisplay: state.wrapperDisplay,
      })}`
    );
    if (expected.path) {
      expect(
        normalizePathForCompare(state.selectedImagePath) === normalizePathForCompare(expected.path),
        `${state.label} selectedImagePath=${state.selectedImagePath} expected=${expected.path}`
      );
    }
  }

  async function getVisibleGridThumbSummary() {
    return await page.evaluate(() => {
      const PLACEHOLDER =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const grid = document.getElementById('image-grid');
      const scrollWrapper = grid?.parentElement;
      if (!grid || !scrollWrapper) {
        return {
          visibleCount: 0,
          loadedCount: 0,
          badCount: 0,
          lotHeaders: 0,
          lotMode: false,
          gridCols: 0,
          role: null,
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
              isLoaded: false,
              reason: 'no-img',
            };
          }
          const src = img.currentSrc || img.src || '';
          return {
            idx,
            isLoaded:
              img.complete &&
              img.naturalWidth > 0 &&
              img.dataset.gridLoaded === 'true' &&
              !src.startsWith(PLACEHOLDER),
            loading: img.dataset.thumbLoading || 'false',
            gridLoaded: img.dataset.gridLoaded || 'false',
          };
        })
        .filter(Boolean);

      const loadedCount = visibleThumbs.filter((item) => item.isLoaded).length;
      const bad = visibleThumbs.filter((item) => !item.isLoaded);
      return {
        visibleCount: visibleThumbs.length,
        loadedCount,
        badCount: bad.length,
        lotHeaders: document.querySelectorAll('#image-grid .lot-header').length,
        lotMode: !!window.viewer.lotMode,
        gridCols: window.viewer.gridCols,
        role: window.viewer.pageManager?.getActivePage()?.role || null,
        bad: bad.slice(0, 8),
      };
    });
  }

  async function getGridLayoutMetrics() {
    return await page.evaluate(() => {
      const grid = document.getElementById('image-grid');
      const wraps = Array.from(grid?.querySelectorAll('.grid-thumb-wrap') || []);
      const rects = wraps.slice(0, 12).map((wrap, idx) => {
        const rect = wrap.getBoundingClientRect();
        return {
          idx,
          top: rect.top,
          width: rect.width,
        };
      });
      const firstTop = rects[0]?.top ?? null;
      return {
        template: grid ? getComputedStyle(grid).gridTemplateColumns : '',
        firstRowCount:
          firstTop === null
            ? 0
            : rects.filter((rect) => Math.abs(rect.top - firstTop) < 2).length,
        firstCellWidth: rects[0]?.width || 0,
      };
    });
  }

  async function scrollGridToRatio(ratio) {
    await page.evaluate(async (value) => {
      const grid = document.querySelector('#image-grid');
      const scrollWrapper = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement;
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
      const scrollWrapper = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement;
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
    await sleep(1800);
  }

  async function adjustGridColsByCtrlWheel(deltaY = -120) {
    await page.locator('#image-grid').dispatchEvent('wheel', { deltaY, ctrlKey: true });
    await sleep(350);
    return await page.evaluate(() => ({
      gridCols: window.viewer.gridCols,
      range: document.getElementById('grid-cols-range')?.value || null,
      input: document.getElementById('grid-cols-input')?.value || null,
    }));
  }

  async function nudgeGridCols() {
    const before = await page.evaluate(() => window.viewer.gridCols);
    const beforeLayout = await getGridLayoutMetrics();
    const after = await adjustGridColsByCtrlWheel(before >= 10 ? 120 : -120);
    await sleep(900);
    const afterLayout = await getGridLayoutMetrics();
    return { before, after, beforeLayout, afterLayout };
  }

  async function getMeasureGridSignature(limit = 8) {
    return await page.evaluate((maxCount) => ({
      overlayMode: window.viewer.overlayMode,
      checkedItems: Array.isArray(window.viewer._measureCheckedItems)
        ? window.viewer._measureCheckedItems.map((item) => ({
            type: item?.type || null,
            key: item?.key ?? null,
            label: item?.label || null,
          }))
        : [],
      mapLen: Array.isArray(window.viewer._gridMeasureMap)
        ? window.viewer._gridMeasureMap.length
        : 0,
      currentLen: Array.isArray(window.viewer.currentGridImages)
        ? window.viewer.currentGridImages.length
        : 0,
      thumbs: Array.from(
        document.querySelectorAll('#image-grid .grid-thumb-wrap')
      )
        .slice(0, maxCount)
        .map((wrap, idx) => {
          const img = wrap.querySelector('img.grid-thumb-img');
          return {
            idx,
            label: wrap.querySelector('.grid-thumb-label')?.textContent?.trim() || '',
            src: img?.dataset?.src || img?.currentSrc || img?.src || '',
          };
        }),
    }), limit);
  }

  function assertAlternatingMeasureSignature(signature, field = 'f') {
    expect(signature.overlayMode === 'multi', `measure overlay=${signature.overlayMode}`);
    expect(
      signature.mapLen === signature.currentLen,
      `measure map/current mismatch=${signature.mapLen}/${signature.currentLen}`
    );
    expect(signature.thumbs.length >= 4, `measure thumbs=${signature.thumbs.length}`);
    const upperField = field.toUpperCase();
    signature.thumbs.forEach((thumb, idx) => {
      if (idx % 2 === 0) {
        expect(
          thumb.src.includes('/api/thumbnail?'),
          `measure raw src[${idx}]=${thumb.src}`
        );
      } else {
        expect(
          thumb.src.includes('/api/measure-thumb?') &&
            thumb.src.includes(`field=${field}`),
          `measure overlay src[${idx}]=${thumb.src}`
        );
        expect(
          thumb.label.startsWith(upperField),
          `measure overlay label[${idx}]=${thumb.label}`
        );
      }
    });
  }

  async function getLabelExplorerState() {
    return await page.evaluate(() => ({
      selected: [...(window.viewer.labelSelection?.selected || [])],
      selectedClasses: [...(window.viewer.labelSelection?.selectedClasses || [])],
      gridMode: !!window.viewer.gridMode,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      currentGridImages: window.viewer.currentGridImages?.length || 0,
      labelGrid: !!document.getElementById('image-grid')?.hasAttribute('data-label-explorer-grid'),
    }));
  }

  async function clickLabelExplorerBlank(button = 'left') {
    const frame = page.locator('.label-explorer-frame');
    const box = await frame.boundingBox();
    expect(!!box, 'label explorer frame missing');
    const x = Math.floor(box.x + box.width - 30);
    const y = Math.floor(box.y + box.height - 30);
    await page.mouse.click(x, y, { button });
  }

  await boot('chunk3');

  await record('41,42,45,47,48,56', 'Composite / Measure 안정성 / toast / color modal / grid restore', async () => {
    removeCompositeInputCacheDir();
    const compositeInputCacheBefore = getCompositeInputCacheState();

    await loadFolder('filter_test');
    const compositeSourceIdxs = Array.from({ length: 10 }, (_, idx) => idx);
    await setSelection(compositeSourceIdxs);
    const compositePerf = await page.evaluate(async () => {
      const startedAt = performance.now();
      await window.viewer.handleCompositeCreate();
      const elapsedMs = performance.now() - startedAt;
      return {
        elapsedMs,
        elapsedSec: Math.round(elapsedMs / 100) / 10,
        sourceImageCount: window.viewer.compositeSession?.sourceImageCount || null,
        processingTime: window.viewer.compositeSession?.processingTime || null,
        numba: window.viewer.compositeSession?.numba || null,
      };
    });
    await page.waitForFunction(
      () =>
        !!window.viewer.pageManager &&
        window.viewer.pageManager.getActivePage()?.role === 'composite',
      null,
      { timeout: COMPOSITE_E2E_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => window.viewer.currentGridImages?.length > 0,
      null,
      { timeout: COMPOSITE_E2E_TIMEOUT_MS }
    );
    expect(compositePerf.sourceImageCount === 10, `composite source count=${JSON.stringify(compositePerf)}`);
    expect(
      Number(compositePerf.processingTime) > 0 && Number(compositePerf.processingTime) < 10,
      `10-image composite server time too slow=${JSON.stringify(compositePerf)}`
    );
    expect(
      compositePerf.numba?.enabled === true && String(compositePerf.numba?.accumulator || '').includes('numba'),
      `composite numba not active=${JSON.stringify(compositePerf)}`
    );
    const toastSeen = await page.evaluate(() =>
      Array.from(document.body.querySelectorAll('div')).some(
        (el) => /Composite Map 생성 완료 \([^)]*\d+images(?: [^)]+)?\)/.test(el.textContent || '')
      )
    );
    const compositeBefore = await getVisibleGridThumbSummary();
    if (compositeBefore.badCount > 0) {
      await sleep(1200);
    }
    const compositeSettled = await getVisibleGridThumbSummary();
    await roundTripGridImageByDblClick(0);
    const compositeAfter = await getVisibleGridThumbSummary();
    const compositeGridCols = await nudgeGridCols();
    const compositeOutputDir = await page.evaluate(() => window.viewer.compositeSession?.outputDir || null);
    const squareMapsDataBeforeSubset = getSquareMapsDataState(compositeOutputDir);
    const npzOnlySubsetRecolor = await page.evaluate(async () => {
      const outputDir = window.viewer.compositeSession?.outputDir || null;
      const subsetResponse = await fetch('/api/composite-subset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          output_dir: outputDir,
          selected_grades: [1, 2],
        }),
        cache: 'no-store',
      });
      const subsetBody = await subsetResponse.json().catch(async () => ({
        detail: await subsetResponse.text().catch(() => ''),
      }));
      const recolorResponse = await fetch('/api/composite-recolor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output_dir: outputDir }),
        cache: 'no-store',
      });
      const recolorBody = await recolorResponse.json().catch(async () => ({
        detail: await recolorResponse.text().catch(() => ''),
      }));
      return {
        outputDir,
        subsetOk: subsetResponse.ok,
        subsetStatus: subsetResponse.status,
        subsetCount: Array.isArray(subsetBody?.subset_maps) ? subsetBody.subset_maps.length : 0,
        subsetPaths: Array.isArray(subsetBody?.subset_maps)
          ? subsetBody.subset_maps.map((entry) => entry.path)
          : [],
        subsetBody,
        recolorOk: recolorResponse.ok,
        recolorStatus: recolorResponse.status,
        recolorCount: Array.isArray(recolorBody?.sum_maps) ? recolorBody.sum_maps.length : 0,
        recolorPaths: Array.isArray(recolorBody?.sum_maps)
          ? recolorBody.sum_maps.map((entry) => entry.path)
          : [],
        recolorBody,
      };
    });
    const squareMapsDataAfterSubsetRecolor = getSquareMapsDataState(compositeOutputDir);
    const compositeInputCacheAfterSubsetRecolor = getCompositeInputCacheState();

    await boot('chunk3-composite-pending-toast');
    await loadFolder('filter_test');
    await setSelection([0, 1, 2]);
    await page.evaluate(() => {
      const v = window.viewer;
      window.__testToastMessages = [];
      if (!window.__testToastHookInstalled) {
        const originalShowCenteredToast = v.showCenteredToast.bind(v);
        v.showCenteredToast = function patchedShowCenteredToast(message, duration) {
          window.__testToastMessages.push({
            message,
            duration,
            at: Date.now(),
          });
          return originalShowCenteredToast(message, duration);
        };
        window.__testToastHookInstalled = true;
      }
    });
    await page.evaluate(() => {
      window.viewer.handleCompositeCreate();
      return true;
    });
    await page.waitForFunction(
      () => !!window.viewer.pageManager?.pages?.some((p) => p.role === 'composite'),
      null,
      { timeout: COMPOSITE_E2E_TIMEOUT_MS }
    );
    const pendingCompositePages = await page.evaluate(() => {
      const v = window.viewer;
      const compositePage = (v.pageManager?.pages || []).find((p) => p.role === 'composite');
      const originPage = (v.pageManager?.pages || []).find((p) => p.id !== compositePage?.id);
      if (originPage?.id) {
        v.pageManager.activatePage(originPage.id);
      }
      return {
        compositePageId: compositePage?.id || null,
        originPageId: originPage?.id || null,
        activeRole: v.pageManager?.getActivePage?.()?.role || null,
      };
    });
    await page.waitForFunction(
      () => Array.isArray(window.__testToastMessages) && window.__testToastMessages.length >= 1,
      null,
      { timeout: COMPOSITE_E2E_TIMEOUT_MS }
    );
    await sleep(2200);
    const pendingToastBeforeActivate = await page.evaluate(() => ({
      toastCount: window.__testToastMessages?.length || 0,
      firstToast: window.__testToastMessages?.[0]?.message || null,
      activeRole: window.viewer.pageManager?.getActivePage?.()?.role || null,
    }));
    await page.evaluate((pageId) => {
      if (pageId) {
        window.viewer.pageManager.activatePage(pageId);
      }
    }, pendingCompositePages.compositePageId);
    await page.waitForFunction(
      () =>
        !!window.viewer &&
        window.viewer.pageManager?.getActivePage?.()?.role === 'composite' &&
        (window.viewer.currentGridImages?.length || 0) > 0,
      null,
      { timeout: COMPOSITE_E2E_TIMEOUT_MS }
    );
    await sleep(2200);
    const pendingToastAfterActivate = await page.evaluate(() => ({
      toastCount: window.__testToastMessages?.length || 0,
      lastToast: window.__testToastMessages?.[window.__testToastMessages.length - 1]?.message || null,
      activeRole: window.viewer.pageManager?.getActivePage?.()?.role || null,
      gridCount: window.viewer.currentGridImages?.length || 0,
    }));

    await boot('chunk3-composite-origin-restore');
    await loadFolder('filter_test');
    await setSelection([4, 7, 9]);
    const originBeforeComposite = await page.evaluate(() => {
      const v = window.viewer;
      const scrollWrapper = document.querySelector('#image-grid')?.parentElement;
      if (scrollWrapper) {
        const targetScroll = Math.min(900, Math.max(0, scrollWrapper.scrollHeight - scrollWrapper.clientHeight));
        scrollWrapper.scrollTop = targetScroll;
      }
      return {
        originPageId: v.pageManager?.activePageId || null,
        selectedIdxs: [...(v.gridSelectedIdxs || [])],
        selectedIdxsLen: v.gridSelectedIdxs?.length || 0,
        currentGridImagesLen: v.currentGridImages?.length || 0,
        scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0,
        maxScrollTop: scrollWrapper ? Math.max(0, scrollWrapper.scrollHeight - scrollWrapper.clientHeight) : 0,
      };
    });
    await page.evaluate(() => window.viewer.handleCompositeCreate());
    await page.waitForFunction(
      () =>
        !!window.viewer.pageManager &&
        window.viewer.pageManager.getActivePage?.()?.role === 'composite' &&
        (window.viewer.currentGridImages?.length || 0) > 0,
      null,
      { timeout: COMPOSITE_E2E_TIMEOUT_MS }
    );
    const originAfterCompositeReturn = await page.evaluate(async (before) => {
      const v = window.viewer;
      const compositePageId = v.pageManager?.activePageId || null;
      const originPage = (v.pageManager?.pages || []).find((p) => p.id === before.originPageId) ||
        (v.pageManager?.pages || []).find((p) => p.id !== compositePageId && p.role !== 'composite');
      if (originPage?.id) {
        v.pageManager.activatePage(originPage.id);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      const scrollWrapper = document.querySelector('#image-grid')?.parentElement;
      return {
        activePageId: v.pageManager?.activePageId || null,
        activeRole: v.pageManager?.getActivePage?.()?.role || null,
        originPageId: originPage?.id || null,
        selectedIdxs: [...(v.gridSelectedIdxs || [])],
        selectedIdxsLen: v.gridSelectedIdxs?.length || 0,
        selectedWraps: document.querySelectorAll('#image-grid .grid-thumb-wrap.selected').length,
        currentGridImagesLen: v.currentGridImages?.length || 0,
        scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0,
        selectedFolders: [...(v.selectedFolders || [])],
      };
    }, originBeforeComposite);
    const compositeInputCacheAfter = getCompositeInputCacheState();

    await boot('chunk3-measure');
    await loadFolder('palette_3k');
    const measureSelection = await findCommonMeasureSelection('f', 4, 24);
    await setSelection(measureSelection.indices);
    await page.evaluate(async (payload) => {
      const v = window.viewer;
      v._measureCheckedItems = [
        { type: 'failbit', key: null, label: 'Failbit' },
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
    const measureBefore = await getVisibleGridThumbSummary();
    await page.evaluate(async () => {
      const editor = await window.viewer._getColorEditor();
      editor?.close?.();
    });
    await sleep(400);
    await roundTripGridImageByDblClick(0);
    const measureAfter = await getVisibleGridThumbSummary();
    const measureAfterRoundTripSignature = await getMeasureGridSignature();
    await page.evaluate(async () => {
      const v = window.viewer;
      const measurePageId = v.pageManager?.activePageId || null;
      const originPageId = (v.pageManager?.pages || []).find(
        (pageInfo) => pageInfo.id !== measurePageId
      )?.id || null;
      if (!measurePageId || !originPageId) return;
      v.pageManager.activatePage(originPageId);
      await new Promise((resolve) => setTimeout(resolve, 700));
      v.pageManager.activatePage(measurePageId);
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    const measureAfterTabReturnSignature = await getMeasureGridSignature();
    const measureGridCols = await nudgeGridCols();
    const measureAfterGridColsSignature = await getMeasureGridSignature();
    const data = await page.evaluate((toastSeenValue) => ({
      compositeRole: window.viewer.pageManager?.getActivePage()?.role || null,
      measureRole: window.viewer.pageManager?.pages?.some((p) => p.role === 'measure'),
      gridCount: window.viewer.currentGridImages.length,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      toastSeen: toastSeenValue,
    }), toastSeen);

    await boot('chunk3-grid-detail-selection');
    await loadFolder('palette_3k');
    const gridSelectionRestore = await page.evaluate(async () => {
      const v = window.viewer;
      const firstWrap = document.querySelector('#image-grid .grid-thumb-wrap');
      if (!firstWrap || typeof firstWrap.ondblclick !== 'function') {
        return {
          total: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
          selectedWraps: document.querySelectorAll('#image-grid .grid-thumb-wrap.selected').length,
          selectedIdxsLen: v.gridSelectedIdxs?.length || 0,
          pageRoles: (v.pageManager?.pages || []).map((pageInfo) => pageInfo.role),
        };
      }
      firstWrap.ondblclick(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const detailPageId = v.pageManager?.activePageId || null;
      const originPageId = (v.pageManager?.pages || []).find(
        (pageInfo) => pageInfo.id !== detailPageId
      )?.id || null;
      if (detailPageId && originPageId) {
        v.pageManager.activatePage(originPageId);
        await new Promise((resolve) => setTimeout(resolve, 700));
        v.pageManager.activatePage(detailPageId);
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      v.exitSingleImageViewMode();
      await new Promise((resolve) => setTimeout(resolve, 1300));
      return {
        total: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        selectedWraps: document.querySelectorAll('#image-grid .grid-thumb-wrap.selected').length,
        selectedIdxsLen: v.gridSelectedIdxs?.length || 0,
        selectedIdxsSample: (v.gridSelectedIdxs || []).slice(0, 8),
        pageRoles: (v.pageManager?.pages || []).map((pageInfo) => pageInfo.role),
      };
    });

    const compositeLayoutChanged =
      compositeGridCols.afterLayout.template !== compositeGridCols.beforeLayout.template ||
      compositeGridCols.afterLayout.firstRowCount !== compositeGridCols.beforeLayout.firstRowCount ||
      Math.abs(
        compositeGridCols.afterLayout.firstCellWidth - compositeGridCols.beforeLayout.firstCellWidth
      ) > 1;
    const measureLayoutChanged =
      measureGridCols.afterLayout.template !== measureGridCols.beforeLayout.template ||
      measureGridCols.afterLayout.firstRowCount !== measureGridCols.beforeLayout.firstRowCount ||
      Math.abs(
        measureGridCols.afterLayout.firstCellWidth - measureGridCols.beforeLayout.firstCellWidth
      ) > 1;
    expect(data.gridCount > 0 && data.wraps > 0, `grid=${data.gridCount}/${data.wraps}`);
    expect(data.measureRole === true, 'measure page missing');
    expect(measureColorVisible, 'measure color modal hidden');
    expect(compositeSettled.badCount === 0, `composite settled badCount=${compositeSettled.badCount}`);
    expect(compositeAfter.badCount === 0, `composite after badCount=${compositeAfter.badCount}`);
    expect(compositeGridCols.after.gridCols !== compositeGridCols.before, `composite gridCols ${compositeGridCols.before}->${compositeGridCols.after.gridCols}`);
    expect(compositeLayoutChanged, `composite layout unchanged: ${JSON.stringify(compositeGridCols)}`);
    expect(
      squareMapsDataBeforeSubset.exists && squareMapsDataBeforeSubset.size > 0,
      `square_maps_data missing before subset=${JSON.stringify(squareMapsDataBeforeSubset)}`
    );
    expect(
      npzOnlySubsetRecolor.subsetOk && npzOnlySubsetRecolor.subsetCount >= 2,
      `subset from square_maps_data failed=${JSON.stringify(npzOnlySubsetRecolor)}`
    );
    expect(
      npzOnlySubsetRecolor.recolorOk && npzOnlySubsetRecolor.recolorCount >= 2,
      `recolor from square_maps_data failed=${JSON.stringify(npzOnlySubsetRecolor)}`
    );
    expect(
      squareMapsDataAfterSubsetRecolor.exists && squareMapsDataAfterSubsetRecolor.size > 0,
      `square_maps_data missing after subset/recolor=${JSON.stringify(squareMapsDataAfterSubsetRecolor)}`
    );
    expect(
      compositeInputCacheAfterSubsetRecolor.exists === false,
      `composite input cache created by subset/recolor=${JSON.stringify(compositeInputCacheAfterSubsetRecolor)}`
    );
    expect(pendingCompositePages.originPageId, `pending composite pages=${JSON.stringify(pendingCompositePages)}`);
    expect(
      isCompositeDoneToast(pendingToastBeforeActivate.firstToast || ''),
      `pending first toast=${pendingToastBeforeActivate.firstToast}`
    );
    expect(pendingToastBeforeActivate.toastCount === 1, `pending toast before activate=${JSON.stringify(pendingToastBeforeActivate)}`);
    expect(pendingToastAfterActivate.toastCount === 1, `pending toast after activate=${JSON.stringify(pendingToastAfterActivate)}`);
    expect(pendingToastAfterActivate.gridCount > 0, `pending grid=${JSON.stringify(pendingToastAfterActivate)}`);
    expect(
      JSON.stringify(originAfterCompositeReturn.selectedIdxs) === JSON.stringify(originBeforeComposite.selectedIdxs),
      `origin selection restore=${JSON.stringify({ before: originBeforeComposite, after: originAfterCompositeReturn })}`
    );
    expect(
      originAfterCompositeReturn.selectedIdxsLen === originBeforeComposite.selectedIdxsLen &&
        originAfterCompositeReturn.selectedIdxsLen < originAfterCompositeReturn.currentGridImagesLen,
      `origin selection count=${JSON.stringify({ before: originBeforeComposite, after: originAfterCompositeReturn })}`
    );
    expect(
      originBeforeComposite.maxScrollTop === 0 ||
        Math.abs(originAfterCompositeReturn.scrollTop - originBeforeComposite.scrollTop) <= 4,
      `origin scroll restore=${JSON.stringify({ before: originBeforeComposite, after: originAfterCompositeReturn })}`
    );
    expect(
      compositeInputCacheBefore.exists === false && compositeInputCacheAfter.exists === false,
      `composite input cache recreated=${JSON.stringify({ before: compositeInputCacheBefore, after: compositeInputCacheAfter })}`
    );
    expect(measureBefore.badCount === 0, `measure before badCount=${measureBefore.badCount}`);
    expect(measureAfter.badCount === 0, `measure after badCount=${measureAfter.badCount}`);
    assertAlternatingMeasureSignature(measureAfterRoundTripSignature, 'f');
    assertAlternatingMeasureSignature(measureAfterTabReturnSignature, 'f');
    expect(measureGridCols.after.gridCols !== measureGridCols.before, `measure gridCols ${measureGridCols.before}->${measureGridCols.after.gridCols}`);
    expect(measureLayoutChanged, `measure layout unchanged: ${JSON.stringify(measureGridCols)}`);
    assertAlternatingMeasureSignature(measureAfterGridColsSignature, 'f');
    expect(
      gridSelectionRestore.selectedWraps < gridSelectionRestore.total,
      `grid selection exploded=${JSON.stringify(gridSelectionRestore)}`
    );
    return {
      ...data,
      measureColorVisible,
      compositeBefore,
      compositeSettled,
      compositeGridCols,
      compositeAfter,
      squareMapsDataBeforeSubset,
      npzOnlySubsetRecolor,
      squareMapsDataAfterSubsetRecolor,
      compositeInputCacheAfterSubsetRecolor,
      pendingCompositePages,
      pendingToastBeforeActivate,
      pendingToastAfterActivate,
      originBeforeComposite,
      originAfterCompositeReturn,
      compositeInputCacheBefore,
      compositePerf,
      compositeInputCacheAfter,
      measureBefore,
      measureAfterRoundTripSignature,
      measureAfterTabReturnSignature,
      measureGridCols,
      measureAfterGridColsSignature,
      measureAfter,
      gridSelectionRestore,
    };
  });

  await record('tab-state-preserve', '탭별 grid/single/selection/scroll/explorer 상태 보존', async () => {
    await boot('chunk3-tab-preserve-composite');
    await selectWaferExplorerFolder('palette_3k');
    await page.evaluate(() => window.viewer.applyGridColsChange(3, { maxCols: 20 }));
    await sleep(800);
    await scrollGridToRatio(0.55);
    await sleep(800);
    await setSelection([2, 4, 6]);
    const waferBeforeComposite = await getTabVisualState('wafer-before-composite');
    const waferPageId = waferBeforeComposite.activePageId;
    await page.evaluate(() => window.viewer.handleCompositeCreate());
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'composite' &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) > 0,
      null,
      { timeout: COMPOSITE_E2E_TIMEOUT_MS }
    );
    await sleep(1200);
    const compositeGridBefore = await getTabVisualState('composite-grid-before-detail');
    const compositeGridPageId = compositeGridBefore.activePageId;
    await page.locator('#image-grid .grid-thumb-wrap').first().dblclick();
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'composite' &&
        window.viewer.gridMode === false &&
        window.viewer.viewMode === 'gridImage' &&
        !!window.viewer.selectedImagePath,
      null,
      { timeout: 30000 }
    );
    await sleep(1500);
    const compositeSingleBefore = await getTabVisualState('composite-single-before-switch');
    const compositeSinglePageId = compositeSingleBefore.activePageId;

    await activatePageById(waferPageId, 'grid');
    const waferAfterComposite = await getTabVisualState('wafer-after-composite-switch');
    await activatePageById(compositeGridPageId, 'grid');
    const compositeGridAfter = await getTabVisualState('composite-grid-after-switch');
    await activatePageById(compositeSinglePageId, 'single');
    const compositeSingleAfter = await getTabVisualState('composite-single-after-switch');
    append(`[TAB_STATE] composite preserve ok :: ${JSON.stringify({ waferPageId, compositeGridPageId, compositeSinglePageId })}\n`);

    expectGridPreserved(waferAfterComposite, { selectedIdxs: [2, 4, 6] });
    expect(
      waferAfterComposite.selectedFolders.includes('palette_3k'),
      `wafer selectedFolders lost=${JSON.stringify(waferAfterComposite)}`
    );
    expect(
      waferAfterComposite.waferSelectedFolderPaths.includes('palette_3k'),
      `wafer explorer selected folder UI lost=${JSON.stringify(waferAfterComposite)}`
    );
    expect(
      waferBeforeComposite.maxScrollTop === 0 ||
        Math.abs(waferAfterComposite.scrollTop - waferBeforeComposite.scrollTop) <= 12,
      `wafer scroll not preserved=${JSON.stringify({ before: waferBeforeComposite, after: waferAfterComposite })}`
    );
    expectGridPreserved(compositeGridAfter);
    expectSinglePreserved(compositeSingleAfter, { path: compositeSingleBefore.selectedImagePath });

    await boot('chunk3-tab-preserve-measure');
    await loadFolder('palette_3k');
    const measureSelection = await findCommonMeasureSelection('f', 4, 24);
    await setSelection(measureSelection.indices);
    await page.evaluate(async (payload) => {
      const v = window.viewer;
      v._measureCheckedItems = [
        { type: 'failbit', key: null, label: 'Failbit' },
        payload.item,
      ];
      await v._applyMeasureSelection();
    }, measureSelection);
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'measure' &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) > 0,
      null,
      { timeout: 30000 }
    );
    await sleep(1200);
    await setSelection([1, 3]);
    const measureGridBefore = await getTabVisualState('measure-grid-before-detail');
    const measureGridPageId = measureGridBefore.activePageId;
    await page.locator('#image-grid .grid-thumb-wrap').first().dblclick();
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'measure' &&
        window.viewer.gridMode === false &&
        window.viewer.viewMode === 'gridImage' &&
        !!window.viewer.selectedImagePath,
      null,
      { timeout: 30000 }
    );
    await sleep(1500);
    const measureSingleBefore = await getTabVisualState('measure-single-before-switch');
    const measureSinglePageId = measureSingleBefore.activePageId;
    await activatePageById(measureGridPageId, 'grid');
    const measureGridAfter = await getTabVisualState('measure-grid-after-switch');
    await activatePageById(measureSinglePageId, 'single');
    const measureSingleAfter = await getTabVisualState('measure-single-after-switch');
    append(`[TAB_STATE] measure preserve ok :: ${JSON.stringify({ measureGridPageId, measureSinglePageId })}\n`);
    expectGridPreserved(measureGridAfter, { selectedIdxs: [1, 3] });
    expect(
      measureGridAfter.overlayMode === 'multi' && measureGridAfter.measureCheckedItems.length === 2,
      `measure overlay state lost=${JSON.stringify(measureGridAfter)}`
    );
    expectSinglePreserved(measureSingleAfter, { path: measureSingleBefore.selectedImagePath });

    await boot('chunk3-tab-preserve-label');
    const labelClass = await getPrimaryLabelClass();
    expect(labelClass, 'label class not found');
    await page.evaluate(async (className) => {
      const v = window.viewer;
      await v.showGridFromClass(className);
      v.labelSelection.selectedClasses = [className];
      v.updateLabelExplorerSelection?.();
    }, labelClass);
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'label' &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) > 0,
      null,
      { timeout: 30000 }
    );
    await sleep(1200);
    await setSelection([0, 1]);
    const labelGridBefore = await getTabVisualState('label-grid-before-detail');
    const labelGridPageId = labelGridBefore.activePageId;
    await page.locator('#image-grid .grid-thumb-wrap').first().dblclick();
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'label' &&
        window.viewer.gridMode === false &&
        window.viewer.viewMode === 'gridImage' &&
        !!window.viewer.selectedImagePath,
      null,
      { timeout: 30000 }
    );
    await sleep(1500);
    const labelSingleBefore = await getTabVisualState('label-single-before-switch');
    const labelSinglePageId = labelSingleBefore.activePageId;
    await activatePageById(labelGridPageId, 'grid');
    const labelGridAfter = await getTabVisualState('label-grid-after-switch');
    await activatePageById(labelSinglePageId, 'single');
    const labelSingleAfter = await getTabVisualState('label-single-after-switch');
    append(`[TAB_STATE] label preserve ok :: ${JSON.stringify({ labelClass, labelGridPageId, labelSinglePageId })}\n`);
    expectGridPreserved(labelGridAfter, { selectedIdxs: [0, 1], labelClass });
    expectSinglePreserved(labelSingleAfter, { path: labelSingleBefore.selectedImagePath });

    await boot('chunk3-tab-preserve-mylot');
    await loadFolder('palette_3k');
    await page.evaluate(async () => {
      const v = window.viewer;
      if (!v.lotMode) {
        v.toggleLotMode();
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      const modal = await v._getMyLotModal();
      const sample = v.currentGridImages.slice(0, 12);
      modal.activeMode = 'lot';
      modal.activeGroup = 'tab-preserve-group';
      modal.currentEntries = [
        { value: 'tab-preserve-lot', filename: 'tab-preserve-lot', path: sample[0], all_paths: sample },
      ];
      modal.selectedKeys = new Set(['tab-preserve-lot']);
      await modal.openSelectionInViewer();
    });
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'mylot' &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) > 0,
      null,
      { timeout: 30000 }
    );
    await sleep(1200);
    await setSelection([0, 2]);
    const mylotGridBefore = await getTabVisualState('mylot-grid-before-detail');
    const mylotGridPageId = mylotGridBefore.activePageId;
    await page.locator('#image-grid .grid-thumb-wrap').first().dblclick();
    await page.waitForFunction(
      () =>
        window.viewer.pageManager?.getActivePage?.()?.role === 'mylot' &&
        window.viewer.gridMode === false &&
        window.viewer.viewMode === 'gridImage' &&
        !!window.viewer.selectedImagePath,
      null,
      { timeout: 30000 }
    );
    await sleep(1500);
    const mylotSingleBefore = await getTabVisualState('mylot-single-before-switch');
    const mylotSinglePageId = mylotSingleBefore.activePageId;
    await activatePageById(mylotGridPageId, 'grid');
    const mylotGridAfter = await getTabVisualState('mylot-grid-after-switch');
    await activatePageById(mylotSinglePageId, 'single');
    const mylotSingleAfter = await getTabVisualState('mylot-single-after-switch');
    append(`[TAB_STATE] mylot preserve ok :: ${JSON.stringify({ mylotGridPageId, mylotSinglePageId })}\n`);
    expectGridPreserved(mylotGridAfter, { selectedIdxs: [0, 2] });
    expectSinglePreserved(mylotSingleAfter, { path: mylotSingleBefore.selectedImagePath });

    return {
      waferBeforeComposite,
      waferAfterComposite,
      compositeGridBefore,
      compositeGridAfter,
      compositeSingleBefore,
      compositeSingleAfter,
      measureGridBefore,
      measureGridAfter,
      measureSingleBefore,
      measureSingleAfter,
      labelClass,
      labelGridBefore,
      labelGridAfter,
      labelSingleBefore,
      labelSingleAfter,
      mylotGridBefore,
      mylotGridAfter,
      mylotSingleBefore,
      mylotSingleAfter,
    };
  });

  await record('tab-state-preserve-10-tabs', '10개 탭 cross-role grid/single 상태 격리', async () => {
    async function waitGridRole(role, timeout = 60000) {
      await page.waitForFunction(
        (expectedRole) => {
          const v = window.viewer;
          const grid = document.getElementById('image-grid');
          const sw = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement;
          return (
            v.pageManager?.getActivePage?.()?.role === expectedRole &&
            v.gridMode === true &&
            !!grid &&
            !!sw &&
            getComputedStyle(grid).display !== 'none' &&
            getComputedStyle(sw).display !== 'none' &&
            document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0
          );
        },
        role,
        { timeout }
      );
      await sleep(900);
    }

    async function openGridDetail(role, label, idx = 0) {
      await page.locator('#image-grid .grid-thumb-wrap').nth(idx).dblclick();
      await page.waitForFunction(
        (expectedRole) => {
          const v = window.viewer;
          const canvas = document.getElementById('image-canvas');
          return (
            v.pageManager?.getActivePage?.()?.role === expectedRole &&
            v.gridMode === false &&
            (v.viewMode === 'gridImage' || v.viewMode === 'single') &&
            !!v.selectedImagePath &&
            !!canvas &&
            getComputedStyle(canvas).display !== 'none'
          );
        },
        role,
        { timeout: 30000 }
      );
      await sleep(1200);
      return await getTabVisualState(label);
    }

    await boot('chunk3-tab-preserve-10tabs');
    await selectWaferExplorerFolder('palette_3k');
    await page.evaluate(() => window.viewer.applyGridColsChange(3, { maxCols: 20 }));
    await scrollGridToRatio(0.55);
    await sleep(800);
    await setSelection([2, 4, 6]);
    const waferGridInitial = await getTabVisualState('10tab-wafer-grid-initial');
    const waferGridPageId = waferGridInitial.activePageId;
    const waferSingleBefore = await openGridDetail('wafer', '10tab-wafer-single-before', 0);
    const waferSinglePageId = waferSingleBefore.activePageId;

    await activatePageById(waferGridPageId, 'grid');
    await page.evaluate(() => window.viewer.handleCompositeCreate());
    await waitGridRole('composite', COMPOSITE_E2E_TIMEOUT_MS);
    const compositeGridBefore = await getTabVisualState('10tab-composite-grid-before');
    const compositeGridPageId = compositeGridBefore.activePageId;
    const compositeSingleBefore = await openGridDetail('composite', '10tab-composite-single-before', 0);
    const compositeSinglePageId = compositeSingleBefore.activePageId;

    await activatePageById(waferGridPageId, 'grid');
    const measureSelection = await findCommonMeasureSelection('f', 4, 24);
    await setSelection(measureSelection.indices);
    await page.evaluate(async (payload) => {
      const v = window.viewer;
      v._measureCheckedItems = [
        { type: 'failbit', key: null, label: 'Failbit' },
        payload.item,
      ];
      await v._applyMeasureSelection();
    }, measureSelection);
    await waitGridRole('measure');
    await setSelection([1, 3]);
    const measureGridBefore = await getTabVisualState('10tab-measure-grid-before');
    const measureGridPageId = measureGridBefore.activePageId;
    const measureSingleBefore = await openGridDetail('measure', '10tab-measure-single-before', 0);
    const measureSinglePageId = measureSingleBefore.activePageId;

    const labelClass = await getPrimaryLabelClass();
    expect(labelClass, '10tab label class not found');
    await page.evaluate(async (className) => {
      const v = window.viewer;
      await v.showGridFromClass(className);
      v.labelSelection.selectedClasses = [className];
      v.updateLabelExplorerSelection?.();
    }, labelClass);
    await waitGridRole('label');
    await setSelection([0, 1]);
    const labelGridBefore = await getTabVisualState('10tab-label-grid-before');
    const labelGridPageId = labelGridBefore.activePageId;
    const labelSingleBefore = await openGridDetail('label', '10tab-label-single-before', 0);
    const labelSinglePageId = labelSingleBefore.activePageId;

    await activatePageById(waferGridPageId, 'grid');
    await setSelection([2, 4, 6]);
    await scrollGridToRatio(0.55);
    await sleep(800);
    const waferGridExpected = await getTabVisualState('10tab-wafer-grid-expected');
    await page.evaluate(async () => {
      const v = window.viewer;
      const modal = await v._getMyLotModal();
      const sample = v.currentGridImages.slice(0, 12);
      modal.activeMode = 'lot';
      modal.activeGroup = 'tab-preserve-10tabs-group';
      modal.currentEntries = [
        { value: 'tab-preserve-10tabs-lot', filename: 'tab-preserve-10tabs-lot', path: sample[0], all_paths: sample },
      ];
      modal.selectedKeys = new Set(['tab-preserve-10tabs-lot']);
      await modal.openSelectionInViewer();
    });
    await waitGridRole('mylot');
    await setSelection([0, 2]);
    const mylotGridBefore = await getTabVisualState('10tab-mylot-grid-before');
    const mylotGridPageId = mylotGridBefore.activePageId;
    const mylotSingleBefore = await openGridDetail('mylot', '10tab-mylot-single-before', 0);
    const mylotSinglePageId = mylotSingleBefore.activePageId;

    const tabCountState = await getTabVisualState('10tab-count');
    expect(tabCountState.pages.length === 10, `10tab count=${tabCountState.pages.length}`);

    await activatePageById(waferGridPageId, 'grid');
    const waferGridAfter = await getTabVisualState('10tab-wafer-grid-after');
    await activatePageById(waferSinglePageId, 'single');
    const waferSingleAfter = await getTabVisualState('10tab-wafer-single-after');
    await activatePageById(compositeGridPageId, 'grid');
    const compositeGridAfter = await getTabVisualState('10tab-composite-grid-after');
    await activatePageById(compositeSinglePageId, 'single');
    const compositeSingleAfter = await getTabVisualState('10tab-composite-single-after');
    await activatePageById(measureGridPageId, 'grid');
    const measureGridAfter = await getTabVisualState('10tab-measure-grid-after');
    await activatePageById(measureSinglePageId, 'single');
    const measureSingleAfter = await getTabVisualState('10tab-measure-single-after');
    await activatePageById(labelGridPageId, 'grid');
    const labelGridAfter = await getTabVisualState('10tab-label-grid-after');
    await activatePageById(labelSinglePageId, 'single');
    const labelSingleAfter = await getTabVisualState('10tab-label-single-after');
    await activatePageById(mylotGridPageId, 'grid');
    const mylotGridAfter = await getTabVisualState('10tab-mylot-grid-after');
    await activatePageById(mylotSinglePageId, 'single');
    const mylotSingleAfter = await getTabVisualState('10tab-mylot-single-after');

    expectGridPreserved(waferGridAfter, { selectedIdxs: [2, 4, 6] });
    expect(
      waferGridAfter.selectedFolders.includes('palette_3k') &&
        waferGridAfter.waferSelectedFolderPaths.includes('palette_3k'),
      `10tab wafer explorer selection lost=${JSON.stringify(waferGridAfter)}`
    );
    expect(
      waferGridExpected.maxScrollTop === 0 ||
        Math.abs(waferGridAfter.scrollTop - waferGridExpected.scrollTop) <= 12,
      `10tab wafer scroll changed=${JSON.stringify({ before: waferGridExpected, after: waferGridAfter })}`
    );
    expectSinglePreserved(waferSingleAfter, { path: waferSingleBefore.selectedImagePath });
    expectGridPreserved(compositeGridAfter);
    expectSinglePreserved(compositeSingleAfter, { path: compositeSingleBefore.selectedImagePath });
    expectGridPreserved(measureGridAfter, { selectedIdxs: [1, 3] });
    expect(
      measureGridAfter.overlayMode === 'multi' && measureGridAfter.measureCheckedItems.length === 2,
      `10tab measure overlay lost=${JSON.stringify(measureGridAfter)}`
    );
    expectSinglePreserved(measureSingleAfter, { path: measureSingleBefore.selectedImagePath });
    expectGridPreserved(labelGridAfter, { selectedIdxs: [0, 1], labelClass });
    expectSinglePreserved(labelSingleAfter, { path: labelSingleBefore.selectedImagePath });
    expectGridPreserved(mylotGridAfter, { selectedIdxs: [0, 2] });
    expectSinglePreserved(mylotSingleAfter, { path: mylotSingleBefore.selectedImagePath });

    return {
      tabCount: tabCountState.pages.length,
      wafer: { before: waferGridExpected, after: waferGridAfter, single: waferSingleAfter.selectedImagePath },
      composite: { grid: compositeGridAfter.role, single: compositeSingleAfter.selectedImagePath },
      measure: { selectedIdxs: measureGridAfter.gridSelectedIdxs, overlayMode: measureGridAfter.overlayMode },
      label: { selectedIdxs: labelGridAfter.gridSelectedIdxs, labelClass },
      mylot: { selectedIdxs: mylotGridAfter.gridSelectedIdxs },
    };
  });

  await record('43,44,49,50,57,60', 'Label Explorer / WF search / classification consistency', async () => {
    await boot('chunk3-label');
    const labelData = await page.evaluate(async () => {
      const classNames = Array.from(
        document.querySelectorAll('.label-explorer-frame li > div')
      )
        .map((el) => (el.textContent || '').replace(/[▸▾]/g, '').trim())
        .filter(Boolean);
      const uniqueClasses = Array.from(new Set(classNames));
      const primaryClass = uniqueClasses[0] || null;
      if (!primaryClass) {
        return {
          classes: [],
          primaryClass: null,
          single: { count: 0, wraps: 0 },
          multi: null,
        };
      }

      await window.viewer.showGridFromClass(primaryClass);
      await new Promise((r) => setTimeout(r, 1000));
      const single = {
        count: window.viewer.currentGridImages.length,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      };

      let multi = null;
      if (uniqueClasses.length > 1) {
        await window.viewer.showGridFromMultipleClasses(uniqueClasses.slice(0, 2));
        await new Promise((r) => setTimeout(r, 1200));
        multi = {
          count: window.viewer.currentGridImages.length,
          wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
          classes: uniqueClasses.slice(0, 2),
        };
      }

      return {
        classes: uniqueClasses,
        primaryClass,
        single,
        multi,
      };
    });

    await page.evaluate(async () => {
      if (!window.viewer.lotMode) {
        window.viewer.toggleLotMode();
        await new Promise((r) => setTimeout(r, 1200));
      }
    });
    const labelBefore = await getVisibleGridThumbSummary();
    const labelGridCols = await nudgeGridCols();
    await roundTripGridImageByDblClick(0);
    const labelAfter = await getVisibleGridThumbSummary();

    await page.evaluate(() => window.viewer.openWfSearchModal());
    await sleep(500);
    const wfVisible = await visible('#wf-search-modal');

    await boot('chunk3-label-clear');
    const labelClearTarget = labelData.classes.includes('test')
      ? 'test'
      : labelData.primaryClass;
    const targetFolder = page
      .locator('.label-explorer-frame li > div')
      .filter({ hasText: labelClearTarget })
      .first();
    await targetFolder.click();
    await sleep(600);
    await targetFolder.click({ modifiers: ['Control'] });
    await sleep(1500);
    const labelClearBefore = await getLabelExplorerState();
    await clickLabelExplorerBlank('left');
    await sleep(900);
    const labelAfterLeftBlank = await getLabelExplorerState();
    await clickLabelExplorerBlank('right');
    await sleep(1200);
    const labelAfterRightBlank = await getLabelExplorerState();
    await targetFolder.click({ modifiers: ['Control'] });
    await sleep(1500);
    const labelAfterReselect = await getLabelExplorerState();

    await boot('chunk3-label-scroll-reset');
    await loadFolder('palette_3k');
    await page.evaluate(async () => {
      const v = window.viewer;
      if (!v.lotMode) {
        v.toggleLotMode();
        await new Promise((r) => setTimeout(r, 1200));
      }
    });
    await page.evaluate(() => window.viewer.applyGridColsChange(3, { maxCols: 20 }));
    await sleep(1000);
    await scrollGridToRatio(0.95);
    await sleep(1200);
    const labelScrollTargetIndex = await getMiddleVisibleGridIndex();
    await roundTripGridImageByDblClick(labelScrollTargetIndex);
    await sleep(1200);
    await page.evaluate(async (className) => {
      await window.viewer.showGridFromClass(className);
    }, labelClearTarget);
    await sleep(1800);
    const labelScrollReset = await page.evaluate(() => {
      const scrollWrapper = document.querySelector('#image-grid')?.parentElement;
      return {
        scrollTop: scrollWrapper?.scrollTop || 0,
        maxScrollTop: Math.max(
          0,
          (scrollWrapper?.scrollHeight || 0) - (scrollWrapper?.clientHeight || 0)
        ),
        gridCols: window.viewer.gridCols,
        role: window.viewer.pageManager?.getActivePage()?.role || null,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      };
    });

    expect(labelData.primaryClass, `label classes=${JSON.stringify(labelData.classes)}`);
    expect(labelData.single.count > 0, `label single=${JSON.stringify(labelData.single)}`);
    expect(labelData.single.wraps > 0, `label single wraps=${JSON.stringify(labelData.single)}`);
    if (labelData.multi) {
      expect(labelData.multi.count >= labelData.single.count, `label multi=${JSON.stringify(labelData.multi)}`);
      expect(labelData.multi.wraps > 0, `label multi wraps=${JSON.stringify(labelData.multi)}`);
    }
    expect(labelBefore.role === 'label', `label role=${labelBefore.role}`);
    expect(labelBefore.lotMode === true, `label lotMode=${labelBefore.lotMode}`);
    expect(labelBefore.lotHeaders > 0, `label lotHeaders=${labelBefore.lotHeaders}`);
    expect(labelBefore.badCount === 0, `label before badCount=${labelBefore.badCount}`);
    expect(labelAfter.badCount === 0, `label after badCount=${labelAfter.badCount}`);
    expect(labelAfter.lotHeaders > 0, `label restore lotHeaders=${labelAfter.lotHeaders}`);
    expect(labelGridCols.after.gridCols !== labelGridCols.before, `label gridCols ${labelGridCols.before}->${labelGridCols.after.gridCols}`);
    expect(wfVisible, 'wf modal hidden');
    expect(labelClearBefore.selectedClasses.includes(labelClearTarget), `label clear before=${JSON.stringify(labelClearBefore)}`);
    expect(labelAfterLeftBlank.selectedClasses.includes(labelClearTarget), `left blank cleared selection: ${JSON.stringify(labelAfterLeftBlank)}`);
    expect(labelAfterLeftBlank.wraps > 0, `left blank cleared wraps=${labelAfterLeftBlank.wraps}`);
    expect(labelAfterRightBlank.selectedClasses.length === 0, `right blank did not clear: ${JSON.stringify(labelAfterRightBlank)}`);
    expect(labelAfterReselect.selectedClasses.includes(labelClearTarget), `reselect failed: ${JSON.stringify(labelAfterReselect)}`);
    expect(labelAfterReselect.wraps > 0, `reselect wraps=${labelAfterReselect.wraps}`);
    expect(labelScrollReset.role === 'label', `label scroll role=${labelScrollReset.role}`);
    expect(labelScrollReset.gridCols === 3, `label scroll gridCols=${labelScrollReset.gridCols}`);
    expect(labelScrollReset.wraps > 0, `label scroll wraps=${labelScrollReset.wraps}`);
    expect(labelScrollReset.scrollTop < 40, `label scrollTop=${labelScrollReset.scrollTop}`);
    return {
      ...labelData,
      labelClearTarget,
      labelBefore,
      labelGridCols,
      labelAfter,
      wfVisible,
      labelClearBefore,
      labelAfterLeftBlank,
      labelAfterRightBlank,
      labelAfterReselect,
      labelScrollReset,
    };
  });

  await record('mylot-grid', 'MyLot grid view / lot mode / double click restore', async () => {
    await boot('chunk3-mylot');
    await loadFolder('palette_3k');
    await page.evaluate(async () => {
      const v = window.viewer;
      if (!v.lotMode) {
        v.toggleLotMode();
        await new Promise((r) => setTimeout(r, 1200));
      }
      const modal = await v._getMyLotModal();
      const sample = v.currentGridImages.slice(0, 12);
      modal.activeMode = 'lot';
      modal.activeGroup = 'probe-group';
      modal.currentEntries = [
        { value: 'probe-lot', filename: 'probe-lot', path: sample[0], all_paths: sample },
      ];
      modal.selectedKeys = new Set(['probe-lot']);
      await modal.openSelectionInViewer();
    });
    await sleep(1500);
    const before = await getVisibleGridThumbSummary();
    const gridCols = await nudgeGridCols();
    await roundTripGridImageByDblClick(0);
    const after = await getVisibleGridThumbSummary();

    expect(before.role === 'mylot', `mylot role=${before.role}`);
    expect(before.lotMode === true, `mylot lotMode=${before.lotMode}`);
    expect(before.lotHeaders > 0, `mylot lotHeaders=${before.lotHeaders}`);
    expect(before.badCount === 0, `mylot before badCount=${before.badCount}`);
    expect(after.badCount === 0, `mylot after badCount=${after.badCount}`);
    expect(after.lotHeaders > 0, `mylot after lotHeaders=${after.lotHeaders}`);
    expect(gridCols.after.gridCols !== gridCols.before, `mylot gridCols ${gridCols.before}->${gridCols.after.gridCols}`);
    return { before, gridCols, after };
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
