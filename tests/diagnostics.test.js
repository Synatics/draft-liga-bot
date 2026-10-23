const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { causedError, logError, interactionContext } = require("../src/shared/diagnostics");
const { LigaDatabase } = require("../src/storage/database");
const { MatchStore, MatchStoreError } = require("../src/storage/match-store");
const { LeagueSettingsStore } = require("../src/storage/league-settings");
const { prepareStartup, failStartup } = require("../src/app/startup");

const GUILD = "300000000000000001",
  CHANNEL = "400000000000000001",
  USER = "200000000000000001";
const REPORT = "a".repeat(24),
  SECRET = "never-print-this-token-or-request-body";
const record = {
  guildId: GUILD,
  channelId: CHANNEL,
  season: 4,
  matchday: 1,
  players: [
    { id: USER, name: "Jan" },
    { id: "200000000000000002", name: "Max" },
  ],
  link: "https://example.org/replay",
};

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "liga-diagnostics-test-"));
  const handles = [];
  t.after(() => {
    for (const database of handles)
      try {
        database.close();
      } catch {
        /* Tests may already have closed a handle. */
      }
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    open(path, options) {
      const db = new LigaDatabase(path, options);
      handles.push(db);
      return db;
    },
  };
}

function capture(error, context) {
  const messages = [];
  logError("Diagnose:", error, context, {
    error(...args) {
      assert.equal(args.length, 1);
      messages.push(args[0]);
    },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].split("\n").length, 1);
  assert.ok(!messages[0].includes(SECRET));
  return JSON.parse(messages[0].slice("Diagnose: ".length));
}

test("storage failures retain their system cause and report IDs without logging requests, file contents or paths", () => {
  for (const [code, hint] of [
    ["EACCES", /Zugriff verweigert/],
    ["ENOSPC", /Datenträger voll/],
    ["EROFS", /schreibgeschützt/],
  ]) {
    const original = Object.assign(new Error(`${SECRET}\nforged-log-entry`), {
      code,
      path: SECRET,
      requestBody: { token: SECRET },
      headers: { Authorization: SECRET },
    });
    const wrapped = causedError(MatchStoreError, "Speicherung fehlgeschlagen.", original, {
      ...record,
      reportId: REPORT,
      operation: "archive.write",
      file: "liga.sqlite",
    });
    assert.equal(wrapped.cause, original);
    const details = capture(wrapped, { userId: USER });
    assert.equal(details.guildId, GUILD);
    assert.equal(details.channelId, CHANNEL);
    assert.equal(details.reportId, REPORT);
    assert.equal(details.userId, USER);
    assert.equal(details.file, "liga.sqlite");
    assert.equal(details.causes.at(-1).code, code);
    assert.match(details.causes.at(-1).hint, hint);
    assert.ok(!JSON.stringify(details).includes("forged-log-entry"));
    assert.equal(details.players, undefined);
  }
});

