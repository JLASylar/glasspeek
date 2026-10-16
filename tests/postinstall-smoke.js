'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portArg = process.argv.find((value) => value.startsWith('--port='));
const fixtureUrlArg = process.argv.find((value) => value.startsWith('--fixture-url='));
const expectedIdArg = process.argv.find((value) => value.startsWith('--expected-id='));
const expectedVersionArg = process.argv.find((value) => value.startsWith('--expected-version='));
const screenshotArg = process.argv.find((value) => value.startsWith('--screenshot='));
const allowExistingSettings = process.argv.includes('--allow-existing-settings');
const closeBrowser = process.argv.includes('--close-browser');
const port = portArg ? Number(portArg.slice('--port='.length)) : 9224;
const fixtureUrl = fixtureUrlArg
  ? fixtureUrlArg.slice('--fixture-url='.length)
  : 'http://localtest.me:8787/';
const expectedId = expectedIdArg
  ? expectedIdArg.slice('--expected-id='.length)
  : '{88cdb8a1-2007-44be-9965-7b08e3518437}';
const expectedVersion = expectedVersionArg
  ? expectedVersionArg.slice('--expected-version='.length)
  : '2.4.0';
const screenshotPath = path.resolve(
  screenshotArg
    ? screenshotArg.slice('--screenshot='.length)
    : path.join(__dirname, 'artifacts', 'postinstall-smoke.png'),
);

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
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('BiDi WebSocket connection failed'));
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

  command(method, params = {}, timeout = 30000) {
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
  for (const context of contexts || []) {
    output.set(context.context, parent);
    parentMap(context.children || [], context.context, output);
  }
  return output;
}

