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
      v.selectedImages = idxs.map((i) => v.currentGridImages[i]).filter(Boolean);
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
    const statsText = await statsPage.evaluate(() =>
      document.body.innerText.slice(0, 120)
    );
    await statsPage.close();
    expect(statsText.length > 0, 'stats empty');
    return { classData, myLotVisible, statsText };
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
    const mcCreate = page.locator('#context-mc-create');
    const mcBox = await mcCreate.boundingBox();
    expect(!!mcBox, 'mc context item missing');
    await page.mouse.move(mcBox.x + mcBox.width / 2, mcBox.y + mcBox.height / 2);
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('context-mc-submenu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    const mcSubmenuState = await page.evaluate(() => ({
      display: getComputedStyle(document.getElementById('context-mc-submenu')).display,
      itemCount: document.querySelectorAll('#context-mc-submenu .failbit-item').length,
    }));
    expect(mcSubmenuState.display !== 'none', `mc submenu hidden=${JSON.stringify(mcSubmenuState)}`);
    expect(mcSubmenuState.itemCount > 0, `mc submenu empty=${mcSubmenuState.itemCount}`);
    const meaCreate = page.locator('#context-mea-create');
    const meaBox = await meaCreate.boundingBox();
    expect(!!meaBox, 'mea context item missing');
    await page.mouse.move(meaBox.x + meaBox.width / 2, meaBox.y + meaBox.height / 2);
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('context-mea-submenu')).display !== 'none',
      null,
      { timeout: 10000 }
    );
    const meaSubmenuState = await page.evaluate(() => ({
      display: getComputedStyle(document.getElementById('context-mea-submenu')).display,
      itemCount: document.querySelectorAll('#context-mea-submenu .failbit-item').length,
    }));
    expect(meaSubmenuState.display !== 'none', `mea submenu hidden=${JSON.stringify(meaSubmenuState)}`);
    expect(meaSubmenuState.itemCount > 0, `mea submenu empty=${meaSubmenuState.itemCount}`);
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
    await page.evaluate(() => window.viewer.handleCompositeCreate());
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
    return {
      ctxComposite,
      ctxMeasure,
      mcSubmenuState,
      meaSubmenuState,
      refVisible,
      overlay,
      compositeCount,
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
