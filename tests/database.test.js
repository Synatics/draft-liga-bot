const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const { LigaDatabase, DATABASE_NAME, checkSnapshot } = require("../src/storage/database");
const { MatchStore, revisionOf } = require("../src/storage/match-store");
const { LeagueSettingsStore } = require("../src/storage/league-settings");
const { SqliteBackups } = require("../src/storage/database-backups");
const { ReportPublisher } = require("../src/reports/report-publisher");
const { ReportManager } = require("../src/reports/report-manager");
const { createResultMessage } = require("../src/reports/report-ui");

const GUILD = "300000000000000001",
  CHANNEL = "400000000000000001",
  MESSAGE = "500000000000000001",
  BOT = "600000000000000001";
const JAN = { id: "200000000000000001", name: "Jan" },
  MAX = { id: "200000000000000002", name: "Max" };
const data = {
  guildId: GUILD,
  channelId: CHANNEL,
  season: 4,
  matchday: 1,
  players: [JAN, MAX],
  link: "https://example.org/replay",
  reporter: JAN,
  result: { winnerId: JAN.id, loserId: MAX.id, score: "2-0" },
};

function setup(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "liga-sqlite-test-"));
  const handles = [];
  t.after(() => {
    for (const db of handles)
      try {
        db.close();
      } catch {
        /* Tests may already have closed this handle. */
      }
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, DATABASE_NAME);
  const open = (path = filePath, options) => {
    const db = new LigaDatabase(path, options);
    handles.push(db);
    return db;
  };
  return { directory, filePath, open };
}

test("SQLite imports validated JSON once, preserves identities and pending changes, and never invents historical authors", (t) => {
  const f = setup(t);
  const settings = new LeagueSettingsStore(join(f.directory, "league-settings.json"));
  settings.setSeason(GUILD, 4, 10, "19.10.2026");
  const original = new MatchStore(join(f.directory, "matches.json"));
  const record = original.add({ ...data, reporter: undefined, result: undefined });
  original.setPublication(record.id, { status: "sending" });
  original.setPublication(record.id, { status: "published", messageId: MESSAGE });
  original.beginChange(record.id, GUILD, revisionOf(original.get(record.id, GUILD)), {
    kind: "delete",
  });
  const before = fs.readFileSync(original.filePath, "utf8");
  const db = f.open();
  const store = new MatchStore(f.filePath, db);
  assert.equal(store.get(record.id, GUILD).change.kind, "delete");
  assert.equal(store.get(record.id, GUILD).reporter, undefined);
  assert.equal(new LeagueSettingsStore(f.filePath, undefined, db).get(GUILD).season, 4);
  assert.equal(db.auditEvents(GUILD, 4)[0].action, "imported");
  assert.equal(db.auditEvents(GUILD, 4)[0].actor, null);
  assert.equal(fs.readFileSync(original.filePath, "utf8"), before);
  const backup = fs.readdirSync(f.directory).find((name) => name.startsWith("migration-json-"));
  assert.equal(fs.readFileSync(join(f.directory, backup, "matches.json"), "utf8"), before);
  db.close();
  fs.writeFileSync(original.filePath, "outdated JSON must not be imported again");
  const reopened = f.open();
  assert.equal(reopened.auditEvents(GUILD, 4).length, 1);
  assert.equal(reopened.listMatches(GUILD).length, 1);
});

test("a failed JSON migration retains the originals and retries transactionally after correction", (t) => {
  const f = setup(t);
  const path = join(f.directory, "matches.json");
  fs.writeFileSync(path, "{invalid");
  assert.throws(() => f.open());
  assert.equal(fs.readFileSync(path, "utf8"), "{invalid");
  fs.writeFileSync(path, JSON.stringify({ version: 1, matches: [] }));
  assert.deepEqual(f.open().listMatches(GUILD), []);
});

