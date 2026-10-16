"use strict";

/**
 * GlassPeek background controller for Firefox 153+.
 *
 * Security invariants:
 * - embedding-header compatibility is scoped to one verified target frame tree;
 * - only frame options and CSP frame-ancestors are relaxed for that tree;
 * - owner and preview capabilities are bound to documentId, never frameId;
 * - preview grants are one-time, memory-only, and expire after 10 seconds;
 * - all externally supplied URLs cross the shared normalizeUrl boundary.
 */

const GP = globalThis.GlassPeek;
if (!GP) throw new Error("GlassPeek shared/common.js must load before background.js");

const PREVIEW_URL = browser.runtime.getURL("preview/preview.html");
const TARGET_BOOTSTRAP_URL = browser.runtime.getURL("target/target-bootstrap.html");
const SIDEBAR_URL = browser.runtime.getURL("sidebar/sidebar.html");
const POPUP_URL = browser.runtime.getURL("popup/popup.html");
const OPTIONS_URL = browser.runtime.getURL("options/options.html");
const GRANT_TTL_MS = 10_000;
const BIND_TTL_MS = 10_000;
const TARGET_BIND_TTL_MS = 6_000;
const TARGET_BOOTSTRAP_TTL_MS = 15_000;
const ABSOLUTE_MAX_WINDOWS = 10;
const NAVIGATION_HISTORY_LIMIT = 100;
const STOP_SUPPRESS_MS = 3_000;
const HISTORY_DEDUPE_MS = 30_000;
const PENDING_NAVIGATION_TIMEOUT_MS = 35_000;

/** documentId -> OwnerContext */
const owners = new Map();
/** sessionId -> PreviewSession */
const sessions = new Map();
/** surface documentId -> PreviewSession */
const sessionsBySurfaceDocument = new Map();
/** `${tabId}:${frameId}` -> direct target PreviewSession */
const sessionsByDirectTargetFrame = new Map();
/** `${tabId}:${frameId}` -> verified direct-target descendant tree PreviewSession */
const sessionsByTargetTreeFrame = new Map();
/** unbound surface connection records */
const provisionalSurfaces = new Set();
/** target documentId -> verified content-script connection */
const targetContextsByDocument = new Map();
/** tabId -> in-flight getAllFrames() promise, shared by concurrent descendants */
const inFlightFrameSnapshots = new Map();
/** windowId -> { url, updatedAt, sessionId } */
const sidebarByWindow = new Map();
/** source tabId -> { url, updatedAt, sessionId, tabId, windowId } */
const sidebarByTab = new Map();
/** source Firefox windowId -> browser-managed compatibility windowId */
const compatibilityBySourceWindow = new Map();
/** source Firefox windowId -> serialized compatibility-window open/update */
const compatibilityOpenQueueBySourceWindow = new Map();
/** sidebar documentId -> armed public target context */
const sidebarSurfacesByDocument = new Map();
/** sidebar documentId -> most recent client arm request */
const sidebarArmIdsByDocument = new Map();
/** webRequest requestId -> immutable sidebar arm generation */
const sidebarRequestsById = new Map();
/** hostname -> { status: "public" | "private" | "synthetic", addresses: string[], expiresAt: number } */
const resolvedHostSafety = new Map();
/** hostname -> in-flight DNS safety promise */
const inFlightHostSafety = new Map();
/** tabId -> most recently observed joint session-history length */
const nativeHistoryLengthByTab = new Map();

function normalizedCompatHostname(value) {
  if (typeof value !== "string") return "";
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    const url = new URL(candidate);
    if (url.username || url.password || !url.hostname) return "";
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch (_error) {
    return "";
  }
}

function normalizeCompatDomains(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizedCompatHostname).filter(Boolean))].sort();
}

function forcedCompatibilityHostname(url, settings = settingsCache) {
  const hostname = normalizedCompatHostname(url);
  return !!(
    hostname &&
    normalizeCompatDomains(settings && settings.forceCompatDomains).includes(
      hostname
    )
  );
}

function resolvedAddressIsPrivate(address) {
  if (typeof address !== "string" || !address) return true;
  const literal = address.includes(":")
    ? `http://[${address.replace(/^\[|\]$/g, "")}]/`
    : `http://${address}/`;
  return GP.isPrivateHost(literal);
}

function canonicalResolvedAddress(address) {
  const normalized = String(address || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.+$/, "")
    .toLowerCase();
  if (!normalized.includes(":")) return normalized;
  if (!/^[0-9a-f:]+$/.test(normalized)) return normalized;
  const halves = normalized.split("::");
  if (halves.length > 2) return normalized;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return normalized;
  }
  const words = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...right,
  ];
  if (
    words.length !== 8 ||
    words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))
  ) {
    return normalized;
  }
  return words
    .map((word) => Number.parseInt(word, 16).toString(16).padStart(4, "0"))
    .join(":");
}

/**
 * Mihomo/Clash TUN mode intentionally answers public hostnames from dedicated
 * fake-IP pools. They are transport handles, not the destination server.
 * Keep this allowlist deliberately narrow: Mihomo's default IPv4 /16 and
 * documented IPv6 fake-IP prefix only.
 */
function isKnownSyntheticProxyAddress(address) {
  const normalized = canonicalResolvedAddress(address);
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    return (
      octets.every((value) => value >= 0 && value <= 255) &&
      octets[0] === 198 &&
      octets[1] === 18
    );
  }
  return normalized.startsWith("fdfe:dcba:9876:0000:");
}

function resolvedAddressesAreSyntheticProxy(addresses) {
  return (
    Array.isArray(addresses) &&
    addresses.length > 0 &&
    addresses.every(isKnownSyntheticProxyAddress)
  );
}

function resolvedEvidenceForUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return resolvedHostSafety.get(hostname) || null;
  } catch (_error) {
    return null;
  }
}

async function publicResolvedUrl(url) {
  const normalized = GP.normalizeUrl(url);
  if (!normalized || GP.isPrivateHost(normalized)) return "private";
  let hostname = "";
  try {
    hostname = new URL(normalized).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch (_error) {
    return "private";
  }
  if (!hostname) return "private";

  const cached = resolvedHostSafety.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  const existing = inFlightHostSafety.get(hostname);
  if (existing) return existing;

  const pending = browser.dns
    .resolve(hostname)
    .then((record) => {
      const addresses = Array.isArray(record && record.addresses)
        ? record.addresses.map(canonicalResolvedAddress).filter(Boolean)
        : [];
      const status = resolvedAddressesAreSyntheticProxy(addresses)
        ? "synthetic"
        : addresses.length > 0 &&
            addresses.every((address) => !resolvedAddressIsPrivate(address))
          ? "public"
          : "private";
      resolvedHostSafety.set(hostname, {
        status,
        addresses,
        // Keep the positive cache short. onHeadersReceived validates the
        // actual remote address or accepted HTTPS origin again.
        expiresAt: Date.now() + (status === "private" ? 30_000 : 5_000),
      });
      return status;
    })
    // Remote-DNS SOCKS configurations can make browser.dns.resolve
    // unavailable. Defer that case to request proxy/IP evidence rather than
    // breaking every public preview.
    .catch(() => "unknown")
    .finally(() => {
      if (inFlightHostSafety.get(hostname) === pending) {
        inFlightHostSafety.delete(hostname);
      }
    });
  inFlightHostSafety.set(hostname, pending);
  return pending;
}

function requestUsesRemoteProxy(details) {
  const proxyInfo = details?.proxyInfo;
  if (!proxyInfo) return false;
  const type = String(proxyInfo.type || "unknown").toLowerCase();
  return type !== "direct";
}

async function verifiedResponseOrigin(details, url) {
  const remoteProxy = requestUsesRemoteProxy(details);
  const actualAddress =
    typeof details?.ip === "string"
      ? canonicalResolvedAddress(details.ip)
      : "";
  const actualPrivate = !!actualAddress && resolvedAddressIsPrivate(actualAddress);
  const evidence = resolvedEvidenceForUrl(url);
  const syntheticTransportPeer = !!(
    actualAddress &&
    actualPrivate &&
    evidence?.status === "synthetic" &&
    Array.isArray(evidence.addresses) &&
    evidence.addresses.includes(actualAddress) &&
    isKnownSyntheticProxyAddress(actualAddress)
  );

  // A direct connection to an unexpected private peer is a DNS-rebinding
  // boundary and remains blocked even if the response happens to use TLS.
  const hardPrivatePeer =
    !remoteProxy && actualPrivate && !syntheticTransportPeer;
  if (hardPrivatePeer) {
    return {
      verified: false,
      hardPrivatePeer: true,
      actualAddress,
      remoteProxy,
    };
  }

  const directPublicPeer =
    !remoteProxy && !!actualAddress && !actualPrivate;
  if (directPublicPeer) {
    return {
      verified: true,
      hardPrivatePeer: false,
      actualAddress,
      remoteProxy,
    };
  }

  // With HTTP/SOCKS proxies or TUN fake-IP transports Firefox's reported IP
  // is not the destination server. For HTTPS, the browser-accepted TLS
  // connection still authenticates the requested origin. A synthetic address
  // only exempts the transport handle from the private-peer hard block; it is
  // never sufficient by itself to weaken embedding protection.
  let secureOrigin = false;
  if (
    String(url || "").startsWith("https://") &&
    typeof details?.requestId === "string" &&
    typeof browser.webRequest.getSecurityInfo === "function"
  ) {
    try {
      const securityInfo = await browser.webRequest.getSecurityInfo(
        details.requestId
      );
      const acceptedState =
        securityInfo &&
        (securityInfo.state === "secure" || securityInfo.state === "weak");
      const hasCertificate =
        Array.isArray(securityInfo?.certificates) &&
        securityInfo.certificates.length > 0;
      const hasCertificateException = !!(
        securityInfo?.overridableErrorCategory ||
        securityInfo?.errorMessage ||
        securityInfo?.isDomainMismatch === true ||
        securityInfo?.isNotValidAtThisTime === true ||
        securityInfo?.isUntrusted === true
      );
      secureOrigin = !!(
        acceptedState &&
        hasCertificate &&
        !hasCertificateException
      );
    } catch (_error) {
      secureOrigin = false;
    }
  }

  return {
    verified: secureOrigin,
    hardPrivatePeer: false,
    actualAddress,
    remoteProxy,
  };
}

function cloneSettings(value) {
  const merged = { ...GP.DEFAULTS, ...(value || {}) };
  merged.siteRules = Array.isArray(merged.siteRules)
    ? merged.siteRules.map((rule) =>
        rule && typeof rule === "object" ? { ...rule } : rule
      )
    : [];
  // A site enters the top-level compatibility route only after an explicit
  // user choice. Keep that exact-host memory while ignoring retired global
  // automatic compatibility modes from earlier builds.
  merged.autoCompat = false;
  merged.compatMode = "ask";
  merged.forceCompatDomains = normalizeCompatDomains(
    merged.forceCompatDomains
  );
  delete merged.readerFallback;
  merged.maxWindows = Math.min(
    ABSOLUTE_MAX_WINDOWS,
    Math.max(1, Number.parseInt(merged.maxWindows, 10) || GP.DEFAULTS.maxWindows)
  );
  merged.longPressDelay = Math.min(
    3000,
    Math.max(150, Number.parseInt(merged.longPressDelay, 10) || GP.DEFAULTS.longPressDelay)
  );
  return merged;
}

let settingsCache = cloneSettings(GP.DEFAULTS);

const settingsReady = browser.storage.sync
  .get(null)
  .then((stored) => {
    const migration = migrateStoredSettings(stored || {});
    settingsCache = cloneSettings(migration.value);
    if (migration.changed) {
      return browser.storage.sync
        .set(migration.value)
        .then(() => browser.storage.sync.remove(migration.remove || []));
    }
    return undefined;
  })
  .catch(() => {});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const next = { ...settingsCache };
  for (const [key, change] of Object.entries(changes)) {
    if (change.newValue === undefined) delete next[key];
    else next[key] = change.newValue;
  }
  settingsCache = cloneSettings(next);
  enforceCurrentSettings();
});

function migrateStoredSettings(stored) {
  const storedSchemaVersion = Number(stored.schemaVersion);
  const schemaOutdated =
    !Number.isFinite(storedSchemaVersion) ||
    storedSchemaVersion < GP.DEFAULTS.schemaVersion;
  const originalModeOutdated =
    stored.autoCompat !== false ||
    stored.compatMode !== "ask" ||
    !Array.isArray(stored.forceCompatDomains) ||
    Object.prototype.hasOwnProperty.call(stored, "readerFallback");
  if (!schemaOutdated && !originalModeOutdated) {
    return { value: stored, changed: false, remove: [] };
  }
  const value = {
    ...stored,
    addPreviewToHistory:
      schemaOutdated &&
      (!Number.isFinite(storedSchemaVersion) || storedSchemaVersion < 5)
        ? true
        : stored.addPreviewToHistory !== false,
    autoCompat: false,
    compatMode: "ask",
    forceCompatDomains: normalizeCompatDomains(stored.forceCompatDomains),
    schemaVersion: GP.DEFAULTS.schemaVersion,
  };
  delete value.readerFallback;
  if (!Array.isArray(value.siteRules) && Array.isArray(stored.disabledSites)) {
    value.siteRules = stored.disabledSites
      .map((host) => String(host || "").trim().toLowerCase())
      .filter(Boolean)
      .map((domain) => ({ domain, action: "deny" }));
    if (value.siteRules.length) value.siteFilterMode = "blacklist";
  }
  if (typeof stored.triggerMode === "string") {
    value.longPress = stored.triggerMode === "longpress" || stored.triggerMode === "both";
    value.drag = stored.triggerMode === "drag" || stored.triggerMode === "both";
  }
  if (typeof stored.windowSizeMode === "string") {
    const sizes = {
      small: [600, 400],
      medium: [800, 600],
      large: [1000, 700],
    };
    if (sizes[stored.windowSizeMode]) {
      [value.widthPx, value.heightPx] = sizes[stored.windowSizeMode];
      value.sizeMode = "px";
    }
    if (stored.windowSizeMode === "remember") value.rememberSize = true;
  }
  return { value, changed: true, remove: ["readerFallback"] };
}

