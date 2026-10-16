'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const PROFILE = path.join(ROOT, 'tests', 'artifacts', 'amo-upload-active', 'profile');
const command = process.argv[2] || 'inspect';
const urlArg = process.argv.find((value) => value.startsWith('--url='));
const url = urlArg
  ? urlArg.slice('--url='.length)
  : 'https://addons.mozilla.org/en-US/developers/addons';
const forwarded = process.argv.slice(3).filter((value) => !value.startsWith('--url='));

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

function waitForExit(child, timeout = 300_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`AMO command timed out\n${stderr}`)), timeout);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`AMO command failed (${code ?? signal})\n${stderr}\n${stdout}`));
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

async function main() {
  if (!fs.existsSync(FIREFOX)) throw new Error(`Firefox not found: ${FIREFOX}`);
  if (!fs.existsSync(path.join(PROFILE, 'cookies.sqlite'))) {
    throw new Error(`Temporary AMO profile is missing its cookie database: ${PROFILE}`);
  }
  const port = await reservePort();
  let firefox = null;
  try {
    firefox = spawn(FIREFOX, [
      '-no-remote',
      '-profile',
      PROFILE,
      '--remote-debugging-port',
      String(port),
      url,
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForPort(port);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const bidi = spawn(process.execPath, [
      path.join(__dirname, 'amo-bidi.js'),
      command,
      `--port=${port}`,
      `--target-url=${url}`,
      ...forwarded,
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const result = await waitForExit(bidi);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
  } finally {
    await terminate(firefox);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
