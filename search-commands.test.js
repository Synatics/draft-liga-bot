const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ChannelType,
  Collection,
  MessageFlags,
  PermissionsBitField,
  PermissionFlagsBits,
} = require("discord.js");
const {
  handleSearchAutocomplete,
  handleSearchCommand,
  playerChoices,
  resultMessages,
} = require("./search-commands");

const JAN = "200000000000000001";
const MAX = "200000000000000002";
const CHANNEL = "400000000000000001";
const GUILD = "300000000000000001";
const match = (overrides = {}) => ({
  guildId: GUILD,
  channelId: CHANNEL,
  season: 4,
  matchday: 1,
  players: [
    { id: JAN, name: "Jan" },
    { id: MAX, name: "Max" },
  ],
  link: "https://replay.pokemonshowdown.com/gen9ou-123456789",
  ...overrides,
});
const storeWith = (matches) => ({
  list: (guildId) => matches.filter((entry) => entry.guildId === guildId),
});

function interaction({ season = 4, name = JAN, matchday = null } = {}) {
  const dms = [];
  return {
    guild: {
      id: GUILD,
      channels: {
        cache: new Collection([
          [
            CHANNEL,
            {
              permissionsFor: () =>
                new PermissionsBitField([
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                ]),
            },
          ],
        ]),
      },
    },
    member: {},
    user: {
      id: JAN,
      async send(payload) {
        dms.push(payload);
      },
    },
    options: {
      getInteger: (key) => (key === "season" ? season : matchday),
      getString: () => name,
      getFocused: () => ({ name: "name", value: name }),
    },
    sent: [],
    dms,
    async deferReply(payload) {
      this.defer = payload;
    },
    async editReply(payload) {
      this.sent.push(payload);
    },
    async respond(choices) {
      this.choices = choices;
    },
  };
}

test("search filters by season, player ID and optional matchday and sends the same result layout by DM", async () => {
  const first = match();
  const second = match({ matchday: 2, link: "https://example.org/two" });
  const unrelated = match({
    players: [{ id: "200000000000000003", name: "Lennart" }, first.players[1]],
  });
  const store = storeWith([first, second, match({ season: 5 }), unrelated]);
  const all = interaction();
  await handleSearchCommand(all, store);
  assert.ok(all.defer.flags.includes(MessageFlags.Ephemeral));
  assert.equal(all.sent.length, 1);
  assert.equal(all.dms.length, 1);
  assert.equal(
    all.dms[0].content,
    `**Spieltag 1 · Jan vs. Max**\n<${first.link}>\n\n**Spieltag 2 · Jan vs. Max**\n<${second.link}>`,
  );
  assert.deepEqual(all.dms[0].allowedMentions, { parse: [] });
  assert.equal(all.sent[0].content, "✅ Ich habe dir 2 Replays per DM geschickt.");
  const specific = interaction({ name: "jan", matchday: 2 });
  await handleSearchCommand(specific, store);
  assert.equal(specific.dms[0].content, `**Spieltag 2 · Jan vs. Max**\n<${second.link}>`);
  assert.equal(specific.sent[0].content, "✅ Ich habe dir 1 Replay per DM geschickt.");
});

test("search suggests archived participants without a role and resolves old names to the same ID", async () => {
  const renamed = match({
    matchday: 2,
    players: [{ id: JAN, name: "Roran321" }, match().players[1]],
  });
  const store = storeWith([match(), renamed]);
  const autocomplete = interaction({ name: "ja" });
  await handleSearchAutocomplete(autocomplete, store);
  assert.deepEqual(autocomplete.choices, [{ name: "Roran321", value: JAN }]);
  const byOldName = interaction({ name: "JAN" });
  await handleSearchCommand(byOldName, store);
  assert.match(byOldName.dms[0].content, /Roran321/);
  assert.match(byOldName.dms[0].content, /Jan/);
});

test("duplicate names offer distinct choices and require selection rather than guessing", async () => {
  const sameName = match({
    players: [
      { id: JAN, name: "Max" },
      { id: MAX, name: "Max" },
    ],
  });
  const choices = playerChoices([sameName], 4, "max");
  assert.equal(new Set(choices.map((entry) => entry.name)).size, 2);
  assert.deepEqual(
    choices.map((entry) => entry.value),
    [JAN, MAX],
  );
  await assert.rejects(
    handleSearchCommand(interaction({ name: "Max" }), storeWith([sameName])),
    /Mehrere Teilnehmer/,
  );
  const selected = interaction({ name: MAX });
  await handleSearchCommand(selected, storeWith([sameName]));
  assert.match(selected.dms[0].content, /Max vs\. Max/);
});

