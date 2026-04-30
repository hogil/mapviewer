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
    await sleep(1800);
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

  await record('2,5,31', 'palette_3k 그리드/범례', async () => {
    await loadFolder('palette_3k');
    const data = await page.evaluate(() => ({
      count: window.viewer.currentGridImages.length,
      wraps: document.querySelectorAll('#image-grid .grid-thumb-wrap').length,
      legendTop: (
        document.getElementById('color-legend-top')?.innerText || ''
      ).replace(/\s+/g, ' '),
    }));
    expect(data.count === 3000, `count=${data.count}`);
    expect(data.wraps === 3000, `wraps=${data.wraps}`);
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

  await record('6,32', 'LOT Mode / 폴더전환 스크롤', async () => {
    await loadFolder('palette_3k');
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
    await loadFolder('filter_test');
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
      await window.viewer.loadImagesInFolderAndShowGrid('palette_3k');
    });
    await statsProbePage.waitForFunction(
      () =>
        !!window.viewer &&
        window.viewer.gridMode === true &&
        (window.viewer.currentGridImages?.length || 0) === 3000 &&
        document.querySelectorAll('#image-grid .grid-thumb-wrap').length > 0,
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
    await loadFolder('filter_test');
    await setSelection([0, 1, 2]);
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
        window.viewer.pageManager.getActivePage()?.role === 'composite' &&
        Array.isArray(window.viewer.currentGridImages) &&
        window.viewer.currentGridImages.length > 0,
      null,
      { timeout: 60000 }
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
      freshMcState,
      mcBeforeGenerate,
      refVisible,
      overlay,
      compositeCount,
      selectedPanelAfterComposite,
      visibleFloatingPanelsAfterComposite,
    };
  });

  await record('13-19', '단일 이미지 기본/피라미드/컨텍스트/라벨모달', async () => {
    await boot('chunk1-single');
    await loadFolder('palette_5mb');
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
      pyramidLevel: window.viewer.currentPyramidLevel,
      fileName: (document.getElementById('file-name-text')?.textContent || '').trim(),
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
    expect(!!data.selectedImagePath, 'no selected image');
    expect(data.pyramidLevel !== undefined, `pyramid=${data.pyramidLevel}`);
    expect(data.fileName.length > 0, 'empty filename');
    expect(data.chipInfoLen > 0, 'empty chip info');
    expect(data.singleCtxVisible, 'single ctx hidden');
    expect(data.addLabelVisible, 'add label hidden');
    await backToGrid();
    return data;
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
