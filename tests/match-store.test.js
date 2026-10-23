const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { MatchStore, normalizeReplayLink } = require("../src/storage/match-store");

const GUILD = "300000000000000001";
const CHANNEL = "400000000000000001";
const JAN = "200000000000000001";
const MAX = "200000000000000002";
const record = (overrides = {}) => ({
  guildId: GUILD,
  channelId: CHANNEL,
  season: 4,
  matchday: 1,
  players: [
    { id: MAX, name: "Max" },
    { id: JAN, name: "Jan" },
  ],
  link: "https://replay.pokemonshowdown.com/gen9ou-123456789",
  ...overrides,
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
  assert.deepEqual(
    matches.map((match) => match.season),
    [4, 5],
  );
  assert.deepEqual(matches[0].players, [
    { id: JAN, name: "Jan" },
    { id: MAX, name: "Max" },
  ]);
  const raw = readFileSync(filePath, "utf8");
  assert.ok(!raw.includes("score"));
  assert.ok(!raw.includes("winner"));
  matches[0].players[0].name = "changed";
  assert.equal(restarted.list(GUILD)[0].players[0].name, "Jan");
});

test("repeated reports do not duplicate an archived replay, while separate matchdays remain distinct", (t) => {
  const { store, filePath } = temporaryStore(t);
  const first = store.add(record());
  const duplicate = store.add(
    record({ players: [...record().players].reverse(), link: ` ${record().link} ` }),
  );
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(first.publication, { status: "pending" });
  store.add(record({ matchday: 2 }));
  assert.equal(new MatchStore(filePath).list(GUILD).length, 2);
});

test("publication reservations and message IDs survive restarts without resetting completed reports", (t) => {
  const { store, filePath } = temporaryStore(t);
  const match = store.add(record());
  store.setPublication(match.id, { status: "sending" });
  const restarted = new MatchStore(filePath);
  assert.equal(restarted.add(record()).publication.status, "sending");
  restarted.setPublication(match.id, { status: "published", messageId: "500000000000000001" });
  const published = new MatchStore(filePath).add(record());
  assert.deepEqual(published.publication, { status: "published", messageId: "500000000000000001" });
  assert.throws(
    () => restarted.setPublication(match.id, { status: "pending" }),
    /Ungültiger Wechsel/,
  );
});

test("older archives stay readable and duplicates remain recognizable without inventing a posting status", (t) => {
  const { filePath } = temporaryStore(t);
  const original = JSON.stringify({ version: 1, matches: [record()] });
  writeFileSync(filePath, original);
  const restarted = new MatchStore(filePath);
  const duplicate = restarted.add(record({ players: [...record().players].reverse() }));
  assert.equal(duplicate.id, undefined);
  assert.equal(duplicate.publication, undefined);
  assert.equal(readFileSync(filePath, "utf8"), original);
  restarted.add(record({ matchday: 2 }));
  assert.equal(new MatchStore(filePath).list(GUILD).length, 2);
});

test("failed publication writes leave the previous on-disk and in-memory states intact", (t) => {
  const { store, filePath } = temporaryStore(t);
  const match = store.add(record());
  store.filePath = join(filePath, "not-a-directory.json");
  assert.throws(() => store.setPublication(match.id, { status: "sending" }), /nicht gespeichert/);
  assert.equal(store.add(record()).publication.status, "pending");
  assert.equal(new MatchStore(filePath).add(record()).publication.status, "pending");
});

test("partial or invalid publication metadata is rejected instead of silently allowing another post", (t) => {
  const { filePath } = temporaryStore(t);
  const id = "a".repeat(24);
  for (const metadata of [
    { id },
    { publication: { status: "pending" } },
    { id, publication: { status: "unknown" } },
    { id, publication: { status: "published" } },
    { id, publication: { status: "sending", messageId: "500000000000000001" } },
  ]) {
    const content = JSON.stringify({ version: 1, matches: [record(metadata)] });
    writeFileSync(filePath, content);
    assert.throws(() => new MatchStore(filePath), /nicht gelesen/);
    assert.equal(readFileSync(filePath, "utf8"), content);
  }
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
  for (const content of [
    "{invalid",
    JSON.stringify({ version: 2, matches: [] }),
    JSON.stringify({ version: 1, matches: [record({ players: [] })] }),
  ]) {
    writeFileSync(filePath, content);
    assert.throws(() => new MatchStore(filePath), /nicht gelesen/);
    assert.equal(readFileSync(filePath, "utf8"), content);
  }
});

test("invalid replay URLs and malformed metadata cannot enter the archive", (t) => {
  const { store } = temporaryStore(t);
  for (const link of [
    "kein-link",
    "javascript:alert(1)",
    "https://",
    "https://example.org/a b",
    "https://example.org\n@everyone",
    "https://example.org/" + "a".repeat(1024),
  ]) {
    assert.throws(() => store.add(record({ link })), /Replay-Link/);
  }
  for (const overrides of [
    { season: 0 },
    { season: 10000 },
    { matchday: 26 },
    { guildId: "other" },
    { players: [record().players[0], record().players[0]] },
  ]) {
    assert.throws(() => store.add(record(overrides)), /Ungültige Daten/);
  }
  assert.equal(normalizeReplayLink(" https://example.org/a>test "), "https://example.org/a%3Etest");
  assert.equal(store.list(GUILD).length, 0);
});

test("playoffs have explicit round identities and never accept a fake matchday, break or inconsistent round metadata", (t) => {
  const { store, filePath } = temporaryStore(t);
  const semifinal = { id: "semifinal", kind: "playoffs" };
  const first = store.add(record({ round: semifinal, matchday: undefined }));
  const final = store.add(
    record({ round: { id: "final", kind: "playoffs" }, matchday: undefined }),
  );
  assert.notEqual(
    first.id,
    final.id,
    "The same players and replay in separate rounds remain distinct",
  );
  assert.equal(store.add(record({ round: semifinal, matchday: undefined })).id, first.id);
  assert.equal(new MatchStore(filePath).get(first.id, GUILD).matchday, undefined);
  const saved = readFileSync(filePath, "utf8");
  for (const overrides of [
    { round: semifinal, matchday: 1 },
    { round: { id: "redraft", kind: "break" }, matchday: undefined },
    { round: { id: "semifinal", kind: "league" } },
    { round: { id: "matchday-2", kind: "league", matchday: 2 }, matchday: 1 },
    { round: { ...semifinal, name: "injected label" }, matchday: undefined },
    { round: { id: "unknown", kind: "playoffs" }, matchday: undefined },
  ])
    assert.throws(() => store.add(record(overrides)), /Ungültige Daten/);
  assert.equal(readFileSync(filePath, "utf8"), saved);
  assert.equal(store.list(GUILD).length, 2);
});
