'use strict';

const http = require('node:http');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_FORM_BYTES = 64 * 1024;
const cspReportsByToken = new Map();
const RELAX_LOCAL_PROTECTED_FIXTURES =
  process.env.GLASSPEEK_RELAX_LOCAL_PROTECTED_FIXTURES === '1';

const ROUTES = Object.freeze([
  '/',
  '/healthz',
  '/embed',
  '/embed/child',
  '/deep/root',
  '/deep/level-1',
  '/deep/level-2',
  '/deep/xfo',
  '/deep/csp',
  '/deep/csp-report-only',
  '/deep/csp-report',
  '/deep/root-destination',
  '/xfo',
  '/xfo-sameorigin',
  '/csp',
  '/csp-self',
  '/redirect',
  '/spa',
  '/early-history',
  '/replace-result',
  '/slow',
  '/large-reader',
  '/form',
  '/form-result',
]);

const LIVE_SITE_LINKS = Object.freeze([
  {
    id: 'live-google-search',
    href: 'https://www.google.com/search?q=firefox',
    label: 'live Google search results',
  },
  {
    id: 'live-bing-search',
    href: 'https://www.bing.com/search?q=firefox',
    label: 'live Bing search results',
  },
  {
    id: 'live-duckduckgo-search',
    href: 'https://duckduckgo.com/?q=firefox',
    label: 'live DuckDuckGo search results',
  },
  {
    id: 'live-wikipedia',
    href: 'https://en.wikipedia.org/wiki/Firefox',
    label: 'live Wikipedia article',
  },
  {
    id: 'live-stack-overflow',
    href: 'https://stackoverflow.com/questions/16624919/why-iframe-dosent-work-for-yahoo-com',
    label: 'live Stack Overflow question',
  },
  {
    id: 'live-npm',
    href: 'https://www.npmjs.com/package/react',
    label: 'live npm package page',
  },
  {
    id: 'live-reddit',
    href: 'https://www.reddit.com/r/firefox/',
    label: 'live Reddit community',
  },
  {
    id: 'live-hacker-news',
    href: 'https://news.ycombinator.com/news',
    label: 'live Hacker News front page',
  },
  {
    id: 'live-amazon',
    href: 'https://www.amazon.com/s?k=firefox',
    label: 'live Amazon search results',
  },
  {
    id: 'live-taobao',
    href: 'https://item.taobao.com/item.htm?id=1000812607847',
    label: 'live Taobao item page',
  },
  {
    id: 'live-jd',
    href: 'https://item.jd.com/100012043978.html',
    label: 'live JD item page',
  },
  {
    id: 'live-bbc',
    href: 'https://www.bbc.com/news',
    label: 'live BBC News page',
  },
  {
    id: 'live-cnn',
    href: 'https://www.cnn.com/world',
    label: 'live CNN World page',
  },
  {
    id: 'live-bilibili',
    href: 'https://www.bilibili.com/video/BV1CHK46eEe7/',
    label: 'live Bilibili video page',
  },
  {
    id: 'live-youtube',
    href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    label: 'live YouTube video page',
  },
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title, body, script = '', headScript = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${headScript ? `<script>${headScript}</script>` : ''}
  <style>
    :root { color-scheme: light dark; font: 16px/1.55 system-ui, sans-serif; }
    body { max-width: 760px; margin: 48px auto; padding: 0 24px; }
    nav, .card { padding: 18px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; }
    nav { display: grid; gap: 8px; }
    button, input, textarea { font: inherit; padding: 8px 10px; }
    code, output { overflow-wrap: anywhere; }
    .marker { padding: 12px; border-left: 4px solid #3478f6; background: color-mix(in srgb, #3478f6 10%, Canvas); }
  </style>
</head>
<body>
${body}
<script>
document.addEventListener('click', (event) => {
  try { sessionStorage.setItem('glasspeek-last-click-trusted', String(event.isTrusted)); } catch (_error) {}
}, true);
</script>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

function send(res, status, headers, body = '') {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': payload.byteLength,
    ...headers,
  });
  res.end(payload);
}

function sendHtml(res, body, headers = {}, status = 200) {
  send(res, status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }, body);
}

