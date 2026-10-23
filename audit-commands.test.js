const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  Collection,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits: P,
  PermissionsBitField,
} = require("discord.js");
const { handleAuditCommand, logFiles } = require("./audit-commands");
const { handleLeagueCommand, leagueCommand } = require("./league-commands");
const { isLeagueManager } = require("./permissions");

const GUILD = "300000000000000001",
  CHANNEL = "400000000000000001",
  USER = "200000000000000001";
const ROLE = "100000000000000001",
  MANAGER = "100000000000000002";
const config = { participantRoleId: ROLE, managerRoleId: MANAGER };
const snapshot = {
  season: 4,
  matchday: 1,
  players: [
    { id: USER, name: "Jan" },
    { id: "200000000000000002", name: "Max" },
  ],
  link: "https://example.org/replay",
  result: { winnerId: USER, loserId: "200000000000000002", score: "2-0" },
};
const event = (overrides = {}) => ({
  id: "event1",
  guildId: GUILD,
  channelId: CHANNEL,
  season: 4,
  reportId: "a".repeat(24),
  messageId: "500000000000000001",
  at: "2026-10-22T18:00:00.000Z",
  actor: { id: USER, name: "Jan" },
  action: "edited",
  before: snapshot,
  after: { ...snapshot, matchday: 2 },
  ...overrides,
});

function setup({
  roles = [ROLE],
  admin = false,
  season = 4,
  events = [event()],
  blocked = false,
} = {}) {
  const member = {
    id: USER,
    displayName: "Jan",
    roles: { cache: new Collection(roles.map((id) => [id, {}])) },
    permissions: new PermissionsBitField(admin ? [P.ManageGuild] : []),
  };
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]),
    members: {
      cache: new Collection([[USER, {}]]),
      async fetch() {
        return member;
      },
    },
  };
  const dms = [];
  const interaction = {
    guild: {
      id: GUILD,
      channels: {
        async fetch() {
          return channel;
        },
      },
      members: {
        async fetch(options) {
          assert.equal(options.force, true);
          return member;
        },
      },
    },
    member,
    memberPermissions: member.permissions,
    user: {
      id: USER,
      async send(payload) {
        if (blocked) throw Object.assign(new Error("DM blocked"), { code: 50007 });
        dms.push(payload);
      },
    },
    options: {
      getInteger: (name, required) => {
        assert.equal(name, "season");
        assert.equal(required, true);
        return season;
      },
      getSubcommand: () => "log",
    },
    async deferReply(payload) {
      this.defer = payload;
    },
    async editReply(payload) {
      this.response = payload;
    },
  };
  let queries = 0;
  const database = {
    auditEvents(guildId, selected) {
      queries++;
      assert.equal(guildId, GUILD);
      return events.filter((entry) => entry.guildId === guildId && entry.season === selected);
    },
  };
  return { member, channel, interaction, dms, database, queries: () => queries };
}

test("participants, managers and server administrators receive only their selected season as a persistent DM attachment", async () => {
  for (const access of [{ roles: [ROLE] }, { roles: [MANAGER] }, { roles: [], admin: true }]) {
    const f = setup({
      ...access,
      events: [
        event(),
        event({ action: "deleted", after: null }),
        event({ season: 5 }),
        event({ guildId: "300000000000000002" }),
      ],
    });
    await handleLeagueCommand(f.interaction, {}, f.database, config);
    assert.ok(f.interaction.defer.flags.includes(MessageFlags.Ephemeral));
    assert.equal(f.dms.length, 1);
    assert.equal(f.dms[0].files[0].name, "liga-season-4-log.txt");
    const text = f.dms[0].files[0].attachment.toString("utf8");
    assert.match(text, /BEARBEITET/);
    assert.match(text, /GELÖSCHT/);
    assert.match(text, /Vorher:/);
    assert.match(text, /Spieltag 2/);
    assert.ok(!text.includes("Season 5"));
    assert.deepEqual(f.dms[0].allowedMentions, { parse: [] });
    assert.equal(f.dms[0].flags, undefined);
    assert.match(f.interaction.response.content, /per DM geschickt/);
  }
});

test("the season is mandatory and invalid or missing filters never query or export all seasons", async () => {
  assert.equal(leagueCommand.default_member_permissions, undefined);
  assert.equal(
    leagueCommand.options.find((option) => option.name === "log").options[0].required,
    true,
  );
  for (const season of [undefined, null, 0, 10000, 1.5]) {
    const f = setup({ season: season === undefined ? null : season });
    await assert.rejects(handleAuditCommand(f.interaction, f.database, config), /Season/);
    assert.equal(f.queries(), 0);
    assert.equal(f.dms.length, 0);
  }
});

