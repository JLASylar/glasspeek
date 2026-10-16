'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portArg = process.argv.find((value) => value.startsWith('--port='));
const uuidArg = process.argv.find((value) => value.startsWith('--uuid='));
const port = portArg ? Number(portArg.slice('--port='.length)) : 9222;
const uuid = uuidArg ? uuidArg.slice('--uuid='.length) : '';
const expectedId = '{88cdb8a1-2007-44be-9965-7b08e3518437}';
const fixtureUrl = 'http://localtest.me:8787/';
const mainScreenshotPath = path.resolve(
  __dirname,
  'artifacts',
  'main-profile-after-2.4.0.png',
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
      const timer = setTimeout(() => reject(new Error('BiDi connection timed out')), 10_000);
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

  command(method, params = {}, timeout = 30_000) {
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

async function waitFor(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
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
  assert.match(uuid, /^[0-9a-f-]{36}$/i, 'A valid Firefox extension UUID is required');
  const client = new BidiClient(`ws://127.0.0.1:${port}/session`);
  let sessionCreated = false;
  let verificationContext = null;
  try {
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    }, 60_000);
    sessionCreated = true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const existingTree = await client.command('browsingContext.getTree', {});
    const existingTopLevelCount = existingTree.contexts.length;
    const existingContext = existingTree.contexts[0]?.context || null;
    let mainVisual = null;
    if (existingContext) {
      const screenshot = await client.command('browsingContext.captureScreenshot', {
        context: existingContext,
        origin: 'viewport',
        format: { type: 'image/png' },
      });
      fs.mkdirSync(path.dirname(mainScreenshotPath), { recursive: true });
      fs.writeFileSync(mainScreenshotPath, Buffer.from(screenshot.data, 'base64'));
      const visualResult = await client.command('script.evaluate', {
        expression: `JSON.stringify((() => ({
          url: location.href,
          title: document.title,
          bodyClass: document.body?.className || '',
          wallpaperNodes: [...document.querySelectorAll('*')]
            .map((element) => ({
              tag: element.tagName,
              id: element.id,
              className: typeof element.className === 'string' ? element.className : '',
              backgroundImage: getComputedStyle(element).backgroundImage
            }))
            .filter((item) =>
              /wallpaper/i.test(item.id + ' ' + item.className) ||
              (item.backgroundImage && item.backgroundImage !== 'none'))
            .slice(0, 12)
        }))())`,
        target: { context: existingContext },
        awaitPromise: false,
        resultOwnership: 'none',
      });
      if (visualResult.type === 'success') {
        mainVisual = JSON.parse(visualResult.result.value);
      }
    }

    const created = await client.command('browsingContext.create', { type: 'tab' });
    verificationContext = created.context;
    await client.command('browsingContext.navigate', {
      context: verificationContext,
      url: fixtureUrl,
      wait: 'complete',
    }, 30_000);

    async function evaluate(expression, context = verificationContext) {
      const evaluated = await client.command('script.evaluate', {
        expression,
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      });
      assert.equal(
        evaluated.type,
        'success',
        evaluated.exceptionDetails?.text || 'runtime readback failed',
      );
      return evaluated.result?.value;
    }

    async function json(expression, context = verificationContext) {
      return JSON.parse(await evaluate(`JSON.stringify(${expression})`, context));
    }

    const fixture = await json(`({
      title: document.title,
      linkCount: document.querySelectorAll('a[href]').length
    })`);
    assert.equal(fixture.title, 'GlassPeek local acceptance fixtures');
    assert.ok(fixture.linkCount >= 10);
    const point = await json(`(() => {
      const link = document.querySelector('a[href^="/embed"]');
      if (!link) return null;
      const rect = link.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    })()`);
    assert.ok(point?.x > 0 && point?.y > 0, 'fixture link was not actionable');
    await client.command('input.performActions', {
      context: verificationContext,
      actions: [{
        type: 'pointer',
        id: 'glasspeek-runtime-readback-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 700 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await client.command('input.releaseActions', { context: verificationContext });

    const preview = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', {
        root: verificationContext,
      });
      return flatten(tree.contexts).find((entry) =>
        entry.url === `moz-extension://${uuid}/preview/preview.html`);
    }, 'installed GlassPeek preview surface');

    const ready = await waitFor(async () => {
      const state = await json(`({
        classes: document.getElementById('surface')?.className || '',
        displayedUrl: document.getElementById('pageUrl')?.textContent || '',
        errorHidden: document.getElementById('error')?.hidden
      })`, preview.context);
      return state.classes.includes('is-ready') ? state : null;
    }, 'installed preview ready');

    const target = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', {
        root: verificationContext,
      });
      const parents = parentMap(tree.contexts);
      return flatten(tree.contexts).find((entry) =>
        parents.get(entry.context) === verificationContext &&
        /\/embed#fragment-target$/.test(entry.url));
    }, 'direct original-page target');

    const result = await client.command('script.evaluate', {
      expression: `(async () => {
        const settings = await browser.storage.sync.get(null);
        const manifest = browser.runtime.getManifest();
        return JSON.stringify({
          id: browser.runtime.id,
          version: manifest.version,
          name: manifest.name,
          schemaVersion: settings.schemaVersion,
          enabled: settings.enabled !== false,
          enabledStored: Object.prototype.hasOwnProperty.call(settings, 'enabled')
            ? settings.enabled
            : null,
          settingKeyCount: Object.keys(settings).length,
          page: location.href,
          previewReady: document.getElementById('surface')?.classList.contains('is-ready') === true
        });
      })()`,
      target: { context: preview.context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    assert.equal(result.type, 'success', result.exceptionDetails?.text || 'runtime readback failed');
    const readback = JSON.parse(result.result.value);
    assert.equal(readback.id, expectedId);
    assert.equal(readback.version, '2.4.0');
    assert.equal(readback.schemaVersion, 6);
    assert.equal(typeof readback.enabled, 'boolean');
    assert.ok(readback.settingKeyCount > 0);
    assert.equal(readback.previewReady, true);
    assert.match(ready.displayedUrl, /\/embed#fragment-target$/);

    console.log(JSON.stringify({
      ok: true,
      browserVersion: session.capabilities.browserVersion,
      existingTopLevelCount,
      mainScreenshotPath: existingContext ? mainScreenshotPath : null,
      mainVisual,
      fixture,
      directSiblingTarget: Boolean(target),
      ...readback,
    }, null, 2));
  } finally {
    if (verificationContext) {
      try {
        await client.command('browsingContext.close', {
          context: verificationContext,
        }, 10_000);
      } catch {
        // The dedicated readback tab may already be closed.
      }
    }
    if (sessionCreated) {
      try {
        await client.command('session.end', {}, 10_000);
      } catch {
        // Keep the user's browser open even if the remote session already ended.
      }
    }
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
