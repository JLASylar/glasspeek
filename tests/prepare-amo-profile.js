'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS_ROOT = path.join(ROOT, 'tests', 'artifacts');
// The source profile is never hard-coded: pass it via GP_FIREFOX_PROFILE or
// as the first CLI argument, e.g. %APPDATA%\\Mozilla\\Firefox\\Profiles\\<id>.default-release
const SOURCE_PROFILE_INPUT = process.env.GP_FIREFOX_PROFILE || process.argv[2];
if (!SOURCE_PROFILE_INPUT) {
  console.error('Set GP_FIREFOX_PROFILE or pass the Firefox profile directory as the first argument.');
  process.exit(2);
}
const SOURCE_PROFILE = path.resolve(SOURCE_PROFILE_INPUT);
const SOURCE_DATABASE = path.join(SOURCE_PROFILE, 'cookies.sqlite');
const TARGET_PROFILE = path.join(
  ARTIFACTS_ROOT,
  'amo-upload-active',
  'profile',
);
const TARGET_DATABASE = path.join(TARGET_PROFILE, 'cookies.sqlite');
const ALLOWED_HOSTS = Object.freeze([
  '.addons.mozilla.org',
  'addons.mozilla.org',
  '.accounts.firefox.com',
  'accounts.firefox.com',
]);

function canonicalWindowsPath(value) {
  return path.resolve(value).replaceAll('/', '\\').toLowerCase();
}

function assertExpectedPaths() {
  const expectedTarget = canonicalWindowsPath(
    path.join(ROOT, 'tests', 'artifacts', 'amo-upload-active', 'profile'),
  );
  if (canonicalWindowsPath(TARGET_PROFILE) !== expectedTarget) {
    throw new Error(`Refusing unexpected target profile: ${TARGET_PROFILE}`);
  }

  const relative = path.relative(ARTIFACTS_ROOT, TARGET_PROFILE);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    canonicalWindowsPath(relative) !==
      canonicalWindowsPath(path.join('amo-upload-active', 'profile'))
  ) {
    throw new Error(`Target escaped the artifacts directory: ${TARGET_PROFILE}`);
  }

  if (!fs.existsSync(ARTIFACTS_ROOT)) {
    throw new Error(`Artifacts directory is missing: ${ARTIFACTS_ROOT}`);
  }
  const artifactsStat = fs.lstatSync(ARTIFACTS_ROOT);
  if (artifactsStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link artifacts directory: ${ARTIFACTS_ROOT}`);
  }
  if (!artifactsStat.isDirectory()) {
    throw new Error(`Artifacts path is not a directory: ${ARTIFACTS_ROOT}`);
  }

  let cursor = ARTIFACTS_ROOT;
  for (const segment of ['amo-upload-active', 'profile']) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link target component: ${cursor}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Target component is not a directory: ${cursor}`);
    }
  }

  if (!fs.existsSync(SOURCE_DATABASE)) {
    throw new Error(`Firefox cookie database is missing: ${SOURCE_DATABASE}`);
  }
  const sourceStat = fs.lstatSync(SOURCE_DATABASE);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Firefox cookie database is not a regular file: ${SOURCE_DATABASE}`);
  }
}

function assertTemporaryProfileIsIdle() {
  const escapedNeedle = TARGET_PROFILE.replaceAll("'", "''");
  const command =
    `$needle='${escapedNeedle}'; ` +
    "$matches = @(Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" -ErrorAction Stop " +
    "| Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 }); " +
    '[Console]::Out.Write($matches.Count)';

  let output;
  try {
    output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    ).trim();
  } catch (error) {
    throw new Error(
      `Could not verify that the temporary Firefox profile is idle: ${error.message}`,
    );
  }

  const count = Number(output);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Unexpected Firefox process check result: ${output}`);
  }
  if (count > 0) {
    throw new Error(
      `Refusing to replace cookies while ${count} Firefox process(es) use ${TARGET_PROFILE}`,
    );
  }
}

function expiryMilliseconds(value) {
  const expiry = Number(value);
  if (!Number.isFinite(expiry) || expiry <= 0) return 0;
  return expiry >= 10_000_000_000 ? expiry : expiry * 1000;
}