test("published reports, edits and deletions produce durable before/after events that survive deleting the report", async (t) => {
  const f = setup(t);
  const db = f.open();
  const store = new MatchStore(f.filePath, db);
  const post = {
    author: { id: BOT },
    async edit(payload) {
      this.payload = payload;
    },
    async delete() {},
  };
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    async send(payload) {
      this.payload = payload;
      return { id: MESSAGE };
    },
    messages: {
      async fetch() {
        return post;
      },
    },
  };
  const publisher = new ReportPublisher(store);
  await publisher.publish(data, channel, createResultMessage("Jan", "Max", "2-0", data.link, data));
  const record = store.list(GUILD)[0];
  assert.equal(channel.payload.components[0].toJSON().components.length, 2);
  const target = { ...data, reporter: undefined, result: undefined, matchday: 2 };
  delete target.reporter;
  delete target.result;
  const result = { winnerId: MAX.id, loserId: JAN.id, score: "1-0" };
  await new ReportManager(store).apply(
    record.id,
    GUILD,
    channel,
    BOT,
    {
      kind: "edit",
      target,
      result,
      embed: createResultMessage("Max", "Jan", "1-0", data.link, target).embeds[0].toJSON(),
    },
    revisionOf(store.get(record.id, GUILD)),
    MAX,
  );
  assert.equal(store.get(record.id, GUILD).reporter.id, JAN.id);
  assert.equal(
    post.payload.components[0].toJSON().components[0].custom_id,
    `report:edit:${record.id}`,
  );
  channel.messages.fetch = async () => {
    throw Object.assign(new Error("Already deleted"), { code: 10008 });
  };
  await new ReportManager(store).apply(
    record.id,
    GUILD,
    channel,
    BOT,
    { kind: "delete" },
    revisionOf(store.get(record.id, GUILD)),
    MAX,
  );
  assert.deepEqual(store.list(GUILD), []);
  const events = db.auditEvents(GUILD, 4);
  assert.deepEqual(
    events.map((event) => event.action),
    ["created", "edited", "deleted"],
  );
  assert.equal(events[1].before.matchday, 1);
  assert.equal(events[1].after.matchday, 2);
  assert.equal(events[1].after.result.winnerId, MAX.id);
  assert.equal(events[2].before.result.score, "1-0");
  assert.equal(events[0].actor.id, JAN.id);
  assert.equal(events[2].actor.id, MAX.id);
  db.close();
  assert.equal(f.open().auditEvents(GUILD, 4).length, 3);
});

test("an audit write failure rolls back the report change and retries the same pending operation exactly once", async (t) => {
  const f = setup(t);
  const db = f.open();
  const store = new MatchStore(f.filePath, db);
  const record = store.add(data);
  store.setPublication(record.id, { status: "sending" });
  store.setPublication(record.id, { status: "published", messageId: MESSAGE });
  let deletes = 0;
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    messages: {
      async fetch() {
        if (deletes) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return {
          author: { id: BOT },
          async delete() {
            deletes++;
          },
        };
      },
    },
  };
  const write = db.writeEvent.bind(db);
  const diskError = Object.assign(new Error("private audit request details"), { code: "ENOSPC" });
  db.writeEvent = () => {
    throw diskError;
  };
  await assert.rejects(
    new ReportManager(store).apply(
      record.id,
      GUILD,
      channel,
      BOT,
      { kind: "delete" },
      revisionOf(store.get(record.id, GUILD)),
      MAX,
    ),
    (error) => {
      assert.match(error.message, /Archiv konnte nicht aktualisiert/);
      assert.equal(error.cause.cause, diskError);
      assert.equal(error.context.reportId, record.id);
      assert.equal(error.context.channelId, CHANNEL);
      assert.ok(!error.message.includes("private audit request details"));
      return true;
    },
  );
  assert.equal(db.auditEvents(GUILD, 4).length, 1);
  assert.equal(db.listMatches(GUILD)[0].change.kind, "delete");
  db.writeEvent = write;
  db.close();
  const restarted = f.open();
  const restartedStore = new MatchStore(f.filePath, restarted);
  await new ReportManager(restartedStore).apply(
    record.id,
    GUILD,
    channel,
    BOT,
    undefined,
    undefined,
    JAN,
  );
  assert.equal(restarted.auditEvents(GUILD, 4).length, 2);
  assert.equal(
    restarted.auditEvents(GUILD, 4)[1].actor.id,
    MAX.id,
    "The original requester remains in the durable journal",
  );
  assert.deepEqual(restartedStore.list(GUILD), []);
  assert.equal(deletes, 1);
});