function indexPage(port) {
  const links = [
    { href: '/embed#fragment-target', label: 'ordinary embeddable page + fragment' },
    {
      id: 'deep-root-link',
      href: '/deep/root',
      label: 'two- and three-level protected iframe tree',
    },
    { href: '/xfo', label: 'X-Frame-Options: DENY' },
    { href: '/xfo-sameorigin', label: 'X-Frame-Options: SAMEORIGIN' },
    { href: '/csp', label: "CSP frame-ancestors 'none'" },
    { href: '/csp-self', label: "CSP frame-ancestors 'self'" },
    { href: '/redirect', label: '302 redirect preserving a fragment' },
    { href: '/spa', label: 'history.pushState and hash navigation' },
    {
      id: 'early-history-link',
      href: '/early-history',
      label: 'document-start pushState plus replaceState',
    },
    { href: '/slow?ms=2500', label: '2.5-second slow response' },
    { href: '/large-reader', label: '5 MB article reader fallback' },
    { href: '/form', label: 'sandboxed form submission' },
    ...LIVE_SITE_LINKS,
  ];
  const items = links
    .map(({ href, label, id: suppliedId }) => {
      const id = suppliedId ||
        `link-${escapeHtml(label.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`;
      return `<a id="${id}" href="${href}">${escapeHtml(label)}</a>`;
    })
    .join('\n');
  return page(
    'GlassPeek local acceptance fixtures',
    `<h1>GlassPeek local acceptance fixtures</h1>
<p>This server is bound to loopback only on port <code>${port}</code>. Each link exercises one observable Firefox preview state.</p>
<nav>${items}</nav>
<h2>Ordinary iframe isolation</h2>
<iframe id="ordinary-frame" title="Ordinary iframe isolation fixture" src="/embed?from=ordinary-iframe" style="width:100%;height:320px;border:1px solid currentColor;border-radius:14px"></iframe>
<p class="marker">The production extension intentionally rejects literal loopback/private targets. This fixture still verifies normal Firefox behavior and the compatibility path; an explicitly configured test hostname is required for embedded-path testing.</p>`,
  );
}

function embeddedPage(url) {
  const from = url.searchParams.get('from') || 'direct';
  return page(
    'Embeddable fixture',
    `<h1>Ordinary embeddable page</h1>
<p id="mode">Loaded through: <strong>${escapeHtml(from)}</strong></p>
<p id="fragment-target" class="marker">Fragment target reached. The URL hash must remain <code>#fragment-target</code>.</p>
<p><a id="child-link" href="/embed/child?from=nested#child-fragment">Navigate to a child page with a fragment</a></p>
<p><a id="new-preview-link" href="/spa#initial" target="_blank">Open the SPA fixture in a new-window target</a></p>
<p><a id="top-target-link" href="/embed/child?from=top-target#child-fragment" target="_top">Navigate a top-target link inside the sandbox</a></p>
<p><a id="download-link" href="/embed/child?from=download#child-fragment" download>Open a download target safely</a></p>
<p><button id="window-open" type="button">Open a scripted window</button></p>`,
    `document.getElementById('window-open').addEventListener('click', () => {
  window.open('/embed/child?from=window-open#child-fragment', '_blank');
});`,
  );
}

function childPage() {
  return page(
    'Nested navigation fixture',
    `<h1>Nested navigation succeeded</h1>
<p id="child-fragment" class="marker">The nested URL and its <code>#child-fragment</code> hash should be visible in GlassPeek.</p>
<p><a href="/embed#fragment-target">Back to the embeddable fixture</a></p>`,
  );
}

function deepToken(url) {
  const token = url.searchParams.get('token') || 'untagged';
  return encodeURIComponent(token);
}

