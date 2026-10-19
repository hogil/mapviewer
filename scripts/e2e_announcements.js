const fs = require('fs');
const path = require('path');
const { createRunner } = require('./e2e_playwright_session');
(async () => {
  const { page, base, outputDir, append, expect, close } = await createRunner(__filename);
  const stamp = Date.now();
  const users = [`e2e-notice-a-${stamp}`, `e2e-notice-b-${stamp}`];
  const go = async user => {
    await page.goto(`${base}/?dev_success=true&LoginId=${user}&Username=NoticeTest`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.viewer?.announcementCenter && window.viewer.announcementCenter.items.length > 0, null, { timeout: 90000 });
  };
  try {
    await go(users[0]);
    const badge = page.locator('#announcements-count');
    if (!(await badge.isVisible())) {
      const items = await page.evaluate(() => window.viewer.announcementCenter.items);
      expect(items.every(item => item.read_by_default && item.read && item.seen), 'unseen notices missing badge');
      expect(items.some(item => item.title === 'test'), 'dummy notice title is not test');
      await page.locator('#announcements-button').click();
      await page.locator('.announcement-row').first().waitFor();
      expect(await page.locator('.announcement-row.unread').count() === 0, 'dummy notice highlighted unread');
      await page.locator('.announcement-row').first().click();
      await page.locator('.announcement-article').waitFor();
      await page.locator('#announcements-close').click();
      await go(users[1]);
      expect(!(await badge.isVisible()), 'second LoginId dummy notice is unread');
      const result = { status:'PASS', checks:['test title','dummy read for new LoginIds','no new-count badge','no unread highlight','detail accessible'], outputDir };
      fs.writeFileSync(path.join(outputDir,'announcements-summary.json'), JSON.stringify(result,null,2));
      append(`[PASS] announcements dummy defaults :: ${JSON.stringify(result)}\n[DONE] total=1\n`);
      console.log(JSON.stringify(result));
      return;
    }
    expect(await badge.isVisible(), 'new user missing announcement badge');
    await page.locator('#announcements-button').click();
    await page.locator('.announcement-row').first().waitFor();
    expect(!(await badge.isVisible()), 'opening list did not clear badge');
    expect(await page.locator('.announcement-row.unread').count() > 0, 'list opening marked details read');
    await page.screenshot({ path: path.join(outputDir, 'announcements-list.png') });
    await page.locator('#announcements-close').click();
    await go(users[0]);
    expect(!(await badge.isVisible()), 'seen badge returned after reload');
    await page.locator('#announcements-button').click();
    await page.locator('.announcement-row.unread').first().waitFor();
    const row = page.locator('.announcement-row.unread').first();
    const id = await row.getAttribute('data-notice-id');
    const title = await row.locator('h3').innerText();
    await row.click();
    await page.locator('.announcement-article').waitFor();
    expect(await page.locator('.announcement-article h3').innerText() === title, 'detail title mismatch');
    expect(await page.locator('.announcement-article p').count() > 0, 'detail paragraphs missing');
    await page.screenshot({ path: path.join(outputDir, 'announcements-detail.png') });
    await page.locator('.announcement-back').click();
    expect(!(await page.locator(`[data-notice-id="${id}"]`).getAttribute('class')).includes('unread'), 'read row still highlighted');
    await page.keyboard.press('Escape');
    expect(!(await page.locator('#announcements-dialog').isVisible()), 'Escape did not close dialog');
    await go(users[1]);
    expect(await badge.isVisible(), 'second LoginId inherited first user state');
    await page.locator('#announcements-button').click();
    await page.locator('.announcement-row.unread').first().waitFor();
    await page.setViewportSize({ width: 1280, height: 800 });
    const geometry = await page.locator('#announcements-dialog').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight, overflow:el.scrollWidth > el.clientWidth };
    });
    expect(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height && !geometry.overflow, `dialog overflow ${JSON.stringify(geometry)}`);
    await page.locator('#announcements-close').click();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await go(users[0]);
    await page.locator('#announcements-button').click();
    await page.locator('.announcement-row').first().waitFor();
    expect(!(await page.locator(`[data-notice-id="${id}"]`).getAttribute('class')).includes('unread'), 'read persistence failed');
    const result = { status:'PASS', checks:['badge dismissed on list open','unread highlight survives list open/reload','detail content','read highlight cleared','LoginId isolation','read persisted across reload','Escape closes','1280px no overflow'], outputDir };
    fs.writeFileSync(path.join(outputDir,'announcements-summary.json'),JSON.stringify(result,null,2));
    append(`[PASS] announcements list/detail state :: ${JSON.stringify(result)}\n[DONE] total=1\n`);
    console.log(JSON.stringify(result));
  } catch(error) {
    await page.screenshot({path:path.join(outputDir,'announcements-failure.png')}).catch(()=>{});
    append(`[FAIL] announcements ${error.stack}\n`);
    console.error(error);
    process.exitCode = 2;
  } finally { await close(); }
})();
