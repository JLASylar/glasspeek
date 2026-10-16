(() => {
  "use strict";

  const CHANNEL = "glasspeek-v2";
  const PREVIEW_URL = browser.runtime.getURL("preview/preview.html");

  const $ = (id) => document.getElementById(id);
  const surface = $("surface");
  const loading = $("loading");
  const error = $("error");
  const menu = $("menu");
  const dragHandle = $("dragHandle");
  const live = $("live");

  let sessionId = null;
  let secret = null;
  let hostPort = null;
  let backgroundPort = null;
  let bound = false;
  let directTarget = false;
  let currentUrl = null;
  let currentTitle = "GlassPeek";
  let currentStatus = "idle";
  let navigationGeneration = 0;
  let loadingUrl = null;
  let pendingTargetFallback = null;
  let historyState = {
    canGoBack: false,
    canGoForward: false,
    index: 0,
    length: 1
  };
  let settings = {
    language: "auto",
    theme: "auto",
    reducedMotion: false,
    openLinksInNewPreview: false
  };
  let pinned = false;
  let targetAlive = false;
  let iframeLoadSeen = false;
  let aliveTimer = 0;
  let hardTimer = 0;
  let revealTimer = 0;
  let compatRequired = false;
  let compatOpening = false;
  let errorCode = "embed-blocked";
  let requestCounter = 0;
  const requests = new Map();
  let menuReturnFocus = null;

  const TEXT = {
    en: {
      securePreview: "Link preview",
      opening: "Opening…",
      security: "Only this preview's own embedding restriction is relaxed. Other site policies stay in force.",
      blockedTitle: "This site refuses to be embedded",
      blockedDetail: "Retry, or open it in a full-page window.",
      timeoutTitle: "The preview did not respond",
      timeoutDetail: "The site may be slow, offline, or blocking embedded viewing.",
      networkTitle: "The page could not be loaded",
      networkDetail: "Retry, or open it in a full-page window.",
      retry: "Retry", compat: "Full-page window", fullPageRemember: "Switch and remember {host}", fullPageOnce: "Open just this time", fullPageToolbar: "Open in a full-page window and remember this site", openingCompat: "Opening full page…", newTab: "New tab",
      close: "Close preview", pin: "Pin preview", unpin: "Unpin preview",
      backNav: "Back", forwardNav: "Forward", stop: "Stop", stopped: "Loading stopped", stoppedDetail: "Reload to continue from this address.",
      compatTitle: "This page needs a full-page window", compatDetail: "Open it once, or remember this exact site so future previews reuse one Firefox full-page window.",
      reload: "Reload", openTab: "Open in new tab", more: "More actions", copied: "Final URL copied", copyFailed: "Could not copy the URL",
      copy: "Copy final URL", sidebar: "Open in sidebar", closeAll: "Close all previews", compatOpened: "Opened in a Firefox window",
      externalOpened: "Opened in a Firefox tab", externalFailed: "Firefox could not open that target", rememberFailed: "The page opened, but Firefox could not remember this site", unsupportedLink: "This link type requires the full-page window", ready: "Preview ready"
    },
    zh_CN: {
      securePreview: "链接预览", opening: "正在打开…", security: "只放宽这个预览自身的嵌入限制，网站的其他安全策略不变。",
      blockedTitle: "网站禁止被嵌入", blockedDetail: "可以重试，或改用完整网页小窗。",
      timeoutTitle: "预览没有响应", timeoutDetail: "网站可能较慢、离线，或禁止嵌入显示。",
      networkTitle: "网页无法载入", networkDetail: "请重试，或改用完整网页小窗。",
      retry: "重试", compat: "完整网页小窗", fullPageRemember: "切换并记住 {host}", fullPageOnce: "仅这一次打开", fullPageToolbar: "在完整网页小窗打开并记住此网站", openingCompat: "正在打开完整网页…", newTab: "新标签页",
      close: "关闭预览", pin: "固定预览", unpin: "取消固定", reload: "刷新", openTab: "在新标签页打开", more: "更多操作",
      backNav: "后退", forwardNav: "前进", stop: "停止", stopped: "已停止加载", stoppedDetail: "刷新即可从当前地址继续。",
      compatTitle: "此网页需要完整网页小窗", compatDetail: "可仅打开这一次，或记住此精确站点；以后预览会复用同一个 Firefox 完整网页小窗。",
      copied: "已复制最终网址", copyFailed: "无法复制网址", copy: "复制最终网址", sidebar: "在侧边栏打开", closeAll: "关闭全部预览",
      compatOpened: "已在 Firefox 小窗中打开", externalOpened: "已在 Firefox 标签页中打开", externalFailed: "Firefox 无法打开该目标", rememberFailed: "网页已打开，但 Firefox 未能记住此网站", unsupportedLink: "此类链接需要使用完整网页小窗", ready: "预览已就绪"
    },
    zh_TW: {
      securePreview: "連結預覽", opening: "正在開啟…", security: "只放寬這個預覽自身的嵌入限制，網站的其他安全策略不變。",
      blockedTitle: "網站禁止被嵌入", blockedDetail: "可以重試，或改用完整網頁小視窗。",
      timeoutTitle: "預覽沒有回應", timeoutDetail: "網站可能較慢、離線，或禁止嵌入顯示。",
      networkTitle: "網頁無法載入", networkDetail: "請重試，或改用完整網頁小視窗。",
      retry: "重試", compat: "完整網頁小視窗", fullPageRemember: "切換並記住 {host}", fullPageOnce: "僅這一次開啟", fullPageToolbar: "在完整網頁小視窗開啟並記住此網站", openingCompat: "正在開啟完整網頁…", newTab: "新分頁",
      close: "關閉預覽", pin: "固定預覽", unpin: "取消固定", reload: "重新載入", openTab: "在新分頁開啟", more: "更多操作",
      backNav: "上一頁", forwardNav: "下一頁", stop: "停止", stopped: "已停止載入", stoppedDetail: "重新載入即可從目前網址繼續。",
      compatTitle: "此網頁需要完整網頁小視窗", compatDetail: "可僅開啟這一次，或記住此精確站點；以後預覽會重用同一個 Firefox 完整網頁小視窗。",
      copied: "已複製最終網址", copyFailed: "無法複製網址", copy: "複製最終網址", sidebar: "在側邊欄開啟", closeAll: "關閉全部預覽",
      compatOpened: "已在 Firefox 視窗中開啟", externalOpened: "已在 Firefox 分頁中開啟", externalFailed: "Firefox 無法開啟該目標", rememberFailed: "網頁已開啟，但 Firefox 未能記住此網站", unsupportedLink: "此類連結需要使用完整網頁小視窗", ready: "預覽已就緒"
    }
  };

  function languageKey() {
    const selected = settings.language;
    if (selected === "zh_CN" || selected === "zh-CN" || selected === "zh") return "zh_CN";
    if (selected === "zh_TW" || selected === "zh-TW") return "zh_TW";
    if (selected === "en") return "en";
    const locale = (navigator.language || "en").toLowerCase();
    if (locale.startsWith("zh-tw") || locale.startsWith("zh-hk") || locale.startsWith("zh-hant")) return "zh_TW";
    if (locale.startsWith("zh")) return "zh_CN";
    return "en";
  }

  function t(key, values = {}) {
    const lang = languageKey();
    let value = (TEXT[lang] && TEXT[lang][key]) || TEXT.en[key] || key;
    for (const [name, replacement] of Object.entries(values)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }

  function applyStrings() {
    document.documentElement.lang = languageKey().replace("_", "-");
    $("loadingTitle").textContent =
      currentStatus === "stopped" ? t("stopped") : t("opening");
    $("loadingDetail").textContent =
      currentStatus === "stopped" ? t("stoppedDetail") : t("security");
    $("retry").textContent = t("retry");
    $("compat").textContent = compatOpening
      ? t("openingCompat")
      : t("fullPageRemember", { host: hostname(currentUrl) });
    $("errorOpenTab").textContent = t("fullPageOnce");
    setButtonLabel($("close"), t("close"));
    setButtonLabel($("pin"), pinned ? t("unpin") : t("pin"));
    setButtonLabel($("back"), t("backNav"));
    setButtonLabel($("forward"), t("forwardNav"));
    setButtonLabel($("stop"), t("stop"));
    setButtonLabel($("reload"), t("reload"));
    setButtonLabel($("fullPage"), t("fullPageToolbar"));
    setButtonLabel($("openTab"), t("openTab"));
    setButtonLabel($("more"), t("more"));
    const labels = { copy: t("copy"), sidebar: t("sidebar"), compat: t("fullPageOnce"), "close-all": t("closeAll") };
    for (const button of menu.querySelectorAll("button[data-action]")) {
      const span = button.querySelector("span");
      if (span && labels[button.dataset.action]) span.textContent = labels[button.dataset.action];
    }
    if (surface.classList.contains("is-error")) {
      updateErrorText(errorCode);
      updateErrorActions();
    }
    updateIdentity();
    updateNavigationControls();
  }

  function setButtonLabel(button, label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function applyAppearance() {
    const theme = settings.theme === "light" || settings.theme === "dark" ? settings.theme : "auto";
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("reduce-motion", settings.reducedMotion === true);
    applyStrings();
  }

  function announce(message, options = {}) {
    live.textContent = "";
    requestAnimationFrame(() => { live.textContent = message; });
    if (options.host === true && hostPort) {
      hostPort.postMessage({ type: "notify", message });
    }
  }

  function validBootstrap(data, port) {
    return data && data.channel === CHANNEL && data.type === "bootstrap" &&
      typeof data.sessionId === "string" && data.sessionId.length >= 8 && data.sessionId.length <= 128 &&
      typeof data.secret === "string" && data.secret.length >= 32 && data.secret.length <= 256 && port;
  }

  window.addEventListener("message", (event) => {
    if (event.source === window.parent && !bound && !backgroundPort) {
      const transferPort = event.ports && event.ports[0];
      if (!validBootstrap(event.data, transferPort)) return;
      sessionId = event.data.sessionId;
      secret = event.data.secret;
      hostPort = transferPort;
      hostPort.onmessage = (hostEvent) => onHostMessage(hostEvent.data);
      hostPort.start();
      connectBackground();
    }
  });

  function connectBackground() {
    try {
      backgroundPort = browser.runtime.connect({ name: "gp-surface-v2" });
    } catch (_error) {
      showError("background");
      return;
    }
    backgroundPort.onMessage.addListener(onBackgroundMessage);
    backgroundPort.onDisconnect.addListener(() => {
      backgroundPort = null;
      if (!bound) showError("background");
    });
    backgroundPort.postMessage({ type: "bind", sessionId, secret });
  }

  function onBackgroundMessage(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "bound") {
      bound = true;
      secret = null;
      directTarget = message.directTarget === true;
      if (message.settings && typeof message.settings === "object") settings = { ...settings, ...message.settings };
      currentUrl = safeHttpUrl(message.url);
      if (!currentUrl) {
        showError("invalid-url");
        return;
      }
      if (typeof message.title === "string" && message.title.trim()) {
        currentTitle = message.title.trim().slice(0, 240);
      }
      applyHistoryState(message.history);
      compatRequired = message.compatRequired === true;
      compatOpening = compatRequired;
      applyAppearance();
      if (hostPort) hostPort.postMessage({ type: "surface-ready" });
      if (compatRequired) showCompatibilityState();
      else navigate(
        safeHttpUrl(message.targetUrl) || currentUrl,
        currentUrl,
        !directTarget
      );
      return;
    }
    if (message.type === "error" && !bound) {
      showError(message.code || "bind-failed");
      return;
    }
    if (message.type === "target-fallback-cancel") {
      cancelPendingTargetFallback(
        message.navigationToken,
        message.generation
      );
      return;
    }
    if (message.type === "target-fallback") {
      scheduleTargetFallback(message);
      return;
    }
    if (message.type === "navigation") {
      cancelPendingTargetFallback();
      const url = safeHttpUrl(message.url);
      if (url) currentUrl = url;
      if (typeof message.title === "string" && message.title.trim()) currentTitle = message.title.trim().slice(0, 240);
      if (Number.isInteger(message.generation)) {
        navigationGeneration = Math.max(navigationGeneration, message.generation);
      }
      applyHistoryState(message.history);
      compatRequired = message.compatRequired === true;
      if (message.error) compatOpening = false;
      currentStatus = message.status || currentStatus;
      updateIdentity();
      if (message.blocked) abortTargetNavigation();
      if (compatRequired || currentStatus === "compat-required") {
        showCompatibilityState();
      } else if (message.error || currentStatus === "error") {
        showError(classifyError(message.error));
      } else if (currentStatus === "stopped") {
        showStopped();
      } else if (currentStatus === "loading") {
        beginObservedNavigation(url, message.generation);
      } else if (currentStatus === "committed") {
        if (!targetAlive) beginObservedNavigation(url, message.generation);
        showProgress();
      } else if (currentStatus === "completed") {
        updateNavigationControls();
        if (targetAlive) showReady();
        else {
          showProgress();
          clearTimeout(aliveTimer);
          aliveTimer = setTimeout(() => {
            if (!targetAlive && currentStatus === "completed") {
              showError("timeout");
            }
          }, 15000);
        }
      } else if (
        targetAlive &&
        (currentStatus === "domcontentloaded" ||
          currentStatus === "history" ||
          currentStatus === "fragment")
      ) {
        showReady();
      } else {
        updateNavigationControls();
      }
      return;
    }
    if (message.type === "compat-opened") {
      compatRequired = true;
      compatOpening = false;
      showCompatibilityState();
      announce(t("compatOpened"), { host: true });
      setTimeout(() => {
        if (hostPort) hostPort.postMessage({ type: "close" });
      }, 250);
      return;
    }
    if (message.type === "closed") {
      if (hostPort) hostPort.postMessage({ type: "close" });
      return;
    }
    if (message.type === "target-signal") {
      if (message.signal === "alive") {
        const url = safeHttpUrl(message.url);
        if (url) currentUrl = url;
        applyHistoryState(message.history);
        markTargetAlive(message.title);
      } else if (message.signal === "activate") {
        if (hostPort) hostPort.postMessage({ type: "activate" });
      } else if (message.signal === "escape") {
        if (hostPort) hostPort.postMessage({ type: message.shiftKey ? "close-all" : "close" });
      } else if (message.signal === "history-shortcut") {
        performHistoryShortcut(message.direction);
      } else if (message.signal === "new-preview") {
        const url = safeHttpUrl(message.url);
        if (url && hostPort) hostPort.postMessage({ type: "new-preview", url, background: message.background === true });
      } else if (message.signal === "navigate-root") {
        const url = safeHttpUrl(message.url);
        if (Number.isInteger(message.generation)) {
          navigationGeneration = Math.max(
            navigationGeneration,
            message.generation
          );
        }
        applyHistoryState(message.history);
        if (url) navigate(url, url, true);
      } else if (message.signal === "unsupported-link") {
        announce(t("unsupportedLink"), { host: true });
      } else if (message.signal === "open-external-result") {
        announce(
          message.ok === true ? t("externalOpened") : t("externalFailed"),
          { host: true }
        );
      }
      return;
    }
    if (message.type === "result") settleRequest(message);
  }

  function markTargetAlive(title) {
    if (compatRequired || currentStatus === "stopped") return;
    targetAlive = true;
    if (typeof title === "string" && title.trim()) {
      currentTitle = title.trim().slice(0, 240);
    }
    updateIdentity();
    clearTimeout(aliveTimer);
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => showReady(), 0);
    updateNavigationControls();
  }

  function onHostMessage(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "host-settings" && message.settings) {
      settings = { ...settings, ...message.settings };
      pinned = message.pinned === true;
      updatePinState();
      applyAppearance();
    } else if (message.type === "pin-state") {
      pinned = message.pinned === true;
      updatePinState();
    } else if (message.type === "target-load") {
      iframeLoadSeen = true;
      if (!targetAlive && isNavigating()) {
        clearTimeout(aliveTimer);
        aliveTimer = setTimeout(() => {
          if (!targetAlive && isNavigating()) showError("timeout");
        }, 15000);
      }
    }
  }

  function safeHttpUrl(value) {
    try {
      if (typeof value !== "string" || value.length > 32768 || /[\u0000-\u001f\u007f]/.test(value)) return null;
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname) return null;
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function applyHistoryState(value) {
    if (!value || typeof value !== "object") return;
    historyState = {
      canGoBack: value.canGoBack === true,
      canGoForward: value.canGoForward === true,
      index: Number.isInteger(value.index) ? value.index : historyState.index,
      length: Number.isInteger(value.length) ? value.length : historyState.length
    };
    updateNavigationControls();
  }

  function isNavigating() {
    return currentStatus === "loading" ||
      currentStatus === "committed" ||
      currentStatus === "domcontentloaded";
  }

  function updateNavigationControls() {
    const busy = isNavigating();
    $("back").disabled = busy || !historyState.canGoBack;
    $("forward").disabled = busy || !historyState.canGoForward;
    const navigating = isNavigating() && !compatRequired;
    $("stop").hidden = !navigating;
    $("reload").hidden = navigating || compatRequired;
  }

  function startFallbackTimers() {
    hardTimer = setTimeout(() => showError("timeout"), 35000);
    aliveTimer = setTimeout(
      () => showError(iframeLoadSeen ? "embed-blocked" : "timeout"),
      15000
    );
  }

  function showProgress() {
    if (compatRequired || currentStatus === "stopped" || targetAlive) return;
    if (hostPort) hostPort.postMessage({ type: "presentation", state: "progress" });
  }

  function beginObservedNavigation(url, generation) {
    const valid = safeHttpUrl(url);
    if (!valid) return;
    if (
      loadingUrl === valid &&
      surface.classList.contains("is-loading") &&
      !targetAlive
    ) {
      if (Number.isInteger(generation)) {
        navigationGeneration = Math.max(navigationGeneration, generation);
      }
      currentStatus = "loading";
      updateNavigationControls();
      return;
    }
    loadingUrl = valid;
    currentUrl = valid;
    currentTitle = hostname(valid);
    currentStatus = "loading";
    targetAlive = false;
    iframeLoadSeen = false;
    compatRequired = false;
    if (Number.isInteger(generation)) {
      navigationGeneration = Math.max(navigationGeneration, generation);
    }
    showLoading();
    startFallbackTimers();
    updateIdentity();
    updateNavigationControls();
  }

  function abortTargetNavigation() {
    if (directTarget && hostPort) {
      hostPort.postMessage({ type: "target-stop" });
    }
    targetAlive = false;
    iframeLoadSeen = false;
  }

  function showStopped() {
    clearTimers();
    currentStatus = "stopped";
    loadingUrl = null;
    targetAlive = false;
    surface.classList.remove("is-ready", "is-error");
    surface.classList.add("is-loading", "is-stopped");
    loading.hidden = false;
    error.hidden = true;
    $("loadingTitle").textContent = t("stopped");
    $("loadingDetail").textContent = t("stoppedDetail");
    updateNavigationControls();
    if (hostPort) hostPort.postMessage({ type: "presentation", state: "stopped" });
  }

  function compatibilityRecommended(code = errorCode) {
    return (
      code === "forced-compat" ||
      code === "embed-blocked" ||
      code === "csp" ||
      code === "xfo"
    );
  }

  function updateErrorActions() {
    const recommended = compatibilityRecommended();
    const secondary = $("errorOpenTab");
    $("retry").classList.toggle("primary", !recommended);
    $("compat").classList.toggle("primary", recommended);
    $("compat").textContent = compatOpening
      ? t("openingCompat")
      : recommended
        ? t("fullPageRemember", { host: hostname(currentUrl) })
        : t("fullPageOnce");
    secondary.dataset.action = recommended ? "compat-once" : "open-tab";
    secondary.textContent = recommended ? t("fullPageOnce") : t("newTab");
  }

  function showCompatibilityState() {
    clearTimers();
    compatRequired = true;
    currentStatus = "compat-required";
    loadingUrl = null;
    targetAlive = false;
    errorCode = "forced-compat";
    surface.classList.remove("is-loading", "is-ready", "is-stopped");
    surface.classList.add("is-error");
    loading.hidden = true;
    error.hidden = false;
    $("retry").hidden = true;
    $("compat").hidden = false;
    $("compat").disabled = compatOpening;
    updateErrorActions();
    $("errorOpenTab").hidden = false;
    updateErrorText(errorCode);
    updateNavigationControls();
    requestAnimationFrame(() => error.focus({ preventScroll: true }));
    if (hostPort) hostPort.postMessage({ type: "presentation", state: "error" });
  }

  function navigate(url, displayUrl = url, loadTarget = true) {
    const valid = safeHttpUrl(url);
    const display = safeHttpUrl(displayUrl);
    if (!valid || !display) return showError("invalid-url");
    compatRequired = false;
    loadingUrl = display;
    currentUrl = display;
    currentTitle = hostname(display);
    currentStatus = "loading";
    targetAlive = false;
    iframeLoadSeen = false;
    clearTimers();
    showLoading();
    if (loadTarget && directTarget && hostPort) {
      hostPort.postMessage({ type: "target-navigate", url: valid });
    }
    startFallbackTimers();
    updateIdentity();
    updateNavigationControls();
  }

  function clearTimers() {
    clearTimeout(aliveTimer);
    clearTimeout(hardTimer);
    clearTimeout(revealTimer);
    cancelPendingTargetFallback();
  }

  function cancelPendingTargetFallback(navigationToken = null, generation = null) {
    const pending = pendingTargetFallback;
    if (!pending) return;
    if (
      typeof navigationToken === "string" &&
      navigationToken &&
      navigationToken !== pending.navigationToken
    ) {
      return;
    }
    if (
      Number.isInteger(generation) &&
      generation !== pending.generation
    ) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTargetFallback = null;
  }

  function scheduleTargetFallback(message) {
    const url = safeHttpUrl(message.url);
    const targetUrl = safeHttpUrl(message.targetUrl || message.url);
    const generation = Number.isInteger(message.generation)
      ? message.generation
      : null;
    const navigationToken =
      typeof message.navigationToken === "string"
        ? message.navigationToken
        : "";
    if (
      !url ||
      !targetUrl ||
      !navigationToken ||
      generation === null ||
      generation !== navigationGeneration ||
      !isNavigating() ||
      loadingUrl !== url
    ) {
      return;
    }

    cancelPendingTargetFallback();
    const pending = {
      url,
      targetUrl,
      generation,
      navigationToken,
      timer: 0
    };
    pendingTargetFallback = pending;
    // Give a native navigation that started at the fallback boundary one last
    // message turn to cancel this explicit URL navigation.
    pending.timer = setTimeout(() => {
      if (
        pendingTargetFallback !== pending ||
        pending.generation !== navigationGeneration ||
        !isNavigating() ||
        loadingUrl !== pending.url
      ) {
        return;
      }
      pendingTargetFallback = null;
      navigate(pending.targetUrl, pending.url);
    }, 75);
  }

  function showLoading() {
    clearTimers();
    surface.classList.remove("is-ready", "is-error", "is-stopped");
    surface.classList.add("is-loading");
    loading.hidden = false;
    error.hidden = true;
    $("loadingTitle").textContent = t("opening");
    $("loadingDetail").textContent = t("security");
    $("retry").hidden = false;
    $("compat").hidden = false;
    $("compat").disabled = false;
    $("compat").textContent = t("fullPageOnce");
    $("compat").classList.remove("primary");
    $("errorOpenTab").hidden = false;
    updateNavigationControls();
    if (hostPort) hostPort.postMessage({ type: "presentation", state: "loading" });
  }

  function showReady() {
    if (!targetAlive) return;
    clearTimers();
    surface.classList.remove("is-loading", "is-error", "is-stopped");
    surface.classList.add("is-ready");
    loading.hidden = true;
    error.hidden = true;
    loadingUrl = null;
    updateNavigationControls();
    announce(t("ready"));
    if (hostPort) {
      hostPort.postMessage({ type: "presentation", state: "ready" });
      if (!menu.hidden) {
        hostPort.postMessage({ type: "target-overlay", value: true });
      }
    }
  }

  function classifyError(raw) {
    const value = String(raw || "").toLowerCase();
    if (
      value.includes("frame") ||
      value.includes("csp") ||
      value.includes("xfo") ||
      value.includes("denied") ||
      value.includes("blocked") ||
      value.includes("policy")
    ) return "embed-blocked";
    if (value.includes("mixed") || value.includes("ssl") || value.includes("cert")) return "tls";
    if (value.includes("timeout")) return "timeout";
    if (value.includes("network") || value.includes("dns") || value.includes("connection")) return "network";
    return value || "network";
  }

  function updateErrorText(code) {
    if (code === "forced-compat") {
      $("errorTitle").textContent = t("compatTitle");
      $("errorDetail").textContent = t("compatDetail");
      return;
    }
    const blocked = code === "embed-blocked" || code === "csp" || code === "xfo";
    const timeout = code === "timeout";
    $("errorTitle").textContent = blocked ? t("blockedTitle") : timeout ? t("timeoutTitle") : t("networkTitle");
    $("errorDetail").textContent = blocked ? t("blockedDetail") : timeout ? t("timeoutDetail") : t("networkDetail");
  }

  function showError(code) {
    if (surface.classList.contains("is-error") && errorCode === code) return;
    clearTimers();
    currentStatus = "error";
    loadingUrl = null;
    errorCode = code || "network";
    surface.classList.remove("is-loading", "is-ready", "is-stopped");
    surface.classList.add("is-error");
    loading.hidden = true;
    error.hidden = false;
    $("retry").hidden = false;
    $("compat").hidden = false;
    $("compat").disabled = false;
    updateErrorActions();
    $("errorOpenTab").hidden = false;
    updateErrorText(errorCode);
    updateNavigationControls();
    requestAnimationFrame(() => error.focus({ preventScroll: true }));
    if (hostPort) hostPort.postMessage({ type: "presentation", state: "error" });
  }

  function updateIdentity() {
    const domain = currentUrl ? hostname(currentUrl) : "GlassPeek";
    $("pageTitle").textContent = currentTitle && currentTitle !== currentUrl ? currentTitle : domain;
    $("pageUrl").textContent = currentUrl || t("securePreview");
    $("pageUrl").title = currentUrl || t("securePreview");
    $("pageUrl").setAttribute("aria-label", t("copy"));
    // Avoid an extra extension-origin network request that would sit outside
    // the document-bound destination checks. The previewed document is the
    // only remote resource the GlassPeek surface initiates directly.
    $("favicon").src = "../icons/icon.svg";
  }

  function hostname(url) {
    try { return new URL(url).hostname; } catch (_error) { return "GlassPeek"; }
  }

  function sendAction(action, extra = {}) {
    if (!backgroundPort || !bound) return Promise.reject(new Error("not-bound"));
    const requestId = `${Date.now().toString(36)}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error("action-timeout"));
      }, 6000);
      requests.set(requestId, { resolve, reject, timer });
      backgroundPort.postMessage({ type: "action", action, requestId, ...extra });
    });
  }

  function settleRequest(message) {
    const item = requests.get(message.requestId);
    if (!item) return;
    requests.delete(message.requestId);
    clearTimeout(item.timer);
    if (message.ok === false) {
      item.reject(new Error(message.message || message.error || "action-failed"));
    }
    else item.resolve(message);
  }

  async function performNavigationAction(action) {
    const result = await sendAction(action);
    applyHistoryState(result.history);
    if (action === "stop") {
      if (result.commanded !== true) abortTargetNavigation();
      showStopped();
      return result;
    }
    const navigation = result.navigation;
    const url = safeHttpUrl(
      navigation && navigation.url ? navigation.url : result.url
    );
    const targetUrl = safeHttpUrl(
      navigation && navigation.targetUrl ? navigation.targetUrl : url
    );
    if (!url || !targetUrl) throw new Error("navigation-url-missing");
    if (navigation && typeof navigation.title === "string") {
      currentTitle = navigation.title.trim().slice(0, 240) || hostname(url);
    }
    if (result.commanded === true) {
      beginObservedNavigation(url, navigation && navigation.generation);
      return result;
    }
    navigate(targetUrl, url);
    return result;
  }

  function performHistoryShortcut(direction) {
    const action = direction === "back"
      ? "history-back"
      : direction === "forward"
        ? "history-forward"
        : "";
    if (!action) return;
    const button = action === "history-back" ? $("back") : $("forward");
    if (!button.disabled) performNavigationAction(action).catch(() => {});
  }

  async function openExternalAndClose(action, extra = {}) {
    if (action === "open-compat") {
      compatOpening = true;
      if (compatRequired) showCompatibilityState();
    }
    try {
      const result = await sendAction(action, extra);
      if (action === "open-compat") {
        announce(
          result.rememberFailed ? t("rememberFailed") : t("compatOpened"),
          { host: true }
        );
      }
      if (hostPort) hostPort.postMessage({ type: "close" });
      return result;
    } finally {
      if (action === "open-compat") {
        compatOpening = false;
        if (compatRequired) showCompatibilityState();
      }
    }
  }

  function updatePinState() {
    surface.classList.toggle("is-pinned", pinned);
    $("pin").setAttribute("aria-pressed", String(pinned));
    setButtonLabel($("pin"), pinned ? t("unpin") : t("pin"));
  }

  function togglePin() {
    pinned = !pinned;
    updatePinState();
    if (hostPort) hostPort.postMessage({ type: "pin", value: pinned });
  }

  $("close").addEventListener("click", () => hostPort && hostPort.postMessage({ type: "close" }));
  $("pin").addEventListener("click", togglePin);
  $("back").addEventListener("click", () => {
    performNavigationAction("history-back").catch(() => {});
  });
  $("forward").addEventListener("click", () => {
    performNavigationAction("history-forward").catch(() => {});
  });
  $("stop").addEventListener("click", () => {
    performNavigationAction("stop").catch(() => {
      abortTargetNavigation();
      showStopped();
    });
  });
  $("reload").addEventListener("click", () => {
    closeMenu();
    performNavigationAction("reload").catch(() => {});
  });
  $("fullPage").addEventListener("click", () => {
    openExternalAndClose("open-compat", { rememberDomain: true })
      .catch(() => openExternalAndClose("open-tab").catch(() => {}));
  });
  $("openTab").addEventListener("click", () => sendAction("open-tab").catch(() => {}));
  $("retry").addEventListener("click", () => {
    performNavigationAction("reload").catch(() => {});
  });
  $("compat").addEventListener("click", () => {
    openExternalAndClose("open-compat", {
      rememberDomain: compatibilityRecommended()
    })
      .catch(() => openExternalAndClose("open-tab").catch(() => {}));
  });
  $("errorOpenTab").addEventListener("click", () => {
    if ($("errorOpenTab").dataset.action === "open-tab") {
      openExternalAndClose("open-tab").catch(() => {});
      return;
    }
    openExternalAndClose("open-compat", { rememberDomain: false })
      .catch(() => openExternalAndClose("open-tab").catch(() => {}));
  });
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(currentUrl || "");
      announce(t("copied"), { host: true });
    } catch (_error) {
      announce(t("copyFailed"), { host: true });
    }
  }

  $("pageUrl").addEventListener("click", copyUrl);
  $("more").addEventListener("click", () => menu.hidden ? openMenu($("more")) : closeMenu());
  dragHandle.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(dragHandle);
  });
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    closeMenu();
    if (action === "copy") copyUrl();
    else if (action === "sidebar") sendAction("open-sidebar").catch(() => {});
    else if (action === "compat") {
      openExternalAndClose("open-compat", { rememberDomain: false })
        .catch(() => openExternalAndClose("open-tab").catch(() => {}));
    }
    else if (action === "close-all" && hostPort) hostPort.postMessage({ type: "close-all" });
  });

  function openMenu(returnFocus) {
    menuReturnFocus = returnFocus;
    menu.hidden = false;
    $("more").setAttribute("aria-expanded", "true");
    if (hostPort) hostPort.postMessage({ type: "target-overlay", value: true });
    const first = menu.querySelector("button[role='menuitem']");
    if (first) first.focus();
  }

  function closeMenu(restore = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    $("more").setAttribute("aria-expanded", "false");
    if (hostPort) hostPort.postMessage({
      type: "target-overlay",
      value: false
    });
    if (restore && menuReturnFocus && typeof menuReturnFocus.focus === "function") menuReturnFocus.focus();
    menuReturnFocus = null;
  }

  menu.addEventListener("keydown", (event) => {
    const items = Array.from(menu.querySelectorAll("button[role='menuitem']"));
    const index = items.indexOf(document.activeElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
    if (next >= 0) { event.preventDefault(); items[next].focus(); }
  });

  document.addEventListener("pointerdown", (event) => {
    if (hostPort) hostPort.postMessage({ type: "activate" });
    if (!menu.hidden && !menu.contains(event.target) && !$("more").contains(event.target)) closeMenu(false);
  }, true);

  document.addEventListener("keydown", (event) => {
    const editable = event.target instanceof HTMLElement && (
      event.target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
    );
    if (
      event.altKey &&
      !editable &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      performHistoryShortcut(event.key === "ArrowLeft" ? "back" : "forward");
      return;
    }
    if (event.key === "Escape") {
      if (!menu.hidden) { event.preventDefault(); closeMenu(); return; }
      if (hostPort) hostPort.postMessage({ type: event.shiftKey ? "close-all" : "close" });
    }
  }, true);

  dragHandle.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button")) togglePin();
  });
  dragHandle.addEventListener("auxclick", (event) => {
    if (event.button === 1 && !event.target.closest("button")) {
      event.preventDefault();
      sendAction("open-tab", { background: true }).catch(() => {});
    }
  });

  function beginPointerGesture(event, kind, edge = "") {
    if (event.button !== 0 || !hostPort) return;
    event.preventDefault();
    const element = event.currentTarget;
    const startX = event.screenX;
    const startY = event.screenY;
    let pendingDx = 0;
    let pendingDy = 0;
    let sentDx = 0;
    let sentDy = 0;
    let moveFrame = 0;
    let ended = false;

    const captureLatestPoint = (moveEvent) => {
      if (
        !moveEvent ||
        moveEvent.type === "pointercancel" ||
        moveEvent.type === "blur"
      ) {
        return;
      }
      const coalesced = typeof moveEvent.getCoalescedEvents === "function"
        ? moveEvent.getCoalescedEvents()
        : [];
      const latest = coalesced.length
        ? coalesced[coalesced.length - 1]
        : moveEvent;
      if (
        !Number.isFinite(latest.screenX) ||
        !Number.isFinite(latest.screenY)
      ) {
        return;
      }
      pendingDx = latest.screenX - startX;
      pendingDy = latest.screenY - startY;
    };
    const postLatestMove = () => {
      moveFrame = 0;
      if (!hostPort || (pendingDx === sentDx && pendingDy === sentDy)) return;
      sentDx = pendingDx;
      sentDy = pendingDy;
      hostPort.postMessage({
        type: "gesture-move",
        dx: sentDx,
        dy: sentDy
      });
    };
    const move = (moveEvent) => {
      captureLatestPoint(moveEvent);
      if (!moveFrame) moveFrame = requestAnimationFrame(postLatestMove);
    };
    const flushMove = (endEvent) => {
      captureLatestPoint(endEvent);
      if (moveFrame) {
        cancelAnimationFrame(moveFrame);
        moveFrame = 0;
      }
      postLatestMove();
    };
    const end = (endEvent) => {
      if (ended) return;
      ended = true;
      flushMove(endEvent);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
      element.removeEventListener("lostpointercapture", end);
      window.removeEventListener("blur", end);
      surface.classList.remove("is-gesturing");
      if (hostPort) hostPort.postMessage({ type: "gesture-end" });
    };

    element.setPointerCapture(event.pointerId);
    surface.classList.add("is-gesturing");
    hostPort.postMessage({ type: "gesture-start", kind, edge });
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
    element.addEventListener("lostpointercapture", end);
    window.addEventListener("blur", end, { once: true });
  }

  dragHandle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    beginPointerGesture(event, "move");
  });
  for (const handle of document.querySelectorAll(".resize[data-edge]")) {
    handle.addEventListener("pointerdown", (event) => beginPointerGesture(event, "resize", handle.dataset.edge));
  }

  dragHandle.addEventListener("keydown", (event) => {
    // Only act when the header itself has focus; buttons inside it keep
    // their own Enter/Space/arrow behaviour.
    if (event.target !== dragHandle) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePin();
      return;
    }
    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      openMenu(dragHandle);
      return;
    }
    if (!event.key.startsWith("Arrow") || !hostPort) return;
    event.preventDefault();
    const step = event.altKey ? 4 : 16;
    const values = { dx: 0, dy: 0, dw: 0, dh: 0 };
    const horizontal = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const vertical = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (event.shiftKey) { values.dw = horizontal; values.dh = vertical; }
    else { values.dx = horizontal; values.dy = vertical; }
    hostPort.postMessage({ type: "adjust", ...values });
  });

  // A web-accessible surface is inert until a valid, one-time owner capability arrives.
  setTimeout(() => {
    if (!backgroundPort && location.href === PREVIEW_URL) showError("bind-timeout");
  }, 10000);
})();
