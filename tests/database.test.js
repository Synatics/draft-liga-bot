const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const { LigaDatabase, DATABASE_NAME } = require("../src/storage/database");
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

test("inconsistent SQL indexes and unknown database versions fail closed without resetting stored reports", (t) => {
  const f = setup(t);
  const db = f.open();
  new MatchStore(f.filePath, db).add(data);
  db.db.prepare("UPDATE reports SET guild_id=?").run("300000000000000002");
  assert.throws(() => db.validate(), /Indizes/);
  assert.equal(db.db.prepare("SELECT count(*) AS count FROM reports").get().count, 1);
  db.db.exec("PRAGMA user_version=999");
  db.close();
  assert.throws(() => f.open(), /Datenbankversion/);
});
