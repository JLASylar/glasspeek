'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');

const firefoxPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const profileArg = process.argv.find((value) => value.startsWith('--profile='));
const profilePath = profileArg ? profileArg.slice('--profile='.length) : '';
const urlArg = process.argv.find((value) => value.startsWith('--url='));
const targetUrl = urlArg
  ? urlArg.slice('--url='.length)
  : 'https://addons.mozilla.org/zh-CN/developers/';
assert.ok(profilePath, '--profile=<temporary clone> is required');
assert.match(targetUrl, /^https:\/\/addons\.mozilla\.org\//, '--url must be an addons.mozilla.org HTTPS URL');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
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
        if (Date.now() >= deadline) reject(new Error('Firefox BiDi port did not open'));
        else setTimeout(attempt, 200);
      };
      socket.once('timeout', retry);
      socket.once('error', retry);
    };
    attempt();
  });
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
      const timer = setTimeout(() => reject(new Error('BiDi connection timeout')), 10000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
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
        reject(new Error(`${method} timeout`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
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
  const port = await reservePort();
  const firefox = spawn(firefoxPath, [
    '-headless',
    '-no-remote',
    '-profile',
    profilePath,
    '--remote-debugging-port',
    String(port),
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  firefox.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
  let client = null;
  try {
    await waitForPort(port);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    client = new BidiClient(`ws://127.0.0.1:${port}/session`);
    await client.connect();
    await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    }, 60000);
    const tree = await client.command('browsingContext.getTree', {});
    const context = tree.contexts[0]?.context;
    assert.ok(context, 'Firefox did not expose a top-level context');
    await client.command('browsingContext.navigate', {
      context,
      url: targetUrl,
      wait: 'complete',
    }, 60000);
    const evaluated = await client.command('script.evaluate', {
      expression: `JSON.stringify({
        url: location.href,
        title: document.title,
        headings: Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 40).map((heading) =>
          (heading.innerText || heading.textContent || "").trim().slice(0, 160)
        ),
        scripts: Array.from(document.scripts)
          .map((script) => script.src)
          .filter(Boolean)
          .slice(0, 80),
        links: Array.from(document.querySelectorAll("a[href]")).slice(0, 120).map((link) => ({
          text: (link.innerText || link.textContent || "").trim().slice(0, 120),
          href: link.href,
          role: link.getAttribute("role"),
          ariaLabel: link.getAttribute("aria-label")
        })),
        forms: Array.from(document.forms).slice(0, 40).map((form) => ({
          action: form.action,
          method: form.method,
          id: form.id,
          name: form.getAttribute("name"),
          text: (form.innerText || form.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 500),
          controls: Array.from(form.elements).slice(0, 80).map((control) => ({
            tag: control.tagName.toLowerCase(),
            type: control.getAttribute("type"),
            name: control.getAttribute("name"),
            id: control.id,
            required: Boolean(control.required),
            accept: control.getAttribute("accept"),
            multiple: Boolean(control.multiple),
            disabled: Boolean(control.disabled),
            checked: Boolean(control.checked),
            labelText: (
              control.labels?.length
                ? Array.from(control.labels)
                    .map((label) => (label.innerText || label.textContent || "").trim())
                    .join(" | ")
                : ""
            ).slice(0, 240),
            dataUploadUrl: control.getAttribute("data-upload-url"),
            dataUploadUrlListed: control.getAttribute("data-upload-url-listed"),
            dataUploadUrlUnlisted: control.getAttribute("data-upload-url-unlisted"),
            dataMaxUploadSize: control.getAttribute("data-max-upload-size"),
            dataAddonIsListed: control.getAttribute("data-addon-is-listed"),
            text: control.tagName === "BUTTON"
              ? (control.innerText || control.textContent || "").trim().slice(0, 120)
              : null,
            ariaLabel: control.getAttribute("aria-label")
          }))
        })),
        buttons: Array.from(document.querySelectorAll("button, input[type=button], input[type=submit]"))
          .slice(0, 80)
          .map((button) => ({
            tag: button.tagName.toLowerCase(),
            type: button.getAttribute("type"),
            name: button.getAttribute("name"),
            id: button.id,
            text: button.tagName === "BUTTON"
              ? (button.innerText || button.textContent || "").trim().slice(0, 120)
              : null,
            ariaLabel: button.getAttribute("aria-label"),
            disabled: Boolean(button.disabled),
            formAction: button.formAction || null
          }))
      })`,
      target: { context },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    assert.equal(evaluated.type, 'success');
    const page = JSON.parse(evaluated.result.value);
    const hasLogin = page.links.some((link) =>
      /accounts\/login\/start/.test(link.href) ||
      /登录|log in|sign in/i.test(link.text)
    );
    const hasDeveloperAccount = page.links.some((link) =>
      /\/developers\/addons|\/developers\/addon\/submit|\/developers\/addon\//.test(link.href)
    ) || page.headings.some((heading) =>
      /我的提交|管理我的扩展|Manage My Submissions|Submit a New Add-on/i.test(heading)
    );
    console.log(JSON.stringify({
      authenticated: hasDeveloperAccount && !hasLogin,
      hasLogin,
      hasDeveloperAccount,
      page,
    }, null, 2));
    await client.command('session.end', {}, 5000).catch(() => {});
  } finally {
    client?.close();
    await terminate(firefox);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
