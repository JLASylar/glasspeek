'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const portArg = process.argv.find((value) => value.startsWith('--port='));
const uuidArg = process.argv.find((value) => value.startsWith('--uuid='));

function waitForHttp(url, timeout = 15_000) {
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
          reject(new Error(`Local fixture returned ${response.statusCode}`));
          return;
        }
        setTimeout(attempt, 150);
      });
      request.setTimeout(800, () => request.destroy());
      request.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error('Local fixture server did not start'));
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function waitForExit(child, label, timeout = 60_000) {
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
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  if (!portArg || !uuidArg) {
    throw new Error('--port and --uuid are required');
  }
  let server = null;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'test-server.js')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForHttp('http://127.0.0.1:8787/');
    const readback = spawn(process.execPath, [
      path.join(__dirname, 'runtime-readback.js'),
      portArg,
      uuidArg,
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const result = await waitForExit(readback, 'Main-profile runtime readback');
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
  } finally {
    await terminate(server);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
