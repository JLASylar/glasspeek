(function () {
  "use strict";

  const GP = globalThis.GlassPeek || {};
  const FALLBACK_DEFAULTS = Object.freeze({
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
    addPreviewToHistory: true,
    openLinksInNewPreview: false,
    dragDropZone: true,
    showRing: true,
    siteFilterMode: "disabled",
    siteRules: [],
    forceCompatDomains: [],
    schemaVersion: 6,
  });

  const DEFAULTS = Object.freeze({ ...FALLBACK_DEFAULTS, ...(GP.DEFAULTS || {}) });
  const form = document.getElementById("settingsForm");
  const toast = document.getElementById("toast");
  const saveState = document.getElementById("saveState");
  const state = {
    settings: { ...DEFAULTS },
    messages: null,
    saveTimer: 0,
    pendingLanguageChanged: false,
    toastTimer: 0,
    shortcuts: [],
  };

  const byId = (id) => document.getElementById(id);

  function normalizeLanguage(value) {
    if (value === "en" || value === "zh_CN" || value === "zh_TW") return value;
    return "auto";
  }

  async function loadMessages(language) {
    const selected = normalizeLanguage(language);
    if (selected === "auto") {
      state.messages = null;
      return;
    }
    try {
      const url = browser.runtime.getURL(`_locales/${selected}/messages.json`);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Locale HTTP ${response.status}`);
      state.messages = await response.json();
    } catch (error) {
      state.messages = null;
      console.warn("GlassPeek locale fallback:", error);
    }
  }

  function t(key, substitutions) {
    const entry = state.messages && state.messages[key];
    let value = entry && typeof entry.message === "string" ? entry.message : "";
    const browserSubstitutions = substitutions && !Array.isArray(substitutions) && typeof substitutions !== "string"
      ? Object.values(substitutions).map(String)
      : substitutions;
    if (!value) value = browser.i18n.getMessage(key, browserSubstitutions) || "";
    if (value && substitutions && !Array.isArray(substitutions)) {
      for (const [name, replacement] of Object.entries(substitutions)) {
        value = value.replaceAll(`{{${name}}}`, String(replacement));
        value = value.replaceAll(`$${name.toUpperCase()}$`, String(replacement));
      }
    }
    return value;
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const translated = t(element.dataset.i18n);
      if (translated) element.textContent = translated;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
      const translated = t(element.dataset.i18nPlaceholder);
      if (translated) element.setAttribute("placeholder", translated);
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      const translated = t(element.dataset.i18nAriaLabel);
      if (translated) element.setAttribute("aria-label", translated);
    });
    const title = t("options_title");
    if (title) document.title = title;
    renderRules();
    renderCompatDomains();
    renderShortcuts();
  }

  function resolvedTheme(theme) {
    if (theme === "light" || theme === "dark") return theme;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyAppearance() {
    document.documentElement.dataset.theme = resolvedTheme(state.settings.theme);
    document.documentElement.dataset.reducedMotion = String(Boolean(state.settings.reducedMotion));
    document.documentElement.lang = normalizeLanguage(state.settings.language) === "auto"
      ? (browser.i18n.getUILanguage() || "en").replace("_", "-")
      : state.settings.language.replace("_", "-");
  }

  function coerceSetting(key, rawValue) {
    const booleanKeys = new Set([
      "enabled", "longPress", "drag", "modifier", "hoverSpace", "multiWindow",
      "clickOutsideClose", "pinByDefault", "rememberPosition", "rememberSize",
      "reducedMotion", "backdrop",
      "addPreviewToHistory", "openLinksInNewPreview", "dragDropZone", "showRing",
    ]);
    if (booleanKeys.has(key)) return Boolean(rawValue);
    const ranges = {
      longPressDelay: [300, 1000],
      maxWindows: [2, 10],
      widthPx: [400, 1600],
      heightPx: [300, 1200],
      widthPercent: [30, 100],
      heightPercent: [30, 100],
    };
    if (ranges[key]) {
      const fallback = Number(DEFAULTS[key]);
      const number = Number.parseInt(rawValue, 10);
      return Math.min(ranges[key][1], Math.max(ranges[key][0], Number.isFinite(number) ? number : fallback));
    }
    return rawValue;
  }

  async function readSettings() {
    const stored = await browser.storage.sync.get(null);
    const next = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) next[key] = stored[key];
    }

    // Safe, read-only compatibility with GlassPeek 1.x until the v2 migration runs.
    if (!Object.prototype.hasOwnProperty.call(stored, "longPress") && stored.triggerMode) {
      next.longPress = stored.triggerMode !== "drag";
      next.drag = stored.triggerMode !== "longpress";
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "widthPx") && stored.windowSizeMode) {
      const sizes = { small: [600, 400], medium: [800, 600], large: [1000, 700] };
      const selected = sizes[stored.windowSizeMode];
      if (selected) [next.widthPx, next.heightPx] = selected;
      if (stored.windowSizeMode === "remember") next.rememberSize = true;
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "siteRules") && Array.isArray(stored.disabledSites)) {
      next.siteFilterMode = stored.disabledSites.length ? "blacklist" : "disabled";
      next.siteRules = stored.disabledSites.map((domain) => ({ domain, action: "deny" }));
    }

    next.siteRules = normalizeRules(next.siteRules);
    next.forceCompatDomains = normalizeCompatDomainList(next.forceCompatDomains);
    next.language = normalizeLanguage(next.language);
    return next;
  }

  function setControlValue(key, value) {
    const radio = form.querySelector(`input[type="radio"][name="${CSS.escape(key)}"][value="${CSS.escape(String(value))}"]`);
    if (radio) {
      radio.checked = true;
      return;
    }
    const control = byId(key);
    if (!control) return;
    if (control.type === "checkbox") control.checked = Boolean(value);
    else control.value = String(value);
  }

  function applySettingsToForm() {
    for (const [key, value] of Object.entries(state.settings)) setControlValue(key, value);
    updateDependentControls();
    updateSizePresetState();
    updateDelayOutput();
    renderRules();
    renderCompatDomains();
  }

  function updateDelayOutput() {
    byId("longPressDelayValue").textContent = `${state.settings.longPressDelay} ms`;
  }

  function updateSizePresetState() {
    document.querySelectorAll(".preset-button").forEach((button) => {
      const matches = Number(button.dataset.width) === Number(state.settings.widthPx)
        && Number(button.dataset.height) === Number(state.settings.heightPx)
        && state.settings.sizeMode === "px";
      button.classList.toggle("is-active", matches);
      button.setAttribute("aria-pressed", String(matches));
    });
  }

  function updateDependentControls() {
    byId("longPressDelay").disabled = !state.settings.longPress;
    byId("showRing").disabled = !state.settings.longPress;
    byId("dragDropZone").disabled = !state.settings.drag;
    byId("modifierKey").disabled = !state.settings.modifier;
    byId("maxWindows").disabled = !state.settings.multiWindow;
    byId("openLinksInNewPreview").disabled = !state.settings.multiWindow;
    const pxMode = state.settings.sizeMode !== "percent";
    byId("pxSizeFields").hidden = !pxMode;
    byId("percentSizeFields").hidden = pxMode;
    byId("sizePresets").closest(".setting-row").hidden = !pxMode;
  }

  function scheduleSave(patch, options = {}) {
    Object.assign(state.settings, patch, { schemaVersion: DEFAULTS.schemaVersion });
    state.pendingLanguageChanged ||= options.languageChanged === true;
    applyAppearance();
    updateDependentControls();
    updateSizePresetState();
    updateDelayOutput();
    setSaveStatus("saving");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        // Save the complete current snapshot. Debouncing partial patches could
        // otherwise lose an earlier change when the user adjusts two controls
        // within the same 220 ms window.
        await browser.storage.sync.set({
          ...state.settings,
          siteRules: normalizeRules(state.settings.siteRules),
          forceCompatDomains: normalizeCompatDomainList(
            state.settings.forceCompatDomains
          ),
          schemaVersion: DEFAULTS.schemaVersion,
        });
        setSaveStatus("saved");
        if (state.pendingLanguageChanged) {
          state.pendingLanguageChanged = false;
          await loadMessages(state.settings.language);
          applyTranslations();
        }
      } catch (error) {
        console.error("GlassPeek settings save failed:", error);
        setSaveStatus("error");
        showToast(t("save_failed") || "保存失败");
      }
    }, options.immediate ? 0 : 220);
  }

  function setSaveStatus(status) {
    saveState.classList.toggle("gp-badge--success", status === "saved" || status === "ready");
    saveState.classList.toggle("gp-badge--warning", status === "saving" || status === "error");
    const keys = { ready: "save_ready", saving: "save_saving", saved: "save_saved", error: "save_failed" };
    saveState.textContent = t(keys[status]) || ({ ready: "已就绪", saving: "保存中…", saved: "已保存", error: "保存失败" })[status];
  }

  function showToast(message) {
    toast.textContent = message;
    toast.dataset.visible = "true";
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.dataset.visible = "false"; }, 2600);
  }

  function normalizeDomain(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || /[\s@*]/.test(trimmed)) return null;
    try {
      const prepared = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const url = new URL(prepared);
      if (url.username || url.password || !url.hostname) return null;
      if (url.pathname !== "/" || url.search || url.hash) {
        // Accept pasted URLs but store only their host.
      }
      return url.hostname.replace(/^\.+|\.+$/g, "").toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function domainSpecificity(domain) {
    return domain.split(".").length * 1000 + domain.length;
  }

  function normalizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    const map = new Map();
    for (const candidate of rules) {
      const domain = normalizeDomain(
        candidate &&
          (candidate.domain || candidate.host || candidate.hostname)
      );
      const action = candidate && candidate.action === "allow" ? "allow" : "deny";
      if (domain) map.set(domain, { domain, action });
    }
    return [...map.values()].sort((a, b) => domainSpecificity(b.domain) - domainSpecificity(a.domain));
  }

  function normalizeCompatDomainList(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map(normalizeDomain).filter(Boolean))].sort(
      (a, b) => domainSpecificity(b) - domainSpecificity(a)
    );
  }

  function createRemoveButton(label, onRemove) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rule-item__remove";
    button.textContent = "×";
    button.setAttribute("aria-label", label);
    button.addEventListener("click", onRemove);
    return button;
  }

  function renderRules() {
    const list = byId("siteRuleList");
    if (!list) return;
    list.replaceChildren();
    const rules = normalizeRules(state.settings.siteRules);
    for (const rule of rules) {
      const item = document.createElement("li");
      item.className = "rule-item";
      const domain = document.createElement("span");
      domain.className = "rule-item__domain";
      domain.textContent = rule.domain;
      domain.title = rule.domain;
      const action = document.createElement("span");
      action.className = "rule-item__action";
      action.dataset.action = rule.action;
      action.textContent = t(rule.action === "allow" ? "rule_allow" : "rule_deny") || rule.action;
      const removeLabel = t("remove_domain", { domain: rule.domain }) || `移除 ${rule.domain}`;
      const remove = createRemoveButton(removeLabel, () => {
        const next = state.settings.siteRules.filter((entry) => entry.domain !== rule.domain);
        state.settings.siteRules = normalizeRules(next);
        renderRules();
        scheduleSave({ siteRules: state.settings.siteRules }, { immediate: true });
      });
      item.append(domain, action, remove);
      list.appendChild(item);
    }
    byId("siteRuleEmpty").hidden = rules.length > 0;
  }

  function renderCompatDomains() {
    const list = byId("compatDomainList");
    const empty = byId("compatDomainEmpty");
    if (!list || !empty) return;
    list.replaceChildren();
    const domains = normalizeCompatDomainList(state.settings.forceCompatDomains);
    state.settings.forceCompatDomains = domains;
    for (const hostname of domains) {
      const item = document.createElement("li");
      item.className = "rule-item";
      const domain = document.createElement("span");
      domain.className = "rule-item__domain";
      domain.textContent = hostname;
      domain.title = hostname;
      const badge = document.createElement("span");
      badge.className = "rule-item__action";
      badge.textContent = t("full_page_site_badge") || "完整网页";
      const removeLabel =
        t("remove_full_page_site", { host: hostname }) ||
        `恢复 ${hostname} 的页内预览`;
      const remove = createRemoveButton(removeLabel, () => {
        const next = state.settings.forceCompatDomains.filter(
          (candidate) => candidate !== hostname
        );
        state.settings.forceCompatDomains = next;
        renderCompatDomains();
        scheduleSave({ forceCompatDomains: next }, { immediate: true });
        showToast(
          t("full_page_site_removed", { host: hostname }) ||
          `已恢复 ${hostname} 的页内预览`
        );
      });
      item.append(domain, badge, remove);
      list.appendChild(item);
    }
    empty.hidden = domains.length > 0;
  }

  async function hasHistoryPermission() {
    try {
      return await browser.permissions.contains({ permissions: ["history"] });
    } catch (_error) {
      return false;
    }
  }

  async function refreshHistoryPermissionState() {
    const element = byId("historyPermissionState");
    if (!element) return;
    const granted = await hasHistoryPermission();
    const enabled = state.settings.addPreviewToHistory === true && granted;
    element.dataset.granted = String(enabled);
    element.textContent = enabled
      ? (t("history_permission_on") || "已获授权；预览访问会写入 Firefox 历史。")
      : (t("history_permission_off") || "未启用，不会访问 Firefox 历史。");
  }

  async function setHistoryRecording(enabled, control) {
    let next = enabled === true;
    if (next && !(await hasHistoryPermission())) {
      try {
        next = await browser.permissions.request({ permissions: ["history"] });
      } catch (_error) {
        next = false;
      }
    }
    if (control) control.checked = next;
    state.settings.addPreviewToHistory = next;
    scheduleSave({ addPreviewToHistory: next }, { immediate: true });
    await refreshHistoryPermissionState();
    if (enabled && !next) {
      showToast(t("history_permission_denied") || "未授予历史权限，记录功能保持关闭。");
    }
  }

  function showInputError(element, key) {
    element.textContent = t(key) || (key === "domain_duplicate" ? "该域名已存在" : "请输入有效域名");
    element.hidden = false;
  }

  function addSiteRule() {
    const input = byId("siteRuleInput");
    const error = byId("siteRuleError");
    error.hidden = true;
    const domain = normalizeDomain(input.value);
    if (!domain) return showInputError(error, "domain_invalid");
    const action = byId("siteRuleAction").value === "allow" ? "allow" : "deny";
    const next = state.settings.siteRules.filter((rule) => rule.domain !== domain);
    next.push({ domain, action });
    state.settings.siteRules = normalizeRules(next);
    input.value = "";
    renderRules();
    scheduleSave({ siteRules: state.settings.siteRules }, { immediate: true });
    input.focus();
  }

  async function refreshShortcuts() {
    try {
      state.shortcuts = await browser.commands.getAll();
    } catch (error) {
      state.shortcuts = [];
      console.warn("Unable to read shortcut status:", error);
    }
    renderShortcuts();
  }

  function renderShortcuts() {
    if (!byId("shortcutList")) return;
    let missing = 0;
    document.querySelectorAll("[data-command]").forEach((row) => {
      const command = state.shortcuts.find((candidate) => candidate.name === row.dataset.command);
      const value = row.querySelector("[data-shortcut-value]");
      const shortcut = command && command.shortcut;
      value.textContent = shortcut || t("shortcut_unassigned") || "未设置";
      value.classList.toggle("gp-badge--warning", !shortcut);
      if (!shortcut) missing += 1;
    });
    const summary = byId("shortcutSummary");
    summary.textContent = missing
      ? (t("shortcut_missing", { count: missing }) || `${missing} 个快捷键未注册或发生冲突。`)
      : (t("shortcut_all_ready") || "所有快捷键均已注册。");
  }

  async function copyDiagnostics() {
    const manifest = browser.runtime.getManifest();
    const shortcutLines = state.shortcuts.map((command) => `${command.name}: ${command.shortcut || "unassigned"}`);
    const lines = [
      `GlassPeek ${manifest.version}`,
      `Firefox: ${navigator.userAgent}`,
      `Platform: ${navigator.platform || "unknown"}`,
      `Language: ${state.settings.language}`,
      `Theme: ${state.settings.theme}`,
      `Schema: ${state.settings.schemaVersion || DEFAULTS.schemaVersion}`,
      `Multi-window: ${state.settings.multiWindow} (max ${state.settings.maxWindows})`,
      `Preview history: ${state.settings.addPreviewToHistory === true}`,
      `Full-page sites: ${normalizeCompatDomainList(state.settings.forceCompatDomains).length}`,
      ...shortcutLines,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showToast(t("diagnostics_copied") || "诊断摘要已复制");
    } catch (error) {
      console.error("Copy diagnostics failed:", error);
      showToast(t("copy_failed") || "复制失败");
    }
  }

  async function resetSettings() {
    if (!confirm(t("reset_confirm") || "确定恢复所有默认设置吗？")) return;
    try {
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
      state.pendingLanguageChanged = false;
      await browser.storage.sync.set({
        ...DEFAULTS,
        siteRules: [],
        autoCompat: false,
        compatMode: "ask",
        forceCompatDomains: [],
        schemaVersion: DEFAULTS.schemaVersion
      });
      await browser.storage.sync.remove(["readerFallback"]);
      try {
        await browser.permissions.remove({ permissions: ["history"] });
      } catch (_error) {}
      await browser.storage.local.remove(["gpRect", "gpRectV2", "rememberedRect"]);
      state.settings = { ...DEFAULTS, siteRules: [] };
      await loadMessages(state.settings.language);
      applyAppearance();
      applySettingsToForm();
      applyTranslations();
      await refreshHistoryPermissionState();
      setSaveStatus("saved");
      showToast(t("reset_done") || "已恢复默认设置");
    } catch (error) {
      console.error("Reset failed:", error);
      showToast(t("reset_failed") || "重置失败");
    }
  }

  function activateSection(id, options = {}) {
    const target = byId(id) || byId("appearance");
    document.querySelectorAll(".settings-section").forEach((section) => {
      section.classList.toggle("is-active", section === target);
    });
    document.querySelectorAll("[data-section]").forEach((button) => {
      const active = button.dataset.section === target.id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    if (options.updateHash !== false) history.replaceState(null, "", `#${target.id}`);
    if (options.focus) target.focus({ preventScroll: true });
    scrollTo({ top: 0, behavior: state.settings.reducedMotion ? "auto" : "smooth" });
  }

  function readControlValue(control) {
    if (control.type === "checkbox") return control.checked;
    if (control.type === "number" || control.type === "range") return coerceSetting(control.dataset.setting || control.name, control.value);
    return control.value;
  }

  function bindEvents() {
    document.querySelectorAll("[data-section]").forEach((button) => {
      button.addEventListener("click", () => activateSection(button.dataset.section, { focus: true }));
    });

    form.addEventListener("change", async (event) => {
      const control = event.target;
      let key = control.dataset.setting || "";
      if (control.matches('input[type="radio"]')) key = control.name;
      if (!key) return;
      const value = coerceSetting(key, readControlValue(control));
      if (key === "addPreviewToHistory") {
        await setHistoryRecording(value, control);
        return;
      }
      scheduleSave({ [key]: value }, { languageChanged: key === "language" });
    });

    byId("longPressDelay").addEventListener("input", (event) => {
      const value = coerceSetting("longPressDelay", event.target.value);
      state.settings.longPressDelay = value;
      updateDelayOutput();
      scheduleSave({ longPressDelay: value });
    });

    document.querySelectorAll(".preset-button").forEach((button) => {
      button.addEventListener("click", () => {
        const widthPx = Number(button.dataset.width);
        const heightPx = Number(button.dataset.height);
        state.settings.sizeMode = "px";
        state.settings.widthPx = widthPx;
        state.settings.heightPx = heightPx;
        setControlValue("sizeMode", "px");
        setControlValue("widthPx", widthPx);
        setControlValue("heightPx", heightPx);
        updateDependentControls();
        updateSizePresetState();
        scheduleSave({ sizeMode: "px", widthPx, heightPx });
      });
    });

    byId("addSiteRule").addEventListener("click", addSiteRule);
    byId("siteRuleInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); addSiteRule(); }
    });
    byId("refreshShortcuts").addEventListener("click", refreshShortcuts);
    byId("openShortcutHelp").addEventListener("click", () => {
      browser.tabs.create({ url: "about:addons" }).catch(() => showToast(t("shortcut_help_failed") || "无法打开快捷键管理"));
    });
    byId("copyDiagnostics").addEventListener("click", copyDiagnostics);
    byId("resetSettings").addEventListener("click", resetSettings);
    window.addEventListener("hashchange", () => activateSection(location.hash.slice(1), { updateHash: false }));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.settings.theme === "auto") applyAppearance();
    });
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "sync") return;
      let languageChanged = false;
      for (const [key, change] of Object.entries(changes)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
        state.settings[key] = change.newValue === undefined ? DEFAULTS[key] : change.newValue;
        languageChanged ||= key === "language";
      }
      if (languageChanged) await loadMessages(state.settings.language);
      applyAppearance();
      applySettingsToForm();
      if (languageChanged) applyTranslations();
      await refreshHistoryPermissionState();
    });
  }

  async function init() {
    try {
      const manifest = browser.runtime.getManifest();
      byId("versionLabel").textContent = `v${manifest.version}`;
      state.settings = await readSettings();
      if (state.settings.addPreviewToHistory === true && !(await hasHistoryPermission())) {
        state.settings.addPreviewToHistory = false;
        await browser.storage.sync.set({
          addPreviewToHistory: false,
          schemaVersion: DEFAULTS.schemaVersion
        });
      }
      await loadMessages(state.settings.language);
      applyAppearance();
      applySettingsToForm();
      applyTranslations();
      bindEvents();
      await refreshHistoryPermissionState();
      await refreshShortcuts();
      setSaveStatus("ready");
      activateSection(location.hash.slice(1) || "appearance", { updateHash: false });
    } catch (error) {
      console.error("GlassPeek options init failed:", error);
      setSaveStatus("error");
      showToast(t("options_init_failed") || "设置页初始化失败");
    }
  }

  init();
})();
