const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function readBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function defaultSessionId() {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `${iso}-${process.pid}`;
}

async function createRunner(scriptFile) {
  const scriptName = path.basename(scriptFile, path.extname(scriptFile));
  const sessionId = process.env.E2E_SESSION_ID || defaultSessionId();
  const base = process.env.E2E_BASE_URL || 'https://127.0.0.1:8443';
  const headless = readBool('E2E_HEADLESS', false);
  const outputDir = path.resolve(
    process.env.E2E_OUTPUT_DIR ||
      path.join(__dirname, '..', '.codex-tmp', 'e2e-sessions', sessionId)
  );
  fs.mkdirSync(outputDir, { recursive: true });

  const progressFile =
    process.env.E2E_PROGRESS_FILE ||
    path.join(outputDir, `${scriptName}.progress.log`);
  fs.writeFileSync(progressFile, '', 'utf8');

  const metaPath = path.join(outputDir, `${scriptName}.meta.json`);
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        scriptName,
        sessionId,
        base,
        headless,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );

  const browser = await chromium.launch({
    headless,
    args: [
      '--window-size=1920,1080',
      '--window-position=40,40',
      '--start-maximized',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true,
    locale: 'ko-KR',
  });
  const page = await context.newPage();
  const results = [];
  const focusWindow = async () => {
    try {
      await page.bringToFront();
      await page.evaluate(() => {
        if (typeof window.focus === 'function') {
          window.focus();
        }
      });
    } catch {
      // Best-effort only. Some environments refuse focus-stealing.
    }
  };

  await focusWindow();

  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const sleep = (ms) => page.waitForTimeout(ms);
  const append = (line) => fs.appendFileSync(progressFile, line, 'utf8');
  const close = async () => {
    await context.close();
    await browser.close();
  };

  return {
    base,
    sessionId,
    outputDir,
    progressFile,
    browser,
    context,
    page,
    results,
    expect,
    sleep,
    append,
    focusWindow,
    close,
  };
}

module.exports = {
  createRunner,
};
