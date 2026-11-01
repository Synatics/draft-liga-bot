const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { LeagueSettingsStore } = require("../src/storage/league-settings");
const { MatchStore } = require("../src/storage/match-store");
const {
  DataBackups,
  startAutomaticBackups,
  CHECK_INTERVAL_MS,
} = require("../src/storage/data-backups");

const GUILD = "300000000000000001";
const record = (overrides = {}) => ({
  guildId: GUILD,
  channelId: "400000000000000001",
  season: 4,
  matchday: 1,
  players: [
    { id: "200000000000000001", name: "Jan" },
    { id: "200000000000000002", name: "Max" },
  ],
  link: "https://example.org/replay",
  ...overrides,
});

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), "pokemon-liga-backup-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const settingsPath = join(directory, "league-settings.json");
  const matchesPath = join(directory, "matches.json");
  const settings = new LeagueSettingsStore(settingsPath);
  const matches = new MatchStore(matchesPath);
  settings.setSeason(GUILD, 4, 9, "19.10.2026");
  const match = matches.add(record());
  matches.setPublication(match.id, { status: "sending" });
  matches.setPublication(match.id, { status: "published", messageId: "500000000000000001" });
  let now = new Date("2026-10-19T08:00:00.000Z");
  const backups = new DataBackups(settingsPath, { now: () => now, ...options });
  return {
    directory,
    settingsPath,
    matchesPath,
    settings,
    matches,
    backups,
    setNow(value) {
      now = new Date(value);
    },
  };
}

test("a complete backup restores both stores, historical names and the persistent duplicate protection", (t) => {
  const { directory, settingsPath, matchesPath, settings, matches, backups } = fixture(t);
  fs.writeFileSync(join(directory, ".env"), "DISCORD_TOKEN=must-never-be-backed-up");
  const settingsText = fs.readFileSync(settingsPath, "utf8");
  const matchesText = fs.readFileSync(matchesPath, "utf8");
  const result = backups.create();
  assert.equal(result.created, true);
  assert.equal(dirname(result.path), join(directory, "backups"));
  assert.deepEqual(fs.readdirSync(result.path).sort(), ["league-settings.json", "matches.json"]);
  assert.equal(fs.readFileSync(join(result.path, "league-settings.json"), "utf8"), settingsText);
  assert.equal(fs.readFileSync(join(result.path, "matches.json"), "utf8"), matchesText);

  settings.setSeason(GUILD, 5, 12, "26.10.2026");
  matches.add(record({ season: 5 }));
  for (const file of ["league-settings.json", "matches.json"]) {
    fs.copyFileSync(join(result.path, file), join(directory, file));
  }
  assert.equal(new LeagueSettingsStore(settingsPath).get(GUILD).season, 4);
  const restored = new MatchStore(matchesPath);
  assert.equal(restored.list(GUILD).length, 1);
  assert.equal(restored.add(record()).publication.messageId, "500000000000000001");
});

test("daily checks survive restarts, roll over at the UTC date boundary and permit forced copies", (t) => {
  const { settingsPath, backups, setNow } = fixture(t);
  const first = backups.create();
  setNow("2026-10-19T23:59:59.999Z");
  assert.equal(backups.create().created, false);
  assert.equal(
    new DataBackups(settingsPath, { now: () => new Date("2026-10-19T20:00:00Z") }).create().created,
    false,
  );
  assert.notEqual(backups.create({ force: true }).path, first.path);
  setNow("2026-10-20T00:00:00.000Z");
  assert.equal(backups.create().created, true);
  assert.equal(backups.list().length, 3);
});