function settingsSnapshot() {
  return cloneSettings(settingsCache);
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function validRequestId(value) {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function directTargetKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function targetTreeSession(tabId, frameId) {
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || frameId <= 0) {
    return null;
  }
  const session = sessionsByTargetTreeFrame.get(directTargetKey(tabId, frameId));
  if (
    !session ||
    session.destroyed ||
    session.tabId !== tabId ||
    !session.targetTreeFrameIds?.has(frameId)
  ) {
    return null;
  }
  return session;
}

function bindTargetTreeFrame(session, frameId, parentFrameId = null) {
  if (
    !session ||
    session.destroyed ||
    !Number.isInteger(frameId) ||
    frameId <= 0
  ) {
    return false;
  }
  const existing = targetTreeSession(session.tabId, frameId);
  if (existing && existing !== session) return false;
  if (Number.isInteger(parentFrameId) && parentFrameId > 0) {
    const parentSession = targetTreeSession(session.tabId, parentFrameId);
    if (parentSession !== session) return false;
    session.targetTreeParents.set(frameId, parentFrameId);
  } else if (frameId !== session.directTargetFrameId) {
    return false;
  }
  session.targetTreeFrameIds.add(frameId);
  sessionsByTargetTreeFrame.set(directTargetKey(session.tabId, frameId), session);
  return true;
}

function clearTargetTreeFrames(session, keepDirect = false) {
  if (!session || !session.targetTreeFrameIds) return;
  for (const frameId of [...session.targetTreeFrameIds]) {
    if (keepDirect && frameId === session.directTargetFrameId) {
      session.targetTreeDocumentIds?.delete(frameId);
      continue;
    }
    if (
      sessionsByTargetTreeFrame.get(directTargetKey(session.tabId, frameId)) ===
      session
    ) {
      sessionsByTargetTreeFrame.delete(directTargetKey(session.tabId, frameId));
    }
    session.targetTreeFrameIds.delete(frameId);
    session.targetTreeParents.delete(frameId);
    session.targetTreeDocumentIds?.delete(frameId);
  }
}

function removeTargetTreeSubtree(session, rootFrameId, includeRoot = false) {
  if (!session || !session.targetTreeFrameIds?.has(rootFrameId)) return;
  const removable = new Set(includeRoot ? [rootFrameId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [frameId, parentFrameId] of session.targetTreeParents) {
      if (
        (parentFrameId === rootFrameId || removable.has(parentFrameId)) &&
        !removable.has(frameId)
      ) {
        removable.add(frameId);
        changed = true;
      }
    }
  }
  const affectedFrames = new Set(removable);
  affectedFrames.add(rootFrameId);
  for (const frameId of affectedFrames) {
    session.targetTreeDocumentIds?.delete(frameId);
  }
  for (const [documentId, context] of session.descendantTargetPorts || []) {
    if (!affectedFrames.has(context.frameId)) continue;
    session.descendantTargetPorts.delete(documentId);
    targetContextsByDocument.delete(documentId);
    try {
      context.port.disconnect();
    } catch (_error) {}
  }
  for (const frameId of removable) {
    if (
      sessionsByTargetTreeFrame.get(directTargetKey(session.tabId, frameId)) ===
      session
    ) {
      sessionsByTargetTreeFrame.delete(directTargetKey(session.tabId, frameId));
    }
    session.targetTreeFrameIds.delete(frameId);
    session.targetTreeParents.delete(frameId);
  }
}

function registerTargetTreeFrame(details) {
  if (
    !details ||
    !Number.isInteger(details.tabId) ||
    !Number.isInteger(details.frameId) ||
    details.frameId <= 0
  ) {
    return null;
  }
  const existing = targetTreeSession(details.tabId, details.frameId);
  if (existing) {
    if (typeof details.documentId === "string" && details.documentId) {
      existing.targetTreeDocumentIds?.set(details.frameId, details.documentId);
    }
    return existing;
  }
  const parentFrameId = Number(details.parentFrameId);
  if (!Number.isInteger(parentFrameId) || parentFrameId <= 0) return null;
  const parentSession = targetTreeSession(details.tabId, parentFrameId);
  if (!parentSession) return null;
  if (!bindTargetTreeFrame(parentSession, details.frameId, parentFrameId)) {
    return null;
  }
  if (typeof details.documentId === "string" && details.documentId) {
    parentSession.targetTreeDocumentIds?.set(details.frameId, details.documentId);
  }
  return parentSession;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeError(error, fallbackCode = "FAILED") {
  return {
    code:
      error && typeof error.code === "string"
        ? error.code.slice(0, 64)
        : fallbackCode,
    message:
      error && typeof error.message === "string"
        ? error.message.slice(0, 300)
        : "Operation failed",
  };
}

function safePost(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch (_error) {
    return false;
  }
}

function allFramesSnapshot(tabId) {
  const existing = inFlightFrameSnapshots.get(tabId);
  if (existing) return existing;
  const pending = browser.webNavigation
    .getAllFrames({ tabId })
    .catch(() => [])
    .finally(() => {
      if (inFlightFrameSnapshots.get(tabId) === pending) {
        inFlightFrameSnapshots.delete(tabId);
      }
    });
  inFlightFrameSnapshots.set(tabId, pending);
  return pending;
}

function ownerError(owner, requestId, code, message) {
  safePost(owner.port, { type: "error", requestId, code, message });
}

function siteRuleDecision(url, settings = settingsCache) {
  if (settings.siteFilterMode === "disabled") return true;
  return GP.siteDecision(
    url,
    settings.siteRules,
    settings.siteFilterMode !== "whitelist"
  );
}

function enforceCurrentSettings() {
  const settings = settingsCache;
  for (const session of [...sessions.values()]) {
    if (
      !settings.enabled ||
      !siteRuleDecision(session.owner.url, settings) ||
      !siteRuleDecision(session.currentUrl, settings)
    ) {
      destroySession(session, "settings-disabled");
    } else {
      session.settings = settingsSnapshot();
      session.compatRequired = null;
      if (session.targetPort) {
        safePost(session.targetPort, {
          type: "config",
          role: "direct",
          openLinksInNewPreview: session.settings.openLinksInNewPreview === true,
          sourceUrl: session.owner.url,
        });
      }
      for (const context of session.descendantTargetPorts?.values() || []) {
        safePost(context.port, {
          type: "config",
          role: "descendant",
          openLinksInNewPreview: session.settings.openLinksInNewPreview === true,
          sourceUrl: session.owner.url,
        });
      }
    }
  }
  if (!settings.enabled) {
    const windowIds = Array.from(sidebarByWindow.keys());
    sidebarByWindow.clear();
    sidebarByTab.clear();
    for (const windowId of windowIds) {
      browser.runtime
        .sendMessage({ type: "gp-sidebar-state", windowId, state: null })
        .catch(() => {});
    }
  }
}


function sourceAllowed(url, settings = settingsCache) {
  const normalized = GP.normalizeUrl(url);
  return !!(
    normalized &&
    settings.enabled &&
    siteRuleDecision(normalized, settings)
  );
}

function previewTargetAllowed(url, settings = settingsCache) {
  const normalized = GP.normalizeUrl(url);
  return !!(
    normalized &&
    settings.enabled &&
    !GP.isPrivateHost(normalized) &&
    siteRuleDecision(normalized, settings)
  );
}

// Removes frame-ancestors from every policy in a CSP header value. When
// removeWhen is given it receives the directive's source list and only the
// policies for which it returns true lose the directive; the others are kept
// byte-for-byte.
function stripFrameAncestors(value, removeWhen = null) {
  const input = String(value || "");
  if (!/(^|[;,])\s*frame-ancestors(?:\s|[;,]|$)/i.test(input)) return input;

  return input
    .split(/,(?=\s*[a-z][a-z0-9-]*(?:\s|;|$))/i)
    .map((policy) =>
      policy
        .split(";")
        .filter((directive) => {
          if (!/^\s*frame-ancestors(?:\s|$)/i.test(directive)) return true;
          if (typeof removeWhen !== "function") return false;
          const sources = directive.trim().split(/\s+/).slice(1);
          return !removeWhen(sources);
        })
        .map((directive) => directive.trim())
        .filter(Boolean)
        .join("; ")
    )
    .filter(Boolean)
    .join(", ");
}

// --- Descendant-frame embedding simulation ---------------------------------
// GlassPeek itself embeds only the direct preview target. Every deeper iframe
// was created by the previewed page, so a third-party response in such a frame
// must not receive more embedding latitude than it would get if the direct
// target were a real top-level document. The helpers below evaluate
// X-Frame-Options and CSP frame-ancestors against a simulated ancestor chain
// whose top is the direct target: the owner page (frameId 0) is dropped, and
// the preview control bar is a sibling frame that never appears in the chain.
// A protection is removed only when the simulated chain already satisfies it,
// i.e. when the owner page is the sole reason Firefox would block the frame.

function embeddingUrlParts(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch (_error) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const scheme = parsed.protocol.slice(0, -1);
  return {
    scheme,
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || (scheme === "https" ? "443" : "80"),
    path: parsed.pathname || "/",
  };
}

function sameEmbeddingOrigin(a, b) {
  return (
    !!a &&
    !!b &&
    a.scheme === b.scheme &&
    a.host === b.host &&
    a.port === b.port
  );
}

function cspSchemeMatches(sourceScheme, targetScheme) {
  // CSP3 scheme-part matching: an http source also matches https targets.
  return (
    sourceScheme === targetScheme ||
    (sourceScheme === "http" && targetScheme === "https")
  );
}

// CSP3 "Does url match source expression" restricted to the source kinds that
// are meaningful for frame-ancestors: 'self', 'none', scheme-source and
// host-source. Anything unrecognised never matches, which keeps the header.
function cspSourceMatchesAncestor(source, ancestor, self) {
  const token = String(source || "").trim();
  if (!token) return false;
  if (token.startsWith("'")) {
    if (token.toLowerCase() !== "'self'" || !self) return false;
    return (
      self.host === ancestor.host &&
      cspSchemeMatches(self.scheme, ancestor.scheme) &&
      (self.port === ancestor.port ||
        (self.scheme === "http" &&
          self.port === "80" &&
          ancestor.scheme === "https" &&
          ancestor.port === "443"))
    );
  }
  const schemeOnly = /^([a-z][a-z0-9+.-]*):$/i.exec(token);
  if (schemeOnly) {
    return cspSchemeMatches(schemeOnly[1].toLowerCase(), ancestor.scheme);
  }
  const hostSource =
    /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[0-9a-f:.]+\])(?::(\d+|\*))?(\/[^?#]*)?$/i.exec(
      token
    );
  if (!hostSource) return false;
  const [, scheme, hostPattern, port, path] = hostSource;
  const sourceScheme = scheme ? scheme.toLowerCase() : self ? self.scheme : null;
  if (!sourceScheme || !cspSchemeMatches(sourceScheme, ancestor.scheme)) {
    return false;
  }
  const host = hostPattern.toLowerCase().replace(/\.$/, "");
  if (host === "*") {
    // A bare wildcard matches any host.
  } else if (host.startsWith("*.")) {
    const suffix = host.slice(1);
    if (
      !ancestor.host.endsWith(suffix) ||
      ancestor.host.length <= suffix.length
    ) {
      return false;
    }
  } else if (host !== ancestor.host) {
    return false;
  }
  if (port === "*") {
    // Any port.
  } else if (port) {
    if (port !== ancestor.port) return false;
  } else {
    const defaultPort = ancestor.scheme === "https" ? "443" : "80";
    if (ancestor.port !== defaultPort) return false;
  }
  if (path) {
    if (path.endsWith("/")) {
      if (!ancestor.path.startsWith(path)) return false;
    } else if (ancestor.path !== path) {
      return false;
    }
  }
  return true;
}

// Builds the "direct target is the top-level document" view of a descendant
// frame's ancestors from the verified frameAncestors chain. Returns null when
// the chain cannot be simulated; callers must then leave every header intact.
function descendantEmbeddingSimulation(details, url) {
  const self = embeddingUrlParts(url);
  const frameAncestors = Array.isArray(details?.frameAncestors)
    ? details.frameAncestors
    : [];
  // frameAncestors runs from the immediate parent up to the owner page
  // (frameId 0). Dropping the last entry makes the direct target the top.
  if (!self || frameAncestors.length < 2) return null;
  const chain = frameAncestors.slice(0, -1);
  const ancestors = [];
  let inherited = null;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    let candidate = String(chain[index]?.url || "");
    if (/^about:(?:blank|srcdoc)$/i.test(candidate) && inherited) {
      // Initial about:blank / srcdoc documents inherit their creator's origin.
      candidate = inherited;
    }
    const parts = embeddingUrlParts(candidate);
    if (!parts) return null;
    inherited = candidate;
    ancestors.push(parts);
  }
  return {
    allowsSameOrigin: ancestors.every((ancestor) =>
      sameEmbeddingOrigin(ancestor, self)
    ),
    frameAncestorsAllow: (sources) =>
      ancestors.every((ancestor) =>
        sources.some((source) =>
          cspSourceMatchesAncestor(source, ancestor, self)
        )
      ),
  };
}

// Only a plain SAMEORIGIN that the simulated chain already satisfies may be
// removed from a descendant response; DENY, ALLOW-FROM, invalid and repeated
// values always stay untouched.
function descendantFrameOptionsRemovable(value, simulation) {
  return (
    !!simulation?.allowsSameOrigin &&
    /^\s*sameorigin\s*$/i.test(String(value || ""))
  );
}

function directResponseFailure(details, headers) {
  const statusCode = Number(details && details.statusCode);
  const challenge = (headers || []).some(
    (header) =>
      String(header.name || "").toLowerCase() === "cf-mitigated" &&
      String(header.value || "").toLowerCase().includes("challenge")
  );
  if (
    challenge ||
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 407 ||
    statusCode === 429 ||
    statusCode === 451
  ) {
    return {
      reason: challenge ? "browser-challenge" : "http-status",
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      compatibility: true,
    };
  }
  if (Number.isFinite(statusCode) && statusCode >= 500) {
    return {
      reason: "http-status",
      statusCode,
      compatibility: false,
    };
  }
  return null;
}

function previewTreeRequestSession(details) {
  if (
    !details ||
    !Number.isInteger(details.tabId) ||
    !Number.isInteger(details.frameId) ||
    details.frameId <= 0
  ) {
    return null;
  }

  const directSession = sessionsByDirectTargetFrame.get(
    directTargetKey(details.tabId, details.frameId)
  );
  if (
    directSession &&
    !directSession.destroyed &&
    directSession.directTargetFrameId === details.frameId &&
    details.parentFrameId === 0 &&
    details.parentDocumentId === directSession.ownerDocumentId
  ) {
    return directSession;
  }

  const ancestors = Array.isArray(details.frameAncestors)
    ? details.frameAncestors
    : [];
  if (ancestors.length < 2) return null;
  const immediateParent = ancestors[0];
  const topAncestor = ancestors[ancestors.length - 1];
  if (
    !immediateParent ||
    immediateParent.frameId !== details.parentFrameId ||
    !topAncestor ||
    topAncestor.frameId !== 0
  ) {
    return null;
  }
  const session = targetTreeSession(details.tabId, details.frameId);
  if (
    !session ||
    session.destroyed ||
    session.tabId !== details.tabId ||
    typeof session.targetDocumentId !== "string" ||
    !session.targetDocumentId ||
    session.targetTreeDocumentIds?.get(session.directTargetFrameId) !==
      session.targetDocumentId ||
    session.targetTreeDocumentIds?.get(0) !== session.ownerDocumentId ||
    session.targetTreeDocumentIds?.get(details.parentFrameId) !==
      details.parentDocumentId
  ) {
    return null;
  }

  let childFrameId = details.frameId;
  for (const ancestor of ancestors) {
    const expectedParentFrameId =
      childFrameId === session.directTargetFrameId
        ? 0
        : session.targetTreeParents?.get(childFrameId);
    if (
      !Number.isInteger(expectedParentFrameId) ||
      !ancestor ||
      ancestor.frameId !== expectedParentFrameId
    ) {
      return null;
    }
    childFrameId = expectedParentFrameId;
  }
  if (childFrameId !== 0) return null;

  return session;
}

function responseHasEmbeddingProtection(headers) {
  return (headers || []).some((header) => {
    const name = String(header.name || "").toLowerCase();
    if (name === "x-frame-options" || name === "frame-options") return true;
    return (
      (name === "content-security-policy" ||
        name === "content-security-policy-report-only") &&
      /(^|[;,])\s*frame-ancestors(?:\s|[;,]|$)/i.test(
        String(header.value || "")
      )
    );
  });
}

function blockDirectPreviewRequest(
  session,
  url,
  reason,
  message,
  compatibility = false
) {
  if (!session || session.destroyed) return;
  session.currentUrl = url || session.currentUrl;
  recordFailedNavigation(session, session.currentUrl);
  session.blockedRequest = {
    url: session.currentUrl,
    reason,
    generation: session.navigationGeneration,
    at: Date.now(),
  };
  session.compatRequired = compatibility
    ? { reason, url: session.currentUrl }
    : null;
  session.state = compatibility ? "compat-required" : "error";
  pushNavigation(
    session,
    session.state,
    session.currentUrl,
    message,
    {
      blocked: true,
      newDocument: true,
      compatRequired: compatibility,
      compatReason: reason,
    }
  );
}

