'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portArg = process.argv.find((value) => value.startsWith('--port='));
const port = portArg ? Number(portArg.slice('--port='.length)) : 9222;
const artifactArg = process.argv.find((value) => value.startsWith('--artifacts='));
const xpiArg = process.argv.find((value) => value.startsWith('--xpi='));
const xpiPath = xpiArg ? path.resolve(xpiArg.slice('--xpi='.length)) : null;
const includeLiveSites = process.argv.includes('--live-sites');
const skipZoom = process.argv.includes('--skip-zoom');
const biliOnly = process.argv.includes('--bili-only');
const sameSiteTop = process.argv.includes('--same-site-top');
const targetArg = process.argv.find((value) => value.startsWith('--target='));
const diagnosticTarget = targetArg
  ? targetArg.slice('--target='.length)
  : 'https://www.bilibili.com/video/BV1CHK46eEe7/';
const diagnosticUrl = new URL(diagnosticTarget);
const diagnosticRoute = `${diagnosticUrl.origin}${diagnosticUrl.pathname}`;
const diagnosticLabel = diagnosticUrl.hostname.replace(/[^a-z0-9.-]+/gi, '-');
const diagnosticTopUrl = (
  diagnosticUrl.hostname.endsWith('youtube.com') ||
  diagnosticUrl.hostname.endsWith('cnn.com')
)
  ? `${diagnosticUrl.origin}/robots.txt`
  : `${diagnosticUrl.origin}/`;
const artifacts = path.resolve(
  artifactArg ? artifactArg.slice('--artifacts='.length) : path.join(__dirname, 'artifacts'),
);

class BidiClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
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
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'error') {
        const error = new Error(`${message.error}: ${message.message}`);
        error.bidi = message;
        pending.reject(error);
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
    if (this.socket) this.socket.close();
  }
}

let activeClient = null;

function stage(label) {
  console.error(`[bidi] ${label}`);
}

function flatten(contexts, output = []) {
  for (const context of contexts || []) {
    output.push(context);
    flatten(context.children || [], output);
  }
  return output;
}

