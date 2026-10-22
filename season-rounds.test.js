const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { LeagueSettingsStore, parseSettingsDocument } = require("./league-settings");
const { LigaDatabase } = require("./database");
const { SqliteBackups } = require("./database-backups");
const { buildRounds, roundLabel } = require("./season-rounds");
const { createReportModal, resolveReportContext } = require("./reports");

const GUILD = "300000000000000001";
const participants = [
  { label: "Jan", value: "200000000000000001" },
  { label: "Max", value: "200000000000000002" },
];

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "liga-rounds-test-"));
  const handles = [];
  t.after(() => {
    for (const db of handles)
      try {
        db.close();
      } catch {
        /* A restart may have closed it. */
      }
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let now = new Date("2026-10-19T12:00:00Z");
  const filePath = join(directory, "liga.sqlite");
  const open = (path = filePath) => {
    const db = new LigaDatabase(path);
    handles.push(db);
    return db;
  };
  const db = open();
  const settings = new LeagueSettingsStore(filePath, () => now, db);
  return {
    directory,
    filePath,
    db,
    settings,
    open,
    at(value) {
      now = new Date(value);
      return settings.get(GUILD);
    },
  };
}

test("a playoff schedule advances from week 9 through redraft to semifinals/final at Berlin Monday midnight", (t) => {
  const f = fixture(t);
  f.settings.setSeason(GUILD, 5, 9, "19.10.2026", { format: "playoffs", redraft: true });
  const stored = f.db.readSettings();
  assert.equal(roundLabel(f.at("2026-12-20T22:59:59.999Z").currentRound), "Spieltag 9");
  const pause = f.at("2026-12-20T23:00:00.000Z");
  assert.equal(pause.week, 10);
  assert.equal(pause.status, "redraft");
  assert.equal(pause.currentMatchday, undefined);
  assert.equal(roundLabel(pause.nextRound), "Playoffs · Halbfinale");
  assert.equal(f.at("2026-12-27T22:59:59.999Z").status, "redraft");
  const semifinal = f.at("2026-12-27T23:00:00.000Z");
  assert.equal(semifinal.week, 11);
  assert.equal(semifinal.currentRound.id, "semifinal");
  assert.equal(f.at("2027-01-03T23:00:00Z").currentRound.id, "final");
  assert.equal(f.at("2027-02-01T12:00:00Z").status, "finished");
  assert.equal(f.at("2026-10-18T21:59:59Z").status, "upcoming");
  assert.equal(f.at("2026-10-18T22:00:00Z").status, "active");
  assert.equal(f.at("2026-10-25T22:59:59Z").currentRound.id, "matchday-1");
  assert.equal(f.at("2026-10-25T23:00:00Z").currentRound.id, "matchday-2");
  assert.equal(f.db.readSettings(), stored, "Calendar progress must not write to disk");
});

test("home and away rounds keep consecutive matchdays and skip only the optional redraft week", (t) => {
  const f = fixture(t);
  f.settings.setSeason(GUILD, 5, 18, "19.10.2026", { format: "home-away", redraft: true });
  assert.equal(roundLabel(f.at("2026-12-14T12:00:00Z").currentRound), "Hinrunde · Spieltag 9");
  assert.equal(f.at("2026-12-21T12:00:00Z").status, "redraft");
  assert.equal(roundLabel(f.at("2026-12-28T12:00:00Z").currentRound), "Rückrunde · Spieltag 10");
  assert.equal(roundLabel(f.at("2027-02-22T12:00:00Z").currentRound), "Rückrunde · Spieltag 18");
  assert.ok(f.settings.get(GUILD).rounds.every((round) => round.kind !== "playoffs"));
  f.settings.setSeason(GUILD, 5, 18, "19.10.2026", { format: "home-away" });
  assert.equal(roundLabel(f.at("2026-12-21T12:00:00Z").currentRound), "Rückrunde · Spieltag 10");
  f.settings.setSeason(GUILD, 5, 9, "19.10.2026", { format: "playoffs" });
  assert.equal(f.at("2026-12-21T12:00:00Z").currentRound.id, "semifinal");
});

test("all playoff presets end in a final, and invalid formats cannot replace the saved season", (t) => {
  const f = fixture(t);
  for (const [first, count] of [
    ["round-of-16", 4],
    ["quarterfinal", 3],
    ["semifinal", 2],
    ["final", 1],
  ]) {
    const settings = f.settings.setSeason(GUILD, 5, 9, "19.10.2026", {
      format: "playoffs",
      playoffsFrom: first,
    });
    assert.equal(settings.rounds.length, 9 + count);
    assert.equal(settings.rounds[9].id, first);
    assert.equal(settings.rounds.at(-1).id, "final");
  }
  const previous = f.db.readSettings();
  for (const [days, options] of [
    [9, { format: "home-away" }],
    [9, { format: "league", redraft: true }],
    [25, { format: "playoffs" }],
    [9, { format: "playoffs", playoffsFrom: "redraft" }],
    [18, { format: "home-away", playoffsFrom: "final" }],
    [9, { format: "unknown" }],
  ]) {
    assert.throws(() => f.settings.setSeason(GUILD, 6, days, "26.10.2026", options));
    assert.equal(f.db.readSettings(), previous);
    assert.equal(f.settings.get(GUILD).season, 5);
  }
  assert.equal(buildRounds(25).length, 25);
  assert.equal(buildRounds(23, { format: "playoffs" }).length, 25);
});

test("planned report modals keep five fields, skip redraft choices and reject forged or stale round selections", (t) => {
  const f = fixture(t);
  f.settings.setSeason(GUILD, 5, 9, "19.10.2026", { format: "playoffs", redraft: true });
  const pause = f.at("2026-12-21T12:00:00Z");
  const modal = createReportModal(participants, pause).toJSON();
  assert.equal(modal.components.length, 5);
  const select = modal.components[0].component;
  assert.equal(select.custom_id, "round");
  assert.equal(select.options.length, 11);
  assert.ok(!select.options.some((option) => option.value === "redraft" || option.default));
  const fields = (id) => ({ getStringSelectValues: () => [id] });
  assert.equal(resolveReportContext(modal.custom_id, fields("matchday-9"), pause).matchday, 9);
  const playoffs = f.at("2026-12-28T12:00:00Z");
  assert.equal(
    createReportModal(participants, playoffs)
      .toJSON()
      .components[0].component.options.find((option) => option.default).value,
    "semifinal",
  );
  const context = resolveReportContext(modal.custom_id, fields("semifinal"), playoffs);
  assert.deepEqual(context, { season: 5, round: { id: "semifinal", kind: "playoffs" } });
  for (const invalid of ["redraft", "quarterfinal", "matchday-10", "unknown"])
    assert.throws(() => resolveReportContext(modal.custom_id, fields(invalid), playoffs), /Runde/);
  f.settings.setSeason(GUILD, 5, 18, "19.10.2026", { format: "home-away", redraft: true });
  assert.throws(
    () => resolveReportContext(modal.custom_id, fields("semifinal"), f.settings.get(GUILD)),
    /inzwischen geändert/,
  );
});

test("SQLite restarts and backups retain historical season plans without exposing mutable internal settings", (t) => {
  const f = fixture(t);
  f.settings.setSeason(GUILD, 5, 9, "19.10.2026", { format: "playoffs", redraft: true });
  f.settings.setSeason(GUILD, 6, 18, "19.10.2026", { format: "home-away", redraft: true });
  const returned = f.settings.getSeason(GUILD, 5);
  returned.rounds[0].id = "corrupted";
  assert.equal(f.settings.getSeason(GUILD, 5).rounds[0].id, "matchday-1");
  const backup = new SqliteBackups(f.filePath).create({ force: true });
  f.db.close();
  const restarted = new LeagueSettingsStore(f.filePath, undefined, f.open());
  assert.equal(restarted.get(GUILD).season, 6);
  assert.equal(restarted.getSeason(GUILD, 5).rounds.at(-1).id, "final");
  const restoredDb = f.open(join(backup.path, "liga.sqlite"));
  const restored = new LeagueSettingsStore(restoredDb.filePath, undefined, restoredDb);
  assert.equal(restored.getSeason(GUILD, 5).format, "playoffs");
  assert.equal(restored.getSeason(GUILD, 6).rounds[10].leg, "second");
  const corrupt = JSON.parse(restoredDb.readSettings());
  corrupt.guilds[GUILD].history[5].rounds[9] = { id: "final", kind: "playoffs" };
  assert.throws(() => parseSettingsDocument(JSON.stringify(corrupt)), /Rundenplan/);
});
