const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { createExtendedRunner } = require('./e2e_extended_common');

(async () => {
  const runner = await createExtendedRunner(__filename);
  const { page, loginId, expect, boot, loadUnknown, visibleGrid, visibleSingle, api, finish } = runner;
  const record = (phase, name, work) => runner.record(phase, name, async () => {
    await boot();
    return work();
  });
  const prefix = `e2exs_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const ownedClasses = new Set();
  const ownedGroups = new Set();
  const cleanupHistory = [];
  const saveManifest = () => fs.writeFileSync(path.join(runner.outputDir, 'storage-owned-fixtures.json'), JSON.stringify({
    prefix, loginId, classes: [...ownedClasses], groups: [...ownedGroups], cleanup: cleanupHistory,
  }, null, 2));
  const groupKey = (mode, name, identity) => `${identity}/${mode}/${name}`;
  const fileName = value => String(value).replace(/\\/g, '/').split('/').pop();
  const flatten = entries => [...new Set(entries.flatMap(entry => entry.all_paths?.length ? entry.all_paths : [entry.path]).filter(Boolean))];
  const accepted = (result, label) => {
    expect(result.status === 200 && result.data?.success !== false, `${label}: ${JSON.stringify(result)}`);
    return result.data;
  };
  const ownedClass = (mode, name) => expect(ownedClasses.has(`${mode}/${name}`), `Unowned class mutation refused: ${mode}/${name}`);
  const ownedGroup = (mode, name, identity = loginId) => expect(ownedGroups.has(groupKey(mode, name, identity)), `Unowned group mutation refused: ${identity}/${mode}/${name}`);

  async function fixtures(work) {
    const classes = [];
    const groups = [];
    const finalizers = [];
    const f = {
      finalizers,
      async class(mode, suffix) {
        const name = `${prefix}_${suffix}`;
        accepted(await api(`/api/classes?mode=${mode}`, { method: 'POST', body: { name } }), 'Create owned class');
        ownedClasses.add(`${mode}/${name}`);
        saveManifest();
        classes.push({ mode, name });
        return name;
      },
      async renameClass(mode, oldName, newName) {
        ownedClass(mode, oldName);
        expect(newName.startsWith(`${prefix}_`), 'Rename target must use this run prefix');
        const result = await api(`/api/classes/rename?mode=${mode}`, { method: 'POST', body: { old_name: oldName, new_name: newName } });
        if (result.status === 200) {
          ownedClasses.add(`${mode}/${newName}`);
          saveManifest();
          classes.push({ mode, name: newName });
        }
        return result;
      },
      async group(mode, suffix, targetPage = page, identity = loginId) {
        const name = `${prefix}_${suffix}`;
        accepted(await api('/api/my-lot/group', { method: 'POST', body: { mode, group: name }, page: targetPage, loginId: identity }), 'Create owned group');
        ownedGroups.add(groupKey(mode, name, identity));
        saveManifest();
        groups.push({ mode, name, page: targetPage, identity });
        return name;
      },
      ownRenamedGroup(mode, name, targetPage = page, identity = loginId) {
        expect(name.startsWith(`${prefix}_`), 'Rename target must use this run prefix');
        ownedGroups.add(groupKey(mode, name, identity));
        saveManifest();
        groups.push({ mode, name, page: targetPage, identity });
      },
    };
    let result;
    let failure;
    try { result = await work(f); } catch (error) { failure = error; }
    const cleanup = [];
    for (const finalizer of finalizers) {
      try { await finalizer(); } catch (error) { cleanup.push({ failure: error.message }); }
    }
    for (const target of [...groups].reverse()) {
      try {
        ownedGroup(target.mode, target.name, target.identity);
        const response = await api('/api/my-lot/group', {
          method: 'DELETE', body: { mode: target.mode, group: target.name }, page: target.page, loginId: target.identity,
        });
        expect([200, 404].includes(response.status), `Owned group cleanup HTTP ${response.status}`);
        const listing = await api('/api/my-lot/groups', { page: target.page, loginId: target.identity });
        expect(listing.status === 200 && !listing.data[target.mode].groups.some(group => group.name === target.name), 'Owned group survived cleanup');
        cleanup.push({ type: 'group', name: target.name, mode: target.mode, identity: target.identity, status: response.status });
      } catch (error) { cleanup.push({ type: 'group', name: target.name, mode: target.mode, identity: target.identity, failure: error.message }); }
    }
    for (const target of [...classes].reverse()) {
      try {
        ownedClass(target.mode, target.name);
        const response = await api(`/api/classes/${encodeURIComponent(target.name)}?mode=${target.mode}&force=true`, { method: 'DELETE' });
        expect([200, 404].includes(response.status), `Owned class cleanup HTTP ${response.status}`);
        const listing = await api(`/api/classes?mode=${target.mode}`);
        expect(listing.status === 200 && !listing.data.classes.includes(target.name), 'Owned class survived cleanup');
        cleanup.push({ type: 'class', name: target.name, mode: target.mode, status: response.status });
      } catch (error) { cleanup.push({ type: 'class', name: target.name, mode: target.mode, failure: error.message }); }
    }
    const cleanupErrors = cleanup.filter(item => item.failure);
    cleanupHistory.push(...cleanup);
    saveManifest();
    if (failure || cleanupErrors.length) {
      throw new Error(`${failure?.stack || ''}\nFixture cleanup: ${JSON.stringify(cleanup)}`);
    }
    return { ...result, cleanup };
  }

  async function samples(limit = 12, targetPage = page) {
    await loadUnknown({ page: targetPage, limit });
    const paths = await targetPage.evaluate(count => (window.viewer.currentGridImages || []).filter(path => String(path).startsWith('unknown/')).slice(0, count), limit);
    expect(paths.length >= Math.min(limit, 3), `Not enough real unknown samples: ${paths.length}`);
    return paths;
  }

  async function openSingle(path, targetPage = page) {
    await targetPage.evaluate(async value => {
      (await window.viewer._getMyLotModal()).close();
      await window.viewer.enterSingleViewMode(value);
    }, path);
    await targetPage.waitForFunction(expected => window.viewer.chipAnnotator?.currentImagePath === expected
      && window.viewer.chipAnnotator.chips.length > 0, path, { timeout: 20000 });
    return visibleSingle(targetPage, path);
  }

  async function openGrid(paths, targetPage = page) {
    await targetPage.evaluate(async values => {
      (await window.viewer._getMyLotModal()).close();
      await window.viewer.showGrid(values);
    }, paths);
    const result = await visibleGrid(targetPage);
    expect(result.count === paths.length, `Visible grid count=${result.count} expected=${paths.length}`);
    return result;
  }

  async function classImages(mode, name) {
    ownedClass(mode, name);
    const result = await api(`/api/classes/${name}/images?mode=${mode}&limit=100`);
    expect(result.status === 200 && Array.isArray(result.data.results), `Class images: ${JSON.stringify(result)}`);
    return result.data.results;
  }

  async function entries(mode, name, targetPage = page, identity = loginId) {
    ownedGroup(mode, name, identity);
    const result = await api(`/api/my-lot/entries?mode=${mode}&group=${encodeURIComponent(name)}`, { page: targetPage, loginId: identity });
    expect(result.status === 200 && Array.isArray(result.data), `Group entries: ${JSON.stringify(result)}`);
    return result.data;
  }

  async function save(mode, group, paths, targetPage = page, identity = loginId) {
    ownedGroup(mode, group, identity);
    return api('/api/my-lot/batch', { method: 'POST', body: { mode, group, paths }, page: targetPage, loginId: identity });
  }

  async function selectGroup(mode, group, targetPage = page) {
    await targetPage.evaluate(async ({ mode, group }) => {
      const modal = await window.viewer._getMyLotModal();
      await modal.open();
      await modal.refreshData();
      await modal.setMode(mode);
      modal.activeGroup = group;
      modal.renderGroups();
      await modal.loadActiveGroupEntriesAndRender();
    }, { mode, group });
    await targetPage.locator('#my-lot-window').waitFor({ state: 'visible' });
    return targetPage.evaluate(async () => {
      const modal = await window.viewer._getMyLotModal();
      return { mode: modal.activeMode, group: modal.activeGroup, rows: modal.currentEntries.length,
        values: modal.currentEntries.map(entry => entry.filename || entry.value), text: modal.entriesContainer.innerText };
    });
  }

  async function groupGrid(mode, group, expectedCount, targetPage = page) {
    const table = await selectGroup(mode, group, targetPage);
    await targetPage.locator('#my-lot-select-all').click();
    await targetPage.locator('#my-lot-grid-view').click();
    await targetPage.evaluate(async () => (await window.viewer._getMyLotModal()).close());
    const grid = await visibleGrid(targetPage);
    expect(grid.count === expectedCount, `MY LOT ${mode}/${group}: ${grid.count} != ${expectedCount}`);
    const state = await targetPage.evaluate(() => ({ paths: [...window.viewer.currentGridImages], scope: window.viewer.currentFolderPath }));
    return { table, grid, ...state };
  }

  async function positions(path, targetPage = page, identity = loginId) {
    const result = await api(`/api/chip-positions?path=${encodeURIComponent(path)}&count_only=1`, { page: targetPage, loginId: identity });
    expect(result.status === 200, `Positions HTTP ${result.status}`);
    return result.data.chip_count ?? result.data.chips?.length ?? 0;
  }

  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }

  async function waitGate(promise, label) {
    let timer;
    try {
      await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not occur`)), 12000); })]);
    } finally { clearTimeout(timer); }
  }

  try {
    await record('storage-wafer-labels', 'Wafer duplicate/multi-class labels, rename collision, deletion, visible positions', async () => fixtures(async f => {
      const paths = await samples(4);
      const a = await f.class('wafer', 'wa');
      const b = await f.class('wafer', 'wb');
      const renamed = `${prefix}_wr`;
      for (const path of paths.slice(0, 2)) {
        accepted(await api('/api/labels', { method: 'POST', body: { image_path: path, labels: [a, b, a] } }), 'Multi-class wafer add');
      }
      const duplicate = await api('/api/labels', { method: 'POST', body: { image_path: paths[0], labels: [a, b] } });
      accepted(duplicate, 'Repeated wafer label');
      const aFiles = await classImages('wafer', a);
      const bFiles = await classImages('wafer', b);
      expect(aFiles.length === 2 && bFiles.length === 2, 'Duplicate label created extra files');
      const collision = await f.renameClass('wafer', a, b);
      expect(collision.status === 409, `Class rename collision status=${collision.status}`);
      accepted(await f.renameClass('wafer', a, renamed), 'Rename owned wafer class');
      const renamedFiles = await classImages('wafer', renamed);
      const grid = await openGrid(renamedFiles);
      const single = await openSingle(renamedFiles[0]);
      const originalCount = await positions(paths.find(path => fileName(path) === fileName(renamedFiles[0])));
      expect(single.chipCount === originalCount && originalCount > 0, 'Renamed wafer label lost positions');
      ownedClass('wafer', renamed);
      accepted(await api('/api/classify', { method: 'DELETE', body: { mode: 'wafer', class_name: renamed, image_name: fileName(renamedFiles[0]) } }), 'Label Explorer basename deletion');
      ownedClass('wafer', b);
      accepted(await api('/api/labels/delete', { method: 'POST', body: { image_path: paths[0], labels: [b] } }), 'Owned legacy label deletion');
      const remaining = await classImages('wafer', renamed);
      expect(remaining.length === 1 && (await classImages('wafer', b)).length === 1, 'Selected label deletion changed unexpected files');
      const remainingGrid = await openGrid(remaining);
      return { duplicateStatus: duplicate.status, collisionStatus: collision.status, originalCount, grid, single, remainingGrid };
    }));

    await record('storage-chip-labels', 'Chip duplicate crop labels and colliding class rename preserve source and crop views', async () => fixtures(async f => {
      const paths = await samples(3);
      const source = paths[0];
      const response = await api(`/api/chip-positions?path=${encodeURIComponent(source)}&include_fq=0`);
      const coords = response.data?.chips?.slice(0, 2).map(chip => ({ x_abs: Number(chip.x_abs), y_abs: Number(chip.y_abs) }));
      expect(response.status === 200 && coords?.length === 2, 'No chip coordinate fixture');
      const a = await f.class('chip', 'ca');
      const b = await f.class('chip', 'cb');
      const renamed = `${prefix}_cr`;
      for (const cls of [a, b, a]) {
        ownedClass('chip', cls);
        accepted(await api('/api/classify/chips', { method: 'POST', body: { class_name: cls, image_path: source, chip_coords: coords } }), 'Chip class crop');
      }
      expect((await classImages('chip', a)).length === 2, 'Duplicate chip labels created extra crops');
      const collision = await f.renameClass('chip', a, b);
      expect(collision.status === 409, `Chip rename collision status=${collision.status}`);
      accepted(await f.renameClass('chip', a, renamed), 'Chip class rename');
      const files = await classImages('chip', renamed);
      const crops = await openGrid(files);
      const sourceView = await openSingle(source);
      expect(sourceView.chipCount >= 2, 'Source chip positions lost during crop operations');
      ownedClass('chip', renamed);
      accepted(await api('/api/classify/delete?mode=chip', { method: 'POST', body: { mode: 'chip', class: renamed, images: [files[0]] } }), 'Delete one owned chip label');
      const remainder = await classImages('chip', renamed);
      expect(remainder.length === 1 && (await classImages('chip', b)).length === 2, 'Chip class deletion crossed class boundaries');
      const remainingGrid = await openGrid(remainder);
      return { coords, duplicateFiles: 2, collisionStatus: collision.status, crops, sourceView, remainingGrid };
    }));

    await record('storage-active-class-delete', 'Delete an owned class while its visible grid thumbnails are requested, then continue viewing', async () => fixtures(async f => {
      const paths = await samples(8);
      const cls = await f.class('wafer', 'active_delete');
      for (const source of paths) {
        accepted(await api('/api/labels', { method: 'POST', body: { image_path: source, labels: [cls] } }), 'Prepare owned active-read class');
      }
      const copies = await classImages('wafer', cls);
      const requests = [];
      const matches = request => {
        const url = new URL(request.url());
        return url.pathname === '/api/thumbnail' && (url.searchParams.get('path') || '').startsWith(`classification/${cls}/`);
      };
      const observe = request => { if (matches(request)) requests.push(request); };
      page.on('request', observe);
      f.finalizers.push(() => page.off('request', observe));
      const requested = page.waitForRequest(matches, { timeout: 12000 });
      await page.evaluate(async values => { await window.viewer.showGrid(values); }, copies);
      await requested;
      ownedClass('wafer', cls);
      const deleted = await api(`/api/classes/${cls}?mode=wafer&force=true`, { method: 'DELETE' });
      const statuses = await Promise.all(requests.map(async request => (await request.response())?.status() ?? 0));
      expect(deleted.status === 200, `Deleting an actively-read class failed: ${JSON.stringify(deleted)}`);
      expect(statuses.length > 0 && statuses.every(status => [200, 304, 404].includes(status)), `Concurrent thumbnail outcomes: ${JSON.stringify(statuses)}`);
      const listing = await api('/api/classes?mode=wafer');
      expect(!listing.data.classes.includes(cls), 'Deleted class survived active thumbnail reads');
      const grid = await openGrid(paths.slice(0, 3));
      const single = await openSingle(paths[0]);
      return { copied: copies.length, requestedThumbnails: statuses.length, statuses, deleteStatus: deleted.status, grid, single };
    }));

    await record('storage-mylot-persistence', 'Two MY LOT groups in both modes survive rename and page reload with exact copies', async () => fixtures(async f => {
      const paths = await samples(5);
      const groups = [];
      for (const mode of ['lot', 'wafer']) {
        for (const index of [0, 1]) {
          const name = await f.group(mode, `persist_${index}`);
          const expected = paths.slice(index * 2, index * 2 + 2);
          const saved = accepted(await save(mode, name, expected), 'Persist MY LOT pair');
          expect(saved.success_count === 2, `Pair save count=${saved.success_count}`);
          groups.push({ mode, name, expected });
        }
      }
      for (const group of groups.filter(item => item.name.endsWith('_0'))) {
        const renamed = `${group.name}_renamed`;
        ownedGroup(group.mode, group.name);
        accepted(await api('/api/my-lot/group/rename', { method: 'PUT', body: { mode: group.mode, old_name: group.name, new_name: renamed } }), 'Rename persisted group');
        f.ownRenamedGroup(group.mode, renamed);
        group.name = renamed;
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await boot();
      const snapshots = [];
      for (const group of groups) {
        const found = flatten(await entries(group.mode, group.name));
        expect(found.length === 2 && found.every(path => group.expected.some(source => fileName(source) === fileName(path))), 'Reload changed saved file set');
        snapshots.push(await groupGrid(group.mode, group.name, 2));
      }
      const copy = snapshots[3].paths[0];
      const single = await openSingle(copy);
      expect(single.chipCount > 0, 'Reloaded MY LOT copy has no coordinates');
      return { groups: groups.map(({ mode, name }) => ({ mode, name })), snapshots, single };
    }));

    await record('storage-group-response-order', 'Real delayed MY LOT response cannot overwrite a later group selection', async () => fixtures(async f => {
      const paths = await samples(3);
      const a = await f.group('wafer', 'slow');
      const b = await f.group('wafer', 'fast');
      accepted(await save('wafer', a, [paths[0]]), 'Slow group fixture');
      accepted(await save('wafer', b, [paths[1]]), 'Fast group fixture');
      await selectGroup('wafer', b);
      const seen = gate();
      const release = gate();
      const delivered = gate();
      const pattern = '**/api/my-lot/entries?**';
      let delayedCount = 0;
      await page.route(pattern, async route => {
        if (new URL(route.request().url()).searchParams.get('group') !== a) return route.continue();
        const response = await route.fetch();
        delayedCount += 1;
        seen.release();
        await release.promise;
        await route.fulfill({ response });
        delivered.release();
      });
      f.finalizers.push(async () => { release.release(); await page.unroute(pattern); });
      const delayedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/my-lot/entries'
        && new URL(response.url()).searchParams.get('group') === a);
      await page.locator('#my-lot-group-select').selectOption(a);
      await waitGate(seen.promise, 'Real delayed group response');
      await page.locator('#my-lot-group-select').selectOption(b);
      await page.waitForFunction(({ group, filename }) => {
        const modal = window.viewer.myLotModal;
        return modal?.activeGroup === group && modal.currentEntries.length === 1
          && modal.currentEntries[0].path?.split('/').pop() === filename
          && modal.entriesContainer.querySelectorAll('.my-lot-entry-row').length === 1;
      }, { group: b, filename: fileName(paths[1]) });
      release.release();
      await waitGate(delivered.promise, 'Delayed group response delivery');
      await (await delayedResponse).finished();
      await page.unroute(pattern);
      const state = await page.evaluate(async () => {
        const modal = await window.viewer._getMyLotModal();
        return { group: modal.activeGroup, paths: modal.currentEntries.map(entry => entry.path), text: modal.entriesContainer.innerText };
      });
      expect(delayedCount > 0 && state.group === b && state.paths.length === 1 && fileName(state.paths[0]) === fileName(paths[1]), `Stale group response: ${JSON.stringify(state)}`);
      const grid = await groupGrid('wafer', b, 1);
      return { delayedCount, state, grid };
    }));

    await record('storage-save-switch', 'LOT save retains its submitted group while real search waits and user switches to Wafer', async () => fixtures(async f => {
      const paths = await samples(3);
      const a = await f.group('lot', 'submit');
      const b = await f.group('wafer', 'later');
      await selectGroup('lot', a);
      await page.evaluate(() => { window.viewer._restoreGridSelectionFromSourceImages([window.viewer.currentGridImages[0]]); });
      const seen = gate();
      const release = gate();
      const pattern = '**/api/search?**';
      let delayed = 0;
      let submitted = null;
      const observe = request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/my-lot/batch') submitted = request.postDataJSON();
      };
      page.on('request', observe);
      await page.route(pattern, async route => {
        if (!new URL(route.request().url()).searchParams.has('lot_multi') || delayed) return route.continue();
        const response = await route.fetch();
        delayed += 1;
        seen.release();
        await release.promise;
        await route.fulfill({ response });
      });
      f.finalizers.push(async () => { release.release(); await page.unroute(pattern); page.off('request', observe); });
      await page.evaluate(async () => { window.__extendedStorageSave = (await window.viewer._getMyLotModal()).handleSave(); });
      await waitGate(seen.promise, 'LOT search response');
      await page.locator('[data-my-lot-mode="wafer"]').click();
      await page.locator('#my-lot-group-select').selectOption(b);
      release.release();
      await page.evaluate(async () => { await window.__extendedStorageSave; delete window.__extendedStorageSave; });
      const target = flatten(await entries('lot', a));
      const other = flatten(await entries('wafer', b));
      expect(submitted?.mode === 'lot' && submitted?.group === a && target.length > 0 && other.length === 0, `Save target switched: ${JSON.stringify({ submitted, target, other })}`);
      expect(target.every(path => fileName(path).split('_')[0] === fileName(paths[0]).split('_')[0]), 'LOT save included unrelated LOT');
      const grid = await groupGrid('lot', a, target.length);
      return { delayed, submittedMode: submitted.mode, submittedGroup: submitted.group, saved: target.length, untouched: other.length, grid };
    }));

    await record('storage-partial-accounting', 'Real duplicate/valid/missing save reports every input and leaves valid images visible', async () => fixtures(async f => {
      const paths = await samples(3);
      const group = await f.group('wafer', 'partial');
      accepted(await save('wafer', group, [paths[0]]), 'Seed duplicate');
      const missing = `unknown/${prefix}_missing.png`;
      await openGrid([paths[0], paths[1]]);
      await selectGroup('wafer', group);
      // A stale selected path is a real missing-file condition; the server response is never mocked.
      await page.evaluate(missing => {
        window.viewer.currentGridImages = [...window.viewer.currentGridImages, missing];
        window.viewer._restoreGridSelectionFromSourceImages(window.viewer.currentGridImages.slice(0, 3));
      }, missing);
      const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/my-lot/batch');
      await page.locator('#my-lot-save-btn').click();
      const response = await responsePromise;
      const result = await response.json();
      await page.waitForFunction(() => [...document.body.children].some(element => element.style.zIndex === '10000'
        && element.innerText.startsWith('Wafer 이미지:')), null, { timeout: 12000 });
      const toast = await page.evaluate(() => [...document.body.children]
        .filter(element => element.style.position === 'fixed' && element.style.zIndex === '10000').map(element => element.innerText));
      const stored = flatten(await entries('wafer', group));
      const grid = await groupGrid('wafer', group, 2);
      expect(stored.length === 2 && stored.every(path => paths.slice(0, 2).some(source => fileName(source) === fileName(path))), 'Partial save corrupted stored images');
      expect(response.status() === 200 && result.success_count === 1 && result.duplicate_count === 1 && result.error_count === 1,
        `Every selected input needs an outcome: ${JSON.stringify({ result, toast, stored })}`);
      expect(toast.some(text => text.includes('1개 저장') && text.includes('1개 중복') && text.includes('1개 실패')), `Partial-save toast omitted actual result: ${JSON.stringify(toast)}`);
      return { submitted: 3, result, toast, grid };
    }));

    await record('storage-user-isolation', 'Two browser users with same group name keep independent files, reload state and UI scope', async () => {
      const context = await page.context().browser().newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 } });
      const second = await context.newPage();
      const otherLogin = `e2ext_other_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      try {
        return await fixtures(async f => {
          const paths = await samples(3);
          await boot({ page: second, loginId: otherLogin });
          const a = await f.group('wafer', 'shared');
          const b = await f.group('wafer', 'shared', second, otherLogin);
          accepted(await save('wafer', a, [paths[0]], page, loginId), 'User A save');
          accepted(await save('wafer', b, [paths[1]], second, otherLogin), 'User B save');
          await second.reload({ waitUntil: 'domcontentloaded' });
          await boot({ page: second, loginId: otherLogin });
          const left = await groupGrid('wafer', a, 1);
          const right = await groupGrid('wafer', b, 1, second);
          const actualA = await page.evaluate(() => window.viewer.getCurrentLoginId());
          const actualB = await second.evaluate(() => window.viewer.getCurrentLoginId());
          expect(actualA === loginId && actualB === otherLogin, `Browser identities ${actualA}/${actualB}`);
          expect(left.paths[0].startsWith(`my-lot/${loginId}/`) && right.paths[0].startsWith(`my-lot/${otherLogin}/`), 'User image paths crossed ownership');
          expect(fileName(left.paths[0]) === fileName(paths[0]) && fileName(right.paths[0]) === fileName(paths[1]), 'One browser overwrote the other user group');
          const leftImage = await openSingle(left.paths[0]);
          const rightImage = await openSingle(right.paths[0], second);
          expect(left.scope === `my-lot/${loginId}/wafer/${a}` && right.scope === `my-lot/${otherLogin}/wafer/${b}`,
            `Visible MY LOT scope belongs to another login: ${JSON.stringify({ left: left.scope, right: right.scope })}`);
          return { users: [actualA, actualB], left, right, leftImage, rightImage };
        });
      } finally { await context.close(); }
    });

    await record('storage-save-rename-delete', 'Overlapping real save/rename/delete leaves one coherent image and positions state', async () => fixtures(async f => {
      const paths = await samples(10);
      const group = await f.group('wafer', 'race');
      const renamed = `${group}_renamed`;
      const batch = save('wafer', group, paths.slice(0, 8));
      ownedGroup('wafer', group);
      const rename = api('/api/my-lot/group/rename', { method: 'PUT', body: { mode: 'wafer', old_name: group, new_name: renamed } });
      const [saved, moved] = await Promise.all([batch, rename]);
      if (moved.status === 200) f.ownRenamedGroup('wafer', renamed);
      accepted(saved, 'Concurrent batch save');
      accepted(moved, 'Concurrent rename');
      const oldPaths = flatten(await entries('wafer', group));
      const newPaths = flatten(await entries('wafer', renamed));
      expect(oldPaths.length + newPaths.length === 8 && (oldPaths.length === 0 || newPaths.length === 0),
        `Save/rename split data between groups: ${JSON.stringify({ oldPaths, newPaths })}`);
      const winner = oldPaths.length ? group : renamed;
      const surviving = oldPaths.length ? oldPaths : newPaths;
      const grid = await groupGrid('wafer', winner, 8);
      const image = await openSingle(surviving[0]);
      expect(image.chipCount > 0, 'Save/rename published image without coordinates');
      ownedGroup('wafer', winner);
      const secondBatch = save('wafer', winner, [paths[8]]);
      const deletion = api('/api/my-lot/group', { method: 'DELETE', body: { mode: 'wafer', group: winner } });
      const [added, deleted] = await Promise.all([secondBatch, deletion]);
      accepted(added, 'Save overlapping delete');
      accepted(deleted, 'Delete overlapping save');
      const finalPaths = flatten(await entries('wafer', winner));
      expect(finalPaths.length <= 1 && finalPaths.every(path => fileName(path) === fileName(paths[8])), `Delete left partial old batch: ${JSON.stringify(finalPaths)}`);
      let finalView;
      if (finalPaths.length) {
        finalView = await openSingle(finalPaths[0]);
        expect(finalView.chipCount > 0, 'Recreated group lost copied positions');
      } else {
        finalView = await openSingle(paths[8]);
      }
      return { batch: saved.data, renameStatus: moved.status, winner, oldCount: oldPaths.length, newCount: newPaths.length,
        grid, image, secondBatch: added.data, deleteStatus: deleted.status, finalCount: finalPaths.length, finalView };
    }));
  } finally { await finish(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
