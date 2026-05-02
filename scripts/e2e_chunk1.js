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
            document.querySelectorAll(
              '#file-explorer .folder, #file-explorer .folder-item'
            ).length > 10,
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

  function assertUnknownSearchResult(scenario, data, expectedLots = []) {
    expect(data.success === true, `${scenario} success=${JSON.stringify(data).slice(0, 500)}`);
    const results = (data.results || []).map(normalizeResultPath);
    expect(results.length > 0, `${scenario} empty results`);
    expect(
      results.every((imagePath) => imagePath.startsWith('unknown/')),
      `${scenario} non-unknown=${JSON.stringify(results.filter((imagePath) => !imagePath.startsWith('unknown/')).slice(0, 8))}`
    );
    expect(
      (data.timings?.search_prefix || '') === '',
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

  await boot('chunk1');

  await record('1', '페이지 로드 & 기본 UI', async () => {
    const data = await page.evaluate(() => ({
      title: document.title,
      folderCount: document.querySelectorAll(
        '#file-explorer .folder, #file-explorer .folder-item'
      ).length,
      classCount: document.querySelectorAll('#class-list .class-btn').length,
    }));
    expect(data.title === 'Wafer Map Viewer', `title=${data.title}`);
    expect(data.folderCount > 10, `folderCount=${data.folderCount}`);
    expect(data.classCount >= 1, `classCount=${data.classCount}`);
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
    const scenarios = [
      { query: 'abc123', expected: 500 },
      { query: 'abc123 or def456', expected: 1024 },
      { query: 'ring', expected: 1024, alert: '검색 결과가 없습니다.' },
      { query: 'edge', expected: 16 },
    ];
    const counts = {};
    for (const scenario of scenarios) {
      let dialogMessage = '';
      if (scenario.alert) {
        page.once('dialog', async (dialog) => {
          dialogMessage = dialog.message();
          await dialog.accept();
        });
      }
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
        scenario.expected,
        { timeout: 30000 }
      );
      counts[scenario.query] = await page.evaluate(() => window.viewer.currentGridImages.length);
      if (scenario.alert) {
        expect(dialogMessage === scenario.alert, `${scenario.query} dialog=${dialogMessage}`);
      }
    }
    expect(counts['abc123'] === 500, `abc123=${counts['abc123']}`);
    expect(counts['abc123 or def456'] === 1024, `or=${counts['abc123 or def456']}`);
    expect(counts['ring'] === 1024, `ring=${counts['ring']}`);
    expect(counts['edge'] === 16, `edge=${counts['edge']}`);
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
    expect(uiResult.unknownCount === uiResult.count, `ui non-unknown=${JSON.stringify(uiResult)}`);
    expect(uiResult.lots.includes(a.lot), `ui lots=${JSON.stringify(uiResult)}`);
    return {
      fixtures,
      apiResults,
      uiResult,
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
    const classData = await page.evaluate(async () => {
      const classes = Array.from(document.querySelectorAll('#class-list .class-btn'))
        .map((button) => (button.textContent || '').trim())
        .filter(Boolean);
      const primaryClass = classes[0] || null;
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
      };
    });
    expect(classData.primaryClass, `classes=${JSON.stringify(classData.classes)}`);
    expect(classData.classes.includes(classData.primaryClass), `primaryClass=${classData.primaryClass}`);
    expect(classData.count > 0, `${classData.primaryClass}=${classData.count}`);
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
    await page.evaluate(() =>
      window.viewer.showSingleContextMenu({
        pageX: 320,
        pageY: 240,
        preventDefault() {},
        stopPropagation() {},
      })
    );
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
      singleCtxVisible:
        getComputedStyle(document.getElementById('single-context-menu')).display !==
        'none',
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
    await backToGrid();
    return data;
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

  await record('chip-label-prefix-wafer', 'Chip label 5토큰 wafer 매칭/우클릭 Wafer 보기', async () => {
    await boot('chunk1-chip-label-prefix-wafer');
    const waferPath = 'unknown/Center_scratch/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.PNG';
    const chipPath = 'classification_chips/bank_boundary/AAU220_00P_13_20260501_010000_EE_PWQ_X13_Y11_B285.PNG';
    const labelKey = 'bank_boundary/AAU220_00P_13_20260501_010000_EE_PWQ_X13_Y11_B285.PNG';
    const fullStem = 'AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ';
    const chipPaths = [
      chipPath,
      'classification_chips/scratch/AAU220_00P_13_20260501_010000_EE_PWQ_X11_Y17_B285.PNG',
    ];

    const data = await page.evaluate(async ({ waferPath, chipPath, labelKey }) => {
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
          chip.class === 'bank_boundary' &&
          chip.x_abs === 13 &&
          chip.y_abs === 11 &&
          String(chip.b) === '285'
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
    }, { waferPath, chipPath, labelKey });

    expect(data.markedHit, `5-token prefix chip annotation missing: ${JSON.stringify(data)}`);
    expect(data.markedCount >= 1, `marked chip count invalid: ${JSON.stringify(data)}`);
    expect(data.annotationAvgMs < 500, `chip annotation prefix lookup too slow: ${JSON.stringify(data)}`);
    expect(
      String(data.waferLookup?.wafer_path || '').replace(/\\/g, '/').toLowerCase() === waferPath.toLowerCase(),
      `related wafer path mismatch: ${JSON.stringify(data.waferLookup)}`
    );
    expect(
      data.waferLookup?.wafer_key === 'AAU220_00P_13_20260501_010000',
      `wafer key mismatch: ${JSON.stringify(data.waferLookup)}`
    );
    expect(
      data.menu.visible && data.menu.text.includes('Wafer 보기') && data.menu.text.includes('Lot 보기'),
      `chip label explorer context menu invalid: ${JSON.stringify(data.menu)}`
    );
    await page.evaluate(() => window.viewer.hideLabelExplorerChipContextMenu?.());

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
      const images = Array.isArray(v.currentGridImages) ? v.currentGridImages : [];
      return !!v &&
        v.gridMode === true &&
        v.pageManager?.getActivePage?.()?.role === 'wafer' &&
        images.length === 1 &&
        images[0].toLowerCase().includes(expectedStemLower) &&
        document.querySelectorAll('#image-grid .grid-thumb-wrap').length >= 1;
    }, fullStem.toLowerCase(), { timeout: 90000 });
    await sleep(800);

    const waferGrid = await page.evaluate(() => ({
      activeRole: window.viewer.pageManager?.getActivePage?.()?.role || null,
      pageCount: window.viewer.pageManager?.pages?.length || 0,
      gridMode: window.viewer.gridMode,
      images: window.viewer.currentGridImages || [],
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
    }));
    expect(waferGrid.pageCount === gridMenu.before.pageCount + 1, `wafer grid tab was not created: before=${JSON.stringify(gridMenu.before)} after=${JSON.stringify(waferGrid)}`);
    expect(waferGrid.activeRole === 'wafer' && waferGrid.gridMode === true, `wafer view should be wafer grid: ${JSON.stringify(waferGrid)}`);
    expect(waferGrid.images.length === 1, `wafer results should be lot/wafer deduped: ${JSON.stringify(waferGrid)}`);
    expect(
      String(waferGrid.images[0] || '').replace(/\\/g, '/').toLowerCase() === waferPath.toLowerCase(),
      `wafer grid result mismatch: ${JSON.stringify(waferGrid)}`
    );
    expect(!waferGrid.images.some(path => /classification_chips|obj_id_maps/i.test(path)), `derived path in wafer results: ${JSON.stringify(waferGrid)}`);

    await page.evaluate((targetPath) => window.viewer.enterSingleViewMode(targetPath), waferGrid.images[0]);
    await page.waitForFunction((expectedStemLower) => {
      const v = window.viewer;
      return !!v &&
        v.viewMode === 'single' &&
        v.gridMode === false &&
        String(v.selectedImagePath || '').toLowerCase().includes(expectedStemLower);
    }, fullStem.toLowerCase(), { timeout: 90000 });
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
        legendHasLabels: /bank_boundary|scratch|invalid_main|particle_blast/.test(legendText),
        legendSnippet: legendText.slice(0, 300),
      };
    });
    expect(waferSinglePanel.folderText === 'Center_scratch', `wafer single folder missing: ${JSON.stringify(waferSinglePanel)}`);
    expect(waferSinglePanel.separatorDisplay !== 'none', `wafer single separator hidden: ${JSON.stringify(waferSinglePanel)}`);
    expect(waferSinglePanel.fileNameText.toLowerCase() === fullStem.toLowerCase(), `wafer single filename mismatch: ${JSON.stringify(waferSinglePanel)}`);
    expect(
      waferSinglePanel.legendHasLabels || (waferSinglePanel.markedCount && waferSinglePanel.markedCount > 0),
      `wafer single chip labels missing: ${JSON.stringify(waferSinglePanel)}`
    );

    const legendBefore = await page.evaluate(() => {
      const legend = document.getElementById('chip-label-legend');
      const pills = Array.from(legend?.querySelectorAll('button[data-chip-label]') || []);
      return {
        visible: !!legend && getComputedStyle(legend).display !== 'none',
        count: pills.length,
        activeCount: pills.filter((pill) => pill.classList.contains('is-active')).length,
        invalidMainActive: !!pills.find((pill) =>
          pill.getAttribute('data-chip-label') === 'invalid_main' && pill.classList.contains('is-active')
        ),
        overlayAlpha: window.viewer.chipAnnotator?.chipLabelOverlayAlpha ?? null,
      };
    });
    expect(legendBefore.visible && legendBefore.count >= 2, `chip label legend not ready: ${JSON.stringify(legendBefore)}`);
    expect(legendBefore.overlayAlpha === 0.15, `chip label overlay alpha should be 15%: ${JSON.stringify(legendBefore)}`);
    expect(!legendBefore.invalidMainActive, `invalid_main should be inactive by default: ${JSON.stringify(legendBefore)}`);

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
      legendSizing.visible && legendSizing.width >= 220 && legendSizing.width <= 230,
      `chip label legend width should be reduced by 15% from 264px: ${JSON.stringify(legendSizing)}`
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
    const particleBlastIdx = rangeClickPillBoxes.indexOf('particle_blast');
    expect(
      scratchIdx !== -1 && particleBlastIdx !== -1 && scratchIdx < particleBlastIdx,
      `scratch -> particle_blast range setup failed: ${JSON.stringify(rangeClickPillBoxes)}`
    );
    const expectedShiftClickRange = rangeClickPillBoxes.slice(scratchIdx, particleBlastIdx + 1);
    await page.locator('#chip-label-legend button[data-chip-label="scratch"]').click({ timeout: 10000 });
    await page.waitForFunction(() => {
      const active = window.viewer.activeChipLabelClasses;
      return active instanceof Set && active.size === 1 && active.has('scratch');
    }, null, { timeout: 5000 });
    await page.keyboard.down('Shift');
    await page.locator('#chip-label-legend button[data-chip-label="particle_blast"]').click({ timeout: 10000 });
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
      `shift click range should select scratch through particle_blast: expected=${JSON.stringify(expectedShiftClickRange)} actual=${JSON.stringify(shiftClickRangeState)}`
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
    const chipSinglePanel = await page.evaluate(() => ({
      folderText: document.getElementById('file-path-text')?.textContent || '',
      separatorDisplay: getComputedStyle(document.getElementById('separator-text')).display,
    }));
    expect(chipSinglePanel.folderText.trim() === '', `chip label folder should stay hidden: ${JSON.stringify(chipSinglePanel)}`);
    expect(chipSinglePanel.separatorDisplay === 'none', `chip label separator should stay hidden: ${JSON.stringify(chipSinglePanel)}`);
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
      waferPath: data.waferLookup.wafer_path,
      waferKey: data.waferLookup.wafer_key,
      gridMenu,
      gridMenuAfterRightClick,
      waferGrid,
      waferSinglePanel,
      legendBefore,
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
