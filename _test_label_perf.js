const { chromium } = require('playwright');

(async () => {
  const PORT = 9028;
  const BASE = `https://localhost:${PORT}`;

  const browser = await chromium.launch({
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1920,1080']
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();

  const T = {};
  const log = (msg) => console.log(msg);

  log('=== Label Explorer Performance Test ===\n');

  // 1. Page load
  let t0 = Date.now();
  await page.goto(BASE);
  await page.waitForTimeout(5000);
  T.page_load = Date.now() - t0;
  log(`1. Page load: ${T.page_load}ms`);

  // 2. Dump DOM structure of file list and label explorer
  const domInfo = await page.evaluate(() => {
    const fileList = document.getElementById('file-list');
    const labelExplorer = document.getElementById('label-explorer-list');

    const getChildInfo = (el, depth = 0) => {
      if (!el || depth > 2) return [];
      const results = [];
      for (const child of el.children) {
        results.push({
          tag: child.tagName,
          cls: child.className?.substring(0, 60),
          text: child.textContent?.trim().substring(0, 40),
          childCount: child.children.length,
          onclick: !!child.onclick,
          dataAttrs: Object.keys(child.dataset || {}).join(',')
        });
      }
      return results;
    };

    return {
      fileList: fileList ? {
        childCount: fileList.children.length,
        children: getChildInfo(fileList)
      } : 'NOT FOUND',
      labelExplorer: labelExplorer ? {
        visible: labelExplorer.offsetParent !== null,
        childCount: labelExplorer.children.length,
        children: getChildInfo(labelExplorer)
      } : 'NOT FOUND'
    };
  });

  log('\n2. DOM Structure:');
  log(`  file-list: ${JSON.stringify(domInfo.fileList?.childCount || 0)} children`);
  if (domInfo.fileList?.children) {
    for (const c of domInfo.fileList.children.slice(0, 5)) {
      log(`    <${c.tag} class="${c.cls}"> text="${c.text}" children=${c.childCount} data=[${c.dataAttrs}]`);
    }
  }

  log(`  label-explorer-list: visible=${domInfo.labelExplorer?.visible}, ${domInfo.labelExplorer?.childCount} children`);
  if (domInfo.labelExplorer?.children) {
    for (const c of domInfo.labelExplorer.children.slice(0, 8)) {
      log(`    <${c.tag} class="${c.cls}"> text="${c.text}" children=${c.childCount} data=[${c.dataAttrs}]`);
    }
  }

  // 3. Click first folder in file-list
  const firstFolder = page.locator('#file-list > *').first();
  const folderExists = await firstFolder.count() > 0;
  if (folderExists) {
    const folderText = await firstFolder.textContent().catch(() => '');
    log(`\n3. Clicking folder: "${folderText.trim().substring(0, 30)}"`);
    t0 = Date.now();
    await firstFolder.click();
    await page.waitForTimeout(4000);
    T.folder_click = Date.now() - t0;
    log(`   Folder click time: ${T.folder_click}ms`);
    await page.screenshot({ path: 'lp_02_folder.png' });

    // Check for grid images
    const gridCount = await page.evaluate(() => {
      const grid = document.getElementById('image-grid');
      if (!grid) return 0;
      return grid.querySelectorAll('img, .grid-item, button').length;
    });
    log(`   Grid items after click: ${gridCount}`);

    // If images, click first one
    if (gridCount > 0) {
      t0 = Date.now();
      await page.locator('#image-grid img, #image-grid button').first().dblclick();
      await page.waitForTimeout(4000);
      T.single_image = Date.now() - t0;
      log(`4. Single image load: ${T.single_image}ms`);
      await page.screenshot({ path: 'lp_03_single.png' });
    }
  }

  // 4. API Performance
  log('\n=== API Performance ===');
  const apiPerf = await page.evaluate(async () => {
    const r = {};

    // /api/classes
    let s = performance.now();
    const cr = await fetch('/api/classes');
    const cd = await cr.json();
    r.classes_ms = Math.round(performance.now() - s);
    r.classes = cd.classes || [];

    if (r.classes.length === 0) return r;

    r.details = [];
    for (const cls of r.classes.slice(0, 3)) {
      const d = { name: cls };

      s = performance.now();
      const fr = await fetch(`/api/files?path=classification/${cls}`);
      const fd = await fr.json();
      d.files_ms = Math.round(performance.now() - s);
      d.count = (fd.items || []).length;

      if (d.count > 0) {
        const img = fd.items[0].name;
        const p = `classification/${cls}/${img}`;

        // Thumbnail
        s = performance.now();
        const tr = await fetch(`/api/thumbnail?path=${encodeURIComponent(p)}&size=128`);
        if (tr.ok) {
          const b = await tr.blob();
          d.thumb_ms = Math.round(performance.now() - s);
          d.thumb_kb = Math.round(b.size / 1024);
        } else { d.thumb_err = tr.status; }

        // Image pyramid
        s = performance.now();
        const ir = await fetch(`/api/image?path=${encodeURIComponent(p)}&level=0.5`);
        if (ir.ok) {
          const b = await ir.blob();
          d.img_ms = Math.round(performance.now() - s);
          d.img_kb = Math.round(b.size / 1024);
          const h = {};
          ir.headers.forEach((v, k) => { if (k.startsWith('x-')) h[k] = v; });
          d.headers = h;
        } else { d.img_err = ir.status; }

        // Image/size
        s = performance.now();
        const sr = await fetch(`/api/image/size?path=${encodeURIComponent(p)}`);
        if (sr.ok) {
          const sd = await sr.json();
          d.size_ms = Math.round(performance.now() - s);
          d.dim = `${sd.width}x${sd.height}`;
        }
      }
      r.details.push(d);
    }
    return r;
  });

  log(`  /api/classes: ${apiPerf.classes_ms}ms → ${apiPerf.classes.length} classes`);
  log(`  Classes: [${apiPerf.classes.join(', ')}]`);

  if (apiPerf.details) {
    for (const d of apiPerf.details) {
      log(`\n  "${d.name}" (${d.count} images):`);
      log(`    files: ${d.files_ms}ms`);
      if (d.thumb_ms != null) log(`    thumb: ${d.thumb_ms}ms (${d.thumb_kb}KB)`);
      if (d.thumb_err) log(`    thumb: ERR ${d.thumb_err}`);
      if (d.img_ms != null) log(`    image(0.5): ${d.img_ms}ms (${d.img_kb}KB) ${JSON.stringify(d.headers)}`);
      if (d.img_err) log(`    image: ERR ${d.img_err}`);
      if (d.dim) log(`    size: ${d.dim} (${d.size_ms}ms)`);
    }
  }

  // 5. Label Explorer UI test
  log('\n=== Label Explorer UI Test ===');

  // Click first class in Label Explorer
  const leChildren = page.locator('#label-explorer-list > div');
  const leCount = await leChildren.count();
  log(`  Label Explorer items: ${leCount}`);

  if (leCount > 0) {
    // Get class name from first item
    const firstClassText = await leChildren.first().textContent().catch(() => '');
    log(`  First item text: "${firstClassText.trim().substring(0, 40)}"`);

    // Click to expand
    t0 = Date.now();
    await leChildren.first().click();
    await page.waitForTimeout(3000);
    T.le_expand = Date.now() - t0;
    log(`  Expand click: ${T.le_expand}ms`);
    await page.screenshot({ path: 'lp_04_le_expand.png' });

    // Check expanded content
    const expandedInfo = await page.evaluate(() => {
      const le = document.getElementById('label-explorer-list');
      if (!le) return { error: 'not found' };
      const imgs = le.querySelectorAll('img');
      const btns = le.querySelectorAll('button');
      return { imgCount: imgs.length, btnCount: btns.length };
    });
    log(`  After expand: ${expandedInfo.imgCount} imgs, ${expandedInfo.btnCount} buttons`);

    // If images, click first label image
    if (expandedInfo.imgCount > 0 || expandedInfo.btnCount > 1) {
      const labelImgBtn = page.locator('#label-explorer-list button img, #label-explorer-list img').first();
      if (await labelImgBtn.count() > 0) {
        t0 = Date.now();
        await labelImgBtn.click();
        await page.waitForTimeout(5000);
        T.le_img_load = Date.now() - t0;
        log(`  Label image click→load: ${T.le_img_load}ms`);
        await page.screenshot({ path: 'lp_05_le_image.png' });
      }
    }
  }

  // Summary
  log('\n=== TIMING SUMMARY ===');
  for (const [k, v] of Object.entries(T)) {
    const icon = v > 5000 ? '🐌' : v > 2000 ? '⚠️' : '✅';
    log(`  ${icon} ${k}: ${v}ms`);
  }

  log('\nBrowser open 8s for inspection...');
  await page.waitForTimeout(8000);
  await browser.close();
})();