function deepRootPage(url, port) {
  const token = deepToken(url);
  const protectedOrigin = `http://other.localtest.me:${port}`;
  return page(
    'Deep root title sentinel',
    `<h1 id="deep-root-ready">Deep preview root</h1>
<p id="deep-root-sentinel" class="marker">The preview URL, title, and history must remain owned by this direct target while its descendants connect.</p>
<iframe id="deep-level-one-frame" title="Deep level one" src="/deep/level-1?token=${token}" style="width:100%;height:720px;border:1px solid currentColor;border-radius:14px"></iframe>
<iframe id="deep-depth-two-xfo-frame" title="Depth two XFO leaf" src="${protectedOrigin}/deep/xfo?scope=preview&amp;depth=2&amp;token=${token}" style="width:100%;height:210px;border:1px solid currentColor;border-radius:14px"></iframe>
<iframe id="deep-depth-two-csp-frame" title="Depth two CSP leaf" src="${protectedOrigin}/deep/csp?depth=2&amp;token=${token}" style="width:100%;height:150px;border:1px solid currentColor;border-radius:14px"></iframe>
<iframe id="deep-depth-two-report-frame" title="Depth two CSP report-only leaf" src="${protectedOrigin}/deep/csp-report-only?depth=2&amp;token=${token}" style="width:100%;height:150px;border:1px solid currentColor;border-radius:14px"></iframe>`,
  );
}

function deepLevelOnePage(url, port) {
  const token = deepToken(url);
  const protectedOrigin = `http://other.localtest.me:${port}`;
  return page(
    'Deep level one title must not escape',
    `<h1 id="deep-level-one-ready">Deep level one</h1>
<iframe id="deep-depth-three-xfo-frame" title="Depth three XFO leaf" src="${protectedOrigin}/deep/xfo?scope=preview&amp;depth=3&amp;token=${token}" style="width:100%;height:210px;border:1px solid currentColor;border-radius:14px"></iframe>
<iframe id="deep-depth-three-csp-frame" title="Depth three CSP leaf" src="${protectedOrigin}/deep/csp?depth=3&amp;token=${token}" style="width:100%;height:150px;border:1px solid currentColor;border-radius:14px"></iframe>
<iframe id="deep-depth-three-report-frame" title="Depth three CSP report-only leaf" src="${protectedOrigin}/deep/csp-report-only?depth=3&amp;token=${token}" style="width:100%;height:150px;border:1px solid currentColor;border-radius:14px"></iframe>
<iframe id="deep-level-two-frame" title="Deep level two" src="/deep/level-2?token=${token}" style="width:100%;height:180px;border:1px solid currentColor;border-radius:14px"></iframe>`,
  );
}

function deepLevelTwoPage() {
  return page(
    'Deep level two title must not escape',
    `<h1 id="deep-level-two-ready">Deep level two</h1>
<p class="marker">A normal descendant remains connected below the protected depth-three siblings.</p>`,
  );
}

function deepXfoPage(url, port) {
  const previewScope = url.searchParams.get('scope') === 'preview';
  const token = deepToken(url);
  const depth = url.searchParams.get('depth') || 'ordinary';
  return page(
    previewScope
      ? 'Deep descendant poisoned title'
      : 'Ordinary sibling XFO sentinel',
    `<h1 id="deep-xfo-ready" data-depth="${escapeHtml(depth)}">Deep XFO descendant loaded</h1>
<p class="marker">This X-Frame-Options response may render only inside a verified GlassPeek target tree.</p>
${previewScope
    ? `<p><a id="deep-top-link" href="http://localtest.me:${port}/deep/root-destination?from=deep-top&amp;token=${token}#reached" target="_top">Navigate the direct preview root</a></p>`
    : ''}`,
    previewScope
      ? `setTimeout(() => {
  document.title = 'Deep descendant poisoned title';
  const poisoned = new URL(location.href);
  poisoned.searchParams.set('child-state', 'poison');
  poisoned.hash = 'descendant';
  history.pushState({ descendant: true }, '', poisoned);
}, 150);`
      : '',
  );
}