async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function main() {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, `invalid port: ${port}`);
  const parsedFixtureUrl = new URL(fixtureUrl);
  assert.equal(parsedFixtureUrl.protocol, 'http:', 'fixture must use HTTP');
  assert.equal(parsedFixtureUrl.hostname, 'localtest.me', 'fixture must use localtest.me');
  assert.ok(
    Number.isInteger(Number(parsedFixtureUrl.port)) &&
      Number(parsedFixtureUrl.port) > 0 &&
      Number(parsedFixtureUrl.port) <= 65535,
    'fixture URL must include an explicit valid port',
  );

  const client = new BidiClient(`ws://127.0.0.1:${port}/session`);
  let sessionCreated = false;
  let browserCloseRequested = false;
  let fixtureContext = null;
  try {
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    });
    sessionCreated = true;
    // The remote agent can accept a BiDi session before Firefox has finished
    // starting every persisted extension. Give the signed add-on a short,
    // deterministic startup window before creating the verification tab.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const created = await client.command('browsingContext.create', { type: 'tab' });
    fixtureContext = created.context;
    await client.command('browsingContext.navigate', {
      context: fixtureContext,
      url: fixtureUrl,
      wait: 'complete',
    });
    await client.command('browsingContext.activate', { context: fixtureContext });
    await new Promise((resolve) => setTimeout(resolve, 800));

    async function evaluate(expression, context = fixtureContext) {
      const result = await client.command('script.evaluate', {
        expression,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      });
      assert.equal(result.type, 'success', result.exceptionDetails?.text || 'script evaluation failed');
      return result.result?.value;
    }

    async function json(expression, context = fixtureContext) {
      return JSON.parse(await evaluate(`JSON.stringify(${expression})`, context));
    }

    const fixture = await json(`({
      title: document.title,
      linkCount: document.querySelectorAll('a[href]').length
    })`);
    assert.equal(fixture.title, 'GlassPeek local acceptance fixtures');
    assert.ok(fixture.linkCount >= 7, 'fixture links did not load');

    const point = await json(`(() => {
      const link = document.querySelector('a[href^="/embed"]');
      if (!link) return null;
      link.href = 'https://example.com/';
      const rect = link.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    })()`);
    assert.ok(point?.x > 0 && point?.y > 0, 'preview test link was not actionable');

    await client.command('input.performActions', {
      context: fixtureContext,
      actions: [{
        type: 'pointer',
        id: 'glasspeek-postinstall-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 700 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await client.command('input.releaseActions', { context: fixtureContext });

    const preview = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', { root: fixtureContext });
      return flatten(tree.contexts).find((entry) => /\/preview\/preview\.html$/.test(entry.url));
    }, 'installed GlassPeek preview');

    const ready = await waitFor(async () => {
      const state = await json(`({
        id: browser.runtime.id,
        version: browser.runtime.getManifest().version,
        classes: document.getElementById('surface')?.className || '',
        displayedUrl: document.getElementById('pageUrl')?.textContent || '',
        errorHidden: document.getElementById('error')?.hidden
      })`, preview.context);
      return state.classes.includes('is-ready') ? state : null;
    }, 'embedded page ready');

    const target = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', { root: fixtureContext });
      const parents = parentMap(tree.contexts);
      return flatten(tree.contexts).find((entry) =>
        parents.get(entry.context) === fixtureContext &&
        /^https:\/\/example\.com\/(?:$|[?#])/.test(entry.url));
    }, 'direct embedded target');
    let lastTargetState = null;
    let targetState;
    try {
      targetState = await waitFor(async () => {
        lastTargetState = await json(`(() => {
          const describe = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              color: style.color,
              backgroundColor: style.backgroundColor,
              colorScheme: style.colorScheme,
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              overflow: style.overflow,
              clipPath: style.clipPath,
              rect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
              }
            };
          };
          return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            heading: document.querySelector('h1')?.textContent?.trim() || '',
            bodyText: document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 240) || '',
            html: document.documentElement?.outerHTML?.slice(0, 500) || '',
            styles: {
              html: describe('html'),
              body: describe('body'),
              heading: describe('h1'),
              paragraph: describe('p'),
              link: describe('a')
            }
          };
        })()`, target.context);
        return (
          lastTargetState.readyState === 'complete' &&
          /Example Domain/i.test(lastTargetState.heading) &&
          /(?:documentation|illustrative) examples/i.test(lastTargetState.bodyText)
        ) ? lastTargetState : null;
      }, 'embedded page content');
    } catch (error) {
      const tree = await client.command('browsingContext.getTree', { root: fixtureContext });
      const previewState = await json(`({
        classes: document.getElementById('surface')?.className || '',
        displayedUrl: document.getElementById('pageUrl')?.textContent || '',
        errorHidden: document.getElementById('error')?.hidden,
        errorText: document.getElementById('error')?.innerText?.replace(/\\s+/g, ' ').trim() || ''
      })`, preview.context);
      throw new Error(
        `${error.message}; target=${JSON.stringify(lastTargetState)}; ` +
        `preview=${JSON.stringify(previewState)}; tree=${JSON.stringify(tree.contexts)}`
      );
    }

    assert.equal(ready.id, expectedId);
    assert.equal(ready.version, expectedVersion);
    assert.match(ready.displayedUrl, /^https:\/\/example\.com\/(?:$|[?#])/);
    assert.match(targetState.url, /^https:\/\/example\.com\/(?:$|[?#])/);
    assert.match(targetState.heading, /Example Domain/i);
    assert.match(targetState.bodyText, /(?:documentation|illustrative) examples/i);
    assert.equal(ready.errorHidden, true);
    const originalModeSettings = JSON.parse(await evaluate(
      `browser.storage.sync.get([
        'schemaVersion',
        'autoCompat',
        'compatMode',
        'forceCompatDomains',
        'readerFallback'
      ]).then((value) => JSON.stringify(value))`,
      preview.context,
    ));
    assert.equal(originalModeSettings.schemaVersion, 6);
    assert.equal(originalModeSettings.autoCompat, false);
    assert.equal(originalModeSettings.compatMode, 'ask');
    if (allowExistingSettings) {
      assert.ok(
        Array.isArray(originalModeSettings.forceCompatDomains),
        'persisted force-compatible domain list was invalid',
      );
    } else {
      assert.deepEqual(originalModeSettings.forceCompatDomains, []);
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(originalModeSettings, 'readerFallback'),
      false,
    );

    const targetImage = await client.command('browsingContext.captureScreenshot', {
      context: target.context,
      origin: 'viewport',
      format: { type: 'image/png' },
    });
    const targetScreenshotPath = screenshotPath.replace(/(\.[^.]+)?$/, '-target$1');
    fs.mkdirSync(path.dirname(targetScreenshotPath), { recursive: true });
    fs.writeFileSync(targetScreenshotPath, Buffer.from(targetImage.data, 'base64'));

    const image = await client.command('browsingContext.captureScreenshot', {
      context: fixtureContext,
      origin: 'viewport',
      format: { type: 'image/png' },
    });
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(image.data, 'base64'));

    const output = {
      ok: true,
      browserVersion: session.capabilities.browserVersion,
      extensionId: ready.id,
      extensionVersion: ready.version,
      trigger: 'longpress',
      embeddedPageReady: true,
      publicTargetVerified: true,
      directSiblingTarget: true,
      targetState,
      originalModeSettings,
      screenshotPath,
      targetScreenshotPath,
      gracefulBrowserClose: closeBrowser,
    };
    if (closeBrowser) {
      browserCloseRequested = true;
      await client.command('browser.close', {}, 15000);
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (fixtureContext) {
      try {
        await client.command('browsingContext.close', { context: fixtureContext }, 10000);
      } catch {
        // The browser may already have closed the dedicated fixture tab.
      }
    }
    if (sessionCreated && !browserCloseRequested) {
      try {
        await client.command('session.end', {}, 10000);
      } catch {
        // Ending the test session is best-effort after all assertions have completed.
      }
    }
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
