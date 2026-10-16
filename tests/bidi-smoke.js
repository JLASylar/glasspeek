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
const liveSiteArg = process.argv.find((value) => value.startsWith('--live-site='));
const requestedLiveSite = liveSiteArg
  ? liveSiteArg.slice('--live-site='.length).trim().toLowerCase()
  : '';
const skipZoom = process.argv.includes('--skip-zoom');
const zoomOnly = process.argv.includes('--zoom-only');
const earlyHistoryOnly = process.argv.includes('--early-history-only');
const unverifiedLocalTransport = process.argv.includes('--unverified-local-transport');
const artifacts = path.resolve(
  artifactArg ? artifactArg.slice('--artifacts='.length) : path.join(__dirname, 'artifacts'),
);
const LIVE_SITE_TIMEOUT_MS = 30000;
const LIVE_SITE_CASES = Object.freeze([
  {
    key: 'google',
    category: 'search',
    selector: '#live-google-search',
    requestedUrl: 'https://www.google.com/search?q=firefox',
    urlPattern: /^https:\/\/www\.google\.com\/search\?/i,
    label: 'Google search results',
    screenshotName: '08-01-live-google-search.png',
  },
  {
    key: 'bing',
    category: 'search',
    selector: '#live-bing-search',
    requestedUrl: 'https://www.bing.com/search?q=firefox',
    urlPattern: /^https:\/\/(?:www|cn)\.bing\.com\/search\?/i,
    label: 'Bing search results',
    screenshotName: '08-02-live-bing-search.png',
  },
  {
    key: 'duckduckgo',
    category: 'search',
    selector: '#live-duckduckgo-search',
    requestedUrl: 'https://duckduckgo.com/?q=firefox',
    urlPattern: /^https:\/\/duckduckgo\.com\/(?:\?|$)/i,
    label: 'DuckDuckGo search results',
    screenshotName: '08-03-live-duckduckgo-search.png',
  },
  {
    key: 'wikipedia',
    category: 'knowledge',
    selector: '#live-wikipedia',
    requestedUrl: 'https://en.wikipedia.org/wiki/Firefox',
    urlPattern: /^https:\/\/en\.wikipedia\.org\/wiki\/Firefox(?:[?#]|$)/i,
    label: 'Wikipedia article',
    screenshotName: '08-04-live-wikipedia.png',
  },
  {
    key: 'stack-overflow',
    category: 'development',
    selector: '#live-stack-overflow',
    requestedUrl: 'https://stackoverflow.com/questions/16624919/why-iframe-dosent-work-for-yahoo-com',
    urlPattern: /^https:\/\/stackoverflow\.com\/questions\/16624919(?:\/|[?#]|$)/i,
    label: 'Stack Overflow question',
    screenshotName: '08-05-live-stack-overflow.png',
  },
  {
    key: 'npm',
    category: 'development',
    selector: '#live-npm',
    requestedUrl: 'https://www.npmjs.com/package/react',
    urlPattern: /^https:\/\/www\.npmjs\.com\/package\/react(?:[/?#]|$)/i,
    label: 'npm package page',
    screenshotName: '08-06-live-npm.png',
  },
  {
    key: 'reddit',
    category: 'forum',
    selector: '#live-reddit',
    requestedUrl: 'https://www.reddit.com/r/firefox/',
    urlPattern: /^https:\/\/(?:www|old|new)\.reddit\.com\/r\/firefox(?:[/?#]|$)/i,
    label: 'Reddit Firefox community',
    screenshotName: '08-07-live-reddit.png',
  },
  {
    key: 'hacker-news',
    category: 'forum',
    selector: '#live-hacker-news',
    requestedUrl: 'https://news.ycombinator.com/news',
    urlPattern: /^https:\/\/news\.ycombinator\.com\/news(?:[?#]|$)/i,
    label: 'Hacker News front page',
    screenshotName: '08-08-live-hacker-news.png',
  },
  {
    key: 'amazon',
    category: 'commerce',
    selector: '#live-amazon',
    requestedUrl: 'https://www.amazon.com/s?k=firefox',
    urlPattern: /^https:\/\/www\.amazon\.com\/s\?/i,
    label: 'Amazon search results',
    screenshotName: '08-09-live-amazon.png',
  },
  {
    key: 'taobao',
    category: 'commerce',
    selector: '#live-taobao',
    requestedUrl: 'https://item.taobao.com/item.htm?id=1000812607847',
    urlPattern: /^https:\/\/item\.taobao\.com\/item\.htm\?/i,
    label: 'Taobao item page',
    screenshotName: '08-10-live-taobao.png',
  },
  {
    key: 'jd',
    category: 'commerce',
    selector: '#live-jd',
    requestedUrl: 'https://item.jd.com/100012043978.html',
    urlPattern: /^https:\/\/item\.jd\.com\/100012043978\.html(?:[?#]|$)/i,
    label: 'JD item page',
    screenshotName: '08-11-live-jd.png',
  },
  {
    key: 'bbc',
    category: 'news',
    selector: '#live-bbc',
    requestedUrl: 'https://www.bbc.com/news',
    urlPattern: /^https:\/\/www\.bbc\.com\/news(?:[/?#]|$)/i,
    label: 'BBC News page',
    screenshotName: '08-12-live-bbc.png',
  },
  {
    key: 'cnn',
    category: 'news',
    selector: '#live-cnn',
    requestedUrl: 'https://www.cnn.com/world',
    urlPattern: /^https:\/\/(?:www|edition)\.cnn\.com\/world(?:[/?#]|$)/i,
    label: 'CNN World page',
    screenshotName: '08-13-live-cnn.png',
  },
  {
    key: 'bilibili',
    category: 'video',
    selector: '#live-bilibili',
    requestedUrl: 'https://www.bilibili.com/video/BV1CHK46eEe7/',
    urlPattern: /^https:\/\/www\.bilibili\.com\/video\/BV1CHK46eEe7(?:[/?#]|$)/i,
    label: 'Bilibili video page',
    screenshotName: '08-14-live-bilibili.png',
  },
  {
    key: 'youtube',
    category: 'video',
    selector: '#live-youtube',
    requestedUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    urlPattern: /^https:\/\/www\.youtube\.com\/watch\?[^#]*v=dQw4w9WgXcQ/i,
    label: 'YouTube video page',
    screenshotName: '08-15-live-youtube.png',
  },
]);
const SELECTED_LIVE_SITE_CASES = requestedLiveSite
  ? LIVE_SITE_CASES.filter((site) => site.key === requestedLiveSite)
  : LIVE_SITE_CASES;

if (requestedLiveSite && SELECTED_LIVE_SITE_CASES.length === 0) {
  throw new Error(`Unknown live-site key: ${requestedLiveSite}`);
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
           y: rect.top + frame.clientTop,
           width: rect.width,
           height: rect.height,
           backgroundColor: getComputedStyle(frame).backgroundColor,
           colorScheme: getComputedStyle(frame).colorScheme,
           opacity: getComputedStyle(frame).opacity,
           visibility: getComputedStyle(frame).visibility,
           pointerEvents: getComputedStyle(frame).pointerEvents,
           clipPath: getComputedStyle(frame).clipPath
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
      const candidates = flatten(nextTree.contexts)
        .filter((entry) => /\/preview\/preview\.html$/.test(entry.url))
        .reverse();
      for (const candidate of candidates) {
        try {
          const live = await evaluate(
            `Boolean(document.getElementById('surface') && document.getElementById('more'))`,
            candidate.context,
          );
          if (live) return candidate;
        } catch (_error) {
          // Firefox can leave the old child browsing-context ID in one tree
          // snapshot while rebuilding a frame after a tab zoom change.
        }
      }
      return null;
    }, label);
  }

  async function waitForEmbedded(selector, urlPattern, label, preview = null) {
    const previewRoot = preview?.context || previewContext.context;
    return waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', { root: context });
      const parents = parentMap(tree.contexts);
      const candidates = flatten(tree.contexts).filter(
        (entry) => parents.get(entry.context) === context,
      );
      for (const candidate of candidates) {
        try {
          const snapshot = await json(
            `({
              exists: Boolean(document.querySelector(${JSON.stringify(selector)})),
              url: location.href
            })`,
            candidate.context,
          );
          urlPattern.lastIndex = 0;
          if (snapshot.exists && urlPattern.test(snapshot.url)) {
            const ready = await evaluate(
              `document.getElementById('surface')?.classList.contains('is-ready') === true`,
              previewRoot,
            );
            if (ready) return { ...candidate, url: snapshot.url };
          }
        } catch (_error) {
          // A navigation may leave a stale context in one tree snapshot.
        }
      }
      return null;
    }, label);
  }

  function contextDistance(parents, childContext, ancestorContext) {
    let current = childContext;
    let distance = 0;
    const visited = new Set();
    while (current && current !== ancestorContext && !visited.has(current)) {
      visited.add(current);
      current = parents.get(current);
      distance += 1;
    }
    return current === ancestorContext ? distance : -1;
  }

  async function waitForNested(
    selector,
    urlPattern,
    label,
    ancestorContext,
    minimumDepth = 1,
  ) {
    return waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', {
        root: context,
      });
      const parents = parentMap(tree.contexts);
      const candidates = flatten(tree.contexts).filter(
        (entry) =>
          contextDistance(parents, entry.context, ancestorContext) >=
          minimumDepth,
      );
      for (const candidate of candidates) {
        try {
          const snapshot = await json(
            `({
              exists: Boolean(document.querySelector(${JSON.stringify(selector)})),
              url: location.href,
              title: document.title
            })`,
            candidate.context,
          );
          urlPattern.lastIndex = 0;
          if (snapshot.exists && urlPattern.test(snapshot.url)) {
            return {
              ...candidate,
              ...snapshot,
              depth: contextDistance(
                parents,
                candidate.context,
                ancestorContext,
              ),
            };
          }
        } catch (_error) {
          // Protected descendants may be replacing a stale browsing context.
        }
      }
      return null;
    }, label, 18000);
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

  stage('verify synthetic page events cannot create a preview');
  const syntheticControllerTree = await client.command(
    'browsingContext.getTree',
    {},
  );
  const syntheticController = syntheticControllerTree.contexts.find(
    (entry) => /\/welcome\/welcome\.html$/.test(entry.url),
  );
  assert.ok(
    syntheticController,
    'extension controller page was not available for synthetic-event audit',
  );
  await waitFor(async () => {
    const ready = await evaluate(
      `document.readyState !== 'loading' &&
        typeof globalThis.GlassPeek === 'object' &&
        Boolean(globalThis.GlassPeek.DEFAULTS)`,
      syntheticController.context,
    );
    return ready === true;
  }, 'extension controller script readiness');
  const syntheticSettingKeys = [
    'longPress',
    'longPressDelay',
    'modifier',
    'modifierKey',
    'hoverSpace',
    'drag',
    'dragDropZone',
  ];
  const originalSyntheticSettings = JSON.parse(await evaluate(`(async () => {
    const keys = ${JSON.stringify(syntheticSettingKeys)};
    const defaults = Object.fromEntries(
      keys.map((key) => [key, GlassPeek.DEFAULTS[key]])
    );
    return JSON.stringify(await browser.storage.sync.get(defaults));
  })()`, syntheticController.context));
  try {
    await evaluate(`(async () => {
      await browser.storage.sync.set({
        longPress: true,
        longPressDelay: 300,
        modifier: true,
        modifierKey: 'Shift',
        hoverSpace: true,
        drag: true,
        dragDropZone: false
      });
      return true;
    })()`, syntheticController.context);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const syntheticEvents = await json(`(() => {
      const anchor = document.querySelector('a[href^="/embed"]');
      if (!anchor) throw new Error('synthetic-anchor-missing');
      anchor.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = anchor.getBoundingClientRect();
      const point = {
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2)
      };
      const trust = {};
      const dispatch = (event) => {
        trust[event.type] = event.isTrusted;
        anchor.dispatchEvent(event);
      };
      anchor.addEventListener('click', (event) => {
        if (!event.isTrusted) event.preventDefault();
      }, { once: true });
      dispatch(new PointerEvent('pointerover', {
        bubbles: true,
        composed: true,
        pointerId: 901,
        pointerType: 'mouse',
        ...point
      }));
      dispatch(new MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true,
        shiftKey: true,
        button: 0,
        ...point
      }));
      dispatch(new KeyboardEvent('keydown', {
        bubbles: true,
        composed: true,
        cancelable: true,
        key: ' ',
        code: 'Space'
      }));
      dispatch(new DragEvent('dragstart', {
        bubbles: true,
        composed: true,
        cancelable: true,
        ...point
      }));
      dispatch(new DragEvent('drop', {
        bubbles: true,
        composed: true,
        cancelable: true,
        ...point
      }));
      dispatch(new DragEvent('dragend', {
        bubbles: true,
        composed: true,
        cancelable: true,
        ...point
      }));
      dispatch(new PointerEvent('pointerdown', {
        bubbles: true,
        composed: true,
        cancelable: true,
        pointerId: 902,
        pointerType: 'mouse',
        button: 0,
        ...point
      }));
      window.__glasspeekSyntheticTrust = trust;
      return trust;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const syntheticRelease = await json(`(() => {
      const anchor = document.querySelector('a[href^="/embed"]');
      const rect = anchor.getBoundingClientRect();
      const event = new PointerEvent('pointerup', {
        bubbles: true,
        composed: true,
        cancelable: true,
        pointerId: 902,
        pointerType: 'mouse',
        button: 0,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2)
      });
      window.__glasspeekSyntheticTrust.pointerup = event.isTrusted;
      anchor.dispatchEvent(event);
      return window.__glasspeekSyntheticTrust;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const syntheticTree = await client.command('browsingContext.getTree', {
      root: context,
    });
    const syntheticPreviewCount = flatten(syntheticTree.contexts).filter(
      (entry) => /\/preview\/preview\.html$/.test(entry.url),
    ).length;
    assert.deepEqual(
      Object.values({ ...syntheticEvents, ...syntheticRelease }),
      Array(Object.keys({ ...syntheticEvents, ...syntheticRelease }).length).fill(false),
      'the synthetic-event fixture unexpectedly produced a trusted event',
    );
    assert.equal(
      syntheticPreviewCount,
      0,
      'page-script synthetic pointer/click/keydown/drag events created a preview',
    );
  } finally {
    await evaluate(`(async () => {
      await browser.storage.sync.set(${JSON.stringify(originalSyntheticSettings)});
      return true;
    })()`, syntheticController.context);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const syntheticTrustAudit = {
    eventTypes: [
      'pointerover',
      'click',
      'keydown',
      'dragstart',
      'drop',
      'dragend',
      'pointerdown',
      'pointerup',
    ],
    allUntrusted: true,
    previewCount: 0,
  };

  if (earlyHistoryOnly) {
    stage('verify document-start pushState and replaceState survive target config startup');
    await longPress('#early-history-link', 'early SPA history fixture');
    const earlyPreview = await waitForPreview('early SPA preview surface');
    await waitFor(async () => {
      const classes = await evaluate(
        `document.getElementById('surface')?.className || ''`,
        earlyPreview.context,
      );
      return classes.includes('is-ready');
    }, 'early SPA target ready');
    const earlyTarget = await waitForEmbedded(
      '#early-history-ready',
      /\/early-history(?:\?phase=replace#two)?$/,
      'early SPA target context',
      earlyPreview,
    );
    const settledTarget = await waitFor(async () => {
      const state = await json(`({
        readyState: document.readyState,
        url: location.href
      })`, earlyTarget.context);
      return state.readyState === 'complete' ? state : null;
    }, 'early SPA target lifecycle complete');
    const startup = await json(`window.__glasspeekEarlyHistory`, earlyTarget.context);
    const ready = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      backDisabled: document.getElementById('back')?.disabled === true
    })`, earlyPreview.context);
    assert.match(
      ready.url,
      /\/early-history\?phase=replace#two$/,
      `startup history did not reach the surface: ${JSON.stringify({ ready, startup, settledTarget })}`,
    );
    assert.equal(ready.backDisabled, false);
    assert.equal(startup.readyState, 'loading');
    assert.equal(startup.bridgeInstalled, true);
    assert.match(startup.originalUrl, /\/early-history$/);
    assert.match(startup.finalUrl, /\/early-history\?phase=replace#two$/);

    await trustedClick('#back', earlyPreview.context, 'early SPA history back');
    const backUrl = await waitFor(async () => {
      const state = await json(`({
        url: document.getElementById('pageUrl')?.textContent || '',
        forwardDisabled: document.getElementById('forward')?.disabled === true
      })`, earlyPreview.context);
      return /\/early-history$/.test(state.url) && state.forwardDisabled === false
        ? state.url
        : null;
    }, 'early SPA back reached the pre-push entry');
    await trustedClick('#forward', earlyPreview.context, 'early SPA history forward');
    const forwardUrl = await waitFor(async () => {
      const value = await evaluate(
        `document.getElementById('pageUrl')?.textContent || ''`,
        earlyPreview.context,
      );
      return /\/early-history\?phase=replace#two$/.test(value) ? value : null;
    }, 'early SPA forward reached the replaced pushed entry');
    console.log(JSON.stringify({
      ok: true,
      browserVersion,
      extensionId,
      fixture,
      earlyHistory: { ready, startup, settledTarget, backUrl, forwardUrl },
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
      errorHidden: document.getElementById('error')?.hidden
    })`, previewContext.context);
    if (state.classes.includes('is-ready')) return state;
    throw new Error(`preview state ${JSON.stringify(state)}`);
  }, 'embeddable page ready', 15000);

  assert.match(ready.url, /\/embed#fragment-target$/);
  assert.equal(ready.errorHidden, true);
  const initialTargetContext = await waitForEmbedded(
    'h1',
    /\/embed#fragment-target$/,
    'initial target for compositor geometry',
    previewContext,
  );
  const normalControlGeometry = await frameOffset(
    context,
    previewContext.context,
    'normal control geometry',
  );
  const normalTargetGeometry = await frameOffset(
    context,
    initialTargetContext.context,
    'normal target geometry',
  );
  assert.ok(
    Math.abs(normalControlGeometry.height - 44) <= 1,
    `ready control iframe must be physically 44px high, got ${normalControlGeometry.height}`,
  );
  assert.equal(normalControlGeometry.clipPath, 'none');
  assert.ok(
    normalControlGeometry.y + normalControlGeometry.height <=
      normalTargetGeometry.y + 1,
    'ready control iframe overlaps the target canvas',
  );
  assert.equal(normalTargetGeometry.visibility, 'visible');
  assert.equal(normalTargetGeometry.pointerEvents, 'auto');

  stage('verify menu overlay expands and releases the control iframe');
  await trustedClick('#more', previewContext.context, 'open preview menu');
  const expandedMenuGeometry = await waitFor(async () => {
    const menuOpen = await evaluate(
      `document.getElementById('menu')?.hidden === false`,
      previewContext.context,
    );
    const controlGeometry = await frameOffset(
      context,
      previewContext.context,
      'expanded menu control geometry',
    );
    const targetGeometry = await frameOffset(
      context,
      initialTargetContext.context,
      'expanded menu target geometry',
    );
    return menuOpen &&
      controlGeometry.height > normalControlGeometry.height + 100 &&
      targetGeometry.visibility === 'hidden' &&
      targetGeometry.pointerEvents === 'none'
      ? { controlGeometry, targetGeometry }
      : null;
  }, 'expanded menu owns the full preview surface');
  await trustedClick('#more', previewContext.context, 'close preview menu');
  const restoredMenuGeometry = await waitFor(async () => {
    const menuClosed = await evaluate(
      `document.getElementById('menu')?.hidden === true`,
      previewContext.context,
    );
    const controlGeometry = await frameOffset(
      context,
      previewContext.context,
      'restored control geometry',
    );
    const targetGeometry = await frameOffset(
      context,
      initialTargetContext.context,
      'restored target geometry',
    );
    return menuClosed &&
      Math.abs(controlGeometry.height - 44) <= 1 &&
      targetGeometry.visibility === 'visible' &&
      targetGeometry.pointerEvents === 'auto'
      ? { controlGeometry, targetGeometry }
      : null;
  }, 'closing the menu releases the target canvas');
  const visualGeometryAudit = {
    normal: {
      controlHeight: normalControlGeometry.height,
      controlBottom: normalControlGeometry.y + normalControlGeometry.height,
      targetTop: normalTargetGeometry.y,
      clipPath: normalControlGeometry.clipPath,
    },
    menu: {
      controlHeight: expandedMenuGeometry.controlGeometry.height,
      targetVisibility: expandedMenuGeometry.targetGeometry.visibility,
      targetPointerEvents: expandedMenuGeometry.targetGeometry.pointerEvents,
    },
    restored: {
      controlHeight: restoredMenuGeometry.controlGeometry.height,
      targetVisibility: restoredMenuGeometry.targetGeometry.visibility,
      targetPointerEvents: restoredMenuGeometry.targetGeometry.pointerEvents,
    },
  };
  const isolation = await json(`({
    hostExists: Boolean(document.querySelector('glasspeek-root')),
    shadowClosed: document.querySelector('glasspeek-root')?.shadowRoot === null,
    pageStayedPut: location.pathname === '/'
  })`);
  assert.deepEqual(isolation, { hostExists: true, shadowClosed: true, pageStayedPut: true });

  stage('verify click-through protection');
  await evaluate(`(() => {
    window.__glasspeekUnderlyingEvents = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      document.addEventListener(type, () => window.__glasspeekUnderlyingEvents.push(type), true);
    }
  })()`);
  const previewRect = await frameOffset(context, previewContext.context, 'outside-close shield');
  const viewport = await json(`({ width: innerWidth, height: innerHeight })`);
  const outsidePoint = [
    { x: 4, y: 4 },
    { x: viewport.width - 4, y: 4 },
    { x: 4, y: viewport.height - 4 },
    { x: viewport.width - 4, y: viewport.height - 4 },
  ].find((point) =>
    point.x < previewRect.x ||
    point.x > previewRect.x + previewRect.width ||
    point.y < previewRect.y ||
    point.y > previewRect.y + previewRect.height
  );
  assert.ok(outsidePoint, 'no outside point was available for click-through testing');
  await client.command('input.performActions', {
    context,
    actions: [{
      type: 'pointer',
      id: 'glasspeek-outside-close',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', ...outsidePoint, duration: 0, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
  await client.command('input.releaseActions', { context });
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'outside click closes the preview');
  assert.deepEqual(
    await json(`window.__glasspeekUnderlyingEvents`),
    [],
    'outside-close gesture leaked to the underlying page',
  );

  stage('verify the release that triggered a preview cannot immediately close it');
  const activationControllerTree = await client.command('browsingContext.getTree', {});
  const activationController = activationControllerTree.contexts.find(
    (entry) => entry.url.startsWith(`${extensionOrigin}/welcome/welcome.html`),
  );
  assert.ok(
    activationController,
    'extension controller page was not available for activation-release audit',
  );
  const activationSettingKeys = [
    'position',
    'sizeMode',
    'widthPx',
    'heightPx',
    'rememberPosition',
    'rememberSize',
    'clickOutsideClose',
    'longPressDelay',
  ];
  const originalActivationSettings = JSON.parse(await evaluate(`(async () => {
    const keys = ${JSON.stringify(activationSettingKeys)};
    const defaults = Object.fromEntries(
      keys.map((key) => [key, GlassPeek.DEFAULTS[key]])
    );
    return JSON.stringify(await browser.storage.sync.get(defaults));
  })()`, activationController.context));
  await evaluate(`(async () => {
    await browser.storage.sync.set({
      position: 'center',
      sizeMode: 'px',
      widthPx: 400,
      heightPx: 300,
      rememberPosition: false,
      rememberSize: false,
      clickOutsideClose: true,
      longPressDelay: 500
    });
    return true;
  })()`, activationController.context);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const activationSourceBefore = await json(`(() => {
    const anchor = document.querySelector('a[href^="/embed"]');
    anchor.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = anchor.getBoundingClientRect();
    sessionStorage.removeItem('glasspeek-last-click-trusted');
    window.__glasspeekActivationClicks = 0;
    document.addEventListener('click', () => {
      window.__glasspeekActivationClicks += 1;
    }, true);
    return {
      url: location.href,
      point: {
        x: Math.round(rect.left + Math.min(6, rect.width / 4)),
        y: Math.round(rect.top + rect.height / 2)
      }
    };
  })()`);
  const activationPointerId = 'glasspeek-activation-release';
  let activationPointerDown = false;
  let activationPreview = null;
  let activationPreviewRect = null;
  try {
    await client.command('input.performActions', {
      context,
      actions: [{
        type: 'pointer',
        id: activationPointerId,
        parameters: { pointerType: 'mouse' },
        actions: [
          {
            type: 'pointerMove',
            x: activationSourceBefore.point.x,
            y: activationSourceBefore.point.y,
            duration: 0,
            origin: 'viewport',
          },
          { type: 'pointerDown', button: 0 },
        ],
      }],
    });
    activationPointerDown = true;
    activationPreview = await waitForPreview('activation preview before pointer release');
    activationPreviewRect = await frameOffset(
      context,
      activationPreview.context,
      'activation preview before pointer release',
    );
    const releasePointIsOutside =
      activationSourceBefore.point.x < activationPreviewRect.x ||
      activationSourceBefore.point.x > activationPreviewRect.x + activationPreviewRect.width ||
      activationSourceBefore.point.y < activationPreviewRect.y ||
      activationSourceBefore.point.y > activationPreviewRect.y + activationPreviewRect.height;
    assert.equal(
      releasePointIsOutside,
      true,
      'activation-release fixture did not place the release point outside the preview',
    );

    await client.command('input.performActions', {
      context,
      actions: [{
        type: 'pointer',
        id: activationPointerId,
        parameters: { pointerType: 'mouse' },
        actions: [{ type: 'pointerUp', button: 0 }],
      }],
    });
    activationPointerDown = false;
    await client.command('input.releaseActions', { context });
    await new Promise((resolve) => setTimeout(resolve, 700));

    const afterReleaseTree = await client.command('browsingContext.getTree', { root: context });
    assert.ok(
      flatten(afterReleaseTree.contexts).some(
        (entry) => entry.context === activationPreview.context,
      ),
      'the pointer release that triggered the preview immediately closed it',
    );
    await waitFor(async () => {
      const classes = await evaluate(
        `document.getElementById('surface')?.className || ''`,
        activationPreview.context,
      );
      return classes.includes('is-ready');
    }, 'activation preview remains ready after pointer release');
    const activationSourceAfter = await json(`({
      url: location.href,
      clickCount: window.__glasspeekActivationClicks,
      trustedClick: sessionStorage.getItem('glasspeek-last-click-trusted')
    })`);
    assert.equal(
      activationSourceAfter.url,
      activationSourceBefore.url,
      'the activation release navigated the source page',
    );
    assert.equal(
      activationSourceAfter.clickCount,
      0,
      'the activation release leaked a click to the source page',
    );
    assert.equal(
      activationSourceAfter.trustedClick,
      null,
      'the activation release recorded a trusted source-page click',
    );
  } finally {
    if (activationPointerDown) {
      await client.command('input.performActions', {
        context,
        actions: [{
          type: 'pointer',
          id: activationPointerId,
          parameters: { pointerType: 'mouse' },
          actions: [{ type: 'pointerUp', button: 0 }],
        }],
      }).catch(() => {});
      await client.command('input.releaseActions', { context }).catch(() => {});
    }
    await evaluate(`(async () => {
      const original = ${JSON.stringify(originalActivationSettings)};
      await browser.storage.sync.set(original);
      return true;
    })()`, activationController.context);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.ok(activationPreview && activationPreviewRect);
  const activationOutsidePoint = [
    { x: 4, y: 4 },
    { x: viewport.width - 4, y: 4 },
    { x: 4, y: viewport.height - 4 },
    { x: viewport.width - 4, y: viewport.height - 4 },
  ].find((point) =>
    point.x < activationPreviewRect.x ||
    point.x > activationPreviewRect.x + activationPreviewRect.width ||
    point.y < activationPreviewRect.y ||
    point.y > activationPreviewRect.y + activationPreviewRect.height
  );
  assert.ok(
    activationOutsidePoint,
    'no outside point was available after the activation-release audit',
  );
  await evaluate(`window.__glasspeekUnderlyingEvents = []`);
  await client.command('input.performActions', {
    context,
    actions: [{
      type: 'pointer',
      id: 'glasspeek-post-activation-outside-close',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', ...activationOutsidePoint, duration: 0, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
  await client.command('input.releaseActions', { context });
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some(
      (entry) => entry.context === activationPreview.context,
    );
  }, 'fresh outside gesture closes the activation preview');
  assert.deepEqual(
    await json(`window.__glasspeekUnderlyingEvents`),
    [],
    'fresh outside gesture after activation leaked to the source page',
  );
  assert.equal(
    await evaluate(`location.href`, context),
    activationSourceBefore.url,
    'fresh outside gesture after activation navigated the source page',
  );
  const activationReleaseAudit = {
    releasePoint: activationSourceBefore.point,
    previewRect: activationPreviewRect,
    sourceStayedPut: true,
    sourceClickCount: 0,
    survivedRelease: true,
    freshOutsideGestureClosed: true,
  };

  await longPress('a[href^="/embed"]', 'reopen after outside-close test');
  try {
    previewContext = await waitForPreview('reopened preview surface');
  } catch (error) {
    const reopenDebug = await json(`({
      events: window.__glasspeekUnderlyingEvents || [],
      hostPresent: Boolean(document.querySelector('glasspeek-root')),
      activeElement: document.activeElement?.tagName || '',
      href: location.href
    })`).catch(() => null);
    const reopenTree = await client.command('browsingContext.getTree', { root: context }).catch(() => null);
    process.stderr.write(`[bidi] reopen debug: ${JSON.stringify({
      reopenDebug,
      contexts: reopenTree ? flatten(reopenTree.contexts).map((entry) => ({
        context: entry.context,
        parent: entry.parent,
        url: entry.url,
      })) : null,
    }, null, 2)}\n`);
    throw error;
  }
  await waitFor(async () => {
    const classes = await evaluate(
      `document.getElementById('surface')?.className || ''`,
      previewContext.context,
    );
    return classes.includes('is-ready');
  }, 'reopened preview ready');

  const previewShot = await capture(context, '01-preview-ready.png');
  const zoomControllerTree = await client.command('browsingContext.getTree', {});
  const zoomController = zoomControllerTree.contexts.find(
    (entry) => entry.url.startsWith(`${extensionOrigin}/welcome/welcome.html`),
  );
  assert.ok(zoomController, 'extension controller page was not available for zoom audit');
  stage('verify Firefox history recording');
  const initialHistory = JSON.parse(await evaluate(`(async () => JSON.stringify(
    await browser.history.search({
      text: ${JSON.stringify(ready.url)},
      startTime: 0,
      maxResults: 20
    })
  ))()`, zoomController.context));
  assert.ok(
    initialHistory.some((entry) => /\/embed#fragment-target$/.test(entry.url)),
    'the previewed URL was not written to Firefox history',
  );

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
    await new Promise((resolve) => setTimeout(resolve, 600));
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
    assert.equal(zoomOnly, false, '--zoom-only cannot be combined with --skip-zoom');
    stage('skip zoom sweep for focused headless regression');
  } else {
    stage('verify preview interaction at 70%, 100%, and 150% zoom');
    const zoom70 = await setSourceZoom(0.7);
    const zoom100 = await setSourceZoom(1);
    const zoom150 = await setSourceZoom(1.5);
    await setSourceZoom(1);
    zoomAudit = [zoom70, zoom100, zoom150];
  }
  if (zoomOnly) {
    console.log(JSON.stringify({
      ok: true,
      browserVersion,
      extensionId,
      fixture,
      ready,
      visualGeometryAudit,
      activationReleaseAudit,
      zoomAudit,
      screenshots: [previewShot, ...zoomAudit.map((entry) => entry.screenshot)],
    }, null, 2));
    await client.command('session.end', {});
    client.close();
    activeClient = null;
    return;
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
    errorHidden: document.getElementById('error').hidden,
    readerAction: Boolean(document.querySelector('[data-action="reader"], #reader, #readerView')),
    nestedTarget: Boolean(document.querySelector('#target, iframe[src^="http"]'))
  })`, previewContext.context);
  assert.match(originalModeControls.classes, /is-ready/);
  assert.equal(originalModeControls.errorHidden, true);
  assert.equal(originalModeControls.readerAction, false);
  assert.equal(originalModeControls.nestedTarget, false);
  await trustedClick('#more', previewContext.context, 'close original-page actions menu');

  const previewTree = await client.command('browsingContext.getTree', { root: context });
  const previewParents = parentMap(previewTree.contexts);
  const targetContext = flatten(previewTree.contexts).find(
    (entry) =>
      previewParents.get(entry.context) === context &&
      /\/embed#fragment-target$/.test(entry.url),
  );
  assert.ok(targetContext, 'target iframe context not found');
  assert.equal(previewParents.get(previewContext.context), context);
  assert.equal(previewParents.get(targetContext.context), context);
  assert.notEqual(previewParents.get(targetContext.context), previewContext.context);
  const targetFrameAppearance = await frameOffset(
    context,
    targetContext.context,
    'target canvas appearance',
  );
  assert.match(targetFrameAppearance.backgroundColor, /rgba?\(\s*255,\s*255,\s*255/);
  assert.equal(targetFrameAppearance.colorScheme, 'light');
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
  await waitFor(async () => {
    const title = await evaluate(
      `document.getElementById('pageTitle')?.textContent || ''`,
      previewContext.context,
    );
    return /Nested navigation fixture/i.test(title) ? title : null;
  }, 'trusted target content-script binding');

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
    await trustedClick('body', shortcutContext, 'focus preview target for history shortcut');
    await client.command('input.performActions', {
      context,
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
    await client.command('input.releaseActions', { context });
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

  stage('verify A to B to A pushState keeps three isolated history entries');
  const loopContext = await waitForEmbedded(
    '#change-hash',
    /\/spa\?step=2#hash-only$/,
    'A-B-A SPA context',
    previewContext,
  );
  const loopAUrl = await evaluate('location.href', loopContext.context);
  await evaluate(
    `history.pushState({ loop: "B" }, "", "/spa?loop=B#middle")`,
    loopContext.context,
  );
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/spa\?loop=B#middle$/.test(value) ? value : null;
  }, 'A-B-A middle entry');
  await evaluate(
    `history.pushState({ loop: "A" }, "", ${JSON.stringify(loopAUrl)})`,
    loopContext.context,
  );
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return value === loopAUrl ? value : null;
  }, 'A-B-A repeated final URL');
  await trustedClick('#back', previewContext.context, 'A-B-A back to middle entry');
  const loopBackState = await waitFor(async () => {
    const value = await json(`({
      url: document.getElementById('pageUrl').textContent,
      forwardDisabled: document.getElementById('forward').disabled
    })`, previewContext.context);
    return /\/spa\?loop=B#middle$/.test(value.url) &&
      value.forwardDisabled === false
      ? value
      : null;
  }, 'A-B-A back preserved the duplicate final URL');
  const loopBackUrl = loopBackState.url;
  await trustedClick('#forward', previewContext.context, 'A-B-A forward to repeated URL');
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return value === loopAUrl ? value : null;
  }, 'A-B-A forward returned to repeated URL');

  stage('verify location.replace replaces rather than appends a preview history entry');
  const locationReplaceContext = await waitForEmbedded(
    '#change-hash',
    /\/spa\?step=2#hash-only$/,
    'location.replace source context',
    previewContext,
  );
  await evaluate(`location.replace("/replace-result")`, locationReplaceContext.context);
  await waitFor(async () => {
    const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
    return /\/replace-result$/.test(value) ? value : null;
  }, 'location.replace destination URL');
  await waitForEmbedded(
    '#replace-result',
    /\/replace-result$/,
    'location.replace destination context',
    previewContext,
  );
  await trustedClick('#back', previewContext.context, 'back after location.replace');
  const replaceLocationBackUrl = await waitFor(async () => {
    const value = await json(`({
      url: document.getElementById('pageUrl')?.textContent || '',
      ready: document.getElementById('surface')?.classList.contains('is-ready') === true,
      forwardDisabled: document.getElementById('forward')?.disabled === true
    })`, previewContext.context);
    return /\/spa\?loop=B#middle$/.test(value.url) &&
      value.ready &&
      value.forwardDisabled === false
      ? value.url
      : null;
  }, 'location.replace did not add an extra preview history entry');
  await trustedClick('#forward', previewContext.context, 'forward after location.replace');
  try {
    await waitFor(async () => {
      const value = await evaluate(`document.getElementById('pageUrl').textContent`, previewContext.context);
      return /\/replace-result$/.test(value) ? value : null;
    }, 'forward returned to location.replace result');
  } catch (error) {
    const replaceDebug = await json(`({
      url: document.getElementById('pageUrl')?.textContent || '',
      classes: document.getElementById('surface')?.className || '',
      backDisabled: document.getElementById('back')?.disabled,
      forwardDisabled: document.getElementById('forward')?.disabled,
      title: document.getElementById('pageTitle')?.textContent || ''
    })`, previewContext.context).catch(() => null);
    process.stderr.write(`[bidi] location.replace forward debug: ${JSON.stringify(replaceDebug)}\n`);
    throw error;
  }

  const spaHistory = JSON.parse(await evaluate(`(async () => JSON.stringify(
    await browser.history.search({
      text: 'localtest.me:8787/spa',
      startTime: 0,
      maxResults: 50
    })
  ))()`, zoomController.context));
  assert.ok(spaHistory.some((entry) => /\/spa\?step=2#replaced$/.test(entry.url)));
  assert.ok(spaHistory.some((entry) => /\/spa\?step=2#hash-only$/.test(entry.url)));

  stage('close from target iframe with Escape');
  const escapeContext = await waitForEmbedded(
    '#replace-result',
    /\/replace-result$/,
    'current location.replace context before Escape',
    previewContext,
  );
  try {
    await client.command('input.performActions', {
      context: escapeContext.context,
      actions: [{
        type: 'key',
        id: 'glasspeek-keyboard',
        actions: [
          { type: 'keyDown', value: '\uE00C' },
          { type: 'keyUp', value: '\uE00C' },
        ],
      }],
    });
    await client.command('input.releaseActions', { context: escapeContext.context });
  } catch (error) {
    if (!/no such frame|BrowsingContext does no longer exist/i.test(String(error && error.message))) {
      throw error;
    }
  }
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'preview close from iframe Escape');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  stage('verify document-start pushState and replaceState survive target config startup');
  await longPress('#early-history-link', 'early SPA history fixture');
  const earlyHistoryPreview = await waitForPreview('early SPA preview surface');
  await waitFor(async () => {
    const classes = await evaluate(
      `document.getElementById('surface')?.className || ''`,
      earlyHistoryPreview.context,
    );
    return classes.includes('is-ready');
  }, 'early SPA target ready');
  const earlyHistoryTarget = await waitForEmbedded(
    '#early-history-ready',
    /\/early-history\?phase=replace#two$/,
    'early SPA target context',
    earlyHistoryPreview,
  );
  await waitFor(async () => {
    return await evaluate(`document.readyState === 'complete'`, earlyHistoryTarget.context);
  }, 'early SPA target lifecycle complete');
  const earlyHistoryReady = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      backDisabled: document.getElementById('back')?.disabled === true
    })`, earlyHistoryPreview.context);
    if (
      state.classes.includes('is-ready') &&
      /\/early-history\?phase=replace#two$/.test(state.url)
    ) {
      return state;
    }
    throw new Error(JSON.stringify(state));
  }, 'early SPA buffered history ready');
  assert.equal(
    earlyHistoryReady.backDisabled,
    false,
    `document-start pushState was not retained: ${JSON.stringify(earlyHistoryReady)}`,
  );
  const earlyHistoryStartup = await json(`window.__glasspeekEarlyHistory`, earlyHistoryTarget.context);
  assert.equal(earlyHistoryStartup.readyState, 'loading');
  assert.equal(earlyHistoryStartup.bridgeInstalled, true);
  assert.match(earlyHistoryStartup.originalUrl, /\/early-history$/);
  assert.match(earlyHistoryStartup.finalUrl, /\/early-history\?phase=replace#two$/);

  await trustedClick('#back', earlyHistoryPreview.context, 'early SPA history back');
  const earlyHistoryBackUrl = await waitFor(async () => {
    const state = await json(`({
      url: document.getElementById('pageUrl')?.textContent || '',
      forwardDisabled: document.getElementById('forward')?.disabled === true
    })`, earlyHistoryPreview.context);
    return /\/early-history$/.test(state.url) && state.forwardDisabled === false
      ? state.url
      : null;
  }, 'early SPA back reached the pre-push entry');
  await trustedClick('#forward', earlyHistoryPreview.context, 'early SPA history forward');
  await waitFor(async () => {
    const value = await evaluate(
      `document.getElementById('pageUrl')?.textContent || ''`,
      earlyHistoryPreview.context,
    );
    return /\/early-history\?phase=replace#two$/.test(value) ? value : null;
  }, 'early SPA forward reached the replaced pushed entry');
  await trustedClick('#close', earlyHistoryPreview.context, 'close early SPA preview');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'early SPA preview close');

  stage('verify SAMEORIGIN and CSP self work with direct sibling targets');
  async function auditSameOriginProtected(selector, urlPattern, marker, label) {
    await longPress(selector, label);
    const protectedPreview = await waitForPreview(`${label} preview surface`);
    let protectedState;
    try {
      protectedState = await waitFor(async () => {
        const state = await json(`({
          classes: document.getElementById('surface')?.className || '',
          url: document.getElementById('pageUrl')?.textContent || ''
        })`, protectedPreview.context);
        return state.classes.includes('is-ready') && urlPattern.test(state.url)
          ? state
          : null;
      }, `${label} ready`, 18000);
    } catch (error) {
      const controlState = await json(`({
        classes: document.getElementById('surface')?.className || '',
        url: document.getElementById('pageUrl')?.textContent || '',
        loadingTitle: document.getElementById('loadingTitle')?.textContent || '',
        loadingDetail: document.getElementById('loadingDetail')?.textContent || '',
        errorHidden: document.getElementById('error')?.hidden ?? null,
        errorTitle: document.getElementById('errorTitle')?.textContent || '',
        errorDetail: document.getElementById('errorDetail')?.textContent || ''
      })`, protectedPreview.context).catch(() => null);
      const failureTree = await client.command('browsingContext.getTree', { root: context })
        .catch(() => ({ contexts: [] }));
      const screenshot = await capture(
        context,
        `failure-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
      ).catch(() => null);
      error.message += `\nDiagnostics: ${JSON.stringify({
        controlState,
        contexts: flatten(failureTree.contexts).map((entry) => ({
          context: entry.context,
          url: entry.url,
        })),
        screenshot,
      }, null, 2)}`;
      throw error;
    }
    const protectedTarget = await waitForEmbedded(
      marker,
      urlPattern,
      `${label} direct target`,
      protectedPreview,
    );
    const protectedTree = await client.command('browsingContext.getTree', {
      root: context,
    });
    const protectedParents = parentMap(protectedTree.contexts);
    assert.equal(protectedParents.get(protectedPreview.context), context);
    assert.equal(protectedParents.get(protectedTarget.context), context);
    assert.notEqual(
      protectedParents.get(protectedTarget.context),
      protectedPreview.context,
    );
    await trustedClick('#close', protectedPreview.context, `close ${label}`);
    await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', { root: context });
      return !flatten(tree.contexts).some((entry) =>
        /\/preview\/preview\.html$/.test(entry.url),
      );
    }, `${label} close`);
    await new Promise((resolve) => setTimeout(resolve, 450));
    return {
      ...protectedState,
      directSibling: true,
    };
  }
  const sameOriginPolicyAudit = {
    xfo: await auditSameOriginProtected(
      'a[href="/xfo-sameorigin"]',
      /\/xfo-sameorigin$/,
      '#sameorigin-ready',
      'X-Frame-Options SAMEORIGIN fixture',
    ),
    csp: await auditSameOriginProtected(
      'a[href="/csp-self"]',
      /\/csp-self$/,
      '#csp-self-ready',
      "CSP frame-ancestors 'self' fixture",
    ),
  };

  stage('verify two- and three-level protected descendant trees');
  const deepToken = `deep-${Date.now().toString(36)}`;
  const deepTokenPattern = deepToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const deepRootHref = `/deep/root?token=${deepToken}`;
  await evaluate(`(() => {
    const entries = [];
    const record = (phase, details) => {
      if (!details.url.includes('/deep/')) return;
      entries.push({
        phase,
        url: details.url,
        frameId: details.frameId,
        parentFrameId: details.parentFrameId,
        documentId: details.documentId || null,
        parentDocumentId: details.parentDocumentId || null,
        frameAncestors: Array.isArray(details.frameAncestors)
          ? details.frameAncestors.map((ancestor) => ({
              frameId: ancestor.frameId,
              documentId: ancestor.documentId || null
            }))
          : null
      });
    };
    const beforeListener = (details) => record('before-request', details);
    browser.webRequest.onBeforeRequest.addListener(beforeListener, {
      urls: ['http://*/*'],
      types: ['sub_frame']
    });
    window.__glasspeekDeepRequestAudit = {
      entries,
      beforeListener
    };
    return true;
  })()`, zoomController.context);
  await evaluate(`(() => {
    const link = document.getElementById('deep-root-link');
    if (!link) throw new Error('deep-root-link-missing');
    link.setAttribute('href', ${JSON.stringify(deepRootHref)});
    return link.href;
  })()`);
  await longPress('#deep-root-link', 'deep protected descendant fixture');
  const deepPreview = await waitForPreview('deep protected preview surface');
  const deepReady = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      title: document.getElementById('pageTitle')?.textContent || ''
    })`, deepPreview.context);
    return state.classes.includes('is-ready') &&
      state.url.includes(deepRootHref)
      ? state
      : null;
  }, 'deep protected preview ready', 22000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.match(
    await evaluate(
      `document.getElementById('surface')?.className || ''`,
      deepPreview.context,
    ),
    /is-ready/,
    'the deep preview disappeared after the long-press pointer was released',
  );

  const deepRootTarget = await waitForEmbedded(
    '#deep-root-ready',
    new RegExp(`/deep/root\\?token=${deepTokenPattern}$`),
    'deep direct root target',
    deepPreview,
  );
  const deepLevelOne = await waitForNested(
    '#deep-level-one-ready',
    new RegExp(`/deep/level-1\\?token=${deepTokenPattern}$`),
    'deep level-one descendant',
    deepRootTarget.context,
    1,
  );
  const deepLevelTwo = await waitForNested(
    '#deep-level-two-ready',
    new RegExp(`/deep/level-2\\?token=${deepTokenPattern}$`),
    'deep level-two descendant',
    deepRootTarget.context,
    2,
  );
  assert.equal(deepLevelOne.depth, 1);
  assert.equal(deepLevelTwo.depth, 2);

  async function protectedDeepLeaf(pathname, marker, depth, label) {
    let leaf;
    try {
      leaf = await waitForNested(
        marker,
        new RegExp(
          `${pathname.replaceAll('/', '\\/')}\\?[^#]*depth=${depth}[^#]*token=${deepTokenPattern}`,
        ),
        label,
        deepRootTarget.context,
        depth - 1,
      );
    } catch (error) {
      const audit = await json(
        `window.__glasspeekDeepRequestAudit?.entries || []`,
        zoomController.context,
      ).catch(() => []);
      const tree = await client.command('browsingContext.getTree', {
        root: context,
      }).catch(() => ({ contexts: [] }));
      process.stderr.write(`[bidi] deep leaf debug: ${JSON.stringify({
        label,
        audit,
        contexts: flatten(tree.contexts).map((entry) => ({
          context: entry.context,
          parent: entry.parent,
          url: entry.url
        }))
      }, null, 2)}\n`);
      throw error;
    }
    assert.equal(
      leaf.depth,
      depth - 1,
      `${label} was not at overall iframe depth ${depth}`,
    );
    return leaf;
  }

  const deepDepthTwoXfo = await protectedDeepLeaf(
    '/deep/xfo',
    '#deep-xfo-ready',
    2,
    'depth-two XFO descendant',
  );
  const deepDepthTwoCsp = await protectedDeepLeaf(
    '/deep/csp',
    '#deep-csp-ready',
    2,
    'depth-two CSP descendant',
  );
  const deepDepthTwoReportOnly = await protectedDeepLeaf(
    '/deep/csp-report-only',
    '#deep-csp-report-only-ready',
    2,
    'depth-two CSP report-only descendant',
  );
  const deepDepthThreeXfo = await protectedDeepLeaf(
    '/deep/xfo',
    '#deep-xfo-ready',
    3,
    'depth-three XFO descendant',
  );
  const deepDepthThreeCsp = await protectedDeepLeaf(
    '/deep/csp',
    '#deep-csp-ready',
    3,
    'depth-three CSP descendant',
  );
  const deepDepthThreeReportOnly = await protectedDeepLeaf(
    '/deep/csp-report-only',
    '#deep-csp-report-only-ready',
    3,
    'depth-three CSP report-only descendant',
  );

  for (const [label, target] of [
    ['depth-two CSP', deepDepthTwoCsp],
    ['depth-three CSP', deepDepthThreeCsp],
  ]) {
    const state = await json(`({
      markerDepth: document.getElementById('deep-csp-ready')?.dataset.depth || '',
      inlineRan: document.documentElement.dataset.inlineRan || ''
    })`, target.context);
    assert.equal(state.markerDepth, label.includes('two') ? '2' : '3');
    assert.notEqual(
      state.inlineRan,
      'yes',
      `${label} lost the non-embedding script-src restriction`,
    );
  }
  for (const [label, target] of [
    ['depth-two CSP report-only', deepDepthTwoReportOnly],
    ['depth-three CSP report-only', deepDepthThreeReportOnly],
  ]) {
    const state = await json(`({
      markerDepth: document.getElementById('deep-csp-report-only-ready')?.dataset.depth || '',
      inlineRan: document.documentElement.dataset.inlineRan || ''
    })`, target.context);
    assert.equal(state.markerDepth, label.includes('two') ? '2' : '3');
    assert.equal(
      state.inlineRan,
      'yes',
      `${label} unexpectedly enforced its report-only script policy`,
    );
  }

  await waitFor(async () => {
    const state = await json(`({
      url: location.href,
      title: document.title,
      poisoned: history.state?.descendant === true
    })`, deepDepthThreeXfo.context);
    return state.poisoned &&
      state.title === 'Deep descendant poisoned title' &&
      state.url.includes('child-state=poison')
      ? state
      : null;
  }, 'deep descendant title and history poison emitted');

  const deepRootIsolation = await json(`({
    classes: document.getElementById('surface')?.className || '',
    url: document.getElementById('pageUrl')?.textContent || '',
    title: document.getElementById('pageTitle')?.textContent || '',
    backDisabled: document.getElementById('back')?.disabled === true,
    forwardDisabled: document.getElementById('forward')?.disabled === true
  })`, deepPreview.context);
  assert.match(deepRootIsolation.classes, /is-ready/);
  assert.match(
    deepRootIsolation.url,
    new RegExp(`/deep/root\\?token=${deepTokenPattern}$`),
  );
  assert.equal(deepRootIsolation.title, 'Deep root title sentinel');
  assert.equal(deepRootIsolation.backDisabled, true);
  assert.equal(deepRootIsolation.forwardDisabled, true);

  const deepHistory = await waitFor(async () => {
    const entries = JSON.parse(await evaluate(`(async () => JSON.stringify(
      await browser.history.search({
        text: ${JSON.stringify(deepToken)},
        startTime: 0,
        maxResults: 50
      })
    ))()`, zoomController.context));
    return entries.some((entry) =>
      entry.url.includes(`/deep/root?token=${deepToken}`))
      ? entries
      : null;
  }, 'deep direct root written to Firefox history');
  assert.equal(
    deepHistory.some((entry) =>
      entry.url.includes(deepToken) && entry.url.includes('child-state=poison')),
    false,
    'a descendant pushState leaked into Firefox history',
  );

  stage('verify protected headers never leak to an ordinary sibling iframe');
  await evaluate(`(() => {
    for (const id of ['ordinary-live-xfo', 'ordinary-live-csp']) {
      document.getElementById(id)?.remove();
    }
    const xfo = document.createElement('iframe');
    xfo.id = 'ordinary-live-xfo';
    xfo.src = '/deep/xfo?scope=ordinary-live&token=${deepToken}';
    const csp = document.createElement('iframe');
    csp.id = 'ordinary-live-csp';
    csp.src = '/deep/csp?depth=ordinary&token=${deepToken}';
    document.body.append(xfo, csp);
    return true;
  })()`, ordinaryFrame.context);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const ordinarySiblingProtection = await json(`(() => {
    const markerVisible = (frameId, marker) => {
      try {
        return Boolean(
          document.getElementById(frameId)?.contentDocument?.querySelector(marker)
        );
      } catch (_error) {
        return false;
      }
    };
    return {
      xfoFrameExists: Boolean(document.getElementById('ordinary-live-xfo')),
      cspFrameExists: Boolean(document.getElementById('ordinary-live-csp')),
      xfoMarkerVisible: markerVisible('ordinary-live-xfo', '#deep-xfo-ready'),
      cspMarkerVisible: markerVisible('ordinary-live-csp', '#deep-csp-ready')
    };
  })()`, ordinaryFrame.context);
  assert.equal(ordinarySiblingProtection.xfoFrameExists, true);
  assert.equal(ordinarySiblingProtection.cspFrameExists, true);
  assert.equal(
    ordinarySiblingProtection.xfoMarkerVisible,
    false,
    'XFO was relaxed for an ordinary sibling iframe',
  );
  assert.equal(
    ordinarySiblingProtection.cspMarkerVisible,
    false,
    'CSP frame-ancestors was relaxed for an ordinary sibling iframe',
  );

  const deepTreeShot = await capture(context, '02-deep-target-tree.png');
  const beforeDeepTopNavigationTree = await client.command(
    'browsingContext.getTree',
    {},
  );
  const beforeDeepTopNavigationWindows = await client.command(
    'browser.getClientWindows',
    {},
  );
  const sourceBeforeDeepTopNavigation = await evaluate('location.href');
  await trustedClick(
    '#deep-top-link',
    deepDepthThreeXfo.context,
    'depth-three target=_top link',
  );
  const deepRootDestinationState = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      title: document.getElementById('pageTitle')?.textContent || '',
      backDisabled: document.getElementById('back')?.disabled === true,
      forwardDisabled: document.getElementById('forward')?.disabled === true
    })`, deepPreview.context);
    return state.classes.includes('is-ready') &&
      state.url.includes('/deep/root-destination?from=deep-top') &&
      state.url.includes(`token=${deepToken}`) &&
      state.url.endsWith('#reached') &&
      state.backDisabled === false
      ? state
      : null;
  }, 'depth-three link navigated the direct preview root', 22000);
  assert.equal(deepRootDestinationState.title, 'Deep root destination');
  assert.equal(deepRootDestinationState.backDisabled, false);
  const deepRootDestination = await waitForEmbedded(
    '#deep-root-destination',
    new RegExp(
      `/deep/root-destination\\?from=deep-top&token=${deepTokenPattern}#reached$`,
    ),
    'deep direct root destination',
    deepPreview,
  );
  const afterDeepTopNavigationTree = await client.command(
    'browsingContext.getTree',
    {},
  );
  const afterDeepTopNavigationWindows = await client.command(
    'browser.getClientWindows',
    {},
  );
  const deepParents = parentMap(afterDeepTopNavigationTree.contexts);
  assert.equal(deepParents.get(deepRootDestination.context), context);
  assert.equal(await evaluate('location.href'), sourceBeforeDeepTopNavigation);
  assert.equal(
    afterDeepTopNavigationTree.contexts.length,
    beforeDeepTopNavigationTree.contexts.length,
  );
  assert.equal(
    afterDeepTopNavigationWindows.clientWindows.length,
    beforeDeepTopNavigationWindows.clientWindows.length,
  );

  await trustedClick('#back', deepPreview.context, 'deep root history back');
  const deepRootBackState = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      title: document.getElementById('pageTitle')?.textContent || '',
      forwardDisabled: document.getElementById('forward')?.disabled === true
    })`, deepPreview.context);
    return state.classes.includes('is-ready') &&
      state.url.includes(deepRootHref) &&
      state.forwardDisabled === false
      ? state
      : null;
  }, 'deep root history returned from descendant target=_top navigation', 22000);
  assert.equal(deepRootBackState.title, 'Deep root title sentinel');
  await trustedClick('#close', deepPreview.context, 'close deep protected preview');
  await waitFor(async () => {
    const tree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(tree.contexts).some((entry) =>
      /\/preview\/preview\.html$/.test(entry.url));
  }, 'deep protected preview close');
  await evaluate(`(() => {
    const audit = window.__glasspeekDeepRequestAudit;
    if (audit?.beforeListener) {
      browser.webRequest.onBeforeRequest.removeListener(audit.beforeListener);
    }
    return true;
  })()`, zoomController.context);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const deepTreeAudit = {
    ready: deepReady,
    embeddingHeadersExercised: !unverifiedLocalTransport,
    transportNote: unverifiedLocalTransport
      ? 'local cross-origin embedding headers omitted because the HTTP fake-IP transport cannot provide authenticated response-origin evidence'
      : null,
    protectedDepths: {
      xfo: [deepDepthTwoXfo.depth + 1, deepDepthThreeXfo.depth + 1],
      csp: [deepDepthTwoCsp.depth + 1, deepDepthThreeCsp.depth + 1],
      cspReportOnly: [
        deepDepthTwoReportOnly.depth + 1,
        deepDepthThreeReportOnly.depth + 1,
      ],
    },
    rootIsolation: deepRootIsolation,
    cspReportOnlyLoadedAtDepths: [2, 3],
    descendantHistoryExcluded: true,
    rootDestination: deepRootDestinationState.url,
    sourceStayedPut: true,
    noNewTopLevelWindow: true,
    historyBack: deepRootBackState.url,
  };

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

  stage('verify a large XFO page renders as the original page');
  const beforeLargeWindows = await client.command('browser.getClientWindows', {});
  const beforeLargeTree = await client.command('browsingContext.getTree', {});
  await longPress('a[href="/large-reader"]', 'large reader fixture');
  const largeBlockedPreview = await waitForPreview('large compatible preview surface');
  const largeBlocked = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      readerSurface: Boolean(document.querySelector('#reader, #readerView, [data-action="reader"]'))
    })`, largeBlockedPreview.context);
    return state.classes.includes('is-ready') ? state : null;
  }, 'large original-page ready state', 30000);
  assert.match(largeBlocked.url, /\/large-reader$/);
  assert.equal(largeBlocked.readerSurface, false);
  const largeTarget = await waitForEmbedded(
    'article h1',
    /\/large-reader$/,
    'large original-page target',
    largeBlockedPreview,
  );
  assert.equal(
    await evaluate(`document.querySelector('article h1')?.textContent`, largeTarget.context),
    'Large article reader fixture',
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterLargeWindows = await client.command('browser.getClientWindows', {});
  const afterLargeTree = await client.command('browsingContext.getTree', {});
  assert.equal(afterLargeWindows.clientWindows.length, beforeLargeWindows.clientWindows.length);
  assert.equal(afterLargeTree.contexts.length, beforeLargeTree.contexts.length);
  const largeBlockedShot = await capture(context, '02-large-page-original-ready.png');
  await trustedClick('#close', largeBlockedPreview.context, 'close large preview');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'large blocked preview close');
  await new Promise((resolve) => setTimeout(resolve, 800));

  const originalCompatDomains = JSON.parse(await evaluate(`(async () => {
    const stored = await browser.storage.sync.get({ forceCompatDomains: [] });
    return JSON.stringify(stored.forceCompatDomains);
  })()`, zoomController.context));
  const compatBaselineDomains = originalCompatDomains.filter(
    (value) => String(value || '').toLowerCase().replace(/\.$/, '') !== 'localtest.me',
  );
  await evaluate(`(async () => {
    await browser.storage.sync.set({
      forceCompatDomains: ${JSON.stringify(compatBaselineDomains)}
    });
    return true;
  })()`, zoomController.context);
  await new Promise((resolve) => setTimeout(resolve, 450));

  stage('verify XFO pages render in place and never auto-open');
  const beforeBlockedWindows = await client.command('browser.getClientWindows', {});
  const beforeBlockedTree = await client.command('browsingContext.getTree', {});
  await longPress('a[href="/xfo"]', 'X-Frame-Options fixture');
  const blockedPreview = await waitForPreview('blocked-page preview surface');
  const blockedState = await waitFor(async () => {
    const state = await json(`({
      classes: document.getElementById('surface')?.className || '',
      url: document.getElementById('pageUrl')?.textContent || '',
      readerSurface: Boolean(document.querySelector('#reader, #readerView, [data-action="reader"]'))
    })`, blockedPreview.context);
    return state.classes.includes('is-ready') ? state : null;
  }, 'XFO original-page ready state', 22000);
  assert.match(blockedState.classes, /is-ready/);
  assert.match(blockedState.url, /\/xfo$/);
  assert.equal(blockedState.readerSurface, false);
  const xfoTarget = await waitForEmbedded(
    'h1',
    /\/xfo$/,
    'XFO protected target',
    blockedPreview,
  );
  assert.equal(
    await evaluate(`document.querySelector('h1')?.textContent`, xfoTarget.context),
    'X-Frame-Options: DENY',
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const afterBlockedWindows = await client.command('browser.getClientWindows', {});
  const afterBlockedTree = await client.command('browsingContext.getTree', {});
  assert.equal(afterBlockedWindows.clientWindows.length, beforeBlockedWindows.clientWindows.length);
  assert.equal(afterBlockedTree.contexts.length, beforeBlockedTree.contexts.length);
  const blockedShot = await capture(context, '02-xfo-original-ready.png');

  stage('verify full-page choice is remembered for the exact host');
  const beforeCompatTree = await client.command('browsingContext.getTree', {});
  const beforeCompatIds = new Set(flatten(beforeCompatTree.contexts).map((entry) => entry.context));
  await trustedClick('#fullPage', blockedPreview.context, 'remembered full-page window action');
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
  }, 'preview closes after remembered full-page handoff');
  const rememberedCompatDomains = JSON.parse(await evaluate(`(async () => {
    const stored = await browser.storage.sync.get({ forceCompatDomains: [] });
    return JSON.stringify(stored.forceCompatDomains);
  })()`, zoomController.context));
  assert.ok(
    rememberedCompatDomains.includes('localtest.me'),
    'the explicit full-page choice was not persisted for localtest.me',
  );

  stage('verify a remembered exact host reuses the full-page window');
  await client.command('browsingContext.activate', { context });
  await longPress('a[href="/xfo"]', 'X-Frame-Options fixture reopen');
  const rememberedReuse = await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', {});
    const sameWindow = flatten(nextTree.contexts).find((entry) => entry.context === compatibilityContext.context);
    const sourceTree = await client.command('browsingContext.getTree', { root: context });
    const previewCount = flatten(sourceTree.contexts).filter(
      (entry) => /\/preview\/preview\.html$/.test(entry.url),
    ).length;
    return (
      sameWindow &&
      /^http:\/\/localtest\.me:8787\/xfo$/.test(sameWindow.url) &&
      nextTree.contexts.length === beforeCompatTree.contexts.length + 1 &&
      previewCount === 0
    ) ? {
      topLevelCount: nextTree.contexts.length,
      previewCount,
    } : null;
  }, 'remembered full-page window single instance');

  stage('verify remembered full-page routing does not match a sibling host');
  await client.command('browsingContext.activate', { context });
  await evaluate(`(() => {
    let link = document.getElementById('compat-sibling-host-link');
    if (!link) {
      link = document.createElement('a');
      link.id = 'compat-sibling-host-link';
      link.textContent = 'Sibling host XFO fixture';
      link.style.cssText =
        'display:block;position:relative;z-index:2;margin:24px;padding:16px;background:#fff;color:#111';
      document.body.appendChild(link);
    }
    link.href = 'http://other.localtest.me:8787/xfo?scope=compat-sibling';
    return link.href;
  })()`);
  await longPress('#compat-sibling-host-link', 'sibling-host XFO fixture');
  const siblingHostPreview = await waitForPreview('sibling-host inline preview');
  const siblingHostTarget = await waitForEmbedded(
    'h1',
    /^http:\/\/other\.localtest\.me:8787\/xfo\?scope=compat-sibling$/,
    'sibling-host XFO target',
    siblingHostPreview,
  );
  assert.equal(
    await evaluate(`document.querySelector('h1')?.textContent`, siblingHostTarget.context),
    'X-Frame-Options: DENY',
  );
  const siblingHostTree = await client.command('browsingContext.getTree', {});
  assert.equal(
    siblingHostTree.contexts.length,
    rememberedReuse.topLevelCount,
    'an exact-host memory entry opened a second full-page window for a sibling hostname',
  );
  await trustedClick('#close', siblingHostPreview.context, 'close sibling-host inline preview');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'sibling-host inline preview close');

  stage('verify settings can remove the exact-host full-page memory');
  const compatOptionsUrl = `${extensionOrigin}/options/options.html#fallbacks`;
  await evaluate(
    `setTimeout(() => location.assign(${JSON.stringify(compatOptionsUrl)}), 0); true`,
    zoomController.context,
  );
  await waitFor(async () => {
    const tree = await client.command('browsingContext.getTree', {});
    return flatten(tree.contexts).some(
      (entry) =>
        entry.context === zoomController.context &&
        entry.url === compatOptionsUrl,
    );
  }, 'full-page memory settings section');
  const removeCompatPoint = await waitFor(async () => {
    const state = await json(`(() => {
      const item = Array.from(document.querySelectorAll('#compatDomainList .rule-item'))
        .find((candidate) =>
          candidate.querySelector('.rule-item__domain')?.textContent?.trim() === 'localtest.me');
      const button = item?.querySelector('button');
      const section = document.getElementById('fallbacks');
      if (!button || !section?.classList.contains('is-active')) return null;
      button.id = 'compat-memory-remove-test';
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        ? {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          }
        : null;
    })()`, zoomController.context);
    return state;
  }, 'localtest.me full-page memory remove control');
  await client.command('input.performActions', {
    context: zoomController.context,
    actions: [{
      type: 'pointer',
      id: `glasspeek-options-click-${Date.now().toString(36)}`,
      parameters: { pointerType: 'mouse' },
      actions: [
        {
          type: 'pointerMove',
          x: removeCompatPoint.x,
          y: removeCompatPoint.y,
          duration: 0,
          origin: 'viewport'
        },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
  await client.command('input.releaseActions', { context: zoomController.context });
  await waitFor(async () => {
    const domains = JSON.parse(await evaluate(`(async () => {
      const stored = await browser.storage.sync.get({ forceCompatDomains: [] });
      return JSON.stringify(stored.forceCompatDomains);
    })()`, zoomController.context));
    return !domains.includes('localtest.me');
  }, 'localtest.me full-page memory removal');

  stage('verify removing the exact-host memory restores inline preview');
  await client.command('browsingContext.close', { context: compatibilityContext.context });
  await client.command('browsingContext.activate', { context });
  await longPress('a[href="/xfo"]', 'X-Frame-Options fixture after memory removal');
  const restoredInlinePreview = await waitForPreview('restored exact-host inline preview');
  const restoredInlineTarget = await waitForEmbedded(
    'h1',
    /\/xfo$/,
    'restored exact-host XFO target',
    restoredInlinePreview,
  );
  assert.equal(
    await evaluate(`document.querySelector('h1')?.textContent`, restoredInlineTarget.context),
    'X-Frame-Options: DENY',
  );
  await trustedClick('#close', restoredInlinePreview.context, 'close restored inline preview');
  await waitFor(async () => {
    const nextTree = await client.command('browsingContext.getTree', { root: context });
    return !flatten(nextTree.contexts).some((entry) => /\/preview\/preview\.html$/.test(entry.url));
  }, 'restored exact-host inline preview close');
  await evaluate(`(async () => {
    await browser.storage.sync.set({
      forceCompatDomains: ${JSON.stringify(originalCompatDomains)}
    });
    return true;
  })()`, zoomController.context);
  const compatibilityMemoryAudit = {
    storedHost: 'localtest.me',
    reusedTopLevelCount: rememberedReuse.topLevelCount,
    siblingHostStayedInline: true,
    removedViaSettings: true,
    removedHostRestoredInline: true,
  };

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
    stage(`verify ${SELECTED_LIVE_SITE_CASES.length} representative live sites render real content in preview overlays`);

    async function auditLivePreview(site) {
      const startedAt = Date.now();
      const deadline = startedAt + LIVE_SITE_TIMEOUT_MS;
      const remainingSiteTime = () => Math.max(250, deadline - Date.now());
      await client.command('browsingContext.activate', { context });
      const beforeWindows = await client.command('browser.getClientWindows', {});
      const beforeTree = await client.command('browsingContext.getTree', {});
      const beforeTopIds = new Set(
        beforeTree.contexts.map((entry) => entry.context),
      );
      let livePreview = null;
      let state = null;
      let embedded = null;
      let screenshot = null;
      let failure = null;
      let openedFirefoxWindow = false;
      let escapedTopLevel = false;
      let sourceStayedOnFixture = true;
      let readyLatencyMs = null;

      try {
        await longPress(site.selector, site.label);
        livePreview = await waitForPreview(`${site.label} preview surface`);
        state = await waitFor(async () => {
          const value = await json(`({
            classes: document.getElementById('surface')?.className || '',
            url: document.getElementById('pageUrl')?.textContent || '',
            pageTitle: document.getElementById('pageTitle')?.textContent || '',
            errorTitle: document.getElementById('errorTitle')?.textContent || '',
            readerSurface: Boolean(document.querySelector('#reader, #readerView, [data-action="reader"]'))
          })`, livePreview.context);
          return /\bis-(?:ready|error)\b/.test(value.classes) ? value : null;
        }, `${site.label} terminal preview state`, remainingSiteTime());
        readyLatencyMs = Date.now() - startedAt;

        assert.match(
          state.classes,
          /\bis-ready\b/,
          `${site.label} did not reach is-ready (${state.errorTitle || state.classes})`,
        );
        assert.doesNotMatch(
          state.classes,
          /\bis-error\b/,
          `${site.label} exposed an error state`,
        );
        assert.match(
          state.url,
          site.urlPattern,
          `${site.label} preview lost the requested route`,
        );
        assert.equal(
          state.readerSurface,
          false,
          `${site.label} exposed a removed reader surface`,
        );

        // A document-start content script can prove that the original page is
        // alive before the site has rendered any meaningful content. Keep the
        // preview progressive, but do not let the acceptance test mistake a
        // transient skeleton/redirect page for a successful result.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const embeddedContext = await waitFor(async () => {
          const embeddedTree = await client.command('browsingContext.getTree', {
            root: context,
          });
          const embeddedParents = parentMap(embeddedTree.contexts);
          return flatten(embeddedTree.contexts).find(
            (entry) =>
              embeddedParents.get(entry.context) === context &&
              site.urlPattern.test(entry.url),
          ) || null;
        }, `${site.label} real target browsing context`, remainingSiteTime());
        embedded = await waitFor(async () => {
          const snapshot = await json(`({
            url: location.href,
            title: (document.title || '').trim(),
            text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1200),
            readyState: document.readyState
          })`, embeddedContext.context);
          return (
            snapshot.title &&
            /[\p{L}\p{N}]/u.test(snapshot.text)
          ) ? snapshot : null;
        }, `${site.label} embedded title and body`, remainingSiteTime());
        assert.match(
          embedded.url,
          site.urlPattern,
          `${site.label} embedded context left the requested route`,
        );
        assert.ok(
          embedded.title,
          `${site.label} embedded document had no title`,
        );
        assert.ok(
          embedded.text,
          `${site.label} embedded document had no readable body text`,
        );

        // Recheck after an additional stability window. Some commerce and
        // anti-abuse pages first paint a convincing shell, then redirect once
        // their data/bootstrap request is rejected. That is not a successful
        // original-page preview.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const stableState = await json(`({
          classes: document.getElementById('surface')?.className || '',
          url: document.getElementById('pageUrl')?.textContent || ''
        })`, livePreview.context);
        assert.match(
          stableState.classes,
          /\bis-ready\b/,
          `${site.label} left the ready state after its first paint`,
        );
        assert.match(
          stableState.url,
          site.urlPattern,
          `${site.label} redirected after its first paint`,
        );
        const stableTree = await client.command('browsingContext.getTree', {
          root: context,
        });
        const stableParents = parentMap(stableTree.contexts);
        const stableEmbeddedContext = flatten(stableTree.contexts).find(
          (entry) =>
            stableParents.get(entry.context) === context &&
            site.urlPattern.test(entry.url),
        );
        assert.ok(
          stableEmbeddedContext,
          `${site.label} target left the requested route after its first paint`,
        );
        embedded = await json(`({
          url: location.href,
          title: (document.title || '').trim(),
          text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1200),
          readyState: document.readyState
        })`, stableEmbeddedContext.context);
        assert.match(
          embedded.url,
          site.urlPattern,
          `${site.label} embedded context was not stable`,
        );
        assert.ok(
          /[\p{L}\p{N}]/u.test(embedded.text),
          `${site.label} lost meaningful content after its first paint`,
        );

        screenshot = await capture(context, site.screenshotName);
        const afterWindows = await client.command('browser.getClientWindows', {});
        const afterTree = await client.command('browsingContext.getTree', {});
        const escapedTopLevels = afterTree.contexts
          .filter((entry) => !beforeTopIds.has(entry.context))
          .map((entry) => ({
            context: entry.context,
            url: entry.url,
            originalOpener: entry.originalOpener,
            clientWindow: entry.clientWindow,
          }));
        openedFirefoxWindow =
          afterWindows.clientWindows.length !==
          beforeWindows.clientWindows.length;
        escapedTopLevel = escapedTopLevels.length > 0;
        assert.equal(
          openedFirefoxWindow,
          false,
          `${site.label} unexpectedly opened a Firefox window`,
        );
        assert.deepEqual(
          escapedTopLevels,
          [],
          `${site.label} escaped into a top-level browsing context`,
        );
        const sourceEntry = afterTree.contexts.find(
          (entry) => entry.context === context,
        );
        sourceStayedOnFixture =
          Boolean(sourceEntry) && sourceEntry.url === fixture.url;
        assert.ok(sourceEntry, `${site.label} removed the source tab`);
        assert.equal(
          sourceStayedOnFixture,
          true,
          `${site.label} navigated the source tab away from the fixture`,
        );
      } catch (error) {
        failure = error && error.message ? error.message : String(error);
        process.stderr.write(`[bidi] live site failed: ${site.key}: ${failure}\n`);
        if (!screenshot) {
          screenshot = await capture(context, site.screenshotName).catch(() => null);
        }
      } finally {
        if (livePreview) {
          await trustedClick(
            '#close',
            livePreview.context,
            `close ${site.label} preview`,
          ).catch(() => {});
          await waitFor(async () => {
            const tree = await client.command('browsingContext.getTree', {
              root: context,
            });
            return !flatten(tree.contexts).some(
              (entry) => /\/preview\/preview\.html(?:$|[?#])/.test(entry.url),
            );
          }, `${site.label} preview close`, 6000).catch(() => {});
        }

        // A failing site must not contaminate the remaining matrix. Close any
        // top-level escape and restore the loopback fixture if the source tab
        // itself was navigated.
        const cleanupTree = await client.command(
          'browsingContext.getTree',
          {},
        ).catch(() => ({ contexts: [] }));
        const cleanupWindows = await client.command(
          'browser.getClientWindows',
          {},
        ).catch(() => beforeWindows);
        if (
          cleanupWindows.clientWindows.length !==
          beforeWindows.clientWindows.length
        ) {
          openedFirefoxWindow = true;
        }
        if (
          cleanupTree.contexts.some(
            (entry) => !beforeTopIds.has(entry.context),
          )
        ) {
          escapedTopLevel = true;
        }
        for (const entry of cleanupTree.contexts) {
          if (!beforeTopIds.has(entry.context)) {
            await client.command(
              'browsingContext.close',
              { context: entry.context },
            ).catch(() => {});
          }
        }
        const sourceEntry = cleanupTree.contexts.find(
          (entry) => entry.context === context,
        );
        if (!sourceEntry) sourceStayedOnFixture = false;
        if (sourceEntry && sourceEntry.url !== fixture.url) {
          sourceStayedOnFixture = false;
          await client.command('browsingContext.navigate', {
            context,
            url: fixture.url,
            wait: 'complete',
          }, 30000).catch(() => {});
        }
        await client.command(
          'browsingContext.activate',
          { context },
        ).catch(() => {});
        await waitFor(async () => {
          const present = await evaluate(
            `Boolean(document.querySelector(${JSON.stringify(site.selector)}))`,
            context,
          ).catch(() => false);
          return present;
        }, `${site.label} fixture restoration`, 6000).catch(() => {});
      }

      return {
        key: site.key,
        category: site.category,
        label: site.label,
        requestedUrl: site.requestedUrl,
        status: failure ? 'failed' : 'passed',
        durationMs: Date.now() - startedAt,
        readyLatencyMs,
        classes: state?.classes || '',
        finalUrl: embedded?.url || state?.url || '',
        pageTitle: embedded?.title || state?.pageTitle || '',
        textSample: embedded?.text?.slice(0, 240) || '',
        readyState: embedded?.readyState || '',
        embeddedContext: Boolean(embedded),
        stayedInOverlay:
          !escapedTopLevel &&
          !openedFirefoxWindow &&
          sourceStayedOnFixture,
        openedFirefoxWindow,
        escapedTopLevel,
        sourceStayedOnFixture,
        screenshot,
        ...(failure ? { error: failure } : {}),
      };
    }

    const sites = [];
    for (const site of SELECTED_LIVE_SITE_CASES) {
      stage(`live compatibility: ${site.category}/${site.key}`);
      const siteResult = await auditLivePreview(site);
      sites.push(siteResult);
      stage(`live compatibility ${siteResult.status}: ${site.key} (${siteResult.durationMs} ms)`);
    }
    const failed = sites.filter((site) => site.status !== 'passed');
    liveSiteAudit = {
      total: sites.length,
      passed: sites.length - failed.length,
      failed: failed.length,
      categories: [...new Set(sites.map((site) => site.category))],
      sites,
      previewFirst: true,
      noAutomaticFirefoxWindow: true,
    };
  }

  const result = {
    ok: !liveSiteAudit || liveSiteAudit.failed === 0,
    browserVersion,
    extensionId,
    fixture,
    syntheticTrustAudit,
    ordinaryIframeNewTab,
    trustedPointerNavigation,
    ready,
    visualGeometryAudit,
    activationReleaseAudit,
    zoomAudit,
    pinned,
    originalModeControls,
    compatibilityMemoryAudit,
    sameOriginPolicyAudit,
    ordinarySiblingProtection,
    deepTreeAudit,
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
    loopBackUrl,
    replaceLocationBackUrl,
    earlyHistoryReady,
    earlyHistoryStartup,
    earlyHistoryBackUrl,
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
      deepTreeShot,
      largeBlockedShot,
      blockedShot,
      compatibilityShot,
      ...uiAudit.map((entry) => entry.screenshot),
      ...(liveSiteAudit
        ? liveSiteAudit.sites
            .map((site) => site.screenshot)
            .filter(Boolean)
        : []),
    ],
  };
  console.log(JSON.stringify(result, null, 2));
  if (liveSiteAudit?.failed) {
    const summary = liveSiteAudit.sites
      .filter((site) => site.status !== 'passed')
      .map((site) => `${site.key}: ${site.error}`)
      .join('; ');
    assert.equal(
      liveSiteAudit.failed,
      0,
      `${liveSiteAudit.failed}/${liveSiteAudit.total} live compatibility sites failed: ${summary}`,
    );
  }
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
