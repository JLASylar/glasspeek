(function () {
  "use strict";

  const GP = globalThis.GlassPeek || {};
  const REMOTE_CHANNEL = "glasspeek-remote-v2";
  const SURFACE_CHANNEL = "glasspeek-surface-v2";
  const FALLBACK_DEFAULTS = Object.freeze({
    language: "auto",
    theme: "auto",
    reducedMotion: false,
  });
  const DEFAULTS = Object.freeze({ ...FALLBACK_DEFAULTS, ...(GP.DEFAULTS || {}) });
  const state = {
    settings: { ...DEFAULTS },
    messages: null,
    windowId: null,
    sourceTabId: null,
    currentUrl: null,
    frame: null,
    loadTimer: 0,
    noticeTimer: 0,
    loadToken: 0,
    surfaceNonce: null,
    surfaceDocumentId: null,
    surfaceGeneration: null,
    historyEntries: [],
    historyIndex: -1,
  };
  const byId = (id) => document.getElementById(id);

  async function loadMessages(language) {
    if (!language || language === "auto") {
      state.messages = null;
      return;
    }
    try {
      const response = await fetch(browser.runtime.getURL(`_locales/${language}/messages.json`), { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      state.messages = await response.json();
    } catch {
      state.messages = null;
    }
  }

  function t(key) {
    return (state.messages && state.messages[key] && state.messages[key].message)
      || browser.i18n.getMessage(key)
      || "";
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const value = t(element.dataset.i18n);
      if (value) element.textContent = value;
    });
    document.querySelectorAll("[data-i18n-title]").forEach((element) => {
      const value = t(element.dataset.i18nTitle);
      if (value) element.title = value;
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      const value = t(element.dataset.i18nAriaLabel);
      if (value) element.setAttribute("aria-label", value);
    });
    const title = t("sidebar_title");
    if (title) document.title = title;
  }

  function applyAppearance() {
    const dark = state.settings.theme === "dark"
      || (state.settings.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.reducedMotion = String(Boolean(state.settings.reducedMotion));
  }

  function normalizeUrl(raw) {
    if (typeof GP.normalizeUrl === "function") return GP.normalizeUrl(raw);
    if (typeof raw !== "string" || raw.length > 32768) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function randomNonce() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0")
    ).join("");
  }

  function setIdentity(url) {
    if (!url) {
      byId("pageHost").textContent = "GlassPeek";
      byId("pageUrl").textContent = "";
      byId("pageUrl").removeAttribute("title");
      return;
    }
    try {
      const parsed = new URL(url);
      byId("pageHost").textContent = parsed.hostname;
      byId("pageUrl").textContent = parsed.href;
      byId("pageUrl").title = parsed.href;
    } catch {
      setIdentity(null);
    }
  }

  function showOnly(id) {
    ["emptyState", "loadingState", "errorState", "frameShell"].forEach((candidate) => {
      byId(candidate).hidden = candidate !== id;
    });
  }

  function cleanupFrame() {
    state.loadToken += 1;
    clearTimeout(state.loadTimer);
    clearTimeout(state.noticeTimer);
    state.loadTimer = 0;
    state.noticeTimer = 0;
    state.surfaceDocumentId = null;
    state.surfaceGeneration = null;
    if (state.frame) {
      try { state.frame.src = "about:blank"; } catch { /* ignore */ }
      state.frame.remove();
      state.frame = null;
    }
    byId("frameNotice").hidden = true;
  }

  function showEmpty() {
    cleanupFrame();
    state.currentUrl = null;
    state.historyEntries = [];
    state.historyIndex = -1;
    setIdentity(null);
    showOnly("emptyState");
  }

  function showLoading(url) {
    setIdentity(url);
    byId("loadingUrl").textContent = url;
    byId("loadingUrl").title = url;
    showOnly("loadingState");
  }

  function showError(code, message) {
    cleanupFrame();
    const titleKeys = {
      timeout: "sidebar_timeout_title",
      blocked: "sidebar_blocked_title",
      network: "sidebar_network_title",
    };
    byId("errorTitle").textContent = t(titleKeys[code] || "sidebar_error_title") || "无法在侧栏显示";
    byId("errorMessage").textContent = message || t("sidebar_error_desc") || "网站可能不允许被嵌入。";
    byId("errorUrl").textContent = state.currentUrl || "";
    byId("errorUrl").title = state.currentUrl || "";
    byId("openCompat").hidden = false;
    showOnly("errorState");
  }

  function createFrame(url, token) {
    const frame = document.createElement("iframe");
    frame.name = "glasspeek-sidebar-frame";
    frame.title = t("sidebar_frame_title") || "GlassPeek page preview";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; autoplay 'none'; fullscreen 'none'");
    frame.addEventListener("load", () => {
      if (token !== state.loadToken || frame !== state.frame) return;
      // Start the frame agent after every real/redirected document load. The
      // extension-origin sender check in content.js and this per-load nonce
      // correlate messages to the current load; all resulting navigation is
      // still revalidated by the privileged background.
      try {
        frame.contentWindow.postMessage({
          channel: SURFACE_CHANNEL,
          type: "config",
          role: "direct",
          surfaceNonce: state.surfaceNonce,
          sourceUrl: state.currentUrl,
          // A DOM surface message is not a privileged capability. Keep
          // separate-target links in this sidebar and revalidate their URL.
          openLinksInNewPreview: false,
        }, "*");
      } catch {
        // The correlated readiness timeout below remains fail closed.
      }
      clearTimeout(state.loadTimer);
      state.loadTimer = setTimeout(() => {
        if (token === state.loadToken) showError("blocked", t("sidebar_blocked_desc"));
      }, 6000);
    });
    frame.addEventListener("error", () => {
      if (token === state.loadToken) showError("network", t("sidebar_network_desc"));
    });
    frame.src = url;
    return frame;
  }

  function recordSidebarHistory(url, mode = "append") {
    if (mode === "history") return;
    if (mode === "replace" && state.historyIndex >= 0) {
      state.historyEntries[state.historyIndex] = url;
      return;
    }
    if (state.historyEntries[state.historyIndex] === url) return;
    state.historyEntries.splice(state.historyIndex + 1);
    state.historyEntries.push(url);
    if (state.historyEntries.length > 100) state.historyEntries.shift();
    state.historyIndex = state.historyEntries.length - 1;
  }

  function openUrl(rawUrl, historyMode = "append") {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      showError("invalid", t("sidebar_invalid_url"));
      return;
    }
    cleanupFrame();
    recordSidebarHistory(url, historyMode);
    state.currentUrl = url;
    state.loadToken += 1;
    state.surfaceNonce = randomNonce();
    const token = state.loadToken;
    showLoading(url);
    state.loadTimer = setTimeout(() => {
      if (token === state.loadToken) showError("timeout", t("sidebar_timeout_desc"));
    }, 20000);
    browser.runtime.sendMessage({
      type: "gp-sidebar-arm",
      url,
      armId: state.surfaceNonce,
    }).then((response) => {
      if (token !== state.loadToken || state.currentUrl !== url) return;
      if (!response || response.ok === false) {
        throw new Error(
          response?.message || response?.code || "sidebar-arm-failed"
        );
      }
      state.surfaceDocumentId =
        typeof response.documentId === "string"
          ? response.documentId
          : state.surfaceDocumentId;
      state.surfaceGeneration =
        typeof response.generation === "string"
          ? response.generation
          : null;
      if (
        !state.surfaceDocumentId ||
        !state.surfaceGeneration ||
        response.armId !== state.surfaceNonce
      ) {
        throw new Error("sidebar-arm-context-missing");
      }
      state.frame = createFrame(response.url || url, token);
      byId("frameShell").appendChild(state.frame);
    }).catch((error) => {
      if (token !== state.loadToken) return;
      console.error("Sidebar target rejected:", error);
      showError("blocked", t("sidebar_blocked_desc"));
    });
  }

  async function getWindowId() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab && Number.isInteger(tab.windowId)) return tab.windowId;
    } catch { /* continue */ }
    try {
      const win = await browser.windows.getCurrent();
      return Number.isInteger(win && win.id) ? win.id : null;
    } catch {
      return null;
    }
  }

  async function refreshSidebarState() {
    state.windowId = await getWindowId();
    try {
      const response = await browser.runtime.sendMessage({ type: "gp-sidebar-get", windowId: state.windowId });
      const url = response && response.ok && response.state && response.state.url;
      if (url) {
        state.sourceTabId = Number.isInteger(response.state.tabId) ? response.state.tabId : null;
        if (normalizeUrl(url) !== state.currentUrl) openUrl(url);
      } else {
        state.sourceTabId = null;
        showEmpty();
      }
    } catch (error) {
      console.warn("Sidebar state unavailable:", error);
      showEmpty();
    }
  }

  async function openCurrentInTab() {
    if (!state.currentUrl) return;
    try {
      await browser.tabs.create({ url: state.currentUrl, active: true });
    } catch (error) {
      console.error("Open tab failed:", error);
    }
  }

  async function openCompat() {
    if (!state.currentUrl) return;
    const options = { type: "gp-open-compat", url: state.currentUrl, windowId: state.windowId, source: "sidebar" };
    try {
      const response = await browser.runtime.sendMessage(options);
      if (response && response.ok === false) throw new Error(response.message || response.code || "compat-failed");
    } catch (error) {
      console.error("Compat window failed:", error);
      await openCurrentInTab();
    }
  }

  async function requestSidebarNavigation(rawUrl, historyMode = "append") {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    try {
      const response = await browser.runtime.sendMessage({
        type: "gp-sidebar-open",
        windowId: state.windowId,
        tabId: state.sourceTabId,
        url,
        updateOnly: true,
      });
      if (!response || response.ok === false) {
        throw new Error(response?.message || response?.code || "sidebar-navigation-failed");
      }
      openUrl(response.url || url, historyMode);
    } catch (error) {
      console.error("Sidebar navigation rejected:", error);
      showError("blocked", t("sidebar_blocked_desc"));
    }
  }

  function persistSidebarUrl(url) {
    browser.runtime.sendMessage({
      type: "gp-sidebar-open",
      windowId: state.windowId,
      tabId: state.sourceTabId,
      url,
      updateOnly: true,
    }).catch(() => {});
  }

  function traverseSidebarHistory(delta) {
    const index = state.historyIndex + delta;
    const url = state.historyEntries[index];
    if (!url) return;
    state.historyIndex = index;
    void requestSidebarNavigation(url, "history");
  }

  function showFrameNotice(message) {
    const text = byId("frameNotice").querySelector("span");
    if (text && message) text.textContent = message;
    byId("frameNotice").hidden = false;
  }

  function bindEvents() {
    byId("reload").addEventListener("click", () => state.currentUrl && openUrl(state.currentUrl));
    byId("retry").addEventListener("click", () => state.currentUrl && openUrl(state.currentUrl));
    byId("openTab").addEventListener("click", openCurrentInTab);
    byId("errorOpenTab").addEventListener("click", openCurrentInTab);
    byId("openCompat").addEventListener("click", openCompat);
    byId("noticeCompat").addEventListener("click", openCompat);
    ["openSettings", "emptySettings"].forEach((id) => {
      byId(id).addEventListener("click", () => browser.runtime.openOptionsPage());
    });

    browser.runtime.onMessage.addListener((message) => {
      if (!message || typeof message.type !== "string") return;
      if ((message.type === "gp-sidebar-open" || message.type === "gp-sidebar-update")
        && (!Number.isInteger(message.windowId) || message.windowId === state.windowId)
        && message.url) {
        if (Number.isInteger(message.tabId)) state.sourceTabId = message.tabId;
        openUrl(message.url);
      } else if (message.type === "gp-sidebar-state"
        && message.windowId === state.windowId) {
        if (message.state && message.state.url) {
          state.sourceTabId = Number.isInteger(message.state.tabId) ? message.state.tabId : null;
          const next = normalizeUrl(message.state.url);
          if (next && next !== state.currentUrl) openUrl(next);
        } else {
          state.sourceTabId = null;
          showEmpty();
        }
      } else if (message.type === "gp-sidebar-blocked") {
        if (
          typeof message.documentId !== "string" ||
          message.documentId !== state.surfaceDocumentId ||
          typeof message.generation !== "string" ||
          message.generation !== state.surfaceGeneration
        ) return;
        const blockedUrl = normalizeUrl(message.url);
        if (!blockedUrl || !state.currentUrl) return;
        showError("blocked", t("sidebar_blocked_desc"));
      }
    });

    window.addEventListener("message", (event) => {
      if (!state.frame || event.source !== state.frame.contentWindow || !event.data || typeof event.data.type !== "string") return;
      if (
        event.data.channel !== REMOTE_CHANNEL ||
        event.data.surfaceNonce !== state.surfaceNonce
      ) return;
      const senderUrl = normalizeUrl(event.data.url);
      if (!senderUrl || event.origin !== new URL(senderUrl).origin) return;
      if (event.data.type === "alive") {
        const announcedUrl = normalizeUrl(event.data.url);
        if (!announcedUrl || !state.currentUrl) return;
        const currentOrigin = new URL(state.currentUrl).origin;
        if (new URL(announcedUrl).origin !== currentOrigin) {
          // Keep the frame hidden until the parent validates and recreates a
          // cross-origin navigation with a matching identity.
          void requestSidebarNavigation(announcedUrl);
          return;
        }
        clearTimeout(state.loadTimer);
        byId("frameNotice").hidden = true;
        showOnly("frameShell");
        const changed = announcedUrl !== state.currentUrl;
        if (changed) {
          recordSidebarHistory(announcedUrl, "append");
          state.currentUrl = announcedUrl;
          persistSidebarUrl(announcedUrl);
        }
        setIdentity(announcedUrl);
      } else if (event.data.type === "navigate-root") {
        const next = normalizeUrl(event.data.targetUrl);
        if (!next) return;
        void requestSidebarNavigation(next);
      } else if (event.data.type === "new-preview") {
        const next = normalizeUrl(event.data.targetUrl);
        if (next) void requestSidebarNavigation(next);
      } else if (event.data.type === "open-external") {
        showFrameNotice(
          t("sidebar_external_notice") ||
          "此操作需要完整网页小窗；当前侧栏不会静默下载或打开新标签页。"
        );
      } else if (event.data.type === "history-shortcut") {
        if (event.data.direction === "back") traverseSidebarHistory(-1);
        else if (event.data.direction === "forward") traverseSidebarHistory(1);
      } else if (event.data.type === "history-state") {
        const next = normalizeUrl(event.data.url);
        if (!next || !state.currentUrl) return;
        if (new URL(next).origin !== new URL(state.currentUrl).origin) {
          void requestSidebarNavigation(next);
          return;
        }
        recordSidebarHistory(
          next,
          event.data.action === "replaceState" ? "replace" : "append"
        );
        state.currentUrl = next;
        setIdentity(next);
        persistSidebarUrl(next);
      } else if (event.data.type === "unsupported-link") {
        showFrameNotice(
          t("preview_unsupported_link") ||
          "此链接类型需要使用完整网页小窗。"
        );
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshSidebarState();
    });
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "sync") return;
      let languageChanged = false;
      for (const [key, change] of Object.entries(changes)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
        state.settings[key] = change.newValue === undefined ? DEFAULTS[key] : change.newValue;
        languageChanged ||= key === "language";
      }
      if (languageChanged) {
        await loadMessages(state.settings.language);
        applyTranslations();
      }
      applyAppearance();
    });
  }

  async function init() {
    const stored = await browser.storage.sync.get(null);
    state.settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) state.settings[key] = stored[key];
    }
    await loadMessages(state.settings.language);
    applyAppearance();
    applyTranslations();
    bindEvents();
    await refreshSidebarState();
  }

  init().catch((error) => {
    console.error("GlassPeek sidebar init failed:", error);
    showError("init", browser.i18n.getMessage("sidebar_init_failed") || "侧栏初始化失败");
  });
})();
