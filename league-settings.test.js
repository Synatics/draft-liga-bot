const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { LeagueSettingsStore, settingsFilePath, normalizeStartDate, currentMatchday } = require("./league-settings");

const fixedNow = () => new Date("2026-10-18T12:00:00Z");

function temporaryStore(t, now = fixedNow) {
  const directory = mkdtempSync(join(tmpdir(), "pokemon-liga-settings-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "league-settings.json");
  return { store: new LeagueSettingsStore(filePath, now), filePath };
}

test("season and matchday survive a restart and remain separate for each guild", (t) => {
  const { store, filePath } = temporaryStore(t);
  assert.throws(() => store.get("guild-a"), /noch nicht eingerichtet/);
  store.setSeason("guild-a", 3, 9, "31.08.2026");
  store.setSeason("guild-b", 8, 18, "12.10.2026");
  const restarted = new LeagueSettingsStore(filePath, fixedNow);
  assert.deepEqual(restarted.get("guild-a"), { season: 3, matchdays: 9, startDate: "2026-08-31", currentMatchday: 7 });
  assert.deepEqual(restarted.get("guild-b"), { season: 8, matchdays: 18, startDate: "2026-10-12", currentMatchday: 1 });
  const returned = restarted.get("guild-a");
  returned.season = 99;
  assert.equal(restarted.get("guild-a").season, 3);
});

test("the current matchday follows the configured start date and stays within the season", (t) => {
  const { store } = temporaryStore(t);
  assert.equal(store.setSeason("guild", 3, 9, "31.08.2026").currentMatchday, 7);
  assert.equal(store.setSeason("guild", 3, 18, "31.08.2026").currentMatchday, 7);
  assert.equal(store.setSeason("guild", 3, 5, "31.08.2026").currentMatchday, 5);
  assert.deepEqual(store.setSeason("guild", 4, 9, "19.10.2026"), {
    season: 4, matchdays: 9, startDate: "2026-10-19", currentMatchday: 1,
  });
});

test("invalid season settings do not change the saved schedule", (t) => {
  const { store, filePath } = temporaryStore(t);
  store.setSeason("guild", 3, 9, "31.08.2026");
  const original = readFileSync(filePath, "utf8");
  for (const season of [0, -1, 1.5, 10000, "3", NaN]) {
    assert.throws(() => store.setSeason("guild", season, 9, "31.08.2026"), /Die Season muss/);
  }
  for (const rounds of [0, 26, 1.5, "9"]) {
    assert.throws(() => store.setSeason("guild", 4, rounds, "31.08.2026"), /Anzahl der Spieltage/);
  }
  for (const startDate of [undefined, "2026-02-29", "18.10.2026", "invalid"]) {
    assert.throws(() => store.setSeason("guild", 4, 9, startDate), /Startdatum/);
  }
  assert.equal(readFileSync(filePath, "utf8"), original);
});

test("a write failure cannot change the active or previously saved season", (t) => {
  const { store, filePath } = temporaryStore(t);
  store.setSeason("guild", 3, 9, "31.08.2026");
  store.filePath = join(filePath, "not-a-directory.json");
  assert.throws(() => store.setSeason("guild", 4, 18, "19.10.2026"), /nicht gespeichert/);
  assert.equal(store.get("guild").season, 3);
  assert.equal(new LeagueSettingsStore(filePath, fixedNow).get("guild").season, 3);
});

test("damaged settings are reported instead of silently resetting the season", (t) => {
  const { filePath } = temporaryStore(t);
  for (const content of ["{invalid", JSON.stringify({ version: 2, guilds: {} }),
    JSON.stringify({ version: 1, guilds: { guild: { season: 3, matchdays: 9, currentMatchday: 10 } } })]) {
    writeFileSync(filePath, content);
    assert.throws(() => new LeagueSettingsStore(filePath), /nicht gelesen/);
    assert.equal(readFileSync(filePath, "utf8"), content);
  }
});

test("Railway settings require a volume and are stored inside its mount path", () => {
  const volume = join(tmpdir(), "liga-volume");
  assert.equal(settingsFilePath({ RAILWAY_VOLUME_MOUNT_PATH: volume }), join(volume, "league-settings.json"));
  assert.equal(settingsFilePath({ RAILWAY_ENVIRONMENT_ID: "test", RAILWAY_VOLUME_MOUNT_PATH: volume,
    DATA_DIR: join(volume, "bot") }), join(volume, "bot", "league-settings.json"));
  assert.throws(() => settingsFilePath({ RAILWAY_ENVIRONMENT_ID: "test" }), /Volume/);
  assert.throws(() => settingsFilePath({ RAILWAY_ENVIRONMENT_ID: "test", RAILWAY_VOLUME_MOUNT_PATH: volume,
    DATA_DIR: tmpdir() }), /innerhalb/);
  assert.equal(settingsFilePath({ DATA_DIR: volume }), join(volume, "league-settings.json"));
});

test("start dates accept German or ISO notation and must be a real calendar Monday", () => {
  assert.equal(normalizeStartDate("19.10.2026"), "2026-10-19");
  assert.equal(normalizeStartDate("2026-10-19"), "2026-10-19");
  assert.equal(normalizeStartDate("2024-02-26"), "2024-02-26");
  for (const invalid of ["31.04.2026", "2026-02-29", "2026-00-19", "2026-10-00", "0000-01-01", "26-10-19", ""]) {
    assert.throws(() => normalizeStartDate(invalid), /Startdatum/);
  }
  assert.throws(() => normalizeStartDate("18.10.2026"), /Montag/);
});

test("Monday midnight in Germany advances the matchday, even on a server using another timezone", () => {
  const settings = { season: 3, matchdays: 9, startDate: "2026-10-12" };
  assert.equal(currentMatchday(settings, new Date("2026-10-18T21:59:59.999Z")), 1);
  assert.equal(currentMatchday(settings, new Date("2026-10-18T22:00:00.000Z")), 2);
  assert.equal(currentMatchday(settings, new Date("2026-10-24T12:00:00Z")), 2);
  assert.equal(currentMatchday(settings, new Date("2026-10-25T22:59:59.999Z")), 2);
  assert.equal(currentMatchday(settings, new Date("2026-10-25T23:00:00.000Z")), 3);
});

test("a spring DST week advances after 167 hours and an autumn week after 169 hours", () => {
  const spring = { season: 3, matchdays: 9, startDate: "2026-03-23" };
  assert.equal(currentMatchday(spring, new Date("2026-03-29T21:59:59.999Z")), 1);
  assert.equal(currentMatchday(spring, new Date("2026-03-29T22:00:00.000Z")), 2);
  const autumn = { season: 3, matchdays: 9, startDate: "2026-10-19" };
  assert.equal(currentMatchday(autumn, new Date("2026-10-25T22:59:59.999Z")), 1);
  assert.equal(currentMatchday(autumn, new Date("2026-10-25T23:00:00.000Z")), 2);
});

test("matchdays cross year boundaries and leap days and are capped before and after the season", () => {
  const yearEnd = { season: 3, matchdays: 2, startDate: "2026-12-28" };
  assert.equal(currentMatchday(yearEnd, new Date("2026-12-20T12:00:00Z")), 1);
  assert.equal(currentMatchday(yearEnd, new Date("2027-01-03T22:59:59.999Z")), 1);
  assert.equal(currentMatchday(yearEnd, new Date("2027-01-03T23:00:00.000Z")), 2);
  assert.equal(currentMatchday(yearEnd, new Date("2027-12-30T12:00:00Z")), 2);
  const leapWeek = { season: 3, matchdays: 9, startDate: "2024-02-26" };
  assert.equal(currentMatchday(leapWeek, new Date("2024-03-03T23:00:00Z")), 2);
});

test("weeks advance without disk writes and are immediately correct after several weeks offline", (t) => {
  let now = new Date("2026-10-18T12:00:00Z");
  const { store, filePath } = temporaryStore(t, () => now);
  store.setSeason("guild", 3, 9, "12.10.2026");
  const saved = readFileSync(filePath, "utf8");
  assert.equal(store.get("guild").currentMatchday, 1);
  now = new Date("2026-11-02T12:00:00Z");
  assert.equal(store.get("guild").currentMatchday, 4);
  assert.equal(readFileSync(filePath, "utf8"), saved);
  assert.equal(new LeagueSettingsStore(filePath, () => now).get("guild").currentMatchday, 4);
});

test("previous manual settings stay readable and can be switched to a weekly schedule once", (t) => {
  const { filePath } = temporaryStore(t);
  writeFileSync(filePath, JSON.stringify({ version: 1, guilds: {
    guild: { season: 3, matchdays: 9, currentMatchday: 7 },
  } }));
  const store = new LeagueSettingsStore(filePath, fixedNow);
  assert.equal(store.get("guild").currentMatchday, 7);
  assert.equal(store.setSeason("guild", 3, 9, "31.08.2026").currentMatchday, 7);
  assert.equal(store.get("guild").startDate, "2026-08-31");
  assert.equal(JSON.parse(readFileSync(filePath, "utf8")).guilds.guild.currentMatchday, undefined);
});