test("retention keeps the newest fourteen copies and leaves live data and unrelated files untouched", (t) => {
  const { settingsPath, matchesPath, backups, setNow } = fixture(t);
  const settingsText = fs.readFileSync(settingsPath, "utf8");
  const matchesText = fs.readFileSync(matchesPath, "utf8");
  backups.create();
  fs.writeFileSync(join(backups.directory, "notes.txt"), "keep me");
  const unrelated = join(backups.directory, "manual-copy");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(join(unrelated, "matches.json"), "keep me too");
  for (let day = 20; day <= 35; day++) {
    setNow(new Date(Date.UTC(2026, 9, day)).toISOString());
    assert.deepEqual(backups.create().cleanupErrors, []);
  }
  const names = backups.list();
  assert.equal(names.length, 14);
  assert.ok(names[0].startsWith("backup-2026-10-22T"));
  assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsText);
  assert.equal(fs.readFileSync(matchesPath, "utf8"), matchesText);
  assert.equal(fs.readFileSync(join(backups.directory, "notes.txt"), "utf8"), "keep me");
  assert.equal(fs.readFileSync(join(unrelated, "matches.json"), "utf8"), "keep me too");
});

test("corrupt or missing source data never replaces backups or triggers retention", (t) => {
  const { settingsPath, matchesPath, backups, setNow } = fixture(t, { keepCount: 1 });
  const good = backups.create();
  const matchesText = fs.readFileSync(matchesPath, "utf8");
  setNow("2026-10-20T08:00:00Z");
  for (const text of [
    "broken JSON",
    JSON.stringify({ version: 2, matches: [] }),
    JSON.stringify({
      version: 1,
      matches: [record({ id: "a".repeat(24), publication: { status: "published" } })],
    }),
  ]) {
    fs.writeFileSync(matchesPath, text);
    assert.throws(() => backups.create());
    assert.deepEqual(backups.list(), [good.path.split(/[\\/]/).pop()]);
  }
  fs.writeFileSync(matchesPath, matchesText);
  fs.writeFileSync(settingsPath, JSON.stringify({ version: 1, guilds: { guild: { season: 0 } } }));
  assert.throws(() => backups.create());
  fs.unlinkSync(settingsPath);
  assert.throws(() => backups.create(), { code: "ENOENT" });
  assert.equal(fs.readFileSync(join(good.path, "matches.json"), "utf8"), matchesText);
});

test("damaged copies and interrupted temporary directories cannot suppress a new daily backup", (t) => {
  const { backups } = fixture(t);
  const first = backups.create();
  fs.writeFileSync(join(first.path, "matches.json"), "broken");
  fs.mkdirSync(join(backups.directory, ".pending-interrupted"));
  const result = backups.create();
  assert.equal(result.created, true);
  assert.notEqual(result.path, first.path);
  assert.equal(new MatchStore(join(result.path, "matches.json")).list(GUILD).length, 1);
});

function withFileSystem(overrides) {
  const module = { exports: {} };
  const modulePath = require.resolve("../src/storage/data-backups");
  const moduleRequire = createRequire(modulePath);
  runInNewContext(fs.readFileSync(modulePath, "utf8"), {
    module,
    console,
    setInterval,
    require(name) {
      return name === "node:fs" ? { ...fs, ...overrides } : moduleRequire(name);
    },
  });
  return module.exports.DataBackups;
}

test("a partial write fails without publishing an incomplete backup or pruning the previous copy", (t) => {
  const { settingsPath, backups } = fixture(t, { keepCount: 1 });
  const previous = backups.create();
  const FaultyBackups = withFileSystem({
    writeFileSync(path, ...args) {
      if (path.includes(".pending-") && path.endsWith("matches.json")) throw new Error("disk full");
      return fs.writeFileSync(path, ...args);
    },
  });
  assert.throws(
    () => new FaultyBackups(settingsPath, { keepCount: 1 }).create({ force: true }),
    /disk full/,
  );
  assert.deepEqual(fs.readdirSync(backups.directory), [previous.path.split(/[\\/]/).pop()]);
});

