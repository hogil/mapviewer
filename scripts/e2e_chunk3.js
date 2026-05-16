const fs = require('fs');
const path = require('path');
const { createRunner } = require('./e2e_playwright_session');

(async () => {
  const {
    base,
    sessionId,
    outputDir,
    page,
    results,
    expect,
    sleep,
    append,
    focusWindow,
    close,
  } = await createRunner(__filename);

  const imagesRoot = path.resolve(
    process.env.IMAGES_ROOT || (process.platform === 'win32' ? 'E:/data/images' : '/appdata/appuser/images')
  );
  const compositeInputCacheDir = path.join(imagesRoot, 'composite_cache_v1');
  const E2E_UNKNOWN_LABEL_CLASSES = ['e2e_unknown_label', 'e2e_unknown_label_alt'];
  const E2E_WAFER_LABEL_CRUD_CLASSES = [
    'e2e_wf_class_single',
    'e2e_wf_class_multi_a',
    'e2e_wf_class_multi_b',
    'e2e_wf_class_rename_old',
    'e2e_wf_class_rename_new',
    'e2e_wf_label_add',
    'e2e_wf_label_single_delete',
    'e2e_wf_label_multi_delete',
    'e2e_wf_label_folder_a',
    'e2e_wf_label_folder_b',
    'e2e_wf_chip_from_wafer_label',
  ];
  const COMPOSITE_E2E_TIMEOUT_MS = 90000;
  const PHASE_61_62_SUMMARY_FILE = 'cold-start-summary.json';

  function median(values) {
    const nums = values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    if (nums.length % 2 === 1) return Math.round(nums[mid] * 1000) / 1000;
    return Math.round(((nums[mid - 1] + nums[mid]) / 2) * 1000) / 1000;
  }

  function writeJsonArtifact(filename, payload) {
    const target = path.join(outputDir, filename);
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
    append(`[ARTIFACT] ${filename} :: ${target}\n`);
    return target;
  }

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
        Array.from(document.querySelectorAll(
          '#file-explorer .folder, #file-explorer .folder-item'
        )).some((node) => (node.textContent || '').includes('unknown')),
      null,
      { timeout: 90000 }
    );
    await focusWindow();
    await sleep(1200);
  }

  async function ensureUnknownWaferLabelClasses() {
    return await page.evaluate(async ({ imagesRoot, classNames }) => {
      const jsonRequest = async (url, options = {}) => {
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          ...options,
          headers,
        });
        const text = await response.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (_) {
          body = { raw: text };
        }
        if (!response.ok || body.success === false) {
          throw new Error(`${url} status=${response.status} body=${JSON.stringify(body).slice(0, 500)}`);
        }
        return body;
      };

      await jsonRequest('/api/change-folder', {
        method: 'POST',
        body: JSON.stringify({ path: imagesRoot }),
      });

      await fetch('/api/classes/delete?mode=wafer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: classNames }),
        cache: 'no-store',
        credentials: 'same-origin',
      }).catch(() => null);

      const recursive = await jsonRequest('/api/files/recursive?path=unknown&limit=5000');
      const supported = /\.(png|jpe?g|bmp|webp|tif|tiff)$/i;
      const blockedParts = new Set([
        'classification',
        'classification_chips',
        'chips',
        'thumbnails',
        'composite_map',
        'my-lot',
      ]);
      const files = (recursive.files || [])
        .map((imagePath) => String(imagePath || '').replace(/\\/g, '/'))
        .filter((imagePath) => imagePath.startsWith('unknown/') && supported.test(imagePath))
        .filter((imagePath) => !imagePath.split('/').some((part) => blockedParts.has(part)))
        .filter((value, index, arr) => arr.indexOf(value) === index);

      const preferredLots = ['AAU220', 'ABM792', 'AAV489', 'AAD534', 'AAI158', 'AAI216'];
      const ordered = [];
      const pushUnique = (imagePath) => {
        if (imagePath && !ordered.includes(imagePath)) ordered.push(imagePath);
      };
      for (const lot of preferredLots) {
        const found = files.find((imagePath) =>
          (imagePath.split('/').pop() || '').toUpperCase().startsWith(`${lot}_`)
        );
        pushUnique(found);
      }
      for (const imagePath of files) {
        pushUnique(imagePath);
      }
      if (ordered.length < 4) {
        throw new Error(`unknown label fixtures too small: ${JSON.stringify({ total: files.length, ordered })}`);
      }

      const primaryImages = ordered.slice(0, Math.min(6, ordered.length));
      const secondaryImages = ordered.slice(primaryImages.length, primaryImages.length + 6);
      while (secondaryImages.length < Math.min(3, ordered.length)) {
        secondaryImages.push(ordered[secondaryImages.length]);
      }

      const seeded = [];
      for (const [index, className] of classNames.entries()) {
        const createResponse = await fetch('/api/classes?mode=wafer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: className }),
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!createResponse.ok && createResponse.status !== 409) {
          const body = await createResponse.text();
          throw new Error(`/api/classes create ${className} status=${createResponse.status} body=${body.slice(0, 500)}`);
        }

        const images = index === 0 ? primaryImages : secondaryImages;
        const batch = await jsonRequest('/api/classify/batch?mode=wafer', {
          method: 'POST',
          body: JSON.stringify({ images, class_name: className, mode: 'wafer' }),
        });
        if ((batch.processed || 0) < images.length || batch.errors) {
          throw new Error(`classify ${className} incomplete: ${JSON.stringify(batch).slice(0, 500)}`);
        }
        seeded.push({ className, sourceImages: images, results: batch.results || [] });
      }

      await window.viewer?.refreshLabelExplorer?.();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const classList = await jsonRequest('/api/classes?mode=wafer');
      const missing = classNames.filter((className) => !(classList.classes || []).includes(className));
      if (missing.length) {
        throw new Error(`seeded unknown classes missing: ${JSON.stringify({ missing, classList })}`);
      }
      return {
        primaryClass: classNames[0],
        secondaryClass: classNames[1],
        seeded,
        classes: classList.classes || [],
      };
    }, { imagesRoot, classNames: E2E_UNKNOWN_LABEL_CLASSES });
  }

  async function getPrimaryLabelClass() {
    const data = await ensureUnknownWaferLabelClasses();
    return data.primaryClass;
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

  async function setSelection(indices, options = {}) {
    const state = await page.evaluate(({ idxs, label }) => {
      const v = window.viewer;
      v.gridSelectedIdxs = [...idxs];
      v.gridSelectedSet = new Set(idxs);
      if (Array.isArray(v.currentGridImages) && v.currentGridImages.length > 0) {
        v.selectedImages = [...v.currentGridImages];
      }
      v.updateGridSelection?.();
      v.flushGridSelectionUpdates?.();
      const modalSelection = typeof v.getSelectedImagesForModal === 'function'
        ? v.getSelectedImagesForModal()
        : [];
      return {
        label,
        requestedIdxs: [...idxs],
        gridSelectedIdxs: [...(v.gridSelectedIdxs || [])],
        selectedSetSize: v.gridSelectedSet?.size || 0,
        currentGridImagesLen: v.currentGridImages?.length || 0,
        selectedImagesLen: v.selectedImages?.length || 0,
        modalCount: modalSelection.length,
        modalSample: modalSelection.slice(0, 12),
        hasGridMeasureMap: !!v._gridMeasureMap,
      };
    }, { idxs: indices, label: options.label || 'selection' });
    await sleep(300);
    append(`[SET_SELECTION] ${state.label} :: ${JSON.stringify(state)}\n`);
    if (Number.isFinite(options.expectedCount)) {
      expect(
        state.modalCount === options.expectedCount,
        `selection count ${state.modalCount} != ${options.expectedCount}: ${JSON.stringify(state)}`
      );
    }
    return state;
  }

  async function findCompositeSourceSelection(minCount = 10, sampleLimit = 120) {
    const result = await page.evaluate(async ({ requiredCount, maxImages }) => {
      const images = Array.isArray(window.viewer?.currentGridImages)
        ? window.viewer.currentGridImages
        : [];
      const selected = [];
      const seen = new Set();
      const rejected = [];

      for (let idx = 0; idx < images.length && idx < maxImages && selected.length < requiredCount; idx += 1) {
        const imagePath = String(images[idx] || '').replace(/\\/g, '/');
        if (!imagePath) {
          rejected.push({ idx, reason: 'empty' });
          continue;
        }
        if (seen.has(imagePath)) {
          rejected.push({ idx, imagePath, reason: 'duplicate' });
          continue;
        }
        seen.add(imagePath);

        try {
          const resp = await fetch(
            `/api/chip-positions?path=${encodeURIComponent(imagePath)}&include_fq=0`,
            { cache: 'no-store' }
          );
          if (!resp.ok) {
            rejected.push({ idx, imagePath, reason: `status_${resp.status}` });
            continue;
          }
          const data = await resp.json();
          const chipCount = Array.isArray(data.chips) ? data.chips.length : 0;
          if (chipCount <= 0) {
            rejected.push({ idx, imagePath, reason: 'no_positions' });
            continue;
          }
          selected.push({ idx, imagePath, chipCount });
        } catch (err) {
          rejected.push({ idx, imagePath, reason: String(err && err.message ? err.message : err).slice(0, 160) });
        }
      }

      return {
        requested: requiredCount,
        sampled: Math.min(images.length, maxImages),
        selectedCount: selected.length,
        indices: selected.map((item) => item.idx),
        paths: selected.map((item) => item.imagePath),
        selectedSample: selected.slice(0, 12),
        rejectedSample: rejected.slice(0, 12),
      };
    }, { requiredCount: minCount, maxImages: sampleLimit });
    append(`[COMPOSITE_SOURCE_SELECTION] ${JSON.stringify(result)}\n`);
    expect(
      result.selectedCount >= minCount,
      `not enough composite sources with positions: ${JSON.stringify(result)}`
    );
    return result;
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

  async function waitForVisibleGridThumbsLoaded(timeoutMs = 12000, settleMs = 500) {
    const startedAt = Date.now();
    let lastSummary = null;
    while (Date.now() - startedAt < timeoutMs) {
      await page.evaluate(() =>
        window.viewer?.loadVisibleGridThumbnails?.({ cancelExisting: false })
      ).catch(() => {});
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

  async function startOrphanContextChooserMonitor(label) {
    await page.evaluate((monitorLabel) => {
      if (typeof window.__e2eStopOrphanContextChooserMonitor === 'function') {
        window.__e2eStopOrphanContextChooserMonitor();
      }
      const events = [];
      const readVisibleOrphans = () => {
        const contextMenu = document.getElementById('grid-context-menu');
        const contextVisible = !!contextMenu && getComputedStyle(contextMenu).display !== 'none';
        return Array.from(document.querySelectorAll('#context-mc-submenu, #context-mea-submenu'))
          .map((panel) => {
            const rect = panel.getBoundingClientRect();
            const style = getComputedStyle(panel);
            const search = panel.querySelector('input[placeholder="검색..."]');
            return {
              id: panel.id,
              display: style.display,
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              text: (panel.innerText || '').trim(),
              hasSearch: !!search,
              contextVisible,
            };
          })
          .filter((panel) =>
            !panel.contextVisible &&
            panel.display !== 'none' &&
            panel.width > 0 &&
            panel.height > 0 &&
            panel.hasSearch &&
            panel.text.includes('이미지를 선택하세요')
          );
      };
      const check = () => {
        const visible = readVisibleOrphans();
        if (visible.length) {
          events.push({
            label: monitorLabel,
            at: Math.round(performance.now()),
            visible,
          });
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
      const interval = setInterval(check, 25);
      window.__e2eStopOrphanContextChooserMonitor = () => {
        observer.disconnect();
        clearInterval(interval);
        check();
        const copy = events.slice();
        delete window.__e2eStopOrphanContextChooserMonitor;
        return copy;
      };
      check();
    }, label);
  }

  async function stopOrphanContextChooserMonitor() {
    return await page.evaluate(() => {
      if (typeof window.__e2eStopOrphanContextChooserMonitor !== 'function') {
        return [];
      }
      return window.__e2eStopOrphanContextChooserMonitor();
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

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function withAutoDialogs(fn) {
    const dialogs = [];
    const handler = async (dialog) => {
      dialogs.push({
        type: dialog.type(),
        message: dialog.message(),
      });
      await dialog.accept();
    };
    page.on('dialog', handler);
    try {
      const result = await fn(dialogs);
      return { result, dialogs };
    } finally {
      page.off('dialog', handler);
    }
  }

  async function setClassModeUi(mode) {
    const selector = mode === 'chip' ? '#class-mode-chip-btn' : '#class-mode-wafer-btn';
    const currentMode = await page.evaluate(() => window.viewer?.classMode || null);
    if (currentMode !== mode) {
      await page.locator(selector).click({ timeout: 10000 });
    }
    await page.waitForFunction(
      (expectedMode) => window.viewer?.classMode === expectedMode,
      mode,
      { timeout: 15000 }
    );
    await sleep(800);
  }

  async function refreshClassificationUi(mode, dirtyClasses = []) {
    await page.evaluate(async ({ expectedMode, dirty }) => {
      const v = window.viewer;
      v.classMode = expectedMode;
      v.cachedClassList = null;
      v.classListPromise = null;
      v.classToImgListCache = v.classToImgListCache || {};
      v.labelSelection = v.labelSelection || {
        selected: [],
        selectedClasses: [],
        openFolders: {},
      };
      await v.refreshClassList?.(true);
      await v.refreshLabelExplorer?.(dirty);
    }, { expectedMode: mode, dirty: dirtyClasses });
    await sleep(1000);
  }

  async function cleanupClassFixtures(mode, classNames) {
    await page.evaluate(async ({ expectedMode, names, root }) => {
      const jsonRequest = async (url, options = {}) => {
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          ...options,
          headers,
        });
        const text = await response.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (_) {
          body = { raw: text };
        }
        if (!response.ok || body.success === false) {
          throw new Error(`${url} status=${response.status} body=${JSON.stringify(body).slice(0, 500)}`);
        }
        return body;
      };

      const folderData = await jsonRequest('/api/change-folder', {
        method: 'POST',
        body: JSON.stringify({ path: root }),
      });
      const v = window.viewer;
      if (v) {
        v.currentFolderPath = folderData.current_folder;
        v.currentFolderPrefix = folderData.current_folder_prefix || '';
        v.productFolderPath = folderData.current_folder;
        v.classMode = expectedMode;
        v.markFolderContextChanged?.('e2e-label-crud-cleanup');
      }
      await jsonRequest(`/api/classes/delete?mode=${encodeURIComponent(expectedMode)}`, {
        method: 'POST',
        body: JSON.stringify({ names }),
      });
      if (v) {
        v.cachedClassList = null;
        v.classListPromise = null;
        v.classToImgListCache = {};
        v.labelSelection = {
          selected: [],
          selectedClasses: [],
          openFolders: {},
        };
      }
    }, { expectedMode: mode, names: classNames, root: imagesRoot });
    await sleep(500);
  }

  async function addClassesViaUi(mode, classNames) {
    await setClassModeUi(mode);
    await page.locator('#new-class-input').fill(classNames.join(','));
    const addDialogs = await withAutoDialogs(async () => {
      await page.locator('#add-class-btn').click({ timeout: 10000 });
    });
    await page.waitForFunction(
      async ({ expectedMode, names }) => {
        if (window.viewer?.classMode !== expectedMode) return false;
        const classButtons = Array.from(document.querySelectorAll('#class-list button'))
          .map((button) => (button.textContent || '').trim());
        const labelFolders = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
          .map((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim());
        const response = await fetch(`/api/classes?mode=${encodeURIComponent(expectedMode)}`, { cache: 'no-store' });
        if (!response.ok) return false;
        const body = await response.json();
        const apiClasses = Array.isArray(body.classes) ? body.classes : [];
        return names.every((name) =>
          classButtons.includes(name) &&
          apiClasses.includes(name) &&
          labelFolders.includes(name)
        );
      },
      { expectedMode: mode, names: classNames },
      { timeout: 20000 }
    );
    await refreshClassificationUi(mode, classNames);
    return {
      ...(await getClassificationUiState(classNames)),
      addDialogs: addDialogs.dialogs,
    };
  }

  async function getClassificationUiState(classNames = []) {
    return await page.evaluate((names) => {
      const classButtons = Array.from(document.querySelectorAll('#class-list button'))
        .map((button) => ({
          text: (button.textContent || '').trim(),
          selected: button.style.background.includes('0, 153, 255') ||
            button.style.background === '#09f' ||
            button.classList.contains('selected'),
        }));
      const labelFolders = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
        .map((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim());
      return {
        classMode: window.viewer?.classMode || null,
        selectedClasses: [...(window.viewer?.classSelection?.selected || [])],
        labelSelectedClasses: [...(window.viewer?.labelSelection?.selectedClasses || [])],
        present: names.filter((name) => classButtons.some((button) => button.text === name)),
        absent: names.filter((name) => !classButtons.some((button) => button.text === name)),
        labelPresent: names.filter((name) => labelFolders.includes(name)),
        classButtons: classButtons
          .filter((button) => names.includes(button.text))
          .map((button) => button.text),
      };
    }, classNames);
  }

  async function clickClassButton(className, modifiers = []) {
    const locator = page
      .locator('#class-list button')
      .filter({ hasText: new RegExp(`^${escapeRegExp(className)}$`) })
      .first();
    await locator.click({ modifiers, timeout: 10000 });
  }

  async function deleteClassesViaUiSelection(mode, classNames) {
    await setClassModeUi(mode);
    await page.evaluate(() => {
      const v = window.viewer;
      if (v?.classSelection) {
        v.classSelection.selected = [];
        v.classSelection.lastClicked = null;
        v.selectedClass = null;
        v.updateClassListSelection?.();
      }
    });
    for (const className of classNames) {
      await clickClassButton(className, ['Control']);
      await sleep(250);
    }
    const selectedBeforeDelete = await page.evaluate(() => [...(window.viewer?.classSelection?.selected || [])]);
    await page.waitForFunction(
      () => document.getElementById('delete-class-btn')?.disabled === false,
      null,
      { timeout: 10000 }
    );
    await withAutoDialogs(async () => {
      await page.locator('#delete-class-btn').click({ timeout: 10000 });
    });
    await page.waitForFunction(
      ({ names }) => {
        const classButtons = Array.from(document.querySelectorAll('#class-list button'))
          .map((button) => (button.textContent || '').trim());
        const labelFolders = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
          .map((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim());
        return names.every((name) => !classButtons.includes(name) && !labelFolders.includes(name));
      },
      { names: classNames },
      { timeout: 20000 }
    );
    return {
      selectedBeforeDelete,
      after: await getClassificationUiState(classNames),
    };
  }

  async function renameClassViaUi(mode, oldName, newName) {
    await setClassModeUi(mode);
    await refreshClassificationUi(mode, [oldName, newName]);
    await page.evaluate(() => {
      const v = window.viewer;
      if (v?.classSelection) {
        v.classSelection.selected = [];
        v.classSelection.lastClicked = null;
        v.selectedClass = null;
        v.updateClassListSelection?.();
      }
    });
    await clickClassButton(oldName, ['Control']);
    await page.waitForFunction(
      () => document.getElementById('rename-class-btn')?.disabled === false,
      null,
      { timeout: 10000 }
    );
    const renameDialogs = [];
    const handler = async (dialog) => {
      renameDialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'prompt') {
        await dialog.accept(newName);
      } else {
        await dialog.accept();
      }
    };
    page.on('dialog', handler);
    try {
      await page.locator('#rename-class-btn').click({ timeout: 10000 });
      await page.waitForFunction(
        ({ oldClass, renamedClass }) => {
          const classButtons = Array.from(document.querySelectorAll('#class-list button'))
            .map((button) => (button.textContent || '').trim());
          const labelFolders = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
            .map((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim());
          return classButtons.includes(renamedClass) &&
            !classButtons.includes(oldClass) &&
            labelFolders.includes(renamedClass) &&
            !labelFolders.includes(oldClass);
        },
        { oldClass: oldName, renamedClass: newName },
        { timeout: 30000 }
      );
    } finally {
      page.off('dialog', handler);
    }
    return {
      dialogs: renameDialogs,
      after: await getClassificationUiState([oldName, newName]),
    };
  }

  async function getUnknownSampleImages(count) {
    return await page.evaluate(async ({ requiredCount }) => {
      const jsonRequest = async (url) => {
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        const body = await response.json();
        if (!response.ok || body.success === false) {
          throw new Error(`${url} status=${response.status} body=${JSON.stringify(body).slice(0, 500)}`);
        }
        return body;
      };
      const recursive = await jsonRequest('/api/files/recursive?path=unknown&limit=5000');
      const blockedParts = new Set(['classification', 'classification_chips', 'chips', 'thumbnails', 'composite_map', 'my-lot']);
      const files = (recursive.files || [])
        .map((imagePath) => String(imagePath || '').replace(/\\/g, '/'))
        .filter((imagePath) => imagePath.startsWith('unknown/') && /\.(png|jpe?g|bmp|webp|tif|tiff)$/i.test(imagePath))
        .filter((imagePath) => !imagePath.split('/').some((part) => blockedParts.has(part)))
        .filter((value, index, arr) => arr.indexOf(value) === index);
      if (files.length < requiredCount) {
        throw new Error(`not enough unknown sample images: ${JSON.stringify({ requiredCount, count: files.length })}`);
      }
      return files.slice(0, requiredCount);
    }, { requiredCount: count });
  }

  async function seedWaferLabelClasses(classToImages) {
    await page.evaluate(async ({ classMap }) => {
      const jsonRequest = async (url, options = {}) => {
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          ...options,
          headers,
        });
        const text = await response.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch (_) {
          body = { raw: text };
        }
        if (!response.ok || body.success === false) {
          throw new Error(`${url} status=${response.status} body=${JSON.stringify(body).slice(0, 500)}`);
        }
        return body;
      };
      for (const [className, images] of Object.entries(classMap)) {
        const createResponse = await fetch('/api/classes?mode=wafer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: className }),
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!createResponse.ok && createResponse.status !== 409) {
          throw new Error(`/api/classes create ${className} status=${createResponse.status}`);
        }
        if (images.length > 0) {
          await jsonRequest('/api/classify/batch?mode=wafer', {
            method: 'POST',
            body: JSON.stringify({ class_name: className, images, mode: 'wafer' }),
          });
        }
      }
      const v = window.viewer;
      if (v) {
        v.classMode = 'wafer';
        v.cachedClassList = null;
        v.classListPromise = null;
        v.classToImgListCache = {};
        await v.refreshClassList?.(true);
        await v.refreshLabelExplorer?.(Object.keys(classMap));
      }
    }, { classMap: classToImages });
    await sleep(1000);
  }

  async function getClassFiles(mode, className) {
    return await page.evaluate(async ({ expectedMode, targetClass }) => {
      const labelPath = `${expectedMode === 'chip' ? 'classification_chips' : 'classification'}/${targetClass}`;
      const response = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const body = await response.json().catch(async () => ({ raw: await response.text().catch(() => '') }));
      if (!response.ok || body.success === false) {
        return { ok: false, status: response.status, files: [], body };
      }
      const files = (body.items || [])
        .filter((item) => item.type === 'file')
        .map((item) => item.name);
      return { ok: true, status: response.status, files, count: files.length };
    }, { expectedMode: mode, targetClass: className });
  }

  async function waitForClassFileCount(mode, className, expectedCount, comparator = 'eq') {
    await page.waitForFunction(
      async ({ expectedMode, targetClass, count, op }) => {
        const labelPath = `${expectedMode === 'chip' ? 'classification_chips' : 'classification'}/${targetClass}`;
        const response = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`, { cache: 'no-store' });
        if (!response.ok) return false;
        const body = await response.json();
        const fileCount = (body.items || []).filter((item) => item.type === 'file').length;
        if (op === 'gte') return fileCount >= count;
        return fileCount === count;
      },
      { expectedMode: mode, targetClass: className, count: expectedCount, op: comparator },
      { timeout: 30000 }
    );
    return await getClassFiles(mode, className);
  }

  async function getLabelFolderLocator(className) {
    return page
      .locator('#label-explorer-list li > div')
      .filter({ hasText: new RegExp(`^[\\s▸▾]*${escapeRegExp(className)}\\s*$`) })
      .first();
  }

  async function clickLabelFolder(className, modifiers = []) {
    const locator = await getLabelFolderLocator(className);
    await locator.click({ modifiers, timeout: 10000 });
  }

  async function ensureLabelFolderOpen(className, minFiles = 0) {
    const isOpen = await page.evaluate((targetClass) =>
      !!window.viewer?.labelSelection?.openFolders?.[targetClass],
    className);
    if (!isOpen) {
      await clickLabelFolder(className);
    }
    await page.waitForFunction(
      ({ targetClass, minimum }) => {
        const v = window.viewer;
        if (!v?.labelSelection?.openFolders?.[targetClass]) return false;
        const cached = v.classToImgListCache?.[targetClass] || [];
        const fileCount = cached.filter((item) => item.type === 'file').length;
        if (fileCount < minimum) return false;
        const folderDiv = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
          .find((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim() === targetClass);
        const classLi = folderDiv?.closest('li');
        const buttons = classLi ? classLi.querySelectorAll('button.label-img-name').length : 0;
        return buttons >= minimum;
      },
      { targetClass: className, minimum: minFiles },
      { timeout: 30000 }
    );
  }

  async function getOpenLabelFolderState(className) {
    return await page.evaluate((targetClass) => {
      const folderDiv = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
        .find((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim() === targetClass);
      const classLi = folderDiv?.closest('li');
      const buttons = classLi ? Array.from(classLi.querySelectorAll('button.label-img-name')) : [];
      const files = buttons.map((button) => (button.textContent || '').trim()).filter(Boolean);
      return {
        exists: !!folderDiv,
        open: !!window.viewer?.labelSelection?.openFolders?.[targetClass],
        selectedClass: !!window.viewer?.labelSelection?.selectedClasses?.includes(targetClass),
        arrow: folderDiv?.querySelector('span')?.textContent || '',
        count: files.length,
        files,
      };
    }, className);
  }

  async function waitForOpenLabelFolderCount(className, expectedCount, comparator = 'eq') {
    try {
      await page.waitForFunction(
        ({ targetClass, count, op }) => {
          const folderDiv = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
            .find((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim() === targetClass);
          const classLi = folderDiv?.closest('li');
          const fileCount = classLi ? classLi.querySelectorAll('button.label-img-name').length : -1;
          const isOpen = !!window.viewer?.labelSelection?.openFolders?.[targetClass];
          if (!folderDiv || !isOpen) return false;
          if (op === 'gte') return fileCount >= count;
          return fileCount === count;
        },
        { targetClass: className, count: expectedCount, op: comparator },
        { timeout: 30000 }
      );
    } catch (error) {
      const state = await getOpenLabelFolderState(className);
      throw new Error(`open label folder count timeout class=${className} expected=${comparator}:${expectedCount} state=${JSON.stringify(state)} cause=${String(error?.message || error)}`);
    }
    return await getOpenLabelFolderState(className);
  }

  async function getLabelImageButtonBox(className, index = 0, deleteButton = false) {
    return await page.evaluate(({ targetClass, targetIndex, del }) => {
      const folderDiv = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
        .find((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim() === targetClass);
      const classLi = folderDiv?.closest('li');
      const selector = del ? 'button.label-img-del-btn' : 'button.label-img-name';
      const button = classLi ? Array.from(classLi.querySelectorAll(selector))[targetIndex] : null;
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: button.textContent || '',
      };
    }, { targetClass: className, targetIndex: index, del: deleteButton });
  }

  async function clickLabelImageButton(className, index = 0, modifiers = []) {
    const box = await getLabelImageButtonBox(className, index, false);
    expect(!!box, `label image button missing: ${className}[${index}]`);
    try {
      for (const modifier of modifiers) {
        await page.keyboard.down(modifier);
      }
      await page.mouse.click(box.x, box.y);
    } finally {
      for (const modifier of [...modifiers].reverse()) {
        await page.keyboard.up(modifier);
      }
    }
    await sleep(700);
    return box;
  }

  async function clickLabelDeleteButton(className, index = 0) {
    const box = await getLabelImageButtonBox(className, index, true);
    expect(!!box, `label delete button missing: ${className}[${index}]`);
    await page.mouse.click(box.x, box.y);
    await sleep(1200);
    return box;
  }

  async function selectLabelFoldersViaUi(mode, classNames) {
    await setClassModeUi(mode);
    await refreshClassificationUi(mode, classNames);
    await page.evaluate(() => {
      const v = window.viewer;
      v.labelSelection = v.labelSelection || { selected: [], selectedClasses: [], openFolders: {} };
      v.labelSelection.selected = [];
      v.labelSelection.selectedClasses = [];
      v.labelSelection.lastClicked = null;
      v.labelSelection.lastClickedClass = null;
      v.updateLabelExplorerSelection?.();
    });
    for (const className of classNames) {
      await clickLabelFolder(className, ['Control']);
      await sleep(900);
    }
    await page.waitForFunction(
      ({ names }) => {
        const v = window.viewer;
        const selectedClasses = v?.labelSelection?.selectedClasses || [];
        const grid = document.getElementById('image-grid');
        const wrapper = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement;
        return names.every((name) => selectedClasses.includes(name)) &&
          v?.gridMode === true &&
          v?.pageManager?.getActivePage?.()?.role === 'label' &&
          (v.currentGridImages?.length || 0) >= names.length &&
          !!grid &&
          !!wrapper &&
          grid.hasAttribute('data-label-explorer-grid') &&
          getComputedStyle(grid).display !== 'none' &&
          getComputedStyle(wrapper).display !== 'none' &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0;
      },
      { names: classNames },
      { timeout: 30000 }
    );
    await sleep(900);
    const visible = await waitForVisibleGridThumbsLoaded(15000, 500);
    return {
      selected: await getLabelExplorerState(),
      visible,
    };
  }

  async function addLabelToCurrentSelectionViaModal(mode, className) {
    await setClassModeUi(mode);
    const result = await withAutoDialogs(async () => {
      await page.locator('#label-explorer-batch-label-btn').click({ timeout: 10000 });
      await page.waitForFunction(() => {
        const modal = document.getElementById('add-label-modal');
        return modal && getComputedStyle(modal).display !== 'none';
      }, null, { timeout: 15000 });
      await page.waitForFunction(
        (targetClass) => Array.from(document.querySelectorAll('#modal-class-select option'))
          .some((option) => option.value === targetClass),
        className,
        { timeout: 15000 }
      );
      await page.locator('#modal-class-select').selectOption(className);
      await page.locator('#modal-add-label').click({ timeout: 10000 });
      await page.waitForFunction(() => {
        const modal = document.getElementById('add-label-modal');
        return !modal || getComputedStyle(modal).display === 'none';
      }, null, { timeout: 30000 });
    });
    return result;
  }

  await boot('chunk3');

  await record('41,42,45,47,48,56', 'Composite / Measure 안정성 / toast / color modal / grid restore', async () => {
    removeCompositeInputCacheDir();
    const compositeInputCacheBefore = getCompositeInputCacheState();

    await loadFolder('unknown');
    const compositeSourceSelection = await findCompositeSourceSelection(10, 160);
    const compositeSourceIdxs = compositeSourceSelection.indices.slice(0, 10);
    await setSelection(compositeSourceIdxs, { label: 'composite-10-with-positions', expectedCount: 10 });
    const compositeSourcePaths = compositeSourceSelection.paths.slice(0, 10);
    expect(
      compositeSourcePaths.every((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/')),
      `composite source paths=${JSON.stringify(compositeSourcePaths)}`
    );
    await startOrphanContextChooserMonitor('direct-composite-10');
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
      Number(compositePerf.elapsedMs) > 0 && Number(compositePerf.elapsedMs) < 10000,
      `10-image composite elapsed time too slow=${JSON.stringify(compositePerf)}`
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
    const compositeBefore = await waitForVisibleGridThumbsLoaded(12000, 500);
    const compositeSettled = await waitForVisibleGridThumbsLoaded(12000, 500);
    const directCompositeOrphanContextChooserEvents = await stopOrphanContextChooserMonitor();
    expect(
      directCompositeOrphanContextChooserEvents.length === 0,
      `direct composite orphan context chooser=${JSON.stringify(directCompositeOrphanContextChooserEvents)}`
    );
    const compositeContextColorModal = await (async () => {
      await page.locator('#image-grid .grid-thumb-wrap').first().click({ button: 'right' });
      await page.waitForFunction(() => {
        const menu = document.getElementById('grid-context-menu');
        const item = document.getElementById('context-composite-colors');
        if (!menu || !item) return false;
        const menuStyle = getComputedStyle(menu);
        const itemStyle = getComputedStyle(item);
        return (
          menuStyle.display !== 'none' &&
          itemStyle.display !== 'none' &&
          /Composite 색 변경/.test(item.textContent || '')
        );
      }, null, { timeout: 10000 });
      const itemText = await page.locator('#context-composite-colors').innerText();
      await page.locator('#context-composite-colors').click();
      await page.waitForFunction(() => {
        const modal = document.getElementById('color-editor-modal');
        const activeTab = document.querySelector('#color-editor-tabs .color-editor-tab.active');
        const compositeContent = document.getElementById('color-editor-composite-content');
        if (!modal || !activeTab || !compositeContent) return false;
        return (
          modal.classList.contains('is-open') &&
          activeTab.dataset.tab === 'composite' &&
          getComputedStyle(compositeContent).display !== 'none'
        );
      }, null, { timeout: 10000 });
      const state = await page.evaluate(() => {
        const modal = document.getElementById('color-editor-modal');
        const activeTab = document.querySelector('#color-editor-tabs .color-editor-tab.active');
        const compositeContent = document.getElementById('color-editor-composite-content');
        const legacyModal = document.getElementById('composite-color-modal');
        return {
          colorEditorOpen: !!modal?.classList.contains('is-open'),
          activeTab: activeTab?.dataset.tab || null,
          compositeContentDisplay: compositeContent ? getComputedStyle(compositeContent).display : null,
          legacyCompositeOpen: !!legacyModal?.classList.contains('is-open'),
        };
      });
      await page.evaluate(async () => {
        const editor = await window.viewer._getColorEditor();
        await editor.close();
      });
      await sleep(300);
      return { itemText, ...state };
    })();
    await roundTripGridImageByDblClick(0);
    const compositeAfter = await waitForVisibleGridThumbsLoaded(12000, 500);
    const compositeGridCols = await nudgeGridCols();
    const compositeOutputDir = await page.evaluate(() => window.viewer.compositeSession?.outputDir || null);
    const squareMapsDataBeforeSubset = getSquareMapsDataState(compositeOutputDir);
    const npzOnlySubsetRecolor = await page.evaluate(async (sourcePaths) => {
      const outputDir = window.viewer.compositeSession?.outputDir || null;
      const unknownSourcePath = (Array.isArray(sourcePaths) ? sourcePaths : [])
        .map((imagePath) => String(imagePath || '').replace(/\\/g, '/'))
        .find((imagePath) => imagePath.startsWith('unknown/')) || null;
      const order = [];
      const timed = async (label, fn) => {
        const startedAt = performance.now();
        const value = await fn();
        const endedAt = performance.now();
        order.push({
          label,
          atMs: Math.round(endedAt),
          elapsedMs: Math.round(endedAt - startedAt),
        });
        return { value, elapsedMs: endedAt - startedAt };
      };
      const subsetTask = timed('subset', async () => {
        const response = await fetch('/api/composite-subset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            output_dir: outputDir,
            selected_grades: [1, 2],
          }),
          cache: 'no-store',
        });
        const body = await response.json().catch(async () => ({
          detail: await response.text().catch(() => ''),
        }));
        return { ok: response.ok, status: response.status, body };
      });
      const imageSizeTask = timed('image-size', async () => {
        if (!unknownSourcePath) return { ok: false, status: 0, body: null };
        const response = await fetch(`/api/image/size?path=${encodeURIComponent(unknownSourcePath)}`, {
          cache: 'no-store',
        });
        const body = await response.json().catch(async () => ({
          detail: await response.text().catch(() => ''),
        }));
        return { ok: response.ok, status: response.status, body };
      });
      const imageTask = timed('image-level', async () => {
        if (!unknownSourcePath) return { ok: false, status: 0, byteLength: 0 };
        const level = window.SERVER_CONFIG?.PYRAMID_LEVELS?.[0] || 0.2;
        const response = await fetch(
          `/api/image?path=${encodeURIComponent(unknownSourcePath)}&level=${encodeURIComponent(level)}`,
          { cache: 'no-store' }
        );
        const buffer = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
        return { ok: response.ok, status: response.status, byteLength: buffer.byteLength, level };
      });
      const [subsetTimed, imageSizeTimed, imageTimed] = await Promise.all([
        subsetTask,
        imageSizeTask,
        imageTask,
      ]);
      const subsetResponse = subsetTimed.value;
      const imageSizeResponse = imageSizeTimed.value;
      const imageResponse = imageTimed.value;
      const subsetBody = subsetResponse.body || {};
      const subsetOrder = order.findIndex((item) => item.label === 'subset');
      const imageSizeOrder = order.findIndex((item) => item.label === 'image-size');
      const imageOrder = order.findIndex((item) => item.label === 'image-level');
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
        unknownSourcePath,
        nonBlockingOrder: order,
        imageSizeBeforeSubset: imageSizeOrder >= 0 && subsetOrder >= 0 && imageSizeOrder < subsetOrder,
        imageBeforeSubset: imageOrder >= 0 && subsetOrder >= 0 && imageOrder < subsetOrder,
        imageSizeOk: imageSizeResponse.ok,
        imageSizeStatus: imageSizeResponse.status,
        imageOk: imageResponse.ok,
        imageStatus: imageResponse.status,
        imageBytes: imageResponse.byteLength || 0,
        imageLevel: imageResponse.level || null,
        subsetMs: Math.round(subsetTimed.elapsedMs),
        imageSizeMs: Math.round(imageSizeTimed.elapsedMs),
        imageMs: Math.round(imageTimed.elapsedMs),
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
    }, compositeSourcePaths);
    const squareMapsDataAfterSubsetRecolor = getSquareMapsDataState(compositeOutputDir);
    const compositeInputCacheAfterSubsetRecolor = getCompositeInputCacheState();

    await boot('chunk3-composite-pending-toast');
    await loadFolder('unknown');
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
    await loadFolder('unknown');
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
    await loadFolder('unknown');
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
    const measureBefore = await waitForVisibleGridThumbsLoaded(12000, 500);
    await page.evaluate(async () => {
      const editor = await window.viewer._getColorEditor();
      editor?.close?.();
    });
    await sleep(400);
    await roundTripGridImageByDblClick(0);
    const measureAfter = await waitForVisibleGridThumbsLoaded(12000, 500);
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
    await loadFolder('unknown');
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
    expect(
      compositeContextColorModal.colorEditorOpen &&
        compositeContextColorModal.activeTab === 'composite' &&
        compositeContextColorModal.compositeContentDisplay !== 'none' &&
        compositeContextColorModal.legacyCompositeOpen === false,
      `composite context color modal did not open Composite tab=${JSON.stringify(compositeContextColorModal)}`
    );
    expect(compositeSettled.badCount === 0, `composite settled=${JSON.stringify(compositeSettled)}`);
    expect(compositeAfter.badCount === 0, `composite after=${JSON.stringify(compositeAfter)}`);
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
      npzOnlySubsetRecolor.unknownSourcePath?.startsWith('unknown/'),
      `subset nonblocking source is not unknown=${JSON.stringify(npzOnlySubsetRecolor)}`
    );
    expect(
      npzOnlySubsetRecolor.imageSizeOk && npzOnlySubsetRecolor.imageSizeBeforeSubset,
      `subset blocked image-size request=${JSON.stringify(npzOnlySubsetRecolor)}`
    );
    expect(
      npzOnlySubsetRecolor.imageOk &&
        npzOnlySubsetRecolor.imageBytes > 0 &&
        npzOnlySubsetRecolor.imageBeforeSubset,
      `subset blocked image request=${JSON.stringify(npzOnlySubsetRecolor)}`
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
    expect(measureBefore.badCount === 0, `measure before=${JSON.stringify(measureBefore)}`);
    expect(measureAfter.badCount === 0, `measure after=${JSON.stringify(measureAfter)}`);
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
      compositeContextColorModal,
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
      compositeSourcePaths,
      directCompositeOrphanContextChooserEvents,
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
    await selectWaferExplorerFolder('unknown');
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
      waferAfterComposite.selectedFolders.includes('unknown'),
      `wafer selectedFolders lost=${JSON.stringify(waferAfterComposite)}`
    );
    expect(
      waferAfterComposite.waferSelectedFolderPaths.includes('unknown'),
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
    await loadFolder('unknown');
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
    await loadFolder('unknown');
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
    await selectWaferExplorerFolder('unknown');
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
      waferGridAfter.selectedFolders.includes('unknown') &&
        waferGridAfter.waferSelectedFolderPaths.includes('unknown'),
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

  await record('label-wafer-crud', 'Wafer label Class Manager CRUD / Label Explorer 다중선택 삭제+상세보기', async () => {
    await boot('chunk3-wafer-label-crud');
    const classes = {
      classSingle: 'e2e_wf_class_single',
      classMultiA: 'e2e_wf_class_multi_a',
      classMultiB: 'e2e_wf_class_multi_b',
      classRenameOld: 'e2e_wf_class_rename_old',
      classRenameNew: 'e2e_wf_class_rename_new',
      labelAdd: 'e2e_wf_label_add',
      labelSingleDelete: 'e2e_wf_label_single_delete',
      labelMultiDelete: 'e2e_wf_label_multi_delete',
      folderA: 'e2e_wf_label_folder_a',
      folderB: 'e2e_wf_label_folder_b',
      chipFromWaferLabel: 'e2e_wf_chip_from_wafer_label',
    };

    await cleanupClassFixtures('wafer', E2E_WAFER_LABEL_CRUD_CLASSES);
    try {
      await refreshClassificationUi('wafer');

      const classSingleAdd = await addClassesViaUi('wafer', [classes.classSingle]);
      expect(classSingleAdd.present.includes(classes.classSingle), `wafer single class add failed=${JSON.stringify(classSingleAdd)}`);
      const classSingleDelete = await deleteClassesViaUiSelection('wafer', [classes.classSingle]);
      expect(
        classSingleDelete.after.absent.includes(classes.classSingle),
        `wafer single class delete failed=${JSON.stringify(classSingleDelete)}`
      );

      const classMultiAdd = await addClassesViaUi('wafer', [classes.classMultiA, classes.classMultiB]);
      expect(
        [classes.classMultiA, classes.classMultiB].every((name) => classMultiAdd.present.includes(name)),
        `wafer multi class add failed=${JSON.stringify(classMultiAdd)}`
      );
      const classMultiDelete = await deleteClassesViaUiSelection('wafer', [classes.classMultiA, classes.classMultiB]);
      expect(
        [classes.classMultiA, classes.classMultiB].every((name) => classMultiDelete.after.absent.includes(name)),
        `wafer multi class delete failed=${JSON.stringify(classMultiDelete)}`
      );

      const classRenameAdd = await addClassesViaUi('wafer', [classes.classRenameOld]);
      expect(
        classRenameAdd.present.includes(classes.classRenameOld),
        `wafer rename source class add failed=${JSON.stringify(classRenameAdd)}`
      );
      const classRename = await renameClassViaUi('wafer', classes.classRenameOld, classes.classRenameNew);
      expect(
        classRename.after.present.includes(classes.classRenameNew) &&
          classRename.after.absent.includes(classes.classRenameOld) &&
          classRename.after.labelPresent.includes(classes.classRenameNew),
        `wafer class rename did not refresh UI immediately=${JSON.stringify(classRename)}`
      );

      const sampleImages = await getUnknownSampleImages(10);
      const classMap = {
        [classes.labelAdd]: [],
        [classes.labelSingleDelete]: [sampleImages[0]],
        [classes.labelMultiDelete]: [sampleImages[1], sampleImages[2]],
        [classes.folderA]: [sampleImages[3], sampleImages[4]],
        [classes.folderB]: [sampleImages[5], sampleImages[6]],
      };
      await seedWaferLabelClasses(classMap);

      await loadFolder('unknown');
      await setSelection([7, 8], { label: 'wafer-label-add-ui', expectedCount: 2 });
      const addLabelDialogs = await addLabelToCurrentSelectionViaModal('wafer', classes.labelAdd);
      const labelAddFiles = await waitForClassFileCount('wafer', classes.labelAdd, 2, 'gte');
      expect(labelAddFiles.count >= 2, `wafer label add failed=${JSON.stringify(labelAddFiles)}`);

      await ensureLabelFolderOpen(classes.labelAdd, 2);
      const waferLabelClick = await clickLabelImageButton(classes.labelAdd, 0);
      await page.waitForFunction(
        (targetClass) => {
          const v = window.viewer;
          const path = String(v?.selectedImagePath || '').replace(/\\/g, '/');
          return v?.gridMode === false &&
            /\/?classification\//i.test(path) &&
            path.includes(`classification/${targetClass}/`) &&
            Array.isArray(v.chipAnnotator?.chips) &&
            v.chipAnnotator.chips.length > 0;
        },
        classes.labelAdd,
        { timeout: 90000 }
      );
      const waferLabelPositions = await page.evaluate(() => ({
        selectedImagePath: String(window.viewer?.selectedImagePath || '').replace(/\\/g, '/'),
        chipCount: window.viewer?.chipAnnotator?.chips?.length || 0,
      }));
      const chipClassFromWaferAdd = await addClassesViaUi('chip', [classes.chipFromWaferLabel]);
      expect(
        chipClassFromWaferAdd.present.includes(classes.chipFromWaferLabel),
        `chip class for wafer-label source add failed=${JSON.stringify(chipClassFromWaferAdd)}`
      );
      const selectedChipsFromWaferLabel = await page.evaluate((requiredCount) => {
        const v = window.viewer;
        const annotator = v?.chipAnnotator;
        const chips = annotator?.chips || [];
        const selected = [];
        for (let i = 0; i < chips.length && selected.length < requiredCount; i += 1) {
          const chip = chips[i];
          if (Number.isFinite(Number(chip?.x_abs)) && Number.isFinite(Number(chip?.y_abs))) {
            selected.push(i);
          }
        }
        if (selected.length < requiredCount) {
          return { ok: false, selected, chipCount: chips.length };
        }
        annotator.selectedChips = new Set(selected);
        annotator.selectedChipsOrder = selected;
        annotator.updateSelectedChipsList?.();
        annotator.render?.();
        return {
          ok: true,
          selected,
          chipCount: chips.length,
          coords: selected.map((idx) => ({
            x_abs: Number(chips[idx].x_abs),
            y_abs: Number(chips[idx].y_abs),
          })),
          selectedImagePath: String(v.selectedImagePath || '').replace(/\\/g, '/'),
        };
      }, 2);
      expect(
        selectedChipsFromWaferLabel.ok,
        `wafer label copy did not expose selectable chips=${JSON.stringify({ waferLabelClick, waferLabelPositions, selectedChipsFromWaferLabel })}`
      );
      await clickClassButton(classes.chipFromWaferLabel);
      const chipFilesFromWaferLabel = await waitForClassFileCount(
        'chip',
        classes.chipFromWaferLabel,
        selectedChipsFromWaferLabel.selected.length,
        'gte'
      );
      expect(
        chipFilesFromWaferLabel.count >= selectedChipsFromWaferLabel.selected.length,
        `chip label from wafer label copy failed=${JSON.stringify({ selectedChipsFromWaferLabel, chipFilesFromWaferLabel })}`
      );

      await setClassModeUi('wafer');
      await loadFolder('unknown');
      await refreshClassificationUi('wafer', [classes.labelAdd, classes.folderA, classes.folderB]);

      await ensureLabelFolderOpen(classes.folderA, 2);
      const folderAOpenBeforeAdd = await waitForOpenLabelFolderCount(classes.folderA, 2);
      await setSelection([7, 8], { label: 'wafer-label-open-folder-add-ui', expectedCount: 2 });
      const openFolderAddDialogs = await addLabelToCurrentSelectionViaModal('wafer', classes.folderA);
      const folderAOpenAfterAdd = await waitForOpenLabelFolderCount(classes.folderA, 4, 'gte');
      expect(
        folderAOpenBeforeAdd.open &&
          folderAOpenAfterAdd.open &&
          folderAOpenAfterAdd.count >= folderAOpenBeforeAdd.count + 2,
        `wafer open label folder add did not preserve/update list=${JSON.stringify({
          folderAOpenBeforeAdd,
          openFolderAddDialogs,
          folderAOpenAfterAdd,
        })}`
      );

      const singleFolderGrid = await selectLabelFoldersViaUi('wafer', [classes.folderA]);
      expect(
        singleFolderGrid.selected.selectedClasses.includes(classes.folderA) &&
          singleFolderGrid.selected.currentGridImages >= 2 &&
          singleFolderGrid.visible.badCount === 0,
        `wafer single label folder grid failed=${JSON.stringify(singleFolderGrid)}`
      );

      const multiFolderGrid = await selectLabelFoldersViaUi('wafer', [classes.folderA, classes.folderB]);
      expect(
        [classes.folderA, classes.folderB].every((name) => multiFolderGrid.selected.selectedClasses.includes(name)) &&
          multiFolderGrid.selected.currentGridImages >= 4 &&
          multiFolderGrid.visible.badCount === 0,
        `wafer multi label folder grid failed=${JSON.stringify(multiFolderGrid)}`
      );

      await page.locator('#image-grid .grid-thumb-wrap').first().dblclick();
      await page.waitForFunction(
        ({ expectedClasses }) => {
          const v = window.viewer;
          const canvas = document.getElementById('image-canvas');
          const path = String(v?.selectedImagePath || '').replace(/\\/g, '/');
          return v?.pageManager?.getActivePage?.()?.role === 'label' &&
            v.gridMode === false &&
            (v.viewMode === 'gridImage' || v.viewMode === 'single') &&
            expectedClasses.some((className) => path.includes(`classification/${className}/`)) &&
            !!canvas &&
            getComputedStyle(canvas).display !== 'none';
        },
        { expectedClasses: [classes.folderA, classes.folderB] },
        { timeout: 30000 }
      );
      await sleep(1000);
      const multiFolderDetail = await page.evaluate(() => ({
        role: window.viewer.pageManager?.getActivePage?.()?.role || null,
        gridMode: window.viewer.gridMode,
        viewMode: window.viewer.viewMode,
        selectedImagePath: window.viewer.selectedImagePath || '',
        canvasVisible: getComputedStyle(document.getElementById('image-canvas')).display !== 'none',
      }));
      expect(multiFolderDetail.canvasVisible, `wafer label detail canvas hidden=${JSON.stringify(multiFolderDetail)}`);

      await page.evaluate(() => window.viewer.exitSingleImageViewMode?.());
      await sleep(1000);
      await refreshClassificationUi('wafer', Object.keys(classMap));

      await ensureLabelFolderOpen(classes.labelSingleDelete, 1);
      const singleDeleteOpenBefore = await waitForOpenLabelFolderCount(classes.labelSingleDelete, 1);
      const singleDeleteButton = await clickLabelDeleteButton(classes.labelSingleDelete, 0);
      const singleDeleteOpenAfter = await waitForOpenLabelFolderCount(classes.labelSingleDelete, 0);
      const singleDeleteFiles = await waitForClassFileCount('wafer', classes.labelSingleDelete, 0);
      expect(
        singleDeleteOpenBefore.open &&
          singleDeleteOpenAfter.open &&
          singleDeleteOpenAfter.count === 0 &&
          singleDeleteFiles.count === 0,
        `wafer single open folder label delete failed=${JSON.stringify({
          singleDeleteOpenBefore,
          singleDeleteButton,
          singleDeleteOpenAfter,
          singleDeleteFiles,
        })}`
      );

      await ensureLabelFolderOpen(classes.labelMultiDelete, 2);
      const firstMultiLabel = await clickLabelImageButton(classes.labelMultiDelete, 0);
      const secondMultiLabel = await clickLabelImageButton(classes.labelMultiDelete, 1, ['Control']);
      const multiLabelSelectedBeforeDelete = await getLabelExplorerState();
      expect(
        multiLabelSelectedBeforeDelete.selected.length >= 2,
        `wafer label multi-select failed=${JSON.stringify({ firstMultiLabel, secondMultiLabel, multiLabelSelectedBeforeDelete })}`
      );
      const multiDeleteDialogs = await withAutoDialogs(async () => {
        await page.locator('#label-explorer-batch-delete-btn').click({ timeout: 10000 });
      });
      const multiDeleteOpenAfter = await waitForOpenLabelFolderCount(classes.labelMultiDelete, 0);
      const multiDeleteFiles = await waitForClassFileCount('wafer', classes.labelMultiDelete, 0);
      expect(
        multiDeleteOpenAfter.open &&
          multiDeleteOpenAfter.count === 0 &&
          multiDeleteFiles.count === 0,
        `wafer multi open folder label delete failed=${JSON.stringify({ multiDeleteDialogs, multiDeleteOpenAfter, multiDeleteFiles })}`
      );

      await ensureLabelFolderOpen(classes.folderA, 2);
      await ensureLabelFolderOpen(classes.folderB, 2);
      const folderAOpenBeforeFolderDelete = await waitForOpenLabelFolderCount(classes.folderA, 2, 'gte');
      const folderBOpenBeforeFolderDelete = await waitForOpenLabelFolderCount(classes.folderB, 2);
      const folderDeleteSelection = await selectLabelFoldersViaUi('wafer', [classes.folderA, classes.folderB]);
      const folderAOpenSelectedBeforeDelete = await waitForOpenLabelFolderCount(classes.folderA, 2, 'gte');
      const folderBOpenSelectedBeforeDelete = await waitForOpenLabelFolderCount(classes.folderB, 2);
      const folderDeleteDialogs = await withAutoDialogs(async () => {
        await page.locator('#label-explorer-batch-delete-btn').click({ timeout: 10000 });
      });
      const folderAFilesAfterDelete = await waitForClassFileCount('wafer', classes.folderA, 0);
      const folderBFilesAfterDelete = await waitForClassFileCount('wafer', classes.folderB, 0);
      const folderAOpenAfterFolderDelete = await waitForOpenLabelFolderCount(classes.folderA, 0);
      const folderBOpenAfterFolderDelete = await waitForOpenLabelFolderCount(classes.folderB, 0);
      const folderClassesAfterLabelDelete = await getClassificationUiState([classes.folderA, classes.folderB, classes.labelAdd]);
      expect(
        folderAFilesAfterDelete.count === 0 &&
          folderBFilesAfterDelete.count === 0 &&
          folderAOpenAfterFolderDelete.open &&
          folderBOpenAfterFolderDelete.open &&
          folderAOpenAfterFolderDelete.count === 0 &&
          folderBOpenAfterFolderDelete.count === 0 &&
          [classes.folderA, classes.folderB, classes.labelAdd].every((name) => folderClassesAfterLabelDelete.present.includes(name)),
        `wafer folder label delete failed=${JSON.stringify({
          folderAFilesAfterDelete,
          folderBFilesAfterDelete,
          folderAOpenBeforeFolderDelete,
          folderBOpenBeforeFolderDelete,
          folderAOpenSelectedBeforeDelete,
          folderBOpenSelectedBeforeDelete,
          folderAOpenAfterFolderDelete,
          folderBOpenAfterFolderDelete,
          folderClassesAfterLabelDelete,
        })}`
      );

      return {
        classSingleAdd,
        classSingleDelete,
        classMultiAdd,
        classMultiDelete,
        classRenameAdd,
        classRename,
        labelAddFiles,
        addLabelDialogs: addLabelDialogs.dialogs,
        waferLabelClick,
        waferLabelPositions,
        chipClassFromWaferAdd,
        selectedChipsFromWaferLabel,
        chipFilesFromWaferLabel,
        folderAOpenBeforeAdd,
        openFolderAddDialogs: openFolderAddDialogs.dialogs,
        folderAOpenAfterAdd,
        singleFolderGrid,
        multiFolderGrid,
        multiFolderDetail,
        singleDeleteOpenBefore,
        singleDeleteButton,
        singleDeleteOpenAfter,
        singleDeleteFiles,
        multiLabelSelectedBeforeDelete,
        multiDeleteDialogs: multiDeleteDialogs.dialogs,
        multiDeleteFiles,
        folderDeleteSelection,
        folderDeleteDialogs: folderDeleteDialogs.dialogs,
        folderAFilesAfterDelete,
        folderBFilesAfterDelete,
        folderAOpenAfterFolderDelete,
        folderBOpenAfterFolderDelete,
        folderClassesAfterLabelDelete,
      };
    } finally {
      await cleanupClassFixtures('wafer', E2E_WAFER_LABEL_CRUD_CLASSES).catch((error) => {
        append(`[WARN] wafer label CRUD cleanup failed :: ${String(error?.message || error)}\n`);
      });
      await cleanupClassFixtures('chip', [classes.chipFromWaferLabel]).catch((error) => {
        append(`[WARN] wafer label chip cleanup failed :: ${String(error?.message || error)}\n`);
      });
    }
  });

  await record('43,44,49,50,57,60', 'Label Explorer / WF search / classification consistency', async () => {
    await boot('chunk3-label');
    const labelSeed = await ensureUnknownWaferLabelClasses();
    const labelData = await page.evaluate(async ({ primaryClass, secondaryClass }) => {
      const classNames = Array.from(
        document.querySelectorAll('.label-explorer-frame li > div')
      )
        .map((el) => (el.textContent || '').replace(/[▸▾]/g, '').trim())
        .filter(Boolean);
      const uniqueClasses = Array.from(new Set(classNames));
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
        images: (window.viewer.currentGridImages || []).slice(0, 12),
      };

      let multi = null;
      if (secondaryClass) {
        const targetClasses = [primaryClass, secondaryClass];
        await window.viewer.showGridFromMultipleClasses(targetClasses);
        await new Promise((r) => setTimeout(r, 1200));
        multi = {
          count: window.viewer.currentGridImages.length,
          wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
          classes: targetClasses,
          images: (window.viewer.currentGridImages || []).slice(0, 12),
        };
      }

      return {
        classes: uniqueClasses,
        primaryClass,
        single,
        multi,
      };
    }, labelSeed);

    await page.evaluate(async () => {
      if (!window.viewer.lotMode) {
        window.viewer.toggleLotMode();
        await new Promise((r) => setTimeout(r, 1200));
      }
    });
    const labelBefore = await waitForVisibleGridThumbsLoaded(12000, 500);
    const labelGridCols = await nudgeGridCols();
    await roundTripGridImageByDblClick(0);
    const labelAfter = await waitForVisibleGridThumbsLoaded(12000, 500);

    await page.evaluate(() => window.viewer.openWfSearchModal());
    await sleep(500);
    const wfVisible = await visible('#wf-search-modal');

    await boot('chunk3-label-clear');
    const labelClearTarget = await getPrimaryLabelClass();
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
    await loadFolder('unknown');
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
    expect(labelData.primaryClass === labelSeed.primaryClass, `label primary should use seeded unknown class=${JSON.stringify({ labelData, labelSeed })}`);
    expect(labelData.single.count > 0, `label single=${JSON.stringify(labelData.single)}`);
    expect(labelData.single.wraps > 0, `label single wraps=${JSON.stringify(labelData.single)}`);
    expect(
      labelData.single.images.every((imagePath) =>
        String(imagePath || '').replace(/\\/g, '/').includes(`classification/${labelSeed.primaryClass}/`)
      ),
      `label single used non-e2e class images=${JSON.stringify(labelData.single)}`
    );
    if (labelData.multi) {
      expect(labelData.multi.count >= labelData.single.count, `label multi=${JSON.stringify(labelData.multi)}`);
      expect(labelData.multi.wraps > 0, `label multi wraps=${JSON.stringify(labelData.multi)}`);
      expect(
        labelData.multi.classes.every((className) => E2E_UNKNOWN_LABEL_CLASSES.includes(className)),
        `label multi used non-e2e classes=${JSON.stringify(labelData.multi)}`
      );
    }
    expect(labelBefore.role === 'label', `label role=${labelBefore.role}`);
    expect(labelBefore.lotMode === true, `label lotMode=${labelBefore.lotMode}`);
    expect(labelBefore.lotHeaders > 0, `label lotHeaders=${labelBefore.lotHeaders}`);
    expect(labelBefore.badCount === 0, `label before=${JSON.stringify(labelBefore)}`);
    expect(labelAfter.badCount === 0, `label after=${JSON.stringify(labelAfter)}`);
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
      labelSeed,
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
    await loadFolder('unknown');
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
    const before = await waitForVisibleGridThumbsLoaded(12000, 500);
    const gridCols = await nudgeGridCols();
    await roundTripGridImageByDblClick(0);
    const after = await waitForVisibleGridThumbsLoaded(12000, 500);

    expect(before.role === 'mylot', `mylot role=${before.role}`);
    expect(before.lotMode === true, `mylot lotMode=${before.lotMode}`);
    expect(before.lotHeaders > 0, `mylot lotHeaders=${before.lotHeaders}`);
    expect(before.badCount === 0, `mylot before=${JSON.stringify(before)}`);
    expect(after.badCount === 0, `mylot after=${JSON.stringify(after)}`);
    expect(after.lotHeaders > 0, `mylot after lotHeaders=${after.lotHeaders}`);
    expect(gridCols.after.gridCols !== gridCols.before, `mylot gridCols ${gridCols.before}->${gridCols.after.gridCols}`);
    return { before, gridCols, after };
  });

  await record('46,52,53,54,55,58,59,61,62,63', '캐시 / 성능 / placeholder / highlight / 버전전파', async () => {
    await boot('chunk3-cache');
    const t0 = Date.now();
    await loadFolder('unknown');
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
    expect(data.fqCount === 5000, `fqCount=${data.fqCount}`);
    expect(data.wraps === 5000, `wraps=${data.wraps}`);
    expect(data.placeholders === 0, `placeholders=${data.placeholders}`);
    expect(fqLoadMs < 3000, `fqLoadMs too slow=${fqLoadMs}`);
    expect(!!data.mainEtag && !!data.cssEtag, `etag main=${data.mainEtag} css=${data.cssEtag}`);
    expect(data.mainHasVersionedImports, 'main versioned imports missing');
    const phase61_62Runs = [
      {
        run: 1,
        mode: 'existing-server-cache-performance-smoke',
        fqLoadMs,
        fqCount: data.fqCount,
        wraps: data.wraps,
        placeholders: data.placeholders,
        highlighted: data.highlighted,
        mainEtagPresent: !!data.mainEtag,
        cssEtagPresent: !!data.cssEtag,
        mainHasVersionedImports: data.mainHasVersionedImports,
        fetchOptimizerHasWorkerVersion: data.fetchOptimizerHasWorkerVersion,
        bitmapLoaderHasWorkerVersion: data.bitmapLoaderHasWorkerVersion,
      },
    ];
    const phase61_62Median = {
      fqLoadMs: median(phase61_62Runs.map((run) => run.fqLoadMs)),
    };
    const coldStartSummaryPath = writeJsonArtifact(PHASE_61_62_SUMMARY_FILE, {
      sessionId,
      baseUrl: base,
      generatedAt: new Date().toISOString(),
      source: path.basename(__filename),
      phase: '46,52,53,54,55,58,59,61,62,63',
      status: 'PASS',
      strictCold: false,
      note:
        'This summarizes the existing grouped cache/performance Phase that includes 61/62. It does not replace a separate 3-run strict cold restart benchmark.',
      runs: phase61_62Runs,
      median: phase61_62Median,
      thresholds: {
        fqLoadMs: {
          passMaxMs: 3000,
          reason: 'Grouped E2E smoke gate for immediate grid load in unknown.',
        },
      },
      assetCache: {
        mainScript: data.mainScript,
        cssHref: data.cssHref,
        mainEtag: data.mainEtag,
        cssEtag: data.cssEtag,
      },
    });
    return {
      ...data,
      fqLoadMs,
      coldStartSummary: {
        path: coldStartSummaryPath,
        strictCold: false,
        runs: phase61_62Runs.length,
        median: phase61_62Median,
      },
    };
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
