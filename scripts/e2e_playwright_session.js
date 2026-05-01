const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function readBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function readInt(name, fallback) {
  const raw = process.env[name];
  const value = Number.parseInt(raw || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function defaultSessionId() {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  return `${iso}-${process.pid}`;
}

async function ensureHeadfulWindow(page, append) {
  try {
    await page.bringToFront();
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        windowState: 'normal',
        left: 40,
        top: 40,
        width: 1920,
        height: 1080,
      },
    });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'maximized' },
    });
    const visibility = await page.evaluate(() => document.visibilityState).catch(() => 'unknown');
    append?.(`[BROWSER] headful window visibility=${visibility}\n`);
    if (visibility !== 'visible') {
      throw new Error(`headful page visibility=${visibility}`);
    }
  } catch (error) {
    append?.(`[BROWSER] headful window verify failed: ${error.message || error}\n`);
    throw error;
  }
}

async function launchSession({ headless, outputDir, progressFile }) {
  const attempts = headless ? 1 : readInt('E2E_BROWSER_SESSION_ATTEMPTS', 3);
  const append = (line) => fs.appendFileSync(progressFile, line, 'utf8');
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let browser = null;
    let context = null;
    try {
      append(`[BROWSER] launch attempt=${attempt}/${attempts} headless=${headless ? 1 : 0}\n`);
      browser = await chromium.launch({
        headless,
        args: [
          '--window-size=1920,1080',
          '--window-position=40,40',
          '--start-maximized',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
        ],
      });
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1920, height: 1080 },
        acceptDownloads: true,
        locale: 'ko-KR',
      });
      const page = await context.newPage();
      if (!headless) {
        await ensureHeadfulWindow(page, append);
      }
      append(`[BROWSER] launch ok attempt=${attempt}\n`);
      return { browser, context, page };
    } catch (error) {
      lastError = error;
      append(`[BROWSER] launch failed attempt=${attempt}: ${error.message || error}\n`);
      try {
        if (context) await context.close();
      } catch {
        // ignore cleanup errors between attempts
      }
      try {
        if (browser) await browser.close();
      } catch {
        // ignore cleanup errors between attempts
      }
    }
  }

  throw lastError || new Error('Playwright browser launch failed');
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

  const { browser, context, page } = await launchSession({ headless, outputDir, progressFile });
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
