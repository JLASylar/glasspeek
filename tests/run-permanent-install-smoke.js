'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createTestServer } = require('./test-server');

const ROOT = path.resolve(__dirname, '..');
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const xpiArg = process.argv.find((value) => value.startsWith('--xpi='));
const XPI = path.resolve(
  xpiArg
    ? xpiArg.slice('--xpi='.length)
    : path.join(ROOT, 'output', 'release-2.4.0', 'glasspeek-2.4.0-signed.xpi'),
);
const EXPECTED_ID = '{88cdb8a1-2007-44be-9965-7b08e3518437}';
const EXPECTED_VERSION = '2.4.0';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
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
        if (Date.now() >= deadline) reject(new Error(`Firefox remote port ${port} did not open`));
        else setTimeout(attempt, 200);
      };
      socket.once('timeout', retry);
      socket.once('error', retry);
    };
    attempt();
  });
}

function waitForFixture(url, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const health = JSON.parse(body);
            if (
              response.statusCode === 200 &&
              health.ok === true &&
              Array.isArray(health.routes) &&
              health.routes.includes('/embed')
            ) {
              resolve();
              return;
            }
          } catch {
            // Retry until the process-owned fixture returns its exact health payload.
          }
          if (Date.now() >= deadline) {
            reject(new Error(`Fixture health check failed (${response.statusCode})`));
            return;
          }
          setTimeout(attempt, 150);
        });
      });
      request.setTimeout(1000, () => request.destroy());
      request.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('Fixture server did not start'));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function startFixtureServer() {
  const server = createTestServer();
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      if (!Number.isInteger(port) || port <= 0) {
        server.close();
        reject(new Error('Process-owned fixture did not receive a valid random port'));
        return;
      }
      resolve({ server, port });
    });
  });
}

function closeFixtureServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function waitForExit(child, label, timeout = 120_000) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ stdout: '', stderr: '' });
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`${label} timed out\n${stderr}`)), timeout);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} failed (${code ?? signal})\n${stderr}\n${stdout}`));
    });
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

function launchFirefox(profile, port, fixtureUrl) {
  return spawn(FIREFOX, [
    '-no-remote',
    '-profile',
    profile,
    '--remote-debugging-port',
    String(port),
    fixtureUrl,
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function runNode(script, args, label) {
  const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return waitForExit(child, label);
}

async function main() {
  if (!fs.existsSync(FIREFOX)) throw new Error(`Firefox not found: ${FIREFOX}`);
  if (!fs.existsSync(XPI)) throw new Error(`Signed XPI not found: ${XPI}`);
  const inputXpiHash = sha256File(XPI);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = path.join(ROOT, 'tests', 'artifacts', `permanent-${runId}`);
  const profile = path.join(runRoot, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const relativeProfile = path.relative(path.join(ROOT, 'tests', 'artifacts'), profile);
  assert.ok(
    relativeProfile &&
      !relativeProfile.startsWith('..') &&
      !path.isAbsolute(relativeProfile) &&
      relativeProfile.split(path.sep)[0].startsWith('permanent-'),
    `refusing to use non-disposable profile: ${profile}`,
  );

  let server = null;
  let firefox = null;
  try {
    const fixture = await startFixtureServer();
    server = fixture.server;
    const fixtureUrl = `http://localtest.me:${fixture.port}/`;
    await waitForFixture(`http://127.0.0.1:${fixture.port}/healthz`);

    const installPort = await reservePort();
    firefox = launchFirefox(profile, installPort, fixtureUrl);
    await waitForPort(installPort);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const install = await runNode('install-bidi.js', [
      `--port=${installPort}`,
      `--xpi=${XPI}`,
      `--expected-id=${EXPECTED_ID}`,
      `--expected-sha256=${inputXpiHash}`,
      '--close-browser',
    ], 'Permanent Firefox install');
    await waitForExit(firefox, 'Graceful Firefox shutdown after install', 30_000);
    firefox = null;

    const restartPort = await reservePort();
    firefox = launchFirefox(profile, restartPort, fixtureUrl);
    await waitForPort(restartPort);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const postinstall = await runNode('postinstall-smoke.js', [
      `--port=${restartPort}`,
      `--fixture-url=${fixtureUrl}`,
      `--expected-id=${EXPECTED_ID}`,
      `--expected-version=${EXPECTED_VERSION}`,
      `--screenshot=${path.join(runRoot, 'postinstall-smoke.png')}`,
    ], 'Post-restart GlassPeek smoke');

    const extensionsPath = path.join(profile, 'extensions.json');
    const extensions = JSON.parse(fs.readFileSync(extensionsPath, 'utf8'));
    const addon = extensions.addons.find((entry) => entry.id === EXPECTED_ID);
    assert.ok(addon, `GlassPeek was missing after restart: ${JSON.stringify(addon)}`);
    assert.equal(addon.version, EXPECTED_VERSION, 'persisted GlassPeek version did not match');
    assert.equal(addon.active, true, 'persisted GlassPeek was not active');
    assert.equal(addon.userDisabled, false, 'persisted GlassPeek was user-disabled');
    assert.equal(addon.appDisabled, false, 'persisted GlassPeek was app-disabled');
    assert.equal(addon.signedState, 2, 'persisted GlassPeek was not Mozilla-signed');

    const profileXpi = path.join(profile, 'extensions', `${EXPECTED_ID}.xpi`);
    assert.ok(fs.statSync(profileXpi).isFile(), `persisted XPI was missing: ${profileXpi}`);
    const profileXpiHash = sha256File(profileXpi);
    assert.equal(
      profileXpiHash,
      inputXpiHash,
      'persisted profile XPI SHA-256 did not match the signed input package',
    );

    console.log(JSON.stringify({
      ok: true,
      xpi: XPI,
      xpiSha256: inputXpiHash,
      profile,
      fixtureUrl,
      installed: JSON.parse(install.stdout),
      afterRestart: JSON.parse(postinstall.stdout),
      persisted: {
        id: addon.id,
        version: addon.version,
        active: addon.active,
        userDisabled: addon.userDisabled,
        appDisabled: addon.appDisabled,
        signedState: addon.signedState,
        profileXpi,
        profileXpiSha256: profileXpiHash,
      },
    }, null, 2));
  } finally {
    await terminate(firefox);
    await closeFixtureServer(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