function deepCspPage(url) {
  const depth = url.searchParams.get('depth') || 'ordinary';
  return page(
    'Deep CSP title must not escape',
    `<h1 id="deep-csp-ready" data-depth="${escapeHtml(depth)}">Deep CSP descendant loaded</h1>
<p class="marker">The enforced frame-ancestors directive was removed without weakening the rest of the policy.</p>`,
    `document.documentElement.dataset.inlineRan = 'yes';`,
  );
}

function deepCspReportOnlyPage(url) {
  const depth = url.searchParams.get('depth') || 'ordinary';
  return page(
    'Deep CSP report-only title must not escape',
    `<h1 id="deep-csp-report-only-ready" data-depth="${escapeHtml(depth)}">Deep CSP report-only descendant loaded</h1>
<p class="marker">The report-only frame-ancestors directive was handled without changing root state.</p>`,
    `document.documentElement.dataset.inlineRan = 'yes';`,
  );
}

function deepRootDestinationPage() {
  return page(
    'Deep root destination',
    `<h1 id="deep-root-destination">Deep target=_top navigation reached the direct preview</h1>
<p class="marker">The source tab stayed put and no Firefox top-level window was opened.</p>`,
  );
}

function xfoPage() {
  return page(
    'XFO DENY fixture',
    '<h1>X-Frame-Options: DENY</h1><p>If this text appears inside a third-party frame, the browser security boundary was weakened.</p><p><a href="/embed/child?from=reader-link#child-fragment">Continue from the reading snapshot</a></p>',
  );
}

function largeReaderPage() {
  const paragraph =
    'GlassPeek must extract a useful article even when a modern news page contains more than one megabyte of markup. ' +
    'The reader remains local, removes scripts, and keeps safe article links. ';
  const paragraphs = Array.from(
    { length: 13_000 },
    (_value, index) => `<p>Article paragraph ${index + 1}. ${paragraph.repeat(2)}</p>`,
  ).join('');
  return page(
    'Large article reader fixture',
    `<article><h1>Large article reader fixture</h1>
<p class="marker">A reader snapshot should remain available beyond the former 1 MB ceiling.</p>
<p><a href="/embed/child?from=large-reader#child-fragment">Continue from the large article</a></p>
${paragraphs}</article>`,
  );
}

function cspPage() {
  return page(
    'CSP frame-ancestors fixture',
    "<h1>CSP frame-ancestors 'none'</h1><p>If this text appears inside a third-party frame, the browser security boundary was weakened.</p>",
  );
}

function spaPage() {
  return page(
    'SPA navigation fixture',
    `<h1>SPA navigation fixture</h1>
<p id="spa-state" class="marker">initial</p>
<p>
  <button id="push-state" type="button">pushState</button>
  <button id="replace-state" type="button">replaceState</button>
  <button id="change-hash" type="button">change hash</button>
</p>
<p id="spa-fragment">The final URL displayed by GlassPeek should track query strings and fragments.</p>`,
    `
const state = document.getElementById('spa-state');
function render(eventName) {
  state.textContent = eventName + ': ' + location.pathname + location.search + location.hash;
}
document.getElementById('push-state').addEventListener('click', () => {
  history.pushState({ step: 1 }, '', '/spa?step=1#pushed');
  render('pushState');
});
document.getElementById('replace-state').addEventListener('click', () => {
  history.replaceState({ step: 2 }, '', '/spa?step=2#replaced');
  render('replaceState');
});
document.getElementById('change-hash').addEventListener('click', () => {
  location.hash = 'hash-only';
});
addEventListener('popstate', () => render('popstate'));
addEventListener('hashchange', () => render('hashchange'));
render('load');`,
  );
}