async function waitFor(fn, label, timeout = 12000, interval = 150) {
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

async function main() {
  const client = new BidiClient(`ws://127.0.0.1:${port}/session`);
  activeClient = client;
  stage('connect');
  await client.connect();
  stage('create session');
  const session = await client.command('session.new', {
    capabilities: { alwaysMatch: { browserName: 'firefox' } },
  }, 60000);
  const browserVersion = session.capabilities.browserVersion;
  if (biliOnly) {
    await client.command('session.subscribe', {
      events: ['network.beforeRequestSent', 'network.responseStarted'],
    });
  }
  let extensionId = null;
  if (xpiPath) {
    assert.ok(fs.existsSync(xpiPath), `test XPI does not exist: ${xpiPath}`);
    stage('install temporary test package');
    const installed = await client.command('webExtension.install', {
      extensionData: {
        type: 'archivePath',
        path: xpiPath,
      },
      'moz:permanent': false,
    }, 60000);
    extensionId = installed.extension;
    assert.equal(
      extensionId,
      '{88cdb8a1-2007-44be-9965-7b08e3518437}',
      'temporary extension id did not match GlassPeek',
    );
  }

  stage('find fixture tab');
  const top = await waitFor(async () => {
    const tree = await client.command('browsingContext.getTree', {});
    return tree.contexts.find(
      (candidate) => /^http:\/\/localtest\.me:8787\//.test(candidate.url),
    );
  }, 'test fixture context', 30000);
  const context = top.context;
  await client.command('browsingContext.activate', { context });

  async function evaluate(expression, targetContext = context) {
    const result = await client.command('script.evaluate', {
      expression,
      target: { context: targetContext },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    assert.equal(result.type, 'success', result.exceptionDetails && result.exceptionDetails.text);
    return result.result && result.result.value;
  }

  async function json(expression, targetContext = context) {
    const value = await evaluate(`JSON.stringify(${expression})`, targetContext);
    return JSON.parse(value);
  }

  async function longPress(selector, label) {
    const point = await topLevelPoint(selector, context, label);
    if (selector === '#glasspeek-diagnostic-link') {
      const viewport = await json(`({
        width: innerWidth,
        height: innerHeight,
        scrollX,
        scrollY,
        visibility: document.visibilityState,
        hit: (() => {
          const node = document.elementFromPoint(${point.x}, ${point.y});
          return node ? { tag: node.tagName, id: node.id, text: node.textContent?.slice(0, 80) } : null;
        })()
      })`);
      stage(`${label} pointer ${JSON.stringify({ point, viewport })}`);
    }
    try {
      await client.command('input.performActions', {
        context,
        actions: [{
          type: 'pointer',
          id: 'glasspeek-mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 700 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
      await client.command('input.releaseActions', { context });
    } catch (error) {
      if (selector !== '#glasspeek-diagnostic-link' || !/NS_ERROR_FAILURE/.test(error.message)) {
        throw error;
      }
      // Firefox 153's BiDi input synthesizer intermittently rejects pointer
      // actions on YouTube even for an in-viewport node. The ordinary fixture
      // suite and Bilibili run still cover a genuinely trusted long press; this
      // fallback uses the independent touch synthesizer and remains trusted.
      stage(`${label} using trusted touch fallback after Firefox BiDi mouse failure`);
      await client.command('input.performActions', {
        context,
        actions: [{
          type: 'pointer',
          id: 'glasspeek-touch',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 700 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      });
      await client.command('input.releaseActions', { context });
    }
  }

  function parentMap(contexts, parent = null, output = new Map()) {
    for (const item of contexts || []) {
      output.set(item.context, parent);
      parentMap(item.children || [], item.context, output);
    }
    return output;
  }

  async function frameOffset(parentContext, childContext, label) {
    const located = await client.command('browsingContext.locateNodes', {
      context: parentContext,
      locator: {
        type: 'context',
        value: { context: childContext },
      },
      maxNodeCount: 1,
    });
    const frame = located.nodes?.[0];
    assert.ok(frame?.sharedId, `${label} embedding frame was not found`);
    const result = await client.command('script.callFunction', {
      functionDeclaration: `(frame) => JSON.stringify((() => {
        const rect = frame.getBoundingClientRect();
        return {
          x: rect.left + frame.clientLeft,
          y: rect.top + frame.clientTop
        };
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
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`, targetContext);
    assert.ok(local && Number.isFinite(local.x) && Number.isFinite(local.y), `${label} is not actionable`);

    const tree = await client.command('browsingContext.getTree', { root: context });
    const parents = parentMap(tree.contexts);
    assert.ok(parents.has(targetContext), `${label} context is outside the active test tab`);
    let current = targetContext;
    let x = local.x;
    let y = local.y;
    while (current !== context) {
      const parent = parents.get(current);
      assert.ok(parent, `${label} has no parent browsing context`);
      const offset = await frameOffset(parent, current, label);
      x += offset.x;
      y += offset.y;
      current = parent;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  async function trustedClick(selector, targetContext, label) {
    const point = await topLevelPoint(selector, targetContext, label);
    await client.command('input.performActions', {
      context,
      actions: [{
        type: 'pointer',
        id: `glasspeek-click-${Date.now().toString(36)}`,
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await client.command('input.releaseActions', { context });
  }

  async function waitForPreview(label) {
    return waitFor(async () => {
      const nextTree = await client.command('browsingContext.getTree', { root: context });
      return flatten(nextTree.contexts).find((entry) => /\/preview\/preview\.html$/.test(entry.url));
    }, label);
  }

  async function waitForEmbedded(selector, urlPattern, label, preview = null) {
    const previewRoot = preview?.context || previewContext.context;
    return waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', { root: previewRoot });
      const candidates = flatten(tree.contexts).filter((entry) => urlPattern.test(entry.url));
      for (const candidate of candidates) {
        try {
          const exists = await evaluate(
            `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
            candidate.context,
          );
          if (exists) {
            const ready = await evaluate(
              `document.getElementById('surface')?.classList.contains('is-ready') === true`,
              previewRoot,
            );
            if (ready) return candidate;
          }
        } catch (_error) {
          // A navigation may leave a stale context in one tree snapshot.
        }
      }
      return null;
    }, label);
  }

  async function capture(targetContext, fileName) {
    const image = await client.command('browsingContext.captureScreenshot', {
      context: targetContext,
      origin: 'viewport',
      format: { type: 'image/png' },
    });
    fs.mkdirSync(artifacts, { recursive: true });
    const filePath = path.join(artifacts, fileName);
    fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
    return filePath;
  }

  await waitFor(async () => {
    const state = await json(`({
      readyState: document.readyState,
      linkCount: document.querySelectorAll('a[href]').length
    })`);
    return state.readyState === 'complete' && state.linkCount >= 10;
  }, 'fixture document ready', 30000);
  stage('fixture loaded');

  const fixture = await json(`({
    title: document.title,
    linkCount: document.querySelectorAll('a[href]').length,
    url: location.href
  })`);
  assert.equal(fixture.title, 'GlassPeek local acceptance fixtures');
  assert.ok(fixture.linkCount >= 10);

  if (biliOnly) {
    if (sameSiteTop) {
      stage(`navigate fixture tab to ${diagnosticUrl.hostname} top-level page`);
      await client.command('browsingContext.navigate', {
        context,
        url: diagnosticTopUrl,
        wait: 'complete',
      }, 60_000);
      await client.command('browsingContext.activate', { context });
      await evaluate(`(() => {
        const anchor = document.createElement('a');
        anchor.id = 'glasspeek-diagnostic-link';
        anchor.href = ${JSON.stringify(diagnosticTarget)};
        anchor.textContent = ${JSON.stringify(`GlassPeek exact ${diagnosticUrl.hostname} diagnostic`)};
        Object.assign(anchor.style, {
          position: 'fixed',
          left: '24px',
          top: '140px',
          zIndex: '2147483647',
          padding: '20px',
          color: 'white',
          background: '#245cff',
          pointerEvents: 'auto',
          display: 'block',
          isolation: 'isolate'
        });
        document.documentElement.append(anchor);
        return true;
      })()`);
      // Keep the trusted pointer action adjacent to injection. Highly dynamic
      // home pages (notably YouTube) can replace top-level DOM nodes shortly
      // after their initial load has completed.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (
      !sameSiteTop &&
      diagnosticTarget !== 'https://www.bilibili.com/video/BV1CHK46eEe7/'
    ) {
      await evaluate(`(() => {
        const anchor = document.querySelector('#live-bilibili');
        if (!anchor) return false;
        anchor.href = ${JSON.stringify(diagnosticTarget)};
        return true;
      })()`);
    }
    stage(`open exact ${diagnosticUrl.hostname} URL`);
    await longPress(
      sameSiteTop ? '#glasspeek-diagnostic-link' : '#live-bilibili',
      `exact ${diagnosticUrl.hostname} page`,
    );
    const preview = await waitForPreview(`GlassPeek ${diagnosticUrl.hostname} preview surface`);
    await new Promise((resolve) => setTimeout(resolve, 12_000));

    const tree = await client.command('browsingContext.getTree', {
      root: context,
    });
    const contexts = flatten(tree.contexts);
    const parents = parentMap(tree.contexts);
    const target = contexts.find(
      (entry) =>
        parents.get(entry.context) === context &&
        entry.url.startsWith(diagnosticRoute),
    ) || null;
    const surface = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      title: document.getElementById('pageTitle')?.textContent || '',
      error: document.getElementById('errorTitle')?.textContent || ''
    })`, preview.context);
    let page = null;
    if (target) {
      page = await json(`({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: (document.body?.innerText || '').slice(0, 1000),
        heading: document.querySelector('h1')?.innerText || '',
        video: Boolean(document.querySelector('video')),
        youtubeApp: Boolean(document.querySelector('ytd-app,ytd-watch-flexy')),
        main: Boolean(document.querySelector('main,[role="main"]')),
        player: Boolean(document.querySelector('.bpx-player-container,[aria-label="哔哩哔哩播放器"]')),
        missing: (document.body?.innerText || '').includes('视频不见了'),
        redirectText: (document.body?.innerText || '').includes('自动跳转至首页')
      })`, target.context).catch((error) => ({ error: error.message }));
    }
    assert.match(
      surface.classes,
      /\bis-ready\b/,
      `${diagnosticUrl.hostname} preview did not reach ready state`,
    );
    assert.ok(
      surface.url.startsWith(diagnosticRoute),
      `${diagnosticUrl.hostname} toolbar lost the requested original-page route`,
    );
    assert.ok(target, `direct ${diagnosticUrl.hostname} target context was not found`);
    assert.equal(parents.get(preview.context), context);
    assert.equal(parents.get(target.context), context);
    assert.ok(
      (page?.bodyText || '').trim().length > 40,
      `${diagnosticUrl.hostname} target did not render meaningful original-page content`,
    );
    if (diagnosticUrl.hostname.endsWith('bilibili.com')) {
      assert.equal(page?.missing, false, 'Bilibili rendered its video-missing error page');
      assert.equal(page?.redirectText, false, 'Bilibili rendered an automatic home redirect');
      assert.doesNotMatch(page?.url || '', /^https:\/\/m\.bilibili\.com\//i);
      assert.ok(page?.video || page?.player, 'Bilibili player did not render');
    } else if (diagnosticUrl.hostname.endsWith('youtube.com')) {
      assert.ok(page?.video || page?.youtubeApp, 'YouTube watch application did not render');
    } else if (diagnosticUrl.hostname.endsWith('cnn.com')) {
      assert.ok(page?.heading || page?.main, 'CNN article structure did not render');
    }
    const screenshot = await capture(context, `diag-live-${diagnosticLabel}.png`);
    const safeHeaderNames = new Set([
      'content-security-policy',
      'location',
      'referer',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'x-frame-options',
    ]);
    const network = client.events
      .filter((event) => event.method?.startsWith('network.'))
      .map((event) => event.params)
      .filter((params) => (params.request?.url || '').startsWith(diagnosticRoute))
      .map((params) => ({
        event: params.response ? 'responseStarted' : 'beforeRequestSent',
        context: params.context,
        navigation: params.navigation,
        redirectCount: params.redirectCount,
        url: params.request?.url,
        method: params.request?.method,
        requestHeaders: (params.request?.headers || [])
          .filter((header) => safeHeaderNames.has(header.name.toLowerCase()))
          .map((header) => ({ name: header.name, value: header.value?.value })),
        status: params.response?.status,
        responseHeaders: (params.response?.headers || [])
          .filter((header) => safeHeaderNames.has(header.name.toLowerCase()))
          .map((header) => ({ name: header.name, value: header.value?.value })),
      }));
    console.log(JSON.stringify({
      ok: true,
      browserVersion,
      extensionId,
      surface,
      page,
      screenshot,
      network,
      contexts: contexts.map((entry) => ({
        context: entry.context,
        parent: entry.parent,
        url: entry.url,
      })),
    }, null, 2));
    await client.command('session.end', {});
    client.close();
    activeClient = null;
    return;
  }

  stage('verify ordinary page iframes are never hijacked');
  const ordinaryTree = await client.command('browsingContext.getTree', { root: context });
  const ordinaryFrame = flatten(ordinaryTree.contexts).find((entry) =>
    /\/embed\?from=ordinary-iframe$/.test(entry.url));
  assert.ok(ordinaryFrame, 'ordinary iframe context not found');
  const ordinaryBeforeTree = await client.command('browsingContext.getTree', {});
  const ordinaryBeforeIds = new Set(flatten(ordinaryBeforeTree.contexts).map((entry) => entry.context));
  await trustedClick('#new-preview-link', ordinaryFrame.context, 'ordinary iframe target blank link');
  const ordinaryOpened = await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', {});
    return nextTree.contexts.find((entry) =>
      !ordinaryBeforeIds.has(entry.context) &&
      /\/spa#initial$/.test(entry.url));
  }, 'ordinary iframe browser tab');
  const ordinaryIframeNewTab = ordinaryOpened.url;
  await client.command('browsingContext.close', { context: ordinaryOpened.context });
  await client.command('browsingContext.activate', { context });

  stage('perform long press');
  await longPress('a[href^="/embed"]', 'embeddable fixture');

  stage('wait for preview surface');
  let previewContext = await waitForPreview('GlassPeek preview surface');
  const extensionUrl = new URL(previewContext.url);
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;

  stage('wait for embedded page');
  const ready = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      target: document.getElementById('target')?.dataset.requestedUrl || '',
      errorHidden: document.getElementById('error')?.hidden
    })`, previewContext.context);
    if (state.classes.includes('is-ready')) return state;
    throw new Error(`preview state ${JSON.stringify(state)}`);
  }, 'embeddable page ready', 15000);

  assert.match(ready.url, /\/embed#fragment-target$/);
  assert.match(ready.target, /\/embed#fragment-target$/);
  assert.equal(ready.errorHidden, true);
  const isolation = await json(`({
    hostExists: Boolean(document.querySelector('glasspeek-root')),
    shadowClosed: document.querySelector('glasspeek-root')?.shadowRoot === null,
    pageStayedPut: location.pathname === '/'
  })`);
  assert.deepEqual(isolation, { hostExists: true, shadowClosed: true, pageStayedPut: true });

  const previewShot = await capture(context, '01-preview-ready.png');
  const zoomControllerTree = await client.command('browsingContext.getTree', {});
  const zoomController = zoomControllerTree.contexts.find(
    (entry) => entry.url.startsWith(`${extensionOrigin}/welcome/welcome.html`),
  );
  assert.ok(zoomController, 'extension controller page was not available for zoom audit');

  async function setSourceZoom(factor) {
    const applied = await evaluate(`(async () => {
      const tabs = await browser.tabs.query({});
      const tab = tabs.find((item) => item.url?.startsWith('http://localtest.me:8787/'));
      if (!tab) throw new Error('fixture-tab-missing');
      await browser.tabs.setZoom(tab.id, ${Number(factor)});
      return browser.tabs.getZoom(tab.id);
    })()`, zoomController.context);
    assert.ok(Math.abs(applied - factor) < 0.02, `Firefox did not apply ${factor} zoom`);
    await client.command('browsingContext.activate', { context });
    previewContext = await waitForPreview(`${Math.round(factor * 100)}% preview context`);
    await waitFor(async () => {
      const state = await json(`({
        ready: document.getElementById('surface')?.classList.contains('is-ready'),
        width: innerWidth,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth + 1
      })`, previewContext.context);
      return state.ready && !state.overflow ? state : null;
    }, `${Math.round(factor * 100)}% preview reflow`);
    await trustedClick('#more', previewContext.context, `${Math.round(factor * 100)}% more menu`);
    await waitFor(async () => {
      return await evaluate(`document.getElementById('menu').hidden === false`, previewContext.context);
    }, `${Math.round(factor * 100)}% menu open`);
    await trustedClick('#more', previewContext.context, `${Math.round(factor * 100)}% close menu`);
    await waitFor(async () => {
      return await evaluate(`document.getElementById('menu').hidden === true`, previewContext.context);
    }, `${Math.round(factor * 100)}% menu close`);
    return {
      zoom: applied,
      screenshot: await capture(
        context,
        `01-preview-${Math.round(factor * 100)}-percent.png`,
      ),
    };
  }

  let zoomAudit = [];
  if (skipZoom) {
    stage('skip zoom sweep for focused headless regression');
  } else {
    stage('verify preview interaction at 70%, 100%, and 150% zoom');
    const zoom70 = await setSourceZoom(0.7);
    const zoom100 = await setSourceZoom(1);
    const zoom150 = await setSourceZoom(1.5);
    await setSourceZoom(1);
    zoomAudit = [zoom70, zoom100, zoom150];
  }

  stage('pin preview');
  await trustedClick('#pin', previewContext.context, 'pin preview button');
  const pinned = await json(`({
    pinned: document.getElementById('surface').classList.contains('is-pinned'),
    pressed: document.getElementById('pin').getAttribute('aria-pressed')
  })`, previewContext.context);
  assert.deepEqual(pinned, { pinned: true, pressed: 'true' });

  stage('verify original-page mode exposes no reader or video substitute controls');
  await trustedClick('#more', previewContext.context, 'more actions button');
  await waitFor(async () => {
    const hidden = await evaluate(`document.getElementById('menu').hidden`, previewContext.context);
    return hidden === false;
  }, 'preview actions menu');
  const originalModeControls = await json(`({
    classes: document.getElementById('surface').className,
    targetVisible: getComputedStyle(document.getElementById('target')).pointerEvents !== 'none',
    errorHidden: document.getElementById('error').hidden,
    readerAction: Boolean(document.querySelector('[data-action="reader"], #reader, #readerView')),
    targetUrl: document.getElementById('target').src
  })`, previewContext.context);
  assert.match(originalModeControls.classes, /is-ready/);
  assert.equal(originalModeControls.targetVisible, true);
  assert.equal(originalModeControls.errorHidden, true);
  assert.equal(originalModeControls.readerAction, false);
  assert.match(originalModeControls.targetUrl, /\/embed#fragment-target$/);
  await trustedClick('#more', previewContext.context, 'close original-page actions menu');

  const previewTree = await client.command('browsingContext.getTree', { root: previewContext.context });
  const targetContext = flatten(previewTree.contexts).find((entry) => /\/embed#fragment-target$/.test(entry.url));
  assert.ok(targetContext, 'target iframe context not found');
  stage('navigate inside preview with a trusted pointer');
  await trustedClick('#child-link', targetContext.context, 'ordinary child link');
  const finalUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed\/child\?from=nested#child-fragment$/.test(value) ? value : null;
  }, 'redirected target URL');
  const trustedChildContext = await waitForEmbedded(
    '#child-fragment',
    /\/embed\/child\?from=nested#child-fragment$/,
    'trusted child navigation context',
  );
  const trustedPointerNavigation = await evaluate(
    `sessionStorage.getItem('glasspeek-last-click-trusted')`,
    trustedChildContext.context,
  );
  assert.equal(trustedPointerNavigation, 'true');

  stage('verify back and forward history controls');
  const historyReady = await waitFor(async () => {
    const value = await json(`({
      backDisabled: document.getElementById('back').disabled,
      forwardDisabled: document.getElementById('forward').disabled
    })`, previewContext.context);
    return value.backDisabled === false ? value : null;
  }, 'back navigation enabled');
  assert.equal(historyReady.forwardDisabled, true);

  stage('verify Alt+Left and Alt+Right history shortcuts');
  async function historyShortcut(arrowValue, shortcutContext) {
    await client.command('input.performActions', {
      context: shortcutContext,
      actions: [{
        type: 'key',
        id: 'glasspeek-history-shortcut',
        actions: [
          { type: 'keyDown', value: '\uE00A' },
          { type: 'keyDown', value: arrowValue },
          { type: 'keyUp', value: arrowValue },
          { type: 'keyUp', value: '\uE00A' },
        ],
      }],
    });
    await client.command('input.releaseActions', { context: shortcutContext });
  }
  await historyShortcut('\uE012', trustedChildContext.context);
  const keyboardBackUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed#fragment-target$/.test(value) ? value : null;
  }, 'Alt+Left preview history back');
  const keyboardBackContext = await waitForEmbedded(
    '#child-link',
    /\/embed#fragment-target$/,
    'Alt+Left destination context',
  );
  await historyShortcut('\uE014', keyboardBackContext.context);
  const keyboardForwardUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed\/child\?from=nested#child-fragment$/.test(value) ? value : null;
  }, 'Alt+Right preview history forward');
  await waitForEmbedded(
    '#child-fragment',
    /\/embed\/child\?from=nested#child-fragment$/,
    'Alt+Right destination context',
  );

  await trustedClick('#back', previewContext.context, 'preview back button');
  const backUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed#fragment-target$/.test(value) ? value : null;
  }, 'preview history back');
  await waitForEmbedded(
    '#child-link',
    /\/embed#fragment-target$/,
    'button back destination context',
  );
  await trustedClick('#forward', previewContext.context, 'preview forward button');
  const forwardUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed\/child\?from=nested#child-fragment$/.test(value) ? value : null;
  }, 'preview history forward');
  await waitForEmbedded(
    '#child-fragment',
    /\/embed\/child\?from=nested#child-fragment$/,
    'button forward destination context',
  );

  await trustedClick('#back', previewContext.context, 'preview back button');
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed#fragment-target$/.test(value) ? value : null;
  }, 'return to parent fixture');

  stage('verify target=_blank stays useful in the current preview');
  const parentTarget = await waitForEmbedded(
    '#top-target-link',
    /\/embed#fragment-target$/,
    'returned parent target context',
  );

  stage('verify target=_top is flattened into the preview');
  await trustedClick('#top-target-link', parentTarget.context, 'target top link');
  const topTargetUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed\/child\?from=top-target#child-fragment$/.test(value) ? value : null;
  }, 'target top link navigation');
  await waitForEmbedded(
    '#child-fragment',
    /\/embed\/child\?from=top-target#child-fragment$/,
    'target top destination context',
  );
  await trustedClick('#back', previewContext.context, 'preview back button');
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed#fragment-target$/.test(value) ? value : null;
  }, 'return after target top link');

  async function verifyExternalTarget(selector, expectedPattern, label) {
    const allBefore = await client.command('browsingContext.getTree', {});
    const beforeIds = new Set(flatten(allBefore.contexts).map((entry) => entry.context));
    const embedded = await waitForEmbedded(
      selector,
      /\/embed#fragment-target$/,
      `${label} parent context`,
    );
    await trustedClick(selector, embedded.context, label);
    const opened = await waitFor(async () => {
      const nextTree = await client.command('browsingContext.getTree', {});
      return nextTree.contexts.find((entry) =>
        !beforeIds.has(entry.context) &&
        expectedPattern.test(entry.url));
    }, label, 12000);
    await client.command('browsingContext.close', { context: opened.context });
    await client.command('browsingContext.activate', { context });
    return opened.url;
  }

  stage('verify downloads are explicit while scripted window.open stays in the preview');
  const downloadUrl = await verifyExternalTarget(
    '#download-link',
    /\/embed\/child\?from=download#child-fragment$/,
    'download target',
  );
  const beforeWindowOpenTree = await client.command('browsingContext.getTree', {});
  const beforeWindowOpenTopIds = new Set(
    beforeWindowOpenTree.contexts.map((entry) => entry.context),
  );
  const windowOpenParent = await waitForEmbedded(
    '#window-open',
    /\/embed#fragment-target$/,
    'scripted window.open parent context',
  );
  await trustedClick('#window-open', windowOpenParent.context, 'scripted window.open target');
  const windowOpenUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed\/child\?from=window-open#child-fragment$/.test(value) ? value : null;
  }, 'scripted window.open preview navigation');
  await waitForEmbedded(
    '#child-fragment',
    /\/embed\/child\?from=window-open#child-fragment$/,
    'scripted window.open destination context',
  );
  const afterWindowOpenTree = await client.command('browsingContext.getTree', {});
  const unexpectedWindowOpenContext = afterWindowOpenTree.contexts.find(
    (entry) =>
      !beforeWindowOpenTopIds.has(entry.context) &&
      /\/embed\/child\?from=window-open#child-fragment$/.test(entry.url),
  );
  assert.equal(
    unexpectedWindowOpenContext,
    undefined,
    'scripted window.open escaped into a top-level Firefox tab or window',
  );
  await trustedClick('#back', previewContext.context, 'return after scripted window.open');
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/embed#fragment-target$/.test(value) ? value : null;
  }, 'return to parent after scripted window.open');

  const targetBlankParent = await waitForEmbedded(
    '#new-preview-link',
    /\/embed#fragment-target$/,
    'target blank parent context',
  );
  await trustedClick('#new-preview-link', targetBlankParent.context, 'target blank link');
  const targetBlankUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/spa#initial$/.test(value) ? value : null;
  }, 'target blank link navigation');

  const targetBlankContext = await waitForEmbedded(
    '#push-state',
    /\/spa#initial$/,
    'target blank destination context',
  );

  stage('verify pushState adds history while replaceState replaces it');
  await trustedClick('#push-state', targetBlankContext.context, 'SPA pushState button');
  const pushStateUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/spa\?step=1#pushed$/.test(value) ? value : null;
  }, 'SPA pushState URL');
  await trustedClick('#replace-state', targetBlankContext.context, 'SPA replaceState button');
  const replaceStateUrl = await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/spa\?step=2#replaced$/.test(value) ? value : null;
  }, 'SPA replaceState URL');
  await trustedClick('#back', previewContext.context, 'preview back after replaceState');
  const replaceBackState = await waitFor(async () => {
    const value = await json(`({
      url: document.getElementById('pageUrl').textContent,
      forwardDisabled: document.getElementById('forward').disabled
    })`, previewContext.context);
    return /\/spa#initial$/.test(value.url) && value.forwardDisabled === false
      ? value
      : null;
  }, 'replaceState did not create an extra history entry');
  const replaceBackUrl = replaceBackState.url;
  await trustedClick('#forward', previewContext.context, 'preview forward after replaceState');
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/spa\?step=2#replaced$/.test(value) ? value : null;
  }, 'forward to replaced SPA entry');

  stage('verify fragment-only back and forward settle without a document commit');
  const fragmentContext = await waitForEmbedded(
    '#change-hash',
    /\/spa\?step=2#replaced$/,
    'fragment-only SPA context',
    previewContext,
  );
  await trustedClick('#change-hash', fragmentContext.context, 'SPA hash-only button');
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/spa\?step=2#hash-only$/.test(value) ? value : null;
  }, 'hash-only SPA URL');
  await trustedClick('#back', previewContext.context, 'preview back from hash-only entry');
  await waitFor(async () => {
    const value = await json(`({
      url: document.getElementById('pageUrl').textContent,
      forwardDisabled: document.getElementById('forward').disabled
    })`, previewContext.context);
    return /\/spa\?step=2#replaced$/.test(value.url) &&
      value.forwardDisabled === false
      ? value
      : null;
  }, 'fragment-only back navigation');
  await trustedClick('#forward', previewContext.context, 'preview forward to hash-only entry');
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/spa\?step=2#hash-only$/.test(value) ? value : null;
  }, 'fragment-only forward navigation');

  stage('close from target iframe with Escape');
  await client.command('input.performActions', {
    context: fragmentContext.context,
    actions: [{
      type: 'key',
      id: 'glasspeek-keyboard',
      actions: [
        { type: 'keyDown', value: '\uE00C' },
        { type: 'keyUp', value: '\uE00C' },
      ],
    }],
  });
  await client.command('input.releaseActions', { context: fragmentContext.context });
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'preview close from iframe Escape');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  stage('verify stop and reload on a slow navigation');
  await longPress('a[href^="/slow"]', 'slow fixture');
  const slowPreview = await waitForPreview('slow preview surface');
  await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      stopHidden: document.getElementById('stop')?.hidden
    })`, slowPreview.context);
    return state.classes.includes('is-loading') && state.stopHidden === false ? state : null;
  }, 'slow preview loading state');
  await trustedClick('#stop', slowPreview.context, 'stop loading button');
  const stoppedState = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      title: document.getElementById('loadingTitle')?.textContent || '',
      reloadHidden: document.getElementById('reload')?.hidden
    })`, slowPreview.context);
    return state.classes.includes('is-stopped') ? state : null;
  }, 'stopped preview state');
  assert.equal(stoppedState.reloadHidden, false);
  await trustedClick('#reload', slowPreview.context, 'reload stopped preview');
  const reloadedSlowUrl = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || ''
    })`, slowPreview.context);
    return state.classes.includes('is-ready') && /\/slow\?ms=2500$/.test(state.url)
      ? state.url
      : null;
  }, 'reloaded slow preview', 18000);
  await trustedClick('#close', slowPreview.context, 'close slow preview');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'slow preview close');
  await new Promise((resolve) => setTimeout(resolve, 800));

  stage('verify sandboxed target-blank form submission');
  await longPress('a[href="/form"]', 'form fixture');
  const formPreview = await waitForPreview('form preview surface');
  await waitFor(async () => {
    const classes = await evaluate(
      `document.getElementById('surface')?.className || ''`,
      formPreview.context,
    );
    return classes.includes('is-ready');
  }, 'form preview ready');
  const formTarget = await waitForEmbedded(
    '#submit-form',
    /\/form$/,
    'form target context',
    formPreview,
  );
  await trustedClick('#submit-form', formTarget.context, 'form submit button');
  const formResultUrl = await waitFor(async () => {
    const value = await evaluate(
      `document.getElementById('pageUrl').textContent`,
      formPreview.context,
    );
    return /\/form-result#submitted$/.test(value) ? value : null;
  }, 'form result navigation');
  const formResultContext = await waitForEmbedded(
    '#submitted',
    /\/form-result#submitted$/,
    'form result context',
    formPreview,
  );
  const formResult = await json(`({
    message: document.getElementById('result-message')?.textContent || '',
    notes: document.getElementById('result-notes')?.textContent || ''
  })`, formResultContext.context);
  assert.deepEqual(formResult, {
    message: 'GlassPeek form value',
    notes: 'sandboxed form submission',
  });
  await trustedClick('#close', formPreview.context, 'close form preview');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'form preview close');
  await new Promise((resolve) => setTimeout(resolve, 500));

  stage('verify a blocked large page stays on an original-URL error state');
  const beforeLargeWindows = await client.command('browser.getClientWindows', {});
  const beforeLargeTree = await client.command('browsingContext.getTree', {});
  await longPress('a[href="/large-reader"]', 'large reader fixture');
  const largeBlockedPreview = await waitForPreview('large blocked preview surface');
  const largeBlocked = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      target: document.getElementById('target')?.dataset.requestedUrl || '',
      readerSurface: Boolean(document.querySelector('#reader, #readerView, [data-action="reader"]')),
      actions: Array.from(document.querySelectorAll('#error button')).map((button) => button.textContent.trim())
    })`, largeBlockedPreview.context);
    return state.classes.includes('is-error') ? state : null;
  }, 'large blocked original-page state', 30000);
  assert.match(largeBlocked.url, /\/large-reader$/);
  assert.match(largeBlocked.target, /\/large-reader$/);
  assert.equal(largeBlocked.readerSurface, false);
  assert.equal(largeBlocked.actions.length, 3);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterLargeWindows = await client.command('browser.getClientWindows', {});
  const afterLargeTree = await client.command('browsingContext.getTree', {});
  assert.equal(afterLargeWindows.clientWindows.length, beforeLargeWindows.clientWindows.length);
  assert.equal(afterLargeTree.contexts.length, beforeLargeTree.contexts.length);
  const largeBlockedShot = await capture(context, '02-large-page-original-error.png');
  await trustedClick('#close', largeBlockedPreview.context, 'close large blocked preview');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'large blocked preview close');
  await new Promise((resolve) => setTimeout(resolve, 800));

  stage('verify blocked pages never auto-open and expose no reader fallback');
  const beforeBlockedWindows = await client.command('browser.getClientWindows', {});
  const beforeBlockedTree = await client.command('browsingContext.getTree', {});
  await longPress('a[href="/xfo"]', 'X-Frame-Options fixture');
  const blockedPreview = await waitForPreview('blocked-page preview surface');
  const blockedState = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      target: document.getElementById('target')?.dataset.requestedUrl || '',
      title: document.getElementById('errorTitle')?.textContent || '',
      readerSurface: Boolean(document.querySelector('#reader, #readerView, [data-action="reader"]')),
      actions: Array.from(document.querySelectorAll('#error button')).map((button) => button.textContent.trim())
    })`, blockedPreview.context);
    return state.classes.includes('is-error') ? state : null;
  }, 'blocked original-page error state', 22000);
  assert.match(blockedState.classes, /is-error/);
  assert.match(blockedState.url, /\/xfo$/);
  assert.match(blockedState.target, /\/xfo$/);
  assert.match(blockedState.title, /禁止|protects itself|无法载入|could not be loaded/i);
  assert.equal(blockedState.readerSurface, false);
  assert.equal(blockedState.actions.length, 3);
  assert.ok(blockedState.actions.every(Boolean));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterBlockedWindows = await client.command('browser.getClientWindows', {});
  const afterBlockedTree = await client.command('browsingContext.getTree', {});
  assert.equal(afterBlockedWindows.clientWindows.length, beforeBlockedWindows.clientWindows.length);
  assert.equal(afterBlockedTree.contexts.length, beforeBlockedTree.contexts.length);
  const blockedShot = await capture(context, '02-blocked-original-error.png');

  stage('verify compatibility window');
  const beforeCompatTree = await client.command('browsingContext.getTree', {});
  const beforeCompatIds = new Set(flatten(beforeCompatTree.contexts).map((entry) => entry.context));
  await trustedClick('#compat', blockedPreview.context, 'interactive window action');
  const compatibilityContext = await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', {});
    return nextTree.contexts.find((entry) =>
      !beforeCompatIds.has(entry.context) &&
      /^http:\/\/localtest\.me:8787\/xfo$/.test(entry.url));
  }, 'browser-managed compatibility window', 12000);
  const compatibilityShot = await capture(compatibilityContext.context, '03-compatibility-window-content.png');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'failed preview closes after interactive handoff');

  stage('verify the interactive window is reused instead of duplicated');
  await client.command('browsingContext.activate', { context });
  await longPress('a[href="/xfo"]', 'X-Frame-Options fixture reopen');
  const secondBlockedPreview = await waitForPreview('second blocked-page preview');
  await waitFor(async () => {
    const classes = await evaluate(
      `document.getElementById('surface')?.className || ''`,
      secondBlockedPreview.context,
    );
    return classes.includes('is-error');
  }, 'second blocked original-page state', 22000);
  const beforeReuseTree = await client.command('browsingContext.getTree', {});
  const topLevelCountBeforeReuse = beforeReuseTree.contexts.length;
  await trustedClick('#compat', secondBlockedPreview.context, 'reuse interactive window action');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', {});
    const sameWindow = flatten(nextTree.contexts).find((entry) => entry.context === compatibilityContext.context);
    const topLevelCount = nextTree.contexts.length;
    return sameWindow &&
      /^http:\/\/localtest\.me:8787\/xfo$/.test(sameWindow.url) &&
      topLevelCount === topLevelCountBeforeReuse;
  }, 'interactive window single instance');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'second failed preview closes after handoff');
  await client.command('browsingContext.close', { context: compatibilityContext.context });

  stage('capture extension interface audit');
  const extensionAuditTree = await client.command('browsingContext.getTree', {});
  const extensionAuditPage = extensionAuditTree.contexts.find(
    (entry) => entry.url.startsWith(`${extensionOrigin}/`),
  );
  assert.ok(extensionAuditPage, 'extension welcome tab was not available for UI audit');
  const extensionAuditContext = extensionAuditPage.context;

  async function auditExtensionPage(name, relativeUrl, viewport, fileName) {
    await client.command('browsingContext.activate', { context: extensionAuditContext });
    await client.command('browsingContext.setViewport', {
      context: extensionAuditContext,
      viewport,
      devicePixelRatio: 1,
    });
    const pageUrl = `${extensionOrigin}/${relativeUrl}`;
    const currentPageUrl = await evaluate('location.href', extensionAuditContext);
    if (currentPageUrl !== pageUrl) {
      await evaluate(
        `setTimeout(() => location.assign(${JSON.stringify(pageUrl)}), 0); true`,
        extensionAuditContext,
      );
      await waitFor(async () => {
        const tree = await client.command('browsingContext.getTree', {});
        const entry = flatten(tree.contexts).find(
          (item) => item.context === extensionAuditContext,
        );
        return entry?.url === pageUrl;
      }, `${name} extension page navigation`);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    const state = await json(`({
      title: document.title,
      lang: document.documentElement.lang,
      width: innerWidth,
      height: innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      heading: document.querySelector('h1, h2, [role="heading"]')?.textContent?.trim() || '',
      controls: Array.from(document.querySelectorAll('button, a, input, select, textarea')).length,
      saveStateHealthy: !document.getElementById('saveState') ||
        document.getElementById('saveState').classList.contains('gp-badge--success'),
      activeSectionVisible: !document.querySelector('.settings-section.is-active') ||
        (getComputedStyle(document.querySelector('.settings-section.is-active')).display !== 'none' &&
          Number(getComputedStyle(document.querySelector('.settings-section.is-active')).opacity) > 0.99),
      unlabeledControls: Array.from(document.querySelectorAll('button, a, input, select, textarea')).filter((element) => {
        const text = element.textContent?.trim() || '';
        return !text && !element.getAttribute('aria-label') && !element.getAttribute('title') && !element.labels?.length;
      }).length
    })`, extensionAuditContext);
    assert.equal(state.overflowX, false, `${name} has horizontal overflow`);
    assert.equal(state.activeSectionVisible, true, `${name} active section is not visible`);
    assert.equal(state.unlabeledControls, 0, `${name} has unlabeled interactive controls`);
    if (name === 'Settings') {
      assert.equal(state.saveStateHealthy, true, 'Settings initialization reported an error');
    }
    assert.ok(state.title, `${name} is missing a document title`);
    const screenshotPath = await capture(extensionAuditContext, fileName);
    return { name, ...state, screenshot: screenshotPath };
  }

  const uiAudit = [];
  uiAudit.push(await auditExtensionPage('Welcome', 'welcome/welcome.html', { width: 1280, height: 900 }, '04-welcome.png'));
  uiAudit.push(await auditExtensionPage('Settings', 'options/options.html', { width: 1280, height: 900 }, '05-settings.png'));
  uiAudit.push(await auditExtensionPage('Popup', 'popup/popup.html', { width: 420, height: 720 }, '06-popup.png'));
  uiAudit.push(await auditExtensionPage('Sidebar', 'sidebar/sidebar.html', { width: 420, height: 800 }, '07-sidebar.png'));
  await client.command('browsingContext.close', { context: extensionAuditContext }).catch(() => {});

  let liveSiteAudit = null;
  if (includeLiveSites) {
    stage('verify real Bilibili, YouTube, and CNN stay in preview-first overlays');
    async function auditLivePreview(
      selector,
      urlPattern,
      label,
      screenshotName,
    ) {
      await client.command('browsingContext.activate', { context });
      const beforeWindows = await client.command('browser.getClientWindows', {});
      const beforeTree = await client.command('browsingContext.getTree', {});
      const beforeTopIds = new Set(
        beforeTree.contexts.map((entry) => entry.context),
      );

      await longPress(selector, label);
      const livePreview = await waitForPreview(`${label} preview surface`);
      const state = await waitFor(async () => {
        const value = await json(`({
          classes: document.getElementById('surface')?.className || '',
          url: document.getElementById('pageUrl')?.textContent || '',
          target: document.getElementById('target')?.dataset.requestedUrl || '',
          pageTitle: document.getElementById('pageTitle')?.textContent || '',
          errorTitle: document.getElementById('errorTitle')?.textContent || '',
          readerSurface: Boolean(document.querySelector('#reader, #readerView, [data-action="reader"]'))
        })`, livePreview.context);
        const settled = /\bis-(?:ready|error)\b/.test(value.classes);
        return settled
          ? value
          : null;
      }, `${label} settled preview`, 45000);
      assert.match(state.url, urlPattern, `${label} preview lost the requested URL`);
      assert.match(state.target, urlPattern, `${label} iframe did not receive the original URL`);
      assert.equal(state.readerSurface, false, `${label} exposed a removed reader surface`);

      const afterWindows = await client.command('browser.getClientWindows', {});
      assert.equal(
        afterWindows.clientWindows.length,
        beforeWindows.clientWindows.length,
        `${label} unexpectedly opened a Firefox window`,
      );
      const afterTree = await client.command('browsingContext.getTree', {});
      const escaped = afterTree.contexts.find(
        (entry) =>
          !beforeTopIds.has(entry.context) &&
          urlPattern.test(entry.url),
      );
      if (escaped) {
        process.stderr.write(
          `[bidi] ${label} unexpected top-level context: ${JSON.stringify({
            beforeTopIds: [...beforeTopIds],
            beforeWindows: beforeWindows.clientWindows,
            afterWindows: afterWindows.clientWindows,
            contexts: flatten(afterTree.contexts).map((entry) => ({
              context: entry.context,
              parent: entry.parent,
              originalOpener: entry.originalOpener,
              clientWindow: entry.clientWindow,
              url: entry.url,
            })),
            state,
          }, null, 2)}\n`,
        );
        await capture(context, `debug-${screenshotName}`).catch(() => {});
      }
      assert.equal(escaped, undefined, `${label} escaped into a top-level Firefox tab`);

      // Let Firefox's compositor paint the final original-page or blocked state.
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      const embeddedTree = await client.command('browsingContext.getTree', {
        root: livePreview.context,
      });
      const embeddedContext = flatten(embeddedTree.contexts).find(
        (entry) => entry.parent === livePreview.context,
      );
      const embedded = embeddedContext
        ? await json(`({
            url: location.href,
            title: document.title,
            text: document.body?.innerText?.slice(0, 700) || ""
          })`, embeddedContext.context).catch(() => null)
        : null;
      const screenshot = await capture(context, screenshotName);
      await trustedClick('#close', livePreview.context, `close ${label} preview`);
      await waitFor(async () => {
        const tree = await client.command('browsingContext.getTree', { root: context });
        return !flatten(tree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
      }, `${label} preview close`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        ...state,
        embedded,
        screenshot,
        stayedInOverlay: true,
        openedFirefoxWindow: false,
      };
    }

    const bilibili = await auditLivePreview(
      '#live-bilibili',
      /^https:\/\/www\.bilibili\.com\/video\/BV1CHK46eEe7\//,
      'real Bilibili video',
      '08-live-bilibili-preview-first.png',
    );
    const youtube = await auditLivePreview(
      '#live-youtube',
      /^https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/,
      'real YouTube video',
      '09-live-youtube-preview-first.png',
    );
    const cnn = await auditLivePreview(
      '#live-cnn',
      /^https:\/\/www\.cnn\.com\/2026\/07\/23\/world\/live-news\/iran-war-trump/,
      'real CNN article',
      '10-live-cnn-preview-first.png',
    );
    liveSiteAudit = {
      bilibili,
      youtube,
      cnn,
      previewFirst: true,
      noAutomaticFirefoxWindow: true,
    };
  }

  const result = {
    ok: true,
    browserVersion,
    extensionId,
    fixture,
    ordinaryIframeNewTab,
    trustedPointerNavigation,
    ready,
    zoomAudit,
    pinned,
    originalModeControls,
    finalUrl,
    keyboardBackUrl,
    keyboardForwardUrl,
    backUrl,
    forwardUrl,
    topTargetUrl,
    downloadUrl,
    windowOpenUrl,
    targetBlankUrl,
    pushStateUrl,
    replaceStateUrl,
    replaceBackUrl,
    closedFromIframeEscape: true,
    stoppedState,
    reloadedSlowUrl,
    formResultUrl,
    formResult,
    largeBlocked,
    blockedState,
    compatibilityWindow: true,
    compatibilitySingleInstance: true,
    uiAudit,
    liveSiteAudit,
    screenshots: [
      previewShot,
      ...zoomAudit.map((entry) => entry.screenshot),
      largeBlockedShot,
      blockedShot,
      compatibilityShot,
      ...uiAudit.map((entry) => entry.screenshot),
      ...(liveSiteAudit
        ? [
            liveSiteAudit.bilibili.screenshot,
            liveSiteAudit.youtube.screenshot,
            liveSiteAudit.cnn.screenshot,
          ]
        : []),
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  await client.command('session.end', {});
  client.close();
  activeClient = null;
}

main().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try {
    await activeClient?.command('session.end', {}, 2000);
  } catch (_cleanupError) {
    // The browser may already have torn the session down.
  }
  activeClient?.close();
  process.exit(1);
});
