const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { MatchStore, normalizeReplayLink } = require("./match-store");

const GUILD = "300000000000000001";
const CHANNEL = "400000000000000001";
const JAN = "200000000000000001";
const MAX = "200000000000000002";
const record = (overrides = {}) => ({
  guildId: GUILD, channelId: CHANNEL, season: 4, matchday: 1,
  players: [{ id: MAX, name: "Max" }, { id: JAN, name: "Jan" }],
  link: "https://replay.pokemonshowdown.com/gen9ou-123456789", ...overrides,
});

function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "pokemon-liga-matches-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "data", "matches.json");
  return { store: new MatchStore(filePath), filePath };
}

test("match archive survives restarts and stores only search metadata, separated by server and season", (t) => {
  const { store, filePath } = temporaryStore(t);
  store.add(record({ score: "2-0", winner: JAN }));
  store.add(record({ season: 5 }));
  store.add(record({ guildId: "300000000000000002" }));
  const restarted = new MatchStore(filePath);
  const matches = restarted.list(GUILD);
  assert.deepEqual(matches.map((match) => match.season), [4, 5]);
  assert.deepEqual(matches[0].players, [{ id: JAN, name: "Jan" }, { id: MAX, name: "Max" }]);
  const raw = readFileSync(filePath, "utf8");
  assert.ok(!raw.includes("score"));
  assert.ok(!raw.includes("winner"));
  matches[0].players[0].name = "changed";
  assert.equal(restarted.list(GUILD)[0].players[0].name, "Jan");
});

test("repeated reports do not duplicate an archived replay, while separate matchdays remain distinct", (t) => {
  const { store, filePath } = temporaryStore(t);
  store.add(record());
  store.add(record({ players: [...record().players].reverse(), link: ` ${record().link} ` }));
  store.add(record({ matchday: 2 }));
  assert.equal(new MatchStore(filePath).list(GUILD).length, 2);
});

test("archive write errors preserve all previous matches in memory and on disk", (t) => {
  const { store, filePath } = temporaryStore(t);
  store.add(record());
  store.filePath = join(filePath, "not-a-directory.json");
  assert.throws(() => store.add(record({ matchday: 2 })), /nicht gespeichert/);
  assert.equal(store.list(GUILD).length, 1);
  assert.equal(new MatchStore(filePath).list(GUILD).length, 1);
});

test("a corrupt archive is reported and never silently overwritten", (t) => {
  const { filePath } = temporaryStore(t);
  for (const content of ["{invalid", JSON.stringify({ version: 2, matches: [] }),
    JSON.stringify({ version: 1, matches: [record({ players: [] })] })]) {
    writeFileSync(filePath, content);
    assert.throws(() => new MatchStore(filePath), /nicht gelesen/);
    assert.equal(readFileSync(filePath, "utf8"), content);
  }
});

test("invalid replay URLs and malformed metadata cannot enter the archive", (t) => {
  const { store } = temporaryStore(t);
  for (const link of ["kein-link", "javascript:alert(1)", "https://", "https://example.org/a b",
    "https://example.org\n@everyone", "https://example.org/" + "a".repeat(1024)]) {
    assert.throws(() => store.add(record({ link })), /Replay-Link/);
  }
  for (const overrides of [{ season: 0 }, { season: 10000 }, { matchday: 26 }, { guildId: "other" },
    { players: [record().players[0], record().players[0]] }]) {
    assert.throws(() => store.add(record(overrides)), /Ungültige Daten/);
  }
  assert.equal(normalizeReplayLink(" https://example.org/a>test "), "https://example.org/a%3Etest");
  assert.equal(store.list(GUILD).length, 0);
});
