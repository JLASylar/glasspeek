'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const firefoxPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const xpiArg = process.argv.find((value) => value.startsWith('--xpi='));
const includeLiveSites = process.argv.includes('--live-sites');
const headless = process.argv.includes('--headless');
const skipZoom = process.argv.includes('--skip-zoom');
const xpiPath = path.resolve(
  xpiArg
    ? xpiArg.slice('--xpi='.length)
    : path.join(root, 'output', 'release-2.4.0', 'glasspeek-2.4.0-unsigned.zip'),
);

function waitForExit(child, label, timeout = 120000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out\n${stderr}`));
    }, timeout);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
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

function waitForHttp(url, timeout = 15000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`fixture server returned ${response.statusCode}`));
          return;
        }
        setTimeout(attempt, 150);
      });
      request.setTimeout(1000, () => request.destroy());
      request.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error('fixture server did not start'));
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
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

async function main() {
  assert.ok(fs.existsSync(firefoxPath), `Firefox does not exist: ${firefoxPath}`);
  assert.ok(fs.existsSync(xpiPath), `test package does not exist: ${xpiPath}`);

  const remotePort = await reservePort();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = path.join(root, 'tests', 'artifacts', `isolated-${runId}`);
  const profilePath = path.join(runRoot, 'profile');
  const screenshotPath = path.join(runRoot, 'screenshots');
  fs.mkdirSync(profilePath, { recursive: true });
  fs.mkdirSync(screenshotPath, { recursive: true });

  let server = null;
  let firefox = null;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'test-server.js')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForHttp('http://127.0.0.1:8787/');

    const firefoxArgs = [
      '-no-remote',
      '-profile',
      profilePath,
      '--remote-debugging-port',
      String(remotePort),
      'http://localtest.me:8787/',
    ];
    if (headless) firefoxArgs.unshift('-headless');
    firefox = spawn(firefoxPath, firefoxArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    firefox.stderr?.on('data', (chunk) => {
      process.stderr.write(`[firefox] ${String(chunk)}`);
    });
    await waitForPort(remotePort);
    // Firefox can expose the WebSocket port before its WebDriver actors have
    // finished registering. Give the fresh disposable profile time to settle
    // so session.new does not race BrowserGlue startup.
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const smokeArgs = [
      path.join(__dirname, 'diag-bidi-bili.js'),
      `--port=${remotePort}`,
      `--artifacts=${screenshotPath}`,
      `--xpi=${xpiPath}`,
      '--bili-only',
    ];
    if (includeLiveSites) smokeArgs.push('--live-sites');
    if (process.argv.includes('--same-site-top')) smokeArgs.push('--same-site-top');
    const targetArg = process.argv.find((value) => value.startsWith('--target='));
    if (targetArg) smokeArgs.push(targetArg);
    if (skipZoom) smokeArgs.push('--skip-zoom');
    const smoke = spawn(process.execPath, smokeArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const result = await waitForExit(smoke, 'Firefox Bilibili diagnostic', 120000);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    process.stderr.write(`\n[isolated] profile: ${profilePath}\n`);
    process.stderr.write(`[isolated] screenshots: ${screenshotPath}\n`);
  } finally {
    await terminate(firefox);
    await terminate(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
