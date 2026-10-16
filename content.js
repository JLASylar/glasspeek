(() => {
  "use strict";

  if (globalThis.__glassPeekV2ContentLoaded) return;
  Object.defineProperty(globalThis, "__glassPeekV2ContentLoaded", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const CHANNEL = "glasspeek-v2";
  const REMOTE_CHANNEL = "glasspeek-remote-v2";
  const SURFACE_CHANNEL = "glasspeek-surface-v2";
  const GP = globalThis.GlassPeek || {};
  const EXTENSION_ORIGIN = new URL(browser.runtime.getURL("")).origin;
  let remotePort = null;
  let remoteSurfaceActive = false;
  let remoteSurfaceNonce = null;

  function navigationType() {
    try {
      const entry = performance.getEntriesByType("navigation")[0];
      return entry && typeof entry.type === "string" ? entry.type : "";
    } catch (_error) {
      return "";
    }
  }

  function safeHttpUrl(value) {
    try {
      if (GP.normalizeUrl) return GP.normalizeUrl(value, location.href);
      if (typeof value !== "string" || value.length > 32768 || /[\u0000-\u001f\u007f]/.test(value)) return null;
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname) return null;
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function signalRemote(type, extra = {}) {
    const message = {
      type,
      url: location.href,
      title: document.title,
      historyLength: Number(history.length) || null,
      navigationType: navigationType(),
      ...extra
    };
    if (remotePort) {
      try { remotePort.postMessage(message); } catch (_error) {}
    }
    if (remoteSurfaceActive) {
      try {
        window.parent.postMessage(
          {
            channel: REMOTE_CHANNEL,
            surfaceNonce: remoteSurfaceNonce,
            ...message
          },
          EXTENSION_ORIGIN
        );
      } catch (_error) {
        // A preview must never break the page it is observing.
      }
    }
  }

  if (window.top !== window) {
    let remoteConfig = {
      active: false,
      role: "direct",
      openLinksInNewPreview: false,
      sourceUrl: null
    };
    let windowOpenBridgeInstalled = false;
    let historyBridgeInstalled = false;
    let historyCaptureEnabled = true;
    const pendingHistorySignals = [];
    const historyBridgeOriginals = new Map();
    const historyBridgeExports = new Map();
    const MAX_PENDING_HISTORY_SIGNALS = 64;
    let refusalWatchGeneration = 0;
    try {
      remotePort = browser.runtime.connect({ name: "gp-target-v2" });
      remotePort.onMessage.addListener((message) => {
        if (!message || typeof message.type !== "string") return;
        if (message.type === "command" && remoteConfig.active) {
          let accepted = true;
          if (
            message.action !== "reload" &&
            message.action !== "stop"
          ) {
            accepted = false;
          }
          signalRemote("command-ack", {
            action: message.action,
            generation: message.generation,
            navigationToken: message.navigationToken,
            accepted
          });
          if (!accepted) return;
          try {
            if (message.action === "reload") location.reload();
            else window.stop();
          } catch (_error) {
            signalRemote("command-ack", {
              action: message.action,
              generation: message.generation,
              navigationToken: message.navigationToken,
              accepted: false
            });
          }
          return;
        }
        if (message.type !== "config") return;
        remoteConfig.active = true;
        remoteSurfaceActive = true;
        remoteConfig.role = message.role === "descendant" ? "descendant" : "direct";
        remoteConfig.openLinksInNewPreview = message.openLinksInNewPreview === true;
        remoteConfig.sourceUrl = safeHttpUrl(message.sourceUrl);
        remoteSurfaceNonce = null;
        historyCaptureEnabled = true;
        installWindowOpenBridge();
        if (remoteConfig.role === "direct") {
          installHistoryBridge();
          flushPendingHistorySignals();
        } else {
          restoreHistoryBridge();
        }
        signalRemote("alive");
        scheduleEmbeddedRefusalWatch();
      });
      remotePort.onDisconnect.addListener(() => {
        remotePort = null;
        if (!remoteConfig.active) restoreHistoryBridge();
      });
    } catch (_error) {
      remotePort = null;
    }
    const announce = () => signalRemote("alive");
    function detectEmbeddedRefusal() {
      if (!remoteConfig.active || remoteConfig.role !== "direct") return false;
      const text = String(document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .trim();
      if (
        !text ||
        text.length > 1600 ||
        document.querySelectorAll("a,button,input,video,article").length > 12
      ) return false;
      if (
        /您正在访问仿冒网站|請使用.+官方域名|请使用.+官方域名|cannot be displayed in (?:a |this )?frame|blocked from loading in (?:a |this )?frame|refused to connect|please open (?:this page )?in (?:your )?browser/i.test(
          text
        )
      ) {
        signalRemote("embed-refused", { reason: "site-warning" });
        return true;
      }
      return false;
    }
    function scheduleEmbeddedRefusalWatch() {
      const generation = ++refusalWatchGeneration;
      for (const delay of [0, 250, 1000, 3000, 8000]) {
        setTimeout(() => {
          if (generation !== refusalWatchGeneration) return;
          if (detectEmbeddedRefusal()) refusalWatchGeneration += 1;
        }, delay);
      }
    }
    announce();
    document.addEventListener("DOMContentLoaded", () => {
      announce();
      scheduleEmbeddedRefusalWatch();
    }, { once: true });
    window.addEventListener("pageshow", () => {
      announce();
      scheduleEmbeddedRefusalWatch();
    });
    window.addEventListener("hashchange", announce);
    window.addEventListener("popstate", () => {
      signalRemote("history-pop");
      announce();
    });
    document.addEventListener("DOMContentLoaded", () => {
      const titleElement = document.querySelector("title");
      if (!titleElement) return;
      let titleTimer = 0;
      new MutationObserver(() => {
        clearTimeout(titleTimer);
        titleTimer = setTimeout(announce, 50);
      }).observe(titleElement, { childList: true, characterData: true, subtree: true });
    }, { once: true });

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.origin !== EXTENSION_ORIGIN) return;
      const data = event.data;
      if (!data || data.channel !== SURFACE_CHANNEL || data.type !== "config") return;
      if (
        typeof data.surfaceNonce !== "string" ||
        data.surfaceNonce.length < 16 ||
        data.surfaceNonce.length > 128
      ) return;
      remoteConfig = {
        active: true,
        role: data.role === "descendant" ? "descendant" : "direct",
        openLinksInNewPreview: data.openLinksInNewPreview === true,
        sourceUrl: safeHttpUrl(data.sourceUrl)
      };
      remoteSurfaceActive = true;
      remoteSurfaceNonce = data.surfaceNonce;
      historyCaptureEnabled = true;
      installWindowOpenBridge();
      if (remoteConfig.role === "direct") {
        installHistoryBridge();
        flushPendingHistorySignals();
      } else {
        restoreHistoryBridge();
      }
      signalRemote("alive");
      scheduleEmbeddedRefusalWatch();
    });

    document.addEventListener("keydown", (event) => {
      if (!remoteConfig.active || !event.isTrusted) return;
      if (event.key === "Enter" || event.key === " ") {
        const target = event.target instanceof Element ? event.target : null;
        let submitter = previewSubmitterFrom(target);
        if (!submitter && event.key === "Enter") {
          const form = target && target.closest("form");
          submitter = form && form.querySelector(
            "button:not([type]), button[type='submit'], input[type='submit'], input[type='image']"
          );
        }
        if (submitter) preparePreviewFormActivation(submitter);
      }
      if (
        event.altKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const message = {
          direction: event.key === "ArrowLeft" ? "back" : "forward",
        };
        signalRemote("history-shortcut", message);
        return;
      }
      if (event.key === "Escape") {
        signalRemote("escape", { shiftKey: event.shiftKey });
      }
    }, true);
    document.addEventListener("pointerdown", (event) => {
      if (!remoteConfig.active || !event.isTrusted) return;
      signalRemote("activate");
    }, true);

    const linkFromEvent = (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      for (const node of path) {
        if (!(node instanceof Element)) continue;
        const link = node.matches("a[href]") ? node : node.closest && node.closest("a[href]");
        if (link) {
          const url = safeHttpUrl(link.href);
          if (url) return { link, url };
          let scheme = "";
          try { scheme = new URL(link.href, location.href).protocol; } catch (_error) {}
          return { link, url: null, scheme };
        }
      }
      return null;
    };

    const effectiveTarget = (link) => {
      const explicit = String(link.target || "").trim().toLowerCase();
      if (explicit) return explicit;
      const base = document.querySelector("base[target]");
      return String((base && base.target) || "").trim().toLowerCase();
    };

    const navigatePreviewRoot = (url) => {
      signalRemote("navigate-root", {
        targetUrl: url,
        userActivated: navigator.userActivation?.isActive === true
      });
    };

    const interceptPreviewNavigation = (event, middle = false) => {
      if (!remoteConfig.active || !event.isTrusted) return;
      const found = linkFromEvent(event);
      if (!found) return;
      if (event.defaultPrevented && !middle) return;
      if (!found.url) {
        event.preventDefault();
        event.stopImmediatePropagation();
        signalRemote("unsupported-link", {
          scheme: String(found.scheme || "").slice(0, 24)
        });
        return;
      }
      if (found.link.hasAttribute("download")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        signalRemote("open-external", {
          targetUrl: found.url,
          background: false,
          reason: "download"
        });
        return;
      }
      const targetName = effectiveTarget(found.link);
      const namedTargetExists =
        targetName &&
        !targetName.startsWith("_") &&
        !!document.querySelector(
          `iframe[name="${CSS.escape(targetName)}"],frame[name="${CSS.escape(targetName)}"]`
        );
      if (namedTargetExists) return;
      const wantsSeparate =
        middle ||
        (targetName && targetName !== "_self") ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey;
      event.preventDefault();
      if (wantsSeparate && remoteConfig.openLinksInNewPreview) {
        signalRemote("new-preview", {
          targetUrl: found.url,
          background: middle || event.ctrlKey || event.metaKey
        });
        return;
      }
      // Route ordinary and separate-target links through one authenticated
      // root-navigation ledger. This makes deep frames behave like the direct
      // page and lets the host use replacement navigation to reduce joint
      // iframe-history pollution.
      navigatePreviewRoot(found.url);
    };
    window.addEventListener(
      "click",
      (event) => interceptPreviewNavigation(event, false),
      true
    );
    window.addEventListener("auxclick", (event) => {
      if (event.button === 1) interceptPreviewNavigation(event, true);
    }, true);

    const pendingFormTargetRestores = new WeakMap();

    function previewSubmitterFrom(element) {
      const candidate = element && element.closest
        ? element.closest("button, input")
        : null;
      if (!candidate || !candidate.form || candidate.form.localName !== "form") return null;
      const inputType = candidate instanceof HTMLInputElement
        ? String(candidate.type || "").toLowerCase()
        : "";
      const buttonType = candidate instanceof HTMLButtonElement
        ? String(candidate.type || "submit").toLowerCase()
        : "";
      if (
        !(candidate instanceof HTMLButtonElement && buttonType === "submit") &&
        !(candidate instanceof HTMLInputElement && (inputType === "submit" || inputType === "image"))
      ) return null;
      return candidate;
    }

    function preparePreviewFormActivation(candidate) {
      if (!candidate || !candidate.form) return;
      const form = candidate.form;
      const targetName = String(
        candidate.getAttribute("formtarget") ||
        form.target ||
        document.querySelector("base[target]")?.target ||
        ""
      ).trim().toLowerCase();
      if (!targetName || targetName === "_self") return;

      let pending = pendingFormTargetRestores.get(form);
      if (!pending) {
        pending = {
          timer: 0,
          formTarget: form.getAttribute("target"),
          submitters: new Map()
        };
        pendingFormTargetRestores.set(form, pending);
      }
      clearTimeout(pending.timer);
      if (!pending.submitters.has(candidate)) {
        pending.submitters.set(candidate, candidate.getAttribute("formtarget"));
      }
      form.setAttribute("target", "_self");
      if (candidate.hasAttribute("formtarget")) candidate.setAttribute("formtarget", "_self");
      pending.timer = setTimeout(() => {
        if (pending.formTarget == null) form.removeAttribute("target");
        else form.setAttribute("target", pending.formTarget);
        for (const [submitter, previousTarget] of pending.submitters) {
          if (!submitter.isConnected) continue;
          if (previousTarget == null) submitter.removeAttribute("formtarget");
          else submitter.setAttribute("formtarget", previousTarget);
        }
        pendingFormTargetRestores.delete(form);
      }, 250);
    }

    function retargetFormActivation(event) {
      if (!remoteConfig.active || !event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      const candidate = previewSubmitterFrom(target);
      if (candidate) preparePreviewFormActivation(candidate);
    }

    // Firefox resolves a submit button's browsing target before dispatching
    // click. Prepare it at pointer/key activation time, while preserving the
    // original attribute for page scripts after the submission starts.
    document.addEventListener("pointerdown", retargetFormActivation, true);
    document.addEventListener("click", retargetFormActivation, true);

    // Forms often inherit <base target="_blank"> and otherwise appear inert in
    // the sandbox. Preserve their method and fields while submitting in-frame.
    document.addEventListener("submit", (event) => {
      if (
        !remoteConfig.active ||
        !event.isTrusted ||
        !(event.target instanceof HTMLFormElement)
      ) return;
      const form = event.target;
      const targetName = String(form.target || document.querySelector("base[target]")?.target || "")
        .trim()
        .toLowerCase();
      if (!targetName || targetName === "_self") return;
      const previous = form.getAttribute("target");
      form.setAttribute("target", "_self");
      setTimeout(() => {
        if (previous == null) form.removeAttribute("target");
        else form.setAttribute("target", previous);
      }, 0);
    }, true);

    function installWindowOpenBridge() {
      if (
        windowOpenBridgeInstalled ||
        !remoteConfig.active ||
        typeof exportFunction !== "function" ||
        !window.wrappedJSObject
      ) return;

      try {
        const pageWindow = window.wrappedJSObject;
        const nativeOpen = window.open.bind(window);
        const bridgedOpen = exportFunction(
          (rawUrl, rawTarget, rawFeatures) => {
            const targetName = String(rawTarget || "_blank").trim().toLowerCase();
            const url = safeHttpUrl(String(rawUrl || ""));
            if (!navigator.userActivation?.isActive || !url) {
              try {
                return nativeOpen(rawUrl, rawTarget, rawFeatures);
              } catch {
                return null;
              }
            }
            if (targetName === "_self") {
              navigatePreviewRoot(url);
              return null;
            }
            if (targetName === "_parent" || targetName === "_top") {
              navigatePreviewRoot(url);
              return null;
            }
            if (targetName && targetName !== "_blank" && !targetName.startsWith("_")) {
              try {
                return nativeOpen(rawUrl, rawTarget, rawFeatures);
              } catch {
                return null;
              }
            }
            if (remoteConfig.openLinksInNewPreview) {
              signalRemote("new-preview", {
                targetUrl: url,
                background: false
              });
              return null;
            }
            navigatePreviewRoot(url);
            return null;
          },
          pageWindow
        );
        if (
          Reflect.defineProperty(pageWindow, "open", {
            configurable: true,
            writable: true,
            value: bridgedOpen
          })
        ) {
          windowOpenBridgeInstalled = true;
        }
      } catch (_error) {
        // A site may freeze window.open. Anchor and form routing still works.
      }
    }

    function installHistoryBridge() {
      if (
        historyBridgeInstalled ||
        typeof exportFunction !== "function" ||
        !window.wrappedJSObject
      ) return;

      try {
        const pageHistory = window.wrappedJSObject.history;
        const nativeHistoryMethods = new Map();
        for (const name of ["pushState", "replaceState"]) {
          const original = pageHistory[name];
          if (typeof original !== "function") throw new Error("history-method-missing");
          historyBridgeOriginals.set(name, original);
          nativeHistoryMethods.set(name, original);
        }
        for (const name of ["pushState", "replaceState"]) {
          const original = nativeHistoryMethods.get(name);
          const bridged = exportFunction(
            (...args) => {
              // Preserve the site's native SPA semantics. GlassPeek records the
              // operation in its own ledger, while Firefox still owns the
              // underlying iframe session history.
              const result = Reflect.apply(original, pageHistory, args);
              if (!historyCaptureEnabled) return result;
              const snapshot = {
                action: name,
                url: location.href,
                title: document.title,
                historyLength: Number(history.length) || null,
                navigationType: navigationType()
              };
              if (remoteConfig.active) {
                signalRemote("history-state", snapshot);
              } else {
                if (pendingHistorySignals.length >= MAX_PENDING_HISTORY_SIGNALS) {
                  pendingHistorySignals.shift();
                }
                pendingHistorySignals.push(snapshot);
              }
              return result;
            },
            pageHistory
          );
          historyBridgeExports.set(name, bridged);
          if (
            !Reflect.defineProperty(pageHistory, name, {
              configurable: true,
              writable: true,
              value: bridged
            })
          ) {
            throw new Error("history-method-locked");
          }
        }
        historyBridgeInstalled = true;
      } catch (_error) {
        // Frozen History methods still receive best-effort webNavigation events.
      }
    }

    function flushPendingHistorySignals() {
      if (!remoteConfig.active || !pendingHistorySignals.length) return;
      const queued = pendingHistorySignals.splice(0);
      for (const snapshot of queued) {
        signalRemote("history-state", snapshot);
      }
    }

    function restoreHistoryBridge() {
      historyCaptureEnabled = false;
      pendingHistorySignals.length = 0;
      if (!historyBridgeOriginals.size || !window.wrappedJSObject) return;
      try {
        const pageHistory = window.wrappedJSObject.history;
        for (const [name, original] of historyBridgeOriginals) {
          if (pageHistory[name] !== historyBridgeExports.get(name)) continue;
          Reflect.defineProperty(pageHistory, name, {
            configurable: true,
            writable: true,
            value: original
          });
        }
      } catch (_error) {
        // A page may replace or freeze History after document_start.
      }
    }

    return;
  }

  if (window.__glassPeekV2Loaded) return;
  window.__glassPeekV2Loaded = true;

  const LOCAL_DEFAULTS = {
    enabled: true,
    language: "auto",
    theme: "auto",
    longPress: true,
    drag: true,
    modifier: false,
    modifierKey: "Shift",
    hoverSpace: false,
    longPressDelay: 500,
    multiWindow: false,
    maxWindows: 10,
    sizeMode: "px",
    widthPx: 1000,
    heightPx: 700,
    widthPercent: 72,
    heightPercent: 78,
    position: "cursor-center",
    clickOutsideClose: true,
    pinByDefault: false,
    rememberPosition: false,
    rememberSize: false,
    reducedMotion: false,
    backdrop: false,
    openLinksInNewPreview: false,
    showRing: true,
    siteFilterMode: "disabled",
    siteRules: [],
    disabledSites: [],
    forceCompatDomains: []
  };
  let settings = { ...LOCAL_DEFAULTS, ...(GP.DEFAULTS || {}) };
  let settingsReady = false;
  let rememberedRect = null;
  let ownerPort = null;
  let reconnectTimer = 0;
  let requestCounter = 0;
  let zCounter = 20;
  let host = null;
  let shadow = null;
  let layer = null;
  let backdrop = null;
  let ring = null;
  let dropzone = null;
  let live = null;
  let toastTimer = 0;
  const pending = new Map();
  const windows = new Map();
  let activeSessionId = null;
  let hoverLink = null;
  let outsideCloseGesture = null;
  let outsideSuppressUntil = 0;
  let activationReleaseGuard = null;

  function swallowOutsideEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function closeOutsideGesture(gesture) {
    if (!gesture || gesture.closed) return;
    gesture.closed = true;
    const current = windows.get(gesture.sessionId);
    if (
      current &&
      activeSessionId === gesture.sessionId &&
      current.pinned !== true &&
      settings.clickOutsideClose === true
    ) {
      closeWindow(gesture.sessionId, false);
    }
  }

  function armActivationReleaseGuard(pointerId) {
    activationReleaseGuard = {
      pointerId: Number.isInteger(pointerId) ? pointerId : null,
      released: false,
      expiresAt: Date.now() + 1_500
    };
  }

  function consumeActivationRelease(event, now) {
    const guard = activationReleaseGuard;
    if (!guard) return false;
    if (now > guard.expiresAt) {
      activationReleaseGuard = null;
      return false;
    }
    if (event.type === "pointerdown" || event.type === "mousedown") {
      // The activation gesture already began before the preview existed.
      // Any later down is a genuinely new gesture and must be allowed to
      // start an outside-close sequence normally.
      activationReleaseGuard = null;
      return false;
    }
    if (
      event.type === "pointerup" &&
      guard.pointerId !== null &&
      Number.isInteger(event.pointerId) &&
      event.pointerId !== guard.pointerId
    ) {
      return false;
    }
    if (
      event.type !== "pointerup" &&
      event.type !== "mouseup" &&
      event.type !== "click" &&
      event.type !== "contextmenu"
    ) {
      return false;
    }
    swallowOutsideEvent(event);
    if (event.type === "pointerup" || event.type === "mouseup") {
      guard.released = true;
      guard.expiresAt = Math.min(guard.expiresAt, now + 600);
    } else {
      activationReleaseGuard = null;
    }
    return true;
  }

  function consumeOutsidePreviewGesture(event) {
    if (!event.isTrusted) return;
    const now = Date.now();
    if (consumeActivationRelease(event, now)) return;
    if (outsideCloseGesture) {
      if (event.type === "pointerdown" && outsideCloseGesture.closed) {
        clearTimeout(outsideCloseGesture.closeTimer);
        clearTimeout(outsideCloseGesture.cleanupTimer);
        outsideCloseGesture = null;
        outsideSuppressUntil = 0;
        return;
      }
      swallowOutsideEvent(event);
      if (
        event.type === "pointerup" ||
        event.type === "mouseup" ||
        event.type === "click"
      ) {
        const gesture = outsideCloseGesture;
        outsideCloseGesture = null;
        clearTimeout(gesture.closeTimer);
        clearTimeout(gesture.cleanupTimer);
        outsideSuppressUntil = now + 320;
        setTimeout(() => closeOutsideGesture(gesture), 0);
      }
      return;
    }
    if (now < outsideSuppressUntil) {
      // A fresh pointer-down is a new user gesture, not click-through from the
      // just-finished close. Let it start normally and only suppress the
      // trailing mouse/click events from the previous gesture.
      if (event.type === "pointerdown") {
        outsideSuppressUntil = 0;
        return;
      }
      swallowOutsideEvent(event);
      return;
    }
    if (
      !windows.size ||
      settings.clickOutsideClose !== true ||
      !activeSessionId
    ) {
      return;
    }
    const active = windows.get(activeSessionId);
    if (!active || active.pinned) return;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    for (const item of windows.values()) {
      const rect = item.frame.getBoundingClientRect();
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      ) {
        return;
      }
    }
    swallowOutsideEvent(event);
    if (event.type === "pointerdown" || event.type === "mousedown") {
      const gesture = {
        sessionId: active.sessionId,
        closed: false,
        closeTimer: 0,
        cleanupTimer: 0
      };
      outsideCloseGesture = gesture;
      // Closing is release-driven. A long press or drag that remains held must
      // never make the preview disappear before its matching pointer-up.
      gesture.cleanupTimer = setTimeout(() => {
        if (outsideCloseGesture === gesture) {
          outsideCloseGesture = null;
          outsideSuppressUntil = Date.now() + 320;
        }
      }, 15_000);
      return;
    }
    // A release/click that did not begin with an outside press while the
    // preview existed belongs to some earlier gesture. Swallow it to prevent
    // click-through, but never let it close a newly opened preview.
    swallowOutsideEvent(event);
  }

  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "contextmenu"]) {
    window.addEventListener(type, consumeOutsidePreviewGesture, true);
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      !data ||
      data.channel !== "glasspeek-target-bootstrap-v3" ||
      data.type !== "ready"
    ) {
      return;
    }
    for (const item of windows.values()) {
      if (item.target.contentWindow !== event.source || item.targetBootstrapSent) {
        continue;
      }
      item.targetBootstrapLoaded = true;
      bindTargetBootstrap(item);
      break;
    }
  });

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const frameMinWidth = () =>
    Math.max(180, Math.min(Math.max(0, innerWidth - 8), innerWidth < 480 ? 320 : 400));
  const frameMinHeight = () =>
    Math.max(160, Math.min(Math.max(0, innerHeight - 8), innerHeight < 360 ? 260 : 300));
  const extensionOrigin = browser.runtime.getURL("").replace(/\/$/, "");
  const previewUrl = browser.runtime.getURL("preview/preview.html");
  const targetBootstrapUrl = browser.runtime.getURL("target/target-bootstrap.html");

  const CONTENT_TEXT = {
    en: {
      release: "Release to preview",
      limit: "GlassPeek window limit reached ({max})",
      secureFail: "GlassPeek could not create a secure preview",
      privateOnly: "Private network pages can only open in a browser tab",
      fullPageOpened: "Opened in the remembered full-page window"
    },
    zh_CN: {
      release: "释放以预览链接",
      limit: "已达到 GlassPeek 窗口上限（{max}）",
      secureFail: "GlassPeek 无法建立安全预览",
      privateOnly: "私有网络页面只能在浏览器标签页中打开",
      fullPageOpened: "已在记住的完整网页小窗中打开"
    },
    zh_TW: {
      release: "放開以預覽連結",
      limit: "已達到 GlassPeek 視窗上限（{max}）",
      secureFail: "GlassPeek 無法建立安全預覽",
      privateOnly: "私人網路頁面只能在瀏覽器分頁中開啟",
      fullPageOpened: "已在記住的完整網頁小視窗中開啟"
    }
  };

  function contentLanguage() {
    const selected = settings.language;
    if (selected === "en") return "en";
    if (selected === "zh_TW" || selected === "zh-TW") return "zh_TW";
    if (selected === "zh_CN" || selected === "zh-CN" || selected === "zh") return "zh_CN";
    const locale = (navigator.language || "en").toLowerCase();
    if (locale.startsWith("zh-tw") || locale.startsWith("zh-hk") || locale.startsWith("zh-hant")) return "zh_TW";
    if (locale.startsWith("zh")) return "zh_CN";
    return "en";
  }

  function ct(key, values = {}) {
    let value = (CONTENT_TEXT[contentLanguage()] || CONTENT_TEXT.en)[key] || CONTENT_TEXT.en[key] || key;
    for (const [name, replacement] of Object.entries(values)) value = value.replace(`{${name}}`, String(replacement));
    return value;
  }

  function prefersReducedMotion() {
    return settings.reducedMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function siteAllowed() {
    const hostname = location.hostname.toLowerCase();
    if (settings.siteFilterMode === "disabled") return true;
    try {
      if (GP.siteDecision) {
        const result = GP.siteDecision(
          hostname,
          settings.siteRules,
          settings.siteFilterMode !== "whitelist"
        );
        if (typeof result === "boolean") return result;
        if (result && typeof result.allowed === "boolean") return result.allowed;
        if (result && typeof result.enabled === "boolean") return result.enabled;
      }
    } catch (_error) {
      // Fall through to the conservative local implementation.
    }

    const rules = Array.isArray(settings.siteRules) ? settings.siteRules : [];
    let winner = null;
    for (const rule of rules) {
      if (!rule || typeof rule.host !== "string") continue;
      const ruleHost = rule.host.toLowerCase().replace(/^\.+|\.+$/g, "");
      if (!ruleHost) continue;
      const matches = hostname === ruleHost || (rule.includeSubdomains !== false && hostname.endsWith(`.${ruleHost}`));
      if (!matches) continue;
      if (!winner || ruleHost.length > winner.host.length || (ruleHost.length === winner.host.length && hostname === ruleHost)) {
        winner = { host: ruleHost, action: rule.action };
      }
    }
    if (winner) return winner.action !== "deny";
    if (settings.siteFilterMode === "whitelist") return false;
    if (Array.isArray(settings.disabledSites)) {
      const disabled = settings.disabledSites.some((item) => hostname === item || hostname.endsWith(`.${item}`));
      if (disabled) return false;
    }
    return true;
  }

  function canTrigger() {
    return settingsReady && settings.enabled !== false && siteAllowed();
  }

  function usesRememberedFullPage(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
      return (
        hostname &&
        Array.isArray(settings.forceCompatDomains) &&
        settings.forceCompatDomains.some(
          (value) => String(value || "").toLowerCase().replace(/\.$/, "") === hostname
        )
      );
    } catch (_error) {
      return false;
    }
  }

  const CONTENT_CSS = `
@property --gp-ring-progress { syntax: "<percentage>"; inherits: false; initial-value: 0%; }
:host { all: initial !important; color-scheme: light dark; }
*, *::before, *::after { box-sizing: border-box; }
.gp-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.gp-backdrop { position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: 0; background: rgba(10,14,24,.10); backdrop-filter: blur(4px); transition: opacity 130ms ease; }
.gp-backdrop.on { opacity: 1; }
.gp-backdrop.interactive { pointer-events: auto; touch-action: manipulation; }
.gp-surface { position: fixed; display: block; min-width: min(400px,calc(100vw - 8px)); min-height: min(300px,calc(100vh - 8px)); border: 0; border-radius: 24px; background: #fff; box-shadow: 0 30px 90px rgba(15,23,42,.28), 0 8px 28px rgba(15,23,42,.16), 0 0 0 1px rgba(255,255,255,.42); opacity: 0; transform: translateY(6px) scale(.99); pointer-events: auto; overflow: hidden; isolation: isolate; transition: opacity 130ms cubic-bezier(.2,.8,.2,1), transform 130ms cubic-bezier(.2,.8,.2,1), box-shadow 120ms ease; }
.gp-surface.ready { opacity: 1; transform: none; }
.gp-surface.active { box-shadow: 0 36px 110px rgba(15,23,42,.34), 0 10px 34px rgba(15,23,42,.20), 0 0 0 1px rgba(103,161,255,.55); }
.gp-surface.gesture-moving,.gp-surface.gesture-resizing { transition: none; }
.gp-surface.gesture-moving { contain: layout paint; will-change: transform; }
.gp-surface.closing { opacity: 0; transform: translateY(4px) scale(.995); pointer-events: none; }
.gp-control { position: absolute; inset: 0; z-index: 1; display: block; width: 100%; height: 100%; border: 0; background: transparent; }
.gp-target { position: absolute; z-index: 2; left: 0; right: 0; top: 44px; bottom: 0; display: block; width: 100%; height: calc(100% - 44px); border: 0; color-scheme: light; background: #fff; opacity: 0; visibility: hidden; pointer-events: none; }
.gp-surface.target-visible .gp-target { opacity: 1; visibility: visible; pointer-events: auto; }
.gp-surface.target-visible:not(.overlay) .gp-control { bottom: auto; height: 44px; }
.gp-surface.overlay .gp-target { opacity: 0; visibility: hidden; pointer-events: none; }
.gp-host-resize { position: absolute; z-index: 4; display: block; pointer-events: auto; touch-action: none; }
.gp-host-resize.n,.gp-host-resize.s { left: 14px; right: 14px; height: 8px; cursor: ns-resize; }
.gp-host-resize.n { top: -2px; }.gp-host-resize.s { bottom: -2px; }
.gp-host-resize.e,.gp-host-resize.w { top: 14px; bottom: 14px; width: 8px; cursor: ew-resize; }
.gp-host-resize.e { right: -2px; }.gp-host-resize.w { left: -2px; }
.gp-host-resize.ne,.gp-host-resize.nw,.gp-host-resize.se,.gp-host-resize.sw { width: 16px; height: 16px; }
.gp-host-resize.ne { top:-2px; right:-2px; cursor:nesw-resize; }.gp-host-resize.nw { top:-2px; left:-2px; cursor:nwse-resize; }
.gp-host-resize.se { bottom:-2px; right:-2px; cursor:nwse-resize; }.gp-host-resize.sw { bottom:-2px; left:-2px; cursor:nesw-resize; }
.gp-ring { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; pointer-events: none; opacity: 0; background: conic-gradient(#4f8cff var(--gp-ring-progress,0%), rgba(90,105,125,.20) 0); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0); mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0); transition: opacity 100ms ease; }
.gp-ring.on { opacity: 1; }
.gp-dropzone { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%,16px) scale(.98); display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 0 22px; border: 1px dashed rgba(79,140,255,.75); border-radius: 18px; color: #172033; background: rgba(249,251,255,.84); box-shadow: 0 18px 50px rgba(15,23,42,.18); backdrop-filter: blur(24px) saturate(170%); opacity: 0; pointer-events: none; font-size: 14px; font-weight: 650; transition: opacity 160ms ease, transform 160ms ease, background 120ms ease; }
.gp-dropzone.on { opacity: 1; transform: translate(-50%,0) scale(1); pointer-events: auto; }
.gp-dropzone.over { background: rgba(225,237,255,.96); border-style: solid; }
.gp-toast { position: fixed; left: 50%; bottom: 30px; transform: translate(-50%,12px); max-width: min(520px,calc(100vw - 32px)); padding: 11px 16px; border-radius: 999px; color: #f8fbff; background: rgba(24,32,48,.90); box-shadow: 0 16px 50px rgba(15,23,42,.24); backdrop-filter: blur(22px); opacity: 0; pointer-events: none; font: 600 13px/1.35 Inter,ui-sans-serif,system-ui,sans-serif; text-align: center; transition: opacity 160ms ease, transform 160ms ease; }
.gp-toast.on { opacity: 1; transform: translate(-50%,0); }
.gp-live { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-color-scheme: dark) { .gp-surface { background:#151820; } .gp-dropzone { color:#f5f8ff; background:rgba(27,34,48,.86); border-color:rgba(113,170,255,.78); } .gp-dropzone.over { background:rgba(35,58,88,.96); } }
@media (max-width: 640px) { .gp-surface { min-width: min(320px,calc(100vw - 8px)); min-height: min(260px,calc(100vh - 8px)); border-radius: 18px; } }
@media (prefers-reduced-motion: reduce) { .gp-surface,.gp-backdrop,.gp-dropzone,.gp-toast { transition-duration: 1ms !important; } }
@media (forced-colors: active) { .gp-surface { outline: 2px solid CanvasText; } .gp-dropzone,.gp-toast { forced-color-adjust:none; } }
`;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("glasspeek-root");
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CONTENT_CSS;
    shadow.appendChild(style);
    layer = document.createElement("div");
    layer.className = "gp-layer";
    backdrop = document.createElement("div");
    backdrop.className = "gp-backdrop";
    ring = document.createElement("div");
    ring.className = "gp-ring";
    ring.setAttribute("aria-hidden", "true");
    dropzone = document.createElement("div");
    dropzone.className = "gp-dropzone";
    dropzone.textContent = ct("release");
    dropzone.setAttribute("role", "status");
    const toast = document.createElement("div");
    toast.className = "gp-toast";
    toast.setAttribute("role", "status");
    live = document.createElement("div");
    live.className = "gp-live";
    live.setAttribute("aria-live", "polite");
    layer.append(backdrop, ring, dropzone, toast, live);
    shadow.appendChild(layer);
    (document.documentElement || document.body).appendChild(host);

    dropzone.addEventListener("dragover", (event) => {
      if (!dragState.url || settings.dragDropZone !== true) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      dropzone.classList.add("over");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
    dropzone.addEventListener("drop", (event) => {
      if (!dragState.url || settings.dragDropZone !== true) return;
      event.preventDefault();
      const url = dragState.url;
      dragState.url = null;
      dropzone.classList.remove("on", "over");
      openPreview(url, { x: event.clientX, y: event.clientY }, dragState.element);
    });
    // Backdrop events bubble through the same window-capture outside gesture
    // state machine. Do not add a second release-only close path here.
    updateBackdrop();
  }

  function notify(message, duration = 2400) {
    ensureHost();
    const toast = layer.querySelector(".gp-toast");
    toast.textContent = message;
    live.textContent = message;
    toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("on"), duration);
  }

  function updateBackdrop() {
    if (!backdrop) return;
    const active = activeSessionId && windows.get(activeSessionId);
    const hasWindows = windows.size > 0;
    backdrop.classList.toggle("on", settings.backdrop === true && hasWindows);
    backdrop.classList.toggle(
      "interactive",
      hasWindows &&
        settings.clickOutsideClose === true &&
        !!active &&
        active.pinned !== true
    );
  }

  function resolveSize() {
    const minWidth = frameMinWidth();
    const minHeight = frameMinHeight();
    let width;
    let height;
    if (settings.rememberSize && rememberedRect) {
      width = rememberedRect.width;
      height = rememberedRect.height;
    } else if (settings.sizeMode === "percent") {
      width = innerWidth * clamp(Number(settings.widthPercent) || 72, 30, 100) / 100;
      height = innerHeight * clamp(Number(settings.heightPercent) || 78, 30, 100) / 100;
    } else {
      width = Number(settings.widthPx) || 1000;
      height = Number(settings.heightPx) || 700;
    }
    return {
      width: Math.round(clamp(width, minWidth, Math.max(minWidth, innerWidth - 16))),
      height: Math.round(clamp(height, minHeight, Math.max(minHeight, innerHeight - 16)))
    };
  }

  function resolvePosition(width, height, point) {
    if (settings.rememberPosition && rememberedRect) {
      return {
        left: clamp(rememberedRect.left, -width + 60, innerWidth - 60),
        top: clamp(rememberedRect.top, 0, innerHeight - 44)
      };
    }
    const cascade = settings.multiWindow ? (windows.size % 6) * 26 : 0;
    const p = point || { x: innerWidth / 2, y: innerHeight / 2 };
    const positions = {
      center: [(innerWidth - width) / 2, (innerHeight - height) / 2],
      "cursor-top-left": [p.x - width, p.y - height],
      "cursor-top-right": [p.x, p.y - height],
      "cursor-bottom-left": [p.x - width, p.y],
      "cursor-bottom-right": [p.x, p.y],
      "cursor-center": [p.x - width / 2, p.y - height / 2]
    };
    const pair = positions[settings.position] || positions["cursor-center"];
    const edge = 8;
    const maxLeft = Math.max(edge, innerWidth - width - edge);
    const maxTop = Math.max(edge, innerHeight - height - edge);
    return {
      left: Math.round(clamp(pair[0] + cascade, edge, maxLeft)),
      top: Math.round(clamp(pair[1] + cascade, edge, maxTop))
    };
  }

  function connectOwner() {
    clearTimeout(reconnectTimer);
    try {
      ownerPort = browser.runtime.connect({ name: "gp-owner-v2" });
    } catch (_error) {
      reconnectTimer = setTimeout(connectOwner, 1000);
      return;
    }
    ownerPort.onMessage.addListener(onOwnerMessage);
    ownerPort.onDisconnect.addListener(() => {
      ownerPort = null;
      for (const item of pending.values()) item.reject(new Error("background-disconnected"));
      pending.clear();
      closeAll(false);
      try {
        reconnectTimer = setTimeout(connectOwner, 750);
      } catch (_error) {
        // The document global may already be tearing down during navigation or
        // extension replacement; reconnecting then is neither possible nor needed.
      }
    });
  }

  function onOwnerMessage(message) {
    if (!message || typeof message.type !== "string") return;
    if (
      message.type === "grant" ||
      message.type === "compat-routed" ||
      message.type === "error"
    ) {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      if (message.type === "grant" || message.type === "compat-routed") {
        item.resolve(message);
      }
      else item.reject(new Error(message.message || message.code || "preview-rejected"));
    }
  }

  function requestGrant(url) {
    if (!ownerPort) return Promise.reject(new Error("background-unavailable"));
    const requestId = `${Date.now().toString(36)}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("grant-timeout"));
      }, 5000);
      pending.set(requestId, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); }
      });
      ownerPort.postMessage({ type: "create", requestId, url });
    });
  }

  async function openPreview(rawUrl, point, triggerElement = null) {
    const url = safeHttpUrl(rawUrl);
    if (!url || !canTrigger()) return;
    const max = clamp(Number(settings.maxWindows) || 10, 1, 10);
    const replaceExisting = !settings.multiWindow && windows.size > 0;
    if (
      !usesRememberedFullPage(url) &&
      !replaceExisting &&
      windows.size >= max
    ) {
      notify(ct("limit", { max }));
      return;
    }
    // Single-window mode: close the existing preview before asking for a new
    // grant, otherwise the background rejects the request with MAX_WINDOWS.
    // Both messages travel on the same port, so ordering is preserved.
    if (replaceExisting) closeAll(false);
    let grant;
    try {
      grant = await requestGrant(url);
    } catch (error) {
      notify(error && /private/i.test(error.message || "") ? ct("privateOnly") : ct("secureFail"));
      return;
    }
    if (grant && grant.type === "compat-routed") {
      notify(ct("fullPageOpened"));
      return;
    }
    ensureHost();
    const size = resolveSize();
    const pos = resolvePosition(size.width, size.height, point);
    const frame = document.createElement("div");
    frame.className = "gp-surface overlay";
    frame.style.left = `${pos.left}px`;
    frame.style.top = `${pos.top}px`;
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    frame.style.zIndex = String(++zCounter);

    const control = document.createElement("iframe");
    control.className = "gp-control";
    control.title = "GlassPeek preview controls";
    control.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    control.setAttribute("referrerpolicy", "no-referrer");
    control.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; autoplay 'none'; fullscreen 'none'");

    const target = document.createElement("iframe");
    target.className = "gp-target";
    target.title = "Previewed website";
    target.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-pointer-lock allow-presentation allow-storage-access-by-user-activation"
    );
    target.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    target.setAttribute(
      "allow",
      "autoplay *; clipboard-write *; encrypted-media *; fullscreen *; picture-in-picture *; web-share *; camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; display-capture 'none'; clipboard-read 'none'"
    );
    target.setAttribute("allowfullscreen", "");
    target.setAttribute("loading", "eager");
    target.setAttribute("fetchpriority", "high");
    frame.append(target, control);

    const item = {
      sessionId: grant.sessionId,
      secret: grant.secret,
      targetSecret: grant.targetSecret,
      frame,
      control,
      target,
      port: null,
      pinned: settings.pinByDefault === true,
      triggerElement,
      gesture: null,
      gestureCleanupFrame: 0,
      bound: false,
      targetStarted: true,
      targetBootstrapLoaded: false,
      targetBootstrapSent: false,
      targetPresented: false,
      controlOverlayRequested: false
    };
    windows.set(item.sessionId, item);
    for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = document.createElement("span");
      handle.className = `gp-host-resize ${edge}`;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.screenX;
        const startY = event.screenY;
        let ended = false;
        handle.setPointerCapture(event.pointerId);
        beginGesture(item, { kind: "resize", edge });
        const move = (moveEvent) => {
          continueGesture(item, {
            dx: moveEvent.screenX - startX,
            dy: moveEvent.screenY - startY
          });
        };
        const end = (endEvent) => {
          if (ended) return;
          ended = true;
          if (
            endEvent &&
            endEvent.type !== "pointercancel" &&
            Number.isFinite(endEvent.screenX) &&
            Number.isFinite(endEvent.screenY)
          ) {
            continueGesture(item, {
              dx: endEvent.screenX - startX,
              dy: endEvent.screenY - startY
            });
          }
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          handle.removeEventListener("lostpointercapture", end);
          window.removeEventListener("blur", end);
          endGesture(item);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
        handle.addEventListener("lostpointercapture", end);
        window.addEventListener("blur", end, { once: true });
      });
      frame.appendChild(handle);
    }
    activate(item.sessionId);
    updateBackdrop();

    const loadTimeout = setTimeout(() => {
      if (!item.bound) closeWindow(item.sessionId, false);
    }, 10000);
    control.addEventListener("load", () => {
      if (!windows.has(item.sessionId) || item.bound) return;
      const channel = new MessageChannel();
      item.port = channel.port1;
      item.port.onmessage = (event) => onSurfaceMessage(item, event.data);
      item.port.start();
      try {
        control.contentWindow.postMessage({
          channel: CHANNEL,
          type: "bootstrap",
          sessionId: item.sessionId,
          secret: item.secret
        }, extensionOrigin, [channel.port2]);
      } catch (_error) {
        clearTimeout(loadTimeout);
        closeWindow(item.sessionId, false);
      }
    }, { once: true });
    target.addEventListener("load", () => {
      if (!windows.has(item.sessionId)) return;
      if (!item.targetBootstrapSent) return;
      if (!item.bound || !item.port) return;
      try { item.port.postMessage({ type: "target-load" }); } catch (_error) {}
    });
    item.loadTimeout = loadTimeout;
    control.src = previewUrl;
    target.src = targetBootstrapUrl;
    layer.appendChild(frame);
    requestAnimationFrame(() => {
      if (windows.has(item.sessionId)) item.frame.classList.add("ready");
    });
  }

  function bindTargetBootstrap(item) {
    if (
      !item ||
      !windows.has(item.sessionId) ||
      !item.bound ||
      !item.targetBootstrapLoaded ||
      item.targetBootstrapSent ||
      typeof item.targetSecret !== "string" ||
      item.targetSecret.length < 32
    ) {
      return;
    }
    item.targetBootstrapSent = true;
    try {
      item.target.contentWindow.postMessage({
        channel: "glasspeek-target-bootstrap-v3",
        type: "bind",
        sessionId: item.sessionId,
        secret: item.targetSecret
      }, extensionOrigin);
      item.targetSecret = null;
    } catch (_error) {
      item.targetBootstrapSent = false;
    }
  }

  function syncSurfacePresentation(item) {
    item.frame.classList.toggle("target-visible", item.targetPresented === true);
    item.frame.classList.toggle(
      "overlay",
      item.targetPresented !== true || item.controlOverlayRequested === true
    );
  }

  function onSurfaceMessage(item, message) {
    if (!windows.has(item.sessionId) || !message || typeof message.type !== "string") return;
    switch (message.type) {
      case "surface-ready":
        item.bound = true;
        item.secret = null;
        clearTimeout(item.loadTimeout);
        item.port.postMessage({ type: "host-settings", settings: publicSettings(), pinned: item.pinned });
        bindTargetBootstrap(item);
        break;
      case "presentation":
        item.targetPresented = message.state === "ready" || message.state === "progress";
        syncSurfacePresentation(item);
        break;
      case "target-overlay":
        item.controlOverlayRequested = message.value === true;
        syncSurfacePresentation(item);
        break;
      case "target-navigate": {
        const targetUrl = safeHttpUrl(message.url);
        if (targetUrl) {
          try {
            // Cross-origin Location replacement is permitted for an ancestor
            // browsing context in Firefox and avoids adding another joint
            // iframe-history entry. Keep src as a compatibility fallback.
            item.target.contentWindow.location.replace(targetUrl);
          } catch (_error) {
            item.target.src = targetUrl;
          }
        }
        break;
      }
      case "target-stop":
        item.targetPresented = false;
        syncSurfacePresentation(item);
        break;
      case "activate":
        activate(item.sessionId);
        break;
      case "close":
        closeWindow(item.sessionId, true);
        break;
      case "close-all":
        closeAll(true);
        break;
      case "pin":
        item.pinned = message.value === true;
        updateBackdrop();
        break;
      case "toggle-pin":
        item.pinned = !item.pinned;
        item.port.postMessage({ type: "pin-state", pinned: item.pinned });
        updateBackdrop();
        break;
      case "gesture-start":
        beginGesture(item, message);
        break;
      case "gesture-move":
        continueGesture(item, message);
        break;
      case "gesture-end":
        endGesture(item);
        break;
      case "adjust":
        adjustFrame(item, message);
        break;
      case "new-preview":
        openPreview(message.url, frameCenter(item.frame), item.triggerElement);
        break;
      case "notify":
        notify(String(message.message || ""));
        break;
      default:
        break;
    }
  }

  function publicSettings() {
    return {
      language: settings.language,
      theme: settings.theme,
      reducedMotion: prefersReducedMotion(),
      openLinksInNewPreview: settings.openLinksInNewPreview === true
    };
  }

  function frameCenter(frame) {
    return { x: frame.offsetLeft + frame.offsetWidth / 2, y: frame.offsetTop + frame.offsetHeight / 2 };
  }

  function activate(sessionId) {
    const item = windows.get(sessionId);
    if (!item) return;
    activeSessionId = sessionId;
    for (const entry of windows.values()) entry.frame.classList.toggle("active", entry === item);
    item.frame.style.zIndex = String(++zCounter);
    if (ownerPort) {
      try { ownerPort.postMessage({ type: "activate", sessionId }); } catch (_error) {}
    }
    updateBackdrop();
  }

  function beginGesture(item, message) {
    if (item.gesture) endGesture(item);
    if (item.gestureCleanupFrame) {
      cancelAnimationFrame(item.gestureCleanupFrame);
      item.gestureCleanupFrame = 0;
      item.frame.style.removeProperty("transform");
      item.frame.classList.remove("gesture-moving", "gesture-resizing");
    }
    const geometry = {
      left: item.frame.offsetLeft,
      top: item.frame.offsetTop,
      width: item.frame.offsetWidth,
      height: item.frame.offsetHeight
    };
    activate(item.sessionId);
    item.gesture = {
      kind: message.kind,
      edge: message.edge || "",
      ...geometry,
      dx: 0,
      dy: 0,
      targetLeft: geometry.left,
      targetTop: geometry.top,
      targetWidth: geometry.width,
      targetHeight: geometry.height,
      renderFrame: 0
    };
    item.frame.classList.add(
      item.gesture.kind === "move" ? "gesture-moving" : "gesture-resizing"
    );
  }

  function continueGesture(item, message) {
    const gesture = item.gesture;
    if (!gesture) return;
    gesture.dx = Number(message.dx) || 0;
    gesture.dy = Number(message.dy) || 0;
    if (gesture.renderFrame) return;
    gesture.renderFrame = requestAnimationFrame(() => {
      gesture.renderFrame = 0;
      if (item.gesture === gesture) applyGestureFrame(item, gesture);
    });
  }

  function applyGestureFrame(item, gesture) {
    const dx = gesture.dx;
    const dy = gesture.dy;
    if (gesture.kind === "move") {
      gesture.targetLeft = clamp(
        gesture.left + dx,
        -gesture.width + 60,
        innerWidth - 60
      );
      gesture.targetTop = clamp(
        gesture.top + dy,
        0,
        innerHeight - 44
      );
      const translateX = gesture.targetLeft - gesture.left;
      const translateY = gesture.targetTop - gesture.top;
      item.frame.style.transform =
        `translate3d(${translateX}px, ${translateY}px, 0)`;
      return;
    }
    resizeFromGesture(item, gesture, dx, dy);
  }

  function flushGestureFrame(item, gesture) {
    if (gesture.renderFrame) {
      cancelAnimationFrame(gesture.renderFrame);
      gesture.renderFrame = 0;
    }
    applyGestureFrame(item, gesture);
  }

  function resizeFromGesture(item, start, dx, dy) {
    const edge = start.edge;
    const minWidth = frameMinWidth();
    const minHeight = frameMinHeight();
    let left = start.left;
    let top = start.top;
    let width = start.width;
    let height = start.height;
    if (edge.includes("e")) width = start.width + dx;
    if (edge.includes("s")) height = start.height + dy;
    if (edge.includes("w")) { width = start.width - dx; left = start.left + dx; }
    if (edge.includes("n")) { height = start.height - dy; top = start.top + dy; }
    if (width < minWidth) { if (edge.includes("w")) left -= minWidth - width; width = minWidth; }
    if (height < minHeight) { if (edge.includes("n")) top -= minHeight - height; height = minHeight; }
    width = Math.min(width, Math.max(minWidth, innerWidth + start.width - 60));
    height = Math.min(height, Math.max(minHeight, innerHeight + start.height - 44));
    start.targetLeft = clamp(left, -width + 60, innerWidth - 60);
    start.targetTop = clamp(top, 0, innerHeight - 44);
    start.targetWidth = width;
    start.targetHeight = height;
    item.frame.style.left = `${start.targetLeft}px`;
    item.frame.style.top = `${start.targetTop}px`;
    item.frame.style.width = `${start.targetWidth}px`;
    item.frame.style.height = `${start.targetHeight}px`;
  }

  function adjustFrame(item, message) {
    activate(item.sessionId);
    const width = clamp(item.frame.offsetWidth + (Number(message.dw) || 0), frameMinWidth(), Math.max(frameMinWidth(), innerWidth - 8));
    const height = clamp(item.frame.offsetHeight + (Number(message.dh) || 0), frameMinHeight(), Math.max(frameMinHeight(), innerHeight - 8));
    item.frame.style.width = `${width}px`;
    item.frame.style.height = `${height}px`;
    item.frame.style.left = `${clamp(item.frame.offsetLeft + (Number(message.dx) || 0), -width + 60, innerWidth - 60)}px`;
    item.frame.style.top = `${clamp(item.frame.offsetTop + (Number(message.dy) || 0), 0, innerHeight - 44)}px`;
    persistRect(item);
  }

  function endGesture(item) {
    const gesture = item.gesture;
    if (!gesture) return;
    flushGestureFrame(item, gesture);
    if (gesture.kind === "move") {
      item.frame.style.left = `${gesture.targetLeft}px`;
      item.frame.style.top = `${gesture.targetTop}px`;
      item.frame.style.transform = "translate3d(0, 0, 0)";
    }
    item.gesture = null;
    persistRect(item);
    item.gestureCleanupFrame = requestAnimationFrame(() => {
      if (item.gesture) {
        item.gestureCleanupFrame = 0;
        return;
      }
      item.frame.style.removeProperty("transform");
      item.gestureCleanupFrame = requestAnimationFrame(() => {
        item.gestureCleanupFrame = 0;
        if (item.gesture) return;
        item.frame.classList.remove("gesture-moving", "gesture-resizing");
      });
    });
  }

  function persistRect(item) {
    if (!settings.rememberPosition && !settings.rememberSize) return;
    rememberedRect = {
      left: item.frame.offsetLeft,
      top: item.frame.offsetTop,
      width: item.frame.offsetWidth,
      height: item.frame.offsetHeight
    };
    browser.storage.local.set({ gpRectV2: rememberedRect }).catch(() => {});
  }

  function closeWindow(sessionId, restoreFocus) {
    const item = windows.get(sessionId);
    if (!item) return;
    if (item.gesture?.renderFrame) {
      cancelAnimationFrame(item.gesture.renderFrame);
    }
    if (item.gestureCleanupFrame) {
      cancelAnimationFrame(item.gestureCleanupFrame);
    }
    item.gesture = null;
    item.gestureCleanupFrame = 0;
    windows.delete(sessionId);
    if (ownerPort) {
      try { ownerPort.postMessage({ type: "close", sessionId }); } catch (_error) {}
    }
    if (item.port) {
      try { item.port.close(); } catch (_error) {}
    }
    clearTimeout(item.loadTimeout);
    item.target.remove();
    item.frame.classList.add("closing");
    const delay = prefersReducedMotion() ? 0 : 130;
    setTimeout(() => item.frame.remove(), delay);
    if (activeSessionId === sessionId) {
      const remaining = Array.from(windows.values());
      activeSessionId = remaining.length ? remaining[remaining.length - 1].sessionId : null;
      if (activeSessionId) activate(activeSessionId);
    }
    updateBackdrop();
    if (restoreFocus && item.triggerElement && typeof item.triggerElement.focus === "function") {
      try { item.triggerElement.focus({ preventScroll: true }); } catch (_error) {}
    }
  }

  function closeAll(restoreFocus) {
    const ids = Array.from(windows.keys());
    for (const id of ids) closeWindow(id, restoreFocus && id === activeSessionId);
  }

  function findLink(eventOrNode) {
    const path = eventOrNode && typeof eventOrNode.composedPath === "function"
      ? eventOrNode.composedPath()
      : [eventOrNode && eventOrNode.target ? eventOrNode.target : eventOrNode];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      const anchor = node.matches("a[href]") ? node : node.closest && node.closest("a[href]");
      if (!anchor) continue;
      const url = safeHttpUrl(anchor.href);
      if (url && url !== location.href) return { anchor, url };
    }
    return null;
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("input,textarea,select,button,[contenteditable=''],[contenteditable='true'],[role='textbox']"));
  }

  const longPressState = { active: false, timer: 0, ringTimer: 0, start: null, found: null, pointerId: null };
  let suppressed = null;

  function cancelLongPress() {
    if (!longPressState.active) return;
    longPressState.active = false;
    clearTimeout(longPressState.timer);
    clearTimeout(longPressState.ringTimer);
    if (ring) {
      ring.classList.remove("on");
      ring.style.setProperty("--gp-ring-progress", "0%");
      ring.style.transition = "none";
    }
  }

  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted || !canTrigger() || event.button !== 0) return;
    const found = findLink(event);
    if (!found) return;
    if (settings.longPress && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      const delay = clamp(Number(settings.longPressDelay) || 500, 300, 1000);
      longPressState.active = true;
      longPressState.start = { x: event.clientX, y: event.clientY };
      longPressState.found = found;
      longPressState.pointerId = event.pointerId;
      clearTimeout(longPressState.ringTimer);
      longPressState.ringTimer = setTimeout(() => {
        if (!longPressState.active || settings.showRing === false) return;
        ensureHost();
        ring.style.left = `${event.clientX}px`;
        ring.style.top = `${event.clientY}px`;
        ring.style.transition = `--gp-ring-progress ${Math.max(1, delay - 120)}ms linear`;
        ring.classList.add("on");
        requestAnimationFrame(() => ring.style.setProperty("--gp-ring-progress", "100%"));
      }, 120);
      longPressState.timer = setTimeout(() => {
        if (!longPressState.active) return;
        const current = longPressState.found;
        const point = longPressState.start;
        const pointerId = longPressState.pointerId;
        suppressed = { anchor: current.anchor, pointerId, expires: Date.now() + 1200 };
        armActivationReleaseGuard(pointerId);
        try {
          if (
            Number.isInteger(pointerId) &&
            current.anchor &&
            typeof current.anchor.setPointerCapture === "function"
          ) {
            current.anchor.setPointerCapture(pointerId);
          }
        } catch (_error) {
          // The release guard remains the deterministic fallback when pointer
          // capture is unavailable or the page changed the source element.
        }
        cancelLongPress();
        try { getSelection().removeAllRanges(); } catch (_error) {}
        openPreview(current.url, point, current.anchor);
      }, delay);
    }
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!event.isTrusted || !longPressState.active) return;
    const start = longPressState.start;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) cancelLongPress();
  }, true);
  const cancelTrustedLongPress = (event) => {
    if (event.isTrusted) cancelLongPress();
  };
  document.addEventListener("pointerup", cancelTrustedLongPress, true);
  document.addEventListener("pointercancel", cancelTrustedLongPress, true);
  document.addEventListener("contextmenu", cancelTrustedLongPress, true);
  window.addEventListener("blur", cancelLongPress);

  function modifierMatches(event) {
    const key = String(settings.modifierKey || "Shift").toLowerCase();
    return (key === "shift" && event.shiftKey) || (key === "alt" && event.altKey) ||
      (key === "ctrl" && event.ctrlKey) || (key === "control" && event.ctrlKey) ||
      ((key === "meta" || key === "cmd" || key === "command") && event.metaKey);
  }

  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    if (suppressed && Date.now() <= suppressed.expires) {
      const found = findLink(event);
      if (found && found.anchor === suppressed.anchor) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressed = null;
        return;
      }
    } else {
      suppressed = null;
    }
    if (!canTrigger() || settings.modifier !== true || !modifierMatches(event)) return;
    const found = findLink(event);
    if (!found) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openPreview(found.url, { x: event.clientX, y: event.clientY }, found.anchor);
  }, true);

  document.addEventListener("pointerover", (event) => {
    if (!event.isTrusted) return;
    const found = findLink(event);
    hoverLink = found;
  }, true);
  document.addEventListener("pointerout", (event) => {
    if (!event.isTrusted) return;
    if (!hoverLink) return;
    const next = event.relatedTarget;
    if (!next || !hoverLink.anchor.contains(next)) hoverLink = null;
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    if (event.key === "Escape" && windows.size) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) closeAll(true);
      else if (activeSessionId) closeWindow(activeSessionId, true);
      return;
    }
    if (event.code !== "Space" || event.repeat || !canTrigger() || settings.hoverSpace !== true || !hoverLink || isEditableTarget(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = hoverLink.anchor.getBoundingClientRect();
    openPreview(hoverLink.url, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, hoverLink.anchor);
  }, true);

  const dragState = { url: null, element: null, lastPoint: null };
  document.addEventListener("dragstart", (event) => {
    if (!event.isTrusted) return;
    cancelLongPress();
    if (!canTrigger() || settings.drag !== true) return;
    const found = findLink(event);
    if (!found) return;
    dragState.url = found.url;
    dragState.element = found.anchor;
    dragState.lastPoint = { x: event.clientX, y: event.clientY };
    if (settings.dragDropZone === true) {
      ensureHost();
      setTimeout(() => {
        if (dragState.url && settings.dragDropZone === true) {
          dropzone.classList.add("on");
        }
      }, 80);
    }
  }, true);
  document.addEventListener("dragover", (event) => {
    if (
      !event.isTrusted ||
      !dragState.url ||
      settings.dragDropZone === true
    ) return;
    event.preventDefault();
    dragState.lastPoint = { x: event.clientX, y: event.clientY };
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, true);
  document.addEventListener("drop", (event) => {
    if (
      !event.isTrusted ||
      !dragState.url ||
      settings.dragDropZone === true
    ) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const url = dragState.url;
    const element = dragState.element;
    dragState.url = null;
    dragState.element = null;
    dragState.lastPoint = null;
    openPreview(url, { x: event.clientX, y: event.clientY }, element);
  }, true);
  document.addEventListener("dragend", (event) => {
    if (!event.isTrusted) return;
    // dropEffect is "none" when the drag was cancelled (Esc) or dropped
    // somewhere that did not accept it, e.g. the Firefox tab strip, which
    // already opened the link natively.
    const dropped = !event.dataTransfer || event.dataTransfer.dropEffect !== "none";
    const openAnywhere =
      dropped && dragState.url && settings.dragDropZone !== true
        ? {
            url: dragState.url,
            element: dragState.element,
            point:
              dragState.lastPoint ||
              { x: event.clientX || innerWidth / 2, y: event.clientY || innerHeight / 2 }
          }
        : null;
    dragState.url = null;
    dragState.element = null;
    dragState.lastPoint = null;
    if (dropzone) dropzone.classList.remove("on", "over");
    if (openAnywhere) {
      openPreview(openAnywhere.url, openAnywhere.point, openAnywhere.element);
    }
  }, true);

  window.addEventListener("resize", () => {
    for (const item of windows.values()) {
      const width = Math.min(item.frame.offsetWidth, Math.max(frameMinWidth(), innerWidth - 8));
      const height = Math.min(item.frame.offsetHeight, Math.max(frameMinHeight(), innerHeight - 8));
      item.frame.style.width = `${width}px`;
      item.frame.style.height = `${height}px`;
      item.frame.style.left = `${clamp(item.frame.offsetLeft, 0, Math.max(0, innerWidth - width))}px`;
      item.frame.style.top = `${clamp(item.frame.offsetTop, 0, Math.max(0, innerHeight - height))}px`;
    }
  });

  function applySettings(next) {
    settings = { ...LOCAL_DEFAULTS, ...(GP.DEFAULTS || {}), ...next };
    settingsReady = true;
    if (dropzone) dropzone.textContent = ct("release");
    if (!canTrigger()) closeAll(false);
    for (const item of windows.values()) {
      if (item.port) item.port.postMessage({ type: "host-settings", settings: publicSettings(), pinned: item.pinned });
    }
    updateBackdrop();
  }

  browser.storage.sync.get({ ...LOCAL_DEFAULTS, ...(GP.DEFAULTS || {}) }).then(applySettings).catch(() => applySettings({}));
  browser.storage.local.get({ gpRectV2: null }).then((value) => { rememberedRect = value.gpRectV2; }).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const patch = {};
    for (const [key, value] of Object.entries(changes)) patch[key] = value.newValue;
    applySettings({ ...settings, ...patch });
  });

  connectOwner();
})();