test("search and suggestions never expose records from other servers, unreadable channels or private threads", async () => {
  const privateChannel = "400000000000000002";
  const privateThread = "400000000000000003";
  const store = storeWith([
    match({ guildId: "300000000000000002" }),
    match({ channelId: privateChannel }),
    match({ channelId: privateThread }),
  ]);
  const search = interaction();
  search.guild.channels.cache.set(privateChannel, {
    permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
  });
  search.guild.channels.cache.set(privateThread, {
    type: ChannelType.PrivateThread,
    members: { cache: new Collection() },
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
  });
  await handleSearchCommand(search, store);
  assert.match(search.sent[0].content, /Keine passenden Replays/);
  assert.equal(search.dms.length, 0);
  await handleSearchAutocomplete(search, store);
  assert.deepEqual(search.choices, []);
  search.guild.channels.cache.get(privateThread).members.cache.set(JAN, {});
  await handleSearchCommand(search, store);
  assert.match(search.dms[0].content, /Jan vs\. Max/);
});

test("large searches send every replay within Discord's message limit as normal DMs", async () => {
  const matches = Array.from({ length: 25 }, (_, index) =>
    match({ matchday: index + 1, link: `https://example.org/${"a".repeat(900)}${index}` }),
  );
  const search = interaction();
  await handleSearchCommand(search, storeWith(matches));
  assert.ok(search.dms.length > 1);
  assert.ok(search.dms.every((message) => message.content.length <= 2000));
  assert.ok(search.dms.every((message) => !message.flags.includes(MessageFlags.Ephemeral)));
  assert.equal(
    search.dms.flatMap((message) => message.content.match(/https:\/\//g) || []).length,
    25,
  );
  assert.ok(search.dms.every((message) => message.flags.includes(MessageFlags.SuppressEmbeds)));
  assert.equal(search.sent.length, 1);
  assert.equal(search.sent[0].content, "✅ Ich habe dir 25 Replays per DM geschickt.");
});

test("search handles empty archives, unknown players and missing optional day without requiring an active season", async () => {
  for (const matches of [[], [match({ season: 3 })]]) {
    const search = interaction({ name: "Unbekannt" });
    await handleSearchCommand(search, storeWith(matches));
    assert.match(search.sent[0].content, /Keine passenden Replays/);
    assert.equal(search.dms.length, 0);
  }
  const missingSeason = interaction({ season: null, name: "Ja" });
  await handleSearchAutocomplete(missingSeason, storeWith([match()]));
  assert.deepEqual(missingSeason.choices, []);
  await assert.rejects(
    handleSearchCommand(interaction({ season: 0 }), storeWith([])),
    /Season zwischen/,
  );
});

test("blocked DMs give private guidance without posting results or a false success message", async () => {
  for (const code of [50007, 50278]) {
    const search = interaction();
    search.user.send = async () => {
      throw Object.assign(new Error("Cannot send messages"), { code });
    };
    await handleSearchCommand(search, storeWith([match()]));
    assert.ok(search.defer.flags.includes(MessageFlags.Ephemeral));
    assert.equal(search.sent.length, 1);
    assert.match(search.sent[0].content, /Direktnachrichten von Servermitgliedern/);
    assert.ok(!search.sent[0].content.includes("https://"));
    assert.ok(!search.sent[0].content.includes("✅"));
  }
});

test("a failure partway through DM delivery reports partial success and stops sending", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const matches = Array.from({ length: 3 }, (_, index) =>
    match({ matchday: index + 1, link: `https://example.org/${"a".repeat(1000)}${index}` }),
  );
  const search = interaction();
  let attempts = 0;
  search.user.send = async (payload) => {
    if (++attempts === 2) throw new Error("Network unavailable");
    search.dms.push(payload);
  };
  await handleSearchCommand(search, storeWith(matches));
  assert.equal(attempts, 2);
  assert.equal(search.dms.length, 1);
  assert.equal(logged.length, 1);
  assert.match(search.sent[0].content, /1 von 3 Nachrichten wurden zugestellt/);
  assert.match(search.sent[0].content, /später erneut/);
  assert.ok(!search.sent[0].content.includes("✅"));
});

test("Markdown and mentions in saved names cannot change the search result layout or trigger mentions", () => {
  const [content] = resultMessages([
    match({ players: [{ id: JAN, name: "Jan**\n@everyone" }, match().players[1]] }),
  ]);
  assert.ok(content.startsWith("**Spieltag 1 · Jan\\*\\* @everyone vs. Max**\n<https://"));
});
