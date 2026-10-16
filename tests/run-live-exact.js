'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const xpiArg = process.argv.find((value) => value.startsWith('--xpi='));
const artifactArg = process.argv.find((value) => value.startsWith('--artifacts='));
const siteArg = process.argv.find((value) => value.startsWith('--site='));
const headed = process.argv.includes('--headed');
if (!xpiArg || !xpiArg.slice('--xpi='.length).trim()) {
  throw new Error('An explicit --xpi=<exact release archive> is required');
}
const XPI = fs.realpathSync(path.resolve(xpiArg.slice('--xpi='.length)));
const XPI_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(XPI)).digest('hex');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_ROOT = path.join(ROOT, 'tests', 'artifacts', `live-exact-${RUN_ID}`);
const PROFILE = path.join(RUN_ROOT, 'profile');
const ARTIFACTS = path.resolve(
  artifactArg ? artifactArg.slice('--artifacts='.length) : path.join(RUN_ROOT, 'screenshots'),
);
const SOURCE_URL = 'https://example.com/?glasspeek-live-exact=1';
const FAKE_WARNING =
  /您正在访问仿冒网站|請使用.+官方域名|请使用.+官方域名|cannot be displayed in (?:a |this )?frame|blocked from loading in (?:a |this )?frame|refused to connect|please open (?:this page )?in (?:your )?browser/i;