function removeExactDatabaseFamily(databasePath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${databasePath}${suffix}`;
    if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
  }
}

function inspectPreparedDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new Error('Prepared cookie database failed SQLite integrity_check');
    }

    const disallowed = database
      .prepare(
        `SELECT count(*) AS count
           FROM moz_cookies
          WHERE lower(host) NOT IN (${ALLOWED_HOSTS.map(() => '?').join(',')})`,
      )
      .get(...ALLOWED_HOSTS);
    if (Number(disallowed.count) !== 0) {
      throw new Error('Prepared cookie database still contains disallowed hosts');
    }

    const session = database
      .prepare(
        `SELECT host, expiry
           FROM moz_cookies
          WHERE lower(host) IN ('.addons.mozilla.org', 'addons.mozilla.org')
            AND name = 'sessionid'
          ORDER BY expiry DESC
          LIMIT 1`,
      )
      .get();
    if (!session) {
      throw new Error('Prepared cookie database has no AMO sessionid');
    }

    const expiresAt = expiryMilliseconds(session.expiry);
    if (!expiresAt || expiresAt <= Date.now()) {
      throw new Error('Prepared AMO sessionid is expired');
    }

    const counts = database
      .prepare(
        `SELECT lower(host) AS host, count(*) AS count
           FROM moz_cookies
          GROUP BY lower(host)
          ORDER BY lower(host)`,
      )
      .all()
      .map((row) => ({ host: row.host, count: Number(row.count) }));

    return {
      retainedCookieCount: counts.reduce((total, row) => total + row.count, 0),
      retainedHosts: counts,
      amoSessionHost: String(session.host),
      amoSessionExpiresAt: new Date(expiresAt).toISOString(),
    };
  } finally {
    database.close();
  }
}

function replacePreparedDatabase(stagingPath) {
  const stamp = `${Date.now()}-${process.pid}`;
  const previousBase = `${TARGET_DATABASE}.previous-${stamp}`;
  const moved = [];

  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const current = `${TARGET_DATABASE}${suffix}`;
      if (!fs.existsSync(current)) continue;
      const previous = `${previousBase}${suffix}`;
      fs.renameSync(current, previous);
      moved.push({ current, previous });
    }

    fs.renameSync(stagingPath, TARGET_DATABASE);
    const result = inspectPreparedDatabase(TARGET_DATABASE);

    for (const entry of moved) {
      if (fs.existsSync(entry.previous)) fs.rmSync(entry.previous, { force: true });
    }
    return result;
  } catch (error) {
    removeExactDatabaseFamily(TARGET_DATABASE);
    for (const entry of moved.reverse()) {
      if (fs.existsSync(entry.previous)) {
        fs.renameSync(entry.previous, entry.current);
      }
    }
    throw error;
  } finally {
    removeExactDatabaseFamily(stagingPath);
  }
}

async function main() {
  assertExpectedPaths();
  assertTemporaryProfileIsIdle();

  fs.mkdirSync(TARGET_PROFILE, { recursive: true });
  assertExpectedPaths();

  const stagingPath = path.join(
    TARGET_PROFILE,
    `cookies.sqlite.preparing-${Date.now()}-${process.pid}`,
  );
  removeExactDatabaseFamily(stagingPath);

  try {
    const source = new DatabaseSync(SOURCE_DATABASE, { readOnly: true });
    try {
      await backup(source, stagingPath);
    } finally {
      source.close();
    }

    const staging = new DatabaseSync(stagingPath);
    try {
      staging.exec('PRAGMA journal_mode=DELETE');
      staging.exec('PRAGMA secure_delete=ON');
      staging.exec('BEGIN IMMEDIATE');
      staging
        .prepare(
          `DELETE FROM moz_cookies
            WHERE lower(host) NOT IN (${ALLOWED_HOSTS.map(() => '?').join(',')})`,
        )
        .run(...ALLOWED_HOSTS);
      staging.exec('COMMIT');
      staging.exec('VACUUM');
    } catch (error) {
      try {
        staging.exec('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      staging.close();
    }

    const result = replacePreparedDatabase(stagingPath);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          sourceProfile: SOURCE_PROFILE,
          targetProfile: TARGET_PROFILE,
          ...result,
          cookieValuesExposed: false,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    removeExactDatabaseFamily(stagingPath);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
