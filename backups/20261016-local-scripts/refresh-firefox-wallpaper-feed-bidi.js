'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portArg = process.argv.find((value) => value.startsWith('--port='));
const artifactArg = process.argv.find((value) => value.startsWith('--artifact='));

if (!portArg || !artifactArg) {
  throw new Error('--port and --artifact are required');
}

const port = Number(portArg.slice('--port='.length));
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

      const getWallpapers = () =>
        store.getState().Wallpapers?.wallpaperList || [];
      const beforeCount = getWallpapers().length;
      store.dispatch({
        type: 'PREF_CHANGED',
        data: {
          name: 'newtabWallpapers.enabled',
          value: true
        },
        meta: {
          from: 'ActivityStream:Content',
          to: 'ActivityStream:Main',
          skipLocal: true
        }
      });

      const listDeadline = Date.now() + 20000;
      let selectedRecord = null;
      while (Date.now() < listDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        selectedRecord = getWallpapers().find(
          (wallpaper) => wallpaper.title === 'dark-beach'
        );
        if (selectedRecord) break;
      }
      if (!selectedRecord) {
        throw new Error(
          'WallpaperFeed did not restore the dark-beach record'
        );
      }

      const setPref = (name, value) =>
        store.dispatch({
          type: 'SET_PREF',
          data: { name, value },
          meta: {
            from: 'ActivityStream:Content',
            to: 'ActivityStream:Main'
          }
        });
      setPref('newtabWallpapers.wallpaper', 'dark-beach');
      setPref('newtabWallpapers.initialWallpaper', '');
      setPref('newtabWallpapers.user.enabled', true);

      const renderDeadline = Date.now() + 15000;
      let wallpaperUrl = '';
      while (Date.now() < renderDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        wallpaperUrl =
          document.body.style.getPropertyValue('--newtab-wallpaper') || '';
        if (/url\\((?!\\s*\\))/.test(wallpaperUrl)) break;
      }

      const state = store.getState();
      return JSON.stringify({
        beforeCount,
        afterCount: getWallpapers().length,
        selectedRecord: {
          id: selectedRecord.id,
          title: selectedRecord.title,
          theme: selectedRecord.theme,
          category: selectedRecord.category,
          wallpaperUrl: selectedRecord.wallpaperUrl,
          backgroundPosition: selectedRecord.background_position
        },
        selectedPref:
          state.Prefs?.values?.['newtabWallpapers.wallpaper'] ?? null,
        enabledPref:
          state.Prefs?.values?.['newtabWallpapers.user.enabled'] ?? null,
        wallpaperUrl,
        background:
          getComputedStyle(document.body).backgroundImage,
        bodyClass: document.body.className,
        shortcutCount: document.querySelectorAll('a[href]').length,
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
      45000,
    );
    assert.equal(
      evaluation.type,
      'success',
      evaluation.exceptionDetails?.text || 'WallpaperFeed refresh failed',
    );
    const state = JSON.parse(evaluation.result.value);
    assert.ok(
      state.afterCount >= 70,
      `WallpaperFeed restored only ${state.afterCount} records`,
    );
    assert.equal(state.selectedPref, 'dark-beach');
    assert.equal(state.enabledPref, true);
    assert.match(
      state.wallpaperUrl,
      /url\((?!\s*\))/,
      'New Tab still has an empty wallpaper URL',
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
