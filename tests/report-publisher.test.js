const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { MatchStore } = require("../src/storage/match-store");
const { ReportPublisher } = require("../src/reports/report-publisher");
const { createResultMessage } = require("../src/reports/report-ui");

const match = (overrides = {}) => ({
  guildId: "300000000000000001",
  channelId: "400000000000000001",
  season: 4,
  matchday: 1,
  players: [
    { id: "200000000000000001", name: "Jan" },
    { id: "200000000000000002", name: "Max" },
  ],
  link: "https://replay.pokemonshowdown.com/gen9ou-123456789",
  ...overrides,
});
const messageId = "500000000000000001";
const message = createResultMessage("Jan", "Max", "2-0", match().link, { season: 4, matchday: 1 });

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "pokemon-liga-publisher-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "matches.json");
  const store = new MatchStore(filePath);
  return { filePath, store, publisher: new ReportPublisher(store) };
}

test("duplicate submissions, changed scores and restarts reuse the published message instead of sending again", async (t) => {
  const { filePath, store, publisher } = setup(t);
  const sent = [];
  const channel = {
    async send(payload) {
      assert.equal(new MatchStore(filePath).list(match().guildId)[0].publication.status, "sending");
      sent.push(payload);
      return { id: messageId };
    },
  };
  assert.deepEqual(await publisher.publish(match(), channel, message), {
    status: "published",
    messageId,
  });
  const changedMessage = createResultMessage("Max", "Jan", "0-2", match().link, {
    season: 4,
    matchday: 1,
  });
  const reversed = match({ players: [...match().players].reverse() });
  assert.deepEqual(await publisher.publish(reversed, channel, changedMessage), {
    status: "duplicate",
    messageId,
  });
  const restarted = new ReportPublisher(new MatchStore(filePath));
  assert.deepEqual(await restarted.publish(match(), channel, message), {
    status: "duplicate",
    messageId,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].nonce, /^[a-f0-9]{24}$/);
  assert.equal(sent[0].enforceNonce, true);
  assert.deepEqual(sent[0].embeds, message.embeds);
  assert.equal(store.list(match().guildId).length, 1);
});

test("simultaneous submissions reserve one post while different matches can proceed independently", async (t) => {
  const { publisher } = setup(t);
  let release;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const channel = {
    async send() {
      calls++;
      signalStarted();
      await pending;
      return { id: messageId };
    },
  };
  const first = publisher.publish(match(), channel, message);
  await started;
  assert.deepEqual(await publisher.publish(match(), channel, message), { status: "in-progress" });
  const different = await publisher.publish(
    match({ matchday: 2 }),
    {
      async send() {
        calls++;
        return { id: "500000000000000002" };
      },
    },
    message,
  );
  assert.equal(different.status, "published");
  release();
  assert.equal((await first).status, "published");
  assert.equal(calls, 2);
});

test("explicit Discord rejections allow a retry, including after restart, using the same nonce", async (t) => {
  const { filePath, store, publisher } = setup(t);
  const rejected = Object.assign(new Error("Missing Permissions"), { status: 403, code: 50013 });
  let nonce;
  const failure = await publisher.publish(
    match(),
    {
      async send(payload) {
        nonce = payload.nonce;
        throw rejected;
      },
    },
    message,
  );
  assert.equal(failure.status, "failed");
  assert.equal(store.list(match().guildId)[0].publication.status, "pending");
  const restarted = new ReportPublisher(new MatchStore(filePath));
  const retried = await restarted.publish(
    match(),
    {
      async send(payload) {
        assert.equal(payload.nonce, nonce);
        return { id: messageId };
      },
    },
    message,
  );
  assert.equal(retried.status, "published");
});

test("ambiguous network errors, HTTP timeouts and server failures cannot trigger another post after restart", async (t) => {
  const { filePath, publisher } = setup(t);
  for (const [index, status] of [undefined, 408, 500].entries()) {
    const input = match({ matchday: index + 1 });
    let attempts = 0;
    const channel = {
      async send() {
        attempts++;
        throw Object.assign(new Error("Delivery unknown"), { status });
      },
    };
    assert.equal((await publisher.publish(input, channel, message)).status, "uncertain");
    assert.deepEqual(await publisher.publish(input, channel, message), { status: "uncertain" });
    const restarted = new ReportPublisher(new MatchStore(filePath));
    assert.deepEqual(await restarted.publish(input, channel, message), { status: "uncertain" });
    assert.equal(attempts, 1);
  }
});

test("a failure to reserve the post on disk never sends a public message", async (t) => {
  const { filePath, store, publisher } = setup(t);
  store.add(match());
  store.filePath = join(filePath, "not-a-directory.json");
  await assert.rejects(
    publisher.publish(
      match(),
      {
        async send() {
          assert.fail("A failed reservation must never be sent");
        },
      },
      message,
    ),
    /nicht gespeichert/,
  );
  store.filePath = filePath;
  const result = await publisher.publish(
    match(),
    {
      async send() {
        return { id: messageId };
      },
    },
    message,
  );
  assert.equal(
    result.status,
    "published",
    "The in-flight guard must be released after a storage failure",
  );
});

test("a failed status write after Discord accepted the post still prevents duplicates after restart", async (t) => {
  const { filePath, store, publisher } = setup(t);
  let calls = 0;
  const result = await publisher.publish(
    match(),
    {
      async send() {
        calls++;
        store.filePath = join(filePath, "not-a-directory.json");
        return { id: messageId };
      },
    },
    message,
  );
  assert.equal(result.status, "published-unconfirmed");
  assert.equal(result.messageId, messageId);
  const restarted = new ReportPublisher(new MatchStore(filePath));
  assert.deepEqual(
    await restarted.publish(
      match(),
      {
        async send() {
          calls++;
          return { id: messageId };
        },
      },
      message,
    ),
    { status: "uncertain" },
  );
  assert.equal(calls, 1);
});

test("an unsuccessful retry-state write after a rejected send leaves the reservation blocked", async (t) => {
  const { filePath, store, publisher } = setup(t);
  const result = await publisher.publish(
    match(),
    {
      async send() {
        store.filePath = join(filePath, "not-a-directory.json");
        throw Object.assign(new Error("Missing Permissions"), { status: 403 });
      },
    },
    message,
  );
  assert.equal(result.status, "failed-unconfirmed");
  assert.ok(result.storageError);
  assert.equal(new MatchStore(filePath).list(match().guildId)[0].publication.status, "sending");
});

test("legacy entries remain searchable but are never automatically republished", async (t) => {
  const { filePath } = setup(t);
  writeFileSync(filePath, JSON.stringify({ version: 1, matches: [match()] }));
  const store = new MatchStore(filePath);
  const publisher = new ReportPublisher(store);
  const result = await publisher.publish(
    match(),
    {
      async send() {
        assert.fail("An old report with unknown publication status must not be resent");
      },
    },
    message,
  );
  assert.deepEqual(result, { status: "legacy" });
  assert.equal(store.list(match().guildId).length, 1);
});