function earlyHistoryPage() {
  return page(
    'Early SPA history fixture',
    `<h1 id="early-history-ready">Early SPA history fixture</h1>
<p id="early-history-state" class="marker">The head script must run before the asynchronous preview target config arrives.</p>`,
    `
const earlyState = document.getElementById('early-history-state');
function renderEarlyHistory(eventName) {
  earlyState.textContent = eventName + ': ' + location.pathname + location.search + location.hash;
}
addEventListener('popstate', () => renderEarlyHistory('popstate'));
renderEarlyHistory('load');`,
    `
window.__glasspeekEarlyHistory = {
  readyState: document.readyState,
  bridgeInstalled:
    Object.prototype.hasOwnProperty.call(history, 'pushState') &&
    Object.prototype.hasOwnProperty.call(history, 'replaceState'),
  originalUrl: location.href
};
const earlyReplayKey = '__glasspeekEarlyHistoryStartupRan';
if (sessionStorage.getItem(earlyReplayKey) !== '1') {
  sessionStorage.setItem(earlyReplayKey, '1');
  history.pushState({ early: 'push' }, '', '/early-history?phase=push#one');
  history.replaceState({ early: 'replace' }, '', '/early-history?phase=replace#two');
}
window.__glasspeekEarlyHistory.finalUrl = location.href;`,
  );
}

