const { createRunner } = require('./e2e_playwright_session');

const FORBIDDEN_SNIPPETS = [
  'python3-saml 라이브러리가 설치되지 않았습니다',
  'pip install python3-saml',
  'python-saml3',
  'lxml & xmlsec libxml2 library version mismatch',
  'full app is still warming up',
];

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

(async () => {
  const loginTimeoutMs = Number(process.env.E2E_SAML_LOGIN_TIMEOUT_MS || 8000);
  const maxLoginMs = Number(process.env.E2E_SAML_LOGIN_MAX_MS || 5000);
  const {
    base,
    page,
    expect,
    append,
    focusWindow,
    close,
  } = await createRunner(__filename);
  let finalExitCode = 0;

  try {
    const stamp = Date.now();
    const expectAutoLoginRedirect = process.env.E2E_EXPECT_AUTO_LOGIN_REDIRECT === '1';
    let rootResponse;
    let rootMs;
    let title = '';

    if (expectAutoLoginRedirect) {
      const rootUrl = `${base}/?saml-bootstrap-smoke=${stamp}`;
      append(`[SAML_BOOTSTRAP] request root redirect ${rootUrl}\n`);
      const rootStartedAt = Date.now();
      rootResponse = await page.request.get(rootUrl, {
        maxRedirects: 0,
        timeout: 8000,
      });
      rootMs = Date.now() - rootStartedAt;
      const rootStatus = rootResponse.status();
      const location = rootResponse.headers().location || '';
      expect(rootStatus === 302 || rootStatus === 307, `root redirect status=${rootStatus}`);
      expect(location.startsWith('/saml/login'), `root redirect location=${location}`);
    } else {
      append(`[SAML_BOOTSTRAP] goto ${base}\n`);
      const rootStartedAt = Date.now();
      rootResponse = await page.goto(`${base}/?saml-bootstrap-smoke=${stamp}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      rootMs = Date.now() - rootStartedAt;
      await focusWindow();
      title = await page.title();
      expect(title === 'Wafer Map Viewer', `title=${title}`);
    }

    const loginUrl = `${base}/saml/login?e2e_saml_bootstrap=${stamp}`;
    append(`[SAML_BOOTSTRAP] request ${loginUrl}\n`);
    const loginStartedAt = Date.now();
    const loginResponse = await page.request.get(loginUrl, {
      maxRedirects: 0,
      timeout: loginTimeoutMs,
    });
    const loginMs = Date.now() - loginStartedAt;
    const loginStatus = loginResponse.status();
    const loginBody = await loginResponse.text().catch(() => '');
    const loginBodyCompact = compact(loginBody);
    const lowerBody = loginBody.toLowerCase();
    const forbiddenHit = FORBIDDEN_SNIPPETS.find((snippet) =>
      lowerBody.includes(snippet.toLowerCase())
    );

    if (!expectAutoLoginRedirect) {
      expect(rootResponse && rootResponse.status() === 200, `root status=${rootResponse?.status()}`);
    }
    expect(!forbiddenHit, `forbidden SAML bootstrap text=${forbiddenHit} body=${loginBodyCompact}`);
    expect(loginStatus !== 503, `saml login returned 503 body=${loginBodyCompact}`);
    expect(loginMs <= maxLoginMs, `saml login too slow ${loginMs}ms > ${maxLoginMs}ms`);

    const result = {
      status: 'PASS',
      rootStatus: rootResponse.status(),
      rootMs,
      title,
      expectAutoLoginRedirect,
      loginStatus,
      loginMs,
      loginBody: loginBodyCompact,
    };
    console.log(JSON.stringify(result, null, 2));
    append(`[PASS] saml-bootstrap SAML login immediate :: ${JSON.stringify(result)}\n`);
    append('[DONE] total=1\n');
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    console.error(detail);
    append(`[FAIL] saml-bootstrap SAML login immediate :: ${detail}\n`);
    finalExitCode = 2;
  } finally {
    await close();
  }

  process.exit(finalExitCode);
})();