test("a genuine SQLite full error logs its specific result code rather than only ERR_SQLITE_ERROR", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE entries(value TEXT)");
    const pages = db.prepare("PRAGMA page_count").get().page_count;
    db.exec(`PRAGMA max_page_count=${pages}`);
    assert.throws(
      () => db.prepare("INSERT INTO entries VALUES(?)").run("x".repeat(100000)),
      (error) => {
        const details = capture(error);
        assert.equal(details.causes[0].sqliteName, "SQLITE_FULL");
        assert.equal(details.causes[0].sqliteCode, 13);
        assert.match(details.causes[0].hint, /voll/);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("read-only SQLite report and season writes preserve the real cause and leave stored data unchanged", (t) => {
  const f = fixture(t);
  const path = join(f.directory, "liga.sqlite");
  f.open(path).close();
  const readOnly = f.open(path, { readOnly: true });
  const matches = new MatchStore(path, readOnly);
  const settings = new LeagueSettingsStore(path, undefined, readOnly);
  for (const write of [
    () => matches.add(record),
    () => settings.setSeason(GUILD, 4, 10, "19.10.2026"),
  ]) {
    assert.throws(write, (error) => {
      assert.equal(error.cause.code, "ERR_SQLITE_ERROR");
      const details = capture(error);
      assert.equal(details.guildId, GUILD);
      assert.equal(details.causes.at(-1).sqliteName, "SQLITE_READONLY");
      assert.match(details.causes.at(-1).hint, /schreibgeschützt/);
      if (error instanceof MatchStoreError) assert.match(details.reportId, /^[a-f0-9]{24}$/);
      return true;
    });
  }
  assert.deepEqual(matches.list(GUILD), []);
  assert.throws(() => settings.get(GUILD), /noch nicht eingerichtet/);
});

test("failed legacy JSON writes and reads retain diagnostic causes while user messages stay generic", (t) => {
  const f = fixture(t);
  const path = join(f.directory, "matches.json");
  const matches = new MatchStore(path);
  matches.filePath = join(path, "not-a-directory.json");
  assert.throws(
    () => matches.add(record),
    (error) => {
      assert.ok(error.cause.code);
      assert.equal(capture(error).reportId.length, 24);
      return true;
    },
  );
  for (const [name, read] of [
    ["matches.json", () => new MatchStore(path)],
    [
      "league-settings.json",
      () => new LeagueSettingsStore(join(f.directory, "league-settings.json")),
    ],
  ]) {
    fs.writeFileSync(join(f.directory, name), `{"secret":"${SECRET}",`);
    assert.throws(read, (error) => {
      assert.ok(!error.message.includes(SECRET));
      const details = capture(error);
      assert.equal(details.file, name);
      assert.equal(details.causes.at(-1).type, "SyntaxError");
      return true;
    });
  }
});

test("startup keeps the failing migration file identifiable without printing invalid JSON containing credentials", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.directory, "matches.json"), `{"token":"${SECRET}",`);
  let failure;
  try {
    prepareStartup({
      DATA_DIR: f.directory,
      DISCORD_TOKEN: SECRET,
      CLIENT_ID: "600000000000000001",
      PARTICIPANT_ROLE_ID: "100000000000000001",
    });
    assert.fail("Invalid migration must stop startup");
  } catch (error) {
    failure = error;
  }
  const messages = [];
  await failStartup(failure, undefined, {
    logger: {
      error(message) {
        messages.push(message);
      },
    },
    runtime: { exit() {} },
  });
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes(SECRET));
  assert.match(messages[0], /"file":"matches.json"/);
  assert.match(messages[0], /SyntaxError/);
});

test("a rollback failure cannot replace the original database failure in diagnostics", () => {
  const primary = Object.assign(new Error(SECRET), { code: "ENOSPC" });
  const secondary = Object.assign(new Error(SECRET), { code: "EIO" });
  const database = Object.create(LigaDatabase.prototype);
  database.db = {
    isTransaction: true,
    exec(sql) {
      if (sql === "ROLLBACK") throw secondary;
    },
  };
  assert.throws(
    () =>
      database.transaction(() => {
        throw primary;
      }),
    (error) => {
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, secondary]);
      assert.deepEqual(
        capture(error)
          .causes.filter((cause) => cause.code)
          .map((cause) => cause.code),
        ["ENOSPC", "EIO"],
      );
      return true;
    },
  );
});

test("unknown fields, forged IDs and cyclic or oversized error chains cannot leak secrets or flood a log line", () => {
  const error = Object.assign(new Error(SECRET), {
    name: SECRET,
    code: SECRET,
    errstr: SECRET,
    constructor: { name: SECRET },
    context: { guildId: SECRET, reportId: SECRET, operation: SECRET, file: SECRET },
  });
  error.cause = error;
  error.errors = Array.from({ length: 100 }, () => new Error(SECRET));
  const details = capture(error, {
    channelId: `${CHANNEL}\n${SECRET}`,
    command: SECRET,
    userId: SECRET,
    headers: { Authorization: SECRET },
  });
  assert.equal(details.guildId, undefined);
  assert.equal(details.channelId, undefined);
  assert.equal(details.causes.length, 12);
  assert.ok(JSON.stringify(details).length < 2000);
  assert.equal(capture(Object.assign(new Error(SECRET), { context: null })).causes.length, 1);
});

test("management interactions provide report IDs without including raw custom IDs or submitted modal fields", () => {
  const context = interactionContext({
    guild: { id: GUILD },
    channelId: CHANNEL,
    user: { id: USER },
    customId: `manage:edit:${REPORT}:1234567890abcdef:${USER}`,
    fields: { token: SECRET },
  });
  assert.deepEqual(context, { guildId: GUILD, channelId: CHANNEL, userId: USER, reportId: REPORT });
  const details = capture(Object.assign(new Error(SECRET), { code: 50013, status: 403 }), context);
  assert.equal(details.causes[0].discordCode, 50013);
  assert.equal(details.causes[0].httpStatus, 403);
});