const SITES = Object.freeze([
  {
    key: 'cnn',
    url: 'https://www.cnn.com/world',
    urlPattern: /^https:\/\/(?:www|edition)\.cnn\.com\/world(?:[/?#]|$)/i,
    markerSelector: 'main, article, [role="main"], h1',
    outcome: 'ready',
  },
  {
    key: 'bilibili',
    url: 'https://www.bilibili.com/video/BV1CHK46eEe7/',
    urlPattern: /^https:\/\/www\.bilibili\.com\/video\/BV1CHK46eEe7(?:[/?#]|$)/i,
    markerSelector: '.bpx-player-container, #bilibili-player, .video-container-v1',
    outcome: 'ready',
  },
  {
    key: 'youtube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    urlPattern: /^https:\/\/www\.youtube\.com\/watch\?[^#]*v=dQw4w9WgXcQ/i,
    markerSelector: 'ytd-app, ytd-watch-flexy, video',
    outcome: 'ready',
  },
  {
    key: 'iyf-screenshot-a',
    url: 'https://www.iyf.tv/play/4bwvnzOIUB2',
    urlPattern: /^https:\/\/www\.iyf\.tv\/play\/4bwvnzOIUB2(?:[/?#]|$)/i,
    outcome: 'ready-or-compat-required',
  },
  {
    key: 'iyf-screenshot-b',
    url: 'https://www.iyf.tv/play/4hbwrnzOlUB2',
    urlPattern: /^https:\/\/www\.iyf\.tv\/play\/4hbwrnzOlUB2(?:[/?#]|$)/i,
    outcome: 'ready-or-compat-required',
  },
  {
    key: 'wikipedia',
    url: 'https://en.wikipedia.org/wiki/Firefox',
    urlPattern: /^https:\/\/en\.wikipedia\.org\/wiki\/Firefox(?:[?#]|$)/i,
    markerSelector: '#firstHeading, #mw-content-text',
    outcome: 'ready',
  },
  {
    key: 'github',
    url: 'https://github.com/mozilla-firefox/firefox',
    urlPattern: /^https:\/\/github\.com\/mozilla-firefox\/firefox\/?(?:[?#].*)?$/i,
    markerSelector: '#repository-container-header, [data-turbo-body]',
    outcome: 'ready',
  },
  {
    key: 'taobao',
    url: 'https://www.taobao.com/',
    urlPattern: /^https:\/\/www\.taobao\.com\/(?:[?#]|$)/i,
    markerSelector: '#J_SiteNav, #ice-container, .tb-pick-header, main',
    outcome: 'ready',
  },
  {
    key: 'example',
    url: 'https://example.com/',
    urlPattern: /^https:\/\/example\.com\/(?:[?#]|$)/i,
    markerSelector: 'h1',
    outcome: 'ready',
  },
  {
    key: 'example-nested',
    url: 'https://example.com/',
    urlPattern: /^https:\/\/example\.com\/(?:[?#]|$)/i,
    markerSelector: 'h1',
    outcome: 'ready',
  },
  {
    key: 'delayed-warning',
    url: 'https://example.org/',
    urlPattern: /^https:\/\/example\.org\/(?:[?#]|$)/i,
    markerSelector: 'h1',
    outcome: 'ready',
  },
]);

const requestedSite = siteArg ? siteArg.slice('--site='.length).trim().toLowerCase() : '';
const SELECTED_SITES = requestedSite
  ? SITES.filter(
      (site) =>
        site.key === requestedSite ||
        (requestedSite === 'iyf' && site.key.startsWith('iyf-')),
    )
  : SITES;
if (requestedSite && SELECTED_SITES.length === 0) {
  throw new Error(`Unknown live site: ${requestedSite}`);
}

class BidiClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('BiDi connection timed out')), 10000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(event.error || new Error('BiDi WebSocket failed'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'error') {
        pending.reject(new Error(`${message.error}: ${message.message}`));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  command(method, params = {}, timeout = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

function flatten(contexts, output = []) {
  for (const context of contexts || []) {
    output.push(context);
    flatten(context.children || [], output);
  }
  return output;
}

function parentMap(contexts, parent = null, output = new Map()) {
  for (const item of contexts || []) {
    output.set(item.context, parent);
    parentMap(item.children || [], item.context, output);
  }
  return output;
}

async function waitFor(fn, label, timeout = 30000, interval = 150) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  if (lastError) throw new Error(`Timed out waiting for ${label}: ${lastError.message}`);
  throw new Error(`Timed out waiting for ${label}`);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function waitForPort(port, timeout = 30000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(800);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`Firefox port ${port} did not open`));
        else setTimeout(attempt, 200);
      };
      socket.once('timeout', retry);
      socket.once('error', retry);
    };
    attempt();
  });
}

async function terminate(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  assert.ok(fs.existsSync(FIREFOX), `Firefox does not exist: ${FIREFOX}`);
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const remotePort = await reservePort();
  let firefox = null;
  let client = null;
  let installedExtensionId = '';
  let sessionStarted = false;
  try {
    const firefoxArgs = [
      '-no-remote',
      '-profile',
      PROFILE,
      '--width=1600',
      '--height=1000',
      '--remote-debugging-port',
      String(remotePort),
      'about:blank',
    ];
    if (!headed) firefoxArgs.unshift('-headless');
    firefox = spawn(FIREFOX, firefoxArgs, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    firefox.stderr?.on('data', (chunk) => process.stderr.write(`[firefox] ${String(chunk)}`));
    await waitForPort(remotePort);
    await new Promise((resolve) => setTimeout(resolve, 8000));

    client = new BidiClient(`ws://127.0.0.1:${remotePort}/session`);
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    }, 60000);
    sessionStarted = true;
    const initialTree = await client.command('browsingContext.getTree', {});
    const source = initialTree.contexts.find((entry) => entry.url === 'about:blank');
    assert.ok(source, 'initial about:blank source tab was not found');
    const context = source.context;

    const installed = await client.command('webExtension.install', {
      extensionData: { type: 'archivePath', path: XPI },
      'moz:permanent': false,
    }, 60000);
    assert.equal(installed.extension, '{88cdb8a1-2007-44be-9965-7b08e3518437}');
    installedExtensionId = installed.extension;
    const welcomeContext = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', {});
      return tree.contexts.find((entry) => /\/welcome\/welcome\.html(?:[?#]|$)/.test(entry.url));
    }, 'install welcome context', 10000);
    const settingsResult = await client.command('script.evaluate', {
      expression: `(async () => JSON.stringify(await browser.storage.sync.get("forceCompatDomains")))()`,
      target: { context: welcomeContext.context },
      awaitPromise: true,
      resultOwnership: 'none',
    }, 30000);
    assert.equal(settingsResult.type, 'success', settingsResult.exceptionDetails?.text || 'settings readback');
    const storedSettings = JSON.parse(settingsResult.result.value);
    assert.deepEqual(
      Array.isArray(storedSettings.forceCompatDomains) ? storedSettings.forceCompatDomains : [],
      [],
      'fresh exact-package profile unexpectedly remembered full-page compatibility hosts',
    );
    const postInstallTree = await client.command('browsingContext.getTree', {});
    for (const entry of postInstallTree.contexts) {
      if (/\/welcome\/welcome\.html(?:[?#]|$)/.test(entry.url)) {
        await client.command('browsingContext.close', { context: entry.context }).catch(() => {});
      }
    }
    // Navigate only after installation so Firefox creates a new document with
    // this exact archive's manifest content script attached.
    await client.command('browsingContext.navigate', {
      context,
      url: SOURCE_URL,
      wait: 'complete',
    }, 60000);
    await client.command('browsingContext.activate', { context });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    async function evaluate(expression, targetContext = context) {
      const result = await client.command('script.evaluate', {
        expression,
        target: { context: targetContext },
        awaitPromise: true,
        resultOwnership: 'none',
      }, 30000);
      assert.equal(result.type, 'success', result.exceptionDetails?.text || expression);
      return result.result?.value;
    }

    async function json(expression, targetContext = context) {
      return JSON.parse(await evaluate(`JSON.stringify(${expression})`, targetContext));
    }

    async function frameOffset(parentContext, childContext, label) {
      const located = await client.command('browsingContext.locateNodes', {
        context: parentContext,
        locator: { type: 'context', value: { context: childContext } },
        maxNodeCount: 1,
      });
      const frame = located.nodes?.[0];
      assert.ok(frame?.sharedId, `${label} embedding frame was not found`);
      const result = await client.command('script.callFunction', {
        functionDeclaration: `(frame) => JSON.stringify((() => {
          const rect = frame.getBoundingClientRect();
          return { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop };
        })())`,
        target: { context: parentContext },
        awaitPromise: false,
        arguments: [{ sharedId: frame.sharedId }],
        resultOwnership: 'none',
      });
      assert.equal(result.type, 'success', result.exceptionDetails?.text || label);
      return JSON.parse(result.result.value);
    }

    async function topLevelPoint(selector, targetContext, label) {
      const local = await json(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rects = [...element.getClientRects()];
        const fractions = [
          [0.5, 0.5], [0.25, 0.25], [0.75, 0.25],
          [0.25, 0.75], [0.75, 0.75], [0.5, 0.2], [0.5, 0.8]
        ];
        for (const rect of rects) {
          for (const [fx, fy] of fractions) {
            const x = rect.left + rect.width * fx;
            const y = rect.top + rect.height * fy;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit === element || element.contains(hit))) {
              return { x, y, hitTag: hit.localName };
            }
          }
        }
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          hitTag: ''
        };
      })()`, targetContext);
      assert.ok(local && Number.isFinite(local.x) && Number.isFinite(local.y), `${label} is not actionable`);
      const tree = await client.command('browsingContext.getTree', { root: context });
      const parents = parentMap(tree.contexts);
      let current = targetContext;
      let x = local.x;
      let y = local.y;
      while (current !== context) {
        const parent = parents.get(current);
        assert.ok(parent, `${label} is outside the source tab`);
        const offset = await frameOffset(parent, current, label);
        x += offset.x;
        y += offset.y;
        current = parent;
      }
      return { x: Math.round(x), y: Math.round(y) };
    }

    async function pointerGesture(selector, targetContext, label, hold = 0) {
      const point = await topLevelPoint(selector, targetContext, label);
      const actions = [
        { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
      ];
      if (hold) actions.push({ type: 'pause', duration: hold });
      actions.push({ type: 'pointerUp', button: 0 });
      await client.command('input.performActions', {
        context,
        actions: [{
          type: 'pointer',
          id: `glasspeek-live-${Date.now().toString(36)}`,
          parameters: { pointerType: 'mouse' },
          actions,
        }],
      });
      await client.command('input.releaseActions', { context });
    }

    async function capture(fileName) {
      const image = await client.command('browsingContext.captureScreenshot', {
        context,
        origin: 'viewport',
        format: { type: 'image/png' },
      });
      const filePath = path.join(ARTIFACTS, fileName);
      fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
      return filePath;
    }

    async function previewContext() {
      const tree = await client.command('browsingContext.getTree', { root: context });
      const candidates = flatten(tree.contexts)
        .filter((entry) => /\/preview\/preview\.html(?:[?#]|$)/.test(entry.url))
        .reverse();
      for (const candidate of candidates) {
        try {
          if (await evaluate('Boolean(document.getElementById("surface"))', candidate.context)) {
            return candidate;
          }
        } catch {
          // A closing preview can leave one stale tree entry.
        }
      }
      return null;
    }

    async function directTargetContext(site) {
      const tree = await client.command('browsingContext.getTree', { root: context });
      const parents = parentMap(tree.contexts);
      return flatten(tree.contexts).find(
        (entry) => parents.get(entry.context) === context && site.urlPattern.test(entry.url),
      ) || null;
    }

    async function directHttpTargetContext() {
      const tree = await client.command('browsingContext.getTree', { root: context });
      const parents = parentMap(tree.contexts);
      return flatten(tree.contexts).find(
        (entry) =>
          parents.get(entry.context) === context &&
          /^https?:\/\//i.test(entry.url),
      ) || null;
    }

    async function embeddedFramePresentation(targetContext, label) {
      const located = await client.command('browsingContext.locateNodes', {
        context,
        locator: { type: 'context', value: { context: targetContext } },
        maxNodeCount: 1,
      });
      const frame = located.nodes?.[0];
      assert.ok(frame?.sharedId, `${label} target iframe was not found`);
      const result = await client.command('script.callFunction', {
        functionDeclaration: `(frame) => JSON.stringify((() => {
          const style = getComputedStyle(frame);
          return {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents
          };
        })())`,
        target: { context },
        awaitPromise: false,
        arguments: [{ sharedId: frame.sharedId }],
        resultOwnership: 'none',
      });
      assert.equal(result.type, 'success', result.exceptionDetails?.text || label);
      return JSON.parse(result.result.value);
    }

    async function audit(site) {
      const startedAt = Date.now();
      let preview = null;
      let state = null;
      let embedded = null;
      let screenshot = null;
      let failure = null;
      let outcome = '';
      let nestedEvidence = null;
      let nestedLink = null;
      let nestedClickAudit = null;
      let delayedWarningEvidence = null;
      let outsideClosePassed = false;
      const beforeWindows = await client.command('browser.getClientWindows', {});
      const beforeTree = await client.command('browsingContext.getTree', {});
      const beforeTopIds = new Set(beforeTree.contexts.map((entry) => entry.context));
      const beforeTopIdList = [...beforeTopIds].sort();
      try {
        await evaluate(`(() => {
          document.getElementById('glasspeek-live-exact-link')?.remove();
          const anchor = document.createElement('a');
          anchor.id = 'glasspeek-live-exact-link';
          anchor.href = ${JSON.stringify(site.url)};
          anchor.textContent = ${JSON.stringify(`GlassPeek exact live: ${site.key}`)};
          Object.assign(anchor.style, {
            position: 'fixed', left: '80px', top: '80px', zIndex: '2147483647',
            padding: '20px 28px', background: '#fff', color: '#111',
            border: '3px solid #2563eb', borderRadius: '12px',
            font: '700 22px sans-serif'
          });
          document.body.appendChild(anchor);
          if (${JSON.stringify(site.key)} === 'cnn') {
            document.getElementById('glasspeek-underlay-probe')?.remove();
            window.__glasspeekUnderlayClicks = 0;
            const probe = document.createElement('button');
            probe.id = 'glasspeek-underlay-probe';
            probe.type = 'button';
            probe.textContent = 'underlay probe';
            Object.assign(probe.style, {
              position: 'fixed', right: '0', bottom: '0', zIndex: '2147483646',
              width: '120px', height: '80px'
            });
            probe.addEventListener('click', () => {
              window.__glasspeekUnderlayClicks += 1;
            });
            document.body.appendChild(probe);
          }
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await pointerGesture('#glasspeek-live-exact-link', context, site.key, 700);
        preview = await waitFor(previewContext, `${site.key} preview`, 15000);
        const releasedPreviewContext = preview.context;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const releaseSurvivor = await previewContext();
        assert.equal(
          releaseSurvivor?.context,
          releasedPreviewContext,
          `${site.key} preview disappeared after pointer release`,
        );
        state = await waitFor(async () => {
          const value = await json(`({
            classes: document.getElementById('surface')?.className || '',
            url: document.getElementById('pageUrl')?.textContent || '',
            pageTitle: document.getElementById('pageTitle')?.textContent || '',
            errorTitle: document.getElementById('errorTitle')?.textContent || '',
            errorDetail: document.getElementById('errorDetail')?.textContent || '',
            retryHidden: document.getElementById('retry')?.hidden === true,
            compatHidden: document.getElementById('compat')?.hidden === true
          })`, preview.context);
          return /\bis-(?:ready|error)\b/.test(value.classes) ? value : null;
        }, `${site.key} terminal state`, 30000);
        const readyLatencyMs = Date.now() - startedAt;

        if (/\bis-error\b/.test(state.classes)) {
          assert.equal(site.outcome, 'ready-or-compat-required', `${site.key} exposed an error state`);
          assert.equal(state.retryHidden, true, 'compat-required must not expose a retry loop');
          assert.equal(state.compatHidden, false, 'compat-required must expose an explicit full-page action');
          assert.match(
            state.errorTitle,
            /needs a full-page window|需要完整网页小窗|需要完整網頁小視窗/i,
            'IYF refusal did not become a clear compatibility-required state',
          );
          const hiddenTarget = await directTargetContext(site);
          if (hiddenTarget) {
            const presentation = await embeddedFramePresentation(
              hiddenTarget.context,
              `${site.key} compatibility-required`,
            );
            assert.ok(
              presentation.display === 'none' ||
                presentation.visibility === 'hidden' ||
                presentation.opacity === '0',
              'compatibility-required target warning remained visibly painted',
            );
            assert.equal(
              presentation.pointerEvents,
              'none',
              'compatibility-required target warning remained interactive',
            );
          }
          outcome = 'compat-required';
        } else {
          assert.match(state.classes, /\bis-ready\b/);
          assert.match(state.url, site.urlPattern);
          const target = await directTargetContext(site);
          assert.ok(target, `${site.key} did not keep a direct embedded original page`);
          embedded = await waitFor(async () => {
            const value = await json(`({
              url: location.href,
              title: (document.title || '').trim(),
              text: (document.body?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1600),
              readyState: document.readyState,
              marker: ${site.markerSelector
                ? `Boolean(document.querySelector(${JSON.stringify(site.markerSelector)}))`
                : 'true'}
            })`, target.context);
            if (FAKE_WARNING.test(value.text)) {
              throw new Error(`${site.key} displayed an embedding/fake-site warning`);
            }
            return (
              value.title &&
              value.marker === true &&
              value.text.length >= 40 &&
              /[\p{L}\p{N}]/u.test(value.text)
            ) ? value : null;
          }, `${site.key} meaningful original document`, 20000, 250);
          assert.match(embedded.url, site.urlPattern);
          assert.doesNotMatch(
            embedded.text,
            FAKE_WARNING,
            `${site.key} displayed an embedding/fake-site warning as if it were a successful page`,
          );
          const stable = await json(`({
            classes: document.getElementById('surface')?.className || '',
            url: document.getElementById('pageUrl')?.textContent || ''
          })`, preview.context);
          assert.match(stable.classes, /\bis-ready\b/);
          assert.match(stable.url, site.urlPattern);
          if (site.key === 'cnn') {
            nestedLink = await waitFor(async () => {
              const candidate = await json(`(() => {
                const links = [...document.querySelectorAll('main a[href], [role="main"] a[href]')];
                const candidates = links.filter((item) => {
                  let url;
                  try { url = new URL(item.href, location.href); } catch (_error) { return false; }
                  const pathOK = /^\\/\\d{4}\\/\\d{2}\\/\\d{2}\\/(?:world|africa|americas|asia|australia|china|europe|india|middleeast)\\/[a-z0-9-]+\\/?$/i.test(url.pathname);
                  const rect = item.getBoundingClientRect();
                  const visible =
                    item.getClientRects().length > 0 &&
                    rect.width > 20 &&
                    rect.height > 10 &&
                    rect.left >= Math.max(180, innerWidth * 0.15) &&
                    rect.right <= innerWidth - 40 &&
                    rect.top >= 60 &&
                    rect.bottom <= innerHeight - 20;
                  const label = [
                    url.pathname,
                    item.textContent || '',
                    item.getAttribute('aria-label') || ''
                  ].join(' ');
                  return (
                    url.origin === location.origin &&
                    url.protocol === 'https:' &&
                    pathOK &&
                    !item.target &&
                    !item.hasAttribute('download') &&
                    !item.closest('nav,header,[role="navigation"],[class*="video" i],[data-component-name*="video" i]') &&
                    !/(video|watch|live|login|account|subscribe|sign.?in)/i.test(label) &&
                    (item.textContent || '').replace(/\\s+/g, ' ').trim().length >= 20 &&
                    visible
                  );
                });
                const anchor = candidates.sort((left, right) => {
                  const a = left.getBoundingClientRect();
                  const b = right.getBoundingClientRect();
                  const ad = Math.abs((a.left + a.right) / 2 - innerWidth / 2) +
                    Math.abs((a.top + a.bottom) / 2 - innerHeight / 2);
                  const bd = Math.abs((b.left + b.right) / 2 - innerWidth / 2) +
                    Math.abs((b.top + b.bottom) / 2 - innerHeight / 2);
                  return ad - bd;
                })[0];
                if (!anchor) return null;
                clearInterval(window.__glasspeekNestedHostTimer);
                document.getElementById('glasspeek-cnn-nested-host')?.remove();
                window.__glasspeekNestedClickAudit = {
                  pointerDown: 0,
                  clicks: 0,
                  trustedPointerDown: false,
                  trustedClick: false
                };
                const host = document.createElement('div');
                host.id = 'glasspeek-cnn-nested-host';
                const importantStyles = {
                  position: 'fixed',
                  left: '360px',
                  top: '240px',
                  zIndex: '2147483647',
                  display: 'block',
                  width: '360px',
                  height: '76px',
                  margin: '0',
                  padding: '18px',
                  transform: 'none',
                  opacity: '1',
                  visibility: 'visible',
                  pointerEvents: 'auto',
                  color: '#fff',
                  background: '#0b57d0',
                  border: '3px solid #fff',
                  borderRadius: '10px',
                  font: '700 18px sans-serif'
                };
                for (const [name, value] of Object.entries(importantStyles)) {
                  host.style.setProperty(
                    name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()),
                    value,
                    'important'
                  );
                }
                const shadow = host.attachShadow({ mode: 'open' });
                const probe = document.createElement('a');
                probe.href = anchor.href;
                probe.textContent = 'Open sampled CNN article inside preview';
                Object.assign(probe.style, {
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  padding: '18px',
                  color: '#fff',
                  background: '#0b57d0',
                  boxSizing: 'border-box'
                });
                probe.addEventListener('pointerdown', (event) => {
                  window.__glasspeekNestedClickAudit.pointerDown += 1;
                  window.__glasspeekNestedClickAudit.trustedPointerDown ||= event.isTrusted;
                }, { once: true });
                probe.addEventListener('click', (event) => {
                  window.__glasspeekNestedClickAudit.clicks += 1;
                  window.__glasspeekNestedClickAudit.trustedClick ||= event.isTrusted;
                  // Simulate a hydrated site handler that would hide the event
                  // from bubble-phase extension listeners.
                  event.stopImmediatePropagation();
                }, { once: true });
                shadow.appendChild(probe);
                const mount = () => {
                  if (!host.isConnected) document.documentElement.appendChild(host);
                };
                mount();
                window.__glasspeekNestedHostTimer = setInterval(mount, 5);
                const url = new URL(anchor.href, location.href);
                return {
                  href: url.href,
                  origin: url.origin,
                  pathname: url.pathname,
                  text: (anchor.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
                };
              })()`, target.context);
              return candidate || null;
            }, 'CNN same-site article link', 20000, 300);
            await waitFor(async () => json(`(() => {
              const host = document.getElementById('glasspeek-cnn-nested-host');
              if (!host || !host.isConnected) return false;
              const rect = host.getBoundingClientRect();
              const hit = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2
              );
              return hit === host;
            })()`, target.context), 'CNN fixed nested-link hit target', 5000, 25);
            const nestedPoint = await topLevelPoint(
              '#glasspeek-cnn-nested-host',
              target.context,
              'CNN nested article',
            );
            nestedLink = { ...nestedLink, topLevelPoint: nestedPoint };
            await pointerGesture(
              '#glasspeek-cnn-nested-host',
              target.context,
              'CNN nested article',
            );
            await new Promise((resolve) => setTimeout(resolve, 750));
            nestedClickAudit = await json(
              'window.__glasspeekNestedClickAudit || null',
              target.context,
            ).catch(() => null);
            nestedEvidence = await waitFor(async () => {
              const currentPreview = await previewContext();
              if (!currentPreview || currentPreview.context !== preview.context) return null;
              const controlState = await json(`({
                classes: document.getElementById('surface')?.className || '',
                url: document.getElementById('pageUrl')?.textContent || '',
                title: document.getElementById('pageTitle')?.textContent || ''
              })`, preview.context);
              if (!/\bis-ready\b/.test(controlState.classes)) return null;
              let controlUrl;
              try { controlUrl = new URL(controlState.url); } catch (_error) { return null; }
              if (
                controlUrl.origin !== nestedLink.origin ||
                controlUrl.pathname !== nestedLink.pathname
              ) return null;
              const nestedTarget = await directHttpTargetContext();
              if (!nestedTarget) return null;
              const documentState = await json(`({
                url: location.href,
                title: (document.title || '').trim(),
                text: (document.body?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1600),
                marker: Boolean(document.querySelector('main, article, [role="main"], h1'))
              })`, nestedTarget.context);
              let documentUrl;
              try { documentUrl = new URL(documentState.url); } catch (_error) { return null; }
              if (
                documentUrl.origin !== nestedLink.origin ||
                documentUrl.pathname !== nestedLink.pathname ||
                !documentState.title ||
                !documentState.marker ||
                documentState.text.length < 40 ||
                FAKE_WARNING.test(documentState.text)
              ) return null;
              return {
                requestedUrl: nestedLink.href,
                finalUrl: documentState.url,
                title: documentState.title,
                textSample: documentState.text.slice(0, 240),
                overlayContext: currentPreview.context,
              };
            }, 'CNN nested article in the same overlay', 35000, 300);
            const nestedTree = await client.command('browsingContext.getTree', {});
            assert.deepEqual(
              nestedTree.contexts.map((entry) => entry.context).sort(),
              beforeTopIdList,
              'CNN nested article escaped into a top-level tab',
            );
          }
          if (site.key === 'example-nested') {
            nestedLink = await json(`(() => {
              const anchor = [...document.querySelectorAll('a[href]')].find((item) => {
                try {
                  return /(^|\\.)iana\\.org$/i.test(new URL(item.href, location.href).hostname);
                } catch (_error) {
                  return false;
                }
              });
              if (!anchor) return null;
              const nativeHref = new URL(anchor.href, location.href).href;
              // IANA's legacy /domains/example redirect currently downgrades
              // to HTTP. Point the same native link at its canonical HTTPS
              // destination so this gate measures nested navigation rather
              // than a legacy redirect policy.
              anchor.href = 'https://www.iana.org/help/example-domains';
              anchor.id = 'glasspeek-example-native-link';
              return {
                href: new URL(anchor.href, location.href).href,
                nativeHref
              };
            })()`, target.context);
            assert.ok(nestedLink?.href, 'example.com native IANA link was not found');
            await pointerGesture(
              '#glasspeek-example-native-link',
              target.context,
              'example.com native IANA link',
            );
            nestedEvidence = await waitFor(async () => {
              const currentPreview = await previewContext();
              if (!currentPreview || currentPreview.context !== preview.context) return null;
              const controlState = await json(`({
                classes: document.getElementById('surface')?.className || '',
                url: document.getElementById('pageUrl')?.textContent || ''
              })`, preview.context);
              if (!/\bis-ready\b/.test(controlState.classes)) return null;
              let controlUrl;
              try { controlUrl = new URL(controlState.url); } catch (_error) { return null; }
              if (!/(^|\.)iana\.org$/i.test(controlUrl.hostname)) return null;
              const nestedTarget = await directHttpTargetContext();
              if (!nestedTarget) return null;
              const documentState = await json(`({
                url: location.href,
                title: (document.title || '').trim(),
                text: (document.body?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1600),
                marker: Boolean(document.querySelector('main, h1'))
              })`, nestedTarget.context);
              let documentUrl;
              try { documentUrl = new URL(documentState.url); } catch (_error) { return null; }
              if (
                !/(^|\.)iana\.org$/i.test(documentUrl.hostname) ||
                !documentState.title ||
                !documentState.marker ||
                documentState.text.length < 40
              ) return null;
              return {
                requestedUrl: nestedLink.href,
                finalUrl: documentState.url,
                title: documentState.title,
                textSample: documentState.text.slice(0, 240),
                overlayContext: currentPreview.context,
              };
            }, 'native example.com to IANA nested navigation', 35000, 300);
            const nestedTree = await client.command('browsingContext.getTree', {});
            assert.deepEqual(
              nestedTree.contexts.map((entry) => entry.context).sort(),
              beforeTopIdList,
              'example.com native nested link escaped into a top-level tab',
            );
          }
          if (site.key === 'delayed-warning') {
            await evaluate(`(() => {
              document.title = 'Delayed warning fixture';
              const warning = document.createElement('main');
              const heading = document.createElement('h1');
              heading.textContent = '警告';
              const detail = document.createElement('p');
              detail.textContent = '您正在访问仿冒网站，请使用官方域名访问。';
              warning.append(heading, detail);
              document.body.replaceChildren(warning);
              return true;
            })()`, target.context);
            const delayedState = await waitFor(async () => {
              const value = await json(`({
                classes: document.getElementById('surface')?.className || '',
                url: document.getElementById('pageUrl')?.textContent || '',
                errorTitle: document.getElementById('errorTitle')?.textContent || '',
                errorDetail: document.getElementById('errorDetail')?.textContent || '',
                retryHidden: document.getElementById('retry')?.hidden === true,
                compatHidden: document.getElementById('compat')?.hidden === true
              })`, preview.context);
              return /\bis-error\b/.test(value.classes) ? value : null;
            }, 'delayed fake-site warning compatibility state', 4000, 100);
            assert.equal(delayedState.retryHidden, true);
            assert.equal(delayedState.compatHidden, false);
            assert.match(
              delayedState.errorTitle,
              /needs a full-page window|需要完整网页小窗|需要完整網頁小視窗/i,
            );
            const delayedTarget = await directHttpTargetContext();
            assert.ok(delayedTarget, 'delayed warning target context disappeared');
            const presentation = await embeddedFramePresentation(
              delayedTarget.context,
              'delayed fake-site warning',
            );
            assert.ok(
              presentation.display === 'none' ||
                presentation.visibility === 'hidden' ||
                presentation.opacity === '0',
              'delayed warning remained visibly painted',
            );
            assert.equal(presentation.pointerEvents, 'none');
            const delayedTree = await client.command('browsingContext.getTree', {});
            assert.deepEqual(
              delayedTree.contexts.map((entry) => entry.context).sort(),
              beforeTopIdList,
              'delayed warning opened a top-level tab or window',
            );
            delayedWarningEvidence = {
              terminal: 'compat-required',
              warningHidden: true,
              warningInteractive: false,
              overlayContext: preview.context,
              errorTitle: delayedState.errorTitle,
              errorDetail: delayedState.errorDetail,
            };
            state = delayedState;
            outcome = 'compat-required-after-delayed-warning';
          }
          if (!outcome) outcome = 'ready';
        }

        screenshot = await capture(`live-exact-${site.key}.png`);
        const afterWindows = await client.command('browser.getClientWindows', {});
        const afterTree = await client.command('browsingContext.getTree', {});
        const afterTopIdList = afterTree.contexts.map((entry) => entry.context).sort();
        assert.equal(
          afterWindows.clientWindows.length,
          beforeWindows.clientWindows.length,
          `${site.key} opened a Firefox window automatically`,
        );
        assert.deepEqual(
          afterTopIdList,
          beforeTopIdList,
          `${site.key} added, removed, or replaced a top-level tab automatically`,
        );
        const sourceEntry = afterTree.contexts.find((entry) => entry.context === context);
        assert.ok(sourceEntry && sourceEntry.url === SOURCE_URL, `${site.key} moved the source tab`);
        if (site.key === 'cnn') {
          await pointerGesture(
            '#glasspeek-underlay-probe',
            context,
            'CNN outside-close probe',
          );
          await waitFor(
            async () => !(await previewContext()),
            'CNN outside click closes preview',
            6000,
          );
          preview = null;
          const underlayClicks = await evaluate(
            'Number(window.__glasspeekUnderlayClicks || 0)',
          );
          assert.equal(
            underlayClicks,
            0,
            'CNN outside close clicked the covered source-page control',
          );
          outsideClosePassed = true;
        }

        return {
          key: site.key,
          requestedUrl: site.url,
          status: 'passed',
          outcome,
          readyLatencyMs,
          durationMs: Date.now() - startedAt,
          finalUrl: embedded?.url || state.url,
          pageTitle: embedded?.title || state.pageTitle || state.errorTitle,
          textSample: embedded?.text?.slice(0, 240) || state.errorDetail,
          stayedInOverlay: true,
          releaseSurvived: true,
          nestedEvidence,
          nestedClickAudit,
          delayedWarningEvidence,
          outsideClosePassed: site.key === 'cnn' ? outsideClosePassed : null,
          openedFirefoxWindow: false,
          escapedTopLevel: false,
          screenshot,
        };
      } catch (error) {
        failure = error?.message || String(error);
        let extensionDiagnostic = null;
        if (preview) {
          extensionDiagnostic = await evaluate(
            `(async () => JSON.stringify(await browser.storage.local.get("gpOriginDiagnostic")))()`,
            preview.context,
          ).then((value) => JSON.parse(value).gpOriginDiagnostic || null)
            .catch(() => null);
        }
        const failureTree = await client.command('browsingContext.getTree', {}).catch(() => ({ contexts: [] }));
        const failureSource = failureTree.contexts.find((entry) => entry.context === context);
        const failureDescendants = flatten(
          failureTree.contexts.filter((entry) => entry.context === context),
        ).map((entry) => ({ context: entry.context, url: entry.url }));
        screenshot ||= await capture(`live-exact-${site.key}-failed.png`).catch(() => null);
        return {
          key: site.key,
          requestedUrl: site.url,
          status: 'failed',
          outcome,
          durationMs: Date.now() - startedAt,
          classes: state?.classes || '',
          finalUrl: embedded?.url || state?.url || '',
          pageTitle: embedded?.title || state?.pageTitle || state?.errorTitle || '',
          textSample: embedded?.text?.slice(0, 240) || state?.errorDetail || '',
          sourceUrl: failureSource?.url || '',
          descendantContexts: failureDescendants,
          extensionDiagnostic,
          nestedLink,
          nestedClickAudit,
          delayedWarningEvidence,
          screenshot,
          error: failure,
        };
      } finally {
        if (preview) {
          await pointerGesture('#close', preview.context, `${site.key} close`).catch(() => {});
          await waitFor(async () => !(await previewContext()), `${site.key} preview close`, 6000)
            .catch(() => {});
        }
        await evaluate(`(() => {
          document.getElementById('glasspeek-live-exact-link')?.remove();
          document.getElementById('glasspeek-underlay-probe')?.remove();
          delete window.__glasspeekUnderlayClicks;
        })()`).catch(() => {});
        const cleanup = await client.command('browsingContext.getTree', {}).catch(() => ({ contexts: [] }));
        for (const entry of cleanup.contexts) {
          if (!beforeTopIds.has(entry.context)) {
            await client.command('browsingContext.close', { context: entry.context }).catch(() => {});
          }
        }
        const sourceEntry = cleanup.contexts.find((entry) => entry.context === context);
        if (sourceEntry && sourceEntry.url !== SOURCE_URL) {
          await client.command('browsingContext.navigate', {
            context,
            url: SOURCE_URL,
            wait: 'complete',
          }, 60000).catch(() => {});
        }
        await client.command('browsingContext.activate', { context }).catch(() => {});
      }
    }

    const results = [];
    for (const site of SELECTED_SITES) {
      process.stderr.write(`[live-exact] ${site.key}\n`);
      results.push(await audit(site));
    }
    const failed = results.filter((entry) => entry.status !== 'passed');
    const report = {
      ok: failed.length === 0,
      browserVersion: session.capabilities.browserVersion,
      package: XPI,
      packageSha256: XPI_SHA256,
      sourceUrl: SOURCE_URL,
      exactPackage: true,
      results,
      artifacts: ARTIFACTS,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (client && installedExtensionId) {
      await client.command('webExtension.uninstall', {
        extension: installedExtensionId,
      }, 30000).catch(() => {});
    }
    if (client && sessionStarted) {
      await client.command('session.end', {}, 10000).catch(() => {});
    }
    client?.close();
    await terminate(firefox);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