async function previewCompatibilityRequest(details) {
  const session = previewTreeRequestSession(details);
  if (!session || session.destroyed) return undefined;
  const url = GP.normalizeUrl(details.url);
  const isDirectTarget = session.directTargetFrameId === details.frameId;
  if (!url || !previewTargetAllowed(url, session.settings)) {
    if (isDirectTarget) {
      blockDirectPreviewRequest(
        session,
        session.currentUrl,
        "unsafe-url",
        "Navigation left the safe public HTTP(S) preview boundary"
      );
    }
    return { cancel: true };
  }

  if (isDirectTarget && forcedCompatibilityHostname(url, session.settings)) {
    blockDirectPreviewRequest(
      session,
      url,
      "remembered-domain",
      null,
      true
    );
    void routeRequiredCompatibility(session, {
      reason: "remembered-domain",
      url,
    });
    return { cancel: true };
  }

  const status = await publicResolvedUrl(url);
  if (!session || session.destroyed) return { cancel: true };
  if (status === "private") {
    if (isDirectTarget) {
      blockDirectPreviewRequest(
        session,
        url,
        "private-network",
        "The target resolves to a local or private-network address"
      );
    }
    return { cancel: true };
  }
  if (
    isDirectTarget &&
    session.blockedRequest?.url === url
  ) {
    session.blockedRequest = null;
  }
  return undefined;
}

browser.webRequest.onBeforeRequest.addListener(
  previewCompatibilityRequest,
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["sub_frame"],
  },
  ["blocking"]
);

async function previewCompatibilityHeaders(details) {
  if (!details || !Number.isInteger(details.tabId) || details.frameId <= 0) {
    return undefined;
  }
  const session = previewTreeRequestSession(details);
  const url = GP.normalizeUrl(details.url);
  if (
    !session ||
    session.destroyed ||
    session.tabId !== details.tabId ||
    !url ||
    !previewTargetAllowed(url, session.settings)
  ) {
    return undefined;
  }

  const isDirectTarget = session.directTargetFrameId === details.frameId;
  const origin = await verifiedResponseOrigin(details, url);
  if (origin.hardPrivatePeer) {
    if (isDirectTarget) {
      blockDirectPreviewRequest(
        session,
        url,
        "private-network",
        "The actual server address is local or private-network"
      );
    }
    return { cancel: true };
  }
  if (!origin.verified && responseHasEmbeddingProtection(details.responseHeaders)) {
    // Keep every protection byte-for-byte when the destination cannot be tied
    // to a verified public endpoint. Firefox can still allow an already-safe
    // SAMEORIGIN/'self' response because the direct target is a sibling of the
    // control frame under the original site. Truly incompatible protections
    // remain enforced by Firefox and settle through the normal timeout/error
    // path instead of being rejected pre-emptively.
    return undefined;
  }
  if (isDirectTarget) {
    const failure = directResponseFailure(details, details.responseHeaders);
    session.directResponseFailure = failure
      ? { ...failure, url, at: Date.now() }
      : null;
    if (failure) {
      session.compatRequired = failure.compatibility
        ? { ...failure, url }
        : null;
      session.state = failure.compatibility ? "compat-required" : "error";
      pushNavigation(
        session,
        session.state,
        session.currentUrl || url,
        failure.compatibility
          ? `Embedded response requires a top-level Firefox window${
              failure.statusCode ? ` (HTTP ${failure.statusCode})` : ""
            }`
          : `Embedded request failed with HTTP ${failure.statusCode}`,
        {
          blocked: true,
          httpStatus: failure.statusCode,
          compatRequired: failure.compatibility,
          compatReason: failure.reason,
        }
      );
    } else if (
      session.compatRequired &&
      (session.compatRequired.reason === "http-status" ||
        session.compatRequired.reason === "browser-challenge")
    ) {
      session.compatRequired = null;
    }
  }

  // Embedding relaxation is unconditional only for the direct target, which
  // GlassPeek itself embeds. Descendant frames were created by the previewed
  // page: they keep every protection the response would have enforced with
  // the direct target as a real top-level document.
  const simulation = isDirectTarget
    ? null
    : descendantEmbeddingSimulation(details, url);
  if (!isDirectTarget && !simulation) return undefined;

  let changed = false;
  const responseHeaders = [];
  for (const header of details.responseHeaders || []) {
    const name = String(header.name || "").toLowerCase();
    if (name === "x-frame-options" || name === "frame-options") {
      if (
        isDirectTarget ||
        descendantFrameOptionsRemovable(header.value, simulation)
      ) {
        changed = true;
        continue;
      }
      responseHeaders.push(header);
      continue;
    }
    if (
      name === "content-security-policy" ||
      name === "content-security-policy-report-only"
    ) {
      const original = String(header.value || "");
      const value = isDirectTarget
        ? stripFrameAncestors(original)
        : stripFrameAncestors(original, simulation.frameAncestorsAllow);
      if (value !== original) {
        changed = true;
        if (value) responseHeaders.push({ ...header, value });
        continue;
      }
    }
    responseHeaders.push(header);
  }
  return changed ? { responseHeaders } : undefined;
}

browser.webRequest.onHeadersReceived.addListener(
  previewCompatibilityHeaders,
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["sub_frame"],
  },
  ["blocking", "responseHeaders"]
);

function sidebarSurfaceForRequest(details) {
  if (
    !details ||
    typeof details.parentDocumentId !== "string" ||
    !details.parentDocumentId
  ) {
    return null;
  }
  const surface = sidebarSurfacesByDocument.get(details.parentDocumentId);
  return surface || null;
}

function sidebarRequestSurface(details, create = true) {
  const requestId =
    details && typeof details.requestId === "string" && details.requestId
      ? details.requestId
      : null;
  if (requestId) {
    const existing = sidebarRequestsById.get(requestId);
    if (existing) {
      if (
        existing.tabId !== details.tabId ||
        existing.frameId !== details.frameId ||
        existing.parentDocumentId !== details.parentDocumentId
      ) {
        return { denied: true };
      }
      return existing;
    }
  }
  if (!create) {
    return sidebarArmIdsByDocument.has(details?.parentDocumentId)
      ? { denied: true }
      : null;
  }
  const surface = sidebarSurfaceForRequest(details);
  if (!surface) {
    return sidebarArmIdsByDocument.has(details?.parentDocumentId)
      ? { denied: true }
      : null;
  }
  const requestSurface = {
    documentId: surface.documentId,
    generation: surface.generation,
    tabId: details.tabId,
    frameId: details.frameId,
    parentDocumentId: details.parentDocumentId,
    verifiedUrl: null,
  };
  if (requestId) sidebarRequestsById.set(requestId, requestSurface);
  return requestSurface;
}

function sidebarSurfaceGenerationIsCurrent(surface) {
  if (!surface || typeof surface.documentId !== "string") return false;
  const current = sidebarSurfacesByDocument.get(surface.documentId);
  return !!(
    current &&
    current.generation === surface.generation
  );
}

function notifySidebarBlocked(surface, url, reason) {
  if (!surface) return;
  browser.runtime
    .sendMessage({
      type: "gp-sidebar-blocked",
      documentId: surface.documentId,
      generation: surface.generation,
      url,
      reason,
    })
    .catch(() => {});
}

async function sidebarCompatibilityRequest(details) {
  const surface = sidebarRequestSurface(details);
  if (!surface) return undefined;
  if (surface.denied) return { cancel: true };
  const url = GP.normalizeUrl(details.url);
  if (!url || !previewTargetAllowed(url)) {
    notifySidebarBlocked(surface, url || surface.url, "unsafe-url");
    return { cancel: true };
  }
  const status = await publicResolvedUrl(url);
  if (!sidebarSurfaceGenerationIsCurrent(surface)) return { cancel: true };
  if (status === "private") {
    notifySidebarBlocked(
      surface,
      url,
      "private-network"
    );
    return { cancel: true };
  }
  surface.verifiedUrl = url;
  return undefined;
}

browser.webRequest.onBeforeRequest.addListener(
  sidebarCompatibilityRequest,
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["sub_frame"],
  },
  ["blocking"]
);

async function sidebarCompatibilityHeaders(details) {
  const surface = sidebarRequestSurface(details, false);
  if (!surface) return undefined;
  if (surface.denied) return { cancel: true };
  const url = GP.normalizeUrl(details.url);
  if (
    !url ||
    !previewTargetAllowed(url) ||
    !sidebarSurfaceGenerationIsCurrent(surface) ||
    surface.verifiedUrl !== url
  ) {
    return { cancel: true };
  }
  const origin = await verifiedResponseOrigin(details, url);
  if (origin.hardPrivatePeer) {
    notifySidebarBlocked(
      surface,
      url,
      "private-network"
    );
    return { cancel: true };
  }
  if (!origin.verified && responseHasEmbeddingProtection(details.responseHeaders)) {
    notifySidebarBlocked(surface, url, "address-unverified");
    return undefined;
  }

  let changed = false;
  const responseHeaders = [];
  for (const header of details.responseHeaders || []) {
    const name = String(header.name || "").toLowerCase();
    if (name === "x-frame-options" || name === "frame-options") {
      changed = true;
      continue;
    }
    if (
      name === "content-security-policy" ||
      name === "content-security-policy-report-only"
    ) {
      const original = String(header.value || "");
      const value = stripFrameAncestors(original);
      if (value !== original) {
        changed = true;
        if (value) responseHeaders.push({ ...header, value });
        continue;
      }
    }
    responseHeaders.push(header);
  }
  return changed ? { responseHeaders } : undefined;
}

browser.webRequest.onHeadersReceived.addListener(
  sidebarCompatibilityHeaders,
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["sub_frame"],
  },
  ["blocking", "responseHeaders"]
);

function cleanupSidebarRequest(details) {
  if (details && typeof details.requestId === "string") {
    sidebarRequestsById.delete(details.requestId);
  }
}

browser.webRequest.onCompleted.addListener(cleanupSidebarRequest, {
  urls: ["http://*/*", "https://*/*"],
  types: ["sub_frame"],
});
browser.webRequest.onErrorOccurred.addListener(cleanupSidebarRequest, {
  urls: ["http://*/*", "https://*/*"],
  types: ["sub_frame"],
});

function destroySession(session, reason = "closed", disconnectSurface = true) {
  if (!session || session.destroyed) return;
  session.destroyed = true;
  session.state = "closed";
  session.secret = null;
  session.targetSecret = null;
  clearTimeout(session.grantTimer);
  clearTimeout(session.targetGrantTimer);
  clearTimeout(session.pendingNavigationTimer);
  clearTimeout(session.pendingNavigationFallbackTimer);
  clearTimeout(session.pendingBrowserHistoryTimer);

  sessions.delete(session.id);
  if (session.surfaceDocumentId) {
    sessionsBySurfaceDocument.delete(session.surfaceDocumentId);
  }
  if (session.targetDocumentId) {
    targetContextsByDocument.delete(session.targetDocumentId);
  }
  if (Number.isInteger(session.directTargetFrameId)) {
    sessionsByDirectTargetFrame.delete(
      directTargetKey(session.tabId, session.directTargetFrameId)
    );
  }
  clearTargetTreeFrames(session, false);
  if (session.owner) {
    session.owner.sessions.delete(session.id);
    if (session.owner.activeSessionId === session.id) {
      session.owner.activeSessionId = null;
    }
  }

  if (session.surfacePort) {
    safePost(session.surfacePort, {
      type: "closed",
      sessionId: session.id,
      reason,
    });
    if (disconnectSurface) {
      try {
        session.surfacePort.disconnect();
      } catch (_error) {}
    }
  }

  if (session.targetPort) {
    try {
      session.targetPort.disconnect();
    } catch (_error) {}
  }
  for (const context of session.descendantTargetPorts?.values() || []) {
    targetContextsByDocument.delete(context.documentId);
    try {
      context.port.disconnect();
    } catch (_error) {}
  }
  session.descendantTargetPorts?.clear();

  session.surfacePort = null;
  session.targetPort = null;
}

function destroyOwner(owner, reason = "owner-disconnected", disconnectPort = false) {
  if (!owner || owner.destroyed) return;
  owner.destroyed = true;
  if (owners.get(owner.documentId) === owner) owners.delete(owner.documentId);

  for (const sessionId of [...owner.sessions]) {
    destroySession(sessions.get(sessionId), reason);
  }
  owner.sessions.clear();

  if (disconnectPort) {
    try {
      owner.port.disconnect();
    } catch (_error) {}
  }
}

function cleanupTab(tabId, reason, survivingDocumentId = null) {
  inFlightFrameSnapshots.delete(tabId);
  if (!survivingDocumentId) nativeHistoryLengthByTab.delete(tabId);
  for (const owner of [...owners.values()]) {
    if (
      owner.tabId === tabId &&
      (!survivingDocumentId || owner.documentId !== survivingDocumentId)
    ) {
      destroyOwner(owner, reason, true);
    }
  }
}

function ownerSessionLimit(settings) {
  return settings.multiWindow ? settings.maxWindows : 1;
}

async function handleOwnerCreate(owner, message) {
  await settingsReady;
  if (!owner || owner.destroyed) return;
  const requestId = message.requestId;
  if (!validRequestId(requestId)) {
    ownerError(owner, requestId, "INVALID_REQUEST", "requestId is required");
    return;
  }

  const settings = settingsSnapshot();
  if (!settings.enabled) {
    ownerError(owner, requestId, "DISABLED", "GlassPeek is disabled");
    return;
  }
  if (!siteRuleDecision(owner.url, settings)) {
    ownerError(owner, requestId, "SITE_DISABLED", "GlassPeek is disabled on this site");
    return;
  }

  const url = GP.normalizeUrl(message.url, owner.url);
  if (!url) {
    ownerError(owner, requestId, "INVALID_URL", "Only credential-free HTTP(S) URLs are supported");
    return;
  }
  if (GP.isPrivateHost(url)) {
    ownerError(owner, requestId, "PRIVATE_HOST", "Local and private-network pages require a normal browser window");
    return;
  }
  if (!siteRuleDecision(url, settings)) {
    ownerError(owner, requestId, "TARGET_DISABLED", "GlassPeek is disabled for this target site");
    return;
  }
  const targetUrl = GP.previewTargetUrl(url, owner.url);
  if (!targetUrl || GP.isPrivateHost(targetUrl)) {
    ownerError(owner, requestId, "INVALID_URL", "The preview compatibility route is not a safe public HTTP(S) URL");
    return;
  }
  const resolvedSafety = await publicResolvedUrl(targetUrl);
  if (owner.destroyed) return;
  if (resolvedSafety === "private") {
    ownerError(
      owner,
      requestId,
      "PRIVATE_HOST",
      "The target resolves to a local or private-network address"
    );
    return;
  }
  if (forcedCompatibilityHostname(url, settings)) {
    try {
      const result = await openCompatibilityUrl({
        url,
        sourceWindowId: owner.windowId,
        openerTabId: owner.tabId,
        incognito: !!owner.incognito,
        width: Math.min(1800, Math.max(720, Number(settings.widthPx) || 1000)),
        height: Math.min(1200, Math.max(520, Number(settings.heightPx) || 700)),
      });
      if (!owner.destroyed) {
        safePost(owner.port, {
          type: "compat-routed",
          requestId,
          url,
          result,
        });
      }
    } catch (error) {
      if (!owner.destroyed) {
        const failure = safeError(error, "COMPAT_FAILED");
        ownerError(owner, requestId, failure.code, failure.message);
      }
    }
    return;
  }
  if (owner.sessions.size >= ownerSessionLimit(settings)) {
    ownerError(owner, requestId, "MAX_WINDOWS", "The preview window limit has been reached");
    return;
  }

  const sessionId = randomHex(16);
  const secret = randomHex(32);
  const targetSecret = randomHex(32);
  const session = {
    id: sessionId,
    owner,
    ownerDocumentId: owner.documentId,
    tabId: owner.tabId,
    windowId: owner.windowId,
    incognito: owner.incognito,
    requestedUrl: url,
    currentUrl: url,
    navigationTargetUrl: targetUrl,
    currentTitle: "",
    settings,
    requestId,
    secret,
    targetSecret,
    state: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + GRANT_TTL_MS,
    targetExpiresAt: Date.now() + TARGET_BOOTSTRAP_TTL_MS,
    lastActiveAt: Date.now(),
    lastNavigationAt: 0,
    committedDocumentId: null,
    navigationGeneration: 0,
    navigationHistory: [{ url, title: "" }],
    historyIndex: 0,
    pendingNavigation: null,
    pendingNavigationTimer: 0,
    pendingNavigationFallbackTimer: 0,
    pendingHistoryReconcile: null,
    pendingRootNavigation: null,
    activeNavigation: null,
    nativeHistoryLength: null,
    pendingBrowserHistoryEvent: null,
    pendingBrowserHistoryTimer: 0,
    lastHistorySignal: null,
    lastBrowserHistoryEvent: null,
    suppressNavigationUntil: 0,
    compatRequired: null,
    compatOpenedUrl: null,
    compatOpenedAt: 0,
    compatOpenPromise: null,
    recordedHistory: new Map(),
    targetDocumentId: null,
    targetFrameId: null,
    surfaceDocumentId: null,
    surfaceFrameId: null,
    surfacePort: null,
    targetPort: null,
    descendantTargetPorts: new Map(),
    directTargetFrameId: null,
    directTargetBootstrapDocumentId: null,
    targetTreeFrameIds: new Set(),
    targetTreeParents: new Map(),
    targetTreeDocumentIds: new Map([[0, owner.documentId]]),
    directResponseFailure: null,
    blockedRequest: null,
    destroyed: false,
    grantTimer: 0,
    targetGrantTimer: 0,
  };

  sessions.set(sessionId, session);
  owner.sessions.add(sessionId);
  owner.activeSessionId = sessionId;
  session.grantTimer = setTimeout(() => {
    if (!session.destroyed && session.state === "pending") {
      destroySession(session, "grant-expired", false);
      ownerError(
        owner,
        requestId,
        "GRANT_EXPIRED",
        "The preview authorization expired before it was bound"
      );
    }
  }, GRANT_TTL_MS);
  session.targetGrantTimer = setTimeout(() => {
    if (!session.destroyed) session.targetSecret = null;
  }, TARGET_BOOTSTRAP_TTL_MS);

  safePost(owner.port, {
    type: "grant",
    requestId,
    sessionId,
    secret,
    targetSecret,
  });
}

