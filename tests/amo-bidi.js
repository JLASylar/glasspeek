'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const port = Number(option('port', '9223'));
const commandName = process.argv[2] || 'inspect';
const targetUrl = option('target-url');
const addonSlug = option('addon', '74c997885be448b086e5');
const expectedVersion = option('version');
const expectedPackageSha256 = option('expected-sha256').replace(/[^0-9a-f]/gi, '').toUpperCase();
const versionsUrl = `https://addons.mozilla.org/en-US/developers/addon/${encodeURIComponent(addonSlug)}/versions`;
const artifacts = path.resolve(__dirname, 'artifacts');

function requireVersion() {
  if (!expectedVersion) throw new Error('--version is required');
  return expectedVersion;
}

function requireExpectedSha256() {
  if (!/^[0-9A-F]{64}$/.test(expectedPackageSha256)) {
    throw new Error('--expected-sha256 must contain exactly 64 hexadecimal characters');
  }
  return expectedPackageSha256;
}

class Client {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('BiDi connection timeout')), 10000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('BiDi WebSocket error')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'error') pending.reject(new Error(`${message.error}: ${message.message}`));
      else pending.resolve(message.result);
    });
  }

  command(method, params = {}, timeout = 20000) {
    const id = ++this.id;
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

function flatten(contexts, output = []) {
  for (const context of contexts || []) {
    output.push(context);
    flatten(context.children || [], output);
  }
  return output;
}

function versionStatusExpression(version) {
  return `(() => {
    const expected = ${JSON.stringify(version)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const escaped = expected.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
    const labelPattern = new RegExp('(?:^|\\\\s)Version\\\\s*' + escaped + '(?![\\\\d.])', 'i');
    const versionPathPattern = /\\/versions\\/(\\d+)\\/?(?:$|[?#])/;
    const detailLinks = Array.from(document.querySelectorAll('a[href]')).filter((link) => {
      try {
        return versionPathPattern.test(new URL(link.href, location.href).pathname);
      } catch {
        return false;
      }
    });
    const matchingLink = detailLinks.find((link) => {
      const text = normalize(link.textContent);
      if (text === expected || text === 'Version ' + expected || labelPattern.test(text)) return true;
      const container = link.closest('tr, li, article, section, .version, .item');
      return Boolean(container && labelPattern.test(normalize(container.textContent)));
    });
    const candidates = Array.from(document.querySelectorAll('tr, li, article, section, .version, .item'));
    const row = matchingLink?.closest('tr, li, article, section, .version, .item')
      || candidates.find((element) => labelPattern.test(normalize(element.textContent)))
      || null;
    const scopedLinks = Array.from((row || document.createElement('div')).querySelectorAll('a[href]'));
    const detailLink = matchingLink || scopedLinks.find((link) => {
      try {
        return versionPathPattern.test(new URL(link.href, location.href).pathname);
      } catch {
        return false;
      }
    }) || null;
    const detailHref = detailLink ? new URL(detailLink.href, location.href).href : '';
    const versionIdMatch = detailHref.match(versionPathPattern);
    const downloads = scopedLinks
      .filter((link) => /\\.xpi(?:$|[?#])|\\/files?\\//i.test(link.href))
      .map((link) => ({ text: normalize(link.textContent), href: link.href }));
    const text = normalize(row?.innerText || row?.textContent);
    const knownStatuses = [
      'Awaiting Review',
      'Under Review',
      'Review Pending',
      'Approved',
      'Signed',
      'Rejected',
      'Disabled',
      'Incomplete'
    ];
    const status = knownStatuses.find((value) => text.toLowerCase().includes(value.toLowerCase())) || '';
    return {
      found: Boolean(row),
      version: expected,
      status,
      versionId: versionIdMatch?.[1] || '',
      detailHref,
      versionText: text.slice(0, 2000),
      downloads,
      pageText: document.body.innerText.slice(0, 3000)
    };
  })()`;
}

function signedXpiExpression(version, slug) {
  return `(() => {
    const expected = ${JSON.stringify(version)};
    const expectedSlug = ${JSON.stringify(slug)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const escaped = expected.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
    const versionPattern = new RegExp('(?:^|[-_.])' + escaped + '(?:\\\\.xpi)?(?:$|[?#])', 'i');
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((link) => {
        let fileName = '';
        try {
          fileName = decodeURIComponent(new URL(link.href, location.href).pathname.split('/').pop() || '');
        } catch {}
        return {
          text: normalize(link.textContent),
          href: link.href,
          fileName
        };
      })
      .filter((link) => /\\.xpi$/i.test(link.fileName) || /\\.xpi(?:$|[?#])/i.test(link.href));
    const matchesExpectedVersion = (link) =>
      versionPattern.test(link.fileName)
      || versionPattern.test(link.text)
      || (link.fileName.includes(expected) && link.fileName.toLowerCase().endsWith('.xpi'));
    const matching = links.filter(matchesExpectedVersion);
    const preferred = matching.find((link) =>
      link.fileName.toLowerCase().startsWith(expectedSlug.toLowerCase() + '-')
    ) || matching[0] || null;
    const elements = Array.from(document.querySelectorAll('*'))
      .filter((element) => {
        const text = normalize(element.textContent);
        return text.includes(expected) && /\\.xpi/i.test(text)
          && !Array.from(element.children).some((child) => {
            const childText = normalize(child.textContent);
            return childText.includes(expected) && /\\.xpi/i.test(childText);
          });
      })
      .map((element) => ({
        tag: element.tagName,
        text: normalize(element.textContent),
        href: element.href || '',
        classes: typeof element.className === 'string' ? element.className : ''
      }));
    return { version: expected, preferred, links: matching, allXpiLinks: links, elements };
  })()`;
}

async function main() {
  const client = new Client(`ws://127.0.0.1:${port}/session`);
  let sessionCreated = false;
  try {
    await client.connect();
    await client.command('session.new', { capabilities: { alwaysMatch: { browserName: 'firefox' } } });
    sessionCreated = true;
    const deadline = Date.now() + 20_000;
    let tree = null;
    let top = null;
    while (Date.now() < deadline) {
      tree = await client.command('browsingContext.getTree', {});
      top = tree.contexts.find((entry) =>
        /(?:addons\.mozilla\.org|accounts\.firefox\.com)/i.test(entry.url));
      if (top) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!top && targetUrl) {
      const candidate = tree?.contexts?.[0];
      if (!candidate) throw new Error(`No top-level Firefox context: ${JSON.stringify(tree?.contexts)}`);
      await client.command('browsingContext.navigate', {
        context: candidate.context,
        url: targetUrl,
        wait: 'interactive',
      }, 60_000);
      tree = await client.command('browsingContext.getTree', {});
      top = flatten(tree.contexts).find((entry) => entry.context === candidate.context);
    }
    if (!top) throw new Error(`Mozilla tab not found: ${JSON.stringify(tree?.contexts)}`);

    async function evaluate(expression, ownership = 'none') {
      const response = await client.command('script.evaluate', {
        expression,
        target: { context: top.context },
        awaitPromise: true,
        resultOwnership: ownership,
      });
      if (response.type !== 'success') throw new Error(response.exceptionDetails?.text || 'evaluation failed');
      return response.result;
    }

    async function json(expression) {
      const result = await evaluate(`Promise.resolve(${expression}).then((value) => JSON.stringify(value))`);
      return JSON.parse(result.value);
    }

    async function navigateTop(url, timeout = 30_000) {
      const result = await client.command('browsingContext.navigate', {
        context: top.context,
        url,
        wait: 'complete',
      }, timeout);
      top = { ...top, url: result.url };
      return result;
    }

    async function readExpectedVersionStatus() {
      return json(versionStatusExpression(requireVersion()));
    }

    async function openExpectedVersionDetail() {
      await navigateTop(versionsUrl);
      const versionInfo = await readExpectedVersionStatus();
      if (!versionInfo.found) {
        throw new Error(`Version ${expectedVersion} was not found on ${versionsUrl}`);
      }
      if (!versionInfo.detailHref) {
        throw new Error(`Version ${expectedVersion} has no detail link: ${JSON.stringify(versionInfo)}`);
      }
      const result = await navigateTop(versionInfo.detailHref);
      return { result, versionInfo };
    }

    if (commandName === 'choose-unlisted') {
      const beforeUrl = top.url;
      const selection = await json(`(() => {
        const radio = document.getElementById('id_channel_1');
        const submit = document.querySelector('button[type="submit"], input[type="submit"]');
        if (!radio || !submit) return { ok: false, reason: 'controls-not-found' };
        radio.click();
        if (!radio.checked) return { ok: false, reason: 'radio-not-selected' };
        submit.click();
        return { ok: true, selected: radio.checked };
      })()`);
      if (!selection.ok) throw new Error(`Could not select self-distribution: ${JSON.stringify(selection)}`);
      const deadline = Date.now() + 20000;
      let current = top;
      while (Date.now() < deadline) {
        const nextTree = await client.command('browsingContext.getTree', {});
        current = flatten(nextTree.contexts).find((entry) => entry.context === top.context) || current;
        if (current.url !== beforeUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (current.url === beforeUrl) throw new Error('Distribution form did not navigate');
      console.log(JSON.stringify({ ok: true, selected: 'unlisted', url: current.url }, null, 2));
      return;
    }

    if (commandName === 'upload-package') {
      const fileArg = process.argv.find((value) => value.startsWith('--file='));
      if (!fileArg) throw new Error('--file is required');
      const uploadVersion = requireVersion();
      const packagePath = path.resolve(fileArg.slice('--file='.length));
      const bytes = fs.readFileSync(packagePath);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
      const requiredSha256 = requireExpectedSha256();
      if (sha256 !== requiredSha256) {
        throw new Error(`Package hash mismatch: expected ${requiredSha256}, received ${sha256}`);
      }

      const fileInput = await evaluate(`document.getElementById('upload-addon')`, 'root');
      if (fileInput.type !== 'node' || !fileInput.sharedId) throw new Error('Upload input was not found');
      await client.command('input.setFiles', {
        context: top.context,
        element: { sharedId: fileInput.sharedId },
        files: [packagePath],
      }, 30000);

      const deadline = Date.now() + 240000;
      let uploadState = null;
      while (Date.now() < deadline) {
        uploadState = await json(`({
          url: location.href,
          continueDisabled: Boolean(document.querySelector('button[type="submit"], input[type="submit"]')?.disabled),
          fileName: document.getElementById('upload-addon')?.files?.[0]?.name || '',
          bodyText: document.body.innerText.slice(0, 6000),
          errors: Array.from(document.querySelectorAll('.errorlist, .error, [role="alert"]')).map((el) => el.textContent.trim()).filter(Boolean)
        })`);
        if (uploadState.errors.length || !uploadState.continueDisabled) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!uploadState || uploadState.continueDisabled || uploadState.errors.length) {
        throw new Error(`Upload did not validate: ${JSON.stringify(uploadState)}`);
      }
      let continued = null;
      if (process.argv.includes('--continue')) {
        const beforeUrl = top.url;
        const action = await json(`(() => {
          const text = document.body.innerText;
          const submit = document.querySelector('button[type="submit"], input[type="submit"]');
          if (!text.includes('validated with no errors or warnings')) {
            return { ok: false, reason: 'validation-not-confirmed' };
          }
          if (!submit || submit.disabled) {
            return { ok: false, reason: 'continue-unavailable' };
          }
          submit.click();
          return { ok: true };
        })()`);
        if (!action.ok) throw new Error(`Could not continue after upload: ${JSON.stringify(action)}`);
        const navigationDeadline = Date.now() + 60_000;
        let current = top;
        while (Date.now() < navigationDeadline) {
          const nextTree = await client.command('browsingContext.getTree', {});
          current = flatten(nextTree.contexts).find((entry) => entry.context === top.context) || current;
          if (current.url !== beforeUrl) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (current.url === beforeUrl) throw new Error('Continue after upload did not navigate');
        const page = await json(`({
          title: document.title,
          headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((el) => el.textContent.trim()).filter(Boolean),
          bodyText: document.body.innerText.slice(0, 5000)
        })`);
        continued = { url: current.url, ...page };
      }
      console.log(JSON.stringify({ ok: true, version: uploadVersion, sha256, ...uploadState, continued }, null, 2));
      return;
    }

    if (commandName === 'continue-after-validation') {
      const beforeUrl = top.url;
      const action = await json(`(() => {
        const text = document.body.innerText;
        const submit = document.querySelector('button[type="submit"], input[type="submit"]');
        if (!text.includes('validated with no errors or warnings')) return { ok: false, reason: 'validation-not-confirmed' };
        if (!submit || submit.disabled) return { ok: false, reason: 'continue-unavailable' };
        submit.click();
        return { ok: true };
      })()`);
      if (!action.ok) throw new Error(`Could not continue: ${JSON.stringify(action)}`);
      const deadline = Date.now() + 30000;
      let current = top;
      while (Date.now() < deadline) {
        const nextTree = await client.command('browsingContext.getTree', {});
        current = flatten(nextTree.contexts).find((entry) => entry.context === top.context) || current;
        if (current.url !== beforeUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (current.url === beforeUrl) throw new Error('Continue did not navigate');
      console.log(JSON.stringify({ ok: true, url: current.url }, null, 2));
      return;
    }

    if (commandName === 'declare-no-build-step') {
      const beforeUrl = top.url;
      const action = await json(`(() => {
        const no = document.getElementById('id_has_source_1');
        const submit = document.querySelector('button[type="submit"], input[type="submit"]');
        if (!document.body.innerText.includes('Code generators or minifiers')) return { ok: false, reason: 'wrong-page' };
        if (!no || !submit) return { ok: false, reason: 'controls-not-found' };
        no.click();
        if (!no.checked) return { ok: false, reason: 'declaration-not-selected' };
        submit.click();
        return { ok: true };
      })()`);
      if (!action.ok) throw new Error(`Could not declare source state: ${JSON.stringify(action)}`);
      const deadline = Date.now() + 30000;
      let current = top;
      while (Date.now() < deadline) {
        const nextTree = await client.command('browsingContext.getTree', {});
        current = flatten(nextTree.contexts).find((entry) => entry.context === top.context) || current;
        if (current.url !== beforeUrl) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (current.url === beforeUrl) throw new Error('Source declaration did not navigate');
      console.log(JSON.stringify({ ok: true, declaration: 'no build step', url: current.url }, null, 2));
      return;
    }

    if (commandName === 'open-submissions') {
      const result = await client.command('browsingContext.navigate', {
        context: top.context,
        url: 'https://addons.mozilla.org/en-US/developers/addons',
        wait: 'complete',
      }, 30000);
      console.log(JSON.stringify({ ok: true, url: result.url }, null, 2));
      return;
    }

    if (commandName === 'open-version-status') {
      const target = await json(`(() => {
        const link = Array.from(document.querySelectorAll('a[href]')).find((el) => el.textContent.includes('Manage Status & Versions'));
        return link ? { href: link.href, text: link.textContent.trim() } : null;
      })()`);
      if (!target?.href) throw new Error('Manage Status & Versions link not found');
      const result = await client.command('browsingContext.navigate', {
        context: top.context,
        url: target.href,
        wait: 'complete',
      }, 30000);
      console.log(JSON.stringify({ ok: true, url: result.url }, null, 2));
      return;
    }

    if (commandName === 'check-status') {
      requireVersion();
      const waitMs = Number(option('wait-ms', '0'));
      const pollMs = Math.max(250, Number(option('poll-ms', '5000')));
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait-ms must be a non-negative number');
      if (!Number.isFinite(pollMs)) throw new Error('--poll-ms must be a number');
      const expectedStatuses = option('until', 'Approved,Signed')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const deadline = Date.now() + waitMs;
      let status = null;
      let reached = false;
      do {
        await navigateTop(versionsUrl);
        status = await readExpectedVersionStatus();
        reached = status.found && expectedStatuses.includes(status.status.toLowerCase());
        if (!waitMs || reached) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      } while (Date.now() < deadline);
      if (!status?.found) throw new Error(`Version ${expectedVersion} was not found on ${versionsUrl}`);
      if (waitMs && !reached) {
        throw new Error(`Timed out waiting for version ${expectedVersion} status (${expectedStatuses.join(', ')}): ${JSON.stringify(status)}`);
      }
      console.log(JSON.stringify({
        ok: true,
        polled: waitMs > 0,
        reached: waitMs > 0 ? reached : undefined,
        ...status
      }, null, 2));
      return;
    }

    if (commandName === 'open-version-detail') {
      const { result, versionInfo } = await openExpectedVersionDetail();
      console.log(JSON.stringify({
        ok: true,
        version: expectedVersion,
        versionId: versionInfo.versionId,
        url: result.url
      }, null, 2));
      return;
    }

    if (commandName === 'locate-signed-xpi') {
      const { versionInfo } = await openExpectedVersionDetail();
      const result = await json(signedXpiExpression(expectedVersion, addonSlug));
      if (!result.preferred) {
        throw new Error(`Signed XPI for version ${expectedVersion} was not found: ${JSON.stringify(result)}`);
      }
      console.log(JSON.stringify({
        ok: true,
        versionId: versionInfo.versionId,
        ...result
      }, null, 2));
      return;
    }

    if (commandName === 'download-signed-xpi') {
      const outputArg = process.argv.find((value) => value.startsWith('--output='));
      if (!outputArg) throw new Error('--output is required');
      const outputPath = path.resolve(outputArg.slice('--output='.length));
      const { versionInfo } = await openExpectedVersionDetail();
      const located = await json(signedXpiExpression(expectedVersion, addonSlug));
      if (!located.preferred?.href) {
        throw new Error(`Signed XPI for version ${expectedVersion} was not found: ${JSON.stringify(located)}`);
      }
      const signedHref = located.preferred.href;
      const download = await json(`(async () => {
        const href = ${JSON.stringify(signedHref)};
        const response = await fetch(href, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) return { ok: false, reason: 'http-' + response.status, href };
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength || buffer.byteLength > 5 * 1024 * 1024) return { ok: false, reason: 'unexpected-size', bytes: buffer.byteLength };
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        return {
          ok: true,
          href,
          contentType: response.headers.get('content-type') || '',
          bytes: buffer.byteLength,
          base64: btoa(binary)
        };
      })()`);
      if (!download.ok) throw new Error(`Authenticated download failed: ${JSON.stringify(download)}`);
      const fileBytes = Buffer.from(download.base64, 'base64');
      if (fileBytes.byteLength !== download.bytes) throw new Error('Downloaded byte count mismatch');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, fileBytes);
      const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex').toUpperCase();
      console.log(JSON.stringify({
        ok: true,
        version: expectedVersion,
        versionId: versionInfo.versionId,
        outputPath,
        bytes: fileBytes.byteLength,
        sha256,
        contentType: download.contentType,
        href: download.href
      }, null, 2));
      return;
    }

    if (commandName !== 'inspect') throw new Error(`Unsupported command: ${commandName}`);
    const state = await json(`({
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang,
      headings: Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).map((el) => el.textContent.trim()).filter(Boolean).slice(0, 20),
      buttons: Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]')).map((el, index) => ({
        index,
        text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim(),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
      })).filter((item) => item.text).slice(0, 40),
      links: Array.from(document.querySelectorAll('a[href]')).map((el, index) => ({ index, text: el.textContent.trim(), href: el.href })).filter((item) => item.text).slice(0, 40),
      inputs: Array.from(document.querySelectorAll('input,select,textarea')).map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        accept: el.accept || '',
        checked: Boolean(el.checked),
        disabled: Boolean(el.disabled),
        label: el.labels ? Array.from(el.labels).map((label) => label.textContent.trim()).join(' | ') : ''
      })).slice(0, 40),
      bodyText: document.body.innerText.slice(0, 5000)
    })`);

    const screenshot = await client.command('browsingContext.captureScreenshot', {
      context: top.context,
      origin: 'viewport',
      format: { type: 'image/png' },
    });
    fs.mkdirSync(artifacts, { recursive: true });
    const screenshotPath = path.join(artifacts, 'amo-current.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ ...state, context: top.context, screenshot: screenshotPath }, null, 2));
  } finally {
    if (sessionCreated) await client.command('session.end', {}, 3000).catch(() => {});
    client.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
