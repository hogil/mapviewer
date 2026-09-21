const assert = require('node:assert/strict');
const { createExtendedRunner } = require('./e2e_extended_common');

(async () => {
  const runner = await createExtendedRunner(__filename);
  const { page, record, boot, loadUnknown, visibleGrid, visibleSingle, api, finish } = runner;
  const sizes = [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }];
  const paths = () => page.evaluate(() => [...window.viewer.currentGridImages]);
  const sorted = values => [...new Set(values)].sort();
  const samePaths = (actual, expected) => assert.deepEqual(sorted(actual), sorted(expected));
  const openSingle = async imagePath => {
    await page.evaluate(async target => window.viewer.enterSingleViewMode(target), imagePath);
    return visibleSingle(page, imagePath);
  };
  const returnGrid = async () => {
    await page.evaluate(async () => window.viewer.exitSingleImageViewMode());
    return visibleGrid(page);
  };
  const canvasPixels = () => page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    context.drawImage(window.viewer.dom.imageCanvas, 0, 0, 64, 64);
    return Array.from(context.getImageData(0, 0, 64, 64).data);
  });
  const assertBitmap = (actual, expected) => {
    assert.equal(actual.length, expected.length);
    const meanError = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
    assert.ok(meanError <= 2, `Final image differs from baseline bitmap: mean channel error=${meanError}`);
    return meanError;
  };
  const positionKeys = chips => sorted(chips.map(chip => `${Number(chip.x_abs)},${Number(chip.y_abs)}`));
  const actualPositionKeys = () => page.evaluate(() => [...new Set(window.viewer.chipAnnotator.chips
    .map(chip => `${Number(chip.x_abs)},${Number(chip.y_abs)}`))].sort());
  const columns = async count => {
    await page.locator('#grid-cols-input').fill(String(count));
    await page.locator('#grid-cols-input').press('Enter');
  };
  const selectIndices = async indices => {
    await page.evaluate(indices => {
      const viewer = window.viewer;
      viewer.gridSelectedIdxs = [...indices];
      viewer.gridSelectedSet = new Set(indices);
      viewer.updateGridSelection();
      viewer.flushGridSelectionUpdates?.();
    }, indices);
    const actual = await page.evaluate(() => [...document.querySelectorAll('#image-grid .grid-thumb-wrap.selected')]
      .map(wrap => Number(wrap.dataset.index)).sort((a, b) => a - b));
    assert.deepEqual(actual, [...indices].sort((a, b) => a - b));
  };

  await record('extended-chip-keyboard-input-guard', 'Ctrl+A in editable controls preserves chip selection in grid and single-image states', async () => {
    await boot(); await loadUnknown({ limit: 16 });
    const imagePath = (await paths())[0];
    await openSingle(imagePath);
    await page.waitForFunction(() => window.viewer.chipAnnotator?.chips?.length > 0);

    const search = page.locator('#new-class-input');
    const beforeSingle = await page.evaluate(() => [...window.viewer.chipAnnotator.selectedChips].sort((a, b) => a - b));
    await search.fill('CTRL_A_SINGLE');
    await search.press('Control+A');
    const single = await page.evaluate(() => {
      const input = document.getElementById('new-class-input');
      return {
        selected: [...window.viewer.chipAnnotator.selectedChips].sort((a, b) => a - b),
        selection: [input.selectionStart, input.selectionEnd],
        valueLength: input.value.length,
      };
    });
    assert.deepEqual(single.selected, beforeSingle);
    assert.deepEqual(single.selection, [0, single.valueLength]);

    const nonEditable = await page.evaluate(() => {
      const viewer = window.viewer;
      viewer.chipAnnotator.selectedChips.clear();
      const target = viewer.dom.overlayCanvas;
      target.tabIndex = 0;
      target.focus();
      const expected = viewer.chipAnnotator.chips
        .map((chip, index) => viewer.chipAnnotator.isChipSelectable(chip) ? index : null)
        .filter(index => index !== null)
        .sort((a, b) => a - b);
      return { expected, before: [...viewer.chipAnnotator.selectedChips] };
    });
    await page.keyboard.press('Control+A');
    const selectedByCanvas = await page.evaluate(() => ({
      selected: [...window.viewer.chipAnnotator.selectedChips].sort((a, b) => a - b),
      activeTag: document.activeElement?.id || document.activeElement?.tagName,
    }));
    assert.equal(selectedByCanvas.activeTag, 'overlay-canvas');
    assert.deepEqual(selectedByCanvas.selected, nonEditable.expected);

    const gridProof = await returnGrid();
    const beforeGrid = await page.evaluate(() => [...window.viewer.chipAnnotator.selectedChips].sort((a, b) => a - b));
    await search.fill('CTRL_A_GRID');
    await search.press('Control+A');
    const grid = await page.evaluate(() => ({
      selected: [...window.viewer.chipAnnotator.selectedChips].sort((a, b) => a - b),
      valueLength: document.getElementById('new-class-input').value.length,
      selection: [document.getElementById('new-class-input').selectionStart, document.getElementById('new-class-input').selectionEnd],
    }));
    assert.deepEqual(grid.selected, beforeGrid);
    assert.deepEqual(grid.selection, [0, grid.valueLength]);
    return { imagePath, single, selectedByCanvas, gridProof, grid, beforeSingle, beforeGrid, nonEditable };
  });

  await record('extended-mylot-edit-commit', 'Manual MY LOT Enter and Tab commit each edited row once', async () => {
    await boot();
    const group = `keyboard_${Date.now()}`;
    const created = await api('/api/my-lot/group', { method: 'POST', body: { mode: 'lot', group } });
    assert.equal(created.status, 200);
    try {
      await page.locator('#my-lot-btn-top').click();
      await page.locator('#my-lot-window').waitFor({ state: 'visible' });
      await page.locator('[data-my-lot-mode="lot"]').click();
      await page.locator('#my-lot-group-select').selectOption(group);
      await page.waitForFunction(target => {
        const modal = window.viewer.myLotModal;
        return modal?.activeGroup === target && modal.entriesContainer?.querySelectorAll('.my-lot-entry-row').length === 0;
      }, group);
      await page.evaluate(() => {
        const modal = window.viewer.myLotModal;
        modal.__editCommitCalls = 0;
        const original = modal.searchAndUpdateManualRowImage.bind(modal);
        modal.searchAndUpdateManualRowImage = (...args) => {
          modal.__editCommitCalls += 1;
          return original(...args);
        };
      });

      await page.locator('#my-lot-manual-add-row').click();
      const firstCell = page.locator('#my-lot-window .my-lot-input-row td[data-cell-type="lot"]').first();
      await firstCell.dblclick();
      await firstCell.locator('input').fill('EDIT_ENTER');
      await page.waitForFunction(() => window.viewer.myLotModal.manualSearchTimers.size === 0);
      const beforeEnter = await page.evaluate(() => window.viewer.myLotModal.__editCommitCalls);
      await firstCell.locator('input').press('Enter');
      await firstCell.locator('input').waitFor({ state: 'hidden' });
      const afterEnter = await page.evaluate(() => window.viewer.myLotModal.__editCommitCalls);
      assert.equal(afterEnter - beforeEnter, 1, 'Enter must commit once, separately from live input preview');

      await page.locator('#my-lot-manual-add-row').click();
      const secondCell = page.locator('#my-lot-window .my-lot-input-row td[data-cell-type="lot"]').nth(1);
      await secondCell.dblclick();
      await secondCell.locator('input').fill('EDIT_TAB');
      await page.waitForFunction(() => window.viewer.myLotModal.manualSearchTimers.size === 0);
      const beforeTab = await page.evaluate(() => window.viewer.myLotModal.__editCommitCalls);
      await secondCell.locator('input').press('Tab');
      await secondCell.locator('input').waitFor({ state: 'hidden' });
      const afterTab = await page.evaluate(() => window.viewer.myLotModal.__editCommitCalls);
      assert.equal(afterTab - beforeTab, 1, 'Tab must commit once, separately from live input preview');
      return { beforeEnter, afterEnter, beforeTab, afterTab };
    } finally {
      await page.evaluate(async () => window.viewer.myLotModal?.close());
      const deleted = await api('/api/my-lot/group', { method: 'DELETE', body: { mode: 'lot', group } });
      assert.equal(deleted.status, 200);
    }
  });

  await record('extended-search-matrix', 'Case/logical/multiline search equivalence, sorting and LOT roundtrip', async () => {
    await boot(); await loadUnknown({ limit: 48 });
    const initial = await paths();
    const lots = [...new Set(initial.map(p => p.split('/').pop().split('_')[0]))].slice(0, 2);
    assert.equal(lots.length, 2);
    const queries = [lots[0], lots[0].toLowerCase(), `(${lots[0]} AND ${lots[0]})`, `${lots[0]} OR ${lots[0]}`];
    let expected;
    const matrix = [];
    for (const query of queries) {
      const result = await api(`/api/search?q=${encodeURIComponent(query)}&limit=10000`);
      assert.equal(result.status, 200);
      assert.ok(result.data.results.length > 0);
      if (!expected) expected = result.data.results;
      samePaths(result.data.results, expected);
      await page.evaluate(async query => {
        window.viewer.dom.fileSearch.value = query;
        await window.viewer.performSearch();
      }, query);
      const proof = await visibleGrid(page);
      samePaths(await paths(), expected);
      matrix.push({ query, count: proof.count, loaded: proof.loadedVisible });
    }
    const input = `${initial[0]}\tignored\n${lots[1]} 05\n${lots[0].toLowerCase()}\n${lots[1]}`;
    const parsed = await page.evaluate(text => {
      window.viewer.dom.multiSearchInput.value = text;
      return window.viewer.parseMultiSearchInput();
    }, input);
    assert.ok(!parsed.error, parsed.error);
    assert.deepEqual(parsed.lots.map(lot => lot.toLowerCase()).sort(), lots.map(lot => lot.toLowerCase()).sort());
    const multi = await api(`/api/search?lot_multi=${encodeURIComponent(lots.join(','))}&limit=10000`);
    await page.evaluate(async lotList => window.viewer.performSearch({ multiLotList: lotList }), parsed.lots);
    await visibleGrid(page); samePaths(await paths(), multi.data.results);
    for (const order of ['lot_desc', 'time_asc', 'lot_asc']) {
      await page.locator('#grid-sort-select').selectOption(order);
      await visibleGrid(page); samePaths(await paths(), multi.data.results);
      if (order.startsWith('lot_')) {
        const actualLots = (await paths()).map(p => p.split('/').pop().split('_')[0].toLowerCase());
        const expectedLots = [...actualLots].sort();
        if (order === 'lot_desc') expectedLots.reverse();
        assert.deepEqual(actualLots, expectedLots);
      } else {
        const timestamps = (await paths()).map(p => p.split('/').pop().split('_'))
          .filter(parts => /^\d{8}$/.test(parts[3]) && /^\d{6}$/.test(parts[4]))
          .map(parts => `${parts[3]}_${parts[4]}`);
        assert.ok(timestamps.length > 0, 'Search fixtures need valid timestamps to check chronological order');
        assert.deepEqual(timestamps, [...timestamps].sort());
      }
    }
    await page.locator('#lot-mode-btn').click(); await visibleGrid(page);
    samePaths(await paths(), multi.data.results);
    const first = (await paths())[0];
    await page.evaluate(() => window.viewer.enterGridImageViewMode(0));
    await visibleSingle(page, first);
    await page.evaluate(() => window.viewer.navigateNext());
    const next = await page.evaluate(() => window.viewer.selectedImagePath);
    assert.notEqual(next, first); await visibleSingle(page, next);
    await page.evaluate(async () => window.viewer.exitSingleImageViewMode());
    const restored = await visibleGrid(page); samePaths(await paths(), multi.data.results);
    return { matrix, parsedLots: parsed.lots, sortedModes: 3, restored };
  });

  const invertedResponse = async kind => {
    await boot(); await loadUnknown({ limit: 16 });
    const sourcePaths = await paths();
    const oldPath = sourcePaths.at(-1), newPath = sourcePaths[1];
    assert.ok(oldPath && newPath);
    await openSingle(newPath);
    await page.locator('#reset-view-btn').click();
    const baselineProof = await visibleSingle(page, newPath);
    const expectedPixels = await canvasPixels();
    const expectedPositions = await api(`/api/chip-positions?path=${encodeURIComponent(newPath)}&include_fq=0&include_grade=1`);
    assert.equal(expectedPositions.status, 200);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let intercepted;
    const captured = new Promise(resolve => { intercepted = resolve; });
    let handlerDone;
    const done = new Promise(resolve => { handlerDone = resolve; });
    let released = false;
    const routePattern = kind === 'positions' ? '**/api/chip-positions?**' : '**/api/chip-annotations?**';
    const handler = async route => {
      if (new URL(route.request().url()).searchParams.get('path') !== oldPath) return route.continue();
      try {
        const response = await route.fetch();
        intercepted({ status: response.status() });
        await held;
        try { await route.fulfill({ response }); }
        catch (error) {
          // The navigation has already canceled the old HTTP request; only that cancellation is expected.
          if (!released || !/closed|cancel|abort|handled|invalid interception/i.test(error.message)) throw error;
        }
      } finally { handlerDone(); }
    };
    await page.route(routePattern, handler);
    try {
      // Start the old real image request without waiting for its delayed metadata.
      await page.evaluate(target => {
        window.__extendedOldLoad = window.viewer.enterSingleViewMode(target);
      }, oldPath);
      const interception = await Promise.race([captured, new Promise((_, reject) => setTimeout(() => reject(Error(`${kind} route was not reached`)), 10000))]);
      assert.equal(interception.status, 200);
      await openSingle(newPath);
      await page.waitForFunction(target => window.viewer.chipAnnotator?.currentImagePath === target &&
        window.viewer.chipAnnotator.chips.length > 0, newPath);
      released = true; release();
      await done;
      await page.evaluate(async () => { await window.__extendedOldLoad; delete window.__extendedOldLoad; });
      await page.locator('#reset-view-btn').click();
      const proof = await visibleSingle(page, newPath);
      assert.equal(proof.annotatorPath, newPath);
      assert.deepEqual(await actualPositionKeys(), positionKeys(expectedPositions.data.chips));
      const meanChannelError = assertBitmap(await canvasPixels(), expectedPixels);
      if (kind === 'annotations') {
        const annotationState = await page.evaluate(async () => {
          const viewer = window.viewer;
          const query = new URLSearchParams({ path: viewer.selectedImagePath, folder: viewer.currentFolderPrefix || '' });
          const response = await fetch(`/api/chip-annotations?${query}`);
          const expected = await response.json();
          const canonical = rows => rows.map(row => JSON.stringify([row.x_abs, row.y_abs, row.class || row.label])).sort();
          return { actual: canonical(viewer.chipAnnotator.markedChips), expected: canonical(expected.marked_chips || []) };
        });
        assert.deepEqual(annotationState.actual, annotationState.expected);
      }
      return { kind, interception, baselineProof, proof, meanChannelError };
    } finally { released = true; release(); await page.unroute(routePattern, handler); }
  };
  await record('extended-position-inversion', 'Real position response inversion preserves final pixels and coordinates', () => invertedResponse('positions'));
  await record('extended-annotation-inversion', 'Real annotation response inversion preserves final labels and bitmap', () => invertedResponse('annotations'));

  await record('extended-tabs-viewport', 'Three viewport sizes preserve independent tab selections and scroll', async () => {
    await boot(); await loadUnknown({ limit: 64 });
    const originalPaths = await paths();
    const firstId = await page.evaluate(() => window.viewer.pageManager.activePageId);
    await selectIndices([0, 3, 7]);
    await page.locator('#page-add-btn').click();
    await loadUnknown({ limit: 24 });
    const secondId = await page.evaluate(() => window.viewer.pageManager.activePageId);
    await selectIndices([1, 5]);
    const results = [];
    for (const size of sizes) {
      await page.setViewportSize(size);
      for (const tab of [{ id: firstId, indices: [0, 3, 7], count: 64 }, { id: secondId, indices: [1, 5], count: 24 }]) {
        await page.locator(`#page-tabs [data-page-id="${tab.id}"]`).click();
        const proof = await visibleGrid(page); assert.equal(proof.count, tab.count);
        const selected = await page.evaluate(() => [...window.viewer.gridSelectedIdxs].sort((a, b) => a - b));
        assert.deepEqual(selected, tab.indices);
        await page.evaluate(() => {
          const wrapper = document.querySelector('.grid-scroll-wrapper');
          wrapper.scrollTop = Math.min(700, wrapper.scrollHeight - wrapper.clientHeight);
          wrapper.dispatchEvent(new Event('scroll'));
        });
        const scrolled = await visibleGrid(page);
        results.push({ size, tab: tab.id, selected, proof: scrolled });
      }
      const firstScroll = results.at(-2).proof.scrollTop;
      const savedScroll = await page.evaluate(id => window.viewer.pageManager.pages
        .find(tab => tab.id === id)?.state?.savedViewState?.scrollTop, firstId);
      assert.ok(Math.abs(savedScroll - firstScroll) < 2,
        `Tab did not save its scroll at ${size.width}: ${firstScroll} -> ${savedScroll}`);
      await page.locator(`#page-tabs [data-page-id="${firstId}"]`).click();
      // A visible cached grid can precede applyPageState's asynchronous scroll restoration.
      await page.waitForFunction(({ id, scroll }) => window.viewer.pageManager.activePageId === id &&
        Math.abs(document.querySelector('.grid-scroll-wrapper').scrollTop - scroll) < 2,
      { id: firstId, scroll: firstScroll });
      const restored = await visibleGrid(page);
      assert.ok(Math.abs(restored.scrollTop - firstScroll) < 2,
        `Tab scroll changed at ${size.width}: ${firstScroll} -> ${restored.scrollTop}`);
      results.at(-2).restoredScroll = { saved: savedScroll, actual: restored.scrollTop };
    }
    await page.locator(`#page-tabs [data-page-id="${firstId}"]`).click();
    await visibleGrid(page); samePaths(await paths(), originalPaths);
    await page.setViewportSize(sizes[2]);
    return results;
  });

  await record('extended-coordinate-matrix', 'Full/partial Shot, wildcard, range intersections and OR at three viewports', async () => {
    await boot();
    const listing = await api('/api/files?path=PW%2FP001%2F20260501');
    const image = listing.data.items.find(item => item.type === 'file' && item.name.endsWith('.png'));
    assert.ok(image, 'P001 layout fixture missing');
    const imagePath = image.root_relative || `PW/P001/20260501/${image.name}`;
    await openSingle(imagePath);
    await page.waitForFunction(() => window.viewer.chipAnnotator?.layoutByChip?.size > 0);
    const targets = await page.evaluate(() => {
      const a = window.viewer.chipAnnotator;
      const groups = [...a.shotBoundaryGroups.values()];
      const max = Math.max(...groups.map(group => group.chips.length));
      const chosen = [groups.find(group => group.chips.length === max), groups.find(group => group.chips.length < max)];
      return chosen.map(group => {
        const chip = group.chips[0], row = a.getLayoutRowForChip(chip);
        return { x: Number(row.shot_x_pos), y: Number(row.shot_y_pos), count: group.chips.length,
          chipX: Number(row.chip_center_x_pos), chipY: Number(row.chip_center_y_pos) };
      });
    });
    const results = [];
    for (let index = 0; index < sizes.length; index++) {
      await page.setViewportSize(sizes[index]);
      await page.evaluate(() => window.viewer.openCoordinateSelectionModal());
      const layout = await page.evaluate(() => {
        const modal = document.getElementById('chip-coordinate-select-modal');
        const nodes = [modal, ...modal.querySelectorAll('.coordinate-select-modal-content, .coordinate-select-list-panels')];
        return nodes.map(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
      });
      assert.ok(layout.every(node => node.width > 0 && node.scrollWidth <= node.width + 1), JSON.stringify(layout));
      const groups = index === 2 ? targets : [targets[index]];
      await page.locator('#chip-coordinate-select-shot-tbody input[data-coordinate-row="0"][data-coordinate-col="0"]')
        .evaluate((input, text) => {
          const transfer = new DataTransfer(); transfer.setData('text/plain', text);
          input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        }, groups.map(group => `${group.x}\t${group.y}`).join('\n'));
      await page.waitForFunction(count => window.viewer.chipAnnotator.selectedChips.size === count,
        groups.reduce((sum, group) => sum + group.count, 0));
      const proof = await visibleSingle(page, imagePath);
      results.push({ viewport: sizes[index], groups, layout, proof });
      // Clear list through its own controls before the next independent viewport case.
      await page.locator('[data-coordinate-list-clear="shot"]').click();
      await page.locator('#chip-coordinate-select-close').click();
    }
    await page.setViewportSize(sizes[2]);
    await page.evaluate(() => window.viewer.openCoordinateSelectionModal());
    const wildcardExpected = await page.evaluate(x => {
      const a = window.viewer.chipAnnotator;
      return a.chips.filter(chip => Number(a.getLayoutRowForChip(chip)?.shot_x_pos) === x).length;
    }, targets[0].x);
    await page.locator('[data-coordinate-quick-search="shot"]').fill(`X=${targets[0].x}`);
    await page.locator('[data-coordinate-quick-search="shot"]').press('Enter');
    await page.waitForFunction(({ x, count }) => {
      const a = window.viewer.chipAnnotator;
      return a.selectedChips.size === count && [...a.selectedChips]
        .every(index => Number(a.getLayoutRowForChip(a.chips[index])?.shot_x_pos) === x);
    }, { x: targets[0].x, count: wildcardExpected });
    const setRange = async (set, axis, bound, value) => {
      await page.locator('#chip-coordinate-select-range-fields .coordinate-select-range-set').nth(set)
        .locator(`input[type="number"][data-coordinate-range-kind="chip"][data-coordinate-range-axis="${axis}"][data-coordinate-range-bound="${bound}"]`).fill(String(value));
    };
    for (const axis of ['x', 'y']) for (const bound of ['min', 'max']) await setRange(0, axis, bound, targets[0][axis === 'x' ? 'chipX' : 'chipY']);
    await page.waitForFunction(() => window.viewer.chipAnnotator.selectedChips.size === 1);
    const wildcardAndRange = await page.evaluate(() => {
      const a = window.viewer.chipAnnotator, chip = a.chips[[...a.selectedChips][0]], row = a.getLayoutRowForChip(chip);
      return [Number(row.chip_center_x_pos), Number(row.chip_center_y_pos)];
    });
    assert.deepEqual(wildcardAndRange, [targets[0].chipX, targets[0].chipY]);
    // Remove the independent Shot constraint so the next OR range can include another Shot.
    await page.locator('[data-coordinate-list-clear="shot"]').click();
    await page.locator('#chip-coordinate-select-range-add').click();
    for (const axis of ['x', 'y']) for (const bound of ['min', 'max']) await setRange(1, axis, bound, targets[1][axis === 'x' ? 'chipX' : 'chipY']);
    await page.waitForFunction(() => window.viewer.chipAnnotator.selectedChips.size === 2);
    const selected = await page.evaluate(() => [...window.viewer.chipAnnotator.selectedChips].map(index => {
      const a = window.viewer.chipAnnotator, row = a.getLayoutRowForChip(a.chips[index]);
      return [Number(row.chip_center_x_pos), Number(row.chip_center_y_pos)];
    }).sort((a, b) => a[0] - b[0]));
    assert.deepEqual(selected, targets.map(target => [target.chipX, target.chipY]).sort((a, b) => a[0] - b[0]));
    await page.locator('#chip-coordinate-select-close').click();
    return { results, wildcardExpected, wildcardAndRange, rangeOrCoordinates: selected };
  });

  for (const seed of [17, 53, 101]) {
    await record(`extended-sequence-${seed}`, `Seed ${seed}: twelve mixed navigation, zoom, legend and grid actions`, async () => {
      await boot(); await loadUnknown({ limit: 32 });
      const expected = await paths();
      let state = seed;
      const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
      const choices = Array.from({ length: 12 }, (_, index) => index % 5);
      for (let index = choices.length - 1; index > 0; index--) {
        const other = next() % (index + 1);
        [choices[index], choices[other]] = [choices[other], choices[index]];
      }
      const trace = [];
      for (let step = 0; step < 12; step++) {
        const choice = choices[step];
        const before = await page.evaluate(() => ({ pageId: window.viewer.pageManager.activePageId,
          gridMode: window.viewer.gridMode, viewMode: window.viewer.viewMode,
          path: window.viewer.selectedImagePath, count: window.viewer.currentGridImages.length }));
        runner.append(`[STEP] seed=${seed} step=${step} choice=${choice} before=${JSON.stringify(before)}\n`);
        if (choice === 0) {
          const cols = [2, 3, 5, 7][next() % 4];
          await columns(cols); const proof = await visibleGrid(page);
          samePaths(await paths(), expected); trace.push({ step, action: 'columns', cols, proof });
        } else if (choice === 1) {
          await page.locator('#lot-mode-btn').click(); const proof = await visibleGrid(page);
          samePaths(await paths(), expected); trace.push({ step, action: 'lot-mode', proof });
        } else if (choice === 4) {
          const originalId = await page.evaluate(() => window.viewer.pageManager.activePageId);
          await page.locator('#page-add-btn').click();
          await loadUnknown({ limit: 8 });
          const scratchId = await page.evaluate(() => window.viewer.pageManager.activePageId);
          const scratch = await visibleGrid(page); assert.equal(scratch.count, 8);
          await page.locator(`#page-tabs [data-page-id="${originalId}"]`).click();
          const restored = await visibleGrid(page); samePaths(await paths(), expected);
          await page.locator(`#page-tabs [data-close-id="${scratchId}"]`).click();
          trace.push({ step, action: 'tab-isolation', scratch, restored });
        } else {
          const list = await paths();
          const index = next() % Math.min(list.length, 12);
          await page.evaluate(index => window.viewer.enterGridImageViewMode(index), index);
          await visibleSingle(page, list[index]);
          if (choice === 2) {
            await page.locator('#zoom-in-btn').click(); await page.locator('#zoom-out-btn').click();
            await page.locator('#reset-view-btn').click();
          } else {
            await page.evaluate(async () => {
              await window.viewer.onGradeButtonClick(0, false, false);
              await window.viewer.onGradeButtonClick(0, false, false);
            });
            await page.evaluate(() => window.viewer.navigateNext());
          }
          const pathNow = await page.evaluate(() => window.viewer.selectedImagePath);
          const proof = await visibleSingle(page, pathNow);
          assert.ok(expected.includes(pathNow));
          const returnState = await page.evaluate(() => ({ pageId: window.viewer.pageManager.activePageId,
            viewMode: window.viewer.viewMode, singleImageFromGrid: window.viewer.singleImageFromGrid,
            savedType: window.viewer.savedViewState?.type,
            savedCount: window.viewer.gridViewSaveState?.images?.length,
            listCount: window.viewer.gridViewImageList?.length }));
          runner.append(`[STEP_RETURN] seed=${seed} step=${step} state=${JSON.stringify(returnState)}\n`);
          await page.evaluate(async () => window.viewer.exitSingleImageViewMode());
          const grid = await visibleGrid(page); samePaths(await paths(), expected);
          trace.push({ step, action: choice === 2 ? 'zoom-reset' : 'legend-next', proof, grid });
        }
      }
      return { seed, trace };
    });
  }
  await finish();
})().catch(error => { console.error(error); process.exitCode = 1; });