function handleOwnerMessage(owner, message) {
  if (!message || typeof message.type !== "string" || owner.destroyed) return;

  if (message.type === "create") {
    void handleOwnerCreate(owner, message);
    return;
  }

  if (message.type === "close") {
    const session = sessions.get(message.sessionId);
    if (session && session.owner === owner) destroySession(session, "owner-closed");
    return;
  }

  if (message.type === "activate") {
    const session = sessions.get(message.sessionId);
    if (session && session.owner === owner && !session.destroyed) {
      owner.activeSessionId = session.id;
      session.lastActiveAt = Date.now();
    }
  }
}

function acceptOwnerPort(port) {
  const sender = port.sender || {};
  const ownerUrl = GP.normalizeUrl(sender.url);
  if (
    !sender.tab ||
    sender.frameId !== 0 ||
    typeof sender.documentId !== "string" ||
    !sender.documentId ||
    !ownerUrl
  ) {
    try {
      port.disconnect();
    } catch (_error) {}
    return;
  }

  const existing = owners.get(sender.documentId);
  if (existing) destroyOwner(existing, "owner-replaced", true);

  const owner = {
    documentId: sender.documentId,
    tabId: sender.tab.id,
    windowId: sender.tab.windowId,
    incognito: !!sender.tab.incognito,
    url: ownerUrl,
    port,
    sessions: new Set(),
    activeSessionId: null,
    connectedAt: Date.now(),
    destroyed: false,
  };
  owners.set(owner.documentId, owner);

  port.onMessage.addListener((message) => handleOwnerMessage(owner, message));
  port.onDisconnect.addListener(() => {
    if (owners.get(owner.documentId) === owner) {
      destroyOwner(owner, "owner-disconnected");
    }
  });
}

function failSurface(context, code, message) {
  clearTimeout(context.bindTimer);
  provisionalSurfaces.delete(context);
  safePost(context.port, { type: "error", code, message });
  try {
    context.port.disconnect();
  } catch (_error) {}
}

async function bindSurface(context, message) {
  if (context.bound || context.binding) {
    failSurface(context, "ALREADY_BOUND", "The preview surface is already bound");
    return;
  }
  context.binding = true;

  const session = sessions.get(message && message.sessionId);
  if (
    !session ||
    session.destroyed ||
    session.state !== "pending" ||
    typeof message.secret !== "string" ||
    message.secret !== session.secret ||
    Date.now() > session.expiresAt
  ) {
    failSurface(context, "INVALID_GRANT", "The preview authorization is invalid or expired");
    return;
  }
  if (session.tabId !== context.tabId || session.owner.destroyed) {
    failSurface(context, "WRONG_TAB", "The preview authorization belongs to another tab");
    return;
  }

  let frame;
  try {
    frame = await browser.webNavigation.getFrame({
      tabId: context.tabId,
      documentId: context.documentId,
    });
  } catch (_error) {
    frame = null;
  }

  // The session may have been destroyed (settings change, owner close,
  // grant expiry) while we were awaiting getFrame.
  if (session.destroyed || session.state !== "pending") {
    failSurface(context, "SESSION_GONE", "The preview session ended before binding completed");
    return;
  }

  if (
    !frame ||
    frame.documentId !== context.documentId ||
    frame.parentDocumentId !== session.ownerDocumentId ||
    frame.url !== PREVIEW_URL
  ) {
    failSurface(context, "WRONG_PARENT", "The preview surface is not owned by the authorized document");
    return;
  }

  const currentSettings = settingsSnapshot();
  if (
    !currentSettings.enabled ||
    !siteRuleDecision(session.owner.url, currentSettings) ||
    !previewTargetAllowed(session.currentUrl, currentSettings)
  ) {
    failSurface(context, "DISABLED", "GlassPeek or this site was disabled before binding completed");
    destroySession(session, "disabled-before-bind", false);
    return;
  }

  clearTimeout(session.grantTimer);
  clearTimeout(context.bindTimer);
  provisionalSurfaces.delete(context);
  session.secret = null;
  session.settings = currentSettings;
  session.compatRequired = null;
  session.state = "bound";
  session.surfacePort = context.port;
  session.surfaceDocumentId = context.documentId;
  session.surfaceFrameId = context.frameId;
  context.bound = true;
  context.binding = false;
  context.session = session;
  sessionsBySurfaceDocument.set(context.documentId, session);

  safePost(context.port, {
    type: "bound",
    sessionId: session.id,
    url: session.currentUrl,
    sourceUrl: session.owner.url,
    targetUrl:
      session.navigationTargetUrl ||
      GP.previewTargetUrl(session.currentUrl, session.owner.url) ||
      session.currentUrl,
    title: session.currentTitle,
    history: historySnapshot(session),
    directTarget: true,
    compatRequired: false,
    compatReason: null,
    settings: settingsSnapshot(),
  });
}

function setSidebarState(
  windowId,
  url,
  sessionId = null,
  tabId = null,
  notify = true
) {
  if (!Number.isInteger(windowId) || windowId < 0) {
    throw codedError("INVALID_WINDOW", "A valid Firefox window is required");
  }
  const normalized = GP.normalizeUrl(url);
  if (!normalized || !previewTargetAllowed(normalized)) {
    throw codedError("INVALID_URL", "The sidebar only accepts enabled public HTTP(S) URLs");
  }
  const state = {
    url: normalized,
    updatedAt: Date.now(),
    sessionId: sessionId || null,
    tabId: Number.isInteger(tabId) ? tabId : null,
    windowId,
  };
  sidebarByWindow.set(windowId, state);
  if (state.tabId != null) sidebarByTab.set(state.tabId, state);
  if (notify) {
    browser.runtime
      .sendMessage({
        type: "gp-sidebar-state",
        windowId,
        state: { ...state },
      })
      .catch(() => {});
  }
  return { ...state };
}

function postSurfaceResult(session, requestId, result) {
  if (!session || !session.surfacePort) return;
  safePost(session.surfacePort, { type: "result", requestId, ...result });
}

async function openSessionTab(session, background = false) {
  const url = GP.normalizeUrl(session.currentUrl);
  if (!url || !previewTargetAllowed(url)) {
    throw codedError("INVALID_URL", "The current preview URL is invalid");
  }
  if ((await publicResolvedUrl(url)) === "private") {
    throw codedError(
      "PRIVATE_HOST",
      "The target resolves to a local or private-network address"
    );
  }
  const tab = await browser.tabs.create({
    url,
    active: !background,
    windowId: session.owner.windowId,
    openerTabId: session.owner.tabId,
  });
  return { tabId: tab.id, windowId: tab.windowId, url };
}

async function openSessionSidebar(session) {
  if ((await publicResolvedUrl(session.currentUrl)) === "private") {
    throw codedError(
      "PRIVATE_HOST",
      "The target resolves to a local or private-network address"
    );
  }
  const state = setSidebarState(
    session.owner.windowId,
    session.currentUrl,
    session.id,
    session.owner.tabId
  );
  await browser.sidebarAction.open();
  return { windowId: session.owner.windowId, url: state.url };
}

async function openCompatibilityWindow(session) {
  const url = GP.normalizeUrl(session.currentUrl);
  if (!url) throw codedError("INVALID_URL", "The current preview URL is invalid");

  const width = Math.min(1800, Math.max(720, Number(session.settings.widthPx) || 1000));
  const height = Math.min(1200, Math.max(520, Number(session.settings.heightPx) || 700));
  return openCompatibilityUrl({
    url,
    sourceWindowId: session.owner.windowId,
    openerTabId: session.owner.tabId,
    incognito: !!session.incognito,
    width,
    height,
  });
}

async function rememberCompatibilityDomain(url) {
  const hostname = normalizedCompatHostname(url);
  if (!hostname) {
    throw codedError("INVALID_DOMAIN", "The full-page site hostname is invalid");
  }
  const nextDomains = normalizeCompatDomains([
    ...(settingsCache.forceCompatDomains || []),
    hostname,
  ]);
  await browser.storage.sync.set({ forceCompatDomains: nextDomains });
  settingsCache = cloneSettings({
    ...settingsCache,
    forceCompatDomains: nextDomains,
  });
  return hostname;
}

async function applyCompatibilityMemory(result, url, requirement) {
  if (!requirement || requirement.rememberDomain !== true) return result;
  try {
    result.rememberedDomain = await rememberCompatibilityDomain(url);
  } catch (error) {
    // The top-level page is already open. A sync-storage failure must not turn
    // that success into a second fallback tab or a memory-only false setting.
    result.rememberFailed = true;
    result.rememberError = safeError(error, "REMEMBER_FAILED").code;
  }
  return result;
}

async function routeRequiredCompatibility(session, requirement) {
  if (!session || session.destroyed) {
    throw codedError("SESSION_CLOSED", "The preview session is closed");
  }
  const url = GP.normalizeUrl(session.currentUrl);
  if (!url) throw codedError("INVALID_URL", "The compatibility URL is invalid");

  session.compatRequired = requirement || null;
  if (session.compatOpenPromise) return session.compatOpenPromise;
  if (
    session.compatOpenedUrl === url &&
    Date.now() - session.compatOpenedAt < HISTORY_DEDUPE_MS
  ) {
    return applyCompatibilityMemory(
      { url, compatibility: true, reused: true, deduplicated: true },
      url,
      requirement
    );
  }

  session.compatOpenedUrl = url;
  session.compatOpenedAt = Date.now();
  session.compatOpenPromise = openCompatibilityWindow(session)
    .then(async (result) => {
      await applyCompatibilityMemory(result, url, requirement);
      if (!session.destroyed && session.surfacePort) {
        safePost(session.surfacePort, {
          type: "compat-opened",
          url,
          result,
        });
      }
      return result;
    })
    .catch((error) => {
      session.compatOpenedUrl = null;
      throw error;
    })
    .finally(() => {
      session.compatOpenPromise = null;
    });
  return session.compatOpenPromise;
}

async function maybeRecordPreviewHistory(session, url, title = "") {
  if (
    !session ||
    session.destroyed ||
    session.incognito ||
    session.settings.addPreviewToHistory !== true ||
    !browser.permissions ||
    !browser.history
  ) {
    return;
  }

  const normalized = GP.normalizeUrl(url);
  if (!normalized || !previewTargetAllowed(normalized, session.settings)) return;
  const previous = session.recordedHistory.get(normalized) || 0;
  if (Date.now() - previous < HISTORY_DEDUPE_MS) return;

  if (session.destroyed) return;

  try {
    await browser.history.addUrl({
      url: normalized,
      title: String(title || new URL(normalized).hostname).slice(0, 240),
      transition: "link",
      visitTime: Date.now(),
    });
    session.recordedHistory.set(normalized, Date.now());
    for (const [recordedUrl, recordedAt] of session.recordedHistory) {
      if (Date.now() - recordedAt >= HISTORY_DEDUPE_MS) {
        session.recordedHistory.delete(recordedUrl);
      }
    }
  } catch (_error) {
    // History integration must never break preview navigation.
  }
}

async function openCompatibilityUrlNow({
  url,
  sourceWindowId,
  openerTabId,
  incognito = false,
  width = 1000,
  height = 700,
}) {
  const normalized = GP.normalizeUrl(url);
  if (!normalized || !previewTargetAllowed(normalized)) {
    throw codedError("INVALID_URL", "The original-page window requires an enabled public HTTP(S) URL");
  }
  if ((await publicResolvedUrl(normalized)) === "private") {
    throw codedError(
      "PRIVATE_HOST",
      "The target resolves to a local or private-network address"
    );
  }
  const existingId = compatibilityBySourceWindow.get(sourceWindowId);
  if (Number.isInteger(existingId)) {
    try {
      const existing = await browser.windows.get(existingId, { populate: true });
      const tab = existing.tabs && existing.tabs[0];
      if (tab) await browser.tabs.update(tab.id, { url: normalized, active: true });
      await browser.windows.update(existingId, { focused: true });
      return { windowId: existingId, url: normalized, compatibility: true, reused: true };
    } catch (_error) {
      compatibilityBySourceWindow.delete(sourceWindowId);
    }
  }

  try {
    const createOptions = {
      url: normalized,
      type: "popup",
      focused: true,
      incognito,
      width,
      height,
    };
    try {
      const sourceWindow = await browser.windows.get(sourceWindowId);
      if (
        Number.isFinite(sourceWindow.left) &&
        Number.isFinite(sourceWindow.top) &&
        Number.isFinite(sourceWindow.width) &&
        Number.isFinite(sourceWindow.height)
      ) {
        createOptions.left = Math.round(
          sourceWindow.left + Math.max(0, (sourceWindow.width - width) / 2)
        );
        createOptions.top = Math.round(
          sourceWindow.top + Math.max(0, (sourceWindow.height - height) / 2)
        );
      }
    } catch (_error) {
      // Firefox will choose a safe visible position when the source window
      // geometry is unavailable.
    }
    const created = await browser.windows.create(createOptions);
    compatibilityBySourceWindow.set(sourceWindowId, created.id);
    return { windowId: created.id, url: normalized, compatibility: true, reused: false };
  } catch (_error) {
    const tab = await browser.tabs.create({
      url: normalized,
      active: true,
      windowId: sourceWindowId,
      ...(Number.isInteger(openerTabId) ? { openerTabId } : {}),
    });
    return { tabId: tab.id, windowId: tab.windowId, url: normalized, compatibility: false, fallback: "tab" };
  }
}

