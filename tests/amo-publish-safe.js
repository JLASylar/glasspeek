'use strict';

/**
 * Safe AMO publisher for the authenticated disposable Firefox profile.
 *
 * The default mode is read-only. Selecting a file is deliberately unreachable
 * unless BOTH --upload-and-submit and --package=<path> are present. The script
 * never reads or prints cookies, CSRF tokens, or AMO upload identifiers.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function normalizedHash(value) {
  return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

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

function waitForPort(port, timeout = 30_000) {
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
      const timer = setTimeout(() => reject(new Error('BiDi connection timeout')), 10_000);
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

  command(method, params = {}, timeout = 30_000) {
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

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP end-of-central-directory record was not found');
}

function zipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry at ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`);
  }
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  let content;
  if (entry.method === 0) content = Buffer.from(compressed);
  else if (entry.method === 8) content = zlib.inflateRawSync(compressed);
  else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  if (content.length !== entry.uncompressedSize) {
    throw new Error(`ZIP size mismatch for ${entry.name}`);
  }
  return content;
}

function inspectExtensionArchive(buffer) {
  const entries = zipEntries(buffer);
  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) throw new Error('Archive has no root manifest.json');
  const manifest = JSON.parse(readZipEntry(buffer, manifestEntry).toString('utf8'));
  const extensionId =
    manifest.browser_specific_settings?.gecko?.id ||
    manifest.applications?.gecko?.id ||
    '';
  const names = [...entries.keys()];
  const recognizedSignatureEntries = names.filter((name) =>
    /^META-INF\/(?:manifest\.mf|mozilla\.(?:sf|rsa)|cose\.(?:manifest|sig))$/i.test(name)
  );
  const rsaSigned =
    names.some((name) => /^META-INF\/manifest\.mf$/i.test(name)) &&
    names.some((name) => /^META-INF\/mozilla\.sf$/i.test(name)) &&
    names.some((name) => /^META-INF\/mozilla\.rsa$/i.test(name));
  const coseSigned =
    names.some((name) => /^META-INF\/cose\.manifest$/i.test(name)) &&
    names.some((name) => /^META-INF\/cose\.sig$/i.test(name));
  return {
    manifestVersion: String(manifest.version || ''),
    extensionId,
    entryCount: names.length,
    recognizedSignatureEntries,
    structurallySigned: rsaSigned || coseSigned,
  };
}

function assertArchiveIdentity(archive, expectedVersion, expectedExtensionId, label) {
  assert.equal(
    archive.manifestVersion,
    expectedVersion,
    `${label} manifest version must be ${expectedVersion}`
  );
  assert.equal(
    archive.extensionId,
    expectedExtensionId,
    `${label} extension ID must be ${expectedExtensionId}`
  );
}

async function main() {
  const profilePath = path.resolve(option('profile'));
  const firefoxPath = path.resolve(
    option('firefox', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe')
  );
  const addonSlug = option('addon', '74c997885be448b086e5');
  const expectedVersion = option('version', '2.4.0');
  const expectedExtensionId = option(
    'expected-extension-id',
    '{88cdb8a1-2007-44be-9965-7b08e3518437}'
  );
  const packageArgument = option('package');
  const expectedPackageHash = normalizedHash(option('expected-sha256'));
  const outputArgument = option('output');
  const mutating = hasFlag('upload-and-submit');
  const resumeVersionId = option('resume-version-id');
  const resuming = Boolean(resumeVersionId);
  const signingTimeout = requirePositiveInteger(
    option('signing-timeout-ms', '900000'),
    '--signing-timeout-ms'
  );
  const pollInterval = requirePositiveInteger(option('poll-ms', '10000'), '--poll-ms');

  if (!option('profile')) throw new Error('--profile=<authenticated disposable clone> is required');
  if (!fs.statSync(profilePath).isDirectory()) throw new Error('--profile must be a directory');
  if (!/^glasspeek-amo-profile-/i.test(path.basename(profilePath))) {
    throw new Error('Refusing to use a non-disposable Firefox profile');
  }
  if (!fs.existsSync(firefoxPath)) throw new Error(`Firefox not found: ${firefoxPath}`);
  if (!/^[a-z0-9_-]+$/i.test(addonSlug)) throw new Error('--addon contains invalid characters');
  if (resuming && !/^\d+$/.test(resumeVersionId)) {
    throw new Error('--resume-version-id must contain only decimal digits');
  }
  if (resuming && mutating) {
    throw new Error('--resume-version-id and --upload-and-submit are mutually exclusive');
  }

  let packageInfo = null;
  let packagePath = '';
  if (packageArgument) {
    packagePath = path.resolve(packageArgument);
    if (!fs.statSync(packagePath).isFile()) throw new Error('--package must be a file');
    if (!/\.(?:zip|xpi|crx)$/i.test(packagePath)) {
      throw new Error('--package must have a .zip, .xpi, or .crx extension');
    }
    const packageBytes = fs.readFileSync(packagePath);
    const packageHash = sha256(packageBytes);
    const archive = inspectExtensionArchive(packageBytes);
    assertArchiveIdentity(archive, expectedVersion, expectedExtensionId, 'Package');
    packageInfo = {
      path: packagePath,
      bytes: packageBytes.length,
      sha256: packageHash,
      manifestVersion: archive.manifestVersion,
      extensionId: archive.extensionId,
      entryCount: archive.entryCount,
    };
    if (packageBytes.length > 200_000_000) throw new Error('Package exceeds AMO 200 MB limit');
    if (mutating) {
      if (!/^[0-9A-F]{64}$/.test(expectedPackageHash)) {
        throw new Error('--expected-sha256=<64 hex characters> is required in mutating mode');
      }
      assert.equal(packageHash, expectedPackageHash, 'Package SHA-256 does not match');
    }
  }

  if (mutating && !packageArgument) {
    throw new Error('--upload-and-submit is inert unless --package=<path> is also provided');
  }
  if ((mutating || resuming) && !outputArgument) {
    throw new Error('--output=<signed.xpi> is required when publishing or resuming');
  }

  let outputPath = '';
  if (mutating || resuming) {
    outputPath = path.resolve(outputArgument);
    if (packagePath && outputPath === packagePath) {
      throw new Error('--output must not overwrite --package');
    }
    if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
  }

  const submitUrl =
    `https://addons.mozilla.org/zh-CN/developers/addon/${encodeURIComponent(addonSlug)}` +
    '/versions/submit/';
  const versionsUrl =
    `https://addons.mozilla.org/zh-CN/developers/addon/${encodeURIComponent(addonSlug)}` +
    '/versions';
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
    stdio: 'ignore',
    windowsHide: true,
  });

  let client = null;
  let sessionCreated = false;
  try {
    await waitForPort(port);
    await delay(3000);
    client = new BidiClient(`ws://127.0.0.1:${port}/session`);
    await client.connect();
    await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    }, 60_000);
    sessionCreated = true;

    const tree = await client.command('browsingContext.getTree', {});
    const context = tree.contexts[0]?.context;
    assert.ok(context, 'Firefox did not expose a top-level browsing context');

    async function evaluate(expression, ownership = 'none') {
      const response = await client.command('script.evaluate', {
        expression,
        target: { context },
        awaitPromise: true,
        resultOwnership: ownership,
      }, 60_000);
      if (response.type !== 'success') {
        throw new Error(response.exceptionDetails?.text || 'Page evaluation failed');
      }
      return response.result;
    }

    async function json(expression) {
      const result = await evaluate(
        `Promise.resolve(${expression}).then((value) => JSON.stringify(value))`
      );
      return JSON.parse(result.value);
    }

    async function navigate(url, wait = 'complete') {
      return client.command('browsingContext.navigate', {
        context,
        url,
        wait,
      }, 90_000);
    }

    async function currentUrl() {
      const currentTree = await client.command('browsingContext.getTree', {});
      const current = currentTree.contexts.find((item) => item.context === context);
      return current?.url || '';
    }

    async function waitForUrl(predicate, timeout, label) {
      const deadline = Date.now() + timeout;
      let url = await currentUrl();
      while (Date.now() < deadline) {
        if (predicate(url)) return url;
        await delay(250);
        url = await currentUrl();
      }
      throw new Error(`Timed out waiting for ${label}; current URL is ${url}`);
    }

    async function downloadSignedVersion(versionId) {
      if (!/^\d+$/.test(String(versionId))) throw new Error('Invalid exact version ID');
      const detailUrl =
        `https://addons.mozilla.org/zh-CN/developers/addon/${encodeURIComponent(addonSlug)}` +
        `/versions/${versionId}`;
      const signingDeadline = Date.now() + signingTimeout;
      let signedBytes = null;
      let signedHref = '';
      let signedStatus = '';
      let nextProgress = 0;
      let detailVerified = false;

      while (Date.now() < signingDeadline) {
        await navigate(detailUrl);
        const located = await json(`(() => {
          const expectedVersion = ${JSON.stringify(expectedVersion)};
          const exactPath = ${JSON.stringify(`/versions/${versionId}`)};
          const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const loginVisible = Array.from(document.querySelectorAll('a[href]')).some((link) =>
            /accounts\\/login\\/start|\\/login(?:[/?#]|$)/i.test(link.href)
          );
          const links = Array.from(document.querySelectorAll('#file-list a[href], a[href]'))
            .filter((link) => /\\.(?:xpi|zip)(?:$|[?#])/i.test(link.href));
          const link = links.find((item) =>
            normalize(item.textContent).includes(expectedVersion) ||
            item.href.includes(expectedVersion)
          ) || links[0] || null;
          const row = link?.closest('tr');
          const cells = row ? Array.from(row.cells).map((cell) =>
            normalize(cell.innerText || cell.textContent)
          ) : [];
          const xpi = links.find((item) =>
            /\\.xpi(?:$|[?#])/i.test(item.href) && (
              normalize(item.textContent).includes(expectedVersion) ||
              item.href.includes(expectedVersion)
            )
          ) || null;
          const pageVersionMatches = [document.title, ...Array.from(
            document.querySelectorAll('h1,h2,h3')
          ).map((heading) => normalize(heading.textContent))]
            .some((text) => new RegExp(
              '(?:^|\\\\s)' + expectedVersion.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&') +
              '(?:$|\\\\s|::)'
            ).test(text));
          return {
            authenticated: !loginVisible,
            exactDetailPage: location.pathname.endsWith(exactPath),
            pageVersionMatches,
            href: xpi?.href || '',
            status: cells[2] || '',
            fileName: normalize(link?.textContent),
            currentExtension: (() => {
              try {
                return new URL(link?.href || '', location.href).pathname.split('.').pop() || '';
              } catch {
                return '';
              }
            })()
          };
        })()`);
        if (!located.authenticated) throw new Error('AMO developer session is not authenticated');
        if (!located.exactDetailPage) {
          throw new Error(`AMO did not remain on exact version ${versionId} detail page`);
        }
        if (!located.pageVersionMatches) {
          throw new Error(`Version detail ${versionId} does not identify version ${expectedVersion}`);
        }
        detailVerified = true;
        signedHref = located.href;
        signedStatus = located.status;

        if (signedHref) {
          const fetched = await json(`(async () => {
            const response = await fetch(${JSON.stringify(signedHref)}, {
              credentials: 'include',
              cache: 'no-store'
            });
            if (!response.ok) return { ok: false, status: response.status };
            const buffer = await response.arrayBuffer();
            if (!buffer.byteLength || buffer.byteLength > 5 * 1024 * 1024) {
              return { ok: false, status: response.status, unexpectedBytes: buffer.byteLength };
            }
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let index = 0; index < bytes.length; index += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
            }
            return {
              ok: true,
              status: response.status,
              bytes: buffer.byteLength,
              contentType: response.headers.get('content-type') || '',
              base64: btoa(binary)
            };
          })()`);
          if (fetched.ok) {
            const candidate = Buffer.from(fetched.base64, 'base64');
            if (candidate.length !== fetched.bytes) {
              throw new Error('Signed XPI byte count mismatch');
            }
            try {
              const archive = inspectExtensionArchive(candidate);
              assertArchiveIdentity(archive, expectedVersion, expectedExtensionId, 'Signed XPI');
              if (archive.structurallySigned) signedBytes = { candidate, archive };
            } catch (error) {
              if (Date.now() + pollInterval >= signingDeadline) throw error;
            }
          }
        }

        if (signedBytes) break;
        if (Date.now() >= nextProgress) {
          console.error(JSON.stringify({
            stage: 'signing-pending',
            version: expectedVersion,
            versionId,
            status: signedStatus || 'not-ready',
            currentExtension: located.currentExtension || 'none',
          }));
          nextProgress = Date.now() + 20_000;
        }
        await delay(pollInterval);
      }

      if (!detailVerified) throw new Error(`Version detail ${versionId} was never verified`);
      if (!signedBytes) {
        throw new Error(
          `Timed out waiting for signed XPI for ${expectedVersion}; last status: ${signedStatus}`
        );
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, signedBytes.candidate);
      const written = fs.readFileSync(outputPath);
      const writtenArchive = inspectExtensionArchive(written);
      assertArchiveIdentity(writtenArchive, expectedVersion, expectedExtensionId, 'Written XPI');
      assert.equal(writtenArchive.structurallySigned, true, 'Written XPI lacks signature metadata');
      assert.equal(written.length, signedBytes.candidate.length, 'Written XPI size mismatch');

      return {
        outputPath,
        bytes: written.length,
        sha256: sha256(written),
        manifestVersion: writtenArchive.manifestVersion,
        extensionId: writtenArchive.extensionId,
        signatureEntries: writtenArchive.recognizedSignatureEntries,
        downloadUrl: signedHref,
        status: signedStatus,
        detailUrl,
      };
    }

    if (resuming) {
      console.error(JSON.stringify({
        stage: 'resume-existing-version',
        version: expectedVersion,
        versionId: resumeVersionId,
        uploadsDisabled: true,
      }));
      const signed = await downloadSignedVersion(resumeVersionId);
      console.log(JSON.stringify({
        ok: true,
        mode: 'resume-existing-version',
        externalChanges: false,
        uploadsOrSubmissionsPerformed: false,
        addon: addonSlug,
        version: expectedVersion,
        versionId: resumeVersionId,
        signed,
        versionsUrl,
      }, null, 2));
      return;
    }

    await navigate(submitUrl);
    const page = await json(`(() => {
      const form = document.getElementById('create-addon');
      const upload = document.getElementById('upload-addon');
      const firefox = document.getElementById('id_compatible_apps_0');
      const android = document.getElementById('id_compatible_apps_1');
      const submit = document.getElementById('submit-upload-file-finish');
      const loginVisible = Array.from(document.querySelectorAll('a[href]')).some((link) =>
        /accounts\\/login\\/start|\\/login(?:[/?#]|$)/i.test(link.href)
      );
      return {
        url: location.href,
        title: document.title,
        authenticated: !loginVisible && Boolean(form),
        form: form ? {
          id: form.id,
          method: form.method.toUpperCase(),
          action: form.action
        } : null,
        upload: upload ? {
          id: upload.id,
          endpoint: new URL(upload.dataset.uploadUrl, location.href).href,
          maxBytes: Number(upload.dataset.maxUploadSize || 0)
        } : null,
        compatibility: {
          firefox: Boolean(firefox?.checked),
          android: Boolean(android?.checked)
        },
        continueDisabled: Boolean(submit?.disabled),
        selfHosted: /upload-unlisted(?:$|[?#])/i.test(upload?.dataset.uploadUrl || '')
      };
    })()`);

    assert.equal(page.authenticated, true, 'AMO developer session is not authenticated');
    assert.equal(page.url, submitUrl, 'AMO did not remain on the expected upload page');
    assert.equal(page.form?.id, 'create-addon', 'Upload form was not found');
    assert.equal(page.form?.method, 'POST', 'Upload form method changed');
    assert.equal(page.form?.action, submitUrl, 'Upload form action changed');
    assert.match(page.upload?.endpoint || '', /\/upload-unlisted(?:$|[?#])/);
    assert.equal(page.selfHosted, true, 'Existing add-on is not in the expected unlisted channel');
    assert.equal(page.compatibility.firefox, true, 'Firefox compatibility is not selected');
    assert.equal(page.compatibility.android, false, 'Android compatibility unexpectedly selected');
    assert.equal(page.continueDisabled, true, 'Continue should be disabled before validation');

    if (!mutating) {
      console.log(JSON.stringify({
        ok: true,
        mode: 'dry-run',
        externalChanges: false,
        page,
        package: packageInfo,
        mutationGuard: {
          requiresFlag: '--upload-and-submit',
          requiresPackage: true,
        },
      }, null, 2));
      return;
    }

    console.error(JSON.stringify({
      stage: 'upload-start',
      version: expectedVersion,
      bytes: packageInfo.bytes,
      sha256: packageInfo.sha256,
    }));

    const input = await evaluate(`document.getElementById('upload-addon')`, 'root');
    if (input.type !== 'node' || !input.sharedId) throw new Error('Upload input is unavailable');
    await client.command('input.setFiles', {
      context,
      element: { sharedId: input.sharedId },
      files: [packagePath],
    }, 60_000);

    const validationDeadline = Date.now() + 300_000;
    let validation = null;
    while (Date.now() < validationDeadline) {
      validation = await json(`(() => {
        const submit = document.getElementById('submit-upload-file-finish');
        const result = document.getElementById('upload-status-results');
        const status = result?.closest('.upload-status');
        const errors = Array.from(document.querySelectorAll(
          '#upload_errors li, .errorlist li, #upload-status-results.status-fail'
        )).map((element) => (element.innerText || element.textContent || '').trim())
          .filter(Boolean)
          .slice(0, 20);
        return {
          continueDisabled: Boolean(submit?.disabled),
          hasUploadReference: Boolean(document.getElementById('id_upload')?.value),
          passed: Boolean(result?.classList.contains('status-pass')),
          statusClass: status?.className || '',
          statusText: (result?.innerText || result?.textContent || '').trim().slice(0, 2000),
          errors
        };
      })()`);
      if (validation.errors.length || (
        validation.passed &&
        validation.hasUploadReference &&
        !validation.continueDisabled
      )) break;
      await delay(500);
    }
    if (
      !validation ||
      validation.errors.length ||
      !validation.passed ||
      !validation.hasUploadReference ||
      validation.continueDisabled
    ) {
      throw new Error(`AMO validation did not pass: ${JSON.stringify(validation)}`);
    }
    if (!/(?:no errors (?:or|and) (?:no )?warnings|没有错误或警告|0\s*个错误.{0,40}0\s*个警告)/i.test(
      validation.statusText
    )) {
      throw new Error(`AMO did not explicitly report zero errors: ${validation.statusText}`);
    }
    console.error(JSON.stringify({
      stage: 'validation-passed',
      zeroErrors: true,
      continueEnabled: true,
    }));

    const submitted = await json(`(() => {
      const form = document.getElementById('create-addon');
      const button = document.getElementById('submit-upload-file-finish');
      if (!form || !button || button.disabled) return { ok: false };
      form.requestSubmit(button);
      return { ok: true };
    })()`);
    if (!submitted.ok) throw new Error('Could not submit the validated version');

    const sourceUrl = await waitForUrl(
      (url) => /\/versions\/submit\/\d+\/source(?:$|[?#])/.test(url),
      90_000,
      'source-code declaration page'
    );
    const versionIdMatch = sourceUrl.match(/\/versions\/submit\/(\d+)\/source/);
    const versionId = versionIdMatch?.[1] || '';
    assert.match(versionId, /^\d+$/, 'Created version ID was not found');
    console.error(JSON.stringify({ stage: 'version-created', version: expectedVersion, versionId }));

    const sourceState = await json(`(() => {
      const form = document.getElementById('submit-source');
      const no = form?.querySelector('input[name="has_source"][value="no"]');
      const submit = form?.querySelector('button[type="submit"], input[type="submit"]');
      return {
        ready: Boolean(form && no && submit),
        action: form?.action || '',
        method: form?.method?.toUpperCase() || ''
      };
    })()`);
    assert.equal(sourceState.ready, true, 'Source-code declaration controls were not found');
    assert.equal(sourceState.method, 'POST', 'Source-code declaration method changed');
    assert.match(sourceState.action, new RegExp(`/versions/submit/${versionId}/source(?:$|[?#])`));

    const sourceSubmitted = await json(`(() => {
      const form = document.getElementById('submit-source');
      const no = form?.querySelector('input[name="has_source"][value="no"]');
      const submit = form?.querySelector('button[type="submit"], input[type="submit"]');
      if (!form || !no || !submit) return { ok: false };
      no.click();
      if (!no.checked) return { ok: false };
      form.requestSubmit(submit);
      return { ok: true };
    })()`);
    if (!sourceSubmitted.ok) throw new Error('Could not declare that no separate source is needed');

    const finishUrl = await waitForUrl(
      (url) => new RegExp(`/versions/submit/${versionId}/finish(?:$|[?#])`).test(url),
      60_000,
      'submission completion page'
    );
    const finishState = await json(`(() => ({
      title: document.title,
      signaturePending: /signature pending|签名待处理|签名.*等待|等待.*签名/i.test(
        document.body?.innerText || ''
      ),
      submissionComplete: /submission complete|提交完成|你.*完成|您.*完成/i.test(
        document.body?.innerText || ''
      )
    }))()`);
    if (!finishState.signaturePending && !finishState.submissionComplete) {
      throw new Error(`Unexpected AMO completion page: ${JSON.stringify(finishState)}`);
    }
    console.error(JSON.stringify({ stage: 'submission-complete', versionId, finishUrl }));

    const detailUrl =
      `https://addons.mozilla.org/zh-CN/developers/addon/${encodeURIComponent(addonSlug)}` +
      `/versions/${versionId}`;
    const signingDeadline = Date.now() + signingTimeout;
    let signedBytes = null;
    let signedHref = '';
    let signedStatus = '';
    let nextProgress = 0;

    while (Date.now() < signingDeadline) {
      await navigate(detailUrl);
      const located = await json(`(() => {
        const links = Array.from(document.querySelectorAll('#file-list a[href], a[href]'))
          .filter((link) => /\\.xpi(?:$|[?#])/i.test(link.href));
        const link = links.find((item) =>
          (item.textContent || '').includes(${JSON.stringify(expectedVersion)}) ||
          item.href.includes(${JSON.stringify(expectedVersion)})
        ) || links[0] || null;
        const row = link?.closest('tr');
        const cells = row ? Array.from(row.cells).map((cell) =>
          (cell.innerText || cell.textContent || '').trim()
        ) : [];
        return {
          href: link?.href || '',
          status: cells[2] || '',
          fileName: (link?.innerText || link?.textContent || '').trim()
        };
      })()`);
      signedHref = located.href;
      signedStatus = located.status;

      if (signedHref) {
        const fetched = await json(`(async () => {
          const response = await fetch(${JSON.stringify(signedHref)}, {
            credentials: 'include',
            cache: 'no-store'
          });
          if (!response.ok) return { ok: false, status: response.status };
          const buffer = await response.arrayBuffer();
          if (!buffer.byteLength || buffer.byteLength > 5 * 1024 * 1024) {
            return { ok: false, status: response.status, unexpectedBytes: buffer.byteLength };
          }
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          return {
            ok: true,
            status: response.status,
            bytes: buffer.byteLength,
            contentType: response.headers.get('content-type') || '',
            base64: btoa(binary)
          };
        })()`);
        if (fetched.ok) {
          const candidate = Buffer.from(fetched.base64, 'base64');
          if (candidate.length !== fetched.bytes) throw new Error('Signed XPI byte count mismatch');
          try {
            const archive = inspectExtensionArchive(candidate);
            assertArchiveIdentity(archive, expectedVersion, expectedExtensionId, 'Signed XPI');
            if (archive.structurallySigned) signedBytes = { candidate, archive };
          } catch (error) {
            if (Date.now() + pollInterval >= signingDeadline) throw error;
          }
        }
      }

      if (signedBytes) break;
      if (Date.now() >= nextProgress) {
        console.error(JSON.stringify({
          stage: 'signing-pending',
          versionId,
          status: signedStatus || 'not-ready',
        }));
        nextProgress = Date.now() + 20_000;
      }
      await delay(pollInterval);
    }

    if (!signedBytes) {
      throw new Error(
        `Timed out waiting for signed XPI for ${expectedVersion}; last status: ${signedStatus}`
      );
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, signedBytes.candidate);
    const written = fs.readFileSync(outputPath);
    const writtenArchive = inspectExtensionArchive(written);
    assertArchiveIdentity(writtenArchive, expectedVersion, expectedExtensionId, 'Written XPI');
    assert.equal(writtenArchive.structurallySigned, true, 'Written XPI lacks signature metadata');
    assert.equal(written.length, signedBytes.candidate.length, 'Written XPI size mismatch');
    const signedHash = sha256(written);

    console.log(JSON.stringify({
      ok: true,
      mode: 'upload-and-submit',
      externalChanges: true,
      addon: addonSlug,
      version: expectedVersion,
      versionId,
      finishUrl,
      package: packageInfo,
      signed: {
        outputPath,
        bytes: written.length,
        sha256: signedHash,
        manifestVersion: writtenArchive.manifestVersion,
        extensionId: writtenArchive.extensionId,
        signatureEntries: writtenArchive.recognizedSignatureEntries,
        downloadUrl: signedHref,
        status: signedStatus,
      },
      versionsUrl,
    }, null, 2));
  } finally {
    if (sessionCreated) {
      await client.command('session.end', {}, 5000).catch(() => {});
    }
    client?.close();
    await terminate(firefox);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
