(function () {
  "use strict";

  const GP = globalThis.GlassPeek || {};
  const DEFAULTS = Object.freeze({
    language: "auto",
    theme: "auto",
    reducedMotion: false,
    ...(GP.DEFAULTS || {}),
  });
  const state = { settings: { ...DEFAULTS }, messages: null };

  async function loadMessages(language) {
    if (!language || language === "auto") return;
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
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      const value = t(element.dataset.i18nAriaLabel);
      if (value) element.setAttribute("aria-label", value);
    });
    const title = t("welcome_title");
    if (title) document.title = title;
  }

  function applyAppearance() {
    const dark = state.settings.theme === "dark"
      || (state.settings.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.reducedMotion = String(Boolean(state.settings.reducedMotion));
  }

  async function init() {
    const stored = await browser.storage.sync.get(null);
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(stored, key)) state.settings[key] = stored[key];
    }
    await loadMessages(state.settings.language);
    applyAppearance();
    applyTranslations();
    const manifest = browser.runtime.getManifest();
    document.getElementById("versionLabel").textContent = `GlassPeek ${manifest.version}`;
    document.getElementById("openSettings").addEventListener("click", () => browser.runtime.openOptionsPage());
    document.getElementById("closeWelcome").addEventListener("click", () => window.close());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.settings.theme === "auto") applyAppearance();
    });
  }

  init().catch((error) => console.error("GlassPeek welcome init failed:", error));
})();
