const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ 
    headless: false,
    args: ['--ignore-certificate-errors', '--window-size=1920,1080']
  });
  const context = await browser.newContext({ 
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true 
  });
  const page = await context.newPage();
  
  console.log('1. Navigate');
  await page.goto('https://localhost:7443');
  await page.waitForTimeout(3000);
  
  console.log('2. MY LOT');
  await page.getByRole('button', { name: 'MY LOT' }).click();
  await page.waitForTimeout(1000);
  
  console.log('3. Select test_mc');
  await page.locator('#my-lot-group-select').selectOption('test_mc');
  await page.waitForTimeout(2000);
  
  console.log('4. Select all');
  await page.locator('#my-lot-select-all').click();
  await page.waitForTimeout(500);
  
  console.log('5. Grid view');
  await page.locator('#my-lot-grid-view').click();
  await page.waitForTimeout(6000);
  
  await page.screenshot({ path: 'mylot-test-grid-col6.jpeg', quality: 90, type: 'jpeg' });
  console.log('   Grid screenshot saved');

  console.log('6. Select all grid');
  await page.locator('button:has-text("전체선택")').click();
  await page.waitForTimeout(1000);
  
  console.log('7. Open M.Comp');
  await page.locator('#measure-composite-btn-top').click();
  await page.waitForTimeout(3000);
  
  const panel = page.locator('#mc-panel');
  const vis = await panel.isVisible();
  console.log(`   Panel visible: ${vis}`);
  if (!vis) { console.log('FAIL: panel not visible'); await browser.close(); return; }
  
  const items = await panel.locator('.failbit-item').all();
  console.log(`   Items: ${items.length}`);
  
  let checked = 0;
  const targets = [];
  for (const item of items) {
    const text = (await item.textContent()).trim();
    const cb = item.locator('input[type="checkbox"]');
    if (await cb.count() === 0) continue;
    if (text === 'Failbit' && !targets.find(t => t.includes('Failbit'))) { targets.push(text); await item.click(); await page.waitForTimeout(200); checked++; }
    else if (text.match(/^BIN\d/) && !targets.find(t => t.match(/^BIN\d/))) { targets.push(text); await item.click(); await page.waitForTimeout(200); checked++; }
    else if (text.match(/^FBT/) && !targets.find(t => t.match(/^FBT/))) { targets.push(text); await item.click(); await page.waitForTimeout(200); checked++; }
    else if (text.match(/^QVL/) && !targets.find(t => t.match(/^QVL/))) { targets.push(text); await item.click(); await page.waitForTimeout(200); checked++; }
    if (checked >= 4) break;
  }
  console.log(`8. Checked: ${targets.join(', ')}`);
  
  const genBtn = panel.locator('.mc-generate-btn');
  console.log('9. Generate');
  await genBtn.click();
  
  console.log('10. Waiting 40s...');
  await page.waitForTimeout(40000);
  
  await page.screenshot({ path: 'mylot-test-composite.jpeg', quality: 90, type: 'jpeg' });
  console.log('11. Composite screenshot saved');
  
  // Check for alert dialogs
  const alertText = await page.evaluate(() => window._lastAlert || 'none');
  console.log(`   Alert: ${alertText}`);
  
  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