test("the current role is checked and nonparticipants cannot retrieve logs or configure a season", async () => {
  const f = setup({ roles: [] });
  await assert.rejects(handleAuditCommand(f.interaction, f.database, config), /Nur Teilnehmer/);
  assert.equal(f.dms.length, 0);
  const participant = setup();
  participant.interaction.options.getSubcommand = () => "season";
  await assert.rejects(
    handleLeagueCommand(participant.interaction, {}, participant.database, config),
    /Ligaverwaltungsrolle/,
  );
  const revoked = setup();
  revoked.member.roles.cache.clear();
  await assert.rejects(
    handleAuditCommand(revoked.interaction, revoked.database, config),
    /Nur Teilnehmer/,
  );
});

test("misconfiguring the everyone role never grants management or log access to every server member", async () => {
  const f = setup({ roles: [GUILD] });
  assert.equal(isLeagueManager(f.interaction, GUILD), false);
  await assert.rejects(
    handleAuditCommand(f.interaction, f.database, {
      participantRoleId: GUILD,
      managerRoleId: GUILD,
    }),
    /Nur Teilnehmer/,
  );
});

test("a manager role reads league status without ManageGuild, but a revoked role is rechecked", async () => {
  const f = setup({ roles: [MANAGER] });
  f.interaction.options = {
    getSubcommand: () => "status",
    getInteger: (key) => (key === "nummer" ? 4 : 10),
    getString: () => "19.10.2026",
  };
  let saved = 0;
  const settings = {
    get() {
      saved++;
      return { season: 4, currentMatchday: 1, matchdays: 10, startDate: "2026-10-19" };
    },
  };
  await handleLeagueCommand(f.interaction, settings, f.database, config);
  assert.equal(saved, 1);
  f.interaction.guild.members.fetch = async () => ({
    ...f.member,
    roles: { cache: new Collection() },
  });
  await assert.rejects(
    handleLeagueCommand(f.interaction, settings, f.database, config),
    /nicht mehr verwalten/,
  );
  assert.equal(saved, 1);
});

test("blocked DMs and empty seasons produce private guidance without leaking the log in the server", async () => {
  const blocked = setup({ blocked: true });
  await handleAuditCommand(blocked.interaction, blocked.database, config);
  assert.match(blocked.interaction.response.content, /Direktnachrichten/);
  assert.ok(!blocked.interaction.response.content.includes(snapshot.link));
  assert.equal(blocked.dms.length, 0);
  const empty = setup({ events: [] });
  await handleAuditCommand(empty.interaction, empty.database, config);
  assert.match(empty.interaction.response.content, /keine.*Protokolleinträge/);
  assert.equal(empty.dms.length, 0);
});

test("private thread membership is verified afresh rather than trusting a stale member cache", async () => {
  const f = setup();
  f.channel.type = ChannelType.PrivateThread;
  f.channel.members.fetch = async () => {
    throw Object.assign(new Error("Removed"), { code: 10007 });
  };
  await handleAuditCommand(f.interaction, f.database, config);
  assert.equal(f.dms.length, 0);
});

test("a channel from a different guild never authorizes an audit export", async () => {
  const f = setup();
  f.channel.guildId = "300000000000000002";
  await handleAuditCommand(f.interaction, f.database, config);
  assert.equal(f.dms.length, 0);
});

test("large exports split into complete UTF-8 files and embedded line breaks cannot spoof new log entries", () => {
  const events = Array.from({ length: 20 }, (_, index) =>
    event({
      id: String(index),
      actor: { id: USER, name: "Jan\nFAKE\r@everyone" },
      after: { ...snapshot, result: { ...snapshot.result, score: "2-0\nFAKE" } },
    }),
  );
  const files = logFiles(events, 4, 1500);
  assert.ok(files.length > 1);
  assert.ok(files.every((file) => file.data.length <= 1500));
  const text = files.map((file) => file.data.toString("utf8")).join("");
  assert.equal((text.match(/BEARBEITET/g) || []).length, 20);
  assert.ok(text.includes("Jan\\nFAKE\\r@everyone"));
  assert.ok(!text.includes("\nFAKE"));
  assert.throws(() => logFiles([event({ season: 5 })], 4), /nur eine/);
});