function openCompatibilityUrl(options) {
  const sourceWindowId = options && options.sourceWindowId;
  if (!Number.isInteger(sourceWindowId)) {
    return Promise.reject(
      codedError("INVALID_WINDOW", "The compatibility source window is invalid")
    );
  }

  const previous =
    compatibilityOpenQueueBySourceWindow.get(sourceWindowId) ||
    Promise.resolve();
  const queued = previous
    .catch(() => {})
    .then(() => openCompatibilityUrlNow(options));
  compatibilityOpenQueueBySourceWindow.set(sourceWindowId, queued);
  return queued.finally(() => {
    if (compatibilityOpenQueueBySourceWindow.get(sourceWindowId) === queued) {
      compatibilityOpenQueueBySourceWindow.delete(sourceWindowId);
    }
  });
}

function historySnapshot(session) {
  const entries = Array.isArray(session.navigationHistory)
    ? session.navigationHistory
    : [];
  const index = Number.isInteger(session.historyIndex)
    ? session.historyIndex
    : 0;
  return {
    canGoBack: index > 0,
    canGoForward: index >= 0 && index < entries.length - 1,
    index,
    length: entries.length,
  };
}

function currentHistoryEntry(session) {
  if (
    !Array.isArray(session.navigationHistory) ||
    !Number.isInteger(session.historyIndex)
  ) {
    return null;
  }
  return session.navigationHistory[session.historyIndex] || null;
}

function updateCurrentHistoryEntry(session, url, title = null) {
  const entry = currentHistoryEntry(session);
  if (!entry) return;
  if (url) entry.url = url;
  if (typeof title === "string") entry.title = title.slice(0, 240);
}

function appendHistoryEntry(session, url, title = "") {
  const entries = session.navigationHistory;
  entries.splice(session.historyIndex + 1);
  entries.push({ url, title: String(title || "").slice(0, 240) });
  if (entries.length > NAVIGATION_HISTORY_LIMIT) {
    const excess = entries.length - NAVIGATION_HISTORY_LIMIT;
    entries.splice(0, excess);
  }
  session.historyIndex = entries.length - 1;
}

function clearPendingNavigation(session, restore = false) {
  const pending = session.pendingNavigation;
  if (!pending) return null;
  clearTimeout(session.pendingNavigationTimer);
  clearTimeout(session.pendingNavigationFallbackTimer);
  session.pendingNavigationTimer = 0;
  session.pendingNavigationFallbackTimer = 0;
  cancelSurfaceNavigationFallback(session, pending);
  session.pendingNavigation = null;
  if (restore) {
    session.historyIndex = Math.min(
      Math.max(0, pending.previousIndex),
      session.navigationHistory.length - 1
    );
    session.currentUrl = pending.previousUrl;
    session.currentTitle = pending.previousTitle;
  }
  return pending;
}

function cancelSurfaceNavigationFallback(session, pending, navigationStarted = false) {
  if (!session || !pending) return;
  clearTimeout(session.pendingNavigationFallbackTimer);
  session.pendingNavigationFallbackTimer = 0;
  if (navigationStarted) pending.navigationStarted = true;
  if (
    !session.surfacePort ||
    typeof pending.navigationToken !== "string" ||
    !pending.navigationToken
  ) {
    return;
  }
  safePost(session.surfacePort, {
    type: "target-fallback-cancel",
    navigationToken: pending.navigationToken,
    generation: pending.generation,
  });
}

function rollbackPendingNavigation(session, status = "completed") {
  const pending = clearPendingNavigation(session, true);
  if (!pending || session.destroyed) return pending;
  session.state = status;
  pushNavigation(session, status, session.currentUrl, null, {
    generation: session.navigationGeneration,
    navigationCancelled: true,
    cancelledAction: pending.kind,
  });
  relayTargetSignal(session, "alive", {
    url: session.currentUrl,
    title: session.currentTitle,
    history: historySnapshot(session),
  });
  return pending;
}

function failPendingNavigation(session, message = "Preview navigation timed out") {
  const pending = clearPendingNavigation(session, false);
  if (!pending || session.destroyed) return pending;
  session.historyIndex = Math.min(
    Math.max(0, pending.index),
    session.navigationHistory.length - 1
  );
  session.currentUrl = pending.expectedUrl;
  const entry = currentHistoryEntry(session);
  session.currentTitle = entry?.title || "";
  session.state = "error";
  pushNavigation(session, "error", session.currentUrl, message, {
    generation: session.navigationGeneration,
    navigationTimedOut: true,
    failedAction: pending.kind,
  });
  return pending;
}

