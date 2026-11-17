const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionsBitField,
  PermissionFlagsBits: P,
} = require("discord.js");
const { commands, createInteractionHandler } = require("../src/app/interactions");
const { LigaDatabase, DATABASE_NAME } = require("../src/storage/database");
const { MatchStore, revisionOf } = require("../src/storage/match-store");

const GUILD = "300000000000000001",
  CHANNEL = "400000000000000001",
  THREAD = "400000000000000002";
const ROLE = "100000000000000001",
  MANAGER = "100000000000000002";
const JAN = { id: "200000000000000001", name: "Jan" },
  LEN = { id: "200000000000000002", name: "Lennart" },
  MAX = { id: "200000000000000003", name: "Max" };

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "liga-winrate-"));
  const path = join(dir, DATABASE_NAME);
  const database = new LigaDatabase(path);
  t.after(() => {
    database.close();
    assert.equal(dirname(dir), tmpdir());
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new MatchStore(path, database);
  const asMember = (p) => ({
    id: p.id,
    displayName: p.name,
    user: { id: p.id, bot: false },
    roles: { cache: new Map([[ROLE, {}]]) },
  });
  const members = new Map([JAN, LEN, MAX].map((p) => [p.id, asMember(p)]));
  const viewer = members.get(MAX.id);
  const guild = {
    id: GUILD,
    members: {
      cache: members,
      async fetch({ user, force }) {
        assert.equal(user, MAX.id);
        assert.equal(force, true);
        return viewer;
      },
    },
    channels: {
      async fetch(id, { force }) {
        assert.equal(force, true);
        const channel = {
          guildId: GUILD,
          permissionsFor: (member) => {
            assert.equal(member, viewer);
            return new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]);
          },
        };
        if (id === CHANNEL) return channel;
        if (id === THREAD)
          return {
            ...channel,
            type: ChannelType.PrivateThread,
            members: {
              async fetch({ member, force }) {
                assert.equal(member, MAX.id);
                assert.equal(force, true);
                throw new Error("not a member");
              },
            },
          };
        return null;
      },
    },
  };
  const errors = [];
  const handle = createInteractionHandler({
    database,
    config: { participantRoleId: ROLE, managerRoleId: MANAGER },
    logger: { error: (line) => errors.push(line) },
  });
  async function call({ spieler = JAN.id, gegner = null, season = null, focus, dmError } = {}) {
    const inputs = { spieler, gegner };
    const dms = [];
    const interaction = {
      commandName: "winrate",
      guild,
      // Deliberately stale: authorization must use the freshly fetched invoking member.
      member: { ...viewer, roles: { cache: new Map([[ROLE, {}]]) } },
      isChatInputCommand: () => !focus,
      isAutocomplete: () => Boolean(focus),
      isModalSubmit: () => false,
      options: {
        getInteger: () => season,
        getString: (key) => inputs[key],
        getFocused: () => focus,
      },
      user: {
        id: MAX.id,
        async send(payload) {
          if (dmError) throw dmError;
          dms.push(payload);
        },
      },
      async deferReply(payload) {
        assert.ok(payload.flags.includes(MessageFlags.Ephemeral));
        this.deferred = true;
      },
      async editReply(payload) {
        assert.equal(this.deferred, true);
        this.feedback = payload.content;
      },
      async respond(choices) {
        this.choices = choices;
        this.responded = true;
      },
    };
    await handle(interaction);
    return { ...interaction, dms };
  }
  let serial = 0;
  function game(
    winner,
    loser,
    { season = 4, channelId = CHANNEL, guildId = GUILD, status = "published", known = true } = {},
  ) {
    const id = ++serial;
    const record = store.add({
      guildId,
      channelId,
      season,
      matchday: 1,
      players: [winner, loser],
      link: `https://example.org/${id}`,
      ...(known ? { result: { winnerId: winner.id, loserId: loser.id, score: "2-1" } } : {}),
    });
    if (status !== "pending") store.setPublication(record.id, { status: "sending" });
    if (status === "published")
      store.setPublication(record.id, {
        status,
        messageId: String(500000000000000000n + BigInt(id)),
      });
    return record;
  }
  return { call, game, viewer, members, store, errors };
}

test("the registered guild command sends overall, season, head-to-head and combined balances only to the caller", async (t) => {
  const command = commands.find((c) => c.name === "winrate");
  assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.deepEqual(
    command.options.map((o) => [o.name, o.required, Boolean(o.autocomplete)]),
    [
      ["spieler", true, true],
      ["gegner", false, true],
      ["season", false, false],
    ],
  );
  const { call, game, store } = setup(t);
  const removed = game(JAN, LEN);
  game(JAN, LEN);
  game(LEN, JAN);
  game(JAN, LEN, { season: 5 });
  game(JAN, LEN, { season: 5 });
  game(MAX, JAN, { season: 5 });
  game(JAN, LEN, { channelId: THREAD });
  game(JAN, LEN, { guildId: "300000000000000002" });
  game(JAN, LEN, { status: "pending" });
  game(JAN, LEN, { status: "sending" });
  game(JAN, LEN, { known: false });
  for (const [options, title, line, rate] of [
    [{}, "Gesamtbilanz für Jan · Alle Seasons", "6 Matches · 4 Siege · 2 Niederlagen", "66,7"],
    [
      { season: 4 },
      "Gesamtbilanz für Jan · Season 4",
      "3 Matches · 2 Siege · 1 Niederlage",
      "66,7",
    ],
    [
      { gegner: LEN.id },
      "Jan gegen Lennart · Alle Seasons",
      "5 Duelle · 4 Siege · 1 Niederlage",
      "80",
    ],
    [
      { gegner: LEN.id, season: 5 },
      "Jan gegen Lennart · Season 5",
      "2 Duelle · 2 Siege · 0 Niederlagen",
      "100",
    ],
    [
      { spieler: LEN.id, gegner: JAN.id },
      "Lennart gegen Jan · Alle Seasons",
      "5 Duelle · 1 Sieg · 4 Niederlagen",
      "20",
    ],
  ]) {
    const result = await call(options);
    assert.equal(result.dms.length, 1);
    assert.deepEqual(result.dms[0].allowedMentions, { parse: [] });
    assert.equal(
      result.dms[0].content,
      `**${title}**\n${line}\n**${rate} % Winrate für ${options.spieler === LEN.id ? "Lennart" : "Jan"}**`,
    );
    assert.equal(result.feedback, "Ich habe dir die Bilanz per DM geschickt.");
  }
  store.beginChange(
    removed.id,
    GUILD,
    revisionOf(store.get(removed.id, GUILD)),
    { kind: "delete" },
    MAX,
  );
  store.finishChange(removed.id, GUILD);
  assert.match((await call({ gegner: LEN.id })).dms[0].content, /75 % Winrate für Jan/);
});

