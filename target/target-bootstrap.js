(() => {
  "use strict";

  const CHANNEL = "glasspeek-target-bootstrap-v3";
  const MAX_CONCURRENT_ATTEMPTS = 16;
  let activeAttempts = 0;
  let navigated = false;

  window.parent.postMessage(
    { channel: CHANNEL, type: "ready" },
    "*"
  );

  window.addEventListener("message", (event) => {
    if (
      navigated ||
      activeAttempts >= MAX_CONCURRENT_ATTEMPTS ||
      event.source !== window.parent
    ) return;
    const data = event.data;
    if (
      !data ||
      data.channel !== CHANNEL ||
      data.type !== "bind" ||
      typeof data.sessionId !== "string" ||
      data.sessionId.length < 8 ||
      data.sessionId.length > 128 ||
      typeof data.secret !== "string" ||
      data.secret.length < 32 ||
      data.secret.length > 256
    ) {
      return;
    }
    let port;
    try {
      port = browser.runtime.connect({ name: "gp-target-bootstrap-v3" });
    } catch (_error) {
      return;
    }
    activeAttempts += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      activeAttempts = Math.max(0, activeAttempts - 1);
    };

    port.onMessage.addListener((message) => {
      if (message && message.type === "rejected") {
        settle();
        return;
      }
      if (!message || message.type !== "navigate") return;
      let target;
      try {
        target = new URL(message.url);
      } catch (_error) {
        return;
      }
      if (
        !/^https?:$/.test(target.protocol) ||
        target.username ||
        target.password ||
        !target.hostname
      ) {
        return;
      }
      navigated = true;
      settle();
      location.replace(target.href);
    });
    port.onDisconnect.addListener(settle);

    port.postMessage({
      type: "bind",
      sessionId: data.sessionId,
      secret: data.secret
    });
  });
})();