function validHistoryLength(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function observeNativeHistoryLength(session, value) {
  const length = validHistoryLength(value);
  if (length === null || !session) return null;
  const previous = validHistoryLength(
    nativeHistoryLengthByTab.get(session.tabId)
  );
  nativeHistoryLengthByTab.set(session.tabId, length);
  session.nativeHistoryLength = length;
  return { length, previous };
}

function reconcileCommittedHistory(
  session,
  url,
  documentId,
  historyLength,
  navigationType
) {
  const pending = session.pendingHistoryReconcile;
  if (!pending || pending.documentId !== documentId || pending.url !== url) {
    observeNativeHistoryLength(session, historyLength);
    return;
  }

  const length = validHistoryLength(historyLength);
  const previousLength = validHistoryLength(pending.previousHistoryLength);
  const type = String(navigationType || "").toLowerCase();
  if (type === "reload") {
    updateCurrentHistoryEntry(session, url, session.currentTitle);
  } else if (type === "back_forward") {
    recordSameDocumentHistory(session, url);
  } else if (previousLength !== null && length !== null && length > previousLength) {
    session.historyIndex = pending.previousIndex;
    appendHistoryEntry(session, url, session.currentTitle);
  } else if (previousLength !== null && length !== null && length === previousLength) {
    // A same-length cross-document transition is a replacement. Keep any
    // forward entries: location.replace() replaces the selected entry rather
    // than inventing a new extension-history visit.
    session.historyIndex = pending.previousIndex;
    updateCurrentHistoryEntry(session, url, session.currentTitle);
  } else if (
    previousLength !== null &&
    length !== null &&
    length < previousLength
  ) {
    session.historyIndex = pending.previousIndex;
    recordSameDocumentHistory(session, url);
  } else {
    session.historyIndex = pending.previousIndex;
    const current = currentHistoryEntry(session);
    if (current?.url === url) {
      updateCurrentHistoryEntry(session, url, session.currentTitle);
    } else {
      appendHistoryEntry(session, url, session.currentTitle);
    }
  }

  observeNativeHistoryLength(session, historyLength);
  session.pendingHistoryReconcile = null;
}

function commitHistoryEntry(session, url, documentId, details = {}) {
  const pending = session.pendingNavigation;
  const pendingRoot = session.pendingRootNavigation;
  const previousDocumentId = session.committedDocumentId;

  if (pending && pending.expiresAt >= Date.now()) {
    session.historyIndex = Math.min(
      Math.max(0, pending.index),
      session.navigationHistory.length - 1
    );
    if (pending.expectedUrl !== url) session.currentTitle = "";
    updateCurrentHistoryEntry(session, url, session.currentTitle);
    clearPendingNavigation(session, false);
  } else if (
    pendingRoot &&
    pendingRoot.expiresAt >= Date.now() &&
    pendingRoot.url === url
  ) {
    session.historyIndex = Math.min(
      Math.max(0, pendingRoot.index),
      session.navigationHistory.length - 1
    );
    updateCurrentHistoryEntry(session, url, session.currentTitle);
    session.pendingRootNavigation = null;
  } else if (!previousDocumentId) {
    updateCurrentHistoryEntry(session, url, session.currentTitle);
  } else if (previousDocumentId !== documentId) {
    if (String(details.transitionType || "").toLowerCase() === "reload") {
      updateCurrentHistoryEntry(session, url, session.currentTitle);
    } else {
      session.pendingHistoryReconcile = {
        documentId,
        url,
        previousIndex: session.historyIndex,
        previousHistoryLength:
          session.activeNavigation?.previousHistoryLength ??
          nativeHistoryLengthByTab.get(session.tabId) ??
          session.nativeHistoryLength,
      };
    }
  } else {
    updateCurrentHistoryEntry(session, url, session.currentTitle);
  }

  session.committedDocumentId = documentId;
  if (session.activeNavigation?.url === url) {
    session.activeNavigation.documentId = documentId;
  }
}

function finalizeCommittedHistoryWithoutAlive(session, url, documentId) {
  const pending = session.pendingHistoryReconcile;
  if (
    !pending ||
    pending.documentId !== documentId ||
    pending.url !== url
  ) {
    return;
  }
  session.historyIndex = Math.min(
    Math.max(0, pending.previousIndex),
    session.navigationHistory.length - 1
  );
  const current = currentHistoryEntry(session);
  if (current?.url === url) {
    updateCurrentHistoryEntry(session, url, session.currentTitle);
  } else {
    appendHistoryEntry(session, url, session.currentTitle);
  }
  session.pendingHistoryReconcile = null;
}

function recordFailedNavigation(session, url) {
  const pending = session.pendingNavigation;
  if (pending) {
    session.historyIndex = Math.min(
      Math.max(0, pending.index),
      session.navigationHistory.length - 1
    );
    session.currentUrl = pending.expectedUrl;
    session.currentTitle =
      session.navigationHistory[session.historyIndex]?.title || "";
    clearPendingNavigation(session, false);
  } else if (url) {
    session.currentUrl = url;
    const current = currentHistoryEntry(session);
    if (current?.url !== url) appendHistoryEntry(session, url, "");
  }
  session.pendingRootNavigation = null;
  session.pendingHistoryReconcile = null;
}

function recordSameDocumentHistory(session, url) {
  const entries = session.navigationHistory;
  const index = session.historyIndex;
  const current = entries[index];
  if (current && current.url === url) return;

  if (index > 0 && entries[index - 1]?.url === url) {
    session.historyIndex -= 1;
    return;
  }
  if (index + 1 < entries.length && entries[index + 1]?.url === url) {
    session.historyIndex += 1;
    return;
  }
  appendHistoryEntry(session, url, session.currentTitle);
}

function clearPendingBrowserHistoryEvent(session) {
  clearTimeout(session.pendingBrowserHistoryTimer);
  session.pendingBrowserHistoryTimer = 0;
  const pending = session.pendingBrowserHistoryEvent;
  session.pendingBrowserHistoryEvent = null;
  return pending;
}

function queueBrowserHistoryFallback(session, url, documentId) {
  clearPendingBrowserHistoryEvent(session);
  const pending = {
    url,
    documentId,
    createdAt: Date.now(),
  };
  session.pendingBrowserHistoryEvent = pending;
  session.pendingBrowserHistoryTimer = setTimeout(() => {
    if (
      session.destroyed ||
      session.pendingBrowserHistoryEvent !== pending ||
      session.targetDocumentId !== documentId
    ) {
      return;
    }
    clearPendingBrowserHistoryEvent(session);
    session.currentUrl = url;
    recordSameDocumentHistory(session, url);
    session.lastBrowserHistoryEvent = {
      url,
      at: Date.now(),
    };
    pushNavigation(session, "history", url);
    void maybeRecordPreviewHistory(session, url, session.currentTitle);
  }, 140);
}

function prepareSessionNavigation(session, kind, index = session.historyIndex) {
  // A toolbar action deliberately supersedes an earlier root-navigation
  // request that never committed (for example after a network failure).
  session.pendingRootNavigation = null;
  if (session.pendingNavigation) {
    throw codedError("NAVIGATION_BUSY", "Another preview navigation is still in progress");
  }
  const entry = session.navigationHistory[index];
  if (!entry || !previewTargetAllowed(entry.url, session.settings)) {
    throw codedError("NO_HISTORY", "No safe preview history entry is available");
  }

  session.navigationGeneration += 1;
  session.pendingNavigation = {
    kind,
    index,
    expectedUrl: entry.url,
    previousIndex: session.historyIndex,
    previousUrl: session.currentUrl,
    previousTitle: session.currentTitle,
    acknowledged: false,
    fallbackSent: false,
    navigationStarted: false,
    navigationToken: randomHex(12),
    generation: session.navigationGeneration,
    expiresAt: Date.now() + PENDING_NAVIGATION_TIMEOUT_MS,
  };
  const pending = session.pendingNavigation;
  clearTimeout(session.pendingNavigationTimer);
  session.pendingNavigationTimer = setTimeout(() => {
    if (
      !session.destroyed &&
      session.pendingNavigation === pending
    ) {
      if (pending.navigationStarted) {
        failPendingNavigation(session);
      } else {
        rollbackPendingNavigation(session);
      }
    }
  }, PENDING_NAVIGATION_TIMEOUT_MS);
  session.suppressNavigationUntil = 0;
  session.state = "loading";
  pushNavigation(session, "loading", entry.url, null, {
    generation: session.navigationGeneration,
    newDocument: true,
  });
  return {
    navigation: {
      kind,
      url: entry.url,
      targetUrl:
        GP.previewTargetUrl(entry.url, session.owner.url) ||
        entry.url,
      title: entry.title || "",
      generation: session.navigationGeneration,
    },
    history: historySnapshot(session),
  };
}

function prepareRootNavigation(session, url) {
  if (
    session.pendingNavigation ||
    (session.pendingRootNavigation &&
      session.pendingRootNavigation.expiresAt >= Date.now())
  ) {
    throw codedError(
      "NAVIGATION_BUSY",
      "Another preview navigation is still in progress"
    );
  }
  const previousIndex = session.historyIndex;
  const previousUrl = session.currentUrl;
  const previousTitle = session.currentTitle;
  appendHistoryEntry(session, url, "");
  session.navigationGeneration += 1;
  session.currentUrl = url;
  session.currentTitle = "";
  session.pendingRootNavigation = {
    url,
    index: session.historyIndex,
    previousIndex,
    previousUrl,
    previousTitle,
    generation: session.navigationGeneration,
    expiresAt: Date.now() + PENDING_NAVIGATION_TIMEOUT_MS,
  };
  return session.pendingRootNavigation;
}

function settlePendingSameDocumentNavigation(
  session,
  url,
  documentId,
  status
) {
  const pending = session.pendingNavigation;
  if (!pending) return false;

  // While an explicit back/forward/reload is pending, same-document events
  // from the outgoing state are stale unless both the document and URL match
  // the entry that was selected. Returning true means the caller must not run
  // its ordinary history-recording path.
  if (
    documentId !== session.targetDocumentId ||
    url !== pending.expectedUrl
  ) {
    return true;
  }

  session.historyIndex = Math.min(
    Math.max(0, pending.index),
    session.navigationHistory.length - 1
  );
  session.currentUrl = url;
  updateCurrentHistoryEntry(session, url, session.currentTitle);
  clearPendingNavigation(session, false);
  session.suppressNavigationUntil = 0;
  session.state = status;
  pushNavigation(session, status, url, null, {
    generation: session.navigationGeneration,
    sameDocumentAction: pending.kind,
  });
  return true;
}

function schedulePendingNavigationFallback(session, pending) {
  if (
    !pending ||
    pending.navigationStarted ||
    pending.generation !== session.navigationGeneration
  ) {
    return;
  }
  clearTimeout(session.pendingNavigationFallbackTimer);
  session.pendingNavigationFallbackTimer = setTimeout(() => {
    if (
      session.destroyed ||
      session.pendingNavigation !== pending ||
      pending.fallbackSent ||
      pending.navigationStarted ||
      pending.generation !== session.navigationGeneration
    ) {
      return;
    }
    pending.fallbackSent = true;
    safePost(session.surfacePort, {
      type: "target-fallback",
      url: pending.expectedUrl,
      targetUrl:
        GP.previewTargetUrl(pending.expectedUrl, session.owner.url) ||
        pending.expectedUrl,
      navigationToken: pending.navigationToken,
      generation: pending.generation,
    });
  }, 900);
}

function sendSessionTargetCommand(session, action, extra = {}) {
  return !!(
    session &&
    session.targetPort &&
    session.targetDocumentId &&
    safePost(session.targetPort, {
      type: "command",
      action,
      generation: session.navigationGeneration,
      navigationToken:
        session.pendingNavigation &&
        session.pendingNavigation.generation === session.navigationGeneration
          ? session.pendingNavigation.navigationToken
          : null,
      ...extra,
    })
  );
}

async function stopSessionTarget(session) {
  if (sendSessionTargetCommand(session, "stop")) return true;
  if (!Number.isInteger(session.directTargetFrameId)) return false;
  try {
    await browser.tabs.executeScript(session.tabId, {
      frameId: session.directTargetFrameId,
      code: "window.stop();",
      runAt: "document_start",
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function handleSurfaceAction(context, message) {
  const session = context.session;
  const requestId = message && message.requestId;
  if (!session || session.destroyed || !validRequestId(requestId)) {
    if (session) {
      postSurfaceResult(session, requestId, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "A valid requestId is required",
      });
    }
    return;
  }

  const currentSettings = settingsSnapshot();
  if (
    !currentSettings.enabled ||
    !siteRuleDecision(session.owner.url, currentSettings) ||
    !siteRuleDecision(session.currentUrl, currentSettings)
  ) {
    postSurfaceResult(session, requestId, {
      ok: false,
      code: "DISABLED",
      message: "GlassPeek or this site is disabled",
    });
    return;
  }
  session.settings = currentSettings;

  const allowed = new Set([
    "open-tab",
    "open-sidebar",
    "open-compat",
    "history-back",
    "history-forward",
    "stop",
    "reload",
  ]);
  if (!allowed.has(message.action)) {
    postSurfaceResult(session, requestId, {
      ok: false,
      code: "UNKNOWN_ACTION",
      message: "Unsupported preview action",
    });
    return;
  }

  try {
    let result;
    if (message.action === "open-tab") result = await openSessionTab(session, message.background === true);
    else if (message.action === "open-sidebar") result = await openSessionSidebar(session);
    else if (message.action === "open-compat") {
      result = await routeRequiredCompatibility(session, {
        reason: "user",
        rememberDomain: message.rememberDomain === true,
      });
    }
    else if (message.action === "history-back") {
      if (session.historyIndex <= 0) {
        throw codedError("NO_HISTORY", "There is no earlier preview page");
      }
      result = prepareSessionNavigation(
        session,
        "history-back",
        session.historyIndex - 1
      );
      // Preview histories are isolated URL ledgers. Navigating the selected
      // URL directly avoids another preview's joint iframe history changing
      // which page this control reaches.
      result.commanded = false;
    } else if (message.action === "history-forward") {
      if (session.historyIndex >= session.navigationHistory.length - 1) {
        throw codedError("NO_HISTORY", "There is no later preview page");
      }
      result = prepareSessionNavigation(
        session,
        "history-forward",
        session.historyIndex + 1
      );
      result.commanded = false;
    } else if (message.action === "stop") {
      session.suppressNavigationUntil = Date.now() + STOP_SUPPRESS_MS;
      clearPendingNavigation(session, true);
      session.state = "stopped";
      pushNavigation(session, "stopped", session.currentUrl, null, {
        generation: session.navigationGeneration,
      });
      result = {
        stopped: true,
        commanded: await stopSessionTarget(session),
        url: session.currentUrl,
        history: historySnapshot(session),
      };
    } else {
      result = prepareSessionNavigation(session, "reload");
      result.reload = true;
      result.commanded = sendSessionTargetCommand(session, "reload");
    }
    if (result?.commanded === true && session.pendingNavigation) {
      schedulePendingNavigationFallback(session, session.pendingNavigation);
    }
    postSurfaceResult(session, requestId, { ok: true, ...result });
  } catch (error) {
    postSurfaceResult(session, requestId, { ok: false, ...safeError(error) });
  }
}

function handleSurfaceMessage(context, message) {
  if (!message || typeof message.type !== "string") return;
  if (!context.bound) {
    if (message.type !== "bind") {
      failSurface(context, "BIND_REQUIRED", "The first surface message must bind a grant");
      return;
    }
    void bindSurface(context, message);
    return;
  }
  if (message.type === "action") void handleSurfaceAction(context, message);
}

function acceptSurfacePort(port) {
  const sender = port.sender || {};
  if (
    sender.url !== PREVIEW_URL ||
    !sender.tab ||
    typeof sender.documentId !== "string" ||
    !sender.documentId ||
    !Number.isInteger(sender.frameId) ||
    sender.frameId <= 0
  ) {
    try {
      port.disconnect();
    } catch (_error) {}
    return;
  }

  const context = {
    port,
    tabId: sender.tab.id,
    frameId: sender.frameId,
    documentId: sender.documentId,
    bound: false,
    binding: false,
    session: null,
    bindTimer: 0,
  };
  provisionalSurfaces.add(context);
  context.bindTimer = setTimeout(() => {
    if (!context.bound) {
      failSurface(context, "BIND_TIMEOUT", "The preview surface was not bound in time");
    }
  }, BIND_TTL_MS);

  port.onMessage.addListener((message) => handleSurfaceMessage(context, message));
  port.onDisconnect.addListener(() => {
    clearTimeout(context.bindTimer);
    provisionalSurfaces.delete(context);
    if (context.session && context.session.surfacePort === port) {
      destroySession(context.session, "surface-disconnected", false);
    }
  });
}

function relayTargetSignal(session, signal, payload = {}) {
  if (!session || session.destroyed || !session.surfacePort) return;
  safePost(session.surfacePort, {
    type: "target-signal",
    signal,
    ...payload,
  });
}

function detachTargetContext(session) {
  if (!session) return;
  if (session.targetDocumentId) {
    targetContextsByDocument.delete(session.targetDocumentId);
  }
  if (session.targetPort) {
    try {
      session.targetPort.disconnect();
    } catch (_error) {}
  }
  session.targetPort = null;
  session.targetDocumentId = null;
  session.targetFrameId = null;
  session.directResponseFailure = null;
  for (const context of session.descendantTargetPorts?.values() || []) {
    targetContextsByDocument.delete(context.documentId);
    try {
      context.port.disconnect();
    } catch (_error) {}
  }
  session.descendantTargetPorts?.clear();
  clearTargetTreeFrames(session, true);
}

function acceptTargetBootstrapPort(port) {
  const sender = port.sender || {};
  if (
    sender.url !== TARGET_BOOTSTRAP_URL ||
    !sender.tab ||
    typeof sender.documentId !== "string" ||
    !sender.documentId ||
    !Number.isInteger(sender.frameId) ||
    sender.frameId <= 0
  ) {
    try { port.disconnect(); } catch (_error) {}
    return;
  }

  let settled = false;
  const bindTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { port.disconnect(); } catch (_error) {}
    }
  }, BIND_TTL_MS);

  port.onMessage.addListener(async (message) => {
    if (settled) return;
    settled = true;
    clearTimeout(bindTimer);
    const session = sessions.get(message && message.sessionId);
    if (
      !message ||
      message.type !== "bind" ||
      !session ||
      session.destroyed ||
      !session.surfacePort ||
      session.state === "pending" ||
      session.tabId !== sender.tab.id ||
      typeof message.secret !== "string" ||
      message.secret !== session.targetSecret ||
      Date.now() > session.targetExpiresAt
    ) {
      safePost(port, { type: "rejected" });
      try { port.disconnect(); } catch (_error) {}
      return;
    }

    let frame = null;
    try {
      frame = await browser.webNavigation.getFrame({
        tabId: sender.tab.id,
        documentId: sender.documentId,
      });
    } catch (_error) {
      frame = null;
    }
    if (
      !frame ||
      frame.documentId !== sender.documentId ||
      frame.frameId !== sender.frameId ||
      frame.parentDocumentId !== session.ownerDocumentId
    ) {
      safePost(port, { type: "rejected" });
      try { port.disconnect(); } catch (_error) {}
      return;
    }

    const currentSettings = settingsSnapshot();
    if (
      !currentSettings.enabled ||
      !siteRuleDecision(session.owner.url, currentSettings) ||
      !previewTargetAllowed(session.currentUrl, currentSettings)
    ) {
      safePost(port, { type: "rejected" });
      try { port.disconnect(); } catch (_error) {}
      destroySession(session, "disabled-before-target-bind");
      return;
    }

    if (Number.isInteger(session.directTargetFrameId)) {
      sessionsByDirectTargetFrame.delete(
        directTargetKey(session.tabId, session.directTargetFrameId)
      );
    }
    clearTargetTreeFrames(session, false);
    session.targetSecret = null;
    clearTimeout(session.targetGrantTimer);
    session.directTargetFrameId = sender.frameId;
    session.directTargetBootstrapDocumentId = sender.documentId;
    sessionsByDirectTargetFrame.set(
      directTargetKey(session.tabId, sender.frameId),
      session
    );
    bindTargetTreeFrame(session, sender.frameId);
    safePost(port, {
      type: "navigate",
      url:
        session.navigationTargetUrl ||
        GP.previewTargetUrl(session.currentUrl, session.owner.url) ||
        session.currentUrl,
    });
  });

  port.onDisconnect.addListener(() => clearTimeout(bindTimer));
}

async function openVerifiedTargetExternally(
  session,
  senderUrl,
  message,
  rateState
) {
  const now = Date.now();
  rateState.timestamps = rateState.timestamps.filter(
    (timestamp) => now - timestamp < 5_000
  );
  if (rateState.timestamps.length >= 3) {
    relayTargetSignal(session, "open-external-result", {
      ok: false,
      code: "RATE_LIMITED",
    });
    return;
  }
  rateState.timestamps.push(now);

  const url = GP.normalizeUrl(message.targetUrl, senderUrl);
  if (!url || !previewTargetAllowed(url, session.settings)) {
    relayTargetSignal(session, "open-external-result", {
      ok: false,
      code: "INVALID_URL",
    });
    return;
  }

  const reason = message.reason === "download" ? "download" : "external";
  try {
    const tab = await browser.tabs.create({
      url,
      active: message.background !== true,
      windowId: session.owner.windowId,
      openerTabId: session.owner.tabId,
    });
    relayTargetSignal(session, "open-external-result", {
      ok: true,
      url,
      reason,
      tabId: tab.id,
      windowId: tab.windowId,
    });
  } catch (error) {
    relayTargetSignal(session, "open-external-result", {
      ok: false,
      code: safeError(error, "OPEN_FAILED").code,
    });
  }
}

async function resolveTargetBinding(sender) {
  const deadline = Date.now() + TARGET_BIND_TTL_MS;
  let frame = null;
  while (Date.now() <= deadline) {
    try {
      frame = await browser.webNavigation.getFrame({
        tabId: sender.tab.id,
        documentId: sender.documentId,
      });
    } catch (_error) {
      frame = null;
    }

    if (
      frame &&
      frame.documentId === sender.documentId &&
      frame.frameId === sender.frameId
    ) {
      const directSession = sessionsByDirectTargetFrame.get(
        directTargetKey(sender.tab.id, sender.frameId)
      );
      if (
        directSession &&
        !directSession.destroyed &&
        directSession.tabId === sender.tab.id &&
        directSession.directTargetFrameId === sender.frameId &&
        frame.parentDocumentId === directSession.ownerDocumentId
      ) {
        bindTargetTreeFrame(directSession, sender.frameId);
        return { frame, session: directSession, direct: true };
      }

      const allFrames = await allFramesSnapshot(sender.tab.id);
      const byDocumentId = new Map(
        allFrames
          .filter((candidate) => typeof candidate.documentId === "string")
          .map((candidate) => [candidate.documentId, candidate])
      );
      const path = [frame];
      let cursor = frame;
      let resolvedSession = null;
      while (
        cursor &&
        typeof cursor.parentDocumentId === "string" &&
        cursor.parentDocumentId
      ) {
        const parent = byDocumentId.get(cursor.parentDocumentId);
        if (!parent) break;
        path.push(parent);
        const candidate = sessionsByDirectTargetFrame.get(
          directTargetKey(sender.tab.id, parent.frameId)
        );
        if (
          candidate &&
          !candidate.destroyed &&
          candidate.tabId === sender.tab.id &&
          candidate.directTargetFrameId === parent.frameId &&
          parent.parentDocumentId === candidate.ownerDocumentId &&
          typeof candidate.targetDocumentId === "string" &&
          candidate.targetDocumentId &&
          parent.documentId === candidate.targetDocumentId
        ) {
          resolvedSession = candidate;
          break;
        }
        cursor = parent;
      }
      if (resolvedSession) {
        let parentFrameId = resolvedSession.directTargetFrameId;
        for (let index = path.length - 2; index >= 0; index -= 1) {
          const childFrameId = path[index].frameId;
          if (!bindTargetTreeFrame(resolvedSession, childFrameId, parentFrameId)) {
            resolvedSession = null;
            break;
          }
          parentFrameId = childFrameId;
        }
        if (resolvedSession) {
          return { frame, session: resolvedSession, direct: false };
        }
      }

      // Only a frame whose live document ancestry reaches a verified direct
      // target can bind. Ordinary site iframes fail closed without URL guesses.
      if (allFrames.length) return { frame, session: null, direct: false };
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { frame, session: null, direct: false };
}

async function acceptTargetPort(port) {
  const sender = port.sender || {};
  const senderUrl = GP.normalizeUrl(sender.url);
  if (
    !sender.tab ||
    !senderUrl ||
    typeof sender.documentId !== "string" ||
    !sender.documentId ||
    !Number.isInteger(sender.frameId) ||
    sender.frameId <= 0
  ) {
    try { port.disconnect(); } catch (_error) {}
    return;
  }

  const { frame, session, direct } = await resolveTargetBinding(sender);
  if (
    !frame ||
    !session ||
    session.destroyed ||
    session.tabId !== sender.tab.id ||
    frame.documentId !== sender.documentId ||
    !previewTargetAllowed(senderUrl, session.settings)
  ) {
    try { port.disconnect(); } catch (_error) {}
    return;
  }

  const isDirect = direct === true;
  let displayUrl = session.currentUrl;
  if (isDirect) {
    if (session.targetPort && session.targetPort !== port) {
      try { session.targetPort.disconnect(); } catch (_error) {}
    }
    const senderDisplayUrl =
      GP.previewDisplayUrl(senderUrl, session.currentUrl) || senderUrl;
    const currentDocumentUrl =
      session.committedDocumentId === sender.documentId &&
      session.targetDocumentId === sender.documentId
        ? GP.normalizeUrl(session.currentUrl)
        : null;
    // Port sender.url is captured when the document connects and can still be
    // the original request URL after an immediate pushState/replaceState.
    displayUrl = currentDocumentUrl || senderDisplayUrl;
    session.targetPort = port;
    session.targetDocumentId = sender.documentId;
    session.targetFrameId = sender.frameId;
    session.currentUrl = displayUrl;
    if (
      session.committedDocumentId === sender.documentId &&
      session.pendingHistoryReconcile?.documentId !== sender.documentId
    ) {
      updateCurrentHistoryEntry(session, displayUrl);
    }
  } else {
    const previous = session.descendantTargetPorts.get(sender.documentId);
    if (previous && previous.port !== port) {
      try { previous.port.disconnect(); } catch (_error) {}
    }
    session.descendantTargetPorts.set(sender.documentId, {
      documentId: sender.documentId,
      frameId: sender.frameId,
      port,
    });
  }
  targetContextsByDocument.set(sender.documentId, {
    port,
    session,
    role: isDirect ? "direct" : "descendant",
  });
  const externalOpenRate = { timestamps: [] };
  const rootNavigationRate = { timestamps: [] };

  const isCurrentPort = () => {
    if (isDirect) {
      return (
        session.targetPort === port &&
        session.targetDocumentId === sender.documentId
      );
    }
    return (
      session.descendantTargetPorts.get(sender.documentId)?.port === port &&
      targetTreeSession(sender.tab.id, sender.frameId) === session
    );
  };

  port.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string" || session.destroyed) return;
    if (!isCurrentPort()) return;
    if (message.type === "alive") {
      if (!isDirect || session.directResponseFailure) return;
      const observedAliveUrl = GP.normalizeUrl(message.url, senderUrl);
      const aliveUrl = observedAliveUrl
        ? GP.previewDisplayUrl(observedAliveUrl, session.currentUrl)
        : null;
      if (aliveUrl && previewTargetAllowed(aliveUrl, session.settings)) {
        session.currentUrl = aliveUrl;
        reconcileCommittedHistory(
          session,
          aliveUrl,
          sender.documentId,
          message.historyLength,
          message.navigationType
        );
        if (
          session.activeNavigation?.generation ===
          session.navigationGeneration
        ) {
          session.activeNavigation = null;
        }
      } else {
        observeNativeHistoryLength(session, message.historyLength);
      }
      // A history/reload action has already selected a different entry, but
      // the old document can still emit one final readiness signal before its
      // replacement commits. Never let that stale document reveal itself or
      // rewrite the selected history entry.
      if (session.pendingNavigation) return;
      const title =
        typeof message.title === "string"
          ? message.title.trim().slice(0, 240)
          : "";
      if (title) {
        session.currentTitle = title;
        updateCurrentHistoryEntry(session, session.currentUrl, title);
      }
      relayTargetSignal(session, "alive", {
        url: session.currentUrl,
        title: session.currentTitle,
        history: historySnapshot(session),
      });
      void maybeRecordPreviewHistory(
        session,
        session.currentUrl,
        session.currentTitle
      );
    } else if (message.type === "embed-refused") {
      if (!isDirect) return;
      session.compatRequired = {
        reason: "site-warning",
        url: session.currentUrl,
      };
      session.state = "compat-required";
      pushNavigation(session, "compat-required", session.currentUrl, null, {
        blocked: true,
        compatRequired: true,
        compatReason: "site-warning",
      });
    } else if (message.type === "command-ack") {
      if (!isDirect) return;
      const pending = session.pendingNavigation;
      if (
        !pending ||
        !Number.isInteger(message.generation) ||
        message.generation !== session.navigationGeneration ||
        typeof message.navigationToken !== "string" ||
        message.navigationToken !== pending.navigationToken
      ) {
        return;
      }
      if (message.accepted === false) {
        rollbackPendingNavigation(session);
        return;
      }
      pending.acknowledged = true;
      schedulePendingNavigationFallback(session, pending);
    } else if (message.type === "escape") {
      relayTargetSignal(session, "escape", { shiftKey: message.shiftKey === true });
    } else if (message.type === "activate") {
      relayTargetSignal(session, "activate");
    } else if (message.type === "history-shortcut") {
      if (message.direction !== "back" && message.direction !== "forward") return;
      relayTargetSignal(session, "history-shortcut", {
        direction: message.direction,
      });
    } else if (message.type === "new-preview") {
      const url = GP.normalizeUrl(message.targetUrl, senderUrl);
      if (!url || !previewTargetAllowed(url, session.settings)) return;
      relayTargetSignal(session, "new-preview", {
        url,
        background: message.background === true,
      });
    } else if (message.type === "navigate-root") {
      // A verified target document may ask the surface to replace the direct
      // root only during a real user activation. Routing both direct and
      // descendant links through one ledger keeps nested navigation reliable.
      const now = Date.now();
      rootNavigationRate.timestamps = rootNavigationRate.timestamps.filter(
        (timestamp) => now - timestamp < 5_000
      );
      if (
        message.userActivated !== true ||
        rootNavigationRate.timestamps.length >= 4
      ) {
        return;
      }
      const url = GP.normalizeUrl(message.targetUrl, senderUrl);
      if (!url || !previewTargetAllowed(url, session.settings)) return;
      rootNavigationRate.timestamps.push(now);
      let rootNavigation;
      try {
        rootNavigation = prepareRootNavigation(session, url);
      } catch (_error) {
        return;
      }
      if (forcedCompatibilityHostname(url, session.settings)) {
        session.compatRequired = { reason: "remembered-domain", url };
        session.state = "compat-required";
        pushNavigation(session, "compat-required", url, null, {
          blocked: true,
          compatRequired: true,
          compatReason: "remembered-domain",
        });
        void routeRequiredCompatibility(session, session.compatRequired);
        return;
      }
      relayTargetSignal(session, "navigate-root", {
        url,
        generation: rootNavigation.generation,
        history: historySnapshot(session),
      });
    } else if (message.type === "unsupported-link") {
      relayTargetSignal(session, "unsupported-link", {
        scheme:
          typeof message.scheme === "string"
            ? message.scheme.slice(0, 24)
            : "",
      });
    } else if (message.type === "history-pop") {
      if (!isDirect) return;
      const observedUrl = GP.normalizeUrl(message.url, senderUrl);
      const url = observedUrl
        ? GP.previewDisplayUrl(observedUrl, session.currentUrl)
        : null;
      if (!url || !previewTargetAllowed(url, session.settings)) return;
      clearPendingBrowserHistoryEvent(session);
      observeNativeHistoryLength(session, message.historyLength);
      if (
        settlePendingSameDocumentNavigation(
          session,
          url,
          sender.documentId,
          "history"
        )
      ) {
        void maybeRecordPreviewHistory(session, url, session.currentTitle);
        return;
      }
      session.currentUrl = url;
      recordSameDocumentHistory(session, url);
      session.lastHistorySignal = {
        url,
        action: "popstate",
        at: Date.now(),
      };
      pushNavigation(session, "history", url, null, {
        sameDocumentAction: "popstate",
      });
      void maybeRecordPreviewHistory(session, url, session.currentTitle);
    } else if (message.type === "history-state") {
      if (!isDirect) return;
      // pushState/replaceState notifications from the outgoing document can
      // race an explicit back/forward/reload and otherwise move historyIndex
      // back to the entry that the user just left.
      if (session.pendingNavigation) return;
      const observedUrl = GP.normalizeUrl(message.url, senderUrl);
      const url = observedUrl
        ? GP.previewDisplayUrl(observedUrl, session.currentUrl)
        : null;
      if (!url || !previewTargetAllowed(url, session.settings)) return;
      const action =
        message.action === "replaceState" ? "replaceState" : "pushState";
      const pendingBrowserEvent = session.pendingBrowserHistoryEvent;
      if (
        pendingBrowserEvent &&
        pendingBrowserEvent.documentId === sender.documentId &&
        pendingBrowserEvent.url === url
      ) {
        clearPendingBrowserHistoryEvent(session);
      }
      observeNativeHistoryLength(session, message.historyLength);
      session.currentUrl = url;
      if (action === "replaceState") {
        updateCurrentHistoryEntry(session, url, session.currentTitle);
      } else {
        // pushState creates a new session-history entry even when its URL
        // matches an older adjacent entry (A -> B -> A is still three visits).
        // The page bridge identifies the operation, while the browser event is
        // briefly buffered so event ordering cannot change this result.
        appendHistoryEntry(session, url, session.currentTitle);
      }
      session.lastHistorySignal = {
        url,
        action,
        at: Date.now(),
      };
      pushNavigation(session, "history", url, null, {
        sameDocumentAction: action,
      });
      void maybeRecordPreviewHistory(session, url, session.currentTitle);
    } else if (message.type === "open-external") {
      void openVerifiedTargetExternally(
        session,
        senderUrl,
        message,
        externalOpenRate
      );
    }
  });
  // Attach the inbound listener before granting the target capability. The
  // content script synchronously flushes document_start history mutations when
  // it receives config; posting config first could otherwise drop that batch.
  safePost(port, {
    type: "config",
    role: isDirect ? "direct" : "descendant",
    openLinksInNewPreview: session.settings.openLinksInNewPreview === true,
    sourceUrl: session.owner.url,
  });
  if (isDirect && !session.directResponseFailure) {
    relayTargetSignal(session, "alive", {
      url: displayUrl,
      title: session.currentTitle,
      history: historySnapshot(session),
    });
  }
  port.onDisconnect.addListener(() => {
    const current = targetContextsByDocument.get(sender.documentId);
    if (current && current.port === port) targetContextsByDocument.delete(sender.documentId);
    if (isDirect) {
      if (session.targetPort === port) session.targetPort = null;
    } else if (
      session.descendantTargetPorts.get(sender.documentId)?.port === port
    ) {
      session.descendantTargetPorts.delete(sender.documentId);
    }
  });
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "gp-owner-v2") acceptOwnerPort(port);
  else if (port.name === "gp-surface-v2") acceptSurfacePort(port);
  else if (port.name === "gp-target-bootstrap-v3") {
    acceptTargetBootstrapPort(port);
  }
  else if (port.name === "gp-target-v2") void acceptTargetPort(port);
  else {
    try {
      port.disconnect();
    } catch (_error) {}
  }
});

