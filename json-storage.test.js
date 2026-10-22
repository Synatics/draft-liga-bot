const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { writeJsonAtomic } = require("./json-storage");
const { MatchStore, MatchStoreError } = require("./match-store");
const { LeagueSettingsStore, LeagueSettingsError } = require("./league-settings");

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "liga-json-storage-test-"));
  t.after(() => {
    t.mock.restoreAll();
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path: join(directory, "data", "document.json") };
}

test("atomic JSON writes create directories, replace whole documents and leave no temporary files", (t) => {
  const { path } = fixture(t);
  writeJsonAtomic(path, { version: 1, value: "älterer Stand" });
  writeJsonAtomic(path, { version: 1, value: "neuer Stand" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), { version: 1, value: "neuer Stand" });
  assert.ok(fs.readFileSync(path, "utf8").endsWith("\n"));
  assert.deepEqual(fs.readdirSync(dirname(path)), ["document.json"]);
});

for (const operation of ["writeFileSync", "renameSync"]) {
  test(`a failed ${operation} preserves the previous JSON, closes the handle and removes its partial file`, (t) => {
    const { path } = fixture(t);
    writeJsonAtomic(path, { value: "previous" });
    const original = fs.readFileSync(path, "utf8");
    const failure = Object.assign(new Error("simulated storage failure"), { code: "ENOSPC" });
    const write = fs.writeFileSync;
    let descriptor;
    t.mock.method(fs, operation, (...args) => {
      if (operation === "writeFileSync") {
        descriptor = args[0];
        write(descriptor, "partial JSON", "utf8");
      }
      throw failure;
    });
    assert.throws(() => writeJsonAtomic(path, { value: "next" }), (error) => error === failure);
    if (descriptor !== undefined) assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
    assert.equal(fs.readFileSync(path, "utf8"), original);
    assert.deepEqual(fs.readdirSync(dirname(path)), ["document.json"]);
  });
}

test("a temporary filename collision never removes or replaces a file belonging to someone else", (t) => {
  const { path } = fixture(t);
  writeJsonAtomic(path, { value: "previous" });
  const original = fs.readFileSync(path, "utf8");
  const open = fs.openSync;
  let existing;
  t.mock.method(fs, "openSync", (temporaryPath, flags) => {
    // Another writer claimed this name before our exclusive open.
    const descriptor = open(temporaryPath, "wx");
    try { fs.writeFileSync(descriptor, "belongs to another writer"); } finally { fs.closeSync(descriptor); }
    existing = temporaryPath;
    return open(temporaryPath, flags);
  });
  assert.throws(() => writeJsonAtomic(path, { value: "next" }), { code: "EEXIST" });
  fs.openSync.mock.restore();
  assert.equal(fs.readFileSync(existing, "utf8"), "belongs to another writer");
  assert.equal(fs.readFileSync(path, "utf8"), original);
});

test("a cleanup failure preserves both system errors and the previous document", (t) => {
  const { path } = fixture(t);
  writeJsonAtomic(path, { value: "previous" });
  const original = fs.readFileSync(path, "utf8");
  const failure = Object.assign(new Error("write failed"), { code: "ENOSPC" });
  const cleanupFailure = Object.assign(new Error("cleanup failed"), { code: "EACCES" });
  t.mock.method(fs, "writeFileSync", () => { throw failure; });
  t.mock.method(fs, "unlinkSync", () => { throw cleanupFailure; });
  assert.throws(() => writeJsonAtomic(path, { value: "next" }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure, cleanupFailure]);
    return true;
  });
  assert.equal(fs.readFileSync(path, "utf8"), original);
});

test("invalid JSON input fails before a file is created or the previous document is touched", (t) => {
  const { path } = fixture(t);
  writeJsonAtomic(path, { value: "previous" });
  const original = fs.readFileSync(path, "utf8");
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJsonAtomic(path, circular), TypeError);
  assert.equal(fs.readFileSync(path, "utf8"), original);
  assert.deepEqual(fs.readdirSync(dirname(path)), ["document.json"]);
});

test("both JSON stores retain their cache, disk state and diagnostic cause on rename failure, then allow retry", (t) => {
  const { directory } = fixture(t);
  const guild = "300000000000000001";
  const match = { guildId: guild, channelId: "400000000000000001", season: 4, matchday: 1,
    players: [{ id: "200000000000000001", name: "Jan" }, { id: "200000000000000002", name: "Max" }],
    link: "https://example.org/replay" };
  const matchPath = join(directory, "matches.json"), settingsPath = join(directory, "league-settings.json");
  const matches = new MatchStore(matchPath);
  const settings = new LeagueSettingsStore(settingsPath);
  matches.add(match);
  settings.setSeason(guild, 4, 10, "19.10.2026");
  const originalMatches = fs.readFileSync(matchPath, "utf8"), originalSettings = fs.readFileSync(settingsPath, "utf8");
  const failure = Object.assign(new Error("destination locked"), { code: "EPERM" });
  t.mock.method(fs, "renameSync", () => { throw failure; });
  for (const [write, ErrorType, operation, file] of [
    [() => matches.add({ ...match, matchday: 2 }), MatchStoreError, "archive.write", "matches.json"],
    [() => settings.setSeason(guild, 5, 10, "26.10.2026"), LeagueSettingsError, "settings.write", "league-settings.json"],
  ]) {
    assert.throws(write, (error) => {
      assert.ok(error instanceof ErrorType);
      assert.equal(error.cause, failure);
      assert.equal(error.context.operation, operation);
      assert.equal(error.context.file, file);
      assert.equal(error.context.guildId, guild);
      return true;
    });
  }
  assert.equal(matches.list(guild).length, 1);
  assert.equal(settings.get(guild).season, 4);
  assert.equal(fs.readFileSync(matchPath, "utf8"), originalMatches);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["league-settings.json", "matches.json"]);
  fs.renameSync.mock.restore();
  matches.add({ ...match, matchday: 2 });
  settings.setSeason(guild, 5, 10, "26.10.2026");
  assert.equal(new MatchStore(matchPath).list(guild).length, 2);
  assert.equal(new LeagueSettingsStore(settingsPath).get(guild).season, 5);
});
