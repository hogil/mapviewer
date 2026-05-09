const fs = require('fs');
const path = require('path');
const { createRunner } = require('./e2e_playwright_session');

(async () => {
  const {
    base,
    browser,
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
  const unknownFolderAbs = path.join(imagesRoot, 'unknown');
  const E2E_UNKNOWN_LABEL_CLASSES = ['e2e_unknown_label', 'e2e_unknown_label_alt'];
  const E2E_CHIP_LABEL_CRUD_CLASSES = [
    'e2e_chip_class_single',
    'e2e_chip_class_multi_a',
    'e2e_chip_class_multi_b',
    'e2e_chip_label_add',
    'e2e_chip_label_single_delete',
    'e2e_chip_label_multi_delete',
    'e2e_chip_label_folder_a',
    'e2e_chip_label_folder_b',
  ];

  async function boot(tag) {
    append(`[BOOT] ${tag}\n`);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await focusWindow();
        await page.goto(`${base}/?${tag}=${Date.now()}&attempt=${attempt}`, {
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
        await sleep(1800);
        return;
      } catch (err) {
        lastError = err;
        const state = await page.evaluate(() => ({
          href: location.href,
          hasViewer: !!window.viewer,
          ready: window.__l3FullViewerReady === true,
          folderCount: document.querySelectorAll(
            '#file-explorer .folder, #file-explorer .folder-item'
          ).length,
          bodyText: document.body?.innerText?.slice(0, 160) || '',
        })).catch((stateErr) => ({ evaluateError: String(stateErr?.message || stateErr) }));
        append(`[BOOT_RETRY] ${tag} attempt=${attempt} state=${JSON.stringify(state)} err=${String(err?.message || err)}\n`);
        if (attempt >= 2) {
          break;
        }
        await sleep(1200);
      }
    }
    throw lastError;
  }

  async function record(phase, name, fn) {
    append(`[START] ${phase} ${name}\n`);
    try {
      const detail = await fn();
      results.push({ status: 'PASS', phase, name, detail });
      append(`[PASS] ${phase} ${name} :: ${JSON.stringify(detail)}\n`);
    } catch (err) {
      const detail = String(err && err.message ? err.message : err);
      results.push({
        status: 'FAIL',
        phase,
        name,
        detail,
      });
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
      v.updateGridSelection?.();
      v.flushGridSelectionUpdates?.();
    }, indices);
    await sleep(300);
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

  async function openLowContextSubmenu(kind) {
    const submenuSelector = kind === 'mc' ? '#context-mc-submenu' : '#context-mea-submenu';
    const triggerSelector = kind === 'mc' ? '#context-mc-create' : '#context-mea-create';
    await page.evaluate(() => window.viewer.hideContextMenu?.());
    const point = await page.evaluate(() => {
      const tab = document.getElementById('page-tab-bar')?.getBoundingClientRect();
      const grid = document.getElementById('image-grid')?.getBoundingClientRect();
      const limit = tab && tab.height > 0 ? tab.top : window.innerHeight;
      const x = Math.max(260, Math.min(window.innerWidth - 260, (grid?.left || 220) + 120));
      const y = Math.max(220, limit - 18);
      return { x, y };
    });
    await page.evaluate(({ x, y }) => {
      window.viewer.showContextMenu(
        {
          pageX: x + window.scrollX,
          pageY: y + window.scrollY,
          clientX: x,
          clientY: y,
          preventDefault() {},
          stopPropagation() {},
        },
        0
      );
    }, point);
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('grid-context-menu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    const trigger = page.locator(triggerSelector);
    const box = await trigger.boundingBox();
    expect(!!box, `${kind} low trigger missing`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(
      (selector) => getComputedStyle(document.querySelector(selector)).display !== 'none',
      submenuSelector,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      (selector) => document.querySelectorAll(`${selector} .failbit-item input[type="checkbox"]`).length > 0,
      submenuSelector,
      { timeout: 10000 }
    );
    await page.evaluate((selector) => {
      const item = Array.from(document.querySelectorAll(`${selector} .failbit-item`))
        .find((el) => el.querySelector('input[type="checkbox"]'));
      item?.click();
    }, submenuSelector);
    await sleep(200);
    return await page.evaluate((selector) => {
      const submenu = document.querySelector(selector);
      const tab = document.getElementById('page-tab-bar')?.getBoundingClientRect();
      const limit = tab && tab.height > 0 ? tab.top - 10 : window.innerHeight - 10;
      const rect = submenu.getBoundingClientRect();
      const button = submenu.querySelector('.mc-generate-btn, .measure-apply-btn');
      const buttonRect = button?.getBoundingClientRect();
      return {
        selector,
        limit,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        buttonText: button?.textContent || '',
        buttonTop: buttonRect?.top || 0,
        buttonBottom: buttonRect?.bottom || 0,
        buttonHeight: buttonRect?.height || 0,
        display: getComputedStyle(submenu).display,
      };
    }, submenuSelector);
  }

  async function openContextMcStateAtIndex(index) {
    await page.evaluate(() => window.viewer.hideContextMenu?.());
    append(`[CM] open mc state index=${index}\n`);
    const point = await page.evaluate((idx) => {
      const wrap = document.querySelectorAll('#image-grid .grid-thumb-wrap')[idx];
      const rect = wrap?.getBoundingClientRect();
      if (!rect) return null;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, index);
    expect(!!point, `grid wrap missing index=${index}`);
    await page.evaluate(({ x, y, index: idx }) => {
      window.viewer.showContextMenu(
        {
          pageX: x + window.scrollX,
          pageY: y + window.scrollY,
          clientX: x,
          clientY: y,
          preventDefault() {},
          stopPropagation() {},
        },
        idx
      );
    }, { ...point, index });
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('grid-context-menu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    append(`[CM] context opened index=${index}\n`);
    await page.evaluate(() => window.viewer._openMcContextSubmenu?.());
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('context-mc-submenu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    append(`[CM] mc submenu opened index=${index}\n`);
    const preCheckboxState = await page.evaluate(() => ({
      selectedForModal: window.viewer.getSelectedImagesForModal?.()?.length || 0,
      gridSelectedIdxs: [...(window.viewer.gridSelectedIdxs || [])],
      currentGridImages: window.viewer.currentGridImages?.length || 0,
      selectedImages: window.viewer.selectedImages?.length || 0,
      listText: document.querySelector('#context-mc-submenu .mc-ctx-list')?.innerText?.slice(0, 80) || '',
      itemCount: document.querySelectorAll('#context-mc-submenu .failbit-item').length,
      checkboxCount: document.querySelectorAll('#context-mc-submenu .failbit-item input[type="checkbox"]').length,
      cachedMcCtxKey: window.viewer._cachedMcCtxKey || '',
      cachedMcKeys: !!window.viewer._cachedMcKeys,
    }));
    append(`[CM] mc pre-checkbox index=${index} ${JSON.stringify(preCheckboxState)}\n`);
    await page.waitForFunction(
      () => document.querySelectorAll('#context-mc-submenu .failbit-item input[type="checkbox"]').length > 0,
      null,
      { timeout: 10000 }
    );
    append(`[CM] mc submenu checkboxes ready index=${index}\n`);
    await sleep(150);
    return await page.evaluate(() => {
      const panel = document.getElementById('context-mc-submenu');
      const button = panel?.querySelector('.mc-generate-btn');
      return {
        itemCount: document.querySelectorAll('#context-mc-submenu .failbit-item').length,
        checkedCount: document.querySelectorAll('#context-mc-submenu input[type="checkbox"]:checked').length,
        buttonText: button?.textContent || '',
        buttonDisabled: !!button?.disabled,
        gridSelectedIdxs: [...(window.viewer.gridSelectedIdxs || [])],
        selectedPanelDisplay: getComputedStyle(document.getElementById('selected-grid-images-panel')).display,
        selectedPanelCount: document.getElementById('selected-count-badge')?.textContent || '',
      };
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

  async function fetchJson(targetPage, relativeUrl) {
    return await targetPage.evaluate(async (url) => {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(`${url} status=${response.status}`);
      }
      return await response.json();
    }, relativeUrl);
  }

  function encodeParams(params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, value);
    }
    return searchParams.toString();
  }

  function parseLotWaferFromPath(imagePath) {
    const name = String(imagePath || '').replace(/\\/g, '/').split('/').pop() || '';
    const parts = name.split('_');
    return {
      path: imagePath,
      lot: (parts[0] || '').toLowerCase(),
      wafer: (parts[2] || '').toLowerCase(),
    };
  }

  function parseUnknownFileRow(imagePath) {
    const normalized = normalizeResultPath(imagePath);
    const name = String(normalized || '').replace(/\\/g, '/').split('/').pop() || '';
    const stem = name.replace(/\.[^.]+$/, '');
    const parts = stem.split('_');
    return {
      path: normalized,
      lot: (parts[0] || '').toLowerCase(),
      bintype: (parts[1] || '').toLowerCase(),
      wafer: (parts[2] || '').toLowerCase(),
      grade: (parts[6] || '').toLowerCase(),
      type: (parts[7] || '').toLowerCase(),
      status: (parts[8] || '').toLowerCase(),
    };
  }

  function normalizeResultPath(rawPath) {
    const normalized = String(rawPath || '').replace(/\\/g, '/');
    if (!normalized.includes(':/')) {
      return normalized;
    }
    const parts = normalized.split('/');
    const markerIdx = parts.indexOf('wm-811k');
    return markerIdx >= 0 && markerIdx + 1 < parts.length
      ? parts.slice(markerIdx + 1).join('/')
      : normalized;
  }

  function resultLots(results) {
    return Array.from(new Set(
      (results || []).map((imagePath) => parseLotWaferFromPath(imagePath).lot).filter(Boolean)
    )).sort();
  }

  function assertUnknownSearchResult(scenario, data, expectedLots = [], expectedPrefix = '') {
    expect(data.success === true, `${scenario} success=${JSON.stringify(data).slice(0, 500)}`);
    const results = (data.results || []).map(normalizeResultPath);
    expect(results.length > 0, `${scenario} empty results`);
    expect(
      results.every((imagePath) => imagePath.startsWith('unknown/')),
      `${scenario} outsideUnknown=${JSON.stringify(results.filter((imagePath) => !imagePath.startsWith('unknown/')).slice(0, 8))}`
    );
    expect(
      (data.timings?.search_prefix || '') === expectedPrefix,
      `${scenario} not global prefix=${JSON.stringify(data.timings || {})}`
    );
    const lots = resultLots(results);
    for (const lot of expectedLots) {
      expect(lots.includes(lot), `${scenario} missing lot=${lot} lots=${JSON.stringify(lots)}`);
    }
    return {
      count: results.length,
      total: data.total,
      firstPath: results[0],
      lots,
      searchMode: data.timings?.search_mode || null,
      searchPrefix: data.timings?.search_prefix || '',
      totalMs: data.timings?.total_ms ?? null,
      logicalEvalMs: data.timings?.logical_eval_ms ?? null,
    };
  }

  async function findUnknownGlobalSearchFixtures(limit = 3) {
    const recursive = await fetchJson(page, '/api/files/recursive?path=unknown&limit=5000');
    const candidates = Array.from(new Map(
      (recursive.files || [])
        .filter((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/'))
        .map((imagePath) => {
          const fixture = parseLotWaferFromPath(imagePath);
          return fixture.lot && fixture.wafer ? [fixture.lot, fixture] : null;
        })
        .filter(Boolean)
    ).values());
    const fixtures = [];
    for (const candidate of candidates) {
      const data = await fetchJson(
        page,
        `/api/search?${encodeParams({ q: candidate.lot, folder: '', limit: '10000' })}`
      );
      const results = (data.results || []).map(normalizeResultPath);
      if (
        data.success === true &&
        results.length > 0 &&
        results.every((imagePath) => imagePath.startsWith('unknown/'))
      ) {
        fixtures.push({
          ...candidate,
          globalCount: results.length,
          firstGlobalPath: results[0],
        });
      }
      if (fixtures.length >= limit) {
        break;
      }
    }
    expect(fixtures.length >= limit, `unknown global search fixtures=${JSON.stringify(fixtures)}`);
    return fixtures;
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
        pushUnique(files.find((imagePath) =>
          (imagePath.split('/').pop() || '').toUpperCase().startsWith(`${lot}_`)
        ));
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

  async function ensureChipLabelPrefixFixture() {
    return await page.evaluate(async ({ imagesRoot }) => {
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
        body: JSON.stringify({ path: imagesRoot }),
      });
      const v = window.viewer;
      if (v) {
        v.currentFolderPath = folderData.current_folder;
        v.currentFolderPrefix = folderData.current_folder_prefix || '';
        v.productFolderPath = folderData.current_folder;
        v.markFolderContextChanged?.('e2e-chip-label-prefix-fixture');
      }

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

      const preferredLots = ['AAB301', 'AAK170', 'AAN585', 'AAS114', 'AAV840'];
      const ordered = [];
      const pushUnique = (imagePath) => {
        if (imagePath && !ordered.includes(imagePath)) ordered.push(imagePath);
      };
      for (const lot of preferredLots) {
        pushUnique(files.find((imagePath) =>
          (imagePath.split('/').pop() || '').toUpperCase().startsWith(`${lot}_`)
        ));
      }
      for (const imagePath of files) {
        pushUnique(imagePath);
      }

      const requiredChipCount = 15;
      let fixture = null;
      for (const imagePath of ordered) {
        const positions = await jsonRequest(`/api/chip-positions?path=${encodeURIComponent(imagePath)}`);
        const chips = (positions.chips || [])
          .filter((chip) =>
            Number.isFinite(Number(chip?.x_abs)) &&
            Number.isFinite(Number(chip?.y_abs)) &&
            chip?.rect
          )
          .slice(0, requiredChipCount);
        if (chips.length >= requiredChipCount) {
          fixture = { imagePath, chips };
          break;
        }
      }
      if (!fixture) {
        throw new Error(`chip label prefix fixture unavailable: ${JSON.stringify({ files: files.length })}`);
      }

      const classSpecs = [
        { name: 'scratch', count: 5 },
        { name: 'bank_boundary', count: 4 },
        { name: 'scratch_rot', count: 3 },
        { name: 'fork', count: 2 },
        { name: 'invalid_main', count: 1 },
      ];

      let cursor = 0;
      const seeded = [];
      for (const spec of classSpecs) {
        const coords = fixture.chips.slice(cursor, cursor + spec.count)
          .map((chip) => ({ x_abs: Number(chip.x_abs), y_abs: Number(chip.y_abs) }));
        cursor += spec.count;
        const body = await jsonRequest('/api/classify/chips', {
          method: 'POST',
          body: JSON.stringify({
            class_name: spec.name,
            image_path: fixture.imagePath,
            chip_coords: coords,
          }),
        });
        if ((body.saved_count || 0) !== coords.length || body.error_count) {
          throw new Error(`chip fixture seed incomplete ${spec.name}: ${JSON.stringify(body).slice(0, 500)}`);
        }
        seeded.push({
          className: spec.name,
          coords,
          savedFiles: body.saved_files || [],
        });
      }

      const bank = seeded.find((item) => item.className === 'bank_boundary');
      const scratch = seeded.find((item) => item.className === 'scratch');
      const bankFile = bank?.savedFiles?.[0];
      const scratchFile = scratch?.savedFiles?.[0];
      if (!bankFile || !scratchFile) {
        throw new Error(`chip fixture missing saved files: ${JSON.stringify(seeded).slice(0, 500)}`);
      }

      const waferName = fixture.imagePath.split('/').pop() || '';
      const fullStem = waferName.replace(/\.[^.]+$/, '');
      const waferKey = fullStem.split('_').slice(0, 5).join('_');
      const folderName = fixture.imagePath.split('/').slice(-2, -1)[0] || '';
      const withPrefix = (className, filename) => `classification_chips/${className}/${filename}`;
      const labelKey = `bank_boundary/${bankFile.filename}`;
      const chipPath = withPrefix('bank_boundary', bankFile.filename);
      const chipPaths = [
        chipPath,
        withPrefix('scratch', scratchFile.filename),
      ];

      const annotations = await jsonRequest(`/api/chip-annotations?path=${encodeURIComponent(fixture.imagePath)}`);
      const marked = annotations.marked_chips || [];
      const missingClasses = classSpecs
        .map((spec) => spec.name)
        .filter((className) => !marked.some((chip) => chip.class === className));
      if (missingClasses.length) {
        throw new Error(`chip fixture annotations missing: ${JSON.stringify({ missingClasses, markedCount: marked.length })}`);
      }

      return {
        waferPath: fixture.imagePath,
        chipPath,
        labelKey,
        fullStem,
        waferKey,
        folderName,
        chipPaths,
        primary: {
          className: 'bank_boundary',
          x_abs: bankFile.x_abs,
          y_abs: bankFile.y_abs,
          b: String(bankFile.b),
        },
        seeded,
        markedCount: marked.length,
      };
    }, { imagesRoot });
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

  async function installClipboardCapture() {
    await page.evaluate(() => {
      window.__e2eClipboard = {
        textWrites: [],
        imageWrites: [],
      };

      if (!window.ClipboardItem) {
        window.ClipboardItem = class ClipboardItem {
          constructor(items) {
            this._items = items || {};
            this.types = Object.keys(this._items);
          }

          async getType(type) {
            return this._items[type];
          }
        };
      }

      const clipboard = {
        async writeText(text) {
          window.__e2eClipboard.textWrites.push(String(text ?? ''));
        },
        async write(items) {
          const records = [];
          for (const item of items || []) {
            const types = Array.from(item?.types || []);
            const type = types[0] || 'image/png';
            let blob = null;
            if (typeof item?.getType === 'function') {
              blob = await item.getType(type);
            } else if (item?._items && item._items[type]) {
              blob = await Promise.resolve(item._items[type]);
            }
            records.push({
              types,
              type: blob?.type || type,
              size: Number(blob?.size || 0),
            });
          }
          window.__e2eClipboard.imageWrites.push(...records);
        },
      };

      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: clipboard,
        });
      } catch (_) {
        navigator.clipboard = clipboard;
      }
    });
  }

  async function readClipboardCapture() {
    return await page.evaluate(() => ({
      textWrites: [...(window.__e2eClipboard?.textWrites || [])],
      imageWrites: [...(window.__e2eClipboard?.imageWrites || [])],
    }));
  }

  async function installHtml2CanvasStub() {
    await page.evaluate(() => {
      window.html2canvas = async (_element, options = {}) => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(Number(options.width) || 96));
        canvas.height = Math.max(1, Math.round(Number(options.height) || 96));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#39a8ff';
        ctx.fillRect(0, 0, Math.min(24, canvas.width), Math.min(24, canvas.height));
        return canvas;
      };
    });
  }

  async function openGridContextAtIndex(index = 0) {
    await page.evaluate(() => window.viewer?.hideContextMenu?.());
    const wrap = page.locator('#image-grid .grid-thumb-wrap').nth(index);
    const box = await wrap.boundingBox({ timeout: 10000 }).catch(() => null);
    expect(!!box, `grid context target missing index=${index}`);
    await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(40, box.height / 2));
    await page.mouse.click(
      box.x + Math.min(40, box.width / 2),
      box.y + Math.min(40, box.height / 2),
      { button: 'right' }
    );
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('grid-context-menu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    await sleep(150);
    return await page.evaluate(() => ({
      text: document.getElementById('grid-context-menu')?.innerText || '',
      targetPath: window.viewer?.contextMenuTargetPath || null,
      gridSelectedIdxs: [...(window.viewer?.gridSelectedIdxs || [])],
    }));
  }

  async function openSingleContextMenuOnCanvas() {
    await page.evaluate(() => {
      window.viewer?.hideSingleContextMenu?.();
      document.getElementById('chip-context-menu')?.remove();
    });
    const canvasBox = await page.locator('#image-canvas').boundingBox({ timeout: 10000 }).catch(() => null);
    expect(!!canvasBox, 'single context target canvas missing');
    const x = canvasBox.x + Math.min(80, canvasBox.width / 2);
    const y = canvasBox.y + Math.min(80, canvasBox.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.click(x, y, { button: 'right' });
    await page.waitForFunction(
      () => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        return isVisible(document.getElementById('single-context-menu')) || isVisible(document.getElementById('chip-context-menu'));
      },
      null,
      { timeout: 10000 }
    );
    await sleep(150);
    return await page.evaluate(() => ({
      ...(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const singleMenu = document.getElementById('single-context-menu');
        const chipMenu = document.getElementById('chip-context-menu');
        const menu = isVisible(singleMenu) ? singleMenu : chipMenu;
        return {
          menuId: menu?.id || null,
          text: menu?.innerText || '',
        };
      })(),
      selectedImagePath: window.viewer?.selectedImagePath || null,
      currentImagePath: window.viewer?.currentImagePath || null,
      visible: true,
    }));
  }

  async function clickVisibleContextMenuItem(text) {
    await page.locator('.context-menu:visible .context-menu-item', { hasText: text }).last().click({ timeout: 10000 });
  }

  async function collectDownloadsForAction(expectedCount, action, timeoutMs = 45000) {
    const downloads = [];
    const handler = (download) => {
      downloads.push(download);
    };
    page.on('download', handler);
    try {
      await action();
      const started = Date.now();
      while (downloads.length < expectedCount && Date.now() - started < timeoutMs) {
        await sleep(200);
      }
      return await Promise.all(
        downloads.map(async (download) => ({
          suggestedFilename: download.suggestedFilename(),
          pathExists: !!(await download.path().catch(() => null)),
        }))
      );
    } finally {
      page.off('download', handler);
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
        v.markFolderContextChanged?.('e2e-chip-label-crud-cleanup');
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

  async function getClassificationUiState(classNames = []) {
    return await page.evaluate((names) => {
      const classButtons = Array.from(document.querySelectorAll('#class-list button'))
        .map((button) => (button.textContent || '').trim());
      const labelFolders = Array.from(document.querySelectorAll('#label-explorer-list li > div'))
        .map((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim());
      return {
        classMode: window.viewer?.classMode || null,
        selectedClasses: [...(window.viewer?.classSelection?.selected || [])],
        labelSelectedClasses: [...(window.viewer?.labelSelection?.selectedClasses || [])],
        present: names.filter((name) => classButtons.includes(name)),
        absent: names.filter((name) => !classButtons.includes(name)),
        labelPresent: names.filter((name) => labelFolders.includes(name)),
      };
    }, classNames);
  }

  async function addClassesViaUi(mode, classNames) {
    await setClassModeUi(mode);
    await page.locator('#new-class-input').fill(classNames.join(','));
    const readAddState = async (label) => await page.evaluate(async ({ expectedMode, names, stateLabel }) => {
      const response = await fetch(`/api/classes?mode=${encodeURIComponent(expectedMode)}`, { cache: 'no-store' });
      const body = response.ok ? await response.json() : { classes: [], status: response.status };
      return {
        label: stateLabel,
        classMode: window.viewer?.classMode || null,
        inputValue: document.getElementById('new-class-input')?.value || '',
        addDisabled: !!document.getElementById('add-class-btn')?.disabled,
        addText: document.getElementById('add-class-btn')?.textContent || '',
        deleteDisabled: !!document.getElementById('delete-class-btn')?.disabled,
        isRefreshingLabelExplorer: !!window.viewer?._isRefreshingLabelExplorer,
        pendingLabelExplorerRefresh: !!window.viewer?._pendingLabelExplorerRefresh,
        cachedClassList: Array.isArray(window.viewer?.cachedClassList)
          ? window.viewer.cachedClassList.filter((name) => names.includes(name))
          : null,
        classListPromise: !!window.viewer?.classListPromise,
        currentFolderVersion: window.viewer?.currentFolderVersion || 0,
        classSelection: [...(window.viewer?.classSelection?.selected || [])],
        classButtons: Array.from(document.querySelectorAll('#class-list button'))
          .map((button) => (button.textContent || '').trim())
          .filter((text) => names.includes(text)),
        apiClasses: (body.classes || []).filter((name) => names.includes(name)),
        labelFolders: Array.from(document.querySelectorAll('#label-explorer-list li > div'))
          .map((node) => (node.textContent || '').replace(/[▸▾]/g, '').trim())
          .filter((text) => names.includes(text)),
      };
    }, { expectedMode: mode, names: classNames, stateLabel: label });
    const addDialogs = await withAutoDialogs(async () => {
      await page.locator('#add-class-btn').click({ timeout: 10000 });
    });
    try {
      await page.waitForFunction(
        async ({ expectedMode, names }) => {
          const classButtons = Array.from(document.querySelectorAll('#class-list button'))
            .map((button) => (button.textContent || '').trim());
          const response = await fetch(`/api/classes?mode=${encodeURIComponent(expectedMode)}`, { cache: 'no-store' });
          if (!response.ok) return false;
          const body = await response.json();
          const apiClasses = Array.isArray(body.classes) ? body.classes : [];
          return names.every((name) => classButtons.includes(name) && apiClasses.includes(name));
        },
        { expectedMode: mode, names: classNames },
        { timeout: 20000 }
      );
    } catch (error) {
      const failedState = await readAddState('timeout');
      append(`[CLASS_UI_ADD_TIMEOUT] ${mode} ${classNames.join(',')} :: ${JSON.stringify(failedState)} err=${String(error?.message || error)}\n`);
      throw new Error(`class UI add timeout mode=${mode} names=${classNames.join(',')} state=${JSON.stringify(failedState)} dialogs=${JSON.stringify(addDialogs.dialogs)}`);
    }
    await refreshClassificationUi(mode, classNames);
    return {
      ...(await getClassificationUiState(classNames)),
      addDialogs: addDialogs.dialogs,
    };
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

  async function seedChipLabelClasses(waferPath, classToCoords) {
    await page.evaluate(async ({ targetWaferPath, classMap }) => {
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
      for (const [className, coords] of Object.entries(classMap)) {
        const createResponse = await fetch('/api/classes?mode=chip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: className }),
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!createResponse.ok && createResponse.status !== 409) {
          throw new Error(`/api/classes create chip ${className} status=${createResponse.status}`);
        }
        if (coords.length > 0) {
          await jsonRequest('/api/classify/chips?mode=chip', {
            method: 'POST',
            body: JSON.stringify({
              class_name: className,
              image_path: targetWaferPath,
              chip_coords: coords,
              folder_prefix: window.viewer?.currentFolderPrefix || '',
            }),
          });
        }
      }
      const v = window.viewer;
      if (v) {
        v.classMode = 'chip';
        v.cachedClassList = null;
        v.classListPromise = null;
        v.classToImgListCache = {};
        await v.refreshClassList?.(true);
        await v.refreshLabelExplorer?.(Object.keys(classMap));
      }
    }, { targetWaferPath: waferPath, classMap: classToCoords });
    await sleep(1200);
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

  async function getLabelExplorerState() {
    return await page.evaluate(() => ({
      selected: [...(window.viewer.labelSelection?.selected || [])],
      selectedClasses: [...(window.viewer.labelSelection?.selectedClasses || [])],
      gridMode: !!window.viewer.gridMode,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      currentGridImages: window.viewer.currentGridImages?.length || 0,
      role: window.viewer.pageManager?.getActivePage?.()?.role || null,
      labelGrid: !!document.getElementById('image-grid')?.hasAttribute('data-label-explorer-grid'),
    }));
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

  async function waitForLabelGridVisible(minCount = 1) {
    await page.waitForFunction(
      (minimum) => {
        const v = window.viewer;
        const grid = document.getElementById('image-grid');
        const wrapper = grid?.closest('.grid-scroll-wrapper') || grid?.parentElement;
        const first = grid?.querySelector('.grid-thumb-wrap');
        const firstRect = first?.getBoundingClientRect?.();
        return v?.gridMode === true &&
          v?.pageManager?.getActivePage?.()?.role === 'label' &&
          (v.currentGridImages?.length || 0) >= minimum &&
          !!grid &&
          !!wrapper &&
          grid.hasAttribute('data-label-explorer-grid') &&
          getComputedStyle(grid).display !== 'none' &&
          getComputedStyle(wrapper).display !== 'none' &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length >= minimum &&
          (firstRect?.width || 0) > 0 &&
          (firstRect?.height || 0) > 0;
      },
      minCount,
      { timeout: 30000 }
    );
    await sleep(1000);
    return await getLabelExplorerState();
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
    return await waitForLabelGridVisible(classNames.length);
  }

  async function openChipWaferSingle(waferPath) {
    await page.evaluate(async (targetPath) => {
      const v = window.viewer;
      await v.enterSingleViewMode(targetPath);
    }, waferPath);
    await page.waitForFunction(
      (targetPath) => {
        const v = window.viewer;
        return !!v &&
          v.gridMode === false &&
          v.viewMode === 'single' &&
          String(v.selectedImagePath || '').replace(/\\/g, '/').toLowerCase() === targetPath.toLowerCase() &&
          Array.isArray(v.chipAnnotator?.chips) &&
          v.chipAnnotator.chips.length > 0;
      },
      waferPath.toLowerCase(),
      { timeout: 90000 }
    );
    await sleep(1200);
  }

  async function selectVisibleChips(count) {
    return await page.evaluate((requiredCount) => {
      const annotator = window.viewer?.chipAnnotator;
      const chips = annotator?.chips || [];
      const selected = [];
      for (let i = 0; i < chips.length && selected.length < requiredCount; i += 1) {
        const chip = chips[i];
        if (Number.isFinite(Number(chip?.x_abs)) && Number.isFinite(Number(chip?.y_abs))) {
          selected.push(i);
        }
      }
      if (selected.length < requiredCount) {
        throw new Error(`not enough selectable chips: ${JSON.stringify({ requiredCount, selected, total: chips.length })}`);
      }
      annotator.selectedChips = new Set(selected);
      annotator.selectedChipsOrder = selected;
      annotator.updateSelectedChipsList?.();
      annotator.render?.();
      return {
        selected,
        coords: selected.map((idx) => ({
          x_abs: Number(chips[idx].x_abs),
          y_abs: Number(chips[idx].y_abs),
        })),
      };
    }, count);
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

  await boot('chunk1');

  await record('1', '페이지 로드 & 기본 UI', async () => {
    const data = await page.evaluate(() => ({
      title: document.title,
      folderCount: document.querySelectorAll(
        '#file-explorer .folder, #file-explorer .folder-item'
      ).length,
      hasUnknownFolder: Array.from(document.querySelectorAll(
        '#file-explorer .folder, #file-explorer .folder-item'
      )).some((node) => (node.textContent || '').includes('unknown')),
      classListExists: !!document.querySelector('#class-list'),
      classCount: document.querySelectorAll('#class-list .class-btn').length,
    }));
    expect(data.title === 'Wafer Map Viewer', `title=${data.title}`);
    expect(data.hasUnknownFolder, `folder explorer missing unknown: ${JSON.stringify(data)}`);
    expect(data.classListExists, 'class-list missing');
    return data;
  });

  await record('2,5,31', 'unknown 그리드/범례', async () => {
    await loadFolder('unknown');
    const data = await page.evaluate(() => ({
      count: window.viewer.currentGridImages.length,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      firstPath: window.viewer.currentGridImages?.[0] || '',
      unknownCount: window.viewer.currentGridImages
        .filter((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/')).length,
      legendTop: (
        document.getElementById('color-legend-top')?.innerText || ''
      ).replace(/\s+/g, ' '),
    }));
    expect(data.count > 0, `count=${data.count}`);
    expect(data.wraps === data.count, `wraps=${data.wraps} count=${data.count}`);
    expect(data.unknownCount === data.count, `unknownCount=${data.unknownCount} count=${data.count}`);
    expect(
      /(Grade0|G0)/.test(data.legendTop) && /(Grade7|G7)/.test(data.legendTop),
      `legend=${data.legendTop}`
    );
    return data;
  });

  await record('3,51', '검색 카운트', async () => {
    await boot('chunk1-search');
    const [a, b] = await findUnknownGlobalSearchFixtures(2);
    const scenarios = [
      { query: a.lot, expectedLots: [a.lot] },
      { query: `${a.lot} or ${b.lot}`, expectedLots: [a.lot, b.lot] },
      { query: `${a.lot} and ${a.wafer}`, expectedLots: [a.lot] },
    ];
    const counts = {};
    for (const scenario of scenarios) {
      const expected = assertUnknownSearchResult(
        `search-count api ${scenario.query}`,
        await fetchJson(page, `/api/search?${encodeParams({ q: scenario.query, folder: '', limit: '10000' })}`),
        scenario.expectedLots
      );
      await page.evaluate((query) => {
        const input = document.getElementById('file-search');
        const btn = document.getElementById('search-btn');
        if (input) input.value = query;
        btn?.click();
      }, scenario.query);
      await page.waitForFunction(
        (expectedCount) => {
          const btn = document.getElementById('search-btn');
          const count = window.viewer?.currentGridImages?.length ?? -1;
          return !btn?.disabled && count === expectedCount;
        },
        expected.count,
        { timeout: 30000 }
      );
      const images = (await page.evaluate(() => window.viewer.currentGridImages || []))
        .map(normalizeResultPath);
      expect(
        images.every((imagePath) => imagePath.startsWith('unknown/')),
        `${scenario.query} outsideUnknown=${JSON.stringify(images.filter((imagePath) => !imagePath.startsWith('unknown/')).slice(0, 8))}`
      );
      const lots = resultLots(images);
      for (const lot of scenario.expectedLots) {
        expect(lots.includes(lot), `${scenario.query} missing lot=${lot} lots=${JSON.stringify(lots)}`);
      }
      counts[scenario.query] = images.length;
    }
    return counts;
  });

  await record('3u', 'unknown LOT 전역 검색', async () => {
    await boot('chunk1-search-unknown-global');
    const fixtures = await findUnknownGlobalSearchFixtures(3);
    const [a, b, c] = fixtures;
    const scenarios = [
      {
        name: 'api exact q',
        params: { q: a.lot, folder: '', limit: '10000' },
        expectedLots: [a.lot],
      },
      {
        name: 'api logical or',
        params: { q: `${a.lot} or ${b.lot}`, folder: '', limit: '10000' },
        expectedLots: [a.lot, b.lot],
      },
      {
        name: 'api whitespace multi',
        params: { q: `${a.lot} ${b.lot}`, folder: '', limit: '10000' },
        expectedLots: [a.lot, b.lot],
      },
      {
        name: 'api comma multi',
        params: { q: `${a.lot},${b.lot},${c.lot}`, folder: '', limit: '10000' },
        expectedLots: [a.lot, b.lot, c.lot],
      },
      {
        name: 'api lot_multi',
        params: { q: '', lot_multi: `${a.lot},${b.lot}`, folder: '', limit: '10000' },
        expectedLots: [a.lot, b.lot],
      },
      {
        name: 'api lot_wafer',
        params: { q: '', lot_wafer: `${a.lot}:${a.wafer},${b.lot}:${b.wafer}`, folder: '', limit: '10000' },
        expectedLots: [a.lot, b.lot],
      },
    ];
    const apiResults = {};
    for (const scenario of scenarios) {
      const data = await fetchJson(page, `/api/search?${encodeParams(scenario.params)}`);
      apiResults[scenario.name] = assertUnknownSearchResult(
        scenario.name,
        data,
        scenario.expectedLots
      );
    }

    await page.evaluate(() => {
      const v = window.viewer;
      v.selectedImages = [];
      v.selectedFolders = new Set();
      v.lastSelectedFolder = null;
      v.lastSelectedFolderPath = null;
      v.lastLoadedGridFolderPath = '';
      v.currentFolderPrefix = '';
      const input = document.getElementById('file-search');
      if (input) input.value = '';
    });
    await page.fill('#file-search', a.lot);
    await page.click('#search-btn');
    await page.waitForFunction(
      (expectedLot) => {
        const btn = document.getElementById('search-btn');
        const images = Array.isArray(window.viewer?.currentGridImages)
          ? window.viewer.currentGridImages.map((imagePath) => String(imagePath || '').replace(/\\/g, '/'))
          : [];
        return (
          !btn?.disabled &&
          window.viewer?.gridMode === true &&
          images.length > 0 &&
          images.every((imagePath) => imagePath.startsWith('unknown/')) &&
          images.some((imagePath) => imagePath.split('/').pop().toLowerCase().startsWith(`${expectedLot}_`)) &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0
        );
      },
      a.lot,
      { timeout: 45000 }
    );
    const uiResult = await page.evaluate(() => {
      const images = (window.viewer.currentGridImages || [])
        .map((imagePath) => String(imagePath || '').replace(/\\/g, '/'));
      return {
        count: images.length,
        firstPath: images[0],
        unknownCount: images.filter((imagePath) => imagePath.startsWith('unknown/')).length,
        lots: Array.from(new Set(images.map((imagePath) => (
          (imagePath.split('/').pop() || '').split('_')[0].toLowerCase()
        )).filter(Boolean))).sort(),
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
        selectedFolders: [...(window.viewer.selectedFolders || [])],
        lastLoadedGridFolderPath: window.viewer.lastLoadedGridFolderPath || '',
      };
    });
    expect(uiResult.unknownCount === uiResult.count, `ui outsideUnknown=${JSON.stringify(uiResult)}`);
    expect(uiResult.lots.includes(a.lot), `ui lots=${JSON.stringify(uiResult)}`);
    return {
      fixtures,
      apiResults,
      uiResult,
    };
  });

  await record('3v', 'unknown 실제 파일명 기반 text 검색', async () => {
    await boot('chunk1-search-diverse-text');
    const recursive = await fetchJson(page, '/api/files/recursive?path=unknown&limit=10000');
    const rows = (recursive.files || [])
      .map(parseUnknownFileRow)
      .filter((row) => row.path.startsWith('unknown/') && row.lot && row.wafer);
    expect(rows.length >= 1000, `unknown rows too small=${rows.length}`);

    const rowsByLot = new Map();
    for (const row of rows) {
      if (!rowsByLot.has(row.lot)) {
        rowsByLot.set(row.lot, row);
      }
    }

    const fixtures = await findUnknownGlobalSearchFixtures(3);
    const [a, b, c] = fixtures.map((fixture) => ({
      ...(rowsByLot.get(fixture.lot) || {}),
      ...fixture,
    }));
    expect(a?.lot && b?.lot && c?.lot, `fixtures=${JSON.stringify(fixtures)}`);

    const byPrefix = new Map();
    for (const row of rowsByLot.values()) {
      if (!row.lot || row.lot.length < 3) continue;
      const prefix = row.lot.slice(0, 3);
      const list = byPrefix.get(prefix) || [];
      list.push(row);
      byPrefix.set(prefix, list);
    }
    const prefixEntry = Array.from(byPrefix.entries())
      .filter(([, list]) => list.length >= 2 && list.length <= 50)
      .sort((left, right) => left[1].length - right[1].length || left[0].localeCompare(right[0]))[0];
    expect(prefixEntry, `prefixEntry missing prefixCount=${byPrefix.size}`);
    const [prefix, prefixRows] = prefixEntry;
    const prefixLots = prefixRows.map((row) => row.lot).sort();
    const excludedPrefixLot = prefixLots[0];
    const keptPrefixLots = prefixLots.filter((lot) => lot !== excludedPrefixLot);

    const RUNS = 3;
    const roundMs = (value) => Math.round(Number(value || 0) * 10) / 10;
    const summarizeNumbers = (values) => {
      const nums = values.map(Number).filter((value) => Number.isFinite(value));
      if (!nums.length) {
        return { n: 0, avg: null, stddev: null, min: null, max: null, spread: null, values: [] };
      }
      const avg = nums.reduce((sum, value) => sum + value, 0) / nums.length;
      const variance = nums.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / nums.length;
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      return {
        n: nums.length,
        avg: roundMs(avg),
        stddev: roundMs(Math.sqrt(variance)),
        min: roundMs(min),
        max: roundMs(max),
        spread: roundMs(max - min),
        values: nums.map(roundMs),
      };
    };
    const compactResult = (results) => {
      const normalized = (results || []).map(normalizeResultPath);
      const lots = resultLots(normalized);
      return {
        count: normalized.length,
        firstPath: normalized[0] || '',
        lotsSample: lots.slice(0, 8),
        lotCount: lots.length,
      };
    };
    const validateExpectedLots = (label, results, expectedLots) => {
      const lots = resultLots(results);
      const missing = expectedLots.filter((lot) => !lots.includes(lot));
      expect(missing.length === 0, `${label} missing lots=${JSON.stringify(missing.slice(0, 12))}`);
      expect(
        results.every((imagePath) => imagePath.startsWith('unknown/')),
        `${label} outsideUnknown=${JSON.stringify(results.filter((imagePath) => !imagePath.startsWith('unknown/')).slice(0, 8))}`
      );
      return { lots, missing };
    };
    const runApiRepeated = async (scenario) => {
      const runs = [];
      for (let i = 0; i < RUNS; i += 1) {
        const data = await fetchJson(page, `/api/search?${encodeParams(scenario.params)}`);
        const results = (data.results || []).map(normalizeResultPath);
        const summary = assertUnknownSearchResult(
          `${scenario.name} run=${i + 1}`,
          data,
          scenario.expectedLots,
          scenario.expectedPrefix
        );
        scenario.validate?.(results, data);
        runs.push({
          count: summary.count,
          total: summary.total,
          totalMs: data.timings?.total_ms ?? null,
          logicalEvalMs: data.timings?.logical_eval_ms ?? null,
          searchMode: data.timings?.search_mode || null,
          liveFallbackInvoked: !!data.timings?.live_fallback_invoked,
          liveFallbackHits: data.timings?.live_fallback_hits ?? 0,
          liveFallbackScanMs: data.timings?.live_fallback_scan_ms ?? null,
          liveFallbackFilesScanned: data.timings?.live_fallback_files_scanned ?? null,
          liveFallbackDirsScanned: data.timings?.live_fallback_dirs_scanned ?? null,
          liveFallbackMissingLots: data.timings?.live_fallback_missing_lots || [],
          liveFallbackFoundLots: data.timings?.live_fallback_found_lots || [],
          firstPath: summary.firstPath,
        });
      }
      const counts = runs.map((run) => run.count);
      expect(
        counts.every((count) => count === counts[0]),
        `${scenario.name} unstable counts=${JSON.stringify(counts)}`
      );
      return {
        count: runs[0].count,
        total: runs[0].total,
        searchMode: runs[0].searchMode,
        firstPath: runs[0].firstPath,
        apiTotalMs: summarizeNumbers(runs.map((run) => run.totalMs)),
        logicalEvalMs: summarizeNumbers(runs.map((run) => run.logicalEvalMs)),
        liveFallback: {
          invoked: runs.some((run) => run.liveFallbackInvoked),
          hits: Math.max(...runs.map((run) => Number(run.liveFallbackHits || 0))),
          scanMs: summarizeNumbers(runs.map((run) => run.liveFallbackScanMs)),
          filesScanned: summarizeNumbers(runs.map((run) => run.liveFallbackFilesScanned)),
          dirsScanned: summarizeNumbers(runs.map((run) => run.liveFallbackDirsScanned)),
          missingLots: Array.from(new Set(runs.flatMap((run) => run.liveFallbackMissingLots || []))).sort(),
          foundLots: Array.from(new Set(runs.flatMap((run) => run.liveFallbackFoundLots || []))).sort(),
        },
      };
    };
    const runUiTextRepeated = async (scenario) => {
      const runs = [];
      for (let i = 0; i < RUNS; i += 1) {
        const data = await page.evaluate(async ({ query, folder }) => {
          const v = window.viewer;
          if (!v) return { success: false, error: 'viewer missing', elapsedMs: 0, images: [] };
          const normalizedFolder = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
          if (normalizedFolder) {
            v.selectedFolders = new Set([normalizedFolder]);
            v.lastSelectedFolder = normalizedFolder;
            v.lastSelectedFolderPath = normalizedFolder;
            v.lastLoadedGridFolderPath = normalizedFolder;
            v.currentFolderPrefix = normalizedFolder;
          } else {
            v.selectedFolders = new Set();
            v.lastSelectedFolder = null;
            v.lastSelectedFolderPath = null;
            v.lastLoadedGridFolderPath = '';
            v.currentFolderPrefix = '';
          }
          const input = document.getElementById('file-search');
          if (!input) return { success: false, error: 'file-search missing', elapsedMs: 0, images: [] };
          input.value = query;
          const start = performance.now();
          const success = await v.performSearch({ suppressAlerts: true });
          const elapsedMs = performance.now() - start;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const images = (v.currentGridImages || []).map((imagePath) =>
            String(imagePath || '').replace(/\\/g, '/')
          );
          return {
            success,
            elapsedMs,
            images,
            wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
            folderParam: v.getSearchFolderParam?.() || '',
          };
        }, { query: scenario.query, folder: scenario.folder || '' });
        expect(data.success === true, `${scenario.name} UI failed run=${i + 1} data=${JSON.stringify(data).slice(0, 500)}`);
        expect(data.images.length > 0 && data.wraps > 0, `${scenario.name} empty UI run=${i + 1} data=${JSON.stringify(data).slice(0, 500)}`);
        expect(
          data.images.every((imagePath) => imagePath.startsWith('unknown/')),
          `${scenario.name} UI outsideUnknown=${JSON.stringify(data.images.filter((imagePath) => !imagePath.startsWith('unknown/')).slice(0, 8))}`
        );
        validateExpectedLots(`${scenario.name} UI run=${i + 1}`, data.images, scenario.expectedLots || []);
        scenario.validate?.(data.images);
        runs.push({
          elapsedMs: data.elapsedMs,
          count: data.images.length,
          wraps: data.wraps,
          folderParam: data.folderParam,
          compact: compactResult(data.images),
        });
      }
      const counts = runs.map((run) => run.count);
      expect(
        counts.every((count) => count === counts[0]),
        `${scenario.name} UI unstable counts=${JSON.stringify(counts)}`
      );
      return {
        query: scenario.query,
        folder: scenario.folder || '',
        count: counts[0],
        wraps: runs[0].wraps,
        folderParam: runs[0].folderParam,
        wallMs: summarizeNumbers(runs.map((run) => run.elapsedMs)),
        sample: runs[0].compact,
      };
    };
    const runUiMultiRepeated = async ({ name, inputText, expectedLots, kind }) => {
      const runs = [];
      for (let i = 0; i < RUNS; i += 1) {
        const data = await page.evaluate(async ({ inputText: rawInput, kind: searchKind }) => {
          const v = window.viewer;
          if (!v) return { success: false, error: 'viewer missing', elapsedMs: 0, images: [] };
          v.selectedFolders = new Set();
          v.lastSelectedFolder = null;
          v.lastSelectedFolderPath = null;
          v.lastLoadedGridFolderPath = '';
          v.currentFolderPrefix = '';

          let success = false;
          let parsed = {};
          const start = performance.now();
          if (searchKind === 'lot') {
            const input = document.getElementById('multi-search-input');
            if (!input) return { success: false, error: 'multi-search-input missing', elapsedMs: 0, images: [] };
            input.value = rawInput;
            parsed = v.parseMultiSearchInput();
            if (!parsed.error) {
              success = await v.performSearch({
                multiLotList: [...(parsed.lots || [])],
                suppressAlerts: true,
              });
            }
          } else {
            const input = document.getElementById('wf-search-input');
            if (!input) return { success: false, error: 'wf-search-input missing', elapsedMs: 0, images: [] };
            input.value = rawInput;
            parsed = v.parseWfSearchInput();
            if (!parsed.error) {
              const pairStr = (parsed.pairs || []).map((pair) => `${pair.lot}:${pair.wf}`).join(',');
              success = await v.performSearch({ wfPairs: pairStr, suppressAlerts: true });
            }
          }
          const elapsedMs = performance.now() - start;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const images = (v.currentGridImages || []).map((imagePath) =>
            String(imagePath || '').replace(/\\/g, '/')
          );
          return {
            success,
            error: parsed.error || '',
            parsedCount: searchKind === 'lot' ? (parsed.lots || []).length : (parsed.pairs || []).length,
            elapsedMs,
            images,
            wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
          };
        }, { inputText, kind });
        expect(data.success === true, `${name} failed run=${i + 1} data=${JSON.stringify(data).slice(0, 700)}`);
        expect(data.parsedCount === expectedLots.length, `${name} parsedCount=${data.parsedCount} expected=${expectedLots.length}`);
        expect(data.images.length >= expectedLots.length, `${name} count=${data.images.length} expected>=${expectedLots.length}`);
        validateExpectedLots(`${name} run=${i + 1}`, data.images, expectedLots);
        runs.push({
          elapsedMs: data.elapsedMs,
          count: data.images.length,
          wraps: data.wraps,
          parsedCount: data.parsedCount,
          compact: compactResult(data.images),
        });
      }
      const counts = runs.map((run) => run.count);
      expect(counts.every((count) => count === counts[0]), `${name} unstable counts=${JSON.stringify(counts)}`);
      return {
        inputCount: expectedLots.length,
        count: counts[0],
        parsedCount: runs[0].parsedCount,
        wraps: runs[0].wraps,
        wallMs: summarizeNumbers(runs.map((run) => run.elapsedMs)),
        sample: runs[0].compact,
      };
    };

    const statusRows = prefixRows.filter((row) => row.status);
    const statusTerms = Array.from(new Set(statusRows.map((row) => row.status))).slice(0, 2);
    while (statusTerms.length < 2) {
      statusTerms.push(statusTerms[0] || a.status || 'pwq');
    }

    const textScenarios = [
      {
        name: 'global exact uppercase LOT',
        params: { q: a.lot.toUpperCase(), folder: '', limit: '10000' },
        query: a.lot.toUpperCase(),
        folder: '',
        expectedLots: [a.lot],
        expectedPrefix: '',
      },
      {
        name: 'global mixed case OR LOTs',
        params: { q: `${a.lot.toUpperCase()} Or ${b.lot}`, folder: '', limit: '10000' },
        query: `${a.lot.toUpperCase()} Or ${b.lot}`,
        folder: '',
        expectedLots: [a.lot, b.lot],
        expectedPrefix: '',
      },
      {
        name: 'unknown partial LOT prefix',
        params: { q: prefix.toUpperCase(), folder: 'unknown', limit: '10000' },
        query: prefix.toUpperCase(),
        folder: 'unknown',
        expectedLots: prefixLots.slice(0, 2),
        expectedPrefix: 'unknown',
        validate: (results) => {
          const lots = resultLots(results);
          expect(
            lots.every((lot) => lot.startsWith(prefix)),
            `partial prefix ${prefix} outside lots=${JSON.stringify(lots.slice(0, 20))}`
          );
        },
      },
      {
        name: 'unknown tab space multi LOTs',
        params: { q: `${a.lot.toUpperCase()}\t  ${b.lot}\t${c.lot.toUpperCase()}`, folder: 'unknown', limit: '10000' },
        query: `${a.lot.toUpperCase()}\t  ${b.lot}\t${c.lot.toUpperCase()}`,
        folder: 'unknown',
        expectedLots: [a.lot, b.lot, c.lot],
        expectedPrefix: 'unknown',
      },
      {
        name: 'unknown comma semicolon LOTs',
        params: { q: `${a.lot}, ${b.lot}; ${c.lot}`, folder: 'unknown', limit: '10000' },
        query: `${a.lot}, ${b.lot}; ${c.lot}`,
        folder: 'unknown',
        expectedLots: [a.lot, b.lot, c.lot],
        expectedPrefix: 'unknown',
      },
      {
        name: 'unknown grouped LOT wafer logical',
        params: { q: `(${a.lot.toUpperCase()} AnD ${a.wafer}) OR (${b.lot}\tand\t${b.wafer})`, folder: 'unknown', limit: '10000' },
        query: `(${a.lot.toUpperCase()} AnD ${a.wafer}) OR (${b.lot}\tand\t${b.wafer})`,
        folder: 'unknown',
        expectedLots: [a.lot, b.lot],
        expectedPrefix: 'unknown',
        validate: (results) => {
          const allowed = new Set([`${a.lot}:${a.wafer}`, `${b.lot}:${b.wafer}`]);
          const pairs = results.map(parseLotWaferFromPath).map((row) => `${row.lot}:${row.wafer}`);
          expect(
            pairs.every((pair) => allowed.has(pair)),
            `unexpected pairs=${JSON.stringify(pairs.slice(0, 20))}`
          );
        },
      },
      {
        name: 'unknown bintype wafer AND',
        params: { q: `${a.bintype} and _${a.wafer}_`, folder: 'unknown', limit: '10000' },
        query: `${a.bintype.toUpperCase()}   and\t_${a.wafer}_`,
        folder: 'unknown',
        expectedLots: [],
        expectedPrefix: 'unknown',
        validate: (results) => {
          expect(
            results.every((imagePath) => {
              const name = imagePath.split('/').pop().toLowerCase();
              return name.includes(`_${a.bintype}_`) && name.includes(`_${a.wafer}_`);
            }),
            `bintype wafer mismatch=${JSON.stringify(results.slice(0, 20))}`
          );
        },
      },
      {
        name: 'unknown nested status OR prefix',
        params: { q: `(${statusTerms[0].toUpperCase()} or ${statusTerms[1]}) and ${prefix}`, folder: 'unknown', limit: '10000' },
        query: `(${statusTerms[0].toUpperCase()} or ${statusTerms[1]}) and ${prefix.toUpperCase()}`,
        expectedLots: [],
        folder: 'unknown',
        expectedPrefix: 'unknown',
        validate: (results) => {
          const allowedStatus = new Set(statusTerms);
          expect(
            results.every((imagePath) => {
              const row = parseUnknownFileRow(imagePath);
              return row.lot.startsWith(prefix) && allowedStatus.has(row.status);
            }),
            `nested status OR prefix mismatch=${JSON.stringify(results.slice(0, 20))}`
          );
        },
      },
      {
        name: 'unknown prefix NOT one LOT',
        params: { q: `${prefix} NoT ${excludedPrefixLot.toUpperCase()}`, folder: 'unknown', limit: '10000' },
        query: `${prefix.toUpperCase()} NoT ${excludedPrefixLot.toUpperCase()}`,
        folder: 'unknown',
        expectedLots: keptPrefixLots.slice(0, 2),
        expectedPrefix: 'unknown',
        validate: (results) => {
          const lots = resultLots(results);
          expect(!lots.includes(excludedPrefixLot), `excluded lot present lots=${JSON.stringify(lots)}`);
          expect(
            lots.every((lot) => lot.startsWith(prefix)),
            `NOT prefix ${prefix} outside lots=${JSON.stringify(lots.slice(0, 20))}`
          );
        },
      },
    ];

    const lotCounts = new Map();
    for (const row of rows) {
      lotCounts.set(row.lot, (lotCounts.get(row.lot) || 0) + 1);
    }
    const stableRows = Array.from(rowsByLot.values())
      .filter((row) => lotCounts.get(row.lot) === 1)
      .slice(0, 100);
    expect(stableRows.length === 100, `stableRows=${stableRows.length}`);
    const multiLots100 = stableRows.map((row) => row.lot);
    const mixedLot100Input = stableRows.map((row, index) => {
      const token = index % 2 === 0 ? row.lot.toUpperCase() : row.lot;
      const sep = index % 4 === 0 ? '\n' : (index % 4 === 1 ? ', ' : (index % 4 === 2 ? '; ' : '\t'));
      return index === stableRows.length - 1 ? token : `${token}${sep}`;
    }).join('');
    const mixedWf100Input = stableRows
      .map((row, index) => {
        const lot = index % 2 === 0 ? row.lot.toUpperCase() : row.lot;
        const gap = index % 3 === 0 ? '\t' : '   ';
        return `${lot}${gap}${row.wafer}`;
      })
      .join('\n');
    const apiMultiScenarios = [
      {
        name: 'global lot_multi 100 mixed separators',
        params: { q: '', lot_multi: mixedLot100Input, folder: '', limit: '10000' },
        expectedLots: multiLots100,
        expectedPrefix: '',
      },
      {
        name: 'global lot_wafer 100 mixed case',
        params: {
          q: '',
          lot_wafer: stableRows.map((row, index) => {
            const lot = index % 2 === 0 ? row.lot.toUpperCase() : row.lot;
            const suffix = index === stableRows.length - 1 ? '' : (index % 3 === 0 ? '\n' : (index % 3 === 1 ? ';' : ','));
            return `${lot}:${row.wafer}${suffix}`;
          }).join(''),
          folder: '',
          limit: '10000',
        },
        expectedLots: multiLots100,
        expectedPrefix: '',
      },
    ];

    const apiResults = {};
    for (const scenario of [...textScenarios, ...apiMultiScenarios]) {
      apiResults[scenario.name] = await runApiRepeated(scenario);
    }

    const uiTextResults = {};
    for (const scenario of textScenarios) {
      uiTextResults[scenario.name] = await runUiTextRepeated(scenario);
    }
    const uiMultiResults = {
      lot100: await runUiMultiRepeated({
        name: 'UI multi LOT 100',
        inputText: mixedLot100Input,
        expectedLots: multiLots100,
        kind: 'lot',
      }),
      wf100: await runUiMultiRepeated({
        name: 'UI multi WF 100',
        inputText: mixedWf100Input,
        expectedLots: multiLots100,
        kind: 'wf',
      }),
    };

    return {
      runsPerScenario: RUNS,
      unknownFileCount: rows.length,
      uniqueLotCount: rowsByLot.size,
      sampleRows: [a, b, c].map((row) => ({
        lot: row.lot,
        bintype: row.bintype,
        wafer: row.wafer,
        status: row.status,
        path: row.path || row.firstGlobalPath,
      })),
      prefixScenario: { prefix, prefixLots, excludedPrefixLot },
      multi100: {
        lotCount: multiLots100.length,
        firstLots: multiLots100.slice(0, 5),
        lastLots: multiLots100.slice(-5),
      },
      apiResults,
      uiTextResults,
      uiMultiResults,
    };
  });

  await record('6,32', 'LOT Mode / 폴더전환 스크롤', async () => {
    await loadFolder('unknown');
    const lotHeaders = await page.evaluate(async () => {
      const w = document.querySelector('#image-grid')?.parentElement;
      if (w) w.scrollTop = 1000;
      const v = window.viewer;
      if (!v.lotMode) {
        v.toggleLotMode();
      }
      await new Promise((r) => setTimeout(r, 1200));
      return document.querySelectorAll('#image-grid .lot-header').length;
    });
    await loadFolder('unknown');
    const scrollTop = await page.evaluate(
      () => document.querySelector('#image-grid')?.parentElement?.scrollTop || 0
    );
    expect(lotHeaders > 0, `lotHeaders=${lotHeaders}`);
    expect(scrollTop < 50, `scrollTop=${scrollTop}`);
    return { lotHeaders, scrollTop };
  });

  await record('7,12,20', 'Class / MY LOT / stats', async () => {
    await boot('chunk1-class');
    const labelSeed = await ensureUnknownWaferLabelClasses();
    await page.waitForFunction(
      async (className) => {
        const response = await fetch('/api/classes?mode=wafer', { cache: 'no-store' });
        const data = await response.json();
        return (data.classes || []).includes(className);
      },
      labelSeed.primaryClass,
      { timeout: 30000 }
    );
    const classData = await page.evaluate(async (primaryClass) => {
      const domClasses = Array.from(document.querySelectorAll('#class-list .class-btn'))
        .map((button) => (button.textContent || '').trim())
        .filter(Boolean);
      const response = await fetch('/api/classes?mode=wafer', { cache: 'no-store' });
      const data = await response.json();
      const classes = (data.classes || domClasses).filter(Boolean);
      if (!primaryClass) {
        return {
          classes: [],
          primaryClass: null,
          count: 0,
        };
      }
      await window.viewer.showGridFromClass(primaryClass);
      await new Promise((r) => setTimeout(r, 1200));
      return {
        classes,
        primaryClass,
        count: window.viewer.currentGridImages.length,
        images: (window.viewer.currentGridImages || []).slice(0, 12),
      };
    }, labelSeed.primaryClass);
    expect(classData.primaryClass, `classes=${JSON.stringify(classData.classes)}`);
    expect(classData.classes.includes(classData.primaryClass), `primaryClass=${classData.primaryClass}`);
    expect(classData.primaryClass === labelSeed.primaryClass, `primaryClass should be seeded unknown class: ${JSON.stringify({ classData, labelSeed })}`);
    expect(classData.count > 0, `${classData.primaryClass}=${classData.count}`);
    expect(
      classData.images.every((imagePath) =>
        String(imagePath || '').replace(/\\/g, '/').includes(`classification/${labelSeed.primaryClass}/`)
      ),
      `class grid used non-e2e class images=${JSON.stringify(classData)}`
    );
    await page.evaluate(() => window.viewer.openMyLotModal());
    await sleep(800);
    const myLotVisible = await visible('#my-lot-window');
    expect(myLotVisible, 'my-lot hidden');
    const statsPage = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 900 },
    });
    await statsPage.goto(`${base}/stats`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await statsPage.waitForTimeout(1000);
    const statsUsers = await fetchJson(statsPage, '/api/stats/users');
    const statsProbeUser = (statsUsers.users || []).find((user) => {
      const userId = String(user?.user_id || '').trim();
      const loginId = String(user?.profile?.LoginId || '').trim();
      if (!userId || !loginId) return false;
      const normalized = userId.toLowerCase();
      return normalized !== 'guest' && normalized !== 'notsaml';
    });
    expect(!!statsProbeUser, `statsProbeUser missing from ${JSON.stringify(statsUsers).slice(0, 400)}`);

    const statsProbeUserId = statsProbeUser.user_id;
    const statsProbePage = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 900 },
    });
    await statsProbePage.goto(
      `${base}/?LoginId=${encodeURIComponent(statsProbeUserId)}&e2e_stats_probe=${Date.now()}`,
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      }
    );
    await statsProbePage.waitForFunction(
      () => !!window.viewer && window.__l3FullViewerReady === true,
      null,
      { timeout: 90000 }
    );
    await statsProbePage.waitForTimeout(1200);

    const statsAfterInitialLoad = await fetchJson(
      statsPage,
      `/api/stats/user/${encodeURIComponent(statsProbeUserId)}`
    );
    const today = String(statsAfterInitialLoad.last_seen || new Date().toISOString().slice(0, 10));
    const baselineTotalRequests = Number(statsAfterInitialLoad.total_requests || 0);
    const baselineDailyRequests = Number(
      (statsAfterInitialLoad.daily_requests || {})[today] || 0
    );
    const baselineRootEndpointCount = Number((statsAfterInitialLoad.endpoints || {})['/'] || 0);

    await statsProbePage.evaluate(async () => {
      const v = window.viewer;
      v.selectedImages = [];
      v.selectedFolders = new Set(['unknown']);
      v.lastSelectedFolderPath = 'unknown';
      v._unfilteredGridImages = [];
      const applied = await v.selectAllFolderFiles('unknown');
      if (applied && Array.isArray(v.selectedImages) && v.selectedImages.length > 0) {
        v.showGrid(v.selectedImages);
      } else {
        await v.loadImagesInFolderAndShowGrid('unknown');
      }
    });
    await statsProbePage.waitForFunction(
      () => {
        const images = Array.isArray(window.viewer?.currentGridImages)
          ? window.viewer.currentGridImages
          : [];
        return (
          !!window.viewer &&
          window.viewer.gridMode === true &&
          images.length > 0 &&
          images.some((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/')) &&
          document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0
        );
      },
      null,
      { timeout: 90000 }
    );
    await statsProbePage.waitForTimeout(1500);

    const statsAfterInternalApis = await fetchJson(
      statsPage,
      `/api/stats/user/${encodeURIComponent(statsProbeUserId)}`
    );
    expect(
      Number(statsAfterInternalApis.total_requests || 0) === baselineTotalRequests,
      `internal total changed ${baselineTotalRequests} -> ${statsAfterInternalApis.total_requests}`
    );
    expect(
      Number((statsAfterInternalApis.daily_requests || {})[today] || 0) === baselineDailyRequests,
      `internal daily changed ${baselineDailyRequests} -> ${(statsAfterInternalApis.daily_requests || {})[today] || 0}`
    );
    expect(
      Number((statsAfterInternalApis.endpoints || {})['/'] || 0) === baselineRootEndpointCount,
      `internal root endpoint changed ${baselineRootEndpointCount} -> ${(statsAfterInternalApis.endpoints || {})['/'] || 0}`
    );

    for (let i = 0; i < 2; i += 1) {
      await statsProbePage.reload({
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await statsProbePage.waitForFunction(
        () => !!window.viewer && window.__l3FullViewerReady === true,
        null,
        { timeout: 90000 }
      );
      await statsProbePage.waitForTimeout(1200);
    }

    const statsAfterReloads = await fetchJson(
      statsPage,
      `/api/stats/user/${encodeURIComponent(statsProbeUserId)}`
    );
    const finalTotalRequests = Number(statsAfterReloads.total_requests || 0);
    const finalDailyRequests = Number(
      (statsAfterReloads.daily_requests || {})[today] || 0
    );
    const rootEndpointCount = Number((statsAfterReloads.endpoints || {})['/'] || 0);
    expect(
      finalTotalRequests - baselineTotalRequests === 2,
      `reload total delta=${finalTotalRequests - baselineTotalRequests}`
    );
    expect(
      finalDailyRequests - baselineDailyRequests === 2,
      `reload daily delta=${finalDailyRequests - baselineDailyRequests}`
    );
    expect(
      rootEndpointCount - baselineRootEndpointCount === 2,
      `reload root delta=${rootEndpointCount - baselineRootEndpointCount}`
    );

    const statsText = await statsPage.evaluate(() =>
      document.body.innerText.slice(0, 120)
    );
    await statsProbePage.close();
    await statsPage.close();
    expect(statsText.length > 0, 'stats empty');
    return {
      classData,
      myLotVisible,
      statsText,
      statsProbeUserId,
      baselineTotalRequests,
      baselineDailyRequests,
      baselineRootEndpointCount,
      finalTotalRequests,
      finalDailyRequests,
      rootEndpointCount,
    };
  });

  await record('8,9,10,11', 'Composite / Context / RefMap / Measure', async () => {
    await boot('chunk1-cm');
    await page.evaluate(() => {
      if (typeof window.viewer?.hideLotListModal === 'function') {
        window.viewer.hideLotListModal();
      }
    });
    await sleep(150);
    await loadFolder('unknown');
    await setSelection([0, 1, 2]);
    const selectedUnknownPaths = await page.evaluate(() => (
      (window.viewer.gridSelectedIdxs || []).map((idx) => window.viewer.currentGridImages?.[idx] || null)
    ));
    expect(
      selectedUnknownPaths.every((imagePath) => String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/')),
      `selectedUnknownPaths=${JSON.stringify(selectedUnknownPaths)}`
    );
    await sleep(1000);
    append('[CM] open initial context\n');
    const firstWrap = page.locator('#image-grid .grid-thumb-wrap').first();
    const firstWrapBox = await firstWrap.boundingBox();
    expect(!!firstWrapBox, 'first grid wrap missing');
    await page.mouse.move(
      firstWrapBox.x + firstWrapBox.width / 2,
      firstWrapBox.y + firstWrapBox.height / 2
    );
    await page.mouse.click(
      firstWrapBox.x + firstWrapBox.width / 2,
      firstWrapBox.y + firstWrapBox.height / 2,
      { button: 'right' }
    );
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('grid-context-menu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    const ctxComposite = await visible('#context-mc-create');
    expect(ctxComposite, 'ctx composite hidden');
    const ctxMeasure = await visible('#context-mea-create');
    expect(ctxMeasure, 'ctx measure hidden');
    append('[CM] initial context visible\n');
    const mcCreate = page.locator('#context-mc-create');
    const mcBox = await mcCreate.boundingBox();
    expect(!!mcBox, 'mc context item missing');
    await page.mouse.move(mcBox.x + mcBox.width / 2, mcBox.y + mcBox.height / 2);
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('context-mc-submenu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#context-mc-submenu .failbit-item input[type="checkbox"]').length > 0,
      null,
      { timeout: 10000 }
    );
    const mcSubmenuState = await page.evaluate(() => ({
      display: getComputedStyle(document.getElementById('context-mc-submenu')).display,
      itemCount: document.querySelectorAll('#context-mc-submenu .failbit-item').length,
      checkboxCount: document.querySelectorAll('#context-mc-submenu .failbit-item input[type="checkbox"]').length,
    }));
    expect(mcSubmenuState.display !== 'none', `mc submenu hidden=${JSON.stringify(mcSubmenuState)}`);
    expect(mcSubmenuState.checkboxCount > 0, `mc submenu empty=${JSON.stringify(mcSubmenuState)}`);
    append(`[CM] initial mc ${JSON.stringify(mcSubmenuState)}\n`);
    const meaCreate = page.locator('#context-mea-create');
    const meaBox = await meaCreate.boundingBox();
    expect(!!meaBox, 'mea context item missing');
    await page.mouse.move(meaBox.x + meaBox.width / 2, meaBox.y + meaBox.height / 2);
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('context-mea-submenu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#context-mea-submenu .failbit-item input[type="checkbox"]').length > 0,
      null,
      { timeout: 10000 }
    );
    const meaSubmenuState = await page.evaluate(() => ({
      display: getComputedStyle(document.getElementById('context-mea-submenu')).display,
      itemCount: document.querySelectorAll('#context-mea-submenu .failbit-item').length,
      checkboxCount: document.querySelectorAll('#context-mea-submenu .failbit-item input[type="checkbox"]').length,
    }));
    expect(meaSubmenuState.display !== 'none', `mea submenu hidden=${JSON.stringify(meaSubmenuState)}`);
    expect(meaSubmenuState.checkboxCount > 0, `mea submenu empty=${JSON.stringify(meaSubmenuState)}`);
    append(`[CM] initial mea ${JSON.stringify(meaSubmenuState)}\n`);
    const lowMcSubmenu = await openLowContextSubmenu('mc');
    expect(lowMcSubmenu.bottom <= lowMcSubmenu.limit + 2, `low mc overlaps tab=${JSON.stringify(lowMcSubmenu)}`);
    expect(lowMcSubmenu.buttonHeight > 0, `low mc button missing=${JSON.stringify(lowMcSubmenu)}`);
    expect(lowMcSubmenu.buttonBottom <= lowMcSubmenu.limit + 2, `low mc button overlaps tab=${JSON.stringify(lowMcSubmenu)}`);
    append(`[CM] low mc ${JSON.stringify(lowMcSubmenu)}\n`);
    const lowMeaSubmenu = await openLowContextSubmenu('mea');
    expect(lowMeaSubmenu.bottom <= lowMeaSubmenu.limit + 2, `low mea overlaps tab=${JSON.stringify(lowMeaSubmenu)}`);
    expect(lowMeaSubmenu.buttonHeight > 0, `low mea button missing=${JSON.stringify(lowMeaSubmenu)}`);
    expect(lowMeaSubmenu.buttonBottom <= lowMeaSubmenu.limit + 2, `low mea button overlaps tab=${JSON.stringify(lowMeaSubmenu)}`);
    append(`[CM] low mea ${JSON.stringify(lowMeaSubmenu)}\n`);
    await page.evaluate(() => window.viewer.hideContextMenu?.());
    const freshMcState = await openContextMcStateAtIndex(4);
    expect(freshMcState.itemCount > 1, `fresh mc list missing=${JSON.stringify(freshMcState)}`);
    expect(freshMcState.checkedCount === 0, `fresh mc has stale checks=${JSON.stringify(freshMcState)}`);
    expect(freshMcState.buttonText === '생성 (0)', `fresh mc stale button=${JSON.stringify(freshMcState)}`);
    expect(freshMcState.buttonDisabled === true, `fresh mc button enabled=${JSON.stringify(freshMcState)}`);
    expect(
      JSON.stringify(freshMcState.gridSelectedIdxs) === JSON.stringify([4]),
      `right click did not retarget selection=${JSON.stringify(freshMcState)}`
    );
    append(`[CM] fresh mc ${JSON.stringify(freshMcState)}\n`);
    await page.evaluate(() => window.viewer.hideContextMenu?.());
    await setSelection([0, 1, 2]);
    const path = await page.evaluate(() => window.viewer.currentGridImages[0]);
    expect(String(path || '').replace(/\\/g, '/').startsWith('unknown/'), `ref path=${path}`);
    await page.evaluate((p) => window.viewer.setRefMap(p), path);
    await sleep(500);
    const refVisible = await visible('#ref-map-window');
    expect(refVisible, 'ref hidden');
    await page.evaluate(async () => {
      await window.viewer._selectFailbitItem('bin');
    });
    await sleep(500);
    const overlay = await page.evaluate(() => window.viewer.overlayMode);
    expect(overlay === 'bin', `overlay=${overlay}`);
    append('[CM] bin overlay ready\n');
    const mcBeforeGenerate = await openContextMcStateAtIndex(0);
    expect(mcBeforeGenerate.checkedCount === 0, `mc generate opened stale=${JSON.stringify(mcBeforeGenerate)}`);
    expect(
      JSON.stringify(mcBeforeGenerate.gridSelectedIdxs) === JSON.stringify([0, 1, 2]),
      `mc generate did not keep selected group=${JSON.stringify(mcBeforeGenerate)}`
    );
    append(`[CM] before generate ${JSON.stringify(mcBeforeGenerate)}\n`);
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('#context-mc-submenu .failbit-item'))
        .find((el) => el.querySelector('input[type="checkbox"]'));
      item?.click();
    });
    await page.waitForFunction(
      () => document.querySelector('#context-mc-submenu .mc-generate-btn')?.textContent === '생성 (1)',
      null,
      { timeout: 10000 }
    );
    append('[CM] generate button armed\n');
    await startOrphanContextChooserMonitor('context-composite-generate');
    await page.locator('#context-mc-submenu .mc-generate-btn').click();
    await page.waitForFunction(
      () =>
        !!window.viewer.pageManager &&
        window.viewer.pageManager.getActivePage()?.role === 'composite',
      null,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      () =>
        !!window.viewer.pageManager &&
        window.viewer.pageManager.getActivePage()?.role === 'composite' &&
        Array.isArray(window.viewer.currentGridImages) &&
        window.viewer.currentGridImages.length > 0,
      null,
      { timeout: 180000 }
    );
    const compositeCount = await page.evaluate(
      () => window.viewer.currentGridImages.length
    );
    expect(compositeCount > 0, `compositeCount=${compositeCount}`);
    const selectedPanelAfterComposite = await page.evaluate(() => {
      const panel = document.getElementById('selected-grid-images-panel');
      const style = panel ? getComputedStyle(panel) : null;
      return {
        activeRole: window.viewer.pageManager?.getActivePage?.()?.role || null,
        isCompositeMode: !!window.viewer.isCompositeMode,
        display: style?.display || null,
        count: document.getElementById('selected-count-badge')?.textContent || null,
        gridSelectedIdxs: [...(window.viewer.gridSelectedIdxs || [])],
      };
    });
    const visibleFloatingPanelsAfterComposite = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.failbit-panel'))
        .map((panel) => {
          const rect = panel.getBoundingClientRect();
          const style = getComputedStyle(panel);
          return {
            id: panel.id,
            display: style.display,
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            text: (panel.innerText || '').trim().slice(0, 80),
          };
        })
        .filter((panel) => panel.display !== 'none' && panel.width > 0 && panel.height > 0)
    );
    const orphanContextChooserEvents = await stopOrphanContextChooserMonitor();
    expect(
      selectedPanelAfterComposite.display === 'none',
      `selected panel visible after composite=${JSON.stringify(selectedPanelAfterComposite)}`
    );
    expect(
      selectedPanelAfterComposite.count === '0' && selectedPanelAfterComposite.gridSelectedIdxs.length === 0,
      `selection not cleared after composite=${JSON.stringify(selectedPanelAfterComposite)}`
    );
    expect(
      visibleFloatingPanelsAfterComposite.length === 0,
      `floating composite/measure panel left visible=${JSON.stringify(visibleFloatingPanelsAfterComposite)}`
    );
    expect(
      orphanContextChooserEvents.length === 0,
      `orphan context chooser visible after composite generate=${JSON.stringify(orphanContextChooserEvents)}`
    );
    return {
      ctxComposite,
      ctxMeasure,
      mcSubmenuState,
      meaSubmenuState,
      lowMcSubmenu,
      lowMeaSubmenu,
      selectedUnknownPaths,
      freshMcState,
      mcBeforeGenerate,
      refVisible,
      refPath: path,
      overlay,
      compositeCount,
      selectedPanelAfterComposite,
      visibleFloatingPanelsAfterComposite,
      orphanContextChooserEvents,
    };
  });

  await record('grid-context-actions', 'Grid context copy/download/MY LOT', async () => {
    await boot('chunk1-grid-context-actions');
    await loadFolder('unknown');
    await setSelection([0, 1]);
    await page.evaluate(async () => {
      await window.viewer?._getContextMenuManager?.();
    });

    const selectedPaths = await page.evaluate(() => (
      (window.viewer.gridSelectedIdxs || []).map((idx) => window.viewer.currentGridImages?.[idx] || null).filter(Boolean)
    ));
    expect(selectedPaths.length === 2, `grid context selectedPaths=${JSON.stringify(selectedPaths)}`);
    const selectedParsed = selectedPaths.map(parseLotWaferFromPath);

    const menuState = await openGridContextAtIndex(0);
    expect(
      menuState.text.includes('선택 wafer 리스트 복사(YMS 방식)'),
      `grid context wafer-list label missing=${JSON.stringify(menuState)}`
    );
    expect(
      !menuState.text.includes('선택 LOT 리스트 복사'),
      `grid context old LOT label remains=${JSON.stringify(menuState)}`
    );
    await page.evaluate(() => window.viewer.hideContextMenu?.());

    await installClipboardCapture();
    const ymsCopy = await withAutoDialogs(async () => {
      await openGridContextAtIndex(0);
      await page.locator('#context-list-copy').click({ timeout: 10000 });
      await page.waitForFunction(
        () => (window.__e2eClipboard?.textWrites || []).length >= 1,
        null,
        { timeout: 10000 }
      );
      return await readClipboardCapture();
    });
    const ymsText = ymsCopy.result.textWrites.at(-1) || '';
    const ymsRows = ymsText.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
    expect(ymsRows.length === selectedPaths.length, `YMS row count mismatch text=${JSON.stringify(ymsText)}`);
    expect(
      ymsRows.every((row, index) =>
        row.length === 2 &&
        row[0].toLowerCase() === selectedParsed[index].lot &&
        row[1].replace(/^W/i, '').toLowerCase() === selectedParsed[index].wafer
      ),
      `YMS rows invalid rows=${JSON.stringify(ymsRows)} parsed=${JSON.stringify(selectedParsed)}`
    );

    await installClipboardCapture();
    const waferInfoCopy = await withAutoDialogs(async () => {
      await openGridContextAtIndex(0);
      await page.locator('#context-wafer-info-copy').click({ timeout: 10000 });
      await page.waitForFunction(
        () => (window.__e2eClipboard?.textWrites || []).length >= 1,
        null,
        { timeout: 20000 }
      );
      return await readClipboardCapture();
    });
    const waferTable = waferInfoCopy.result.textWrites.at(-1) || '';
    const waferTableLines = waferTable.trim().split(/\r?\n/).filter(Boolean);
    const waferHeader = (waferTableLines[0] || '').split('\t');
    const waferHeaderLower = waferHeader.map((key) => key.toLowerCase());
    expect(waferTableLines.length >= 2, `wafer info table empty=${JSON.stringify(waferTable)}`);
    expect(
      waferHeaderLower.includes('wafer'),
      `wafer info header missing wafer=${JSON.stringify(waferHeader)}`
    );
    expect(
      !waferHeaderLower.some((key) => key.includes('bucket')),
      `wafer info bucket column remains=${JSON.stringify(waferHeader)}`
    );
    const waferColumnIndex = waferHeaderLower.indexOf('wafer');
    const firstWaferValue = (waferTableLines[1] || '').split('\t')[waferColumnIndex] || '';
    expect(firstWaferValue && !/^W/i.test(firstWaferValue), `wafer value not normalized=${firstWaferValue}`);

    await installClipboardCapture();
    const mergeCopy = await withAutoDialogs(async () => {
      await openGridContextAtIndex(0);
      await page.locator('#context-merge-copy').click({ timeout: 10000 });
      await page.waitForFunction(
        () => (window.__e2eClipboard?.imageWrites || []).length >= 1,
        null,
        { timeout: 45000 }
      );
      return await readClipboardCapture();
    });
    const mergeImageWrite = mergeCopy.result.imageWrites.at(-1) || {};
    expect(
      mergeImageWrite.types?.includes('image/png') && mergeImageWrite.size > 0,
      `merged image clipboard write invalid=${JSON.stringify(mergeImageWrite)}`
    );

    const expectedDownloadNames = selectedPaths.map((imagePath) => (
      String(imagePath || '').replace(/\\/g, '/').split('/').pop()
    ));
    const downloadCopy = await withAutoDialogs(async () => {
      const downloads = await collectDownloadsForAction(selectedPaths.length, async () => {
        await openGridContextAtIndex(0);
        await page.locator('#context-download').click({ timeout: 10000 });
      });
      await sleep(1800);
      return downloads;
    });
    const downloadedNames = downloadCopy.result.map((item) => item.suggestedFilename);
    expect(
      downloadedNames.length === selectedPaths.length &&
        expectedDownloadNames.every((name) => downloadedNames.includes(name)),
      `download filenames invalid expected=${JSON.stringify(expectedDownloadNames)} actual=${JSON.stringify(downloadedNames)}`
    );

    const myLotAdd = await withAutoDialogs(async () => {
      await openGridContextAtIndex(0);
      await page.locator('#context-my-lot-add').click({ timeout: 10000 });
      await page.waitForFunction(
        () => getComputedStyle(document.getElementById('my-lot-window')).display !== 'none',
        null,
        { timeout: 15000 }
      );
      await sleep(500);
      return await page.evaluate(() => ({
        visible: getComputedStyle(document.getElementById('my-lot-window')).display !== 'none',
        pendingCount: window.viewer?.myLotModal?.pendingPaths?.length || 0,
        pendingPaths: [...(window.viewer?.myLotModal?.pendingPaths || [])],
        savePendingText: document.getElementById('my-lot-save-pending-btn')?.textContent || '',
      }));
    });
    expect(myLotAdd.result.visible, `MY LOT modal hidden=${JSON.stringify(myLotAdd.result)}`);
    expect(
      myLotAdd.result.pendingCount === selectedPaths.length &&
        selectedPaths.every((imagePath) => myLotAdd.result.pendingPaths.includes(imagePath)),
      `MY LOT pending paths invalid=${JSON.stringify(myLotAdd.result)} selected=${JSON.stringify(selectedPaths)}`
    );
    await page.evaluate(() => window.viewer?.myLotModal?.close?.());
    await sleep(300);

    return {
      selectedPaths,
      menuState,
      ymsRows,
      ymsDialogs: ymsCopy.dialogs,
      waferHeader,
      waferInfoRows: waferTableLines.length - 1,
      waferInfoDialogs: waferInfoCopy.dialogs,
      mergeImageWrite,
      mergeDialogs: mergeCopy.dialogs,
      downloads: downloadCopy.result,
      downloadDialogs: downloadCopy.dialogs,
      myLotAdd: myLotAdd.result,
      myLotDialogs: myLotAdd.dialogs,
    };
  });

  await record('13-19', '단일 이미지 기본/피라미드/컨텍스트/라벨모달', async () => {
    await boot('chunk1-single');
    await loadFolder('unknown');
    await setSelection([0]);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => !!window.viewer && !window.viewer.gridMode && !!window.viewer.selectedImagePath,
      null,
      { timeout: 30000 }
    );
    await sleep(1500);

    const initialSingleMenu = await openSingleContextMenuOnCanvas();
    expect(initialSingleMenu.visible, `single context menu hidden=${JSON.stringify(initialSingleMenu)}`);
    expect(
      initialSingleMenu.text.includes('원본 다운로드') &&
        initialSingleMenu.text.includes('이미지 복사') &&
        initialSingleMenu.text.includes('캔버스 전체 복사') &&
        initialSingleMenu.text.includes('MY LOT 추가') &&
        initialSingleMenu.text.includes('파일명복사 (YMS)'),
      `single context menu items missing=${JSON.stringify(initialSingleMenu)}`
    );
    await page.evaluate(() => window.viewer.hideSingleContextMenu?.());

    const singleParsed = parseLotWaferFromPath(initialSingleMenu.selectedImagePath);

    await installClipboardCapture();
    const singleYmsCopy = await withAutoDialogs(async () => {
      await openSingleContextMenuOnCanvas();
      await clickVisibleContextMenuItem('파일명복사 (YMS)');
      await page.waitForFunction(
        () => (window.__e2eClipboard?.textWrites || []).length >= 1,
        null,
        { timeout: 10000 }
      );
      return await readClipboardCapture();
    });
    const singleYmsText = singleYmsCopy.result.textWrites.at(-1) || '';
    const singleYmsRow = singleYmsText.trim().split('\t');
    expect(
      singleYmsRow.length === 2 &&
        singleYmsRow[0].toLowerCase() === singleParsed.lot &&
        singleYmsRow[1].replace(/^W/i, '').toLowerCase() === singleParsed.wafer,
      `single YMS copy invalid row=${JSON.stringify(singleYmsRow)} parsed=${JSON.stringify(singleParsed)}`
    );

    await installClipboardCapture();
    const singleImageCopy = await withAutoDialogs(async () => {
      await openSingleContextMenuOnCanvas();
      await clickVisibleContextMenuItem('이미지 복사');
      await page.waitForFunction(
        () => (window.__e2eClipboard?.imageWrites || []).length >= 1,
        null,
        { timeout: 30000 }
      );
      return await readClipboardCapture();
    });
    const singleImageWrite = singleImageCopy.result.imageWrites.at(-1) || {};
    expect(
      singleImageWrite.types?.includes('image/png') && singleImageWrite.size > 0,
      `single image clipboard write invalid=${JSON.stringify(singleImageWrite)}`
    );

    await installClipboardCapture();
    await installHtml2CanvasStub();
    const singleCanvasCopy = await withAutoDialogs(async () => {
      await openSingleContextMenuOnCanvas();
      await clickVisibleContextMenuItem('캔버스 전체 복사');
      await page.waitForFunction(
        () => (window.__e2eClipboard?.imageWrites || []).length >= 1,
        null,
        { timeout: 30000 }
      );
      return await readClipboardCapture();
    });
    const singleCanvasWrite = singleCanvasCopy.result.imageWrites.at(-1) || {};
    expect(
      singleCanvasWrite.types?.includes('image/png') && singleCanvasWrite.size > 0,
      `single canvas clipboard write invalid=${JSON.stringify(singleCanvasWrite)}`
    );

    const singleDownload = await withAutoDialogs(async () => {
      const downloads = await collectDownloadsForAction(1, async () => {
        await openSingleContextMenuOnCanvas();
        await clickVisibleContextMenuItem('원본 다운로드');
      }, 30000);
      await sleep(800);
      return downloads;
    });
    const expectedSingleDownloadName = String(initialSingleMenu.selectedImagePath || '').replace(/\\/g, '/').split('/').pop();
    expect(
      singleDownload.result.length === 1 &&
        singleDownload.result[0].suggestedFilename === expectedSingleDownloadName,
      `single download invalid expected=${expectedSingleDownloadName} actual=${JSON.stringify(singleDownload.result)}`
    );

    const singleMyLotAdd = await withAutoDialogs(async () => {
      await openSingleContextMenuOnCanvas();
      await clickVisibleContextMenuItem('MY LOT 추가');
      await page.waitForFunction(
        () => getComputedStyle(document.getElementById('my-lot-window')).display !== 'none',
        null,
        { timeout: 15000 }
      );
      await sleep(500);
      return await page.evaluate(() => ({
        visible: getComputedStyle(document.getElementById('my-lot-window')).display !== 'none',
        pendingCount: window.viewer?.myLotModal?.pendingPaths?.length || 0,
        pendingPaths: [...(window.viewer?.myLotModal?.pendingPaths || [])],
      }));
    });
    expect(
      singleMyLotAdd.result.visible &&
        singleMyLotAdd.result.pendingCount === 1 &&
        singleMyLotAdd.result.pendingPaths[0] === initialSingleMenu.selectedImagePath,
      `single MY LOT pending invalid=${JSON.stringify(singleMyLotAdd.result)} selected=${initialSingleMenu.selectedImagePath}`
    );
    await page.evaluate(() => window.viewer?.myLotModal?.close?.());
    await sleep(300);

    const finalSingleMenu = await openSingleContextMenuOnCanvas();
    await page.evaluate(() => window.viewer.openAddLabelModal?.());
    await sleep(500);
    const data = await page.evaluate(() => ({
      selectedImagePath: window.viewer.selectedImagePath,
      selectedImagesForLabel: window.viewer.getSelectedImagesForModal?.() || [],
      pyramidLevel: window.viewer.currentPyramidLevel,
      fileName: (document.getElementById('file-name-text')?.textContent || '').trim(),
      currentImageInfo: (
        document.getElementById('current-image-info')?.textContent || ''
      ).trim(),
      chipInfoLen: (
        document.getElementById('chip-info-container')?.innerText || ''
      )
        .trim()
        .length,
      singleCtxVisible: (() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        return isVisible(document.getElementById('single-context-menu')) || isVisible(document.getElementById('chip-context-menu'));
      })(),
      addLabelVisible:
        getComputedStyle(document.getElementById('add-label-modal')).display !==
        'none',
    }));
    expect(
      String(data.selectedImagePath || '').replace(/\\/g, '/').startsWith('unknown/'),
      `single selectedImagePath=${data.selectedImagePath}`
    );
    expect(
      data.selectedImagesForLabel.length > 0 &&
        data.selectedImagesForLabel.every((imagePath) =>
          String(imagePath || '').replace(/\\/g, '/').startsWith('unknown/')
        ),
      `label modal selectedImages=${JSON.stringify(data.selectedImagesForLabel)}`
    );
    expect(!!data.selectedImagePath, 'no selected image');
    expect(data.pyramidLevel !== undefined, `pyramid=${data.pyramidLevel}`);
    expect(data.fileName.length > 0, 'empty filename');
    expect(data.chipInfoLen > 0, 'empty chip info');
    expect(data.singleCtxVisible, 'single ctx hidden');
    expect(data.addLabelVisible, 'add label hidden');
    await page.evaluate(() => {
      window.viewer.hideSingleContextMenu?.();
      document.getElementById('chip-context-menu')?.remove();
      window.viewer.closeAddLabelModal?.();
    });
    await backToGrid();
    return {
      ...data,
      initialSingleMenu,
      finalSingleMenu,
      singleYmsRow,
      singleYmsDialogs: singleYmsCopy.dialogs,
      singleImageWrite,
      singleImageDialogs: singleImageCopy.dialogs,
      singleCanvasWrite,
      singleCanvasDialogs: singleCanvasCopy.dialogs,
      singleDownload: singleDownload.result,
      singleDownloadDialogs: singleDownload.dialogs,
      singleMyLotAdd: singleMyLotAdd.result,
      singleMyLotDialogs: singleMyLotAdd.dialogs,
    };
  });

  await record('chip-label-b', 'Chip label 파일명 b suffix', async () => {
    await boot('chunk1-chip-label-b');
    const className = `e2e_chip_bfmt_${Date.now()}`;
    await page.evaluate(async (folderPath) => {
      const res = await fetch('/api/change-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(`change-folder failed: ${JSON.stringify(data)}`);
      }
      const v = window.viewer;
      v.currentFolderPath = data.current_folder;
      v.currentFolderPrefix = data.current_folder_prefix || '';
      v.productFolderPath = data.current_folder;
      v.markFolderContextChanged?.('e2e-chip-label-b');
    }, unknownFolderAbs);
    await loadFolder('unknown');
    await setSelection([0]);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () =>
        !!window.viewer &&
        !window.viewer.gridMode &&
        String(window.viewer.selectedImagePath || '').replace(/\\/g, '/').startsWith('unknown/') &&
        Array.isArray(window.viewer.chipAnnotator?.chips) &&
        window.viewer.chipAnnotator.chips.length > 0,
      null,
      { timeout: 60000 }
    );

    const data = await page.evaluate(async (targetClass) => {
      const v = window.viewer;
      const annotator = v.chipAnnotator;
      const chips = annotator.chips || [];
      const chipIndex = chips.findIndex((chip) =>
        chip &&
        chip.rect &&
        chip.x_abs !== undefined &&
        chip.y_abs !== undefined
      );
      if (chipIndex < 0) {
        throw new Error('labelable chip not found');
      }
      const chip = chips[chipIndex];
      const expectedB = String(chip.b ?? 'Normal')
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'Normal';
      annotator.selectedChips = new Set([chipIndex]);
      annotator.selectedChipsOrder = [chipIndex];
      annotator.render?.();

      const coords = annotator.getSelectedChipCoords();
      const classifyRes = await fetch('/api/classify/chips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_name: targetClass,
          image_path: v.selectedImagePath,
          chip_coords: coords,
          folder_prefix: v.currentFolderPrefix || '',
        }),
      });
      const classifyBody = await classifyRes.json();
      if (!classifyRes.ok || !classifyBody.success) {
        throw new Error(`chip classify failed: ${JSON.stringify(classifyBody)}`);
      }

      await annotator.loadAnnotations(v.selectedImagePath);
      const annotationRes = await fetch(`/api/chip-annotations?path=${encodeURIComponent(v.selectedImagePath)}`);
      const annotations = await annotationRes.json();
      const previousClassMode = v.classMode;
      v.classMode = 'chip';
      const classPath = v.buildClassificationPath(targetClass);
      v.classMode = previousClassMode;
      const filesRes = await fetch(`/api/files?path=${encodeURIComponent(classPath)}`);
      const filesText = await filesRes.text();
      let filesBody = {};
      try {
        filesBody = filesText ? JSON.parse(filesText) : {};
      } catch (err) {
        throw new Error(`chip files response is not JSON status=${filesRes.status} body=${filesText.slice(0, 160)}`);
      }
      if (!filesRes.ok || filesBody.success === false) {
        throw new Error(`chip files failed status=${filesRes.status} body=${filesText.slice(0, 320)}`);
      }
      const savedFilename = classifyBody.saved_files?.[0]?.filename || '';

      return {
        className: targetClass,
        imagePath: v.selectedImagePath,
        chip: {
          index: chipIndex,
          x_abs: chip.x_abs,
          y_abs: chip.y_abs,
          b: chip.b ?? null,
        },
        expectedB,
        coords,
        classifyBody,
        savedFilename,
        classPath,
        files: (filesBody.items || []).map((item) => item.name),
        marked: annotations.marked_chips || [],
      };
    }, className).finally(async () => {
      await page.evaluate(async (targetClass) => {
        await fetch('/api/classes/delete?mode=chip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: [targetClass] }),
        }).catch(() => {});
      }, className).catch(() => {});
    });

    expect(data.classifyBody.saved_count === 1, `saved_count=${JSON.stringify(data.classifyBody)}`);
    expect(
      /^.+_x\d+_y\d+_b[A-Za-z0-9_-]+\.png$/.test(data.savedFilename),
      `chip filename missing b suffix: ${data.savedFilename}`
    );
    expect(
      data.savedFilename.endsWith(`_b${data.expectedB}.png`),
      `chip filename b mismatch expected=${data.expectedB} actual=${data.savedFilename}`
    );
    expect(
      data.classifyBody.saved_files?.[0]?.b === data.expectedB,
      `saved_files b mismatch: ${JSON.stringify(data.classifyBody)}`
    );
    expect(data.files.includes(data.savedFilename), `saved file missing: ${JSON.stringify(data)}`);
    expect(
      data.marked.some((chip) =>
        chip.class === data.className &&
        chip.filename === data.savedFilename &&
        chip.b === data.expectedB
      ),
      `annotation missing saved filename: ${JSON.stringify(data)}`
    );
    await backToGrid();
    return data;
  });

  await record('chip-label-index-live', 'Chip label 인덱스 즉시 반영/삭제 stale 방지', async () => {
    await boot('chunk1-chip-label-index-live');
    const fixture = await ensureChipLabelPrefixFixture();
    const className = `e2e_chip_idx_${Date.now()}`;
    const coord = fixture.seeded?.[0]?.coords?.[0] || fixture.primary;

    let data = null;
    try {
      data = await page.evaluate(async ({ className, coord, waferPath }) => {
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

        const readAnnotations = async () => {
          const t0 = performance.now();
          const body = await jsonRequest(`/api/chip-annotations?path=${encodeURIComponent(waferPath)}`);
          return {
            ms: Math.round((performance.now() - t0) * 10) / 10,
            marked: body.marked_chips || [],
            metadata: body.metadata || {},
          };
        };

        const before = await readAnnotations();
        const classifyBody = await jsonRequest('/api/classify/chips', {
          method: 'POST',
          body: JSON.stringify({
            class_name: className,
            image_path: waferPath,
            chip_coords: [{ x_abs: Number(coord.x_abs), y_abs: Number(coord.y_abs) }],
          }),
        });
        const savedFile = classifyBody.saved_files?.[0]?.filename || '';

        const afterReads = [];
        for (let i = 0; i < 3; i += 1) {
          afterReads.push(await readAnnotations());
        }

        const deleteBody = await jsonRequest('/api/classes/delete?mode=chip', {
          method: 'POST',
          body: JSON.stringify({ names: [className] }),
        });

        const deletedReads = [];
        for (let i = 0; i < 2; i += 1) {
          deletedReads.push(await readAnnotations());
        }

        const hasClass = (read) => read.marked.some((chip) =>
          chip.class === className &&
          chip.filename === savedFile &&
          Number(chip.x_abs) === Number(coord.x_abs) &&
          Number(chip.y_abs) === Number(coord.y_abs)
        );

        return {
          className,
          waferPath,
          coord,
          beforeHit: hasClass(before),
          classifyBody,
          savedFile,
          afterHits: afterReads.map(hasClass),
          afterTimings: afterReads.map((read) => read.ms),
          afterCounts: afterReads.map((read) => read.marked.length),
          deleteBody,
          deletedHits: deletedReads.map(hasClass),
          deletedTimings: deletedReads.map((read) => read.ms),
          deletedCounts: deletedReads.map((read) => read.marked.length),
        };
      }, { className, coord, waferPath: fixture.waferPath });
    } finally {
      await page.evaluate(async (targetClass) => {
        await fetch('/api/classes/delete?mode=chip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ names: [targetClass] }),
        }).catch(() => {});
      }, className).catch(() => {});
    }

    expect(data.beforeHit === false, `index class should not exist before classify: ${JSON.stringify(data)}`);
    expect(data.classifyBody.saved_count === 1, `chip classify failed: ${JSON.stringify(data)}`);
    expect(data.afterHits.every(Boolean), `new chip label not visible through annotations immediately: ${JSON.stringify(data)}`);
    expect(Math.max(...data.afterTimings, ...data.deletedTimings) < 500, `chip annotation index lookup too slow: ${JSON.stringify(data)}`);
    expect(data.deleteBody.deleted?.includes(className), `chip class delete did not report target: ${JSON.stringify(data)}`);
    expect(data.deletedHits.every((hit) => hit === false), `deleted chip class still visible through annotations: ${JSON.stringify(data)}`);
    return data;
  });

  await record('chip-label-crud-ui', 'Chip label Class Manager CRUD / Label Explorer 다중선택 삭제+상세보기', async () => {
    await boot('chunk1-chip-label-crud-ui');
    const classes = {
      classSingle: 'e2e_chip_class_single',
      classMultiA: 'e2e_chip_class_multi_a',
      classMultiB: 'e2e_chip_class_multi_b',
      labelAdd: 'e2e_chip_label_add',
      labelSingleDelete: 'e2e_chip_label_single_delete',
      labelMultiDelete: 'e2e_chip_label_multi_delete',
      folderA: 'e2e_chip_label_folder_a',
      folderB: 'e2e_chip_label_folder_b',
    };

    await cleanupClassFixtures('chip', E2E_CHIP_LABEL_CRUD_CLASSES);
    try {
      const fixture = await ensureChipLabelPrefixFixture();
      const seedCoords = (fixture.seeded || [])
        .flatMap((item) => item.coords || [])
        .filter((coord) => Number.isFinite(Number(coord?.x_abs)) && Number.isFinite(Number(coord?.y_abs)))
        .map((coord) => ({ x_abs: Number(coord.x_abs), y_abs: Number(coord.y_abs) }));
      expect(seedCoords.length >= 7, `chip label CRUD seed coords too small=${JSON.stringify({ fixture })}`);

      await refreshClassificationUi('chip');
      const classSingleAdd = await addClassesViaUi('chip', [classes.classSingle]);
      expect(classSingleAdd.present.includes(classes.classSingle), `chip single class add failed=${JSON.stringify(classSingleAdd)}`);
      const classSingleDelete = await deleteClassesViaUiSelection('chip', [classes.classSingle]);
      expect(
        classSingleDelete.after.absent.includes(classes.classSingle),
        `chip single class delete failed=${JSON.stringify(classSingleDelete)}`
      );

      const classMultiAdd = await addClassesViaUi('chip', [classes.classMultiA, classes.classMultiB]);
      expect(
        [classes.classMultiA, classes.classMultiB].every((name) => classMultiAdd.present.includes(name)),
        `chip multi class add failed=${JSON.stringify(classMultiAdd)}`
      );
      const classMultiDelete = await deleteClassesViaUiSelection('chip', [classes.classMultiA, classes.classMultiB]);
      expect(
        [classes.classMultiA, classes.classMultiB].every((name) => classMultiDelete.after.absent.includes(name)),
        `chip multi class delete failed=${JSON.stringify(classMultiDelete)}`
      );

      const classMap = {
        [classes.labelAdd]: [],
        [classes.labelSingleDelete]: [seedCoords[0]],
        [classes.labelMultiDelete]: [seedCoords[1], seedCoords[2]],
        [classes.folderA]: [seedCoords[3], seedCoords[4]],
        [classes.folderB]: [seedCoords[5], seedCoords[6]],
      };
      await seedChipLabelClasses(fixture.waferPath, classMap);

      await openChipWaferSingle(fixture.waferPath);
      const selectedChipsForAdd = await selectVisibleChips(2);
      const addLabelDialogs = await addLabelToCurrentSelectionViaModal('chip', classes.labelAdd);
      const labelAddFiles = await waitForClassFileCount('chip', classes.labelAdd, 2, 'gte');
      expect(
        labelAddFiles.count >= 2,
        `chip label add failed=${JSON.stringify({ selectedChipsForAdd, addLabelDialogs, labelAddFiles })}`
      );

      await ensureLabelFolderOpen(classes.folderA, 2);
      const folderAOpenBeforeAdd = await waitForOpenLabelFolderCount(classes.folderA, 2);
      const selectedChipsForOpenFolderAdd = await selectVisibleChips(2);
      const openFolderAddDialogs = await addLabelToCurrentSelectionViaModal('chip', classes.folderA);
      const folderAOpenAfterAdd = await waitForOpenLabelFolderCount(classes.folderA, 4, 'gte');
      expect(
        folderAOpenBeforeAdd.open &&
          folderAOpenAfterAdd.open &&
          folderAOpenAfterAdd.count >= folderAOpenBeforeAdd.count + 2,
        `chip open label folder add did not preserve/update list=${JSON.stringify({
          folderAOpenBeforeAdd,
          selectedChipsForOpenFolderAdd,
          openFolderAddDialogs,
          folderAOpenAfterAdd,
        })}`
      );

      const singleFolderGrid = await selectLabelFoldersViaUi('chip', [classes.folderA]);
      expect(
        singleFolderGrid.selectedClasses.includes(classes.folderA) &&
          singleFolderGrid.currentGridImages >= 2 &&
          singleFolderGrid.role === 'label' &&
          singleFolderGrid.labelGrid === true,
        `chip single label folder grid failed=${JSON.stringify(singleFolderGrid)}`
      );

      const multiFolderGrid = await selectLabelFoldersViaUi('chip', [classes.folderA, classes.folderB]);
      expect(
        [classes.folderA, classes.folderB].every((name) => multiFolderGrid.selectedClasses.includes(name)) &&
          multiFolderGrid.currentGridImages >= 4 &&
          multiFolderGrid.role === 'label' &&
          multiFolderGrid.labelGrid === true,
        `chip multi label folder grid failed=${JSON.stringify(multiFolderGrid)}`
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
            expectedClasses.some((className) => path.includes(`classification_chips/${className}/`)) &&
            !!canvas &&
            getComputedStyle(canvas).display !== 'none';
        },
        { expectedClasses: [classes.folderA, classes.folderB] },
        { timeout: 30000 }
      );
      await sleep(1000);
      const multiFolderDetail = await page.evaluate(() => {
        const legend = document.getElementById('chip-label-legend');
        return {
          role: window.viewer.pageManager?.getActivePage?.()?.role || null,
          gridMode: window.viewer.gridMode,
          viewMode: window.viewer.viewMode,
          selectedImagePath: window.viewer.selectedImagePath || '',
          canvasVisible: getComputedStyle(document.getElementById('image-canvas')).display !== 'none',
          chipLegendDisplay: legend ? getComputedStyle(legend).display : null,
        };
      });
      expect(
        multiFolderDetail.canvasVisible &&
          /classification_chips\//i.test(multiFolderDetail.selectedImagePath),
        `chip label detail invalid=${JSON.stringify(multiFolderDetail)}`
      );

      await page.evaluate(() => window.viewer.exitSingleImageViewMode?.());
      await sleep(1000);
      await refreshClassificationUi('chip', Object.keys(classMap));

      await ensureLabelFolderOpen(classes.labelSingleDelete, 1);
      const singleDeleteOpenBefore = await waitForOpenLabelFolderCount(classes.labelSingleDelete, 1);
      const singleDeleteButton = await clickLabelDeleteButton(classes.labelSingleDelete, 0);
      const singleDeleteOpenAfter = await waitForOpenLabelFolderCount(classes.labelSingleDelete, 0);
      const singleDeleteFiles = await waitForClassFileCount('chip', classes.labelSingleDelete, 0);
      expect(
        singleDeleteOpenBefore.open &&
          singleDeleteOpenAfter.open &&
          singleDeleteOpenAfter.count === 0 &&
          singleDeleteFiles.count === 0,
        `chip single open folder label delete failed=${JSON.stringify({
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
        `chip label multi-select failed=${JSON.stringify({ firstMultiLabel, secondMultiLabel, multiLabelSelectedBeforeDelete })}`
      );
      const multiDeleteDialogs = await withAutoDialogs(async () => {
        await page.locator('#label-explorer-batch-delete-btn').click({ timeout: 10000 });
      });
      const multiDeleteOpenAfter = await waitForOpenLabelFolderCount(classes.labelMultiDelete, 0);
      const multiDeleteFiles = await waitForClassFileCount('chip', classes.labelMultiDelete, 0);
      expect(
        multiDeleteOpenAfter.open &&
          multiDeleteOpenAfter.count === 0 &&
          multiDeleteFiles.count === 0,
        `chip multi open folder label delete failed=${JSON.stringify({ multiDeleteDialogs, multiDeleteOpenAfter, multiDeleteFiles })}`
      );

      await ensureLabelFolderOpen(classes.folderA, 2);
      await ensureLabelFolderOpen(classes.folderB, 2);
      const folderAOpenBeforeFolderDelete = await waitForOpenLabelFolderCount(classes.folderA, 2, 'gte');
      const folderBOpenBeforeFolderDelete = await waitForOpenLabelFolderCount(classes.folderB, 2);
      const folderDeleteSelection = await selectLabelFoldersViaUi('chip', [classes.folderA, classes.folderB]);
      const folderAOpenSelectedBeforeDelete = await waitForOpenLabelFolderCount(classes.folderA, 2, 'gte');
      const folderBOpenSelectedBeforeDelete = await waitForOpenLabelFolderCount(classes.folderB, 2);
      const folderDeleteDialogs = await withAutoDialogs(async () => {
        await page.locator('#label-explorer-batch-delete-btn').click({ timeout: 10000 });
      });
      const folderAFilesAfterDelete = await waitForClassFileCount('chip', classes.folderA, 0);
      const folderBFilesAfterDelete = await waitForClassFileCount('chip', classes.folderB, 0);
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
        `chip folder label delete failed=${JSON.stringify({
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
        fixture: {
          waferPath: fixture.waferPath,
          markedCount: fixture.markedCount,
        },
        classSingleAdd,
        classSingleDelete,
        classMultiAdd,
        classMultiDelete,
        selectedChipsForAdd,
        labelAddFiles,
        addLabelDialogs: addLabelDialogs.dialogs,
        folderAOpenBeforeAdd,
        selectedChipsForOpenFolderAdd,
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
      await cleanupClassFixtures('chip', E2E_CHIP_LABEL_CRUD_CLASSES).catch((error) => {
        append(`[WARN] chip label CRUD cleanup failed :: ${String(error?.message || error)}\n`);
      });
    }
  });

  await record('chip-label-prefix-wafer', 'Chip label 5토큰 wafer 매칭/우클릭 Wafer 보기', async () => {
    await boot('chunk1-chip-label-prefix-wafer');
    const fixture = await ensureChipLabelPrefixFixture();
    const { waferPath, chipPath, labelKey, fullStem, chipPaths } = fixture;

    const data = await page.evaluate(async ({ waferPath, chipPath, labelKey, primary }) => {
      const annotationTimings = [];
      let marked = [];
      let metadata = {};
      for (let i = 0; i < 5; i += 1) {
        const t0 = performance.now();
        const res = await fetch(`/api/chip-annotations?path=${encodeURIComponent(waferPath)}`);
        const body = await res.json();
        const t1 = performance.now();
        if (!res.ok) {
          throw new Error(`chip annotations failed status=${res.status} body=${JSON.stringify(body)}`);
        }
        annotationTimings.push(Math.round((t1 - t0) * 10) / 10);
        marked = body.marked_chips || [];
        metadata = body.metadata || {};
      }

      const lookupStart = performance.now();
      const waferRes = await fetch(`/api/chip-label-wafer?path=${encodeURIComponent(chipPath)}`);
      const waferLookup = await waferRes.json();
      const lookupMs = Math.round((performance.now() - lookupStart) * 10) / 10;
      if (!waferRes.ok) {
        throw new Error(`chip label wafer lookup failed status=${waferRes.status} body=${JSON.stringify(waferLookup)}`);
      }

      const v = window.viewer;
      const beforeUi = {
        pageCount: v.pageManager?.pages?.length || 0,
        activeRole: v.pageManager?.getActivePage?.()?.role || null,
      };
      v.classMode = 'chip';
      v.showLabelExplorerChipContextMenu({ clientX: 160, clientY: 140 }, labelKey);
      const menuEl = document.getElementById('label-chip-context-menu');
      const rect = menuEl?.getBoundingClientRect?.();

      return {
        annotationTimings,
        annotationAvgMs: Math.round((annotationTimings.reduce((a, b) => a + b, 0) / annotationTimings.length) * 10) / 10,
        markedHit: marked.some((chip) =>
          chip.class === primary.className &&
          Number(chip.x_abs) === Number(primary.x_abs) &&
          Number(chip.y_abs) === Number(primary.y_abs) &&
          String(chip.b) === String(primary.b)
        ),
        markedCount: marked.length,
        metadata,
        waferLookup,
        lookupMs,
        beforeUi,
        menu: {
          text: menuEl?.innerText || '',
          visible: !!menuEl && rect.width > 0 && rect.height > 0,
        },
      };
    }, { waferPath, chipPath, labelKey, primary: fixture.primary });

    expect(data.markedHit, `5-token prefix chip annotation missing: ${JSON.stringify(data)}`);
    expect(data.markedCount >= 1, `marked chip count invalid: ${JSON.stringify(data)}`);
    expect(data.annotationAvgMs < 500, `chip annotation prefix lookup too slow: ${JSON.stringify(data)}`);
    expect(
      String(data.waferLookup?.wafer_path || '').replace(/\\/g, '/').toLowerCase() === waferPath.toLowerCase(),
      `related wafer path mismatch: ${JSON.stringify(data.waferLookup)}`
    );
    expect(
      data.waferLookup?.wafer_key === fixture.waferKey,
      `wafer key mismatch: ${JSON.stringify(data.waferLookup)}`
    );
    expect(
      data.menu.visible && data.menu.text.includes('Wafer 보기') && data.menu.text.includes('Lot 보기'),
      `chip label explorer context menu invalid: ${JSON.stringify(data.menu)}`
    );
    await page.locator('#label-chip-context-menu .context-menu-item', { hasText: 'Wafer 보기' }).click({ timeout: 10000 });
    await page.waitForFunction((expectedStemLower) => {
      const v = window.viewer;
      return !!v &&
        v.viewMode === 'single' &&
        v.gridMode === false &&
        v.pageManager?.getActivePage?.()?.role === 'wafer' &&
        String(v.selectedImagePath || '').toLowerCase().includes(expectedStemLower);
    }, fullStem.toLowerCase(), { timeout: 90000 });
    const labelExplorerWaferSingle = await page.evaluate(() => ({
      activeRole: window.viewer.pageManager?.getActivePage?.()?.role || null,
      pageCount: window.viewer.pageManager?.pages?.length || 0,
      gridMode: window.viewer.gridMode,
      viewMode: window.viewer.viewMode,
      selectedImagePath: window.viewer.selectedImagePath || '',
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
    }));
    expect(
      labelExplorerWaferSingle.pageCount === data.beforeUi.pageCount + 1,
      `label explorer wafer single tab was not created: before=${JSON.stringify(data.beforeUi)} after=${JSON.stringify(labelExplorerWaferSingle)}`
    );
    expect(
      labelExplorerWaferSingle.activeRole === 'wafer' &&
        labelExplorerWaferSingle.gridMode === false &&
        labelExplorerWaferSingle.viewMode === 'single',
      `label explorer wafer should open single view directly: ${JSON.stringify(labelExplorerWaferSingle)}`
    );
    expect(
      String(labelExplorerWaferSingle.selectedImagePath || '').replace(/\\/g, '/').toLowerCase() === waferPath.toLowerCase(),
      `label explorer wafer single result mismatch: ${JSON.stringify(labelExplorerWaferSingle)}`
    );

    const gridMenu = await page.evaluate(async ({ chipPaths }) => {
      const v = window.viewer;
      v.showGrid(chipPaths, false, true);
      v.gridSelectedIdxs = [0, 1];
      v.gridSelectedSet = new Set([0, 1]);
      v.updateGridSelection?.();
      v.updateSelectedGridImagesList?.();
      return { before: { pageCount: v.pageManager?.pages?.length || 0 } };
    }, { chipPaths });
    await page.waitForSelector('#image-grid .grid-thumb-wrap', { timeout: 30000 });
    await page.locator('#image-grid .grid-thumb-wrap').first().click({
      button: 'right',
      position: { x: 20, y: 20 },
      timeout: 10000,
    });
    await page.waitForFunction(() => {
      const menu = document.getElementById('grid-context-menu');
      const waferItem = document.getElementById('context-chip-wafer-view');
      const lotItem = document.getElementById('context-chip-lot-view');
      return menu && getComputedStyle(menu).display !== 'none' &&
        waferItem && getComputedStyle(waferItem).display !== 'none' &&
        lotItem && getComputedStyle(lotItem).display !== 'none';
    }, null, { timeout: 10000 });

    const gridMenuAfterRightClick = await page.evaluate(() => {
      const waferItem = document.getElementById('context-chip-wafer-view');
      const lotItem = document.getElementById('context-chip-lot-view');

      return {
        selected: window.viewer.getSelectedImagesForModal(),
        contextPaths: window.viewer.getChipLabelContextPaths(),
        menuText: document.getElementById('grid-context-menu')?.innerText || '',
        waferDisplay: waferItem ? getComputedStyle(waferItem).display : null,
        lotDisplay: lotItem ? getComputedStyle(lotItem).display : null,
      };
    });
    expect(gridMenuAfterRightClick.selected.length === 2, `chip label grid multi-select failed: ${JSON.stringify(gridMenuAfterRightClick)}`);
    expect(gridMenuAfterRightClick.contextPaths.length === 2, `chip label grid context paths invalid: ${JSON.stringify(gridMenuAfterRightClick)}`);
    expect(
      gridMenuAfterRightClick.menuText.includes('Wafer 보기') &&
        gridMenuAfterRightClick.menuText.includes('Lot 보기') &&
        gridMenuAfterRightClick.waferDisplay !== 'none' &&
        gridMenuAfterRightClick.lotDisplay !== 'none',
      `chip label grid right-click menu hidden: ${JSON.stringify(gridMenuAfterRightClick)}`
    );

    await page.locator('#context-chip-wafer-view').click({ timeout: 10000 });
    await page.waitForFunction((expectedStemLower) => {
      const v = window.viewer;
      return !!v &&
        v.viewMode === 'single' &&
        v.gridMode === false &&
        v.pageManager?.getActivePage?.()?.role === 'wafer' &&
        String(v.selectedImagePath || '').toLowerCase().includes(expectedStemLower);
    }, fullStem.toLowerCase(), { timeout: 90000 });
    await sleep(800);

    const waferSingle = await page.evaluate(() => ({
      activeRole: window.viewer.pageManager?.getActivePage?.()?.role || null,
      pageCount: window.viewer.pageManager?.pages?.length || 0,
      gridMode: window.viewer.gridMode,
      viewMode: window.viewer.viewMode,
      selectedImagePath: window.viewer.selectedImagePath || '',
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
    }));
    expect(waferSingle.pageCount === gridMenu.before.pageCount + 1, `wafer single tab was not created: before=${JSON.stringify(gridMenu.before)} after=${JSON.stringify(waferSingle)}`);
    expect(waferSingle.activeRole === 'wafer' && waferSingle.gridMode === false && waferSingle.viewMode === 'single', `single wafer result should open directly: ${JSON.stringify(waferSingle)}`);
    expect(
      String(waferSingle.selectedImagePath || '').replace(/\\/g, '/').toLowerCase() === waferPath.toLowerCase(),
      `wafer single result mismatch: ${JSON.stringify(waferSingle)}`
    );
    expect(!/classification_chips|obj_id_maps/i.test(waferSingle.selectedImagePath), `derived path in wafer result: ${JSON.stringify(waferSingle)}`);
    await sleep(1200);

    const waferSinglePanel = await page.evaluate(() => {
      const legendText = document.getElementById('chip-label-legend')?.innerText || document.body.innerText || '';
      const marked = window.viewer.chipAnnotator?.markedChips ||
        window.viewer.chipAnnotator?.annotations ||
        window.viewer.chipAnnotator?.chipAnnotations ||
        [];
      return {
        selectedImagePath: window.viewer.selectedImagePath,
        folderText: document.getElementById('file-path-text')?.textContent || '',
        fileNameText: document.getElementById('file-name-text')?.textContent || '',
        separatorDisplay: getComputedStyle(document.getElementById('separator-text')).display,
        markedCount: Array.isArray(marked) ? marked.length : null,
        legendHasLabels: /bank_boundary|scratch|invalid_main|fork/.test(legendText),
        legendSnippet: legendText.slice(0, 300),
      };
    });
    expect(
      waferSinglePanel.folderText === fixture.folderName,
      `wafer single folder missing: expected=${fixture.folderName} actual=${JSON.stringify(waferSinglePanel)}`
    );
    expect(waferSinglePanel.separatorDisplay !== 'none', `wafer single separator hidden: ${JSON.stringify(waferSinglePanel)}`);
    expect(waferSinglePanel.fileNameText.toLowerCase() === fullStem.toLowerCase(), `wafer single filename mismatch: ${JSON.stringify(waferSinglePanel)}`);
    expect(
      waferSinglePanel.legendHasLabels || (waferSinglePanel.markedCount && waferSinglePanel.markedCount > 0),
      `wafer single chip labels missing: ${JSON.stringify(waferSinglePanel)}`
    );

    const readChipLabelLegendState = () => page.evaluate(() => {
      const legend = document.getElementById('chip-label-legend');
      const pills = Array.from(legend?.querySelectorAll('button[data-chip-label]') || []);
      const toggle = document.getElementById('chip-label-overlay-toggle');
      return {
        visible: !!legend && getComputedStyle(legend).display !== 'none',
        count: pills.length,
        activeCount: pills.filter((pill) => pill.classList.contains('is-active')).length,
        invalidMainActive: !!pills.find((pill) =>
          pill.getAttribute('data-chip-label') === 'invalid_main' && pill.classList.contains('is-active')
        ),
        toggleChecked: !!toggle?.checked,
        overlayEnabled: window.viewer.chipLabelOverlayEnabled,
        overlayAlpha: window.viewer.chipAnnotator?.chipLabelOverlayAlpha ?? null,
      };
    });
    let legendBefore = await readChipLabelLegendState();
    expect(legendBefore.visible && legendBefore.count >= 2, `chip label legend not ready: ${JSON.stringify(legendBefore)}`);
    if (!legendBefore.toggleChecked || !legendBefore.overlayEnabled || legendBefore.activeCount !== legendBefore.count) {
      if (!legendBefore.toggleChecked || !legendBefore.overlayEnabled) {
        await page.locator('#chip-label-overlay-toggle').check({ timeout: 10000 });
      } else {
        await page.evaluate(() => window.viewer.setChipLabelOverlayEnabled?.(true, { persist: true }));
      }
      await page.waitForFunction(() => {
        const pills = document.querySelectorAll('#chip-label-legend .chip-label-pill');
        const activePills = document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active');
        const filter = window.viewer.chipAnnotator?.legendFilterClasses;
        return window.viewer.chipLabelOverlayEnabled === true &&
          document.getElementById('chip-label-overlay-toggle')?.checked === true &&
          pills.length > 0 &&
          activePills.length === pills.length &&
          filter instanceof Set &&
          filter.size === pills.length;
      }, null, { timeout: 5000 });
      legendBefore = await readChipLabelLegendState();
    }
    expect(legendBefore.toggleChecked === true && legendBefore.overlayEnabled === true, `chip label overlay toggle should be on before selection checks: ${JSON.stringify(legendBefore)}`);
    expect(legendBefore.overlayAlpha === 0.15, `chip label overlay alpha should be 15%: ${JSON.stringify(legendBefore)}`);
    expect(legendBefore.activeCount === legendBefore.count, `chip label classes should all be active by default: ${JSON.stringify(legendBefore)}`);
    expect(legendBefore.invalidMainActive, `invalid_main should be active by default: ${JSON.stringify(legendBefore)}`);

    const selectedChipClassFilter = await page.evaluate(async () => {
      const v = window.viewer;
      const annotator = v.chipAnnotator;
      const marked = (annotator.markedChips || []).find(chip => chip.class === 'bank_boundary') ||
        (annotator.markedChips || [])[0];
      if (!marked) {
        throw new Error('marked chip for selection filter not found');
      }
      const selectedIndex = (annotator.chips || []).findIndex(chip =>
        chip &&
        String(chip.x_abs) === String(marked.x_abs) &&
        String(chip.y_abs) === String(marked.y_abs)
      );
      if (selectedIndex < 0) {
        throw new Error(`marked chip index not found: ${JSON.stringify(marked)}`);
      }
      annotator.selectedChips = new Set([selectedIndex]);
      annotator.selectedChipsOrder = [selectedIndex];
      annotator.updateSelectedChipsList?.();
      await new Promise(resolve => setTimeout(resolve, 250));
      const active = Array.from(document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active'))
        .map(pill => pill.getAttribute('data-chip-label'));
      const filter = annotator.legendFilterClasses instanceof Set
        ? Array.from(annotator.legendFilterClasses)
        : null;
      return {
        markedClass: marked.class || marked.label,
        selectedIndex,
        active,
        filter,
        activeCount: active.length,
        filterSize: filter ? filter.length : null,
      };
    });
    expect(
      selectedChipClassFilter.active.length === 1 &&
        selectedChipClassFilter.active[0] === selectedChipClassFilter.markedClass &&
        selectedChipClassFilter.filter?.length === 1 &&
        selectedChipClassFilter.filter[0] === selectedChipClassFilter.markedClass,
      `chip selection should narrow chip labels to selected object class: ${JSON.stringify(selectedChipClassFilter)}`
    );
    await page.evaluate(() => {
      const v = window.viewer;
      const annotator = v.chipAnnotator;
      annotator.selectedChips?.clear?.();
      annotator.selectedChipsOrder = [];
      v.handleChipSelectionCleared?.();
    });
    await page.waitForFunction(() => {
      const pills = document.querySelectorAll('#chip-label-legend .chip-label-pill');
      const activePills = document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active');
      return pills.length > 0 && activePills.length === pills.length;
    }, null, { timeout: 5000 });

    await page.locator('#chip-label-overlay-toggle').uncheck({ timeout: 10000 });
    await page.waitForFunction(() => {
      const activePills = document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active').length;
      const filter = window.viewer.chipAnnotator?.legendFilterClasses;
      return window.viewer.chipLabelOverlayEnabled === false &&
        document.getElementById('chip-label-overlay-toggle')?.checked === false &&
        activePills === 0 &&
        filter instanceof Set &&
        filter.size === 0;
    }, null, { timeout: 5000 });
    await page.waitForFunction(async () => {
      const res = await fetch(`/api/user-prefs?LoginId=${encodeURIComponent(window.viewer.getCurrentLoginId())}`);
      const body = await res.json();
      return body?.prefs?.chipLabelOverlayEnabled === false;
    }, null, { timeout: 5000 });
    const legendToggleOff = await page.evaluate(async () => {
      const res = await fetch(`/api/user-prefs?LoginId=${encodeURIComponent(window.viewer.getCurrentLoginId())}`);
      const body = await res.json();
      return {
        overlayEnabled: window.viewer.chipLabelOverlayEnabled,
        toggleChecked: document.getElementById('chip-label-overlay-toggle')?.checked,
        activePills: document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active').length,
        prefValue: body?.prefs?.chipLabelOverlayEnabled,
      };
    });
    expect(
      legendToggleOff.overlayEnabled === false &&
        legendToggleOff.toggleChecked === false &&
        legendToggleOff.activePills === 0 &&
        legendToggleOff.prefValue === false,
      `chip label overlay toggle off failed: ${JSON.stringify(legendToggleOff)}`
    );

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => !!window.viewer && window.__l3FullViewerReady === true,
      null,
      { timeout: 90000 }
    );
    await page.evaluate(async (targetPath) => {
      await window.viewer.enterSingleViewMode(targetPath);
    }, waferPath);
    await page.waitForFunction((expectedStemLower) => {
      const v = window.viewer;
      return !!v &&
        v.viewMode === 'single' &&
        v.gridMode === false &&
        String(v.selectedImagePath || '').toLowerCase().includes(expectedStemLower);
    }, fullStem.toLowerCase(), { timeout: 90000 });
    await page.waitForFunction(() => {
      const legend = document.getElementById('chip-label-legend');
      const pills = document.querySelectorAll('#chip-label-legend .chip-label-pill');
      const activePills = document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active').length;
      const toggle = document.getElementById('chip-label-overlay-toggle');
      const filter = window.viewer.chipAnnotator?.legendFilterClasses;
      return !!legend &&
        getComputedStyle(legend).display !== 'none' &&
        pills.length > 0 &&
        window.viewer.chipLabelOverlayEnabled === false &&
        toggle?.checked === false &&
        activePills === 0 &&
        filter instanceof Set &&
        filter.size === 0;
    }, null, { timeout: 30000 });
    const legendReloadOff = await page.evaluate(() => ({
      overlayEnabled: window.viewer.chipLabelOverlayEnabled,
      toggleChecked: document.getElementById('chip-label-overlay-toggle')?.checked,
      count: document.querySelectorAll('#chip-label-legend .chip-label-pill').length,
      activePills: document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active').length,
      filterSize: window.viewer.chipAnnotator?.legendFilterClasses?.size ?? null,
    }));

    await page.locator('#chip-label-overlay-toggle').check({ timeout: 10000 });
    await page.waitForFunction(() => {
      const pills = document.querySelectorAll('#chip-label-legend .chip-label-pill');
      const activePills = document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active').length;
      const filter = window.viewer.chipAnnotator?.legendFilterClasses;
      return window.viewer.chipLabelOverlayEnabled === true &&
        document.getElementById('chip-label-overlay-toggle')?.checked === true &&
        activePills === pills.length &&
        filter instanceof Set &&
        filter.size === pills.length &&
        pills.length > 0;
    }, null, { timeout: 5000 });
    await page.waitForFunction(async () => {
      const res = await fetch(`/api/user-prefs?LoginId=${encodeURIComponent(window.viewer.getCurrentLoginId())}`);
      const body = await res.json();
      return body?.prefs?.chipLabelOverlayEnabled === true;
    }, null, { timeout: 5000 });
    const legendReloadToggleOn = await page.evaluate(async () => {
      const res = await fetch(`/api/user-prefs?LoginId=${encodeURIComponent(window.viewer.getCurrentLoginId())}`);
      const body = await res.json();
      return {
        overlayEnabled: window.viewer.chipLabelOverlayEnabled,
        toggleChecked: document.getElementById('chip-label-overlay-toggle')?.checked,
        count: document.querySelectorAll('#chip-label-legend .chip-label-pill').length,
        activePills: document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active').length,
        filterSize: window.viewer.chipAnnotator?.legendFilterClasses?.size ?? null,
        prefValue: body?.prefs?.chipLabelOverlayEnabled,
      };
    });
    expect(
      legendReloadToggleOn.count > 0 &&
        legendReloadToggleOn.activePills === legendReloadToggleOn.count &&
        legendReloadToggleOn.filterSize === legendReloadToggleOn.count &&
        legendReloadToggleOn.prefValue === true,
      `chip label overlay reload-on should select all classes: off=${JSON.stringify(legendReloadOff)} on=${JSON.stringify(legendReloadToggleOn)}`
    );

    const legendSizing = await page.evaluate(() => {
      const legend = document.getElementById('chip-label-legend');
      const fileBar = document.getElementById('file-name-display');
      const legendRect = legend?.getBoundingClientRect?.();
      const fileRect = fileBar?.getBoundingClientRect?.();
      return {
        width: legendRect ? Math.round(legendRect.width) : 0,
        left: legendRect ? Math.round(legendRect.left) : null,
        fileBarLeft: fileRect ? Math.round(fileRect.left) : null,
        visible: !!legend && getComputedStyle(legend).display !== 'none',
      };
    });
    expect(
      legendSizing.visible && legendSizing.width >= 178 && legendSizing.width <= 182,
      `chip label legend width should be 80% of previous 224px width: ${JSON.stringify(legendSizing)}`
    );

    const titleBox = await page.locator('#chip-label-legend .chip-label-legend__title').boundingBox();
    expect(!!titleBox, 'chip label legend title missing');
    const transformBeforeLegendDrag = await page.evaluate(() => ({
      dx: window.viewer.transform.dx,
      dy: window.viewer.transform.dy,
    }));
    await page.mouse.move(titleBox.x + 8, titleBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(titleBox.x + 96, titleBox.y + 22, { steps: 6 });
    await page.mouse.up();
    const transformAfterLegendDrag = await page.evaluate(() => ({
      dx: window.viewer.transform.dx,
      dy: window.viewer.transform.dy,
    }));
    expect(
      Math.abs(transformAfterLegendDrag.dx - transformBeforeLegendDrag.dx) < 0.1 &&
        Math.abs(transformAfterLegendDrag.dy - transformBeforeLegendDrag.dy) < 0.1,
      `chip label legend drag should not pan image: before=${JSON.stringify(transformBeforeLegendDrag)} after=${JSON.stringify(transformAfterLegendDrag)}`
    );

    const legendBox = await page.locator('#chip-label-legend').boundingBox();
    expect(!!legendBox, 'chip label legend box missing');
    await page.mouse.click(legendBox.x + 12, legendBox.y + 12, { button: 'right' });
    await page.waitForFunction(() => {
      const active = window.viewer.activeChipLabelClasses;
      const filter = window.viewer.chipAnnotator?.legendFilterClasses;
      return active instanceof Set && filter instanceof Set && active.size === 0 && filter.size === 0;
    }, null, { timeout: 5000 });

    const pillBoxes = await page.locator('#chip-label-legend button[data-chip-label]').evaluateAll((els) =>
      els.slice(0, Math.min(3, els.length)).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          className: el.getAttribute('data-chip-label'),
          cx: rect.left + rect.width / 2,
          cy: rect.top + rect.height / 2,
        };
      })
    );
    expect(pillBoxes.length >= 2, `not enough chip label pills for drag selection: ${JSON.stringify(pillBoxes)}`);

    const rangeClickPillBoxes = await page.locator('#chip-label-legend button[data-chip-label]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-chip-label'))
    );
    const scratchIdx = rangeClickPillBoxes.indexOf('scratch');
    const forkIdx = rangeClickPillBoxes.indexOf('fork');
    expect(
      scratchIdx !== -1 && forkIdx !== -1 && scratchIdx < forkIdx,
      `scratch -> fork range setup failed: ${JSON.stringify(rangeClickPillBoxes)}`
    );
    const expectedShiftClickRange = rangeClickPillBoxes.slice(scratchIdx, forkIdx + 1);
    await page.locator('#chip-label-legend button[data-chip-label="scratch"]').click({ timeout: 10000 });
    await page.waitForFunction(() => {
      const active = window.viewer.activeChipLabelClasses;
      return active instanceof Set && active.size === 1 && active.has('scratch');
    }, null, { timeout: 5000 });
    await page.keyboard.down('Shift');
    await page.locator('#chip-label-legend button[data-chip-label="fork"]').click({ timeout: 10000 });
    await page.keyboard.up('Shift');
    await page.waitForFunction((expected) => {
      const active = window.viewer.activeChipLabelClasses;
      return active instanceof Set &&
        active.size === expected.length &&
        expected.every(cls => active.has(cls));
    }, expectedShiftClickRange, { timeout: 5000 });
    const shiftClickRangeState = await page.evaluate(() => ({
      active: Array.from(window.viewer.activeChipLabelClasses || []),
      filter: Array.from(window.viewer.chipAnnotator?.legendFilterClasses || []),
    }));
    expect(
      expectedShiftClickRange.every((className) => shiftClickRangeState.active.includes(className)) &&
        shiftClickRangeState.active.length === expectedShiftClickRange.length &&
        shiftClickRangeState.filter.length === expectedShiftClickRange.length,
      `shift click range should select scratch through fork: expected=${JSON.stringify(expectedShiftClickRange)} actual=${JSON.stringify(shiftClickRangeState)}`
    );

    await page.mouse.click(legendBox.x + 12, legendBox.y + 12, { button: 'right' });
    await page.waitForFunction(() => window.viewer.activeChipLabelClasses instanceof Set && window.viewer.activeChipLabelClasses.size === 0, null, { timeout: 5000 });

    await page.keyboard.down('Shift');
    await page.mouse.move(pillBoxes[0].cx, pillBoxes[0].cy);
    await page.mouse.down();
    await page.mouse.move(pillBoxes[pillBoxes.length - 1].cx, pillBoxes[pillBoxes.length - 1].cy, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForFunction((expectedCount) => {
      const active = window.viewer.activeChipLabelClasses;
      return active instanceof Set && active.size === expectedCount;
    }, pillBoxes.length, { timeout: 5000 });

    const shiftDragState = await page.evaluate(() => ({
      active: Array.from(window.viewer.activeChipLabelClasses || []),
      activePills: Array.from(document.querySelectorAll('#chip-label-legend .chip-label-pill.is-active'))
        .map((pill) => pill.getAttribute('data-chip-label')),
    }));
    expect(
      pillBoxes.every((pill) => shiftDragState.active.includes(pill.className)),
      `shift drag did not activate expected chip labels: expected=${JSON.stringify(pillBoxes)} actual=${JSON.stringify(shiftDragState)}`
    );

    await page.mouse.click(legendBox.x + 12, legendBox.y + 12, { button: 'right' });
    await page.waitForFunction(() => window.viewer.activeChipLabelClasses instanceof Set && window.viewer.activeChipLabelClasses.size === 0, null, { timeout: 5000 });
    await page.keyboard.down('Control');
    await page.mouse.move(pillBoxes[0].cx, pillBoxes[0].cy);
    await page.mouse.down();
    await page.mouse.move(pillBoxes[1].cx, pillBoxes[1].cy, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await page.waitForFunction(() => {
      const active = window.viewer.activeChipLabelClasses;
      return active instanceof Set && active.size === 2;
    }, null, { timeout: 5000 });

    const ctrlDragState = await page.evaluate(() => ({
      active: Array.from(window.viewer.activeChipLabelClasses || []),
      filter: Array.from(window.viewer.chipAnnotator?.legendFilterClasses || []),
    }));
    expect(
      pillBoxes.slice(0, 2).every((pill) => ctrlDragState.active.includes(pill.className)) &&
        ctrlDragState.filter.length === ctrlDragState.active.length,
      `ctrl drag did not toggle expected chip labels: expected=${JSON.stringify(pillBoxes.slice(0, 2))} actual=${JSON.stringify(ctrlDragState)}`
    );

    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.mouse.move(pillBoxes[1].cx, pillBoxes[1].cy);
    await page.mouse.down();
    await page.mouse.move(pillBoxes[pillBoxes.length - 1].cx, pillBoxes[pillBoxes.length - 1].cy, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForFunction((expectedCount) => {
      const active = window.viewer.activeChipLabelClasses;
      return active instanceof Set && active.size === expectedCount;
    }, pillBoxes.length, { timeout: 5000 });

    const ctrlShiftDragState = await page.evaluate(() => ({
      active: Array.from(window.viewer.activeChipLabelClasses || []),
      filter: Array.from(window.viewer.chipAnnotator?.legendFilterClasses || []),
    }));
    expect(
      pillBoxes.every((pill) => ctrlShiftDragState.active.includes(pill.className)) &&
        ctrlShiftDragState.filter.length === ctrlShiftDragState.active.length,
      `ctrl+shift drag did not add range to chip labels: expected=${JSON.stringify(pillBoxes)} actual=${JSON.stringify(ctrlShiftDragState)}`
    );

    const ctrlShiftChipDragState = await (async () => {
      const dragBox = await page.evaluate(() => {
        const v = window.viewer;
        const ca = v.chipAnnotator;
        if (!ca || !ca.canvas || !Array.isArray(ca.chips)) return { ok: false, reason: 'chip annotator missing' };
        v.setChipLabelLegendClasses?.(null);
        ca.clearSelection?.(false);
        const canvasRect = ca.canvas.getBoundingClientRect();
        const active = ca.legendFilterClasses instanceof Set ? ca.legendFilterClasses : null;
        const candidateChips = (ca.markedChips || [])
          .filter(marked => !active || active.has(marked.class || marked.label))
          .map(marked => (ca.chips || []).find(chip =>
            chip && chip.x_abs === marked.x_abs && chip.y_abs === marked.y_abs && chip.rect
          ))
          .filter(Boolean);
        if (candidateChips.length < 2) return { ok: false, reason: 'not enough marked chips', count: candidateChips.length };

        let pair = null;
        let bestDistance = Infinity;
        for (let i = 0; i < candidateChips.length; i += 1) {
          for (let j = i + 1; j < candidateChips.length; j += 1) {
            const a = candidateChips[i];
            const b = candidateChips[j];
            const ax = (a.rect.x0 + a.rect.x1) / 2;
            const ay = (a.rect.y0 + a.rect.y1) / 2;
            const bx = (b.rect.x0 + b.rect.x1) / 2;
            const by = (b.rect.y0 + b.rect.y1) / 2;
            const distance = Math.hypot(ax - bx, ay - by);
            if (distance > 10 && distance < bestDistance) {
              bestDistance = distance;
              pair = [a, b];
            }
          }
        }
        if (!pair) return { ok: false, reason: 'marked chip pair missing', count: candidateChips.length };

        const pairCenters = pair.map(chip => ({
          x: (chip.rect.x0 + chip.rect.x1) / 2,
          y: (chip.rect.y0 + chip.rect.y1) / 2,
        }));
        const scale = 1.25;
        const yOffset = ca.Y_OFFSET || 0;
        const centerImgX = (pairCenters[0].x + pairCenters[1].x) / 2;
        const centerImgY = (pairCenters[0].y + pairCenters[1].y) / 2;
        v.transform.scale = scale;
        v.zoom = scale;
        v.transform.dx = Math.round(ca.canvas.width / 2 - centerImgX * scale);
        v.transform.dy = Math.round(ca.canvas.height / 2 - centerImgY * scale - yOffset);
        v.updatePyramidLevel?.();
        ca.render?.();

        const centers = pairCenters.map(center => ({
          x: center.x * scale + v.transform.dx,
          y: center.y * scale + v.transform.dy + yOffset,
        }));
        const minX = Math.max(24, Math.min(...centers.map(center => center.x)) - 8);
        const maxX = Math.min(ca.canvas.width - 24, Math.max(...centers.map(center => center.x)) + 8);
        const minY = Math.max(24, Math.min(...centers.map(center => center.y)) - 8);
        const maxY = Math.min(ca.canvas.height - 24, Math.max(...centers.map(center => center.y)) + 8);
        const toClient = (x, y) => ({
          x: canvasRect.left + x * canvasRect.width / ca.canvas.width,
          y: canvasRect.top + y * canvasRect.height / ca.canvas.height,
        });
        return {
          ok: true,
          expectedMin: 2,
          pairDistance: bestDistance,
          start: toClient(minX, minY),
          end: toClient(maxX, maxY),
        };
      });
      expect(dragBox.ok, `ctrl+shift chip drag setup failed: ${JSON.stringify(dragBox)}`);
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.mouse.move(dragBox.start.x, dragBox.start.y);
      await page.mouse.down();
      await page.mouse.move(dragBox.end.x, dragBox.end.y, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await page.waitForFunction((expectedMin) => {
        const selected = window.viewer.chipAnnotator?.selectedChips;
        return selected instanceof Set && selected.size >= expectedMin;
      }, dragBox.expectedMin, { timeout: 5000 });
      return await page.evaluate(() => ({
        selectedCount: window.viewer.chipAnnotator?.selectedChips?.size || 0,
        selectedOrderCount: window.viewer.chipAnnotator?.selectedChipsOrder?.length || 0,
      }));
    })();
    expect(
      ctrlShiftChipDragState.selectedCount >= 2,
      `ctrl+shift drag did not multi-select chips on wafer: ${JSON.stringify(ctrlShiftChipDragState)}`
    );

    await page.evaluate(() => window.viewer.setChipLabelLegendClasses?.(null));
    const overlayInteriorCheck = await page.evaluate(() => {
      const v = window.viewer;
      const ca = v.chipAnnotator;
      ca.clearSelection?.(false);
      ca.hoveredChip = null;
      ca._tempDragSelection = null;
      ca.shiftClickPos = null;
      ca.dragStartChip = null;
      ca.ctrlClickStartPos = null;
      ca.clickStartPos = null;
      ca.render();
      const active = ca.legendFilterClasses instanceof Set ? ca.legendFilterClasses : null;
      const transform = v.transform;
      const yOffset = ca.Y_OFFSET || 0;
      const clamp = (value, max) => Math.max(0, Math.min(max - 1, Math.round(value)));
      const samplePointsForChip = (chip) => {
        const left = chip.rect.x0 * transform.scale + transform.dx;
        const top = chip.rect.y0 * transform.scale + transform.dy + yOffset;
        const right = chip.rect.x1 * transform.scale + transform.dx;
        const bottom = chip.rect.y1 * transform.scale + transform.dy + yOffset;
        const inset = Math.min(
          Math.abs(right - left) / 2,
          Math.abs(bottom - top) / 2,
          Math.max(1, transform.scale)
        );
        const insideX = Math.ceil(left + inset) + 1;
        const insideY = Math.ceil(top + inset) + 1;
        const boundaryX = Math.floor(left);
        const boundaryY = Math.floor(top + Math.min(inset, Math.abs(bottom - top) / 2));
        const pointsInCanvas =
          insideX >= 0 && insideX < ca.canvas.width &&
          insideY >= 0 && insideY < ca.canvas.height &&
          boundaryX >= 0 && boundaryX < ca.canvas.width &&
          boundaryY >= 0 && boundaryY < ca.canvas.height &&
          (insideX !== boundaryX || insideY !== boundaryY);
        return {
          pointsInCanvas,
          insideX: clamp(insideX, ca.canvas.width),
          insideY: clamp(insideY, ca.canvas.height),
          boundaryX: clamp(boundaryX, ca.canvas.width),
          boundaryY: clamp(boundaryY, ca.canvas.height),
          rect: { left, top, right, bottom, inset },
        };
      };

      const markedEntries = (ca.markedChips || [])
        .filter((markedChip) => !active || active.has(markedChip.class || markedChip.label))
        .map((markedChip) => {
          const chip = (ca.chips || []).find((candidate) =>
            candidate && candidate.x_abs === markedChip.x_abs && candidate.y_abs === markedChip.y_abs
          );
          return { marked: markedChip, chip, sample: chip?.rect ? samplePointsForChip(chip) : null };
        });
      const entry = markedEntries.find((item) => item.chip && item.sample?.pointsInCanvas);
      const marked = entry?.marked;
      if (!marked) return { ok: false, reason: 'active marked chip missing' };
      const chip = entry?.chip;
      if (!chip || !chip.rect) return { ok: false, reason: 'chip rect missing', marked };

      const { insideX, insideY, boundaryX, boundaryY, rect } = entry.sample;
      const insideAlpha = ca.ctx.getImageData(insideX, insideY, 1, 1).data[3];
      const boundaryAlpha = ca.ctx.getImageData(boundaryX, boundaryY, 1, 1).data[3];
      return {
        ok: true,
        overlayAlpha: ca.chipLabelOverlayAlpha,
        active: active ? Array.from(active) : null,
        markedClass: marked.class || marked.label,
        markedChip: { x_abs: marked.x_abs, y_abs: marked.y_abs },
        insideAlpha,
        boundaryAlpha,
        points: { insideX, insideY, boundaryX, boundaryY },
        rect,
      };
    });
    expect(overlayInteriorCheck.ok, `chip label overlay check setup failed: ${JSON.stringify(overlayInteriorCheck)}`);
    expect(overlayInteriorCheck.markedClass !== 'invalid_main', `invalid_main should be excluded from default overlay: ${JSON.stringify(overlayInteriorCheck)}`);
    expect(overlayInteriorCheck.insideAlpha >= 30, `chip label overlay interior not filled: ${JSON.stringify(overlayInteriorCheck)}`);
    expect(overlayInteriorCheck.boundaryAlpha <= 8, `chip label overlay should leave boundary transparent: ${JSON.stringify(overlayInteriorCheck)}`);
    await page.evaluate(() => window.viewer.setChipLabelLegendClasses?.(null));

    const overlayZoomConsistency = await page.evaluate(() => {
      const v = window.viewer;
      const ca = v.chipAnnotator;
      if (!v || !ca || !ca.canvas || !ca.ctx) return { ok: false, reason: 'chip annotator missing' };
      v.setChipLabelLegendClasses?.(null);

      const active = ca.legendFilterClasses instanceof Set ? ca.legendFilterClasses : null;
      const marked = (ca.markedChips || []).find((candidate) => {
        if (active && !active.has(candidate.class || candidate.label)) return false;
        const chip = (ca.chips || []).find((item) =>
          item && item.x_abs === candidate.x_abs && item.y_abs === candidate.y_abs && item.rect
        );
        return !!chip;
      });
      if (!marked) return { ok: false, reason: 'marked chip missing' };
      const chip = (ca.chips || []).find((candidate) =>
        candidate && candidate.x_abs === marked.x_abs && candidate.y_abs === marked.y_abs && candidate.rect
      );
      if (!chip) return { ok: false, reason: 'chip rect missing', marked };

      const original = {
        scale: v.transform.scale,
        dx: v.transform.dx,
        dy: v.transform.dy,
        zoom: v.zoom,
      };
      const centerX = (chip.rect.x0 + chip.rect.x1) / 2;
      const centerY = (chip.rect.y0 + chip.rect.y1) / 2;
      const yOffset = ca.Y_OFFSET || 0;
      const clamp = (value, max) => Math.max(0, Math.min(max - 1, Math.round(value)));
      const sample = (scale) => {
        v.transform.scale = scale;
        v.transform.dx = Math.round(ca.canvas.width / 2 - centerX * scale);
        v.transform.dy = Math.round(ca.canvas.height / 2 - centerY * scale - yOffset);
        v.zoom = scale;
        ca.render();
        const cx = clamp(centerX * scale + v.transform.dx, ca.canvas.width);
        const cy = clamp(centerY * scale + v.transform.dy + yOffset, ca.canvas.height);
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let count = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const x = clamp(cx + ox, ca.canvas.width);
            const y = clamp(cy + oy, ca.canvas.height);
            const data = ca.ctx.getImageData(x, y, 1, 1).data;
            r += data[0];
            g += data[1];
            b += data[2];
            a += data[3];
            count += 1;
          }
        }
        return {
          scale,
          rgba: [
            Math.round(r / count),
            Math.round(g / count),
            Math.round(b / count),
            Math.round(a / count),
          ],
          point: { x: cx, y: cy },
        };
      };

      const small = sample(0.45);
      const large = sample(1.6);
      v.transform.scale = original.scale;
      v.transform.dx = original.dx;
      v.transform.dy = original.dy;
      v.zoom = original.zoom;
      ca.render();

      const colorDiff = Math.max(
        Math.abs(small.rgba[0] - large.rgba[0]),
        Math.abs(small.rgba[1] - large.rgba[1]),
        Math.abs(small.rgba[2] - large.rgba[2])
      );
      const alphaDiff = Math.abs(small.rgba[3] - large.rgba[3]);
      return {
        ok: true,
        markedClass: marked.class || marked.label,
        overlayAlpha: ca.chipLabelOverlayAlpha,
        small,
        large,
        colorDiff,
        alphaDiff,
      };
    });
    expect(overlayZoomConsistency.ok, `chip label overlay zoom setup failed: ${JSON.stringify(overlayZoomConsistency)}`);
    expect(overlayZoomConsistency.small.rgba[3] >= 30 && overlayZoomConsistency.large.rgba[3] >= 30, `chip label overlay zoom alpha missing: ${JSON.stringify(overlayZoomConsistency)}`);
    expect(overlayZoomConsistency.colorDiff <= 8 && overlayZoomConsistency.alphaDiff <= 8, `chip label overlay color changes by zoom: ${JSON.stringify(overlayZoomConsistency)}`);

    const personalizedZoomState = await page.evaluate(async ({ waferPath }) => {
      const sleepInPage = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const v = window.viewer;
      if (!v) return { ok: false, reason: 'viewer missing' };

      v.personalizedColorEnabled = true;
      v.currentUser = 'notsaml';
      await v.loadColorLegends?.();
      v._personalizedColorCacheBuster = String(Date.now());
      await v.loadImage(waferPath, false, null, true);

      const waitDeadline = performance.now() + 30000;
      while (performance.now() < waitDeadline) {
        if (v.currentImage && !v.gridMode && String(v.selectedImagePath || '').replace(/\\/g, '/').toLowerCase() === waferPath.toLowerCase()) {
          break;
        }
        await sleepInPage(100);
      }

      const levels = window.SERVER_CONFIG?.PYRAMID_LEVELS || [0.2, 0.5, 0.7, 1];
      const thresholds = window.SERVER_CONFIG?.PYRAMID_ZOOM_THRESHOLDS || [0.25, 0.5, 0.75];
      const currentLevel = v.currentPyramidLevel;
      const targetLevel = String(currentLevel) === String(levels[levels.length - 1])
        ? levels[0]
        : levels[levels.length - 1];
      const targetScale = String(targetLevel) === String(levels[0])
        ? Math.max(0.05, thresholds[0] * 0.5)
        : thresholds[thresholds.length - 1] + 0.35;
      const expectedKey = v.getPyramidCacheKey(targetLevel);
      const personalizedParams = v.getPersonalizedParams();
      const nudgeWithinRange = (start, end) => {
        const gap = Number.isFinite(end - start) && end > start ? end - start : 0.25;
        return Math.min(Math.max(gap * 0.04, 0.005), 0.02);
      };
      const sampleScaleForLevelIndex = (index) => {
        if (index === 0) {
          return Math.max(0.05, (thresholds[0] || 0.25) * 0.8);
        }
        const prevThreshold = thresholds[index - 1];
        if (index >= levels.length - 1 || index >= thresholds.length) {
          return (Number.isFinite(prevThreshold) ? prevThreshold : thresholds[thresholds.length - 1] || 0.75) + 0.05;
        }
        const nextThreshold = thresholds[index];
        const nudge = nudgeWithinRange(prevThreshold, nextThreshold);
        return index === 1 ? nextThreshold - nudge : prevThreshold + nudge;
      };
      const levelScales = levels.map((level, index) => ({
        label: `level-${level}`,
        level,
        scale: sampleScaleForLevelIndex(index),
      }));
      const warmPersonalizedLevel = async (level) => {
        const url = `/api/image?path=${encodeURIComponent(waferPath)}&level=${encodeURIComponent(level)}${personalizedParams}`;
        const deadline = performance.now() + 90000;
        let attempts = 0;
        let lastStatus = null;
        let lastError = null;
        while (performance.now() < deadline) {
          attempts += 1;
          try {
            const response = await fetch(url, {
              cache: 'no-cache',
              headers: {
                Accept: 'image/png,image/apng,image/*;q=0.8',
                'Cache-Control': 'no-cache',
              },
            });
            lastStatus = response.status;
            if (response.ok) {
              const blob = await response.blob();
              return { ok: true, level, attempts, status: response.status, bytes: blob.size };
            }
          } catch (err) {
            lastError = err?.message || String(err);
          }
          await sleepInPage(500);
        }
        return { ok: false, level, attempts, lastStatus, lastError };
      };
      const warmResults = [];
      for (const item of levelScales) {
        warmResults.push({ label: item.label, ...(await warmPersonalizedLevel(item.level)) });
      }

      const poisonCanvas = document.createElement('canvas');
      poisonCanvas.width = 1;
      poisonCanvas.height = 1;
      const poisonCtx = poisonCanvas.getContext('2d');
      poisonCtx.fillStyle = '#ff00ff';
      poisonCtx.fillRect(0, 0, 1, 1);
      const poisonBitmap = await createImageBitmap(poisonCanvas);

      delete v.pyramidLevels[expectedKey];
      v.pyramidLevels[targetLevel] = poisonBitmap;
      v._pyramidLoading = new Set();
      v.transform.scale = targetScale;
      v.zoom = targetScale;
      v.updatePyramidLevel();

      const immediate = {
        usedLegacyPoison: v.currentImage === poisonBitmap,
        currentLevel: v.currentPyramidLevel,
        currentKey: v.currentPyramidCacheKey,
      };

      const loadDeadline = performance.now() + 45000;
      while (performance.now() < loadDeadline) {
        if (v.pyramidLevels?.[expectedKey]) {
          v.updatePyramidLevel();
          if (v.currentPyramidCacheKey === expectedKey && v.currentImage === v.pyramidLevels[expectedKey]) {
            break;
          }
        }
        await sleepInPage(150);
      }

      const finalState = {
        hasExpectedCache: !!v.pyramidLevels?.[expectedKey],
        currentLevel: v.currentPyramidLevel,
        currentKey: v.currentPyramidCacheKey,
        usedLegacyPoison: v.currentImage === poisonBitmap,
        gpuAvailable: !!v.semiconductorRenderer?.isGpuAvailable?.(),
        gpuHasExpectedTexture: v.semiconductorRenderer?.isGpuAvailable?.()
          ? !!v.semiconductorRenderer?.hasLevelTexture?.(expectedKey)
          : null,
      };
      if (typeof poisonBitmap.close === 'function') {
        poisonBitmap.close();
      }

      const expectedBackground = (() => {
        const hex = v.colorLegends?.notsaml?.background || '#FAB8FF';
        const clean = String(hex).replace('#', '');
        return [
          Number.parseInt(clean.slice(0, 2), 16),
          Number.parseInt(clean.slice(2, 4), 16),
          Number.parseInt(clean.slice(4, 6), 16),
        ];
      })();
      const samplePersonalizedBackground = async (item) => {
        const scale = item.scale;
        const canvas = v.dom?.imageCanvas;
        const ctx = canvas?.getContext?.('2d');
        if (!canvas || !ctx) return { ok: false, reason: 'image canvas missing', scale };
        const imgX = 100;
        const imgY = 100;
        v.transform.scale = scale;
        v.transform.dx = Math.round(canvas.width / 2 - imgX * scale);
        v.transform.dy = Math.round(canvas.height / 2 - imgY * scale);
        v.zoom = scale;
        const levelForScale = v.getBestPyramidLevel(scale);
        const keyForScale = v.getPyramidCacheKey(levelForScale);
        let loadError = null;
        v.updatePyramidLevel();
        if (!v.pyramidLevels?.[keyForScale]) {
          try {
            await v.loadPyramidLevel(levelForScale, false);
          } catch (err) {
            loadError = err?.message || String(err);
          }
        }
        const deadline = performance.now() + 90000;
        while (performance.now() < deadline) {
          v.updatePyramidLevel();
          if (v.currentPyramidCacheKey === keyForScale && v.currentImage === v.pyramidLevels?.[keyForScale]) {
            break;
          }
          if (!v.pyramidLevels?.[keyForScale]) {
            try {
              await v.loadPyramidLevel(levelForScale, false);
            } catch (err) {
              loadError = err?.message || String(err);
            }
          }
          await sleepInPage(150);
        }
        v.scheduleDraw();
        await sleepInPage(250);
        const x = Math.round(imgX * scale + v.transform.dx);
        const y = Math.round(imgY * scale + v.transform.dy);
        const pixel = Array.from(ctx.getImageData(x, y, 1, 1).data);
        return {
          ok: true,
          scale,
          expectedLevel: levelForScale,
          configuredLevel: item.level,
          levelMatches: String(levelForScale) === String(item.level),
          expectedKey: keyForScale,
          currentLevel: v.currentPyramidLevel,
          currentKey: v.currentPyramidCacheKey,
          pixel,
          loadError,
          point: { x, y },
        };
      };
      const personalizedLevelSamples = [];
      for (const item of levelScales) {
        const sample = await samplePersonalizedBackground(item);
        personalizedLevelSamples.push({ ...item, ...sample });
      }

      return {
        ok: true,
        currentLevel,
        targetLevel,
        targetScale,
        personalizedParams,
        expectedKey,
        expectedBackground,
        levelScales,
        warmResults,
        immediate,
        finalState,
        personalizedLevelSamples,
      };
    }, { waferPath });
    expect(personalizedZoomState.ok, `personalized zoom setup failed: ${JSON.stringify(personalizedZoomState)}`);
    expect(personalizedZoomState.expectedKey.includes('personalized=true') && personalizedZoomState.expectedKey.includes('scheme=notsaml'), `personalized pyramid cache key missing params: ${JSON.stringify(personalizedZoomState)}`);
    expect(!personalizedZoomState.immediate.usedLegacyPoison, `personalized zoom reused legacy level cache immediately: ${JSON.stringify(personalizedZoomState)}`);
    expect(personalizedZoomState.finalState.hasExpectedCache, `personalized zoom expected cache not loaded: ${JSON.stringify(personalizedZoomState)}`);
    expect(personalizedZoomState.finalState.currentKey === personalizedZoomState.expectedKey, `personalized zoom did not switch to keyed cache: ${JSON.stringify(personalizedZoomState)}`);
    expect(!personalizedZoomState.finalState.usedLegacyPoison, `personalized zoom stayed on legacy poison cache: ${JSON.stringify(personalizedZoomState)}`);
    expect(
      personalizedZoomState.finalState.gpuHasExpectedTexture !== false,
      `personalized zoom missing keyed GPU texture: ${JSON.stringify(personalizedZoomState)}`
    );
    const maxRgbDiff = (pixel, expected) => Math.max(
      Math.abs(pixel[0] - expected[0]),
      Math.abs(pixel[1] - expected[1]),
      Math.abs(pixel[2] - expected[2])
    );
    const samples = personalizedZoomState.personalizedLevelSamples || [];
    expect(
      personalizedZoomState.warmResults?.length === samples.length && personalizedZoomState.warmResults.every(item => item.ok),
      `personalized pyramid warmup failed for one or more levels: ${JSON.stringify(personalizedZoomState)}`
    );
    expect(samples.length === personalizedZoomState.levelScales?.length && samples.every(sample => sample.ok && sample.levelMatches), `personalized background sampling failed for all levels: ${JSON.stringify(personalizedZoomState)}`);
    expect(
      samples.every(sample => sample.currentKey === sample.expectedKey),
      `personalized pyramid did not switch to expected level cache: ${JSON.stringify(personalizedZoomState)}`
    );
    expect(
      samples.every(sample => maxRgbDiff(sample.pixel, personalizedZoomState.expectedBackground) <= 12),
      `personalized color missing in one or more pyramid levels: ${JSON.stringify(personalizedZoomState)}`
    );

    const singleMenu = await page.evaluate(async ({ chipPath }) => {
      const v = window.viewer;
      await v.enterSingleViewMode(chipPath);
      await new Promise(resolve => setTimeout(resolve, 500));
      return {
        before: { pageCount: v.pageManager?.pages?.length || 0 },
        selectedImagePath: v.selectedImagePath,
        viewMode: v.viewMode,
      };
    }, { chipPath });
    await page.waitForFunction(() => window.viewer.viewMode === 'single' && !window.viewer.gridMode, null, { timeout: 60000 });
    await sleep(800);
    const canvasBox = await page.locator('#image-canvas').boundingBox();
    expect(!!canvasBox, 'chip label single image canvas missing');
    await page.mouse.click(
      canvasBox.x + Math.min(80, canvasBox.width / 2),
      canvasBox.y + Math.min(80, canvasBox.height / 2),
      { button: 'right' }
    );
    await page.waitForFunction(() => {
      const singleMenuEl = document.getElementById('single-context-menu');
      const waferItem = document.getElementById('single-chip-wafer-view');
      const lotItem = document.getElementById('single-chip-lot-view');
      return singleMenuEl && getComputedStyle(singleMenuEl).display !== 'none' &&
        waferItem && getComputedStyle(waferItem).display !== 'none' &&
        lotItem && getComputedStyle(lotItem).display !== 'none';
    }, null, { timeout: 10000 });

    const singleMenuAfterRightClick = await page.evaluate(() => {
      const waferItem = document.getElementById('single-chip-wafer-view');
      const lotItem = document.getElementById('single-chip-lot-view');
      return {
        contextPaths: window.viewer.getChipLabelContextPaths(),
        menuText: document.getElementById('single-context-menu')?.innerText || '',
        waferDisplay: waferItem ? getComputedStyle(waferItem).display : null,
        lotDisplay: lotItem ? getComputedStyle(lotItem).display : null,
      };
    });
    expect(singleMenu.viewMode === 'single', `chip label single mode failed: ${JSON.stringify(singleMenu)}`);
    expect(singleMenuAfterRightClick.contextPaths[0]?.toLowerCase().includes('classification_chips/'), `chip label single context path invalid: ${JSON.stringify(singleMenuAfterRightClick)}`);
    expect(singleMenuAfterRightClick.contextPaths.length === 1, `chip label single context paths invalid: ${JSON.stringify(singleMenuAfterRightClick)}`);
    const chipSinglePanel = await page.evaluate(() => {
      const legend = document.getElementById('chip-label-legend');
      const legendStyle = legend ? getComputedStyle(legend) : null;
      const legendRect = legend?.getBoundingClientRect?.();
      const legendVisible = !!legend &&
        legendStyle?.display !== 'none' &&
        legendStyle?.visibility !== 'hidden' &&
        (legendRect?.width || 0) > 0 &&
        (legendRect?.height || 0) > 0;
      return {
        folderText: document.getElementById('file-path-text')?.textContent || '',
        separatorDisplay: getComputedStyle(document.getElementById('separator-text')).display,
        legendDisplay: legendStyle?.display || null,
        legendVisible,
        legendPillCount: legend?.querySelectorAll('button[data-chip-label]').length || 0,
        selectedImagePath: window.viewer.selectedImagePath || '',
      };
    });
    expect(chipSinglePanel.folderText.trim() === '', `chip label folder should stay hidden: ${JSON.stringify(chipSinglePanel)}`);
    expect(chipSinglePanel.separatorDisplay === 'none', `chip label separator should stay hidden: ${JSON.stringify(chipSinglePanel)}`);
    expect(
      !chipSinglePanel.legendVisible && chipSinglePanel.legendDisplay === 'none',
      `chip label image should not show wafer chip label legend: ${JSON.stringify(chipSinglePanel)}`
    );
    expect(
      singleMenuAfterRightClick.menuText.includes('Wafer 보기') &&
        singleMenuAfterRightClick.menuText.includes('Lot 보기') &&
        singleMenuAfterRightClick.waferDisplay !== 'none' &&
        singleMenuAfterRightClick.lotDisplay !== 'none',
      `chip label single right-click menu hidden: ${JSON.stringify(singleMenuAfterRightClick)}`
    );

    await page.locator('#single-chip-lot-view').click({ timeout: 10000 });
    await page.waitForFunction(() => {
      const v = window.viewer;
      const images = Array.isArray(v.currentGridImages) ? v.currentGridImages : [];
      return !!v &&
        v.gridMode === true &&
        v.pageManager?.getActivePage?.()?.role === 'wafer' &&
        images.length >= 1 &&
        document.querySelectorAll('#image-grid .grid-thumb-wrap').length >= 1;
    }, null, { timeout: 90000 });
    await sleep(800);

    const lotGrid = await page.evaluate(() => {
      const images = window.viewer.currentGridImages || [];
      const uniqueKeys = Array.from(new Set(images.map(path => {
        const file = String(path || '').replace(/\\/g, '/').split('/').pop() || '';
        const parts = file.replace(/\.[^.]+$/, '').split('_');
        return `${(parts[0] || '').toLowerCase()}:${(parts[2] || '').toLowerCase()}`;
      })));
      return {
        activeRole: window.viewer.pageManager?.getActivePage?.()?.role || null,
        pageCount: window.viewer.pageManager?.pages?.length || 0,
        gridMode: window.viewer.gridMode,
        images,
        count: images.length,
        uniqueKeys,
        wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      };
    });
    expect(lotGrid.pageCount === singleMenu.before.pageCount + 1, `lot grid tab was not created: before=${JSON.stringify(singleMenu.before)} after=${JSON.stringify(lotGrid)}`);
    expect(lotGrid.activeRole === 'wafer' && lotGrid.gridMode === true, `lot view should be wafer grid: ${JSON.stringify(lotGrid)}`);
    expect(lotGrid.count === lotGrid.uniqueKeys.length, `lot results should be lot/wafer deduped: ${JSON.stringify(lotGrid)}`);
    expect(!lotGrid.images.some(path => /classification_chips|obj_id_maps/i.test(path)), `derived path in lot results: ${JSON.stringify(lotGrid)}`);

    return {
      annotationAvgMs: data.annotationAvgMs,
      annotationTimings: data.annotationTimings,
      lookupMs: data.lookupMs,
      markedCount: data.markedCount,
      fixture,
      waferPath: data.waferLookup.wafer_path,
      waferKey: data.waferLookup.wafer_key,
      labelExplorerWaferSingle,
      gridMenu,
      gridMenuAfterRightClick,
      waferSingle,
      waferSinglePanel,
      legendBefore,
      selectedChipClassFilter,
      legendToggleOff,
      legendReloadOff,
      legendReloadToggleOn,
      legendSizing,
      transformBeforeLegendDrag,
      transformAfterLegendDrag,
      shiftDragState,
      shiftClickRangeState,
      ctrlDragState,
      ctrlShiftDragState,
      ctrlShiftChipDragState,
      overlayInteriorCheck,
      overlayZoomConsistency,
      personalizedZoomState,
      singleMenu,
      singleMenuAfterRightClick,
      chipSinglePanel,
      lotGrid,
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