test("a failed atomic rename preserves the old copy and cleans up the unfinished directory", (t) => {
  const { settingsPath, backups } = fixture(t);
  const previous = backups.create();
  const FaultyBackups = withFileSystem({
    renameSync() {
      throw new Error("rename failed");
    },
  });
  assert.throws(() => new FaultyBackups(settingsPath).create({ force: true }), /rename failed/);
  assert.deepEqual(fs.readdirSync(backups.directory), [previous.path.split(/[\\/]/).pop()]);
});

test("unexpected contents and deletion failures are reported without losing the new backup", (t) => {
  const { settingsPath, backups, setNow } = fixture(t, { keepCount: 1 });
  const previous = backups.create();
  fs.writeFileSync(join(previous.path, "notes.txt"), "do not delete");
  setNow("2026-10-20T08:00:00Z");
  const result = backups.create();
  assert.equal(result.created, true);
  assert.equal(result.cleanupErrors.length, 1);
  assert.equal(fs.readFileSync(join(previous.path, "notes.txt"), "utf8"), "do not delete");
  fs.unlinkSync(join(previous.path, "notes.txt"));
  const FaultyBackups = withFileSystem({
    unlinkSync() {
      throw new Error("access denied");
    },
  });
  const failedCleanup = new FaultyBackups(settingsPath, { keepCount: 1 }).create({ force: true });
  assert.equal(failedCleanup.created, true);
  assert.ok(failedCleanup.cleanupErrors.length > 0);
  assert.equal(new MatchStore(join(failedCleanup.path, "matches.json")).list(GUILD).length, 1);
});

test("automatic backups check at startup and hourly, recover from failures, and do not keep Node alive", (t) => {
  const { backups, setNow } = fixture(t);
  let callback,
    unreferenced = false;
  t.mock.method(global, "setInterval", (fn, interval) => {
    callback = fn;
    assert.equal(interval, CHECK_INTERVAL_MS);
    return {
      unref() {
        unreferenced = true;
      },
    };
  });
  const logs = [],
    errors = [];
  startAutomaticBackups(backups, {
    log(message) {
      logs.push(message);
    },
    error(message) {
      errors.push(message);
    },
  });
  assert.equal(unreferenced, true);
  assert.equal(logs.length, 1);
  callback();
  assert.equal(logs.length, 1);
  t.mock.method(backups, "create", () => {
    throw Object.assign(new Error("private-backup-details"), { code: "ENOSPC" });
  });
  callback();
  assert.match(errors[0], /ENOSPC/);
  assert.match(errors[0], /Datenträger voll/);
  assert.ok(!errors[0].includes("private-backup-details"));
  backups.create.mock.restore();
  setNow("2026-10-20T08:00:00Z");
  callback();
  assert.equal(logs.length, 2);
});

test("manual CLI uses the configured directory, never connects to Discord and exits unsuccessfully on invalid data", (t) => {
  const { directory, settingsPath, backups } = fixture(t);
  const run = () =>
    spawnSync(process.execPath, [require.resolve("../backup")], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        DATA_DIR: directory,
        RAILWAY_ENVIRONMENT_ID: "",
        RAILWAY_VOLUME_MOUNT_PATH: "",
        DISCORD_TOKEN: "must-not-be-printed",
        CLIENT_ID: "invalid-discord-client",
      },
    });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Datensicherung erstellt/);
  assert.ok(!result.stdout.includes("must-not-be-printed"));
  assert.equal(backups.list().length, 1);
  fs.writeFileSync(settingsPath, "broken must-not-be-printed");
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Datensicherung fehlgeschlagen/);
  assert.ok(!failed.stderr.includes("must-not-be-printed"));
  assert.equal(backups.list().length, 1);
});

test("manual backup obeys the Railway volume boundary instead of backing up an unrelated directory", (t) => {
  const { directory } = fixture(t);
  const result = spawnSync(process.execPath, [require.resolve("../backup")], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: directory,
      RAILWAY_ENVIRONMENT_ID: "test",
      RAILWAY_VOLUME_MOUNT_PATH: join(directory, "volume"),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /innerhalb/);
  assert.equal(fs.existsSync(join(directory, "backups")), false);
});
