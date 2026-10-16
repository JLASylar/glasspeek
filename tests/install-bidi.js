'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const portArg = process.argv.find((value) => value.startsWith('--port='));
const xpiArg = process.argv.find((value) => value.startsWith('--xpi='));
const idArg = process.argv.find((value) => value.startsWith('--expected-id='));
const shaArg = process.argv.find((value) => value.startsWith('--expected-sha256='));
const closeBrowser = process.argv.includes('--close-browser');

if (!portArg || !xpiArg || !idArg || !shaArg) {
  throw new Error(
    '--port, --xpi, --expected-id, and --expected-sha256 are required',
  );
}
const port = Number(portArg.slice('--port='.length));
const xpiPath = path.resolve(xpiArg.slice('--xpi='.length));
const expectedId = idArg.slice('--expected-id='.length);
const expectedSha256 = shaArg.slice('--expected-sha256='.length).trim().toUpperCase();

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
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, `invalid port: ${port}`);
  assert.ok(
    fs.existsSync(xpiPath) && fs.statSync(xpiPath).isFile(),
    `signed XPI is not a file: ${xpiPath}`,
  );
  assert.match(expectedSha256, /^[0-9A-F]{64}$/, 'invalid expected SHA-256');
  const xpiSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(xpiPath))
    .digest('hex')
    .toUpperCase();
  assert.equal(xpiSha256, expectedSha256, 'signed XPI SHA-256 did not match');

  const client = new BidiClient(`ws://127.0.0.1:${port}/session`);
  let sessionCreated = false;
  let browserCloseCompleted = false;
  try {
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    });
    sessionCreated = true;

    const result = await client.command('webExtension.install', {
      extensionData: {
        type: 'archivePath',
        path: xpiPath,
      },
      'moz:permanent': true,
    }, 60000);

    assert.equal(result.extension, expectedId, 'installed extension id did not match the signed package');
    const output = {
      ok: true,
      permanent: true,
      extension: result.extension,
      browserVersion: session.capabilities.browserVersion,
      xpiPath,
      xpiSha256,
      gracefulBrowserClose: false,
    };

    if (closeBrowser) {
      await client.command('browser.close', {}, 15000);
      browserCloseCompleted = true;
      output.gracefulBrowserClose = true;
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (sessionCreated && !browserCloseCompleted) {
      try {
        await client.command('session.end', {}, 10000);
      } catch {
        // The install is already complete; a closed browser connection is harmless here.
      }
    }
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