test("SQLite backups are complete snapshots with logs, rotate safely and restore without legacy JSON", (t) => {
  const f = setup(t);
  const db = f.open();
  const store = new MatchStore(f.filePath, db);
  const record = store.add(data);
  store.setPublication(record.id, { status: "sending" });
  store.setPublication(record.id, { status: "published", messageId: MESSAGE });
  new LeagueSettingsStore(f.filePath, undefined, db).setSeason(GUILD, 4, 10, "19.10.2026");
  let date = new Date("2026-10-22T12:00:00Z");
  const backups = new SqliteBackups(f.filePath, { now: () => date, keepCount: 2 });
  assert.equal(backups.create().created, true);
  assert.equal(backups.create().created, false);
  for (let day = 23; day <= 24; day++) {
    date = new Date(`2026-10-${day}T12:00:00Z`);
    backups.create();
  }
  const names = fs.readdirSync(backups.directory);
  assert.equal(names.length, 2);
  const restored = f.open(join(backups.directory, names.sort().at(-1), DATABASE_NAME), {
    readOnly: true,
  });
  assert.equal(restored.auditEvents(GUILD, 4).length, 1);
  assert.equal(restored.listMatches(GUILD)[0].reporter.id, JAN.id);
  assert.equal(
    new LeagueSettingsStore(restored.filePath, undefined, restored).get(GUILD).season,
    4,
  );
  const expected = restored.auditEvents(GUILD, 4);
  assert.deepEqual(restored.auditEvents("300000000000000002", 4), []);
  assert.deepEqual(restored.auditEvents(GUILD, 5), []);
  assert.equal(expected.length, 1);
  assert.throws(() => restored.auditEvents(GUILD), /Season/);
});

test("the backup CLI selects SQLite without a Discord login and a corrupt source cannot prune older backups", (t) => {
  const f = setup(t);
  const db = f.open();
  const store = new MatchStore(f.filePath, db);
  const record = store.add(data);
  store.setPublication(record.id, { status: "sending" });
  store.setPublication(record.id, { status: "published", messageId: MESSAGE });
  const result = spawnSync(process.execPath, [require.resolve("../backup")], {
    cwd: f.directory,
    env: { ...process.env, DATA_DIR: f.directory, RAILWAY_ENVIRONMENT_ID: "", DISCORD_TOKEN: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Datensicherung erstellt/);
  const directory = join(f.directory, "sqlite-backups");
  const before = fs.readdirSync(directory);
  assert.equal(before.length, 1);
  db.close();
  fs.writeFileSync(f.filePath, "corrupt SQLite file");
  assert.throws(() => new SqliteBackups(f.filePath).create({ force: true }));
  assert.deepEqual(fs.readdirSync(directory), before);
});

test("inconsistent results and unknown database versions are rejected without resetting stored reports", (t) => {
  const f = setup(t);
  const db = f.open();
  new MatchStore(f.filePath, db).add(data);
  assert.throws(() => db.db.prepare("UPDATE reports SET winner_id=loser_id").run(), /CHECK/);
  assert.equal(db.db.prepare("SELECT count(*) AS count FROM reports").get().count, 1);
  db.db.exec("PRAGMA user_version=999");
  db.close();
  assert.throws(() => f.open(), /Datenbankversion/);
});

// A fixture in the actual format of the 2.0 release, independent of the new row mappings.
function seedVersionOne(filePath) {
  const db = new DatabaseSync(filePath);
  const season = {
    season: 4,
    matchdays: 3,
    startDate: "2026-10-19",
    history: {
      3: { season: 3, matchdays: 9, currentMatchday: 4 },
    },
  };
  const old = {
    guildId: GUILD,
    channelId: CHANNEL,
    season: 3,
    matchday: 1,
    players: [JAN, MAX],
    link: "https://example.org/old",
  };
  const oldKey = "legacy-" + createHash("sha256").update(JSON.stringify(old)).digest("hex");
  const record = {
    ...data,
    id: "a".repeat(24),
    revision: 2,
    controlsVersion: 1,
    createdAt: "2026-10-19T11:10:00.000Z",
    matchday: undefined,
    round: { id: "semifinal", kind: "playoffs" },
    publication: { status: "published", messageId: MESSAGE },
    change: { kind: "delete", actor: MAX },
  };
  const removed = {
    id: "earlier:deleted",
    action: "deleted",
    reportId: "b".repeat(24),
    guildId: GUILD,
    season: 3,
    channelId: CHANNEL,
    messageId: null,
    at: "2026-10-12T12:34:56.789Z",
    actor: JAN,
    before: old,
    after: null,
  };
  try {
    db.exec(`PRAGMA application_id=0x444c424f; PRAGMA user_version=1;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata VALUES ('initialized','2026-10-19T00:00:00.000Z');
      CREATE TABLE settings (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE reports (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, season INTEGER NOT NULL, channel_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX reports_by_season ON reports(guild_id,season);
      CREATE TABLE audit_events (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, season INTEGER NOT NULL, report_id TEXT NOT NULL, occurred_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX audit_by_season ON audit_events(guild_id,season,occurred_at);`);
    db.prepare("INSERT INTO settings VALUES(?,?)").run(GUILD, JSON.stringify(season));
    const insert = db.prepare("INSERT INTO reports VALUES(?,?,?,?,?)");
    insert.run(oldKey, GUILD, 3, CHANNEL, JSON.stringify(old));
    insert.run(record.id, GUILD, 4, CHANNEL, JSON.stringify(record));
    db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?)").run(
      removed.id,
      GUILD,
      3,
      removed.reportId,
      removed.at,
      JSON.stringify(removed),
    );
    return { record: JSON.parse(JSON.stringify(record)), old, oldKey, removed };
  } finally {
    db.close();
  }
}

