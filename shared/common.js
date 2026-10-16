(function initGlassPeekCommon(root) {
  "use strict";

  const MAX_URL_LENGTH = 32768;
  const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
  const DEFAULTS = Object.freeze({
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
    siteRules: Object.freeze([]),
    forceCompatDomains: Object.freeze([]),
    schemaVersion: 6,
  });

  /**
   * Return a canonical HTTP(S) URL, preserving its fragment, or null.
   * Credentials, control characters, opaque/non-web schemes, and oversized
   * URLs are deliberately rejected at the shared trust boundary.
   */
  function normalizeUrl(raw, base) {
    if (typeof raw !== "string" || !raw || CONTROL_CHAR_RE.test(raw)) {
      return null;
    }

    const candidate = raw.trim();
    if (!candidate || candidate.length > MAX_URL_LENGTH) return null;

    try {
      const parsed = base == null ? new URL(candidate) : new URL(candidate, base);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (!parsed.hostname || parsed.username || parsed.password) return null;
      if (CONTROL_CHAR_RE.test(parsed.href) || parsed.href.length > MAX_URL_LENGTH) {
        return null;
      }
      return parsed.href;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Direct original-page previews keep the network URL identical to the
   * requested URL. Compatibility comes from the verified frame architecture
   * and narrowly scoped embedding-header handling, never hidden redirects or
   * substitute reader/video targets.
   */
  function previewTargetUrl(raw, _sourceUrl) {
    return normalizeUrl(raw);
  }

  /**
   * Display identity, history, copy, and open-tab actions use the exact
   * normalized network URL in original-page mode.
   */
  function previewDisplayUrl(rawTarget, _expectedDisplayUrl) {
    return normalizeUrl(rawTarget);
  }

  function hostnameFrom(input) {
    if (input instanceof URL) return input.hostname;
    if (typeof input !== "string") return "";

    const value = input.trim();
    if (!value || CONTROL_CHAR_RE.test(value)) return "";

    try {
      if (/^[a-z][a-z\d+.-]*:/i.test(value)) return new URL(value).hostname;
      if (value.startsWith("[") && value.endsWith("]")) {
        return new URL(`http://${value}/`).hostname;
      }
      if (value.includes(":")) return new URL(`http://[${value}]/`).hostname;
      return new URL(`http://${value}/`).hostname;
    } catch (_error) {
      return "";
    }
  }

  function normalizedHostname(input) {
    return hostnameFrom(input)
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
  }

  function parseIpv4(hostname) {
    const parts = hostname.split(".");
    if (parts.length !== 4) return null;
    const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
    if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    return bytes;
  }

  function parseIpv6(hostname) {
    if (typeof hostname !== "string" || !hostname.includes(":")) return null;
    const input = hostname.toLowerCase();
    if (!/^[0-9a-f:.]+$/.test(input) || (input.match(/::/g) || []).length > 1) {
      return null;
    }

    let prepared = input;
    const dotted = prepared.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) {
      const ipv4 = parseIpv4(dotted[1]);
      if (!ipv4) return null;
      prepared = prepared.slice(0, -dotted[1].length) +
        `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    }

    const halves = prepared.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    if (
      left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
      right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    ) {
      return null;
    }
    const missing = 8 - left.length - right.length;
    if (
      (halves.length === 1 && missing !== 0) ||
      (halves.length === 2 && missing < 1)
    ) {
      return null;
    }
    return [
      ...left.map((part) => Number.parseInt(part, 16)),
      ...Array(Math.max(0, missing)).fill(0),
      ...right.map((part) => Number.parseInt(part, 16)),
    ];
  }

  function ipv4FromWords(high, low) {
    return [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ];
  }

  function ipv6MatchesAllocation(words, firstWord, secondWord, prefixLength) {
    if (!Array.isArray(words) || words.length !== 8) return false;
    if (prefixLength <= 16) {
      const mask = (0xffff << (16 - prefixLength)) & 0xffff;
      return (words[0] & mask) === (firstWord & mask);
    }
    if (words[0] !== firstWord) return false;
    const remaining = prefixLength - 16;
    const mask = remaining === 16
      ? 0xffff
      : (0xffff << (16 - remaining)) & 0xffff;
    return (words[1] & mask) === (secondWord & mask);
  }

  /**
   * Current IANA allocations from the IPv6 Global Unicast Address Space
   * registry. Unlisted portions of 2000::/3 are reserved for future
   * allocation and therefore fail closed until reviewed.
   */
  const ALLOCATED_GLOBAL_IPV6_PREFIXES = Object.freeze([
    [0x2001, 0x0200, 23],
    [0x2001, 0x0400, 23],
    [0x2001, 0x0600, 23],
    [0x2001, 0x0800, 22],
    [0x2001, 0x0c00, 23],
    [0x2001, 0x0e00, 23],
    [0x2001, 0x1200, 23],
    [0x2001, 0x1400, 22],
    [0x2001, 0x1800, 23],
    [0x2001, 0x1a00, 23],
    [0x2001, 0x1c00, 22],
    [0x2001, 0x2000, 19],
    [0x2001, 0x4000, 23],
    [0x2001, 0x4200, 23],
    [0x2001, 0x4400, 23],
    [0x2001, 0x4600, 23],
    [0x2001, 0x4800, 23],
    [0x2001, 0x4a00, 23],
    [0x2001, 0x4c00, 23],
    [0x2001, 0x5000, 20],
    [0x2001, 0x8000, 19],
    [0x2001, 0xa000, 20],
    [0x2001, 0xb000, 20],
    [0x2003, 0x0000, 18],
    [0x2400, 0x0000, 12],
    [0x2410, 0x0000, 12],
    [0x2600, 0x0000, 12],
    [0x2610, 0x0000, 23],
    [0x2620, 0x0000, 23],
    [0x2630, 0x0000, 12],
    [0x2800, 0x0000, 12],
    [0x2a00, 0x0000, 12],
    [0x2a10, 0x0000, 12],
    [0x2c00, 0x0000, 12],
  ]);

  function isAllocatedGlobalIpv6(words) {
    return ALLOCATED_GLOBAL_IPV6_PREFIXES.some(
      ([firstWord, secondWord, prefixLength]) =>
        ipv6MatchesAllocation(words, firstWord, secondWord, prefixLength)
    );
  }

  function isPrivateIpv4(bytes) {
    if (!bytes) return true;
    const [a, b, c] = bytes;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  /**
   * Detect literal private/special-use hosts without performing DNS lookups.
   * URL parsing first canonicalizes legacy numeric IPv4 spellings.
   */
  function isPrivateHost(input) {
    const hostname = normalizedHostname(input);
    if (!hostname) return true;

    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname === "home.arpa" ||
      hostname.endsWith(".home.arpa")
    ) {
      return true;
    }

    const ipv4 = parseIpv4(hostname);
    if (ipv4) return isPrivateIpv4(ipv4);

    if (hostname.includes(":")) {
      const words = parseIpv6(hostname);
      if (!words) return true;
      const allZero = words.every((word) => word === 0);
      const loopback =
        words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
      if (allZero || loopback) return true;

      // Unique-local, deprecated site-local, link-local, multicast,
      // discard-only, documentation, and other literal special-use ranges
      // must never receive preview header relaxation.
      if ((words[0] & 0xfe00) === 0xfc00) return true;
      if ((words[0] & 0xffc0) === 0xfec0) return true;
      if ((words[0] & 0xffc0) === 0xfe80) return true;
      if ((words[0] & 0xff00) === 0xff00) return true;
      if (
        words[0] === 0x0064 &&
        words[1] === 0xff9b &&
        words[2] === 0x0001
      ) {
        return true;
      }
      // IANA discard-only and dummy prefixes.
      if (
        words[0] === 0x0100 &&
        words[1] === 0 &&
        words[2] === 0 &&
        (words[3] === 0 || words[3] === 1)
      ) {
        return true;
      }
      if (words[0] === 0x2001 && words[1] === 0x0db8) return true;

      const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
      if (firstFiveZero && words[5] === 0xffff) {
        return isPrivateIpv4(ipv4FromWords(words[6], words[7]));
      }
      // Deprecated IPv4-compatible literals use ::/96. Treat their embedded
      // special-use IPv4 endpoint exactly like an ordinary IPv4 literal.
      if (words.slice(0, 6).every((word) => word === 0)) {
        return isPrivateIpv4(ipv4FromWords(words[6], words[7]));
      }
      // The well-known NAT64 prefix embeds an IPv4 endpoint and is globally
      // reachable only when that endpoint itself is public.
      if (
        words[0] === 0x0064 &&
        words[1] === 0xff9b &&
        words.slice(2, 6).every((word) => word === 0)
      ) {
        return isPrivateIpv4(ipv4FromWords(words[6], words[7]));
      }

      if (!isAllocatedGlobalIpv6(words)) return true;
    }

    return false;
  }

  function ruleHost(rule) {
    const raw =
      typeof rule === "string"
        ? rule
        : rule && (rule.domain || rule.host || rule.hostname || rule.pattern);
    if (typeof raw !== "string") return "";
    return normalizedHostname(raw.replace(/^\*\./, ""));
  }

  function ruleEnabled(rule) {
    if (typeof rule === "string") return false;
    if (!rule || typeof rule !== "object") return null;
    if (typeof rule.enabled === "boolean") return rule.enabled;
    if (typeof rule.allow === "boolean") return rule.allow;

    const action = String(rule.action || rule.decision || "").toLowerCase();
    if (["allow", "enable", "enabled", "on"].includes(action)) return true;
    if (["deny", "disable", "disabled", "off", "block"].includes(action)) {
      return false;
    }
    return null;
  }

  /**
   * Apply the most-specific matching hostname rule. A child-domain rule can
   * therefore explicitly override its parent-domain rule. Ties use the last
   * rule so a later user edit wins deterministically.
   */
  function siteDecision(hostOrUrl, rules, defaultEnabled = true) {
    const hostname = normalizedHostname(hostOrUrl);
    if (!hostname || !Array.isArray(rules)) return !!defaultEnabled;

    let enabled = !!defaultEnabled;
    let bestSpecificity = -1;

    rules.forEach((rule) => {
      const domain = ruleHost(rule);
      const decision = ruleEnabled(rule);
      if (!domain || decision == null) return;
      if (hostname !== domain && !hostname.endsWith(`.${domain}`)) return;

      const specificity = domain.split(".").length * 10000 + domain.length;
      if (specificity >= bestSpecificity) {
        bestSpecificity = specificity;
        enabled = decision;
      }
    });

    return enabled;
  }

  root.GlassPeek = Object.freeze({
    DEFAULTS,
    normalizeUrl,
    previewTargetUrl,
    previewDisplayUrl,
    siteDecision,
    isPrivateHost,
  });
})(globalThis);