function sessionForNavigation(details) {
  if (
    !details ||
    typeof details.parentDocumentId !== "string" ||
    !details.parentDocumentId
  ) {
    return null;
  }
  const surfaceSession = sessionsBySurfaceDocument.get(details.parentDocumentId);
  if (
    surfaceSession &&
    !surfaceSession.destroyed &&
    surfaceSession.tabId === details.tabId
  ) {
    return surfaceSession;
  }
  const directSession = sessionsByDirectTargetFrame.get(
    directTargetKey(details.tabId, details.frameId)
  );
  if (
    !directSession ||
    directSession.destroyed ||
    directSession.tabId !== details.tabId ||
    directSession.directTargetFrameId !== details.frameId ||
    details.parentDocumentId !== directSession.ownerDocumentId
  ) {
    return null;
  }
  return directSession;
}

function pushNavigation(session, status, suppliedUrl, error, extra = {}) {
  if (!session || session.destroyed || !session.surfacePort) return;
  const url = GP.normalizeUrl(suppliedUrl) || session.currentUrl;
  const message = {
    type: "navigation",
    url,
    title: session.currentTitle,
    status,
    history: historySnapshot(session),
    generation: session.navigationGeneration,
    compatRequired: !!session.compatRequired,
    compatReason:
      session.compatRequired && typeof session.compatRequired.reason === "string"
        ? session.compatRequired.reason
        : null,
    ...extra,
  };
  if (error) message.error = String(error).slice(0, 300);
  safePost(session.surfacePort, message);
}

function suppressesNavigationEvent(session, details) {
  return session.suppressNavigationUntil >= Date.now();
}

browser.webNavigation.onBeforeNavigate.addListener((details) => {
  if (!details || details.frameId === 0) return;
  const treeSession = registerTargetTreeFrame(details);
  if (
    treeSession &&
    treeSession.directTargetFrameId !== details.frameId
  ) {
    removeTargetTreeSubtree(treeSession, details.frameId, false);
    return;
  }
  const session = sessionForNavigation(details);
  if (!session || suppressesNavigationEvent(session, details)) return;

  const observedUrl = GP.normalizeUrl(details.url);
  const url = observedUrl
    ? GP.previewDisplayUrl(observedUrl, session.currentUrl)
    : null;
  const previousDocumentId = session.targetDocumentId;
  const previousHistoryLength =
    nativeHistoryLengthByTab.get(session.tabId) ??
    session.nativeHistoryLength;
  detachTargetContext(session);
  if (!url || !previewTargetAllowed(url, session.settings)) {
    session.suppressNavigationUntil = Date.now() + STOP_SUPPRESS_MS;
    session.state = "error";
    pushNavigation(
      session,
      "error",
      session.currentUrl,
      "Navigation left the safe HTTP(S) preview boundary",
      { blocked: true, newDocument: true }
    );
    return;
  }

  if (
    session.pendingNavigation &&
    session.pendingNavigation.expectedUrl === url
  ) {
    cancelSurfaceNavigationFallback(
      session,
      session.pendingNavigation,
      true
    );
  }
  const pendingRoot = session.pendingRootNavigation;
  let expectedRootNavigation =
    pendingRoot &&
    pendingRoot.expiresAt >= Date.now() &&
    pendingRoot.url === url;
  if (
    !expectedRootNavigation &&
    pendingRoot &&
    pendingRoot.expiresAt >= Date.now() &&
    session.activeNavigation?.generation === pendingRoot.generation
  ) {
    // Preserve one ledger entry across an HTTP redirect chain.
    pendingRoot.url = url;
    const entry = session.navigationHistory[pendingRoot.index];
    if (entry) entry.url = url;
    expectedRootNavigation = true;
  }
  session.compatRequired = null;
  if (session.blockedRequest?.url !== url) {
    session.blockedRequest = null;
  }
  if (
    (!session.pendingNavigation ||
      session.pendingNavigation.expectedUrl !== url) &&
    !expectedRootNavigation
  ) {
    session.navigationGeneration += 1;
    session.currentTitle = "";
  }
  session.activeNavigation = {
    url,
    generation: session.navigationGeneration,
    documentId:
      typeof details.documentId === "string" ? details.documentId : null,
    previousDocumentId,
    previousHistoryLength,
    startedAt: Date.now(),
  };
  session.currentUrl = url;
  session.state = "loading";
  pushNavigation(session, "loading", url, null, {
    newDocument: true,
  });
});

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    cleanupTab(details.tabId, "top-document-replaced", details.documentId || null);
    return;
  }

  const treeSession = registerTargetTreeFrame(details);
  if (
    treeSession &&
    treeSession.directTargetFrameId !== details.frameId
  ) {
    return;
  }
  const session = sessionForNavigation(details);
  if (!session || suppressesNavigationEvent(session, details)) return;
  const observedUrl = GP.normalizeUrl(details.url);
  const url = observedUrl
    ? GP.previewDisplayUrl(observedUrl, session.currentUrl)
    : null;
  if (!url || !previewTargetAllowed(url, session.settings)) {
    session.suppressNavigationUntil = Date.now() + STOP_SUPPRESS_MS;
    pushNavigation(
      session,
      "error",
      session.currentUrl,
      "Unsupported or disabled navigation URL",
      { blocked: true, newDocument: true }
    );
    return;
  }
  if (session.targetDocumentId && session.targetDocumentId !== details.documentId) {
    targetContextsByDocument.delete(session.targetDocumentId);
    if (session.targetPort) {
      try { session.targetPort.disconnect(); } catch (_error) {}
      session.targetPort = null;
    }
  }
  commitHistoryEntry(session, url, details.documentId, details);
  session.currentUrl = url;
  session.targetDocumentId = details.documentId;
  session.targetFrameId = details.frameId;
  session.lastNavigationAt = details.timeStamp || Date.now();
  if (session.directResponseFailure) {
    const failure = session.directResponseFailure;
    finalizeCommittedHistoryWithoutAlive(
      session,
      url,
      details.documentId
    );
    session.activeNavigation = null;
    session.state = failure.compatibility ? "compat-required" : "error";
    pushNavigation(
      session,
      session.state,
      url,
      failure.compatibility
        ? `Embedded response requires a top-level Firefox window${
            failure.statusCode ? ` (HTTP ${failure.statusCode})` : ""
          }`
        : `Embedded request failed with HTTP ${failure.statusCode}`,
      {
        blocked: true,
        newDocument: true,
        httpStatus: failure.statusCode,
        compatRequired: failure.compatibility,
        compatReason: failure.reason,
      }
    );
    return;
  }
  session.state = "committed";
  pushNavigation(session, "committed", url, null, {
    newDocument: true,
  });
  void maybeRecordPreviewHistory(session, url, session.currentTitle);
});