test("v1 upgrades once with a restorable v1 backup, historical plans, pending operation, unknown outcome and deleted report log intact", (t) => {
  const f = setup(t);
  const { record, old, oldKey, removed } = seedVersionOne(f.filePath);
  fs.writeFileSync(join(f.directory, "matches.json"), "outdated JSON must never be read");
  const db = f.open();
  assert.equal(db.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.deepEqual(db.getReport(record.id, GUILD), record);
  assert.deepEqual(db.listMatches(GUILD, 3), [old]);
  assert.equal(db.db.prepare("SELECT id FROM reports WHERE season=3").get().id, oldKey);
  assert.deepEqual(db.auditEvents(GUILD, 3), [removed]);
  assert.equal(db.getSeason(GUILD).season, 4);
  assert.equal(db.getSeason(GUILD, 3).currentMatchday, 4);
  assert.equal(
    db.db.prepare("SELECT winner_name FROM report_overview WHERE id=?").get(record.id).winner_name,
    "Jan",
  );
  const copyDir = fs
    .readdirSync(f.directory)
    .find((name) => name.startsWith("migration-sqlite-v1-"));
  const copyPath = join(f.directory, copyDir, DATABASE_NAME);
  assert.equal(checkSnapshot(copyPath), 1);
  const raw = new DatabaseSync(copyPath, { readOnly: true });
  try {
    assert.deepEqual(
      JSON.parse(raw.prepare("SELECT data FROM reports WHERE id=?").get(record.id).data),
      record,
    );
  } finally {
    raw.close();
  }
  db.close();
  const restarted = f.open();
  assert.equal(
    fs.readdirSync(f.directory).filter((name) => name.startsWith("migration-sqlite-v1-")).length,
    1,
  );
  const store = new MatchStore(f.filePath, restarted);
  store.finishChange(record.id, GUILD);
  assert.deepEqual(restarted.listMatches(GUILD, 4), []);
  assert.deepEqual(restarted.auditEvents(GUILD, 4)[0].actor, MAX);
  assert.equal(checkSnapshot(copyPath), 1);
});

test("an inconsistent v1 file is rejected and a failed DDL migration rolls back before retrying", (t) => {
  const f = setup(t);
  const { record } = seedVersionOne(f.filePath);
  const modify = (fn) => {
    const db = new DatabaseSync(f.filePath);
    try {
      fn(db);
    } finally {
      db.close();
    }
  };
  modify((db) => db.prepare("UPDATE reports SET season=2 WHERE id=?").run(record.id));
  assert.throws(() => f.open(), /Indizes/);
  modify((db) => {
    db.prepare("UPDATE reports SET season=4 WHERE id=?").run(record.id);
    db.exec("CREATE TABLE seasons (unrelated TEXT)");
  });
  assert.throws(() => f.open(), /already exists/);
  modify((db) => {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM reports").get().n, 2);
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT data FROM reports WHERE id=?").get(record.id).data),
      record,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='reports_v1'").get(),
      undefined,
    );
    db.exec("DROP TABLE seasons");
  });
  assert.deepEqual(f.open().getReport(record.id, GUILD), record);
});