test("before the first match the roster is selectable, and zero matches get a DM without an invented percentage", async (t) => {
  const { call, game } = setup(t);
  assert.deepEqual((await call({ focus: { name: "spieler", value: "le" } })).choices, [
    { name: "Lennart", value: LEN.id },
  ]);
  assert.deepEqual(
    (await call({ spieler: JAN.id, focus: { name: "gegner", value: "ja" } })).choices,
    [],
  );
  const empty = await call({ gegner: LEN.id, season: 4 });
  assert.match(empty.dms[0].content, /Jan gegen Lennart · Season 4/);
  assert.match(empty.dms[0].content, /keine gewerteten Matches/);
  assert.ok(!empty.dms[0].content.includes("%"));
  game(MAX, LEN);
  assert.match(
    (await call({ spieler: LEN.id, gegner: MAX.id })).dms[0].content,
    /1 Duell · 0 Siege · 1 Niederlage\n\*\*0 %/,
  );
});

test("old aliases resolve across seasons; suggestions and counts exclude inaccessible or unpublished matches", async (t) => {
  const { call, game } = setup(t);
  const old = { id: "200000000000000004", name: "Alter Name" };
  const renamed = { ...old, name: "Neuer Name" };
  const hidden = { id: "200000000000000005", name: "Geheim" };
  game(old, JAN);
  game(renamed, JAN, { season: 5 });
  game(hidden, JAN, { channelId: THREAD });
  game(hidden, JAN, { status: "sending" });
  game(hidden, JAN, { guildId: "300000000000000002" });
  assert.deepEqual((await call({ focus: { name: "gegner", value: "alt" } })).choices, [
    { name: renamed.name, value: old.id },
  ]);
  assert.deepEqual((await call({ focus: { name: "spieler", value: "geh" } })).choices, []);
  assert.match(
    (await call({ spieler: " alter NAME ", gegner: JAN.id, season: 4 })).dms[0].content,
    /Neuer Name gegen Jan · Season 4[\s\S]*1 Duell · 1 Sieg/,
  );
  assert.match((await call({ spieler: old.id, season: 9 })).dms[0].content, /keine gewerteten/);
  assert.equal((await call({ gegner: hidden.id })).dms.length, 0);
});

test("ambiguous, unknown or identical opponents and invalid seasons never turn into an overall result", async (t) => {
  const { call, members } = setup(t);
  members.get(JAN.id).displayName = "Doppel";
  members.get(LEN.id).displayName = "Doppel";
  const choices = (await call({ focus: { name: "spieler", value: "doppel" } })).choices;
  assert.equal(new Set(choices.map((c) => c.name)).size, 2);
  assert.deepEqual(
    choices.map((c) => c.value),
    [JAN.id, LEN.id],
  );
  for (const [input, expected] of [
    [{ spieler: MAX.id, gegner: "Doppel" }, /„gegner“/],
    [{ spieler: "Doppel" }, /„spieler“/],
    [{ gegner: "unbekannt" }, /Gegner nicht gefunden/],
    [{ gegner: JAN.id }, /verschiedene Spieler/],
    [{ season: 0 }, /1 und 9999/],
  ]) {
    const result = await call(input);
    assert.match(result.feedback, expected);
    assert.equal(result.dms.length, 0);
  }
  const identicalNames = await call({ gegner: LEN.id });
  assert.ok(identicalNames.dms[0].content.includes(`Doppel (${JAN.id}) gegen Doppel (${LEN.id})`));
});

test("revoked roles and server-admin rights cannot grant access; blocked DMs never expose results in the channel", async (t) => {
  const { call, viewer, game, errors } = setup(t);
  game(JAN, LEN);
  viewer.roles.cache.clear();
  viewer.permissions = new PermissionsBitField([P.Administrator]);
  const denied = await call();
  assert.match(denied.feedback, /Nur Teilnehmer/);
  assert.deepEqual(denied.dms, []);
  assert.deepEqual((await call({ focus: { name: "spieler", value: "" } })).choices, []);
  viewer.roles.cache.set(MANAGER, {});
  assert.match((await call()).dms[0].content, /100 %/);
  for (const code of [50007, 50278, "ECONNRESET"]) {
    const blocked = await call({ dmError: Object.assign(new Error("transport failed"), { code }) });
    assert.equal(blocked.dms.length, 0);
    assert.match(
      blocked.feedback,
      typeof code === "number" ? /erlaube Direktnachrichten/ : /später erneut/,
    );
    assert.doesNotMatch(blocked.feedback, /100 %|Jan|Sieg|geschickt/);
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"operation":"winrate.dm"/);
});