browser.webNavigation.onDOMContentLoaded.addListener((details) => {
  const session = sessionForNavigation(details);
  if (
    !session ||
    suppressesNavigationEvent(session, details) ||
    details.documentId !== session.targetDocumentId ||
    session.directResponseFailure
  ) {
    return;
  }
  session.state = "domcontentloaded";
  pushNavigation(
    session,
    "domcontentloaded",
    // Firefox reports the originally committed request URL here even when a
    // router already changed location with pushState/replaceState.
    session.currentUrl || GP.previewDisplayUrl(details.url, session.currentUrl)
  );
});

browser.webNavigation.onCompleted.addListener((details) => {
  const session = sessionForNavigation(details);
  if (
    !session ||
    suppressesNavigationEvent(session, details) ||
    details.documentId !== session.targetDocumentId ||
    session.directResponseFailure
  ) {
    return;
  }
  finalizeCommittedHistoryWithoutAlive(
    session,
    session.currentUrl || GP.previewDisplayUrl(details.url, session.currentUrl),
    details.documentId
  );
  session.activeNavigation = null;
  session.state = "completed";
  pushNavigation(
    session,
    "completed",
    // Completion is a lifecycle signal, not a newer URL observation. Keep the
    // same-document URL already established by the target/history channels.
    session.currentUrl || GP.previewDisplayUrl(details.url, session.currentUrl)
  );
});

browser.webNavigation.onErrorOccurred.addListener((details) => {
  const session = sessionForNavigation(details);
  if (!session || suppressesNavigationEvent(session, details)) return;
  const observedUrl = GP.normalizeUrl(details.url);
  const url = observedUrl
    ? GP.previewDisplayUrl(observedUrl, session.currentUrl)
    : null;
  const blocked = session.blockedRequest;
  if (
    blocked &&
    blocked.url === (url || session.currentUrl) &&
    Date.now() - blocked.at < 10_000
  ) {
    session.activeNavigation = null;
    return;
  }
  const active = session.activeNavigation;
  const matchesActive =
    !!active &&
    active.generation === session.navigationGeneration &&
    active.url === url &&
    (!active.documentId ||
      !details.documentId ||
      active.documentId === details.documentId);
  const matchesCommitted =
    !!session.targetDocumentId &&
    !!details.documentId &&
    session.targetDocumentId === details.documentId;
  if (!matchesActive && !matchesCommitted) return;

  recordFailedNavigation(session, url);
  session.activeNavigation = null;
  session.state = "error";
  pushNavigation(
    session,
    "error",
    session.currentUrl || url,
    details.error || "Navigation failed"
  );
});

browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const session = sessionForNavigation(details);
  if (!session || details.documentId !== session.targetDocumentId) return;
  const observedUrl = GP.normalizeUrl(details.url);
  const url = observedUrl
    ? GP.previewDisplayUrl(observedUrl, session.currentUrl)
    : null;
  if (!url || !previewTargetAllowed(url, session.settings)) return;
  if (
    settlePendingSameDocumentNavigation(
      session,
      url,
      details.documentId,
      "history"
    )
  ) {
    return;
  }
  if (
    session.lastHistorySignal &&
    session.lastHistorySignal.url === url &&
    Date.now() - session.lastHistorySignal.at < 1_000
  ) {
    // A previously queued browser fallback may describe an earlier router
    // state. Once the page bridge confirms this URL, no delayed fallback may
    // overwrite it.
    clearPendingBrowserHistoryEvent(session);
    session.currentUrl = url;
    return;
  }
  queueBrowserHistoryFallback(session, url, details.documentId);
});

browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  const session = sessionForNavigation(details);
  if (!session || details.documentId !== session.targetDocumentId) return;
  const observedUrl = GP.normalizeUrl(details.url);
  const url = observedUrl
    ? GP.previewDisplayUrl(observedUrl, session.currentUrl)
    : null;
  if (!url || !previewTargetAllowed(url, session.settings)) return;
  if (
    settlePendingSameDocumentNavigation(
      session,
      url,
      details.documentId,
      "fragment"
    )
  ) {
    return;
  }
  session.currentUrl = url;
  recordSameDocumentHistory(session, url);
  pushNavigation(session, "fragment", url);
  void maybeRecordPreviewHistory(session, url, session.currentTitle);
});

browser.tabs.onRemoved.addListener((tabId) => {
  cleanupTab(tabId, "tab-closed");
  const state = sidebarByTab.get(tabId);
  sidebarByTab.delete(tabId);
  if (state && sidebarByWindow.get(state.windowId)?.tabId === tabId) {
    sidebarByWindow.delete(state.windowId);
  }
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const state = sidebarByTab.get(tabId) || null;
  if (state) sidebarByWindow.set(windowId, state);
  else sidebarByWindow.delete(windowId);
  browser.runtime.sendMessage({
    type: "gp-sidebar-state",
    windowId,
    state: state ? { ...state } : null,
  }).catch(() => {});
});

browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  const state = sidebarByTab.get(tabId);
  if (state && sidebarByWindow.get(oldWindowId)?.tabId === tabId) {
    sidebarByWindow.delete(oldWindowId);
    browser.runtime.sendMessage({ type: "gp-sidebar-state", windowId: oldWindowId, state: null }).catch(() => {});
  }
});

browser.tabs.onAttached.addListener((tabId, attachInfo) => {
  for (const owner of owners.values()) {
    if (owner.tabId === tabId) {
      owner.windowId = attachInfo.newWindowId;
      for (const sessionId of owner.sessions) {
        const session = sessions.get(sessionId);
        if (session) session.windowId = attachInfo.newWindowId;
      }
    }
  }
  const sidebarState = sidebarByTab.get(tabId);
  if (sidebarState) {
    sidebarState.windowId = attachInfo.newWindowId;
    sidebarByWindow.set(attachInfo.newWindowId, sidebarState);
    browser.runtime.sendMessage({
      type: "gp-sidebar-state",
      windowId: attachInfo.newWindowId,
      state: { ...sidebarState },
    }).catch(() => {});
  }
});

if (browser.webNavigation.onTabReplaced) {
  browser.webNavigation.onTabReplaced.addListener((details) => {
    cleanupTab(details.replacedTabId, "tab-replaced");
  });
}

browser.windows.onRemoved.addListener((windowId) => {
  sidebarByWindow.delete(windowId);
  for (const [tabId, state] of sidebarByTab) {
    if (state.windowId === windowId) sidebarByTab.delete(tabId);
  }
  compatibilityBySourceWindow.delete(windowId);
  for (const [sourceWindowId, compatibilityWindowId] of compatibilityBySourceWindow) {
    if (compatibilityWindowId === windowId) compatibilityBySourceWindow.delete(sourceWindowId);
  }
});

async function resolveWindowId(message, sender) {
  if (Number.isInteger(message && message.windowId) && message.windowId >= 0) {
    return message.windowId;
  }
  if (sender && sender.tab && Number.isInteger(sender.tab.windowId)) {
    return sender.tab.windowId;
  }
  const current = await browser.windows.getCurrent();
  return current.id;
}

function activeSessionForTab(tabId) {
  const candidates = [...owners.values()].filter((owner) => owner.tabId === tabId);
  candidates.sort((a, b) => b.connectedAt - a.connectedAt);
  for (const owner of candidates) {
    const active = sessions.get(owner.activeSessionId);
    if (active && !active.destroyed) return active;
    const fallback = [...owner.sessions]
      .map((id) => sessions.get(id))
      .filter(Boolean)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (fallback) return fallback;
  }
  return null;
}

async function currentState(message) {
  let tab = null;
  if (Number.isInteger(message && message.tabId)) {
    try {
      tab = await browser.tabs.get(message.tabId);
    } catch (_error) {}
  }
  if (!tab) {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  }

  const settings = settingsSnapshot();
  const normalized = tab && GP.normalizeUrl(tab.url);
  const siteEnabled = !!(
    normalized &&
    settings.enabled &&
    siteRuleDecision(normalized, settings)
  );
  const active = tab ? activeSessionForTab(tab.id) : null;
  const owner = tab
    ? [...owners.values()].find((candidate) => candidate.tabId === tab.id)
    : null;

  return {
    ok: true,
    settings,
    tab: tab
      ? { id: tab.id, windowId: tab.windowId, url: normalized || null }
      : null,
    siteEnabled,
    activeSession: active
      ? { sessionId: active.id, url: active.currentUrl, status: active.state }
      : null,
    sessionCount: owner ? owner.sessions.size : 0,
  };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return undefined;

  if (message.type === "gp-sidebar-arm") {
    const armId =
      typeof message.armId === "string" && /^[a-f0-9]{36}$/.test(message.armId)
        ? message.armId
        : null;
    if (
      sender.url !== SIDEBAR_URL ||
      typeof sender.documentId !== "string" ||
      !sender.documentId ||
      !armId
    ) {
      return Promise.resolve({
        ok: false,
        code: "FORBIDDEN",
        message: "Sidebar document context required",
      });
    }
    sidebarArmIdsByDocument.set(sender.documentId, armId);
    // A new navigation revokes the previous arm immediately, before DNS
    // resolution. This makes last-request-wins even when lookups finish out of
    // order and keeps old blocked callbacks from targeting the new load.
    sidebarSurfacesByDocument.delete(sender.documentId);
    return (async () => {
      const url = GP.normalizeUrl(message.url);
      if (!url || !previewTargetAllowed(url)) {
        throw codedError(
          "INVALID_URL",
          "The sidebar only accepts enabled public HTTP(S) URLs"
        );
      }
      if ((await publicResolvedUrl(url)) === "private") {
        throw codedError(
          "PRIVATE_HOST",
          "The sidebar target resolves to a local or private-network address"
        );
      }
      if (sidebarArmIdsByDocument.get(sender.documentId) !== armId) {
        throw codedError("STALE_ARM", "A newer sidebar navigation superseded this request");
      }
      const now = Date.now();
      sidebarSurfacesByDocument.set(sender.documentId, {
        documentId: sender.documentId,
        generation: randomHex(16),
        url,
        armedAt: now,
      });
      const surface = sidebarSurfacesByDocument.get(sender.documentId);
      return {
        ok: true,
        url,
        documentId: sender.documentId,
        generation: surface.generation,
        armId,
      };
    })().catch((error) => ({ ok: false, ...safeError(error) }));
  }

  if (message.type === "gp-sidebar-get") {
    if (sender.url !== SIDEBAR_URL) {
      return Promise.resolve({ ok: false, code: "FORBIDDEN", message: "Sidebar context required" });
    }
    return resolveWindowId(message, sender)
      .then(async (windowId) => {
        const [activeTab] = await browser.tabs.query({ active: true, windowId });
        const state = activeTab ? sidebarByTab.get(activeTab.id) : null;
        return {
          ok: true,
          windowId,
          state: state ? { ...state } : null,
        };
      })
      .catch((error) => ({ ok: false, ...safeError(error) }));
  }

  if (message.type === "gp-sidebar-open") {
    if (sender.url !== SIDEBAR_URL && sender.url !== POPUP_URL) {
      return Promise.resolve({ ok: false, code: "FORBIDDEN", message: "Trusted GlassPeek UI required" });
    }
    return (async () => {
      try {
        const windowId = await resolveWindowId(message, sender);
        let sourceTabId = Number.isInteger(message.tabId) ? message.tabId : null;
        if (sourceTabId != null) {
          const sourceTab = await browser.tabs.get(sourceTabId);
          if (sourceTab.windowId !== windowId) throw codedError("WRONG_WINDOW", "Source tab belongs to another window");
        } else {
          const [activeTab] = await browser.tabs.query({ active: true, windowId });
          sourceTabId = activeTab ? activeTab.id : null;
        }
        const targetUrl = GP.normalizeUrl(message.url);
        if (!targetUrl || !previewTargetAllowed(targetUrl)) {
          throw codedError(
            "INVALID_URL",
            "The sidebar only accepts enabled public HTTP(S) URLs"
          );
        }
        const resolvedSafety = await publicResolvedUrl(targetUrl);
        if (resolvedSafety === "private") {
          throw codedError(
            "PRIVATE_HOST",
            "The sidebar target resolves to a local or private-network address"
          );
        }
        const state = setSidebarState(
          windowId,
          targetUrl,
          null,
          sourceTabId,
          !(sender.url === SIDEBAR_URL && message.updateOnly === true)
        );
        await browser.sidebarAction.open();
        return { ok: true, windowId, tabId: sourceTabId, url: state.url };
      } catch (error) {
        return { ok: false, ...safeError(error) };
      }
    })();
  }

  if (message.type === "gp-open-compat") {
    if (sender.url !== SIDEBAR_URL) {
      return Promise.resolve({ ok: false, code: "FORBIDDEN", message: "Sidebar context required" });
    }
    return (async () => {
      try {
        const windowId = await resolveWindowId(message, sender);
        const [activeTab] = await browser.tabs.query({ active: true, windowId });
        const targetUrl = GP.normalizeUrl(message.url);
        if (!targetUrl || !previewTargetAllowed(targetUrl)) {
          throw codedError(
            "INVALID_URL",
            "The compatibility window only accepts enabled public HTTP(S) URLs"
          );
        }
        const resolvedSafety = await publicResolvedUrl(targetUrl);
        if (resolvedSafety === "private") {
          throw codedError(
            "PRIVATE_HOST",
            "The target resolves to a local or private-network address"
          );
        }
        const result = await openCompatibilityUrl({
          url: targetUrl,
          sourceWindowId: windowId,
          openerTabId: activeTab && activeTab.id,
          incognito: !!(activeTab && activeTab.incognito),
        });
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, ...safeError(error) };
      }
    })();
  }

  if (message.type === "gp-current-state") {
    if (sender.url !== POPUP_URL && sender.url !== OPTIONS_URL) {
      return Promise.resolve({ ok: false, code: "FORBIDDEN", message: "Extension UI context required" });
    }
    return currentState(message).catch((error) => ({ ok: false, ...safeError(error) }));
  }

  return undefined;
});

function commandUrlForTab(tab) {
  const active = activeSessionForTab(tab.id);
  return GP.normalizeUrl(active ? active.currentUrl : tab.url);
}

async function handleCommand(command, suppliedTab) {
  let tab = suppliedTab;
  if (!tab || !Number.isInteger(tab.id)) {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab || !sourceAllowed(tab.url)) return;

  const url = commandUrlForTab(tab);
  if (!url || !siteRuleDecision(url, settingsCache)) return;

  if (command === "open-in-sidebar") {
    if (GP.isPrivateHost(url)) return;
    setSidebarState(tab.windowId, url, null, tab.id);
    await browser.sidebarAction.open();
  } else if (command === "open-in-tab") {
    await browser.tabs.create({
      url,
      active: true,
      windowId: tab.windowId,
      openerTabId: tab.id,
    });
  }
}

browser.commands.onCommand.addListener((command, tab) => {
  void handleCommand(command, tab).catch(() => {});
});

async function injectUpdatedContentScripts() {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id) && GP.normalizeUrl(tab.url))
      .map(async (tab) => {
        await browser.tabs.executeScript(tab.id, {
          file: "shared/common.js",
          allFrames: true,
          matchAboutBlank: false,
          runAt: "document_idle",
        });
        await browser.tabs.executeScript(tab.id, {
          file: "content.js",
          allFrames: true,
          matchAboutBlank: false,
          runAt: "document_idle",
        });
      })
  );
}

browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    browser.tabs
      .create({ url: browser.runtime.getURL("welcome/welcome.html") })
      .catch(() => {});
  } else if (reason === "update") {
    void injectUpdatedContentScripts().catch(() => {});
  }
});
