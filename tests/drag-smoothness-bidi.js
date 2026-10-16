'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const remotePortArg = process.argv.find((value) => value.startsWith('--port='));
const fixturePortArg = process.argv.find((value) => value.startsWith('--fixture-port='));
const artifactsArg = process.argv.find((value) => value.startsWith('--artifacts='));
const xpiArg = process.argv.find((value) => value.startsWith('--xpi='));

const remotePort = remotePortArg ? Number(remotePortArg.slice('--port='.length)) : 9222;
const fixturePort = fixturePortArg
  ? Number(fixturePortArg.slice('--fixture-port='.length))
  : 8787;
const artifacts = path.resolve(
  artifactsArg
    ? artifactsArg.slice('--artifacts='.length)
    : path.join(__dirname, 'artifacts', 'drag-smoothness'),
);
const xpiPath = xpiArg ? path.resolve(xpiArg.slice('--xpi='.length)) : null;
const fixtureOrigin = `http://localtest.me:${fixturePort}`;

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
    if (this.socket) this.socket.close();
  }
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function flatten(contexts, output = []) {
  for (const context of contexts || []) {
    output.push(context);
    flatten(context.children || [], output);
  }
  return output;
}

async function waitFor(fn, label, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for ${label}: ${lastError.message}`);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index];
}

function frameStats(samples) {
  const gaps = [];
  for (let index = 1; index < samples.length; index += 1) {
    const gap = samples[index].t - samples[index - 1].t;
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  gaps.sort((left, right) => left - right);
  const durationMs = samples.length > 1
    ? samples[samples.length - 1].t - samples[0].t
    : 0;
  return {
    sampleCount: samples.length,
    durationMs,
    effectiveFps: durationMs > 0
      ? ((samples.length - 1) * 1000) / durationMs
      : 0,
    medianGapMs: percentile(gaps, 0.5),
    p95GapMs: percentile(gaps, 0.95),
    p99GapMs: percentile(gaps, 0.99),
    maxGapMs: gaps.length ? gaps[gaps.length - 1] : 0,
  };
}

function nearestPriorPointer(pointerMoves, timestamp) {
  let low = 0;
  let high = pointerMoves.length - 1;
  let match = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (pointerMoves[middle].t <= timestamp) {
      match = pointerMoves[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

function chooseDelta(positiveRoom, negativeRoom, desired, minimum) {
  const positive = Math.max(0, positiveRoom);
  const negative = Math.max(0, negativeRoom);
  if (positive >= minimum || positive >= negative) {
    return Math.max(minimum, Math.min(desired, positive));
  }
  return -Math.max(minimum, Math.min(desired, negative));
}

async function main() {
  assert.ok(Number.isInteger(remotePort) && remotePort > 0, 'invalid BiDi port');
  assert.ok(Number.isInteger(fixturePort) && fixturePort > 0, 'invalid fixture port');
  assert.ok(xpiPath, '--xpi is required');
  assert.ok(fs.existsSync(xpiPath), `test XPI does not exist: ${xpiPath}`);
  fs.mkdirSync(artifacts, { recursive: true });

  const client = new BidiClient(`ws://127.0.0.1:${remotePort}/session`);
  let sessionCreated = false;
  let extensionId = null;
  try {
    await client.connect();
    const session = await client.command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    }, 60000);
    sessionCreated = true;
    const browserVersion = session.capabilities.browserVersion;

    const installed = await client.command('webExtension.install', {
      extensionData: {
        type: 'archivePath',
        path: xpiPath,
      },
      'moz:permanent': false,
    }, 60000);
    extensionId = installed.extension;
    assert.equal(
      extensionId,
      '{88cdb8a1-2007-44be-9965-7b08e3518437}',
      'temporary extension id did not match GlassPeek',
    );

    const top = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', {});
      return tree.contexts.find(
        (candidate) => candidate.url.startsWith(`${fixtureOrigin}/`),
      );
    }, 'local fixture tab', 30000);
    const context = top.context;
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
        result.exceptionDetails && result.exceptionDetails.text,
      );
      return result.result && result.result.value;
    }

    async function json(expression, targetContext = context) {
      const value = await evaluate(`JSON.stringify(${expression})`, targetContext);
      return JSON.parse(value);
    }

    async function callJson(functionDeclaration, targetContext, args = [], timeout = 30000) {
      const result = await client.command('script.callFunction', {
        functionDeclaration,
        target: { context: targetContext },
        awaitPromise: true,
        arguments: args,
        resultOwnership: 'none',
      }, timeout);
      assert.equal(
        result.type,
        'success',
        result.exceptionDetails && result.exceptionDetails.text,
      );
      return JSON.parse(result.result.value);
    }

    function parentMap(contexts, parent = null, output = new Map()) {
      for (const item of contexts || []) {
        output.set(item.context, parent);
        parentMap(item.children || [], item.context, output);
      }
      return output;
    }

    async function locateContextFrame(parentContext, childContext, label) {
      const located = await client.command('browsingContext.locateNodes', {
        context: parentContext,
        locator: {
          type: 'context',
          value: { context: childContext },
        },
        maxNodeCount: 1,
      });
      const frame = located.nodes && located.nodes[0];
      assert.ok(frame && frame.sharedId, `${label} embedding iframe was not found`);
      return frame.sharedId;
    }

    async function topLevelPoint(selector, targetContext, label) {
      const local = await json(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })()`, targetContext);
      assert.ok(
        local && Number.isFinite(local.x) && Number.isFinite(local.y),
        `${label} is not actionable`,
      );

      const tree = await client.command('browsingContext.getTree', { root: context });
      const parents = parentMap(tree.contexts);
      let current = targetContext;
      let x = local.x;
      let y = local.y;
      while (current !== context) {
        const parent = parents.get(current);
        assert.ok(parent, `${label} has no parent browsing context`);
        const frameId = await locateContextFrame(parent, current, label);
        const offset = await callJson(
          `(frame) => {
            const rect = frame.getBoundingClientRect();
            return JSON.stringify({
              x: rect.left + frame.clientLeft,
              y: rect.top + frame.clientTop
            });
          }`,
          parent,
          [{ sharedId: frameId }],
        );
        x += offset.x;
        y += offset.y;
        current = parent;
      }
      return { x: Math.round(x), y: Math.round(y) };
    }

    async function capture(fileName) {
      const image = await client.command('browsingContext.captureScreenshot', {
        context,
        origin: 'viewport',
        format: { type: 'image/png' },
      }, 60000);
      const filePath = path.join(artifacts, fileName);
      fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
      return filePath;
    }

    async function frameSnapshot(frameId) {
      return callJson(
        `(frame) => {
          const surface = frame.parentElement;
          const rect = surface.getBoundingClientRect();
          const style = getComputedStyle(surface);
          return JSON.stringify({
            rect: {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            },
            inlineTransform: surface.style.transform || "",
            computedTransform: style.transform,
            willChange: style.willChange,
            classes: surface.className
          });
        }`,
        context,
        [{ sharedId: frameId }],
      );
    }

    async function collectFrameTimeline(frameId, durationMs) {
      return callJson(
        `(frame) => new Promise((resolve) => {
          const surface = frame.parentElement;
          const samples = [];
          const started = performance.now();
          const absoluteOrigin = performance.timeOrigin;
          const sample = (now) => {
            const rect = surface.getBoundingClientRect();
            const style = getComputedStyle(surface);
            samples.push({
              t: absoluteOrigin + now,
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              inlineTransform: surface.style.transform || "",
              computedTransform: style.transform,
              willChange: style.willChange
            });
            if (now - started < ${Number(durationMs)}) {
              requestAnimationFrame(sample);
            } else {
              resolve(JSON.stringify(samples));
            }
          };
          requestAnimationFrame(sample);
        })`,
        context,
        [{ sharedId: frameId }],
        durationMs + 15000,
      );
    }

    const controller = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', {});
      return tree.contexts.find(
        (entry) => /\/welcome\/welcome\.html$/.test(entry.url),
      );
    }, 'extension controller page', 20000);
    await waitFor(async () => {
      try {
        return await evaluate(
          `document.readyState !== "loading" &&
            typeof globalThis.browser === "object" &&
            Boolean(globalThis.browser.storage?.sync)`,
          controller.context,
        );
      } catch (_error) {
        return false;
      }
    }, 'extension controller script readiness', 20000);
    await evaluate(`(async () => {
      await browser.storage.sync.set({
        enabled: true,
        longPress: true,
        longPressDelay: 420,
        drag: true,
        modifier: false,
        hoverSpace: false,
        position: "center",
        sizeMode: "px",
        widthPx: 720,
        heightPx: 520,
        rememberPosition: false,
        rememberSize: false,
        multiWindow: false,
        clickOutsideClose: false,
        backdrop: true,
        pinByDefault: false,
        forceCompatDomains: []
      });
      return true;
    })()`, controller.context);
    await sleep(600);

    await waitFor(async () => {
      const state = await json(`({
        readyState: document.readyState,
        linkCount: document.querySelectorAll('a[href]').length
      })`);
      return state.readyState === 'complete' && state.linkCount >= 10;
    }, 'fixture readiness', 30000);

    const triggerPoint = await topLevelPoint(
      'a[href^="/embed"]',
      context,
      'embeddable fixture link',
    );
    await client.command('input.performActions', {
      context,
      actions: [{
        type: 'pointer',
        id: 'glasspeek-drag-open',
        parameters: { pointerType: 'mouse' },
        actions: [
          {
            type: 'pointerMove',
            x: triggerPoint.x,
            y: triggerPoint.y,
            duration: 0,
            origin: 'viewport',
          },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 650 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await client.command('input.releaseActions', { context });

    const preview = await waitFor(async () => {
      const tree = await client.command('browsingContext.getTree', { root: context });
      const candidates = flatten(tree.contexts)
        .filter((entry) => /\/preview\/preview\.html$/.test(entry.url))
        .reverse();
      for (const candidate of candidates) {
        try {
          const ready = await evaluate(
            `document.getElementById("surface")?.classList.contains("is-ready") === true`,
            candidate.context,
          );
          if (ready) return candidate;
        } catch (_error) {
          // A just-rebuilt child context can be stale for one tree snapshot.
        }
      }
      return null;
    }, 'ready preview surface', 20000);

    const frameId = await locateContextFrame(
      context,
      preview.context,
      'preview control',
    );
    await sleep(350);
    const initial = await frameSnapshot(frameId);
    assert.ok(initial.rect.width >= 400 && initial.rect.height >= 300);
    const viewport = await json(`({
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      visibilityState: document.visibilityState
    })`);
    assert.equal(viewport.visibilityState, 'visible');

    const idleFrames = await collectFrameTimeline(frameId, 900);
    const idleStats = frameStats(idleFrames);
    const beforeScreenshot = await capture('drag-before.png');

    await evaluate(`(() => {
      const samples = [];
      const record = (event) => {
        if (event.pointerType && event.pointerType !== "mouse") return;
        samples.push({
          type: event.type,
          t: performance.timeOrigin + performance.now(),
          screenX: event.screenX,
          screenY: event.screenY,
          clientX: event.clientX,
          clientY: event.clientY,
          trusted: event.isTrusted,
          pointerId: event.pointerId
        });
      };
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
        document.addEventListener(type, record, true);
      }
      window.__glasspeekDragSamples = samples;
      return true;
    })()`, preview.context);

    const dragStart = await topLevelPoint(
      '#pageTitle',
      preview.context,
      'preview titlebar drag point',
    );
    const horizontalRoom = {
      positive: viewport.width - 12 - (initial.rect.x + initial.rect.width),
      negative: initial.rect.x - 12,
    };
    const verticalRoom = {
      positive: viewport.height - 12 - (initial.rect.y + initial.rect.height),
      negative: initial.rect.y - 12,
    };
    const plannedDx = chooseDelta(
      horizontalRoom.positive,
      horizontalRoom.negative,
      240,
      80,
    );
    const plannedDy = chooseDelta(
      verticalRoom.positive,
      verticalRoom.negative,
      140,
      60,
    );
    const stepCount = 120;
    const stepDurationMs = 8;
    const pointerActions = [
      {
        type: 'pointerMove',
        x: dragStart.x,
        y: dragStart.y,
        duration: 0,
        origin: 'viewport',
      },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 50 },
    ];
    for (let step = 1; step <= stepCount; step += 1) {
      pointerActions.push({
        type: 'pointerMove',
        x: Math.round(dragStart.x + (plannedDx * step) / stepCount),
        y: Math.round(dragStart.y + (plannedDy * step) / stepCount),
        duration: stepDurationMs,
        origin: 'viewport',
      });
    }
    pointerActions.push({ type: 'pointerUp', button: 0 });

    const timelinePromise = collectFrameTimeline(
      frameId,
      Math.max(3600, stepCount * stepDurationMs * 3),
    );
    await sleep(100);
    await client.command('input.performActions', {
      context,
      actions: [{
        type: 'pointer',
        id: 'glasspeek-titlebar-drag',
        parameters: { pointerType: 'mouse' },
        actions: pointerActions,
      }],
    }, 30000);
    await client.command('input.releaseActions', { context });
    const dragTimeline = await timelinePromise;

    const pointerSamples = await waitFor(async () => {
      const samples = await json(`window.__glasspeekDragSamples || []`, preview.context);
      return samples.some((sample) => sample.type === 'pointerup') ? samples : null;
    }, 'trusted titlebar pointer release', 5000);
    await sleep(120);
    const final = await frameSnapshot(frameId);
    const afterScreenshot = await capture('drag-after.png');

    const pointerDown = pointerSamples.find((sample) => sample.type === 'pointerdown');
    const pointerUp = [...pointerSamples]
      .reverse()
      .find((sample) => sample.type === 'pointerup');
    assert.ok(pointerDown, 'trusted titlebar pointerdown was not observed');
    assert.ok(pointerUp, 'trusted titlebar pointerup was not observed');
    assert.equal(pointerDown.trusted, true, 'titlebar pointerdown was not trusted');
    assert.equal(pointerUp.trusted, true, 'titlebar pointerup was not trusted');
    assert.equal(
      pointerUp.pointerId,
      pointerDown.pointerId,
      'pointer capture did not preserve the pointer identity',
    );
    assert.equal(
      pointerSamples.some((sample) => sample.type === 'pointercancel'),
      false,
      'titlebar drag was cancelled',
    );

    const observedDx = pointerUp.screenX - pointerDown.screenX;
    const observedDy = pointerUp.screenY - pointerDown.screenY;
    const expectedX = clamp(
      initial.rect.x + observedDx,
      -initial.rect.width + 60,
      viewport.width - 60,
    );
    const expectedY = clamp(
      initial.rect.y + observedDy,
      0,
      viewport.height - 44,
    );
    const finalError = {
      x: Math.abs(final.rect.x - expectedX),
      y: Math.abs(final.rect.y - expectedY),
      euclidean: Math.hypot(final.rect.x - expectedX, final.rect.y - expectedY),
    };
    const sizeError = {
      width: Math.abs(final.rect.width - initial.rect.width),
      height: Math.abs(final.rect.height - initial.rect.height),
    };

    const dragFrames = dragTimeline.filter(
      (sample) => sample.t >= pointerDown.t && sample.t <= pointerUp.t,
    );
    const dragStats = frameStats(dragFrames);
    let movementFrames = 0;
    let backwardsFrames = 0;
    for (let index = 1; index < dragFrames.length; index += 1) {
      const dx = dragFrames[index].x - dragFrames[index - 1].x;
      const dy = dragFrames[index].y - dragFrames[index - 1].y;
      if (Math.hypot(dx, dy) > 0.1) movementFrames += 1;
      if (
        (Math.sign(observedDx) && dx * Math.sign(observedDx) < -1) ||
        (Math.sign(observedDy) && dy * Math.sign(observedDy) < -1)
      ) {
        backwardsFrames += 1;
      }
    }
    const movementFrameRatio = dragFrames.length > 1
      ? movementFrames / (dragFrames.length - 1)
      : 0;
    const transformUsed = dragFrames.some(
      (sample) =>
        (sample.inlineTransform && sample.inlineTransform !== 'none') ||
        (sample.computedTransform && sample.computedTransform !== 'none'),
    );

    const pointerMoves = pointerSamples
      .filter((sample) =>
        sample.type === 'pointerdown' || sample.type === 'pointermove')
      .sort((left, right) => left.t - right.t);
    const trackingErrors = [];
    for (const frame of dragFrames) {
      const pointer = nearestPriorPointer(pointerMoves, frame.t);
      if (!pointer) continue;
      const expectedFrameX = clamp(
        initial.rect.x + pointer.screenX - pointerDown.screenX,
        -initial.rect.width + 60,
        viewport.width - 60,
      );
      const expectedFrameY = clamp(
        initial.rect.y + pointer.screenY - pointerDown.screenY,
        0,
        viewport.height - 44,
      );
      trackingErrors.push(Math.hypot(
        frame.x - expectedFrameX,
        frame.y - expectedFrameY,
      ));
    }
    trackingErrors.sort((left, right) => left - right);
    const tracking = {
      sampleCount: trackingErrors.length,
      medianErrorPx: percentile(trackingErrors, 0.5),
      p95ErrorPx: percentile(trackingErrors, 0.95),
      maxErrorPx: trackingErrors.length
        ? trackingErrors[trackingErrors.length - 1]
        : 0,
    };
    const sampleRateRatio = idleStats.effectiveFps > 0
      ? dragStats.effectiveFps / idleStats.effectiveFps
      : 0;
    const dragDurationMs = pointerUp.t - pointerDown.t;
    const movementUpdatesPerSecond = dragDurationMs > 0
      ? movementFrames * 1000 / dragDurationMs
      : 0;
    const speedPxPerMs = dragDurationMs > 0
      ? Math.hypot(observedDx, observedDy) / dragDurationMs
      : 0;
    const trackingLimitPx = Math.max(
      12,
      speedPxPerMs * Math.max(idleStats.p95GapMs, idleStats.medianGapMs) * 3 + 4,
    );

    const checks = [];
    function check(name, pass, details) {
      checks.push({ name, pass: Boolean(pass), details });
    }
    check(
      'planned pointer displacement reached',
      Math.abs(observedDx - plannedDx) <= 3 &&
        Math.abs(observedDy - plannedDy) <= 3,
      { plannedDx, plannedDy, observedDx, observedDy },
    );
    check(
      'final position is accurate',
      finalError.x <= 2 && finalError.y <= 2,
      { expectedX, expectedY, actualX: final.rect.x, actualY: final.rect.y, finalError },
    );
    check(
      'drag does not resize the preview',
      sizeError.width <= 1 && sizeError.height <= 1,
      sizeError,
    );
    check(
      'compositor transform was used during drag',
      transformUsed,
      { transformUsed },
    );
    check(
      'transform state is cleared after release',
      (!final.inlineTransform || final.inlineTransform === 'none') &&
        final.computedTransform === 'none' &&
        !String(final.willChange).split(',').map((value) => value.trim()).includes('transform'),
      {
        inlineTransform: final.inlineTransform,
        computedTransform: final.computedTransform,
        willChange: final.willChange,
      },
    );
    check(
      'drag produced enough animation samples',
      dragFrames.length >= 20 && sampleRateRatio >= 0.55,
      {
        dragSampleCount: dragFrames.length,
        sampleRateRatio,
        idleFps: idleStats.effectiveFps,
        dragFps: dragStats.effectiveFps,
      },
    );
    check(
      'drag frame cadence stayed near idle',
      dragStats.medianGapMs <= Math.max(
        idleStats.medianGapMs * 1.75,
        idleStats.medianGapMs + 4,
      ) &&
        dragStats.p95GapMs <= Math.max(
          40,
          idleStats.p95GapMs * 2.5,
          idleStats.medianGapMs * 4,
        ) &&
        dragStats.maxGapMs <= Math.max(120, idleStats.maxGapMs * 3),
      { idle: idleStats, drag: dragStats },
    );
    check(
      'drag path moved continuously without reversing',
      movementFrames >= 20 &&
        movementUpdatesPerSecond >= 30 &&
        backwardsFrames === 0,
      {
        movementFrames,
        movementFrameRatio,
        movementUpdatesPerSecond,
        backwardsFrames,
      },
    );
    check(
      'surface tracked the trusted pointer',
      tracking.sampleCount >= 10 && tracking.p95ErrorPx <= trackingLimitPx,
      { ...tracking, trackingLimitPx },
    );
    check(
      'preview remained ready after release',
      /ready/.test(final.classes),
      { classes: final.classes },
    );

    const report = {
      ok: checks.every((entry) => entry.pass),
      browserVersion,
      extensionId,
      xpiPath,
      fixtureOrigin,
      viewport,
      initial,
      final,
      path: {
        start: dragStart,
        plannedDx,
        plannedDy,
        observedDx,
        observedDy,
        durationMs: dragDurationMs,
        finalError,
        sizeError,
      },
      performance: {
        idle: idleStats,
        drag: dragStats,
        sampleRateRatio,
        movementFrames,
        movementFrameRatio,
        movementUpdatesPerSecond,
        backwardsFrames,
        transformUsed,
        tracking: { ...tracking, limitPx: trackingLimitPx },
      },
      checks,
      artifacts: {
        beforeScreenshot,
        afterScreenshot,
        report: path.join(artifacts, 'drag-smoothness.json'),
      },
    };
    fs.writeFileSync(
      report.artifacts.report,
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify(report, null, 2));
    assert.equal(
      report.ok,
      true,
      `drag smoothness acceptance failed:\n${checks
        .filter((entry) => !entry.pass)
        .map((entry) => `- ${entry.name}: ${JSON.stringify(entry.details)}`)
        .join('\n')}`,
    );
  } finally {
    if (sessionCreated) {
      await client.command('session.end', {}, 15000).catch(() => {});
    }
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
