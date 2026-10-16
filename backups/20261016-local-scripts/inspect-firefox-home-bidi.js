'use strict';

const assert = require('node:assert/strict');

const portArg = process.argv.find((value) => value.startsWith('--port='));
const port = portArg ? Number(portArg.slice('--port='.length)) : 9224;
const fresh = process.argv.includes('--fresh');

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

async function main() {
  const client = new BidiClient(`ws://127.0.0.1:${port}/session`);
  let sessionCreated = false;
  try {
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    });
    sessionCreated = true;
    const tree = await client.command('browsingContext.getTree', {});
    let home = tree.contexts.find((entry) =>
      /^(?:about:home|about:newtab)$/.test(entry.url),
    );
    assert.ok(home, 'Firefox Home/New Tab context was not found');
    let createdContext = null;
    if (fresh) {
      const created = await client.command('browsingContext.create', {
        type: 'tab',
        referenceContext: home.context,
        background: true,
      });
      createdContext = created.context;
      await client.command(
        'browsingContext.navigate',
        { context: createdContext, url: 'about:newtab', wait: 'complete' },
        30000,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const freshTree = await client.command('browsingContext.getTree', {});
      home = freshTree.contexts.find(
        (entry) => entry.context === createdContext,
      );
      assert.ok(home, 'Fresh New Tab context was not found');
    }

    const expression = `JSON.stringify((() => {
      const root = document.querySelector('#root');
      const fiberKey =
        root && Object.keys(root).find((key) =>
          key.startsWith('__reactContainer$')
        );
      const queue = fiberKey ? [root[fiberKey]] : [];
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
      const state = store?.getState();
      const wallpapers = state?.Wallpapers || {};
      return {
        hasStore: Boolean(store),
        dispatchSource: store
          ? String(store.dispatch).slice(0, 500)
          : null,
        didRehydrate: state?.didRehydrate ?? null,
        fromStartupCache: Boolean(window.__FROM_STARTUP_CACHE__),
        wallpaperStateKeys: Object.keys(wallpapers),
        wallpaperCount: Array.isArray(wallpapers.wallpaperList)
          ? wallpapers.wallpaperList.length
          : null,
        wallpaperIds: Array.isArray(wallpapers.wallpaperList)
          ? wallpapers.wallpaperList.map((item) => item.id).filter(Boolean)
          : [],
        categories: wallpapers.categories || null,
        uploadedWallpaper: wallpapers.uploadedWallpaper || null,
        selectedPref:
          state?.Prefs?.values?.['newtabWallpapers.wallpaper'] ?? null,
        enabledPref:
          state?.Prefs?.values?.['newtabWallpapers.user.enabled'] ?? null,
        wallpaperUrl:
          document.body.style.getPropertyValue('--newtab-wallpaper') || '',
        background:
          getComputedStyle(document.body).backgroundImage,
        bodyClass: document.body.className,
        shortcutCount: document.querySelectorAll('a[href]').length,
        chromeUtilsType: typeof ChromeUtils,
        servicesType: typeof Services,
        title: document.title,
        readyState: document.readyState
      };
    })())`;
    const result = await client.command('script.evaluate', {
      expression,
      target: { context: home.context },
      awaitPromise: false,
      resultOwnership: 'none',
    });
    assert.equal(
      result.type,
      'success',
      result.exceptionDetails?.text || 'New Tab inspection failed',
    );
    console.log(
      JSON.stringify(
        {
          browserVersion: session.capabilities.browserVersion,
          context: home.context,
          state: JSON.parse(result.result.value),
        },
        null,
        2,
      ),
    );
    if (createdContext) {
      await client.command('browsingContext.close', {
        context: createdContext,
      });
    }
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
