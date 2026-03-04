/**
 * ╔══════════════════════════════════════╗
 * ║        PROXY BROWSER v3.0            ║
 * ║  Strips X-Frame-Options/CSP on fly   ║
 * ╚══════════════════════════════════════╝
 *
 * node proxy-browser.js
 */

const puppeteer = require('puppeteer');
const http      = require('http');
const https     = require('https');
const { URL }   = require('url');

const PROXY_PORT = 8765;

// ─────────────────────────────────────────────────────────────────────────────
//  LOCAL PROXY SERVER
// ─────────────────────────────────────────────────────────────────────────────
const proxyServer = http.createServer((req, res) => {
  let targetUrl;
  try {
    targetUrl = decodeURIComponent(req.url.slice(1));
    if (!targetUrl.startsWith('http')) throw new Error('bad url');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request');
  }

  // Browser-like headers — servers hang up without a real User-Agent
  const baseHeaders = {
    'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language':           'en-US,en;q=0.9',
    'accept-encoding':           'identity',
    'user-agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'upgrade-insecure-requests': '1',
    'connection':                'keep-alive',
  };
  if (req.headers['cookie']) baseHeaders['cookie'] = req.headers['cookie'];

  function doRequest(url, hops) {
    if (hops > 10) {
      res.writeHead(508, { 'Content-Type': 'text/html' });
      return res.end(errPage('Too many redirects'));
    }

    let parsed;
    try { parsed = new URL(url); }
    catch {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      return res.end(errPage('Invalid URL: ' + url));
    }

    const lib  = parsed.protocol === 'https:' ? https : http;
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    const path = (parsed.pathname || '/') + (parsed.search || '');
    const hdrs = { ...baseHeaders, host: parsed.host };

    const proxyReq = lib.request(
      {
        hostname:           parsed.hostname,
        port,
        path,
        method:             'GET',
        headers:            hdrs,
        rejectUnauthorized: false,  // skip SSL cert validation
        timeout:            20000,
      },
      (proxyRes) => {
        const status = proxyRes.statusCode;

        // Transparently follow redirects
        if ([301, 302, 303, 307, 308].includes(status) && proxyRes.headers['location']) {
          const loc  = proxyRes.headers['location'];
          const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
          proxyRes.resume();
          return doRequest(next, hops + 1);
        }

        // Strip every header that blocks iframe embedding
        const out = { ...proxyRes.headers };
        delete out['x-frame-options'];
        delete out['content-security-policy'];
        delete out['content-security-policy-report-only'];
        delete out['cross-origin-opener-policy'];
        delete out['cross-origin-embedder-policy'];
        delete out['cross-origin-resource-policy'];
        out['access-control-allow-origin'] = '*';

        res.writeHead(status, out);
        proxyRes.pipe(res, { end: true });
      }
    );

    proxyReq.setTimeout(20000, () => proxyReq.destroy(new Error('Timed out')));
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end(errPage(err.message));
      }
    });
    proxyReq.end();
  }

  doRequest(targetUrl, 0);
});

function errPage(msg) {
  return `<html><body style="font-family:monospace;background:#0d0d12;color:#ff6b6b;padding:3rem">
    <h2>⚠ Proxy Error</h2><p style="color:#888;margin-top:1rem">${msg}</p></body></html>`;
}

proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`\n✓ Proxy server live → http://127.0.0.1:${PROXY_PORT}\n`);
  launchBrowser();
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUPPETEER SHELL
// ─────────────────────────────────────────────────────────────────────────────
async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const page = await browser.newPage();
  await page.goto('about:blank');

  await page.evaluate((PROXY_PORT) => {
    const proxyURL = (target) =>
      `http://127.0.0.1:${PROXY_PORT}/${encodeURIComponent(target)}`;

    let navHistory = [];
    let histIdx    = -1;

    const fontLink = document.createElement('link');
    fontLink.rel   = 'stylesheet';
    fontLink.href  = 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap';
    document.head.appendChild(fontLink);

    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
      :root {
        --bg:      #0d0d12; --surface: #17171f; --border: #2a2a38;
        --accent:  #7c6af7; --accent2: #f7826a;
        --text:    #e8e6f0; --muted:   #6b6880; --bar-h:  56px;
      }
      html,body { width:100%; height:100%; overflow:hidden; background:var(--bg); }
      #chrome {
        position:fixed; top:0; left:0; width:100%; height:var(--bar-h);
        background:var(--surface); border-bottom:1px solid var(--border);
        display:flex; align-items:center; gap:8px; padding:0 14px;
        z-index:2147483647; user-select:none;
      }
      .dots { display:flex; gap:6px; flex-shrink:0; }
      .dot  { width:12px; height:12px; border-radius:50%; cursor:pointer; transition:filter .15s; }
      .dot:hover { filter:brightness(1.4); }
      .dot.red { background:#ff5f57; } .dot.yel { background:#febc2e; } .dot.grn { background:#28c840; }
      .nav-btn {
        width:32px; height:32px; border-radius:8px; border:none;
        background:transparent; color:var(--muted); cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        font-size:16px; transition:background .15s, color .15s; flex-shrink:0;
      }
      .nav-btn:hover:not(:disabled) { background:var(--border); color:var(--text); }
      .nav-btn:disabled { opacity:.3; cursor:default; }
      #addr-wrap {
        flex:1; display:flex; align-items:center;
        background:var(--bg); border:1px solid var(--border);
        border-radius:10px; height:36px; overflow:hidden;
        transition:border-color .2s, box-shadow .2s;
      }
      #addr-wrap:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px rgba(124,106,247,.18); }
      #favicon { width:18px; height:18px; margin:0 8px; flex-shrink:0; object-fit:contain; opacity:0; transition:opacity .2s; }
      #addr {
        flex:1; background:transparent; border:none; outline:none;
        color:var(--text); font-family:'DM Mono',monospace; font-size:13px; padding-right:10px;
      }
      #addr::selection { background:rgba(124,106,247,.35); }
      #load-bar {
        position:fixed; top:var(--bar-h); left:0; height:2px;
        background:linear-gradient(90deg, var(--accent), var(--accent2));
        width:0%; z-index:2147483646; opacity:0; transition:opacity .4s;
      }
      #load-bar.loading { opacity:1; animation:indeterminate 1.4s ease infinite; }
      @keyframes indeterminate {
        0%  { width:0%;  margin-left:0; }
        50% { width:60%; margin-left:20%; }
        100%{ width:10%; margin-left:100%; }
      }
      #load-bar.done { width:100%; opacity:0; }
      #status-badge {
        font-family:'DM Mono',monospace; font-size:11px; color:var(--muted);
        padding:4px 10px; border-radius:6px; background:var(--bg);
        border:1px solid var(--border); white-space:nowrap; flex-shrink:0;
        min-width:70px; text-align:center; transition:color .3s;
      }
      #status-badge.ok   { color:#28c840; border-color:rgba(40,200,64,.3); }
      #status-badge.err  { color:#ff5f57; border-color:rgba(255,95,87,.3); }
      #status-badge.load { color:var(--accent); border-color:rgba(124,106,247,.3); }
      #viewer {
        position:fixed; top:var(--bar-h); left:0;
        width:100vw; height:calc(100vh - var(--bar-h));
        border:none; background:#fff; transition:opacity .3s;
      }
      #start {
        position:fixed; top:var(--bar-h); left:0;
        width:100vw; height:calc(100vh - var(--bar-h));
        background:var(--bg); display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:16px; z-index:100; transition:opacity .4s;
      }
      #start h1 {
        font-family:'Syne',sans-serif; font-size:48px; font-weight:800;
        background:linear-gradient(135deg, var(--accent), var(--accent2));
        -webkit-background-clip:text; -webkit-text-fill-color:transparent; letter-spacing:-1px;
      }
      #start p { color:var(--muted); font-family:'DM Mono',monospace; font-size:13px; }
      .quick-links { display:flex; gap:12px; flex-wrap:wrap; justify-content:center; margin-top:8px; }
      .ql {
        padding:8px 16px; border-radius:8px; border:1px solid var(--border);
        background:var(--surface); color:var(--text); cursor:pointer;
        font-family:'DM Mono',monospace; font-size:12px;
        transition:border-color .2s, background .2s; text-decoration:none;
      }
      .ql:hover { border-color:var(--accent); background:rgba(124,106,247,.08); }
      #err-overlay {
        display:none; position:fixed; top:var(--bar-h); left:0;
        width:100vw; height:calc(100vh - var(--bar-h));
        background:var(--bg); z-index:99;
        align-items:center; justify-content:center; flex-direction:column; gap:12px;
      }
      #err-overlay.show { display:flex; }
      #err-overlay h2 { font-family:'Syne',sans-serif; color:#ff5f57; font-size:28px; }
      #err-overlay p  { font-family:'DM Mono',monospace; color:var(--muted); font-size:13px; max-width:420px; text-align:center; }
    `;
    document.head.appendChild(style);

    document.body.innerHTML = `
      <div id="load-bar"></div>
      <div id="chrome">
        <div class="dots">
          <div class="dot red" title="Close" onclick="window.close()"></div>
          <div class="dot yel"></div>
          <div class="dot grn"></div>
        </div>
        <button class="nav-btn" id="btn-back"    disabled>&#8592;</button>
        <button class="nav-btn" id="btn-fwd"     disabled>&#8594;</button>
        <button class="nav-btn" id="btn-refresh">&#8635;</button>
        <div id="addr-wrap">
          <img id="favicon" src="">
          <input id="addr" placeholder="Enter a URL or search term…" spellcheck="false" autocomplete="off">
        </div>
        <div id="status-badge">ready</div>
      </div>
      <iframe id="viewer" style="opacity:0"></iframe>
      <div id="start">
        <h1>Proxy Browser</h1>
        <p>All sites load — X-Frame-Options & CSP stripped at proxy level</p>
        <div class="quick-links">
          <a class="ql" data-url="https://wikipedia.org">Wikipedia</a>
          <a class="ql" data-url="https://news.ycombinator.com">Hacker News</a>
          <a class="ql" data-url="https://github.com">GitHub</a>
          <a class="ql" data-url="https://reddit.com">Reddit</a>
          <a class="ql" data-url="https://example.com">Example.com</a>
        </div>
      </div>
      <div id="err-overlay">
        <h2>⚠ Can't reach this page</h2>
        <p>The proxy couldn't connect. Check the URL and try again.</p>
        <button class="ql" onclick="document.getElementById('err-overlay').classList.remove('show')">← Go Back</button>
      </div>
    `;
    document.body.style.margin = '0';

    const frame       = document.getElementById('viewer');
    const addrInput   = document.getElementById('addr');
    const loadBar     = document.getElementById('load-bar');
    const statusBadge = document.getElementById('status-badge');
    const btnBack     = document.getElementById('btn-back');
    const btnFwd      = document.getElementById('btn-fwd');
    const btnRefresh  = document.getElementById('btn-refresh');
    const favicon     = document.getElementById('favicon');
    const startScreen = document.getElementById('start');
    const errOverlay  = document.getElementById('err-overlay');

    function updateNavButtons() {
      btnBack.disabled = histIdx <= 0;
      btnFwd.disabled  = histIdx >= navHistory.length - 1;
    }

    function navigate(rawUrl, push = true) {
      errOverlay.classList.remove('show');
      let target = rawUrl.trim();
      if (!target) return;
      if (!/^https?:\/\//i.test(target)) {
        target = /^[\w-]+(\.[a-z]{2,})+/.test(target)
          ? 'https://' + target
          : 'https://www.google.com/search?q=' + encodeURIComponent(target);
      }
      if (push && navHistory[histIdx] !== target) {
        navHistory = navHistory.slice(0, histIdx + 1);
        navHistory.push(target);
        histIdx = navHistory.length - 1;
      }
      updateNavButtons();
      addrInput.value = target;
      addrInput.blur();

      startScreen.style.opacity = '0';
      setTimeout(() => { startScreen.style.display = 'none'; }, 400);
      loadBar.className = 'loading';
      statusBadge.textContent = 'loading…';
      statusBadge.className = 'load';
      frame.style.opacity = '0.4';

      try {
        const u = new URL(target);
        favicon.src = `https://www.google.com/s2/favicons?sz=32&domain=${u.hostname}`;
        favicon.style.opacity = '1';
      } catch { favicon.style.opacity = '0'; }

      frame.src = proxyURL(target);
    }

    frame.addEventListener('load', () => {
      loadBar.className = 'done';
      frame.style.opacity = '1';
      statusBadge.textContent = '200 OK';
      statusBadge.className = 'ok';
      setTimeout(() => { loadBar.className = ''; }, 600);
    });
    frame.addEventListener('error', () => {
      loadBar.className = '';
      statusBadge.textContent = 'error';
      statusBadge.className = 'err';
      errOverlay.classList.add('show');
    });

    addrInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(addrInput.value); });
    addrInput.addEventListener('focus', () => addrInput.select());

    btnBack.addEventListener('click', () => { if (histIdx > 0) { histIdx--; navigate(navHistory[histIdx], false); } });
    btnFwd.addEventListener('click',  () => { if (histIdx < navHistory.length - 1) { histIdx++; navigate(navHistory[histIdx], false); } });
    btnRefresh.addEventListener('click', () => { const s = frame.src; frame.src = ''; frame.src = s; });

    document.querySelectorAll('.ql[data-url]').forEach(el =>
      el.addEventListener('click', () => navigate(el.dataset.url))
    );
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); addrInput.focus(); }
    });

    updateNavButtons();
  }, PROXY_PORT);
}