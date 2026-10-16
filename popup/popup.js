(function () {
  "use strict";

  const GP = globalThis.GlassPeek || {};
  const FALLBACK_DEFAULTS = Object.freeze({
    enabled: true,
    language: "auto",
    theme: "auto",
    reducedMotion: false,
    siteFilterMode: "disabled",
    siteRules: [],
    schemaVersion: 3,
  });
  const DEFAULTS = Object.freeze({ ...FALLBACK_DEFAULTS, ...(GP.DEFAULTS || {}) });
  const state = { settings: { ...DEFAULTS }, tab: null, host: null, messages: null };
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

  function t(key, substitutions) {
    let value = state.messages && state.messages[key] && state.messages[key].message;
    const browserSubstitutions = substitutions && !Array.isArray(substitutions) && typeof substitutions !== "string"
      ? Object.values(substitutions).map(String)
      : substitutions;
    if (!value) value = browser.i18n.getMessage(key, browserSubstitutions) || "";
    if (value && substitutions && !Array.isArray(substitutions)) {
      for (const [name, replacement] of Object.entries(substitutions)) {
        value = value.replaceAll(`{{${name}}}`, String(replacement));
      }
    }
    return value;
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const value = t(element.dataset.i18n);
      if (value) element.textContent = value;
    });
  }

  function applyAppearance() {
    const dark = state.settings.theme === "dark"
      || (state.settings.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.reducedMotion = String(Boolean(state.settings.reducedMotion));
  }

  function normalizeDomain(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    try {
      const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
      return new URL(value).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function matchingRules(host) {
    if (!host || !Array.isArray(state.settings.siteRules)) return [];
    return state.settings.siteRules
      .filter((rule) => {
        const domain = normalizeDomain(rule && rule.domain);
        return domain && (host === domain || host.endsWith(`.${domain}`));
      })
      .map((rule) => ({ domain: normalizeDomain(rule.domain), action: rule.action === "allow" ? "allow" : "deny" }))
      .sort((a, b) => b.domain.split(".").length - a.domain.split(".").length || b.domain.length - a.domain.length);
  }

  function defaultEnabledForMode() {
    return state.settings.siteFilterMode !== "whitelist";
  }

  function siteEnabled() {
    if (!state.host) return false;
    if (state.settings.siteFilterMode === "disabled") return true;
    if (typeof GP.siteDecision === "function") {
      return GP.siteDecision(state.host, state.settings.siteRules || [], defaultEnabledForMode());
    }
    const match = matchingRules(state.host)[0];
    return match ? match.action === "allow" : defaultEnabledForMode();
  }

  function renderSiteState() {
    const supported = Boolean(state.host);
    const siteSwitch = byId("siteEnabled");
    byId("siteHost").textContent = supported ? state.host : (t("popup_unsupported_page") || "此页面不支持");
    siteSwitch.disabled = !supported || !state.settings.enabled;
    siteSwitch.checked = supported && siteEnabled();

    const reason = byId("siteReason");
    reason.classList.remove("is-override");
    if (!supported) {
      reason.textContent = "";
      return;
    }
    if (state.settings.siteFilterMode === "disabled") {
      reason.textContent = t("popup_rule_default") || "未使用站点规则";
      return;
    }
    const match = matchingRules(state.host)[0];
    if (match) {
      const exact = match.domain === state.host;
      reason.classList.toggle("is-override", exact);
      reason.textContent = exact
        ? (t("popup_exact_override") || "此域名使用精确规则")
        : (t("popup_inherited_rule", { domain: match.domain }) || `继承 ${match.domain} 的规则`);
    } else {
      reason.textContent = defaultEnabledForMode()
        ? (t("popup_default_allow") || "当前模式默认允许")
        : (t("popup_default_deny") || "当前模式默认阻止");
    }
  }

  function render() {
    byId("enabled").checked = Boolean(state.settings.enabled);
    byId("statusDot").classList.toggle("is-on", Boolean(state.settings.enabled));
    renderSiteState();
  }

  async function setSetting(patch) {
    Object.assign(state.settings, patch, { schemaVersion: DEFAULTS.schemaVersion });
    await browser.storage.sync.set({ ...patch, schemaVersion: DEFAULTS.schemaVersion });
    render();
  }

  async function setSiteOverride(enabled) {
    if (!state.host) return;
    const current = Array.isArray(state.settings.siteRules) ? state.settings.siteRules : [];
    const next = current.filter((rule) => normalizeDomain(rule && rule.domain) !== state.host);
    next.push({ domain: state.host, action: enabled ? "allow" : "deny" });
    const patch = { siteRules: next };
    if (state.settings.siteFilterMode === "disabled") patch.siteFilterMode = "blacklist";
    await setSetting(patch);
    showMessage(enabled ? (t("popup_site_allowed") || "已为此域名创建允许规则") : (t("popup_site_denied") || "已为此域名创建阻止规则"));
  }

  function showMessage(message) {
    byId("popupMessage").textContent = message;
  }

  async function openSidebar() {
    if (!state.tab || !/^https?:/i.test(state.tab.url || "")) {
      showMessage(t("popup_unsupported_page") || "此页面不支持");
      return;
    }
    const payload = { type: "gp-sidebar-open", url: state.tab.url, windowId: state.tab.windowId, tabId: state.tab.id };
    try {
      const response = await browser.runtime.sendMessage(payload);
      if (response && response.ok === false) throw new Error(response.message || response.code || "sidebar-open-failed");
      if (!response || response.ok !== true) throw new Error("sidebar-open-no-response");
      showMessage(t("popup_sidebar_opened") || "已发送到侧栏");
      setTimeout(() => window.close(), 180);
    } catch (error) {
      console.error("Sidebar open failed:", error);
      showMessage(t("popup_sidebar_failed") || "无法打开侧栏");
    }
  }

  function bindEvents() {
    byId("enabled").addEventListener("change", (event) => {
      setSetting({ enabled: event.target.checked }).catch(() => showMessage(t("save_failed") || "保存失败"));
    });
    byId("siteEnabled").addEventListener("change", (event) => {
      setSiteOverride(event.target.checked).catch(() => showMessage(t("save_failed") || "保存失败"));
    });
    byId("openSidebar").addEventListener("click", openSidebar);
    byId("openOptions").addEventListener("click", () => {
      browser.runtime.openOptionsPage().finally(() => window.close());
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
      render();
    });
  }

  async function init() {
    const manifest = browser.runtime.getManifest();
    byId("versionLabel").textContent = `v${manifest.version}`;
    const stored = await browser.storage.sync.get(null);
    state.settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) state.settings[key] = stored[key];
    }
    if (!Object.prototype.hasOwnProperty.call(stored, "siteRules") && Array.isArray(stored.disabledSites)) {
      state.settings.siteRules = stored.disabledSites.map((domain) => ({ domain, action: "deny" }));
      state.settings.siteFilterMode = stored.disabledSites.length ? "blacklist" : "disabled";
    }
    await loadMessages(state.settings.language);
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    try {
      const url = new URL(tab && tab.url);
      state.host = /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase() : null;
    } catch {
      state.host = null;
    }
    applyAppearance();
    applyTranslations();
    render();
    bindEvents();
  }

  init().catch((error) => {
    console.error("GlassPeek popup init failed:", error);
    showMessage(browser.i18n.getMessage("popup_init_failed") || "初始化失败");
  });
})();
