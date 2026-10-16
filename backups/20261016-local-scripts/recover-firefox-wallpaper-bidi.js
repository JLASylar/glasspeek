'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portArg = process.argv.find((value) => value.startsWith('--port='));
const imageArg = process.argv.find((value) => value.startsWith('--image='));
const artifactArg = process.argv.find((value) => value.startsWith('--artifact='));

if (!portArg || !imageArg || !artifactArg) {
  throw new Error('--port, --image, and --artifact are required');
}

const port = Number(portArg.slice('--port='.length));
const imagePath = path.resolve(imageArg.slice('--image='.length));
const artifactPath = path.resolve(artifactArg.slice('--artifact='.length));

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
      const timer = setTimeout(
        () => reject(new Error('BiDi connection timed out')),
        10000,
      );
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('BiDi WebSocket connection failed'));
        },
        { once: true },
      );
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

async function main() {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.ok(fs.existsSync(imagePath), `wallpaper image not found: ${imagePath}`);
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const client = new BidiClient(`ws://127.0.0.1:${port}/session`);
  let sessionCreated = false;

  try {
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    });
    sessionCreated = true;

    const tree = await client.command('browsingContext.getTree', {});
    const home = tree.contexts.find((entry) =>
      /^(?:about:home|about:newtab)$/.test(entry.url),
    );
    assert.ok(home, 'Firefox Home/New Tab context was not found');

    const expression = `(async () => {
      const root = document.querySelector('#root');
      if (!root) throw new Error('New Tab React root was not found');
      const fiberKey = Object.keys(root).find((key) =>
        key.startsWith('__reactContainer$')
      );
      if (!fiberKey) throw new Error('New Tab React fiber was not found');

      const queue = [root[fiberKey]];
      const seen = new Set();
      let store = null;
      while (queue.length && seen.size < 10000) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const candidate = fiber.memoizedProps?.store;
        if (
          candidate &&
          typeof candidate.dispatch === 'function' &&
          typeof candidate.getState === 'function'
        ) {
          store = candidate;
          break;
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (!store) throw new Error('New Tab Redux store was not found');

      const beforeState = store.getState();
      const bytes = Uint8Array.from(
        atob(${JSON.stringify(imageBase64)}),
        (character) => character.charCodeAt(0)
      );
      const file = new File(
        [bytes],
        'firefox-home-wallpaper.jpg',
        { type: 'image/jpeg', lastModified: Date.now() }
      );
      store.dispatch({
        type: 'WALLPAPER_UPLOAD',
        data: { file, theme: 'light' },
        meta: {
          from: 'ActivityStream:Content',
          to: 'ActivityStream:Main',
          skipLocal: true
        }
      });

      const deadline = Date.now() + 15000;
      let wallpaperUrl = '';
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        wallpaperUrl =
          document.body.style.getPropertyValue('--newtab-wallpaper') || '';
        if (/moz-newtab-wallpaper:\\/\\//.test(wallpaperUrl)) break;
      }
      const afterState = store.getState();
      return JSON.stringify({
        beforeUploadedWallpaper:
          beforeState.Wallpapers?.uploadedWallpaper || null,
        afterUploadedWallpaper:
          afterState.Wallpapers?.uploadedWallpaper || null,
        selectedWallpaper:
          afterState.Wallpapers?.selectedWallpaper || null,
        wallpaperUrl,
        shortcutCount: document.querySelectorAll('a[href]').length,
        bodyClass: document.body.className,
        readyState: document.readyState
      });
    })()`;

    const evaluation = await client.command(
      'script.evaluate',
      {
        expression,
        target: { context: home.context },
        awaitPromise: true,
        resultOwnership: 'none',
      },
      30000,
    );
    assert.equal(
      evaluation.type,
      'success',
      evaluation.exceptionDetails?.text || 'wallpaper upload evaluation failed',
    );
    const state = JSON.parse(evaluation.result.value);
    assert.match(
      state.wallpaperUrl,
      /moz-newtab-wallpaper:\/\//,
      'New Tab did not receive a custom wallpaper URL',
    );
    assert.ok(
      state.shortcutCount >= 20,
      `New Tab shortcut count was unexpectedly low: ${state.shortcutCount}`,
    );

    await client.command('browsingContext.activate', { context: home.context });
    const image = await client.command('browsingContext.captureScreenshot', {
      context: home.context,
      origin: 'viewport',
      format: { type: 'image/png' },
    });
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, Buffer.from(image.data, 'base64'));

    console.log(
      JSON.stringify(
        {
          ok: true,
          browserVersion: session.capabilities.browserVersion,
          context: home.context,
          state,
          screenshot: artifactPath,
        },
        null,
        2,
      ),
    );
  } finally {
    if (sessionCreated) {
      await client.command('session.end', {}, 10000).catch(() => {});
    }
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
