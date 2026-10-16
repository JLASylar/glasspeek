'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { HOST, ROUTES, createTestServer } = require('./test-server');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_LOCALES = Object.freeze(['en', 'zh_CN', 'zh_TW']);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function walk(directory, predicate, output = []) {
  const excluded = new Set([
    'tests',
    'web-ext-artifacts',
    '.git',
    'backups',
    'output',
    '.playwright-cli',
  ]);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, predicate, output);
    else if (predicate(absolute)) output.push(absolute);
  }
  return output;
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function findAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? match[2] : null;
}

function openingTag(html, tagName, id) {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) || [];
  const found = tags.find((tag) => findAttribute(tag, 'id') === id);
  assert.ok(found, `<${tagName} id="${id}"> must exist`);
  return found;
}

function loadCommonProtocol() {
  const context = vm.createContext({ URL });
  vm.runInContext(read('shared/common.js'), context, { filename: 'shared/common.js' });
  assert.ok(context.GlassPeek, 'shared/common.js must publish GlassPeek');
  return context.GlassPeek;
}

function httpRequest(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body == null ? null : Buffer.from(options.body);
    const request = http.request(
      {
        host: HOST,
        port,
        path: requestPath,
        method: options.method || 'GET',
        headers: {
          ...(body ? { 'Content-Length': body.byteLength } : {}),
          ...(options.headers || {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const manifest = JSON.parse(read('manifest.json'));
const jsFiles = walk(ROOT, (file) => file.endsWith('.js'));
const htmlFiles = walk(ROOT, (file) => file.endsWith('.html'));
const cssFiles = walk(ROOT, (file) => file.endsWith('.css'));
const javascript = jsFiles.map((file) => `\n/* ${relative(file)} */\n${fs.readFileSync(file, 'utf8')}`).join('\n');

test('embedding-header compatibility is confined to the verified preview frame', () => {
  const permissions = manifest.permissions || [];
  const background = read('background.js');
  const treeResolver = background.slice(
    background.indexOf('function previewTreeRequestSession'),
    background.indexOf('function responseHasEmbeddingProtection'),
  );
  const requestListener = background.slice(
    background.indexOf('async function previewCompatibilityRequest'),
    background.indexOf('function previewCompatibilityHeaders'),
  );
  const compatibilityListener = background.slice(
    background.indexOf('function previewCompatibilityHeaders'),
    background.indexOf('browser.webRequest.onHeadersReceived.addListener'),
  );
  assert.ok(permissions.includes('webRequest'));
  assert.ok(permissions.includes('webRequestBlocking'));
  assert.match(background, /browser\.webRequest\.onHeadersReceived\.addListener/);
  assert.match(background, /types:\s*\[["']sub_frame["']\]/);
  assert.match(
    treeResolver,
    /sessionsByDirectTargetFrame\.get\(\s*directTargetKey\(details\.tabId,\s*details\.frameId\)/,
  );
  assert.match(treeResolver, /details\.parentFrameId === 0/);
  assert.match(
    treeResolver,
    /details\.parentDocumentId === directSession\.ownerDocumentId/,
  );
  assert.match(treeResolver, /const ancestors = Array\.isArray\(details\.frameAncestors\)/);
  assert.match(
    treeResolver,
    /const immediateParent = ancestors\[0\]/,
  );
  assert.match(
    treeResolver,
    /immediateParent\.frameId !== details\.parentFrameId/,
  );
  assert.match(treeResolver, /topAncestor\.frameId !== 0/);
  assert.match(
    treeResolver,
    /const session = targetTreeSession\(details\.tabId,\s*details\.frameId\)/,
  );
  assert.match(
    treeResolver,
    /session\.targetTreeDocumentIds\?\.get\(session\.directTargetFrameId\) !==[\s\S]*?session\.targetDocumentId/,
  );
  assert.match(
    treeResolver,
    /session\.targetTreeDocumentIds\?\.get\(0\) !== session\.ownerDocumentId/,
  );
  assert.match(
    treeResolver,
    /session\.targetTreeDocumentIds\?\.get\(details\.parentFrameId\) !==[\s\S]*?details\.parentDocumentId/,
  );
  assert.match(
    treeResolver,
    /for\s*\(const ancestor of ancestors\)[\s\S]*?session\.targetTreeParents\?\.get\(childFrameId\)[\s\S]*?ancestor\.frameId !== expectedParentFrameId[\s\S]*?if\s*\(childFrameId !== 0\)\s*return null/,
  );
  assert.doesNotMatch(
    treeResolver,
    /ancestor\.documentId|directAncestor\.documentId|topAncestor\.documentId/,
    'Firefox omits documentId inside frameAncestors; exact document binding must use the parent document map',
  );
  assert.match(
    compatibilityListener,
    /const session = previewTreeRequestSession\(details\)/,
  );
  assert.doesNotMatch(
    compatibilityListener,
    /registerTargetTreeFrame|bindTargetTreeFrame/,
    'the blocking header listener may verify but must never mutate the target tree',
  );
  assert.match(background, /name === ["']x-frame-options["']/);
  assert.match(background, /name === ["']content-security-policy["']/);
  assert.match(background, /name === ["']content-security-policy-report-only["']/);
  assert.match(background, /stripFrameAncestors\(original\)/);
  assert.doesNotMatch(background, /\bfilterResponseData\b/);
  assert.match(requestListener, /const session = previewTreeRequestSession\(details\)/);
  assert.match(requestListener, /if\s*\(!session \|\| session\.destroyed\)\s*return undefined/);
  assert.match(requestListener, /const status = await publicResolvedUrl\(url\)/);
  assert.match(requestListener, /status === ["']private["'][\s\S]*?return \{ cancel:\s*true \}/);
  assert.doesNotMatch(
    requestListener,
    /requestUsesRemoteProxy\(details\)[\s\S]*?return \{ cancel:\s*true \}/,
    'proxy and TUN requests must reach response-stage origin verification',
  );
  assert.doesNotMatch(
    requestListener,
    /status === ["']unknown["'][\s\S]*?return \{ cancel:\s*true \}/,
    'DNS-unavailable requests must reach response-stage origin verification',
  );
  assert.match(
    compatibilityListener,
    /const origin = await verifiedResponseOrigin\(details,\s*url\)/,
  );
  assert.match(
    compatibilityListener,
    /origin\.hardPrivatePeer[\s\S]*?return \{ cancel:\s*true \}/,
  );
  assert.ok(
    compatibilityListener.indexOf('origin.hardPrivatePeer') <
      compatibilityListener.indexOf('stripFrameAncestors(original)'),
    'the actual peer address must be validated before any embedding protection is weakened',
  );
  assert.match(
    compatibilityListener,
    /!origin\.verified && responseHasEmbeddingProtection\(details\.responseHeaders\)[\s\S]*?return undefined/,
  );
  const unverifiedProtectedBranch = compatibilityListener.slice(
    compatibilityListener.indexOf('if (!origin.verified && responseHasEmbeddingProtection'),
    compatibilityListener.indexOf('if (isDirectTarget)', compatibilityListener.indexOf('if (!origin.verified && responseHasEmbeddingProtection')),
  );
  assert.doesNotMatch(
    unverifiedProtectedBranch,
    /blockDirectPreviewRequest/,
    'an untouched SAMEORIGIN/self response must be allowed to let Firefox make the safe embedding decision',
  );
  assert.match(
    requestListener,
    /browser\.webRequest\.onBeforeRequest\.addListener\([\s\S]*?types:\s*\[["']sub_frame["']\][\s\S]*?\[["']blocking["']\]/,
  );
});

test('sidebar header compatibility verifies every direct-frame navigation hop', () => {
  const background = read('background.js');
  const sidebar = read('sidebar/sidebar.js');
  const armHandler = background.slice(
    background.indexOf('if (message.type === "gp-sidebar-arm")'),
    background.indexOf('if (message.type === "gp-sidebar-get")'),
  );
  const surfaceResolver = background.slice(
    background.indexOf('function sidebarSurfaceForRequest'),
    background.indexOf('function notifySidebarBlocked'),
  );
  const requestListener = background.slice(
    background.indexOf('async function sidebarCompatibilityRequest'),
    background.indexOf('function sidebarCompatibilityHeaders'),
  );
  const headerListener = background.slice(
    background.indexOf('function sidebarCompatibilityHeaders'),
    background.indexOf('function destroySession'),
  );
  const blockedHandler = sidebar.slice(
    sidebar.indexOf('message.type === "gp-sidebar-blocked"'),
    sidebar.indexOf('window.addEventListener("message"'),
  );

  assert.match(armHandler, /sender\.url !== SIDEBAR_URL/);
  assert.match(armHandler, /typeof sender\.documentId !== ["']string["']/);
  assert.match(armHandler, /\(await publicResolvedUrl\(url\)\) === ["']private["']/);
  assert.match(
    armHandler,
    /sidebarSurfacesByDocument\.set\(sender\.documentId,\s*\{[\s\S]*?documentId:\s*sender\.documentId[\s\S]*?generation:\s*randomHex\(16\)[\s\S]*?url[\s\S]*?armedAt:\s*now/,
  );
  assert.match(
    armHandler,
    /return \{[\s\S]*?ok:\s*true[\s\S]*?documentId:\s*sender\.documentId[\s\S]*?generation:\s*surface\.generation/,
  );

  assert.match(surfaceResolver, /typeof details\.parentDocumentId !== ["']string["']/);
  assert.match(
    surfaceResolver,
    /sidebarSurfacesByDocument\.get\(details\.parentDocumentId\)/,
  );
  assert.match(surfaceResolver, /return surface \|\| null/);
  assert.match(
    surfaceResolver,
    /const requestId =[\s\S]*?typeof details\.requestId === ["']string["'][\s\S]*?sidebarRequestsById\.get\(requestId\)/,
  );
  assert.match(
    surfaceResolver,
    /existing\.tabId !== details\.tabId[\s\S]*?existing\.frameId !== details\.frameId[\s\S]*?existing\.parentDocumentId !== details\.parentDocumentId[\s\S]*?return \{ denied:\s*true \}/,
  );
  assert.match(
    surfaceResolver,
    /documentId:\s*surface\.documentId[\s\S]*?generation:\s*surface\.generation[\s\S]*?tabId:\s*details\.tabId[\s\S]*?frameId:\s*details\.frameId[\s\S]*?parentDocumentId:\s*details\.parentDocumentId[\s\S]*?sidebarRequestsById\.set\(requestId,\s*requestSurface\)/,
  );
  assert.match(
    surfaceResolver,
    /function sidebarSurfaceGenerationIsCurrent\(surface\)[\s\S]*?sidebarSurfacesByDocument\.get\(surface\.documentId\)[\s\S]*?current\.generation === surface\.generation/,
  );

  assert.match(requestListener, /const surface = sidebarRequestSurface\(details\)/);
  assert.match(requestListener, /if\s*\(surface\.denied\)\s*return \{ cancel:\s*true \}/);
  assert.doesNotMatch(
    requestListener,
    /requestUsesRemoteProxy\(details\)[\s\S]*?return \{ cancel:\s*true \}/,
  );
  assert.match(requestListener, /const status = await publicResolvedUrl\(url\)/);
  assert.match(
    requestListener,
    /if\s*\(!sidebarSurfaceGenerationIsCurrent\(surface\)\)\s*return \{ cancel:\s*true \}/,
  );
  assert.match(requestListener, /status === ["']private["'][\s\S]*?return \{ cancel:\s*true \}/);
  assert.match(requestListener, /surface\.verifiedUrl = url/);
  assert.match(
    requestListener,
    /browser\.webRequest\.onBeforeRequest\.addListener\([\s\S]*?types:\s*\[["']sub_frame["']\][\s\S]*?\[["']blocking["']\]/,
  );

  assert.match(headerListener, /const surface = sidebarRequestSurface\(details,\s*false\)/);
  assert.match(headerListener, /if\s*\(surface\.denied\)\s*return \{ cancel:\s*true \}/);
  assert.match(
    headerListener,
    /!sidebarSurfaceGenerationIsCurrent\(surface\)[\s\S]*?surface\.verifiedUrl !== url[\s\S]*?return \{ cancel:\s*true \}/,
  );
  assert.match(
    headerListener,
    /const origin = await verifiedResponseOrigin\(details,\s*url\)/,
  );
  assert.match(
    headerListener,
    /origin\.hardPrivatePeer[\s\S]*?return \{ cancel:\s*true \}/,
  );
  assert.ok(
    headerListener.indexOf('origin.hardPrivatePeer') <
      headerListener.indexOf('stripFrameAncestors(original)'),
    'the sidebar must validate the actual peer address before weakening embedding protection',
  );
  assert.match(
    headerListener,
    /!origin\.verified && responseHasEmbeddingProtection\(details\.responseHeaders\)[\s\S]*?return undefined/,
  );
  assert.match(
    headerListener,
    /browser\.webRequest\.onHeadersReceived\.addListener\([\s\S]*?types:\s*\[["']sub_frame["']\][\s\S]*?\[["']blocking["'],\s*["']responseHeaders["']\]/,
  );
  assert.match(
    headerListener,
    /function cleanupSidebarRequest\(details\)[\s\S]*?sidebarRequestsById\.delete\(details\.requestId\)[\s\S]*?onCompleted\.addListener\(cleanupSidebarRequest[\s\S]*?onErrorOccurred\.addListener\(cleanupSidebarRequest/,
  );

  assert.match(blockedHandler, /message\.documentId !== state\.surfaceDocumentId/);
  assert.match(blockedHandler, /message\.generation !== state\.surfaceGeneration/);
  assert.doesNotMatch(
    blockedHandler,
    /\.origin|currentOrigin/,
    'a capability-matched blocked notice may report a cross-origin direct-frame navigation',
  );
});

test('proxy evidence is fail-closed except for absent or explicitly direct proxyInfo', () => {
  const background = read('background.js');
  const start = background.indexOf('function requestUsesRemoteProxy');
  const end = background.indexOf('function cloneSettings', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(
    `${background.slice(start, end)}
result = JSON.stringify([
  requestUsesRemoteProxy({}),
  requestUsesRemoteProxy({ proxyInfo: null }),
  requestUsesRemoteProxy({ proxyInfo: { type: "direct" } }),
  requestUsesRemoteProxy({ proxyInfo: { type: "DIRECT" } }),
  requestUsesRemoteProxy({ proxyInfo: { type: "unknown" } }),
  requestUsesRemoteProxy({ proxyInfo: {} }),
  requestUsesRemoteProxy({ proxyInfo: { type: "socks" } })
]);`,
    context,
  );
  assert.deepEqual(
    JSON.parse(context.result),
    [false, false, false, false, true, true, true],
  );
});

test('known Mihomo fake-IP transports are narrowly recognized without reclassifying private literals', () => {
  const background = read('background.js');
  const start = background.indexOf('function canonicalResolvedAddress');
  const end = background.indexOf('async function publicResolvedUrl', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(
    `${background.slice(start, end)}
result = JSON.stringify({
  ipv4: isKnownSyntheticProxyAddress("198.18.8.68"),
  adjacentBenchmarkHalf: isKnownSyntheticProxyAddress("198.19.0.1"),
  ipv6: isKnownSyntheticProxyAddress("fdfe:dcba:9876::31a"),
  adjacentIpv6Prefix: isKnownSyntheticProxyAddress("fdfe:dcba:9876:1::31a"),
  canonicalIpv6: canonicalResolvedAddress("FDFE:DCBA:9876:0:0:0:0:031A"),
  ordinaryPrivate: isKnownSyntheticProxyAddress("192.168.1.10"),
  ordinaryUla: isKnownSyntheticProxyAddress("fd12:3456::1"),
  mixedRecord: resolvedAddressesAreSyntheticProxy(["198.18.0.16", "8.8.8.8"]),
  syntheticRecord: resolvedAddressesAreSyntheticProxy([
    "198.18.0.16",
    "fdfe:dcba:9876::77"
  ])
});`,
    context,
  );
  assert.deepEqual(JSON.parse(context.result), {
    ipv4: true,
    adjacentBenchmarkHalf: false,
    ipv6: true,
    adjacentIpv6Prefix: false,
    canonicalIpv6: 'fdfe:dcba:9876:0000:0000:0000:0000:031a',
    ordinaryPrivate: false,
    ordinaryUla: false,
    mixedRecord: false,
    syntheticRecord: true,
  });
  assert.match(
    background,
    /getSecurityInfo\([\s\S]*?securityInfo\.state === ["']secure["'][\s\S]*?securityInfo\.state === ["']weak["']/,
    'proxied HTTPS responses must use Firefox TLS-origin evidence before embedding headers are relaxed',
  );
  assert.match(
    background,
    /!remoteProxy && actualPrivate && !syntheticTransportPeer/,
    'unexpected direct private peers must remain a hard DNS-rebinding block',
  );
  assert.match(
    background,
    /evidence\.addresses\.includes\(actualAddress\)/,
    'a synthetic transport address must match the fresh hostname evidence exactly',
  );
  assert.doesNotMatch(
    background,
    /directPublicPeer \|\| syntheticTransportPeer/,
    'a fake-IP transport handle alone must never authorize header relaxation',
  );
});

test('response origin verification keeps private peers closed while accepting authenticated proxy HTTPS', async () => {
  const background = read('background.js');
  const start = background.indexOf('async function verifiedResponseOrigin');
  const end = background.indexOf('function cloneSettings', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    evidence: null,
    securityState: 'secure',
    securityErrorCategory: '',
    securityChecks: 0,
    requestUsesRemoteProxy(details) {
      return details.proxy === true;
    },
    canonicalResolvedAddress(value) {
      return String(value || '').toLowerCase();
    },
    resolvedAddressIsPrivate(value) {
      return (
        /^192\.168\./.test(value) ||
        /^127\./.test(value) ||
        /^198\.18\./.test(value)
      );
    },
    resolvedEvidenceForUrl() {
      return context.evidence;
    },
    isKnownSyntheticProxyAddress(value) {
      return /^198\.18\./.test(value);
    },
    browser: {
      webRequest: {
        async getSecurityInfo() {
          context.securityChecks += 1;
          return {
            state: context.securityState,
            certificates: [{ subject: 'CN=example.test' }],
            overridableErrorCategory: context.securityErrorCategory || undefined,
          };
        },
      },
    },
  };
  vm.runInNewContext(background.slice(start, end), context);

  let result = await context.verifiedResponseOrigin(
    { requestId: 'public', ip: '8.8.8.8' },
    'https://example.com/',
  );
  assert.equal(result.verified, true);
  assert.equal(result.hardPrivatePeer, false);
  assert.equal(context.securityChecks, 0);

  context.evidence = null;
  result = await context.verifiedResponseOrigin(
    { requestId: 'private', ip: '192.168.1.9' },
    'https://example.com/',
  );
  assert.equal(result.verified, false);
  assert.equal(result.hardPrivatePeer, true);
  assert.equal(context.securityChecks, 0);

  context.evidence = {
    status: 'synthetic',
    addresses: ['198.18.8.68'],
  };
  context.securityState = 'secure';
  result = await context.verifiedResponseOrigin(
    { requestId: 'fake-exact', ip: '198.18.8.68' },
    'https://www.cnn.com/world',
  );
  assert.equal(result.verified, true);
  assert.equal(result.hardPrivatePeer, false);
  assert.equal(context.securityChecks, 1);

  result = await context.verifiedResponseOrigin(
    { requestId: 'fake-mismatch', ip: '198.18.8.69' },
    'https://www.cnn.com/world',
  );
  assert.equal(result.verified, false);
  assert.equal(result.hardPrivatePeer, true);
  assert.equal(context.securityChecks, 1);

  result = await context.verifiedResponseOrigin(
    { requestId: 'fake-http', ip: '198.18.8.68' },
    'http://www.cnn.com/world',
  );
  assert.equal(result.verified, false);
  assert.equal(result.hardPrivatePeer, false);
  assert.equal(context.securityChecks, 1);

  context.evidence = null;
  context.securityState = 'secure';
  result = await context.verifiedResponseOrigin(
    { requestId: 'proxy-secure', ip: '127.0.0.1', proxy: true },
    'https://example.com/',
  );
  assert.equal(result.verified, true);
  assert.equal(result.hardPrivatePeer, false);

  context.securityState = 'insecure';
  result = await context.verifiedResponseOrigin(
    { requestId: 'proxy-insecure', ip: '127.0.0.1', proxy: true },
    'https://example.com/',
  );
  assert.equal(result.verified, false);
  assert.equal(result.hardPrivatePeer, false);

  context.securityState = 'secure';
  context.securityErrorCategory = 'domain_mismatch';
  result = await context.verifiedResponseOrigin(
    { requestId: 'proxy-cert-exception', ip: '127.0.0.1', proxy: true },
    'https://example.com/',
  );
  assert.equal(result.verified, false);
  assert.equal(result.hardPrivatePeer, false);
});

test('frame compatibility removes only embedding directives', () => {
  const background = read('background.js');
  const start = background.indexOf('function stripFrameAncestors');
  const end = background.indexOf('function previewTreeRequestSession', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(
    `${background.slice(start, end)}\nresult = stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src https:");`,
    context,
  );
  assert.equal(context.result, "default-src 'self'; img-src https:");
  vm.runInNewContext(
    `${background.slice(start, end)}\nresult = stripFrameAncestors("default-src 'none'; script-src 'self'");`,
    context,
  );
  assert.equal(context.result, "default-src 'none'; script-src 'self'");
});

test('descendant preview frames keep every protection the direct target would enforce as top level', () => {
  const background = read('background.js');
  const compatibilityListener = background.slice(
    background.indexOf('function previewCompatibilityHeaders'),
    background.indexOf('browser.webRequest.onHeadersReceived.addListener'),
  );
  assert.match(
    compatibilityListener,
    /const simulation = isDirectTarget\s*\?\s*null\s*:\s*descendantEmbeddingSimulation\(details,\s*url\)/,
  );
  assert.match(compatibilityListener, /if \(!isDirectTarget && !simulation\) return undefined/);
  assert.match(
    compatibilityListener,
    /isDirectTarget \|\|\s*descendantFrameOptionsRemovable\(header\.value,\s*simulation\)/,
  );
  assert.match(
    compatibilityListener,
    /isDirectTarget\s*\?\s*stripFrameAncestors\(original\)\s*:\s*stripFrameAncestors\(original,\s*simulation\.frameAncestorsAllow\)/,
  );

  const start = background.indexOf('function stripFrameAncestors');
  const end = background.indexOf('function previewTreeRequestSession', start);
  const context = { URL };
  vm.runInNewContext(background.slice(start, end), context);
  const {
    descendantEmbeddingSimulation,
    descendantFrameOptionsRemovable,
    stripFrameAncestors,
  } = context;
  const owner = { frameId: 0, url: 'https://owner.example/article' };
  const direct = { frameId: 5, url: 'https://site.example/page' };

  // A third-party iframe inside the previewed page: nothing is relaxed.
  const third = descendantEmbeddingSimulation(
    { frameAncestors: [direct, owner] },
    'https://third.example/widget',
  );
  assert.ok(third);
  assert.equal(third.allowsSameOrigin, false);
  assert.equal(descendantFrameOptionsRemovable('DENY', third), false);
  assert.equal(descendantFrameOptionsRemovable('SAMEORIGIN', third), false);
  for (const policy of [
    "frame-ancestors 'none'",
    "frame-ancestors 'self'",
    'frame-ancestors https://owner.example',
    "default-src 'self'; frame-ancestors https://partner.example",
  ]) {
    assert.equal(stripFrameAncestors(policy, third.frameAncestorsAllow), policy);
  }
  // ...unless the third party explicitly allows the direct target as embedder.
  assert.equal(
    stripFrameAncestors("img-src https:; frame-ancestors https://site.example", third.frameAncestorsAllow),
    'img-src https:',
  );
  assert.equal(
    stripFrameAncestors('frame-ancestors https://*.example:*', third.frameAncestorsAllow),
    '',
  );
  assert.equal(
    stripFrameAncestors('frame-ancestors https:', third.frameAncestorsAllow),
    '',
  );
  assert.equal(
    stripFrameAncestors('frame-ancestors https://site.example/other/', third.frameAncestorsAllow),
    'frame-ancestors https://site.example/other/',
  );

  // A same-origin iframe of the previewed page: SAMEORIGIN / 'self' are the
  // only protections that the simulated top-level chain already satisfies.
  const same = descendantEmbeddingSimulation(
    { frameAncestors: [direct, owner] },
    'https://site.example/embed',
  );
  assert.equal(same.allowsSameOrigin, true);
  assert.equal(descendantFrameOptionsRemovable('SAMEORIGIN', same), true);
  assert.equal(descendantFrameOptionsRemovable('sameorigin ', same), true);
  assert.equal(descendantFrameOptionsRemovable('DENY', same), false);
  assert.equal(descendantFrameOptionsRemovable('ALLOW-FROM https://x.example', same), false);
  assert.equal(descendantFrameOptionsRemovable('SAMEORIGIN, DENY', same), false);
  assert.equal(
    stripFrameAncestors("default-src 'self'; frame-ancestors 'self'", same.frameAncestorsAllow),
    "default-src 'self'",
  );
  assert.equal(
    stripFrameAncestors("frame-ancestors 'none'", same.frameAncestorsAllow),
    "frame-ancestors 'none'",
  );
  assert.equal(
    stripFrameAncestors(
      "frame-ancestors 'self', frame-ancestors https://other.example",
      same.frameAncestorsAllow,
    ),
    'frame-ancestors https://other.example',
  );

  // A deeper chain: every intermediate ancestor must satisfy the policy too.
  const deep = descendantEmbeddingSimulation(
    {
      frameAncestors: [
        { frameId: 9, url: 'about:srcdoc' },
        { frameId: 7, url: 'https://cdn.example/wrapper' },
        direct,
        owner,
      ],
    },
    'https://site.example/embed',
  );
  assert.equal(deep.allowsSameOrigin, false);
  assert.equal(descendantFrameOptionsRemovable('SAMEORIGIN', deep), false);
  assert.equal(
    stripFrameAncestors("frame-ancestors 'self'", deep.frameAncestorsAllow),
    "frame-ancestors 'self'",
  );
  assert.equal(
    stripFrameAncestors("frame-ancestors 'self' https://cdn.example", deep.frameAncestorsAllow),
    '',
  );

  // Chains that cannot be simulated never relax anything.
  assert.equal(descendantEmbeddingSimulation({ frameAncestors: [owner] }, 'https://x.example/'), null);
  assert.equal(
    descendantEmbeddingSimulation(
      { frameAncestors: [{ frameId: 7, url: 'blob:https://site.example/x' }, direct, owner] },
      'https://site.example/embed',
    ),
    null,
  );
  assert.equal(descendantEmbeddingSimulation({ frameAncestors: [direct, owner] }, 'ftp://x.example/'), null);
});

test('runtime code has no HTML injection or string-code execution sinks', () => {
  const forbidden = [
    /\.innerHTML\s*=/,
    /\.outerHTML\s*=/,
    /\.insertAdjacentHTML\s*\(/,
    /\bdocument\.write(?:ln)?\s*\(/,
    /\.srcdoc\s*=/,
    /(?:^|[^\w$.])eval\s*\(/m,
    /\bnew\s+Function\s*\(/,
    /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(javascript, pattern, `forbidden dynamic-code/HTML sink: ${pattern}`);
  }

  const preview = read('preview/preview.js');
  assert.match(preview, /pageTitle["']\)\.textContent\s*=/);
  assert.match(preview, /errorTitle["']\)\.textContent\s*=/);
});

test('all executable resources are packaged locally', () => {
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, 'utf8');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${relative(htmlFile)} contains an inline event handler`);
    const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
    for (const tag of scriptTags) {
      const src = findAttribute(tag, 'src');
      assert.ok(src, `${relative(htmlFile)} contains an inline script`);
      assert.doesNotMatch(src, /^(?:https?:)?\/\//i, `${relative(htmlFile)} loads a remote script`);
      const resolved = path.resolve(path.dirname(htmlFile), src.split(/[?#]/, 1)[0]);
      assert.ok(resolved.startsWith(`${ROOT}${path.sep}`), `${relative(htmlFile)} script escapes the package`);
      assert.ok(fs.existsSync(resolved), `${relative(htmlFile)} references missing script ${src}`);
    }
  }

  assert.doesNotMatch(javascript, /\bimportScripts\s*\(\s*["'`](?:https?:)?\/\//i);
  assert.doesNotMatch(javascript, /\bimport\s*\(\s*["'`](?:https?:)?\/\//i);
  assert.doesNotMatch(javascript, /\bnew\s+(?:Shared)?Worker\s*\(\s*["'`](?:https?:)?\/\//i);
  for (const cssFile of cssFiles) {
    const css = fs.readFileSync(cssFile, 'utf8');
    assert.doesNotMatch(css, /@import\s+(?:url\()?\s*["']?https?:\/\//i, `${relative(cssFile)} imports remote CSS`);
  }

  const csp = manifest.content_security_policy || '';
  assert.match(csp, /script-src\s+'self'/);
  assert.match(csp, /(?:^|;\s*)connect-src\s+'self'\s*(?:;|$)/);
  assert.doesNotMatch(csp, /connect-src[^;]*(?:https?:|\*)/i);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline/i);
});

test('page-owned UI is isolated in a closed shadow root', () => {
  const content = read('content.js');
  assert.match(content, /attachShadow\s*\(\s*\{\s*mode\s*:\s*["']closed["']\s*\}\s*\)/);
  assert.doesNotMatch(content, /attachShadow\s*\([^)]*mode\s*:\s*["']open["']/);
});

test('direct target and control frames have reviewed isolation and permissions', () => {
  const html = read('preview/preview.html');
  const content = read('content.js');
  assert.doesNotMatch(html, /<iframe\b[^>]*id=["']target["']/i);
  assert.match(content, /target\.className = ["']gp-target["']/);
  const sandboxMatch = content.match(
    /target\.setAttribute\(\s*["']sandbox["']\s*,\s*["']([^"']+)["']\s*\)/,
  );
  assert.ok(sandboxMatch, 'direct target sandbox must be explicit');
  const sandbox = new Set(sandboxMatch[1].split(/\s+/).filter(Boolean));
  assert.deepEqual([...sandbox].sort(), [
    'allow-downloads',
    'allow-forms',
    'allow-modals',
    'allow-pointer-lock',
    'allow-presentation',
    'allow-same-origin',
    'allow-scripts',
    'allow-storage-access-by-user-activation',
  ]);

  const forbiddenSandboxTokens = [
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
  ];
  for (const token of forbiddenSandboxTokens) assert.ok(!sandbox.has(token), `${token} must stay disabled`);
  assert.match(content, /target\.setAttribute\(["']referrerpolicy["'], ["']strict-origin-when-cross-origin["']\)/);
  assert.match(content, /target\.setAttribute\(["']allowfullscreen["'], ["']["']\)/);
  assert.match(content, /target\.setAttribute\(["']loading["'], ["']eager["']\)/);

  const allowMatch = content.match(
    /target\.setAttribute\(\s*["']allow["']\s*,\s*"([^"]+)"\s*\)/,
  );
  assert.ok(allowMatch, 'direct target Permissions Policy must be explicit');
  const permissionsPolicy = allowMatch[1];
  for (const feature of ['autoplay', 'clipboard-write', 'encrypted-media', 'fullscreen', 'picture-in-picture', 'web-share']) {
    assert.match(permissionsPolicy, new RegExp(`(?:^|;)\\s*${feature}\\s+\\*(?:;|$)`));
  }
  for (const feature of [
    'camera',
    'microphone',
    'geolocation',
    'payment',
    'usb',
    'serial',
    'hid',
    'display-capture',
    'clipboard-read',
  ]) {
    assert.match(permissionsPolicy, new RegExp(`(?:^|;)\\s*${feature}\\s+'none'(?:;|$)`));
  }

  assert.match(content, /control\.setAttribute\(\s*["']sandbox["']\s*,\s*["']allow-scripts allow-same-origin allow-forms["']\s*\)/);
  assert.match(content, /control\.setAttribute\(\s*["']referrerpolicy["']\s*,\s*["']no-referrer["']\s*\)/);
  assert.match(manifest.content_security_policy, /frame-src\s+http:\s+https:/);
});

test('sandbox-blocked link targets always receive a deliberate destination', () => {
  const content = read('content.js');
  assert.match(content, /const interceptPreviewNavigation = \(event, middle = false\) =>/);
  assert.match(content, /if\s*\(\s*!remoteConfig\.active\s*\|\|\s*!event\.isTrusted\s*\)\s*return/);
  assert.match(content, /event\.origin !== EXTENSION_ORIGIN/);
  assert.match(content, /if\s*\(remoteSurfaceActive\)/);
  assert.doesNotMatch(content, /window\.parent\.postMessage\([^;]+,\s*["']\*["']\s*\)/);
  assert.match(content, /\(targetName && targetName !== ["']_self["']\)/);
  assert.match(content, /signalRemote\(["']new-preview["']/);
  assert.match(content, /signalRemote\(["']open-external["']/);
  assert.match(content, /reason:\s*["']download["']/);
  assert.match(content, /typeof exportFunction !== ["']function["']/);
  assert.match(content, /navigator\.userActivation\?\.isActive/);
  assert.match(content, /GP\.normalizeUrl\(value,\s*location\.href\)/);
  assert.match(content, /function installHistoryBridge\(\)/);
  assert.match(content, /signalRemote\(["']history-state["'],\s*snapshot\s*\)/);
  assert.match(content, /pendingHistorySignals\.push\(snapshot\)/);
  assert.match(content, /flushPendingHistorySignals\(\)/);
  assert.match(content, /navigatePreviewRoot\(found\.url\)/);
  assert.match(content, /form\.setAttribute\(["']target["'], ["']_self["']\)/);
  assert.doesNotMatch(
    content,
    /if\s*\(\s*!event\.isTrusted\s*\|\|\s*!remoteConfig\.openLinksInNewPreview\s*\)\s*return/,
    'disabled multi-window mode must not turn target=_blank clicks into no-ops',
  );
});

test('preview navigation controls and Firefox history are wired end to end', () => {
  const common = loadCommonProtocol();
  const html = read('preview/preview.html');
  const preview = read('preview/preview.js');
  const background = read('background.js');

  assert.equal(common.DEFAULTS.addPreviewToHistory, true);
  assert.ok(manifest.permissions.includes('history'));
  assert.ok(!Object.prototype.hasOwnProperty.call(manifest, 'optional_permissions'));
  for (const id of ['back', 'forward', 'stop', 'reload']) {
    openingTag(html, 'button', id);
  }
  for (const action of ['history-back', 'history-forward', 'stop', 'reload']) {
    assert.match(
      `${preview}\n${background}`,
      new RegExp(`["']${action}["']`),
      `${action} must be implemented`,
    );
  }
  assert.match(
    background,
    /function suppressesNavigationEvent\(session,\s*details\)\s*\{\s*return session\.suppressNavigationUntil >= Date\.now\(\)/,
  );
  assert.match(
    background,
    /session\.navigationGeneration \+= 1/,
  );
  assert.match(background, /PENDING_NAVIGATION_TIMEOUT_MS = 35_000/);
  assert.match(background, /throw codedError\(["']NAVIGATION_BUSY["']/);
  assert.match(background, /previousIndex:\s*session\.historyIndex/);
  assert.match(background, /navigationToken:\s*randomHex\(12\)/);
  assert.match(background, /type:\s*["']target-fallback-cancel["']/);
  assert.match(background, /pending\.navigationStarted/);
  assert.match(preview, /message\.type === ["']target-fallback-cancel["']/);
  assert.match(preview, /generation !== navigationGeneration/);
  assert.match(preview, /navigationToken !== pending\.navigationToken/);
  const targetHistoryBridge = read('content.js');
  assert.match(targetHistoryBridge, /const pendingHistorySignals = \[\]/);
  assert.match(targetHistoryBridge, /flushPendingHistorySignals\(\)/);
  assert.match(targetHistoryBridge, /pendingHistorySignals\.push\(snapshot\)/);
  assert.match(
    targetHistoryBridge,
    /remoteConfig\.active = true;[\s\S]*?remoteConfig\.role === ["']direct["'][\s\S]*?installHistoryBridge\(\);[\s\S]*?flushPendingHistorySignals\(\)/,
    'authenticated direct-target config must install and flush the History bridge',
  );
  const acceptTargetPort = background.slice(
    background.indexOf('async function acceptTargetPort'),
    background.indexOf('browser.runtime.onConnect.addListener'),
  );
  assert.ok(
    acceptTargetPort.indexOf('port.onMessage.addListener') <
      acceptTargetPort.indexOf('type: "config"'),
    'the background must listen before config triggers a synchronous startup-history flush',
  );
  assert.match(
    acceptTargetPort,
    /if\s*\(isDirect\)\s*\{[\s\S]*?const currentDocumentUrl\s*=[\s\S]*?session\.committedDocumentId === sender\.documentId[\s\S]*?session\.targetDocumentId === sender\.documentId[\s\S]*?displayUrl = currentDocumentUrl \|\| senderDisplayUrl/,
    'binding a target port must preserve a newer URL already observed in the same document',
  );
  const targetHistoryHandler = background.slice(
    background.indexOf('message.type === "history-state"'),
    background.indexOf('message.type === "open-external"'),
  );
  assert.match(
    targetHistoryHandler,
    /if\s*\(session\.pendingNavigation\)\s*return/,
    'the outgoing target document must not overwrite an explicit history selection',
  );
  const pendingSameDocumentSettlement = background.slice(
    background.indexOf('function settlePendingSameDocumentNavigation'),
    background.indexOf('async function handleSurfaceAction'),
  );
  assert.match(
    pendingSameDocumentSettlement,
    /documentId !== session\.targetDocumentId\s*\|\|\s*url !== pending\.expectedUrl/,
    'only the selected URL in the current target document may settle pending history',
  );
  assert.match(
    pendingSameDocumentSettlement,
    /clearPendingNavigation\(session,\s*false\)/,
    'a matching same-document history event must complete the pending navigation',
  );
  const browserHistoryHandler = background.slice(
    background.indexOf('browser.webNavigation.onHistoryStateUpdated'),
    background.indexOf('browser.webNavigation.onReferenceFragmentUpdated'),
  );
  assert.match(
    browserHistoryHandler,
    /settlePendingSameDocumentNavigation/,
    'browser history events must settle only the selected pending entry',
  );
  const browserFragmentHandler = background.slice(
    background.indexOf('browser.webNavigation.onReferenceFragmentUpdated'),
    background.indexOf('browser.tabs.onRemoved'),
  );
  assert.match(
    browserFragmentHandler,
    /settlePendingSameDocumentNavigation/,
    'fragment-only history must settle without waiting for a document commit',
  );
  const lifecycleHandlers = background.slice(
    background.indexOf('browser.webNavigation.onDOMContentLoaded'),
    background.indexOf('browser.webNavigation.onErrorOccurred'),
  );
  assert.equal(
    (lifecycleHandlers.match(/session\.currentUrl \|\| GP\.previewDisplayUrl/g) || []).length,
    3,
    'history finalization, DOMContentLoaded, and completed must preserve a newer same-document URL',
  );
  assert.match(
    browserHistoryHandler,
    /clearPendingBrowserHistoryEvent\(session\);\s*session\.currentUrl = url;\s*return;/,
    'a confirmed bridge signal must cancel any older delayed browser-history fallback',
  );
  assert.match(background, /browser\.history\.addUrl\(\{/);
  assert.match(background, /visitTime:\s*Date\.now\(\)/);
  assert.match(background, /session\.incognito/);
  const committedHandler = background.slice(
    background.indexOf('browser.webNavigation.onCommitted'),
    background.indexOf('browser.webNavigation.onDOMContentLoaded'),
  );
  assert.match(committedHandler, /maybeRecordPreviewHistory\(session,\s*url,\s*session\.currentTitle\)/);
  assert.doesNotMatch(committedHandler, /setTimeout/);
});

test('preview history uses its isolated URL ledger and never blanks the frame to stop', () => {
  const content = read('content.js');
  const preview = read('preview/preview.js');
  const background = read('background.js');
  const historyActions = background.slice(
    background.indexOf('else if (message.action === "history-back")'),
    background.indexOf('else if (message.action === "stop")'),
  );
  assert.match(historyActions, /prepareSessionNavigation\([\s\S]*?["']history-back["']/);
  assert.match(historyActions, /prepareSessionNavigation\([\s\S]*?["']history-forward["']/);
  assert.equal(
    (historyActions.match(/result\.commanded = false/g) || []).length,
    2,
    'Back and Forward must load the selected per-preview URL rather than joint iframe history',
  );
  assert.doesNotMatch(
    historyActions,
    /sendSessionTargetCommand\([\s\S]*?["']history-go["']/,
  );
  assert.match(content, /location\.reload\(\)/);
  assert.match(content, /window\.stop\(\)/);
  assert.match(background, /sendSessionTargetCommand\(session,\s*["']reload["']\)/);
  assert.match(preview, /result\.commanded === true/);
  assert.match(preview, /navigate\(targetUrl,\s*url\)/);
  assert.match(preview, /type:\s*["']target-navigate["']/);
  assert.match(content, /item\.target\.src = targetUrl/);
  assert.doesNotMatch(content, /target\.src\s*=\s*["']about:blank["']/);
});

test('outside-close shield consumes the complete click and cannot click through', () => {
  const content = read('content.js');
  assert.match(content, /\.gp-backdrop\.interactive\s*\{\s*pointer-events:\s*auto/);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu']) {
    assert.match(content, new RegExp(`["']${type}["']`));
  }
  assert.match(content, /event\.preventDefault\(\)/);
  assert.match(content, /event\.stopImmediatePropagation\(\)/);
  assert.match(content, /armActivationReleaseGuard\(pointerId\)/);
  assert.match(content, /current\.anchor\.setPointerCapture\(pointerId\)/);
  assert.match(content, /if\s*\(consumeActivationRelease\(event,\s*now\)\)\s*return/);
  assert.doesNotMatch(
    content,
    /backdrop\.addEventListener\(["'](?:pointerup|mouseup|click)["']/,
    'the backdrop must not reintroduce a release-only close path',
  );
  assert.doesNotMatch(
    content,
    /outsideSuppressUntil\s*=\s*now\s*\+\s*320;\s*setTimeout\(\(\)\s*=>\s*closeOutsideGesture\(\{/,
    'an orphan release/click must not close a newly opened preview',
  );
  assert.doesNotMatch(
    content,
    /document\.addEventListener\(["']mousedown["'][\s\S]{0,300}closeWindow\(/,
  );
});

test('page-script synthetic events cannot enter any source-page preview trigger', () => {
  const content = read('content.js');
  const sourceTriggers = content.indexOf('function canTrigger()');
  assert.ok(sourceTriggers >= 0);
  const trustedSourceHandlers = [
    ['pointerdown', 'pointermove'],
    ['click', 'pointerover'],
    ['pointerover', 'pointerout'],
    ['keydown', 'dragstart'],
    ['dragstart', 'dragover'],
    ['drop', 'dragend'],
    ['dragend', 'resize'],
  ];
  for (const [type, nextType] of trustedSourceHandlers) {
    const start = content.indexOf(
      `document.addEventListener("${type}", (event) => {`,
      sourceTriggers,
    );
    const nextDocumentHandler = content.indexOf(
      `document.addEventListener("${nextType}"`,
      start + 1,
    );
    const nextWindowHandler = content.indexOf(
      `window.addEventListener("${nextType}"`,
      start + 1,
    );
    const end = [nextDocumentHandler, nextWindowHandler]
      .filter((value) => value > start)
      .sort((left, right) => left - right)[0];
    assert.ok(start >= 0 && end > start, `source ${type} handler was not found`);
    assert.match(
      content.slice(start, end),
      /if\s*\([\s\S]{0,160}!event\.isTrusted[\s\S]{0,160}\)\s*return/,
      `source ${type} handler accepts page-script synthetic events`,
    );
  }
});

test('preview startup is parallel, progressive, and keeps the web canvas readable', () => {
  const content = read('content.js');
  const preview = read('preview/preview.js');
  const targetSource = content.indexOf('target.src = targetBootstrapUrl');
  const append = content.indexOf('layer.appendChild(frame)', targetSource);
  assert.ok(targetSource >= 0 && append > targetSource);
  assert.match(content, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*item\.frame\.classList\.add\(["']ready["']\)/);
  assert.match(content, /\.gp-target\s*\{[^}]*color-scheme:\s*light;[^}]*background:\s*#fff;/);
  assert.doesNotMatch(content, /prefers-color-scheme:\s*dark[^}]*\.gp-target/);
  assert.match(
    content,
    /\.gp-surface\.target-visible:not\(\.overlay\)\s+\.gp-control\s*\{[^}]*bottom:\s*auto;[^}]*height:\s*44px;/,
  );
  assert.match(content, /\.gp-control\s*\{[^}]*z-index:\s*1;/);
  assert.match(content, /\.gp-target\s*\{[^}]*z-index:\s*2;/);
  const positionResolver = content.slice(
    content.indexOf('function resolvePosition'),
    content.indexOf('function connectOwner'),
  );
  assert.match(positionResolver, /const edge = 8/);
  assert.match(positionResolver, /innerWidth - width - edge/);
  assert.match(positionResolver, /innerHeight - height - edge/);
  assert.doesNotMatch(
    positionResolver.slice(positionResolver.indexOf('const pair')),
    /-width \+ 60|innerWidth - 60|innerHeight - 44/,
  );
  assert.doesNotMatch(
    content,
    /\.gp-surface\.target-visible:not\(\.overlay\)\s+\.gp-control\s*\{[^}]*clip-path:/,
  );
  assert.match(content, /targetPresented:\s*false/);
  assert.match(content, /controlOverlayRequested:\s*false/);
  assert.match(
    content,
    /function syncSurfacePresentation\(item\)\s*\{[\s\S]*target-visible[\s\S]*targetPresented[\s\S]*overlay[\s\S]*controlOverlayRequested/,
  );
  assert.match(
    preview,
    /type:\s*["']target-overlay["'][\s\S]{0,120}value:\s*false/,
  );
  assert.match(preview, /presentation["'],\s*state:\s*["']progress["']/);
  assert.doesNotMatch(preview, /\?\s*0\s*:\s*320/);
});

test('preview identity never initiates a remote favicon request', () => {
  const preview = read('preview/preview.js');
  const identity = preview.slice(
    preview.indexOf('function updateIdentity'),
    preview.indexOf('function hostname', preview.indexOf('function updateIdentity')),
  );
  assert.match(identity, /\$\(["']favicon["']\)\.src = ["']\.\.\/icons\/icon\.svg["']/);
  assert.doesNotMatch(identity, /https?:|favicon\.ico|google\.com\/s2/i);
});

test('long signed commerce URLs remain inside the reviewed URL boundary', () => {
  const common = loadCommonProtocol();
  const longUrl = `https://example.com/item?token=${'a'.repeat(30000)}`;
  assert.equal(common.normalizeUrl(longUrl), longUrl);
  assert.match(read('shared/common.js'), /MAX_URL_LENGTH\s*=\s*32768/);
});

test('every public site uses the original URL and external windows are explicit only', () => {
  const commonSource = read('shared/common.js');
  const background = read('background.js');
  const content = read('content.js');
  const sidebar = read('sidebar/sidebar.js');
  assert.doesNotMatch(commonSource, /BUILTIN_COMPAT_DOMAINS/);
  assert.doesNotMatch(background, /BUILTIN_COMPAT_DOMAINS/);
  assert.doesNotMatch(background, /function compatibilityRequirement\(/);
  const rememberedFullPageMatch = content.slice(
    content.indexOf('function usesRememberedFullPage'),
    content.indexOf('const CONTENT_CSS'),
  );
  assert.match(
    rememberedFullPageMatch,
    /String\(value \|\| ""\)[\s\S]*?=== hostname/,
    'remembered full-page routing must use an exact normalized hostname',
  );
  assert.doesNotMatch(
    rememberedFullPageMatch,
    /endsWith/,
    'a remembered parent hostname must not force sibling or descendant hosts into full-page mode',
  );
  const compatDomainSettings = read('options/options.js').slice(
    read('options/options.js').indexOf('function renderCompatDomains'),
    read('options/options.js').indexOf('async function refreshHistoryPermissionState'),
  );
  assert.match(compatDomainSettings, /candidate !== hostname/);
  assert.match(compatDomainSettings, /scheduleSave\(\{\s*forceCompatDomains:\s*next\s*\}/);
  assert.equal(
    (background.match(/routeRequiredCompatibility\(/g) || []).length,
    4,
    'compatibility routing must be limited to its definition, the explicit action, and two remembered-domain gates',
  );
  const openCompatAction = background.slice(
    background.indexOf('else if (message.action === "open-compat")'),
    background.indexOf('else if (message.action === "history-back")'),
  );
  assert.match(openCompatAction, /routeRequiredCompatibility\(session,\s*\{/);
  assert.match(openCompatAction, /reason:\s*["']user["']/);
  assert.match(
    openCompatAction,
    /rememberDomain:\s*message\.rememberDomain === true/,
  );
  const targetNavigateRoot = background.slice(
    background.indexOf('message.type === "navigate-root"'),
    background.indexOf('message.type === "unsupported-link"'),
  );
  assert.match(
    targetNavigateRoot,
    /if\s*\(forcedCompatibilityHostname\(url,\s*session\.settings\)\)[\s\S]*?routeRequiredCompatibility\(session,\s*session\.compatRequired\)/,
  );
  const directCompatibilityRequest = background.slice(
    background.indexOf('async function previewCompatibilityRequest'),
    background.indexOf('browser.webRequest.onBeforeRequest.addListener'),
  );
  assert.match(
    directCompatibilityRequest,
    /if\s*\(isDirectTarget && forcedCompatibilityHostname\(url,\s*session\.settings\)\)[\s\S]*?routeRequiredCompatibility\(session,\s*\{[\s\S]*?reason:\s*["']remembered-domain["']/,
  );
  const compatibilityListener = background.slice(
    background.indexOf('function previewTreeRequestSession'),
    background.indexOf('function destroySession'),
  );
  assert.match(compatibilityListener, /sessionsByDirectTargetFrame\.get/);
  assert.match(compatibilityListener, /previewTreeRequestSession\(details\)/);
  assert.match(
    compatibilityListener,
    /const isDirectTarget = session\.directTargetFrameId === details\.frameId/,
  );
  assert.doesNotMatch(
    compatibilityListener,
    /registerTargetTreeFrame/,
    'response-header authorization must remain isolated from lifecycle caches',
  );
  assert.doesNotMatch(sidebar, /autoCompat|compatMode|readerFallback/);
  assert.doesNotMatch(
    read('options/options.js'),
    /renderForceCompat/,
    'removed compatibility-domain UI must not leave an initialization call behind',
  );
  const windowOpenBridge = content.slice(
    content.indexOf('function installWindowOpenBridge'),
    content.indexOf('function installHistoryBridge'),
  );
  assert.doesNotMatch(windowOpenBridge, /open-external/);
  assert.match(windowOpenBridge, /signalRemote\(["']new-preview["']/);
  assert.match(windowOpenBridge, /navigatePreviewRoot\(url\)/);
  const preview = read('preview/preview.js');
  assert.doesNotMatch(preview, /reader|autoCompat|compatMode/i);
  assert.doesNotMatch(background, /createReaderResult|READER_|message\.action === ["']reader["']/);
  assert.doesNotMatch(preview, /\btarget\.src\s*=/);
  assert.match(preview, /type:\s*["']target-navigate["']/);
  assert.match(content, /item\.target\.src = targetUrl/);
});

test('deep preview descendants are verified, isolated, and can only navigate the direct root deliberately', () => {
  const background = read('background.js');
  const content = read('content.js');
  const preview = read('preview/preview.js');
  const resolver = background.slice(
    background.indexOf('async function resolveTargetBinding'),
    background.indexOf('async function acceptTargetPort'),
  );
  const snapshotter = background.slice(
    background.indexOf('function allFramesSnapshot'),
    background.indexOf('function ownerError'),
  );
  const targetPort = background.slice(
    background.indexOf('async function acceptTargetPort'),
    background.indexOf('browser.runtime.onConnect.addListener'),
  );
  const descendantBinding = targetPort.slice(
    targetPort.indexOf('const previous = session.descendantTargetPorts'),
    targetPort.indexOf('targetContextsByDocument.set'),
  );
  const currentPort = targetPort.slice(
    targetPort.indexOf('const isCurrentPort'),
    targetPort.indexOf('port.onMessage.addListener'),
  );
  const sessionNavigation = background.slice(
    background.indexOf('function sessionForNavigation'),
    background.indexOf('function pushNavigation'),
  );
  const detachTarget = background.slice(
    background.indexOf('function detachTargetContext'),
    background.indexOf('function acceptTargetBootstrapPort'),
  );
  const destroySession = background.slice(
    background.indexOf('function destroySession'),
    background.indexOf('function createSession'),
  );
  const navigationLifecycle = background.slice(
    background.indexOf('browser.webNavigation.onBeforeNavigate.addListener'),
    background.indexOf('browser.webNavigation.onCommitted.addListener'),
  );

  assert.match(resolver, /const allFrames = await allFramesSnapshot\(sender\.tab\.id\)/);
  assert.match(snapshotter, /browser\.webNavigation[\s\S]*?\.getAllFrames\(\{\s*tabId\s*\}\)/);
  assert.match(snapshotter, /inFlightFrameSnapshots\.get\(tabId\)/);
  assert.match(snapshotter, /inFlightFrameSnapshots\.set\(tabId,\s*pending\)/);
  assert.match(
    resolver,
    /frame\.documentId === sender\.documentId\s*&&\s*frame\.frameId === sender\.frameId/,
  );
  assert.match(resolver, /parent\.parentDocumentId === candidate\.ownerDocumentId/);
  assert.match(
    resolver,
    /parent\.documentId === candidate\.targetDocumentId/,
  );
  assert.doesNotMatch(
    resolver,
    /!candidate\.targetDocumentId\s*\|\|/,
    'a descendant must never bind before its direct target document is known',
  );
  assert.match(resolver, /return \{ frame, session: resolvedSession, direct: false \}/);
  assert.match(background, /descendantTargetPorts:\s*new Map\(\)/);
  assert.match(targetPort, /const isDirect = direct === true/);
  assert.match(targetPort, /if\s*\(isDirect\)\s*\{/);
  assert.match(targetPort, /session\.descendantTargetPorts\.set\(sender\.documentId/);
  assert.doesNotMatch(
    descendantBinding,
    /session\.(?:targetPort|targetDocumentId|targetFrameId|currentUrl|currentTitle|historyIndex|navigationHistory)\s*=/,
    'a descendant port must never overwrite direct-target state',
  );
  assert.match(
    currentPort,
    /session\.descendantTargetPorts\.get\(sender\.documentId\)\?\.port === port/,
  );
  assert.match(
    currentPort,
    /targetTreeSession\(sender\.tab\.id,\s*sender\.frameId\) === session/,
  );
  assert.match(targetPort, /role:\s*isDirect \? ["']direct["'] : ["']descendant["']/);
  assert.match(targetPort, /if\s*\(!isDirect \|\| session\.directResponseFailure\)\s*return/);
  assert.match(
    targetPort,
    /message\.type === ["']command-ack["'][\s\S]*?if\s*\(!isDirect\)\s*return/,
  );
  assert.match(
    targetPort,
    /message\.type === ["']history-pop["'][\s\S]*?if\s*\(!isDirect\)\s*return/,
  );
  assert.match(
    targetPort,
    /message\.type === ["']history-state["'][\s\S]*?if\s*\(!isDirect\)\s*return/,
  );
  assert.match(targetPort, /message\.type === ["']navigate-root["']/);
  const navigateRootHandler = targetPort.slice(
    targetPort.indexOf('message.type === "navigate-root"'),
    targetPort.indexOf('message.type === "unsupported-link"'),
  );
  assert.match(navigateRootHandler, /prepareRootNavigation\(session,\s*url\)/);
  assert.doesNotMatch(
    navigateRootHandler,
    /if\s*\(isDirect\)\s*return/,
    'direct and descendant user links must enter the same isolated root ledger',
  );
  assert.match(
    navigateRootHandler,
    /relayTargetSignal\(session,\s*["']navigate-root["'],\s*\{[\s\S]*?generation:\s*rootNavigation\.generation[\s\S]*?history:\s*historySnapshot\(session\)/,
  );
  assert.match(targetPort, /message\.userActivated !== true/);
  assert.match(targetPort, /relayTargetSignal\(session,\s*["']navigate-root["']/);
  assert.doesNotMatch(
    sessionNavigation,
    /targetTreeSession|sessionsByTargetTreeFrame|registerTargetTreeFrame/,
    'descendants must not enter the direct-target navigation state machine',
  );
  assert.match(navigationLifecycle, /registerTargetTreeFrame\(details\)/);
  assert.match(navigationLifecycle, /removeTargetTreeSubtree\(treeSession,\s*details\.frameId,\s*false\)/);
  assert.match(detachTarget, /session\.descendantTargetPorts\?\.clear\(\)/);
  assert.match(detachTarget, /clearTargetTreeFrames\(session,\s*true\)/);
  assert.match(destroySession, /clearTargetTreeFrames\(session,\s*false\)/);
  assert.match(content, /remoteConfig\.role = message\.role === ["']descendant["']/);
  assert.match(content, /role:\s*data\.role === ["']descendant["']/);
  assert.match(content, /signalRemote\(["']navigate-root["']/);
  assert.match(
    content,
    /window\.addEventListener\(\s*["']click["'],[\s\S]*?interceptPreviewNavigation\(event,\s*false\)[\s\S]*?true\s*\)/,
    'preview link routing must run in capture phase before sites can stop propagation',
  );
  assert.match(
    content,
    /window\.addEventListener\(["']auxclick["'],[\s\S]*?interceptPreviewNavigation\(event,\s*true\)[\s\S]*?true\s*\)/,
  );
  assert.match(content, /userActivated:\s*navigator\.userActivation\?\.isActive === true/);
  assert.match(preview, /message\.signal === ["']navigate-root["']/);
  assert.match(preview, /navigate\(url,\s*url,\s*true\)/);
});

test('interactive windows serialize across concurrent preview sessions', () => {
  const background = read('background.js');
  assert.match(
    background,
    /const compatibilityOpenQueueBySourceWindow = new Map\(\)/,
  );
  assert.match(
    background,
    /compatibilityOpenQueueBySourceWindow\.get\(sourceWindowId\)/,
  );
  assert.match(
    background,
    /\.then\(\(\) => openCompatibilityUrlNow\(options\)\)/,
  );
  assert.match(
    background,
    /compatibilityOpenQueueBySourceWindow\.delete\(sourceWindowId\)/,
  );
});

test('updates safely reactivate already-open pages without duplicate listeners', () => {
  const content = read('content.js');
  const background = read('background.js');
  assert.match(content, /__glassPeekV2ContentLoaded/);
  assert.match(background, /async function injectUpdatedContentScripts\(\)/);
  assert.match(background, /browser\.tabs\.executeScript\(tab\.id,\s*\{\s*file:\s*["']content\.js["']/);
  assert.match(background, /reason === ["']update["']/);
});

test('URL protocol keeps fragments and rejects unsafe schemes and credentials', () => {
  const GP = loadCommonProtocol();
  assert.equal(
    GP.normalizeUrl('https://example.com/path?q=1#kept'),
    'https://example.com/path?q=1#kept',
  );
  assert.equal(
    GP.normalizeUrl('../next#nested', 'https://example.com/a/b/'),
    'https://example.com/a/next#nested',
  );
  for (const unsafe of [
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/test',
    'about:config',
    'moz-extension://example/test',
    'https://user:password@example.com/',
    'https://example.com/\u0000bad',
  ]) {
    assert.equal(GP.normalizeUrl(unsafe), null, `${unsafe} must be rejected`);
  }
  assert.equal(GP.isPrivateHost('http://127.0.0.1/'), true);
  assert.equal(GP.isPrivateHost('http://2130706433/'), true, 'numeric loopback spelling must be canonicalized');
  assert.equal(GP.isPrivateHost('http://[::1]/'), true);
  assert.equal(GP.isPrivateHost('http://[::ffff:7f00:1]/'), true);
  assert.equal(GP.isPrivateHost('http://[::ffff:a00:1]/'), true);
  assert.equal(GP.isPrivateHost('http://[::ffff:808:808]/'), false);
  assert.equal(GP.isPrivateHost('http://[::808:808]/'), false);
  assert.equal(GP.isPrivateHost('http://[::a00:1]/'), true);
  assert.equal(GP.isPrivateHost('http://[64:ff9b::0808:0808]/'), false);
  assert.equal(GP.isPrivateHost('http://[64:ff9b::0a00:1]/'), true);
  assert.equal(GP.isPrivateHost('http://[2001:200::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2001:41d0::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2001:4860:4860::8888]/'), false);
  assert.equal(GP.isPrivateHost('http://[2003:100::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2404::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2410::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2606:4700:4700::1111]/'), false);
  assert.equal(GP.isPrivateHost('http://[2610:1ff::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2620:1ff::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2630::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2800::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2a02::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2a10::1]/'), false);
  assert.equal(GP.isPrivateHost('http://[2c0f::1]/'), false);
  assert.equal(GP.isPrivateHost('http://192.0.1.1/'), false);
  for (const specialUseAddress of [
    'http://192.0.0.1/',
    'http://192.0.2.1/',
    'http://198.51.100.1/',
    'http://203.0.113.1/',
    'http://[64:ff9b:1::1]/',
    'http://[fec0::1]/',
    'http://[100::1]/',
    'http://[100:0:0:1::1]/',
    'http://[2001::1]/',
    'http://[2001:1ff::1]/',
    'http://[2001:db8::1]/',
    'http://[2002::1]/',
    'http://[3fff::1]/',
    'http://[3fff:fff::1]/',
    'http://[2d00::1]/',
    'http://[2e00::1]/',
    'http://[2420::1]/',
    'http://[2610:200::1]/',
    'http://[2620:200::1]/',
    'http://[2640::1]/',
    'http://[2a20::1]/',
    'http://[3000::1]/',
    'http://[3800::1]/',
    'http://[3c00::1]/',
    'http://[3e00::1]/',
    'http://[3f00::1]/',
    'http://[3ffe::1]/',
    'http://[3fff:1000::1]/',
    'http://[4000::1]/',
    'http://[5f00::1]/',
    'http://[8000::1]/',
  ]) {
    assert.equal(
      GP.isPrivateHost(specialUseAddress),
      true,
      `${specialUseAddress} must remain outside the public preview boundary`,
    );
  }
  assert.equal(GP.isPrivateHost('https://example.com/'), false);

  assert.equal(
    GP.siteDecision(
      'https://allowed.child.example.com/path',
      [
        { domain: 'example.com', action: 'deny' },
        { domain: 'child.example.com', action: 'allow' },
      ],
      true,
    ),
    true,
    'a more-specific child rule must override its parent',
  );

  const common = read('shared/common.js');
  const background = read('background.js');
  const content = read('content.js');
  assert.doesNotMatch(common, /\.hash\s*=\s*["']["']/);
  assert.doesNotMatch(`${common}\n${background}\n${content}`, /\.split\(\s*["']#["']\s*\)\s*\[\s*0\s*\]/);
  assert.match(background, /webNavigation\.onReferenceFragmentUpdated\.addListener/);
  assert.match(content, /addEventListener\(\s*["']hashchange["']/);
});

test('original-page mode never substitutes video or reader targets', () => {
  const GP = loadCommonProtocol();
  const bilibili =
    'https://www.bilibili.com/video/BV1QTNR69ECB/?share_source=copy_web';
  const bilibiliTarget = GP.previewTargetUrl(bilibili);
  assert.equal(bilibiliTarget, bilibili);
  assert.equal(GP.previewDisplayUrl(bilibiliTarget, bilibili), bilibili);

  const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12';
  const youtubeTarget = GP.previewTargetUrl(youtube);
  assert.equal(youtubeTarget, youtube);
  assert.equal(GP.previewDisplayUrl(youtubeTarget, youtube), youtube);

  const ordinary = 'https://example.com/article#section';
  assert.equal(GP.previewTargetUrl(ordinary), ordinary);
  assert.equal(
    GP.previewTargetUrl('https://www.bilibili.com/video/not-a-bvid/'),
    'https://www.bilibili.com/video/not-a-bvid/',
  );
  assert.equal(
    GP.previewDisplayUrl('https://example.net/final', ordinary),
    'https://example.net/final',
  );

  const previewHtml = read('preview/preview.html');
  const preview = read('preview/preview.js');
  const background = read('background.js');
  const content = read('content.js');
  assert.ok(
    previewHtml.indexOf('../shared/common.js') <
      previewHtml.indexOf('preview.js'),
    'the shared URL protocol must load before preview.js',
  );
  assert.doesNotMatch(
    `${read('shared/common.js')}\n${background}\n${preview}`,
    /youtube-nocookie|player\.bilibili|readerSnapshot|createReaderResult|is-reader/i,
  );
  assert.doesNotMatch(previewHtml, /readerView|data-action=["']reader["']/i);
  assert.doesNotMatch(previewHtml, /<iframe\b[^>]*id=["']target["']/i);
  assert.doesNotMatch(preview, /\btarget\.src\s*=/);
  assert.match(preview, /function navigate\(url,\s*displayUrl = url,\s*loadTarget = true\)/);
  assert.match(preview, /type:\s*["']target-navigate["']/);
  assert.match(
    content,
    /您正在访问仿冒网站[\s\S]*?signalRemote\(["']embed-refused["'],\s*\{\s*reason:\s*["']site-warning["']/,
  );
  assert.match(
    content,
    /function scheduleEmbeddedRefusalWatch\(\)[\s\S]*?\[0,\s*250,\s*1000,\s*3000,\s*8000\]/,
    'late-rendered anti-embed warning pages must be detected after initial load',
  );
});

test('documentId capability protocol is one-time, parent-bound, and short-lived', () => {
  const background = read('background.js');
  const content = read('content.js');
  const preview = read('preview/preview.js');

  assert.match(content, /runtime\.connect\(\{\s*name:\s*["']gp-owner-v2["']/);
  assert.match(preview, /runtime\.connect\(\{\s*name:\s*["']gp-surface-v2["']/);
  assert.match(background, /typeof sender\.documentId !== ["']string["']/);
  assert.match(background, /frame\.parentDocumentId !== session\.ownerDocumentId/);
  assert.match(background, /documentId:\s*context\.documentId/);
  assert.match(background, /const GRANT_TTL_MS = 10_000/);
  assert.match(background, /const secret = randomHex\(32\)/);
  assert.match(background, /const targetSecret = randomHex\(32\)/);
  assert.match(background, /message\.secret !== session\.secret/);
  assert.match(background, /session\.secret = null/);
  assert.match(background, /session\.tabId !== context\.tabId/);
  assert.match(read('target/target-bootstrap.js'), /runtime\.connect\(\{\s*name:\s*["']gp-target-bootstrap-v3["']/);
  assert.match(background, /sender\.url !== TARGET_BOOTSTRAP_URL/);
  assert.match(background, /message\.secret !== session\.targetSecret/);
  assert.match(background, /frame\.parentDocumentId !== session\.ownerDocumentId/);
  assert.match(background, /sessionsByDirectTargetFrame\.set/);
  assert.match(background, /sessionsByDirectTargetFrame\.delete/);
  assert.match(background, /directTargetKey\(details\.tabId,\s*details\.frameId\)/);
});

test('iframe load cannot bypass timeout/error state and recovery controls', () => {
  const html = read('preview/preview.html');
  const preview = read('preview/preview.js');

  assert.match(openingTag(html, 'div', 'error'), /\brole=["']alert["']/i);
  for (const id of ['retry', 'compat', 'errorOpenTab']) openingTag(html, 'button', id);
  assert.match(preview, /hardTimer\s*=\s*setTimeout\(\(\)\s*=>\s*showError\(["']timeout["']\),\s*35000\)/);
  assert.match(preview, /showError\(iframeLoadSeen\s*\?\s*["']embed-blocked["']\s*:\s*["']timeout["']\)/);
  assert.match(
    preview,
    /function showReady\(\)\s*\{\s*if\s*\(!targetAlive\)\s*return;/,
  );

  const loadHandlerStart = preview.indexOf('message.type === "target-load"');
  const clearTimersStart = preview.indexOf('function safeHttpUrl', loadHandlerStart);
  assert.ok(loadHandlerStart >= 0 && clearTimersStart > loadHandlerStart, 'host target load handler must be present');
  assert.doesNotMatch(
    preview.slice(loadHandlerStart, clearTimersStart),
    /showReady\s*\(/,
    'iframe load alone must never mark the preview ready',
  );
  const completedHandler = preview.slice(
    preview.indexOf('currentStatus === "completed"'),
    preview.indexOf('message.type === "compat-opened"'),
  );
  assert.doesNotMatch(
    completedHandler,
    /targetAlive\s*=\s*true/,
    'completed without an authenticated target signal must not fake readiness',
  );
});

test('multi-window limits are enforced in both content and background contexts', () => {
  const GP = loadCommonProtocol();
  const background = read('background.js');
  const content = read('content.js');
  assert.equal(GP.DEFAULTS.maxWindows, 10);
  assert.match(background, /const ABSOLUTE_MAX_WINDOWS = 10/);
  assert.match(background, /Math\.min\(\s*ABSOLUTE_MAX_WINDOWS,/);
  assert.match(background, /owner\.sessions\.size >= ownerSessionLimit\(settings\)/);
  assert.match(content, /clamp\(Number\(settings\.maxWindows\) \|\| 10, 1, 10\)/);
  assert.match(content, /windows\.size >= max/);
});

test('preview movement is frame-coalesced and compositor-backed', () => {
  const content = read('content.js');
  const preview = read('preview/preview.js');
  const previewCss = read('preview/preview.css');

  assert.match(preview, /getCoalescedEvents/);
  assert.match(preview, /moveFrame\s*=\s*requestAnimationFrame\(postLatestMove\)/);
  assert.match(
    preview,
    /const flushMove\s*=\s*\(endEvent\)\s*=>\s*\{[\s\S]{0,500}postLatestMove\(\)/,
  );
  assert.match(
    preview,
    /const end\s*=\s*\(endEvent\)\s*=>\s*\{[\s\S]{0,300}flushMove\(endEvent\)[\s\S]{0,500}type:\s*["']gesture-end["']/,
  );
  assert.match(preview, /lostpointercapture/);

  const continueStart = content.indexOf('function continueGesture');
  const applyStart = content.indexOf('function applyGestureFrame', continueStart);
  assert.ok(
    continueStart >= 0 && applyStart > continueStart,
    'host gesture scheduler must be present',
  );
  assert.doesNotMatch(
    content.slice(continueStart, applyStart),
    /style\.(?:left|top|width|height|transform)/,
    'raw gesture messages must not mutate layout or transforms directly',
  );
  assert.match(
    content.slice(continueStart, applyStart),
    /requestAnimationFrame\(\(\)\s*=>/,
  );
  assert.match(
    content,
    /style\.transform\s*=\s*[\s\S]{0,100}translate3d\(/,
  );
  assert.match(
    content,
    /function endGesture\(item\)[\s\S]{0,300}flushGestureFrame\(item,\s*gesture\)[\s\S]{0,500}style\.left\s*=\s*`\$\{gesture\.targetLeft\}px`[\s\S]{0,300}translate3d\(0,\s*0,\s*0\)/,
  );
  assert.match(content, /gestureCleanupFrame\s*=\s*requestAnimationFrame/);
  assert.match(content, /\.gp-surface\.gesture-moving\s*\{[^}]*will-change:\s*transform/);
  assert.match(content, /\.gp-surface\.gesture-moving[^}]*contain:\s*layout paint/);

  assert.match(
    previewCss,
    /\.surface\.is-gesturing\s*\{[^}]*backdrop-filter:\s*none/,
  );
  assert.match(
    previewCss,
    /\.titlebar\s*\{[\s\S]*?touch-action:\s*none;[\s\S]*?\}/,
  );
});

test('browser zoom and viewport resize keep the whole preview actionable', () => {
  const content = read('content.js');
  assert.match(content, /window\.addEventListener\(["']resize["']/);
  assert.match(
    content,
    /clamp\(item\.frame\.offsetLeft,\s*0,\s*Math\.max\(0,\s*innerWidth - width\)\)/,
  );
  assert.match(
    content,
    /clamp\(item\.frame\.offsetTop,\s*0,\s*Math\.max\(0,\s*innerHeight - height\)\)/,
  );
});

test('English, Simplified Chinese, and Traditional Chinese locales are complete', () => {
  assert.equal(manifest.default_locale, 'zh_CN');
  const localeRoot = path.join(ROOT, '_locales');
  assert.ok(fs.existsSync(localeRoot), '_locales directory is required');

  const messagesByLocale = new Map();
  for (const locale of EXPECTED_LOCALES) {
    const file = path.join(localeRoot, locale, 'messages.json');
    assert.ok(fs.existsSync(file), `missing ${relative(file)}`);
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Object.keys(messages).length > 0, `${locale} must not be empty`);
    for (const [key, entry] of Object.entries(messages)) {
      assert.equal(typeof entry.message, 'string', `${locale}.${key}.message must be a string`);
      assert.ok(entry.message.trim(), `${locale}.${key}.message must not be empty`);
    }
    messagesByLocale.set(locale, messages);
  }

  const baselineKeys = Object.keys(messagesByLocale.get('en')).sort();
  for (const locale of EXPECTED_LOCALES.slice(1)) {
    assert.deepEqual(Object.keys(messagesByLocale.get(locale)).sort(), baselineKeys, `${locale} key set differs from en`);
  }

  const referencedKeys = new Set();
  for (const relativePath of ['options/options.html', 'popup/popup.html']) {
    const html = read(relativePath);
    for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?=["']([^"']+)["']/gi)) {
      referencedKeys.add(match[1]);
    }
  }
  for (const relativePath of ['options/options.js', 'popup/popup.js']) {
    const source = read(relativePath);
    for (const match of source.matchAll(/\bt\(\s*["']([^"']+)["']/g)) referencedKeys.add(match[1]);
  }
  for (const key of referencedKeys) {
    for (const locale of EXPECTED_LOCALES) {
      assert.ok(messagesByLocale.get(locale)[key], `${locale} is missing referenced key ${key}`);
    }
  }

  const preview = read('preview/preview.js');
  for (const locale of EXPECTED_LOCALES) {
    assert.match(preview, new RegExp(`(?:^|\\n)\\s{4}${locale}:\\s*\\{`), `preview UI is missing ${locale}`);
  }
});

test('local acceptance server exposes every required Firefox smoke route', async () => {
  for (const required of [
    '/embed',
    '/deep/root',
    '/deep/level-1',
    '/deep/level-2',
    '/deep/xfo',
    '/deep/csp',
    '/deep/csp-report-only',
    '/deep/csp-report',
    '/deep/root-destination',
    '/xfo',
    '/xfo-sameorigin',
    '/csp',
    '/csp-self',
    '/redirect',
    '/spa',
    '/early-history',
    '/slow',
    '/large-reader',
    '/form',
  ]) {
    assert.ok(ROUTES.includes(required), `${required} is missing from ROUTES`);
  }

  const server = createTestServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    const embedded = await httpRequest(port, '/embed?from=static-test#fragment-target');
    assert.equal(embedded.status, 200);
    assert.match(embedded.body, /id="fragment-target"/);
    assert.equal(embedded.headers['x-frame-options'], undefined);
    assert.equal(embedded.headers['content-security-policy'], undefined);

    const deepRoot = await httpRequest(port, '/deep/root?token=static-deep');
    assert.equal(deepRoot.status, 200);
    assert.match(deepRoot.body, /id="deep-root-ready"/);
    assert.match(deepRoot.body, /src="\/deep\/level-1\?token=static-deep"/);
    assert.match(
      deepRoot.body,
      /other\.localtest\.me:\d+\/deep\/xfo\?scope=preview&amp;depth=2/,
    );
    assert.match(
      deepRoot.body,
      /other\.localtest\.me:\d+\/deep\/csp\?depth=2/,
    );
    assert.match(
      deepRoot.body,
      /other\.localtest\.me:\d+\/deep\/csp-report-only\?depth=2/,
    );
    const deepLevelOne = await httpRequest(
      port,
      '/deep/level-1?token=static-deep',
    );
    assert.equal(deepLevelOne.status, 200);
    assert.match(
      deepLevelOne.body,
      /other\.localtest\.me:\d+\/deep\/xfo\?scope=preview&amp;depth=3/,
    );
    assert.match(
      deepLevelOne.body,
      /other\.localtest\.me:\d+\/deep\/csp\?depth=3/,
    );
    assert.match(
      deepLevelOne.body,
      /other\.localtest\.me:\d+\/deep\/csp-report-only\?depth=3/,
    );
    assert.match(deepLevelOne.body, /src="\/deep\/level-2\?token=static-deep"/);
    const deepLevelTwo = await httpRequest(port, '/deep/level-2');
    assert.equal(deepLevelTwo.status, 200);
    assert.match(deepLevelTwo.body, /id="deep-level-two-ready"/);
    const deepXfo = await httpRequest(
      port,
      '/deep/xfo?scope=preview&depth=3&token=static-deep',
    );
    assert.equal(deepXfo.status, 200);
    assert.equal(deepXfo.headers['x-frame-options'], 'DENY');
    assert.match(deepXfo.body, /id="deep-top-link"/);
    assert.match(deepXfo.body, /history\.pushState/);
    assert.match(deepXfo.body, /data-depth="3"/);
    const deepCsp = await httpRequest(
      port,
      '/deep/csp?depth=3&token=static-deep',
    );
    assert.equal(deepCsp.status, 200);
    assert.match(
      deepCsp.headers['content-security-policy'],
      /frame-ancestors 'none'/,
    );
    assert.match(deepCsp.headers['content-security-policy'], /script-src 'none'/);
    assert.match(deepCsp.body, /dataset\.inlineRan = 'yes'/);
    const deepCspReportOnly = await httpRequest(
      port,
      '/deep/csp-report-only?depth=3&token=static-deep',
    );
    assert.equal(deepCspReportOnly.status, 200);
    assert.match(
      deepCspReportOnly.headers['content-security-policy-report-only'],
      /frame-ancestors 'none'/,
    );
    assert.match(
      deepCspReportOnly.headers['content-security-policy-report-only'],
      /script-src 'none'/,
    );
    assert.match(
      deepCspReportOnly.headers['content-security-policy-report-only'],
      /report-uri \/deep\/csp-report\?token=static-deep/,
    );
    const deepCspReports = await httpRequest(
      port,
      '/deep/csp-report?token=static-deep',
    );
    assert.equal(deepCspReports.status, 200);
    assert.deepEqual(JSON.parse(deepCspReports.body), []);
    const deepDestination = await httpRequest(
      port,
      '/deep/root-destination?from=deep-top#reached',
    );
    assert.equal(deepDestination.status, 200);
    assert.match(deepDestination.body, /id="deep-root-destination"/);

    const xfo = await httpRequest(port, '/xfo');
    assert.equal(xfo.status, 200);
    assert.equal(xfo.headers['x-frame-options'], 'DENY');
    const xfoSameOrigin = await httpRequest(port, '/xfo-sameorigin');
    assert.equal(xfoSameOrigin.status, 200);
    assert.equal(xfoSameOrigin.headers['x-frame-options'], 'SAMEORIGIN');

    const csp = await httpRequest(port, '/csp');
    assert.equal(csp.status, 200);
    assert.match(csp.headers['content-security-policy'], /frame-ancestors 'none'/);
    const cspSelf = await httpRequest(port, '/csp-self');
    assert.equal(cspSelf.status, 200);
    assert.match(cspSelf.headers['content-security-policy'], /frame-ancestors 'self'/);

    const redirect = await httpRequest(port, '/redirect');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, '/embed?from=redirect#fragment-target');

    const spa = await httpRequest(port, '/spa');
    assert.equal(spa.status, 200);
    assert.match(spa.body, /history\.pushState/);
    assert.match(spa.body, /location\.hash = 'hash-only'/);
    const earlyHistory = await httpRequest(port, '/early-history');
    assert.equal(earlyHistory.status, 200);
    assert.match(earlyHistory.body, /window\.__glasspeekEarlyHistory/);
    assert.match(earlyHistory.body, /sessionStorage\.getItem\(earlyReplayKey\)/);
    assert.match(earlyHistory.body, /history\.pushState/);
    assert.match(earlyHistory.body, /history\.replaceState/);

    const slowStarted = Date.now();
    const slow = await httpRequest(port, '/slow?ms=25');
    assert.equal(slow.status, 200);
    assert.ok(Date.now() - slowStarted >= 15, 'slow fixture returned without delaying');
    assert.match(slow.body, /Delayed 25 ms/);

    const form = await httpRequest(port, '/form');
    assert.equal(form.status, 200);
    assert.match(form.body, /id="fixture-form"/);
    assert.match(form.body, /target="_blank"/);
    const largeReader = await httpRequest(port, '/large-reader');
    assert.equal(largeReader.status, 200);
    assert.equal(largeReader.headers['x-frame-options'], 'DENY');
    assert.ok(Buffer.byteLength(largeReader.body) > 4 * 1024 * 1024);
    assert.match(largeReader.body, /Large article reader fixture/);
    const submitted = await httpRequest(port, '/form-result#submitted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'message=%3Cscript%3Ealert(1)%3C%2Fscript%3E&notes=A%26B',
    });
    assert.equal(submitted.status, 200);
    assert.doesNotMatch(submitted.body, /<script>alert\(1\)<\/script>/);
    assert.match(submitted.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(submitted.body, /A&amp;B/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function main() {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }

  if (failures) {
    console.error(`static/protocol checks: FAIL (${failures}/${tests.length})`);
    process.exitCode = 1;
  } else {
    console.log(`static/protocol checks: PASS (${tests.length}/${tests.length})`);
  }
}

main();
