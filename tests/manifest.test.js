'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(extensionRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const sorted = (values) => [...values].sort();

assert.equal(manifest.manifest_version, 2, 'GlassPeek must remain a Firefox MV2 extension');
assert.equal(manifest.version, '2.4.0', 'release version must be 2.4.0');
assert.equal(manifest.default_locale, 'zh_CN', 'the default locale must be zh_CN');

const gecko = manifest.browser_specific_settings?.gecko;
assert.ok(gecko, 'browser_specific_settings.gecko is required');
assert.match(
  gecko.id,
  /^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i,
  'gecko.id must be a permanent GUID-style ID',
);
assert.equal(gecko.strict_min_version, '153.0', 'Firefox 153 is the minimum supported version');
assert.deepEqual(
  gecko.data_collection_permissions,
  { required: ['none'] },
  'the extension must explicitly declare that it collects no data',
);

const expectedPermissions = [
  'storage',
  'tabs',
  'webNavigation',
  'webRequest',
  'webRequestBlocking',
  'dns',
  'history',
  'clipboardWrite',
  'http://*/*',
  'https://*/*',
];

assert.equal(
  new Set(manifest.permissions).size,
  manifest.permissions.length,
  'permissions must not contain duplicates',
);
assert.deepEqual(
  sorted(manifest.permissions),
  sorted(expectedPermissions),
  'permissions must stay on the reviewed allowlist',
);
assert.ok(
  !Object.prototype.hasOwnProperty.call(manifest, 'optional_permissions'),
  'this release has no optional permissions',
);

for (const forbiddenPermission of ['declarativeNetRequest', '<all_urls>', 'windows', 'cookies', 'privacy']) {
  assert.ok(
    !manifest.permissions.includes(forbiddenPermission),
    `${forbiddenPermission} must never be requested`,
  );
}

assert.deepEqual(
  manifest.background?.scripts,
  ['shared/common.js', 'background.js'],
  'the background must load only reviewed local scripts',
);

assert.equal(manifest.content_scripts?.length, 1, 'exactly one content-script declaration is expected');
const contentScript = manifest.content_scripts[0];
assert.deepEqual(
  contentScript.matches,
  ['http://*/*', 'https://*/*'],
  'content scripts must run only on HTTP(S) pages',
);
assert.deepEqual(
  contentScript.js,
  ['shared/common.js', 'content.js'],
  'shared/common.js must load before content.js',
);
assert.equal(contentScript.run_at, 'document_start', 'content scripts must initialize at document_start');
assert.equal(contentScript.all_frames, true, 'content scripts must cover all frames');

const expectedWebAccessibleResources = [
  'preview/preview.html',
  'preview/preview.css',
  'preview/preview.js',
  'target/target-bootstrap.html',
  'target/target-bootstrap.js',
];
assert.deepEqual(
  sorted(manifest.web_accessible_resources),
  sorted(expectedWebAccessibleResources),
  'only the reviewed preview surface and one-time target bootstrap may be web accessible',
);
assert.ok(
  manifest.web_accessible_resources.every((resource) => !resource.includes('*')),
  'web-accessible resources must not use wildcards',
);

const csp = manifest.content_security_policy;
assert.equal(typeof csp, 'string', 'an explicit extension CSP is required');
assert.ok(csp.includes("script-src 'self'"), 'scripts must be limited to the extension itself');
assert.ok(csp.includes("object-src 'none'"), 'plugin objects must be disabled');
assert.match(
  csp,
  /(?:^|;\s*)connect-src\s+'self'\s*(?:;|$)/,
  'extension-initiated connections must be limited to packaged extension resources',
);
assert.doesNotMatch(csp, /connect-src[^;]*(?:https?:|\*)/i);
assert.ok(!/unsafe-eval/i.test(csp), 'unsafe-eval is forbidden');
assert.ok(!/unsafe-inline/i.test(csp), 'unsafe-inline is forbidden');

assert.ok(!('update_url' in gecko), 'self-hosted update endpoints are not part of this release');

console.log('manifest security invariants: PASS');
