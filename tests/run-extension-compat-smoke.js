'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createTestServer } = require('./test-server');

const root = path.resolve(__dirname, '..');
const firefoxPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const xpiArg = process.argv.find((value) => value.startsWith('--xpi='));
const headed = process.argv.includes('--headed');
const xpiPath = path.resolve(
  xpiArg
    ? xpiArg.slice('--xpi='.length)
    : path.join(root, 'output', 'release-2.4.0', 'glasspeek-2.4.0-unsigned.zip'),
);
const probePath = path.join(__dirname, 'fixtures', 'extension-compat-probe');

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

async function waitFor(fn, label, timeout = 20000, interval = 150) {
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
  if (lastError) {
    throw new Error(`Timed out waiting for ${label}: ${lastError.message}`);
  }
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
        if (Date.now() >= deadline) {
          reject(new Error(`Firefox remote port ${port} did not open`));
        } else {
          setTimeout(attempt, 200);
        }
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function main() {
  assert.ok(fs.existsSync(firefoxPath), `Firefox does not exist: ${firefoxPath}`);
  assert.ok(fs.existsSync(xpiPath), `GlassPeek test package does not exist: ${xpiPath}`);
  assert.ok(fs.existsSync(probePath), `compatibility probe does not exist: ${probePath}`);

  const remotePort = await reservePort();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = path.join(__dirname, 'artifacts', `extension-compat-${runId}`);
  const profilePath = path.join(runRoot, 'profile');
  const screenshotPath = path.join(runRoot, 'all-frames-in-preview.png');
  const reportPath = path.join(runRoot, 'report.json');
  fs.mkdirSync(profilePath, { recursive: true });

  const fixtureServer = createTestServer();
  let firefox = null;
  let client = null;
  let glassPeekId = null;
  let probeId = null;

  try {
    await listen(fixtureServer);
    const address = fixtureServer.address();
    assert.ok(address && typeof address === 'object');
    const fixtureUrl = `http://localtest.me:${address.port}/`;

    const firefoxArgs = [
      '-no-remote',
      '-profile',
      profilePath,
      '--remote-debugging-port',
      String(remotePort),
      'about:blank',
    ];
    if (!headed) firefoxArgs.unshift('-headless');
    firefox = spawn(firefoxPath, firefoxArgs, {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    firefox.stderr?.on('data', (chunk) => {
      process.stderr.write(`[compat-firefox] ${String(chunk)}`);
    });
    await waitForPort(remotePort);
    await new Promise((resolve) => setTimeout(resolve, 8000));

    client = new BidiClient(`ws://127.0.0.1:${remotePort}/session`);
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    }, 60000);

    const glassPeekInstall = await client.command('webExtension.install', {
      extensionData: {
        type: 'archivePath',
        path: xpiPath,
      },
      'moz:permanent': false,
    }, 60000);
    glassPeekId = glassPeekInstall.extension;
    assert.equal(
      glassPeekId,
      '{88cdb8a1-2007-44be-9965-7b08e3518437}',
      'temporary GlassPeek id did not match',
    );

    const probeInstall = await client.command('webExtension.install', {
      extensionData: {
        type: 'path',
        path: probePath,
      },
      'moz:permanent': false,
    }, 60000);
    probeId = probeInstall.extension;
    assert.equal(
      probeId,
      'glasspeek-compat-probe@test.invalid',
      'temporary compatibility probe id did not match',
    );

    const initialTree = await client.command('browsingContext.getTree', {});
    const top = initialTree.contexts[0];
    assert.ok(top?.context, 'Firefox did not expose a top-level tab');
    const context = top.context;
    await client.command('browsingContext.navigate', {
      context,
      url: fixtureUrl,
      wait: 'complete',
    }, 60000);
    await client.command('browsingContext.activate', { context });

    async function evaluate(expression, targetContext = context) {
      const result = await client.command('script.evaluate', {
        expression,
        target: { context: targetContext },
        awaitPromise: true,
        resultOwnership: 'none',
      });
      assert.equal(
        result.type,
        'success',
        result.exceptionDetails?.text || `evaluation failed: ${expression}`,
      );
      return result.result?.value;
    }

    async function json(expression, targetContext = context) {
      const value = await evaluate(`JSON.stringify(${expression})`, targetContext);
      return JSON.parse(value);
    }

    const topLevelProbe = await waitFor(async () => {
      const state = await json(`({
        allFrames: document.documentElement.dataset.glasspeekAllFramesProbe || null,
        topOnly: document.documentElement.dataset.glasspeekTopOnlyProbe || null,
        frameKind: document.documentElement.dataset.glasspeekProbeFrameKind || null,
        marker: document.getElementById('glasspeek-all-frames-probe')?.textContent || null
      })`);
      return state.allFrames === 'injected' && state.topOnly === 'injected'
        ? state
        : null;
    }, 'both probe modes on the fixture top-level page', 30000);

    const point = await json(`(() => {
      const link = document.querySelector('a[href^="/embed"]');
      if (!link) return null;
      link.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = link.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    })()`);
    assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y));

    await client.command('input.performActions', {
      context,
      actions: [{
        type: 'pointer',
        id: 'glasspeek-compat-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: point.x, y: point.y, duration: 0, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 750 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await client.command('input.releaseActions', { context });

    const preview = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', { root: context });
      return flatten(tree.contexts).find((entry) =>
        /\/preview\/preview\.html(?:$|[?#])/.test(entry.url));
    }, 'GlassPeek preview context', 30000);

    const target = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', {
        root: context,
      });
      const parents = parentMap(tree.contexts);
      return flatten(tree.contexts).find((entry) =>
        parents.get(entry.context) === context &&
        /\/embed#fragment-target$/.test(entry.url));
    }, 'original webpage in the direct GlassPeek target frame', 30000);

    const directTree = await client.command('browsingContext.getTree', {
      root: context,
    });
    const directParents = parentMap(directTree.contexts);
    assert.equal(directParents.get(preview.context), context);
    assert.equal(directParents.get(target.context), context);
    assert.notEqual(directParents.get(target.context), preview.context);

    await waitFor(async () => evaluate(
      `document.getElementById('surface')?.classList.contains('is-ready') === true`,
      preview.context,
    ), 'GlassPeek preview ready state', 30000);

    const previewFrameProbe = await waitFor(async () => {
      const state = await json(`({
        allFrames: document.documentElement.dataset.glasspeekAllFramesProbe || null,
        topOnly: document.documentElement.dataset.glasspeekTopOnlyProbe || null,
        frameKind: document.documentElement.dataset.glasspeekProbeFrameKind || null,
        marker: document.getElementById('glasspeek-all-frames-probe')?.textContent || null,
        markerVisible: (() => {
          const marker = document.getElementById('glasspeek-all-frames-probe');
          if (!marker) return false;
          const rect = marker.getBoundingClientRect();
          const style = getComputedStyle(marker);
          return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        })(),
        nativeTarget: Boolean(document.getElementById('fragment-target')),
        directParent: window.parent === window.top,
        url: location.href
      })`, target.context);
      return state.allFrames === 'injected' && state.marker && state.markerVisible
        ? state
        : null;
    }, 'all-frames probe inside the GlassPeek preview iframe', 30000);

    assert.deepEqual(
      {
        allFrames: topLevelProbe.allFrames,
        topOnly: topLevelProbe.topOnly,
        frameKind: topLevelProbe.frameKind,
      },
      {
        allFrames: 'injected',
        topOnly: 'injected',
        frameKind: 'top',
      },
      'both probe modes should run on the fixture top-level page',
    );
    assert.equal(previewFrameProbe.allFrames, 'injected');
    assert.equal(previewFrameProbe.topOnly, null);
    assert.equal(previewFrameProbe.frameKind, 'subframe');
    assert.equal(previewFrameProbe.markerVisible, true);
    assert.equal(previewFrameProbe.nativeTarget, true);
    assert.equal(previewFrameProbe.directParent, true);
    assert.match(previewFrameProbe.url, /\/embed#fragment-target$/);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const screenshot = await client.command('browsingContext.captureScreenshot', {
      context,
      origin: 'viewport',
      format: { type: 'image/png' },
    });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const report = {
      ok: true,
      browserVersion: session.capabilities.browserVersion,
      glassPeekExtensionId: glassPeekId,
      probeExtensionId: probeId,
      glassPeekPackage: xpiPath,
      fixtureUrl,
      previewUrl: preview.url,
      targetUrl: target.url,
      topLevelProbe,
      previewFrameProbe,
      finding:
        'An extension content script declared with all_frames:true injected into the original webpage in GlassPeek’s direct sibling target frame.',
      objectiveLimit:
        'A content script using the default top-level-only behavior ran in the normal top-level fixture, but did not run in the same webpage when it was a GlassPeek preview iframe.',
      screenshot: screenshotPath,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`[compat] report: ${reportPath}\n`);
  } finally {
    if (client) {
      if (probeId) {
        await client.command('webExtension.uninstall', { extension: probeId })
          .catch(() => {});
      }
      if (glassPeekId) {
        await client.command('webExtension.uninstall', { extension: glassPeekId })
          .catch(() => {});
      }
      await client.command('session.end', {}).catch(() => {});
      client.close();
    }
    await terminate(firefox);
    await closeServer(fixtureServer);
    process.stderr.write(`[compat] disposable profile: ${profilePath}\n`);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