function formPage() {
  return page(
    'Form fixture',
    `<h1>Form submission fixture</h1>
<form id="fixture-form" action="/form-result#submitted" method="post" target="_blank">
  <p><label>Message <input id="message" name="message" value="GlassPeek form value"></label></p>
  <p><label>Notes <textarea id="notes" name="notes">sandboxed form submission</textarea></label></p>
  <button id="submit-form" type="submit">Submit form</button>
</form>`,
  );
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_FORM_BYTES) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleRequest(req, res, port) {
  const url = new URL(req.url || '/', `http://${HOST}:${port}`);

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    send(res, 204, {});
    return;
  }
  if (req.method === 'GET' && url.pathname === '/healthz') {
    send(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: true, routes: ROUTES }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, indexPage(port));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/embed') {
    sendHtml(res, embeddedPage(url));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/embed/child') {
    sendHtml(res, childPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/root') {
    sendHtml(res, deepRootPage(url, port));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/level-1') {
    sendHtml(res, deepLevelOnePage(url, port));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/level-2') {
    sendHtml(res, deepLevelTwoPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/xfo') {
    const relaxPreviewLeaf =
      RELAX_LOCAL_PROTECTED_FIXTURES &&
      url.searchParams.get('scope') === 'preview';
    sendHtml(
      res,
      deepXfoPage(url, port),
      relaxPreviewLeaf ? {} : { 'X-Frame-Options': 'DENY' },
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/csp') {
    const relaxPreviewLeaf =
      RELAX_LOCAL_PROTECTED_FIXTURES &&
      /^[23]$/.test(url.searchParams.get('depth') || '');
    sendHtml(res, deepCspPage(url), {
      'Content-Security-Policy':
        relaxPreviewLeaf
          ? "script-src 'none'; style-src 'unsafe-inline'"
          : "frame-ancestors 'none'; script-src 'none'; style-src 'unsafe-inline'",
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/csp-report-only') {
    const token = deepToken(url);
    const relaxPreviewLeaf =
      RELAX_LOCAL_PROTECTED_FIXTURES &&
      /^[23]$/.test(url.searchParams.get('depth') || '');
    sendHtml(res, deepCspReportOnlyPage(url), {
      'Content-Security-Policy-Report-Only':
        relaxPreviewLeaf
          ? `script-src 'none'; style-src 'unsafe-inline'; report-uri /deep/csp-report?token=${token}`
          : `frame-ancestors 'none'; script-src 'none'; style-src 'unsafe-inline'; report-uri /deep/csp-report?token=${token}`,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/deep/csp-report') {
    const token = deepToken(url);
    const body = await readBody(req);
    let report = { malformed: body };
    try {
      report = JSON.parse(body);
    } catch (_error) {
      // Preserve malformed reports so the smoke test can show what Firefox sent.
    }
    const reports = cspReportsByToken.get(token) || [];
    reports.push(report);
    cspReportsByToken.set(token, reports);
    send(res, 204, {});
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/csp-report') {
    const token = deepToken(url);
    send(
      res,
      200,
      { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify(cspReportsByToken.get(token) || []),
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/deep/root-destination') {
    sendHtml(res, deepRootDestinationPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/xfo') {
    sendHtml(
      res,
      xfoPage(),
      RELAX_LOCAL_PROTECTED_FIXTURES ? {} : { 'X-Frame-Options': 'DENY' },
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/xfo-sameorigin') {
    sendHtml(
      res,
      page(
        'XFO SAMEORIGIN fixture',
        '<h1 id="sameorigin-ready">X-Frame-Options: SAMEORIGIN loaded</h1><p>The target is a direct child of its same-origin source page.</p>',
      ),
      { 'X-Frame-Options': 'SAMEORIGIN' },
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/csp') {
    sendHtml(res, cspPage(), {
      'Content-Security-Policy': "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'",
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/csp-self') {
    sendHtml(
      res,
      page(
        'CSP self fixture',
        "<h1 id=\"csp-self-ready\">CSP frame-ancestors 'self' loaded</h1><p>The extension control frame is a sibling, not an ancestor.</p>",
      ),
      {
        'Content-Security-Policy':
          "frame-ancestors 'self'; default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      },
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/redirect') {
    send(res, 302, { Location: '/embed?from=redirect#fragment-target' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/spa') {
    sendHtml(res, spaPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/early-history') {
    sendHtml(res, earlyHistoryPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/replace-result') {
    sendHtml(
      res,
      page(
        'Location replace result',
        '<h1 id="replace-result">location.replace completed</h1><p>This document must replace, not append, the current preview history entry.</p>',
      ),
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/slow') {
    const requested = Number(url.searchParams.get('ms'));
    const delay = Number.isFinite(requested) ? Math.min(20_000, Math.max(0, requested)) : 7_000;
    const timer = setTimeout(() => {
      if (!res.destroyed) {
        sendHtml(res, page('Slow fixture', `<h1>Slow page completed</h1><p id="delay">Delayed ${delay} ms.</p>`));
      }
    }, delay);
    req.once('aborted', () => clearTimeout(timer));
    res.once('close', () => {
      if (!res.writableEnded) clearTimeout(timer);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/large-reader') {
    sendHtml(
      res,
      largeReaderPage(),
      RELAX_LOCAL_PROTECTED_FIXTURES ? {} : { 'X-Frame-Options': 'DENY' },
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/form') {
    sendHtml(res, formPage());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/form-result') {
    const body = await readBody(req);
    const fields = new URLSearchParams(body);
    sendHtml(
      res,
      page(
        'Form result fixture',
        `<h1 id="submitted">Form submitted</h1>
<dl>
  <dt>message</dt><dd id="result-message">${escapeHtml(fields.get('message') || '')}</dd>
  <dt>notes</dt><dd id="result-notes">${escapeHtml(fields.get('notes') || '')}</dd>
</dl>
<p><a href="/form">Submit another response</a></p>`,
      ),
    );
    return;
  }

  sendHtml(res, page('Not found', `<h1>404</h1><p>No fixture at <code>${escapeHtml(url.pathname)}</code>.</p>`), {}, 404);
}

function createTestServer() {
  const server = http.createServer((req, res) => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : DEFAULT_PORT;
    handleRequest(req, res, port).catch((error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendHtml(res, page('Fixture error', `<h1>${status}</h1><p>${escapeHtml(error.message)}</p>`), {}, status);
    });
  });
  return server;
}

function requestedPort(argv = process.argv.slice(2), env = process.env) {
  const explicit = argv.find((value) => /^--port=\d+$/.test(value));
  const positional = argv.find((value) => /^\d+$/.test(value));
  const raw = explicit ? explicit.slice('--port='.length) : positional || env.GLASSPEEK_TEST_PORT || DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid test port: ${raw}`);
  }
  return port;
}

if (require.main === module) {
  const server = createTestServer();
  const port = requestedPort();
  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    console.log(`GlassPeek acceptance server: http://${HOST}:${actualPort}/`);
    console.log('Press Ctrl+C to stop.');
  });
  server.on('error', (error) => {
    console.error(`GlassPeek acceptance server failed: ${error.message}`);
    process.exitCode = 1;
  });
  const stop = () => server.close(() => process.exit());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = {
  HOST,
  ROUTES,
  createTestServer,
  requestedPort,
};