test("overlapping database handles preserve unrelated reports and historical seasons and reject stale changes", (t) => {
  const f = setup(t),
    a = f.open(),
    b = f.open();
  const first = new MatchStore(f.filePath, a),
    second = new MatchStore(f.filePath, b);
  const report = first.add(data);
  const other = second.add({ ...data, matchday: 2 });
  assert.equal(second.add(data).id, report.id);
  first.setPublication(report.id, { status: "sending" });
  first.setPublication(report.id, { status: "published", messageId: MESSAGE });
  const stale = revisionOf(second.get(report.id, GUILD));
  first.beginChange(report.id, GUILD, stale, { kind: "delete" }, JAN);
  assert.throws(
    () => second.beginChange(report.id, GUILD, stale, { kind: "delete" }, MAX),
    /inzwischen geändert/,
  );
  assert.deepEqual(second.get(report.id, GUILD).change.actor, JAN);
  assert.deepEqual(first.get(other.id, GUILD), other);
  const settingsA = new LeagueSettingsStore(f.filePath, undefined, a),
    settingsB = new LeagueSettingsStore(f.filePath, undefined, b);
  settingsA.setSeason(GUILD, 4, 9, "19.10.2026");
  settingsB.setSeason(GUILD, 5, 10, "26.10.2026");
  assert.equal(settingsA.get(GUILD).season, 5);
  settingsA.setSeason(GUILD, 4, 8, "19.10.2026");
  assert.equal(settingsB.getSeason(GUILD, 5).matchdays, 10);
  assert.equal(settingsB.get(GUILD).matchdays, 8);
});

test("live SQL balances count only current published results, scoped by player, opponent, guild, season and readable channels", (t) => {
  const f = setup(t),
    db = f.open(),
    store = new MatchStore(f.filePath, db);
  const other = { id: "200000000000000009", name: "Lennart" },
    hidden = "400000000000000009";
  let n = 0;
  const game = (winner, loser, overrides = {}, published = true) => {
    const serial = ++n;
    const record = store.add({
      ...data,
      players: [winner, loser],
      result: { winnerId: winner.id, loserId: loser.id, score: "2-1" },
      link: `https://example.org/game-${serial}`,
      ...overrides,
    });
    if (published) {
      store.setPublication(record.id, { status: "sending" });
      store.setPublication(record.id, {
        status: "published",
        messageId: String(BigInt(MESSAGE) + BigInt(serial)),
      });
    }
    return record;
  };
  const first = game(JAN, other);
  game({ ...JAN, name: "Jan neu" }, other);
  game(JAN, other, { season: 5 });
  game(JAN, other);
  game(other, JAN);
  game(MAX, JAN);
  game(JAN, other, { channelId: hidden });
  game(JAN, other, { guildId: "300000000000000009" });
  game(JAN, other, { result: undefined });
  game(JAN, other, {}, false);
  const counts = (options) => db.countResults(GUILD, JAN.id, [CHANNEL], options);
  assert.deepEqual(counts({ opponentId: other.id }), { wins: 4, losses: 1 });
  assert.deepEqual(counts({ opponentId: other.id, season: 4 }), { wins: 3, losses: 1 });
  assert.deepEqual(counts(), { wins: 4, losses: 2 });
  assert.deepEqual(db.countResults(GUILD, other.id, [CHANNEL], { opponentId: JAN.id }), {
    wins: 1,
    losses: 4,
  });
  assert.deepEqual(db.countResults(GUILD, JAN.id, []), { wins: 0, losses: 0 });
  // An edit to one report must not rewrite any of the other rows.
  db.db
    .exec(`CREATE TEMP TABLE touched(id TEXT); CREATE TEMP TRIGGER changed AFTER UPDATE ON reports
    BEGIN INSERT INTO touched VALUES(NEW.id); END;`);
  const saved = store.get(first.id, GUILD);
  const target = {
    guildId: GUILD,
    channelId: CHANNEL,
    season: 4,
    matchday: 1,
    players: saved.players,
    link: saved.link,
  };
  const updated = { winnerId: other.id, loserId: JAN.id, score: "1-0" };
  const embed = createResultMessage(
    other.name,
    JAN.name,
    updated.score,
    saved.link,
    target,
  ).embeds[0].toJSON();
  store.beginChange(
    first.id,
    GUILD,
    revisionOf(saved),
    { kind: "edit", target, embed, result: updated },
    JAN,
  );
  assert.deepEqual(counts({ opponentId: other.id }), { wins: 4, losses: 1 });
  store.finishChange(first.id, GUILD);
  assert.deepEqual(counts({ opponentId: other.id }), { wins: 3, losses: 2 });
  store.beginChange(
    first.id,
    GUILD,
    revisionOf(store.get(first.id, GUILD)),
    { kind: "delete" },
    JAN,
  );
  store.finishChange(first.id, GUILD);
  assert.deepEqual(counts({ opponentId: other.id }), { wins: 3, losses: 1 });
  assert.deepEqual(
    db.db
      .prepare("SELECT DISTINCT id FROM touched")
      .all()
      .map((row) => row.id),
    [first.id],
  );
});
