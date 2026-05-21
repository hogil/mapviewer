const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');

const trackedBrowserProcesses = new Map();
let cleanupHandlersRegistered = false;

function removeFile(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function killProcessTree(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(Number(pid), 'SIGKILL');
    }
  } catch {
    // The process may already be gone.
  }
}

function cleanupTrackedBrowsersSync() {
  for (const [pid, pidFile] of trackedBrowserProcesses.entries()) {
    killProcessTree(pid);
    removeFile(pidFile);
  }
  trackedBrowserProcesses.clear();
}

function registerCleanupHandlers() {
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;
  process.once('exit', cleanupTrackedBrowsersSync);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      cleanupTrackedBrowsersSync();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

function registerBrowserPid(browser, pidFile) {
  const browserProcess =
    browser && typeof browser.process === 'function' ? browser.process() : null;
  let pid = browserProcess && browserProcess.pid ? Number(browserProcess.pid) : 0;
  if (!(pid > 0)) {
    pid = findBrowserChildPid();
  }
  if (pid > 0) {
    fs.writeFileSync(pidFile, String(pid), 'ascii');
    trackedBrowserProcesses.set(pid, pidFile);
  }
  return pid;
}

function findBrowserChildPid() {
  try {
    if (process.platform === 'win32') {
      const script = [
        '$p = Get-CimInstance Win32_Process | Where-Object {',
        ('  $_.ParentProcessId -eq {0} -and' ).replace('{0}', String(process.pid)),
        '  $_.Name -in @("chrome.exe","chromium.exe","chrome-headless-shell.exe","chromium-headless-shell.exe")',
        '} | Select-Object -First 1 -ExpandProperty ProcessId;',
        'if ($p) { Write-Output $p }',
      ].join(' ');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      if (result.error || result.status === null) {
        return 0;
      }
      const pid = Number.parseInt(String(result.stdout || '').trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : 0;
    }
  } catch {
    // Fall through to unknown PID.
  }
  return 0;
}

function unregisterBrowserPid(pid, pidFile) {
  if (pid > 0) {
    trackedBrowserProcesses.delete(pid);
  }
  removeFile(pidFile);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeBrowserResources({ context, browser, browserPid, browserPidFile, append }) {
  let hadCloseError = false;
  try {
    if (context) {
      await withTimeout(context.close(), 5000, 'context.close');
    }
  } catch (error) {
    hadCloseError = true;
    append?.(`[BROWSER] context close failed: ${error.message || error}\n`);
  }

  try {
    if (browser) {
      await withTimeout(browser.close(), 5000, 'browser.close');
    }
  } catch (error) {
    hadCloseError = true;
    append?.(`[BROWSER] browser close failed: ${error.message || error}\n`);
  }

  if (hadCloseError && browserPid > 0) {
    append?.(`[BROWSER] killing browser process tree pid=${browserPid}\n`);
    killProcessTree(browserPid);
  }
  unregisterBrowserPid(browserPid, browserPidFile);
}

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

async function launchSession({ headless, outputDir, progressFile, browserPidFile }) {
  registerCleanupHandlers();
  const attempts = headless ? 1 : readInt('E2E_BROWSER_SESSION_ATTEMPTS', 3);
  const append = (line) => fs.appendFileSync(progressFile, line, 'utf8');
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let browser = null;
    let context = null;
    let browserPid = 0;
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
      browserPid = registerBrowserPid(browser, browserPidFile);
      if (browserPid > 0) {
        append(`[BROWSER] pid=${browserPid} pidFile=${browserPidFile}\n`);
      }
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
      return { browser, context, page, browserPid };
    } catch (error) {
      lastError = error;
      append(`[BROWSER] launch failed attempt=${attempt}: ${error.message || error}\n`);
      await closeBrowserResources({ context, browser, browserPid, browserPidFile, append });
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
  const tmpRoot = path.resolve(__dirname, '..', '.codex-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const browserPidFile = path.join(
    tmpRoot,
    `e2e-browser-${sessionId}-${scriptName}-${process.pid}.pid`
  );
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

  const { browser, context, page, browserPid } = await launchSession({
    headless,
    outputDir,
    progressFile,
    browserPidFile,
  });
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
  let closeStarted = false;
  const close = async () => {
    if (closeStarted) return;
    closeStarted = true;
    await closeBrowserResources({ context, browser, browserPid, browserPidFile, append });
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
