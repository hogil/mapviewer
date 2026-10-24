const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createExtendedRunner } = require('./e2e_extended_common');

(async () => {
  const r = await createExtendedRunner(__filename);
  const { page, api, boot, loadUnknown, visibleGrid, visibleSingle } = r;
  const prefix = `e2elink_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const manifest = { prefix, loginId: r.loginId, classes: [], groups: [], cleanup: [] };
  const saveManifest = () => fs.writeFileSync(path.join(r.outputDir, 'linked-owned-fixtures.json'), JSON.stringify(manifest, null, 2));
  saveManifest();
  const active = () => page.evaluate(() => window.viewer.pageManager.activePageId);
  const paths = () => page.evaluate(() => [...window.viewer.currentGridImages]);
  const accept = (result, label) => {
    assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.data)}`);
    assert.notEqual(result.data?.success, false, label);
    return result.data;
  };
  const imageName = value => value.replace(/\\/g, '/').split('/').pop();
  const sameMembers = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());
  const classFolder = name => page.locator('#label-explorer-list li > div')
    .filter({ hasText: new RegExp(`^[\\s▸▾]*${name}\\s*$`) }).first();

  async function select(indices) {
    await page.locator('#image-grid .grid-thumb-wrap').nth(indices[0]).click();
    await page.waitForFunction(index => window.viewer.gridSelectedIdxs.length === 1 && window.viewer.gridSelectedIdxs[0] === index
      && !window.viewer._pendingGridPlainClickSelection, indices[0]);
    for (const index of indices.slice(1)) await page.locator('#image-grid .grid-thumb-wrap').nth(index).click({ modifiers: ['Control'] });
    await page.waitForFunction(expected => JSON.stringify([...window.viewer.gridSelectedIdxs].sort((a, b) => a - b)) === JSON.stringify(expected), [...indices].sort((a, b) => a - b));
  }

  async function gridState() {
    await visibleGrid(page);
    return page.evaluate(() => {
      const v = window.viewer;
      const wrapper = document.querySelector('.grid-scroll-wrapper');
      const viewport = wrapper.getBoundingClientRect();
      const visible = [...document.querySelectorAll('#image-grid .grid-thumb-wrap')].flatMap(wrap => {
        const rect = wrap.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
          ? [{ index: Number(wrap.dataset.index), path: wrap.dataset.path, top: rect.top - viewport.top }] : [];
      });
      return {
        paths: [...v.currentGridImages], selected: [...v.gridSelectedIdxs].sort((a, b) => a - b),
        selectedUi: [...document.querySelectorAll('#image-grid .grid-thumb-wrap.selected')].map(w => Number(w.dataset.index)).sort((a, b) => a - b),
        lotMode: !!v.lotMode, scroll: wrapper.scrollTop, cols: v.gridCols,
        anchor: visible[0] || null, visibleIndices: visible.map(item => item.index),
        savedScroll: v.savedViewState?.scrollTop, lastGridScroll: v._lastGridScrollTop,
        pageSavedScroll: v.pageManager.getActivePage()?.state?.savedViewState?.scrollTop,
      };
    });
  }

  async function restoreGrid(id, expected) {
    await page.locator(`#page-tabs [data-page-id="${id}"]`).click();
    await visibleGrid(page);
    try {
      await page.waitForFunction(({ id, expected }) => {
        const v = window.viewer;
        return v.pageManager.activePageId === id && JSON.stringify(v.currentGridImages) === JSON.stringify(expected.paths)
          && JSON.stringify([...v.gridSelectedIdxs].sort((a, b) => a - b)) === JSON.stringify(expected.selected)
          && Math.abs(document.querySelector('.grid-scroll-wrapper').scrollTop - expected.scroll) <= 2;
      }, { id, expected });
    } catch (error) {
      const actual = await gridState();
      const firstDifferentPath = expected.paths.findIndex((value, index) => actual.paths[index] !== value);
      throw new Error(`Background restore mismatch: ${JSON.stringify({
        targetPageId: id, actualPageId: await active(),
        expectedCount: expected.paths.length, actualCount: actual.paths.length,
        firstDifferentPath, expectedPath: expected.paths[firstDifferentPath], actualPath: actual.paths[firstDifferentPath],
        expectedSelected: expected.selected, actualSelected: actual.selected,
        expectedSelectedUi: expected.selectedUi, actualSelectedUi: actual.selectedUi,
        expectedScroll: expected.scroll, actualScroll: actual.scroll,
        expectedLotMode: expected.lotMode, actualLotMode: actual.lotMode,
        expectedCols: expected.cols, actualCols: actual.cols,
        expectedAnchor: expected.anchor, actualAnchor: actual.anchor,
        expectedVisibleIndices: expected.visibleIndices, actualVisibleIndices: actual.visibleIndices,
        expectedSavedScroll: expected.savedScroll, actualSavedScroll: actual.savedScroll,
        expectedLastGridScroll: expected.lastGridScroll, actualLastGridScroll: actual.lastGridScroll,
        expectedPageSavedScroll: expected.pageSavedScroll, actualPageSavedScroll: actual.pageSavedScroll,
      })}\n${error.message}`);
    }
    const actual = await gridState();
    assert.deepEqual(actual.paths, expected.paths, 'Background image order changed');
    assert.deepEqual(actual.selected, expected.selected, 'Background selection changed');
    assert.deepEqual(actual.selectedUi, expected.selectedUi, 'Background selection highlight changed');
    assert.equal(actual.lotMode, expected.lotMode, 'Background LOT mode changed');
    return { count: actual.paths.length, selected: actual.selected, scroll: actual.scroll };
  }

  async function scratch(limit = 12) {
    await page.locator('#page-add-btn').click(); await loadUnknown({ limit }); return active();
  }

  async function roundTrip(index = 0) {
    const images = await paths(); const expected = images[index];
    // Make an explicit user multi-selection, then double-click its first image immediately.
    // This also guards against restoring a stale pre-Ctrl-click selection snapshot.
    await select(images.length > 1 ? [index, (index + 1) % images.length] : [index]);
    const before = await gridState();
    await page.locator('#image-grid .grid-thumb-wrap').nth(index).dblclick();
    const single = await visibleSingle(page, expected);
    assert.ok(single.colorCount > 1, 'Single image is blank');
    await page.locator('#viewer-container').dblclick(); await visibleGrid(page);
    const after = await gridState();
    assert.deepEqual(after.paths, before.paths, 'Double-click return changed image order');
    assert.deepEqual(after.selected, before.selected, 'Double-click return changed selection');
    assert.deepEqual(after.selectedUi, before.selectedUi, 'Double-click return changed selection highlight');
    return { expected, single, gridCount: after.paths.length, selected: after.selected };
  }

  async function fixtureRecord(phase, title, work) {
    await r.record(phase, title, async () => {
      await boot();
      // Enter through Wafer Explorer: the initial blank page is legitimately
      // converted in place by Label Explorer, so it is not a background wafer tab.
      await page.locator('#file-explorer summary.folder[data-path="unknown"]').click({ modifiers: ['Control'] });
      await page.waitForFunction(() => window.viewer.pageManager.getActivePage().role === 'wafer');
      await loadUnknown({ limit: 64 }); await select([0, 2]);
      const source = await gridState(); const sourceId = await active();
      const ownedClasses = new Set(); const ownedGroups = new Set();
      const fixture = {
        source, sourceId,
        async class(suffix, images = source.paths.slice(0, 4)) {
          const name = `${prefix}_${phase}_${suffix}`;
          accept(await api('/api/classes?mode=wafer', { method: 'POST', body: { name } }), 'Create owned class');
          ownedClasses.add(name); manifest.classes.push(name); saveManifest();
          accept(await api('/api/classify/batch?mode=wafer', { method: 'POST', body: { class_name: name, images, mode: 'wafer' } }), 'Populate owned class'); return name;
        },
        ownClass(name) {
          assert.ok(name.startsWith(prefix), 'Unowned rename target'); ownedClasses.add(name); manifest.classes.push(name); saveManifest();
        },
        async group(suffix, images) {
          const group = `${prefix}_${phase}_${suffix}`;
          accept(await api('/api/my-lot/group', { method: 'POST', body: { mode: 'wafer', group } }), 'Create owned group');
          ownedGroups.add(group); manifest.groups.push(group); saveManifest();
          accept(await api('/api/my-lot/batch', { method: 'POST', body: { mode: 'wafer', group, paths: images } }), 'Populate owned group'); return group;
        },
      };
      let result; let failure; const httpFailures = [];
      const onResponse = response => { if (response.status() >= 500) httpFailures.push({ url: response.url(), status: response.status() }); };
      page.on('response', onResponse); const cleanup = [];
      try { result = await work(fixture); } catch (error) { failure = error; } finally { page.off('response', onResponse); }
      for (const group of ownedGroups) {
        try {
          const deleted = await api('/api/my-lot/group', { method: 'DELETE', body: { mode: 'wafer', group } }); assert.ok([200, 404].includes(deleted.status));
          const listing = accept(await api('/api/my-lot/groups'), 'List groups after cleanup'); assert.ok(!listing.wafer.groups.some(item => item.name === group)); cleanup.push({ group, status: deleted.status });
        } catch (error) { cleanup.push({ group, error: error.message }); }
      }
      for (const name of [...ownedClasses].reverse()) {
        try {
          const deleted = await api(`/api/classes/${encodeURIComponent(name)}?mode=wafer&force=true`, { method: 'DELETE' }); assert.ok([200, 404].includes(deleted.status));
          const listing = accept(await api('/api/classes?mode=wafer'), 'List classes after cleanup'); assert.ok(!listing.classes.includes(name)); cleanup.push({ class: name, status: deleted.status });
        } catch (error) { cleanup.push({ class: name, error: error.message }); }
      }
      manifest.cleanup.push(...cleanup); saveManifest();
      assert.deepEqual(httpFailures, [], 'Linked interaction had server errors');
      assert.ok(!cleanup.some(item => item.error), `Owned cleanup failed: ${JSON.stringify(cleanup)}`);
      if (failure) throw failure;
      return { ...result, cleanup };
    });
  }

  async function openClass(name) {
    await page.evaluate(async value => {
      window.viewer.classToImgListCache = {}; window.viewer.cachedClassList = null;
      await window.viewer.refreshClassList(true); await window.viewer.refreshLabelExplorer();
      await window.viewer.showGridFromClass(value);
    }, name);
    await visibleGrid(page);
    assert.equal(await page.evaluate(() => window.viewer.pageManager.getActivePage().role), 'label'); return active();
  }

  await fixtureRecord('linked-search-sort-lot', 'Search, sorting and LOT toggling preserve a selected background wafer tab', async f => {
    await scratch(); const lot = imageName(f.source.paths[0]).split('_')[0];
    await page.locator('#file-search').fill(lot); await page.locator('#search-btn').click(); await visibleGrid(page);
    const expected = accept(await api(`/api/search?q=${encodeURIComponent(lot)}&limit=10000`), 'Search oracle').results;
    sameMembers(await paths(), expected); const results = [];
    for (const order of ['lot_desc', 'time_asc']) {
      await page.locator('#grid-sort-select').selectOption(order); await visibleGrid(page); sameMembers(await paths(), expected);
      await page.locator('#lot-mode-btn').click(); await visibleGrid(page); sameMembers(await paths(), expected); results.push(await roundTrip(0));
    }
    return { operations: results, source: await restoreGrid(f.sourceId, f.source) };
  });

  await fixtureRecord('linked-multisearch-cancel', 'Multi-search cancel, valid apply and re-entry preserve the other tab', async f => {
    await scratch(); const before = await gridState();
    await page.locator('#multi-search-btn').click(); await page.locator('#multi-search-dropdown [data-mode="lot"]').click();
    await page.locator('#multi-search-input').fill('UNCOMMITTED_TEXT'); await page.locator('#multi-search-cancel').click(); assert.deepEqual((await gridState()).paths, before.paths);
    const lots = [...new Set(f.source.paths.map(p => imageName(p).split('_')[0]))].slice(0, 2); assert.equal(lots.length, 2);
    await page.locator('#multi-search-btn').click(); await page.locator('#multi-search-dropdown [data-mode="lot"]').click();
    await page.locator('#multi-search-input').fill(lots.join('\n')); await page.locator('#multi-search-apply').click(); await visibleGrid(page);
    const expected = accept(await api(`/api/search?lot_multi=${lots.join(',')}&limit=10000`), 'Multi search oracle').results; sameMembers(await paths(), expected);
    return { lots, proof: await roundTrip(0), source: await restoreGrid(f.sourceId, f.source) };
  });

  await fixtureRecord('linked-class-rename', 'Class rename collision and successful rename refresh Explorer without changing source view', async f => {
    const a = await f.class('a'); const b = await f.class('b'); await openClass(a);
    const collision = await api('/api/classes/rename?mode=wafer', { method: 'POST', body: { old_name: a, new_name: b } }); assert.equal(collision.status, 409);
    const renamed = `${a}_renamed`; f.ownClass(renamed);
    await page.evaluate(async () => {
      const v = window.viewer; v.classMode = 'wafer'; v.cachedClassList = null; await v.refreshClassList(true);
      v.classSelection.selected = []; v.classSelection.lastClicked = null; v.selectedClass = null; v.updateClassListSelection();
    });
    await page.locator('#class-list').getByRole('button', { name: a, exact: true }).click({ modifiers: ['Control'] });
    const renamePrompt = dialog => dialog.accept(dialog.type() === 'prompt' ? renamed : undefined); page.on('dialog', renamePrompt);
    try { await page.locator('#rename-class-btn').click(); await classFolder(renamed).waitFor({ state: 'visible' }); } finally { page.off('dialog', renamePrompt); }
    assert.equal(await classFolder(a).count(), 0); await openClass(renamed); assert.equal((await paths()).length, 4);
    return { collisionStatus: collision.status, renamed, proof: await roundTrip(0), source: await restoreGrid(f.sourceId, f.source) };
  });

  await fixtureRecord('linked-label-mutations', 'Removing and re-adding a label refreshes class images while wafer selection remains intact', async f => {
    const name = await f.class('labels'); await openClass(name); const original = await paths();
    accept(await api('/api/classify', { method: 'DELETE', body: { mode: 'wafer', class_name: name, image_name: imageName(original[0]) } }), 'Delete one owned label');
    await openClass(name); assert.equal((await paths()).length, 3); assert.ok(!(await paths()).some(p => imageName(p) === imageName(original[0])));
    const deletedView = await roundTrip(0);
    const originalSource = f.source.paths.find(p => imageName(p) === imageName(original[0])); assert.ok(originalSource);
    accept(await api('/api/labels', { method: 'POST', body: { image_path: originalSource, labels: [name] } }), 'Re-add owned label');
    await openClass(name); sameMembers((await paths()).map(imageName), original.map(imageName));
    return { deletedView, restoredCount: 4, source: await restoreGrid(f.sourceId, f.source) };
  });

  await fixtureRecord('linked-mylot-groups', 'MY LOT group and mode changes keep the already-open group grid and source tab independent', async f => {
    const a = await f.group('groupa', f.source.paths.slice(0, 3)); const b = await f.group('groupb', f.source.paths.slice(3, 5));
    await page.evaluate(async () => { const modal = await window.viewer._getMyLotModal(); await modal.open(); await modal.refreshData(); await modal.setMode('wafer'); });
    await page.locator('#my-lot-group-select').selectOption(a); await page.waitForFunction(() => window.viewer.myLotModal.currentEntries.length === 3);
    await page.locator('#my-lot-select-all').click(); await page.locator('#my-lot-grid-view').click(); await page.evaluate(() => window.viewer.myLotModal.close());
    const groupId = await active(); const groupGrid = await gridState(); assert.equal(groupGrid.paths.length, 3);
    await page.evaluate(async () => { await window.viewer.myLotModal.open(); await window.viewer.myLotModal.refreshData(); });
    await page.locator('#my-lot-group-select').selectOption(b); await page.waitForFunction(() => window.viewer.myLotModal.currentEntries.length === 2);
    await page.evaluate(async () => { await window.viewer.myLotModal.setMode('lot'); await window.viewer.myLotModal.setMode('wafer'); });
    await page.locator('#my-lot-group-select').selectOption(b); await page.waitForFunction(() => window.viewer.myLotModal.currentEntries.length === 2); await page.evaluate(() => window.viewer.myLotModal.close());
    const restoredGroup = await restoreGrid(groupId, groupGrid);
    return { groups: [a, b], restoredGroup, proof: await roundTrip(0), source: await restoreGrid(f.sourceId, f.source) };
  });

  await fixtureRecord('linked-color-cancel', 'Color editor preview cancellation and reopening do not save preview colors or disturb the label tab', async f => {
    const name = await f.class('color'); const labelId = await openClass(name); await select([0, 2]); const labelState = await gridState();
    await restoreGrid(f.sourceId, f.source);
    await page.locator('#image-grid .grid-thumb-wrap').first().scrollIntoViewIfNeeded();
    const sourceBeforeSingle = await gridState();
    await page.locator('#image-grid .grid-thumb-wrap').first().dblclick(); const image = await visibleSingle(page, f.source.paths[0]);
    await page.evaluate(async () => (await window.viewer._getColorEditor()).open()); await page.locator('#color-editor-modal').waitFor({ state: 'visible' });
    const before = await page.evaluate(() => window.viewer.colorEditor.originalSchemeData);
    await page.locator('#color-editor-table-body tr[data-section="background"] input[type="color"]').evaluate(element => { element.value = '#12ab34'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    // Preview is debounced by 500ms. Closing before it runs intentionally has no
    // restore POST; first prove that the requested preview reached the image.
    await page.waitForFunction(expectedPath => {
      const v = window.viewer;
      const editor = v.colorEditor;
      if (!editor._previewApplied || v.selectedImagePath !== expectedPath ||
          String(v.colorLegends[editor.currentSchemeName]?.background).toLowerCase() !== '#12ab34') return false;
      const sample = document.createElement('canvas'); sample.width = sample.height = 32;
      const ctx = sample.getContext('2d'); ctx.drawImage(v.dom.imageCanvas, 0, 0, 32, 32);
      const pixels = ctx.getImageData(0, 0, 32, 32).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - 18) <= 2 && Math.abs(pixels[i + 1] - 171) <= 2 && Math.abs(pixels[i + 2] - 52) <= 2 && pixels[i + 3] > 0) return true;
      }
      return false;
    }, f.source.paths[0], { timeout: 20000 });
    const restored = page.waitForResponse(response => response.url().includes('/api/color-scheme') && response.request().method() === 'POST' && !response.url().includes('ratio'));
    await page.locator('#color-editor-cancel-btn').click(); assert.ok((await restored).ok(), 'Color restoration failed'); await page.locator('#color-editor-modal').waitFor({ state: 'hidden' }); await visibleSingle(page, f.source.paths[0]);
    const after = accept(await api('/logs/color-legends.json'), 'Read colors after cancel');
    const logicalColors = value => JSON.parse(JSON.stringify({ top: value.top, bottom: value.bottom, background: value.background, text: value.text }).replace(/#[0-9a-fA-F]{6}/g, hex => hex.toLowerCase()));
    assert.deepEqual(logicalColors(after[r.loginId]), logicalColors(before), 'Cancel persisted preview colors');
    await page.evaluate(async () => (await window.viewer._getColorEditor()).open()); await page.locator('#color-editor-cancel-btn').click();
    return { image, label: await restoreGrid(labelId, labelState), source: await restoreGrid(f.sourceId, sourceBeforeSingle) };
  });

  await fixtureRecord('linked-navigator-zoom', 'Next/previous navigation, zoom and minimap remain tied to the single view while source selection survives', async f => {
    const positionedSingle = async expectedPath => {
      await visibleSingle(page, expectedPath);
      // selectedImagePath is assigned before the asynchronous positions load.
      // Capture proof only after the annotator belongs to that same image.
      await page.waitForFunction(target => {
        const v = window.viewer;
        return v.selectedImagePath === target && v.chipAnnotator?.currentImagePath === target &&
          v.chipAnnotator.chips.length > 0 && v.chipAnnotator.positionsData?.chips?.length > 0;
      }, expectedPath, { timeout: 20000 });
      return visibleSingle(page, expectedPath);
    };
    await page.locator('#image-grid .grid-thumb-wrap').first().scrollIntoViewIfNeeded();
    const sourceBeforeSingle = await gridState();
    await page.locator('#image-grid .grid-thumb-wrap').first().dblclick(); await positionedSingle(f.source.paths[0]);
    await page.locator('#next-btn').click(); const next = await positionedSingle(f.source.paths[1]);
    await page.locator('#zoom-in-btn').click(); await page.locator('#minimap-container').waitFor({ state: 'visible' });
    const viewport = await page.locator('#minimap-viewport').boundingBox(); assert.ok(viewport?.width > 0 && viewport?.height > 0, 'Minimap viewport is missing');
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2); await page.mouse.down();
    await page.mouse.move(viewport.x + viewport.width / 2 + 10, viewport.y + viewport.height / 2 + 5, { steps: 3 }); await page.mouse.up();
    await page.locator('#reset-view-btn').click(); await page.locator('#prev-btn').click(); const previous = await positionedSingle(f.source.paths[0]);
    assert.equal(next.annotatorPath, f.source.paths[1]); assert.equal(previous.annotatorPath, f.source.paths[0]); await page.locator('#viewer-container').dblclick();
    return { next, previous, source: await restoreGrid(f.sourceId, sourceBeforeSingle) };
  });

  await fixtureRecord('linked-close-recreate', 'Closing a scrolled scratch tab after global column changes preserves the original top-of-grid workspace', async f => {
    if (!await page.evaluate(() => window.viewer.lotMode)) await page.locator('#lot-mode-btn').click();
    await visibleGrid(page);
    await page.locator('.grid-scroll-wrapper').evaluate(element => {
      element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const sourceAtTop = await gridState();
    assert.equal(sourceAtTop.scroll, 0);
    const id = await scratch(16); await select([1, 4]); const before = await gridState();
    await page.locator('#grid-cols-input').fill('2');
    await page.locator('#grid-cols-input').press('Enter');
    await page.waitForFunction(() => window.viewer.gridCols === 2);
    await visibleGrid(page);
    assert.deepEqual((await gridState()).paths, before.paths);
    await page.locator('.grid-scroll-wrapper').evaluate(element => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * .5);
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await visibleGrid(page);
    const visibleIndex = await page.evaluate(() => {
      const viewport = document.querySelector('.grid-scroll-wrapper').getBoundingClientRect();
      const visible = [...document.querySelectorAll('#image-grid .grid-thumb-wrap')].filter(element => {
        const rect = element.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      return Number(visible[Math.floor(visible.length / 2)].dataset.index);
    });
    const proof = await roundTrip(visibleIndex);
    assert.ok((await gridState()).scroll > 0, 'Scratch fixture must have a positive scroll before closing');
    await page.locator(`#page-tabs [data-close-id="${id}"]`).click();
    assert.equal(await page.locator(`#page-tabs [data-page-id="${id}"]`).count(), 0);
    await restoreGrid(f.sourceId, sourceAtTop);
    const newId = await scratch(8); assert.notEqual(newId, id);
    assert.deepEqual((await gridState()).selected, [], 'New page inherited closed-page selection');
    await page.locator(`#page-tabs [data-close-id="${newId}"]`).click();
    return { closedId: id, newId, proof, source: await restoreGrid(f.sourceId, sourceAtTop) };
  });

  await fixtureRecord('linked-cache-eviction', 'A top-of-grid source survives more live tabs than the DOM cache limit and a scrolled detail return', async f => {
    if (!await page.evaluate(() => window.viewer.lotMode)) await page.locator('#lot-mode-btn').click();
    await page.locator('#grid-cols-input').fill('2');
    await page.locator('#grid-cols-input').press('Enter');
    await page.waitForFunction(() => window.viewer.gridCols === 2);
    await visibleGrid(page);
    await page.locator('.grid-scroll-wrapper').evaluate(element => {
      element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const sourceAtTop = await gridState();
    assert.equal(sourceAtTop.scroll, 0);
    const limit = await page.evaluate(() => window.viewer.pageViewCacheLimit);
    assert.ok(limit > 0 && limit <= 20, 'Unexpected DOM cache limit');
    const opened = [];
    for (let index = 0; index < limit + 2; index++) opened.push(await scratch(8));
    assert.equal(await page.evaluate(id => window.viewer.pageViewCache.has(id), f.sourceId), false,
      'Source DOM must be evicted by real tab creation');
    if (!await page.evaluate(() => window.viewer.lotMode)) await page.locator('#lot-mode-btn').click();
    await visibleGrid(page);
    await page.locator('.grid-scroll-wrapper').evaluate(element => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * .5);
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await visibleGrid(page);
    const visibleIndex = await page.evaluate(() => {
      const viewport = document.querySelector('.grid-scroll-wrapper').getBoundingClientRect();
      const visible = [...document.querySelectorAll('#image-grid .grid-thumb-wrap')].filter(element => {
        const rect = element.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      return Number(visible[Math.floor(visible.length / 2)].dataset.index);
    });
    const detail = await roundTrip(visibleIndex);
    const scratchState = await gridState();
    assert.ok(scratchState.scroll > 0 && scratchState.lastGridScroll > 0, 'Scratch must leave a positive scroll');
    assert.equal(await page.evaluate(id => window.viewer.pageViewCache.has(id), f.sourceId), false);
    const restored = await restoreGrid(f.sourceId, sourceAtTop);
    return { cacheLimit: limit, openedTabs: opened.length, detail, scratchScroll: scratchState.scroll, restored };
  });

  await r.finish();
})().catch(error => { console.error(error); process.exitCode = 2; });
