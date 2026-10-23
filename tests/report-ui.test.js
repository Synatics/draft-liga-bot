const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Collection, ComponentType, ModalSubmitFields } = require("discord.js");
const {
  getParticipantOptions,
  createReportModal,
  resolveReportContext,
  resolveReportPlayers,
  createResultEmbed,
  createResultMessage,
} = require("../src/reports/report-ui");

const ROLE_ID = "100000000000000001";
const JAN_ID = "200000000000000001";
const MAX_ID = "200000000000000002";
const LINK = "https://replay.pokemonshowdown.com/gen9anythinggoes-123456789";
const SETTINGS = { season: 3, matchdays: 9, currentMatchday: 7 };

function member(id, displayName, { participant = true, bot = false } = {}) {
  return {
    id,
    displayName,
    user: { username: `account${id}`, bot },
    roles: { cache: new Collection(participant ? [[ROLE_ID, {}]] : []) },
  };
}

function guildWith(members) {
  const cache = new Collection(members.map((entry) => [entry.id, entry]));
  return {
    id: "300000000000000001",
    roles: { cache: new Collection([[ROLE_ID, {}]]) },
    members: {
      cache,
      async fetch({ user, force }) {
        assert.equal(force, true, "Submitting must refresh the selected member");
        const result = cache.get(user);
        if (!result) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        return result;
      },
    },
  };
}

function fields(winner = JAN_ID, loser = MAX_ID, matchday = "7") {
  return new ModalSubmitFields([
    {
      type: ComponentType.Label,
      component: {
        type: ComponentType.StringSelect,
        customId: "matchday",
        values: [matchday],
      },
    },
    {
      type: ComponentType.Label,
      component: {
        type: ComponentType.StringSelect,
        customId: "winner",
        values: [winner],
      },
    },
    {
      type: ComponentType.Label,
      component: {
        type: ComponentType.StringSelect,
        customId: "loser",
        values: [loser],
      },
    },
    {
      type: ComponentType.Label,
      component: {
        type: ComponentType.TextInput,
        customId: "score",
        value: "2-0",
      },
    },
    {
      type: ComponentType.Label,
      component: {
        type: ComponentType.TextInput,
        customId: "link",
        value: LINK,
      },
    },
  ]);
}

test("dropdowns show sorted server names only for human members of the participant role", () => {
  const guild = guildWith([
    member(MAX_ID, "Max"),
    member(JAN_ID, "Jan"),
    member("200000000000000003", "Zuschauer", { participant: false }),
    member("200000000000000004", "Liga-Bot", { bot: true }),
  ]);
  const modal = JSON.parse(
    JSON.stringify(createReportModal(getParticipantOptions(guild, ROLE_ID), SETTINGS)),
  );
  for (const label of modal.components.filter((label) =>
    ["winner", "loser"].includes(label.component.custom_id),
  )) {
    assert.equal(label.type, ComponentType.Label);
    assert.equal(label.component.type, ComponentType.StringSelect);
    assert.deepEqual(label.component.options, [
      { label: "Jan", value: JAN_ID },
      { label: "Max", value: MAX_ID },
    ]);
    assert.equal(label.component.min_values, 1);
    assert.equal(label.component.max_values, 1);
  }
  assert.deepEqual(
    modal.components.slice(-2).map((label) => label.component.custom_id),
    ["score", "link"],
  );
});

test("role additions, removals and nickname changes appear on the next opening", () => {
  const jan = member(JAN_ID, "Jan");
  const max = member(MAX_ID, "Max");
  const newcomer = member("200000000000000003", "Lennart", { participant: false });
  const guild = guildWith([jan, max, newcomer]);
  assert.deepEqual(
    getParticipantOptions(guild, ROLE_ID).map((option) => option.label),
    ["Jan", "Max"],
  );

  jan.roles.cache.delete(ROLE_ID);
  newcomer.roles.cache.set(ROLE_ID, {});
  max.displayName = "Maximilian";
  assert.deepEqual(getParticipantOptions(guild, ROLE_ID), [
    { label: "Lennart", value: newcomer.id },
    { label: "Maximilian", value: MAX_ID },
  ]);
});

test("missing or unsuitable configuration gives actionable errors", () => {
  const guild = guildWith([member(JAN_ID, "Jan"), member(MAX_ID, "Max")]);
  assert.throws(() => getParticipantOptions(null, ROLE_ID), /Liga-Server/);
  assert.throws(() => getParticipantOptions(guild), /PARTICIPANT_ROLE_ID/);
  assert.throws(() => getParticipantOptions(guild, "unknown"), /nicht gefunden/);
  guild.roles.cache.set(guild.id, {});
  assert.throws(() => getParticipantOptions(guild, guild.id), /nicht gefunden/);
  guild.members.cache.delete(MAX_ID);
  assert.throws(() => getParticipantOptions(guild, ROLE_ID), /mindestens zwei/);
});

test("up to 25 participants fit in a valid Discord modal; larger lists are rejected", () => {
  const members = Array.from({ length: 26 }, (_, i) => member(String(400000 + i), `Spieler ${i}`));
  const guild = guildWith(members.slice(0, 25));
  assert.doesNotThrow(() =>
    createReportModal(getParticipantOptions(guild, ROLE_ID), SETTINGS).toJSON(),
  );
  guild.members.cache.set(members[25].id, members[25]);
  assert.throws(() => getParticipantOptions(guild, ROLE_ID), /höchstens 25/);
});

test("submission resolves IDs to current nicknames and preserves the result format", async () => {
  const guild = guildWith([member(JAN_ID, "Jan"), member(MAX_ID, "Max")]);
  const submitted = fields();
  guild.members.cache.get(JAN_ID).displayName = "Jan Neu";
  const { winner, loser } = await resolveReportPlayers(guild, ROLE_ID, submitted);
  assert.deepEqual({ winner, loser }, { winner: "Jan Neu", loser: "Max" });

  const embed = createResultEmbed(
    winner,
    loser,
    submitted.getTextInputValue("score"),
    LINK,
  ).toJSON();
  assert.match(embed.title, /^Liga Match: (Jan Neu vs\. Max|Max vs\. Jan Neu)$/);
  assert.equal(embed.color, 0xffd700);
  for (const field of embed.fields.slice(0, 3)) assert.match(field.value, /^\|\| .+ \|\|$/);
  assert.equal(embed.fields[3].value, LINK);
});

test("a player cannot be selected as both winner and loser", async () => {
  const guild = guildWith([member(JAN_ID, "Jan"), member(MAX_ID, "Max")]);
  await assert.rejects(
    resolveReportPlayers(guild, ROLE_ID, fields(JAN_ID, JAN_ID)),
    /unterschiedliche/,
  );
});

test("participants who lose their role, leave, or are bots cannot be submitted", async () => {
  for (const change of [
    (guild) => guild.members.cache.get(MAX_ID).roles.cache.delete(ROLE_ID),
    (guild) => guild.members.cache.delete(MAX_ID),
    (guild) => {
      guild.members.cache.get(MAX_ID).user.bot = true;
    },
  ]) {
    const guild = guildWith([member(JAN_ID, "Jan"), member(MAX_ID, "Max")]);
    const submitted = fields();
    change(guild);
    await assert.rejects(resolveReportPlayers(guild, ROLE_ID, submitted), /nicht mehr Teilnehmer/);
  }
});

test("network errors are not misreported as a removed participant", async () => {
  const guild = guildWith([member(JAN_ID, "Jan"), member(MAX_ID, "Max")]);
  const error = new Error("Discord unavailable");
  guild.members.fetch = async () => {
    throw error;
  };
  await assert.rejects(
    resolveReportPlayers(guild, ROLE_ID, fields()),
    (actual) => actual === error,
  );
});

test("duplicate nicknames remain distinct by ID and never produce an undefined title", async () => {
  const guild = guildWith([member(JAN_ID, "Max"), member(MAX_ID, "Max")]);
  const options = getParticipantOptions(guild, ROLE_ID);
  assert.equal(new Set(options.map((option) => option.value)).size, 2);
  assert.ok(options.every((option) => option.description.startsWith("@account")));
  const { winner, loser } = await resolveReportPlayers(guild, ROLE_ID, fields());
  assert.equal(
    createResultEmbed(winner, loser, "2-0", LINK).toJSON().title,
    "Liga Match: Max vs. Max",
  );
});

test("special characters in nicknames cannot close the spoiler markup", () => {
  const embed = createResultEmbed("Max||Test", "Jan", "2-0", LINK).toJSON();
  assert.match(embed.fields[0].value, /Max\\\|\\\|Test/);
  assert.equal((embed.fields[0].value.match(/(?<!\\)\|\|/g) || []).length, 2);
});

test("the current matchday is preselected and all matchdays remain available for late reports", () => {
  const guild = guildWith([member(JAN_ID, "Jan"), member(MAX_ID, "Max")]);
  const modal = createReportModal(getParticipantOptions(guild, ROLE_ID), SETTINGS).toJSON();
  assert.equal(modal.custom_id, "submit_report:3");
  assert.match(modal.title, /Season 3/);
  assert.equal(modal.components.length, 5);
  const matchdays = modal.components.find(
    (label) => label.component.custom_id === "matchday",
  ).component;
  assert.equal(matchdays.options.length, 9);
  assert.deepEqual(
    matchdays.options.filter((option) => option.default).map((option) => option.value),
    ["7"],
  );
  assert.deepEqual(resolveReportContext(modal.custom_id, fields(JAN_ID, MAX_ID, "2"), SETTINGS), {
    season: 3,
    matchday: 2,
  });
  assert.doesNotThrow(() =>
    createReportModal(getParticipantOptions(guild, ROLE_ID), {
      season: 9999,
      matchdays: 25,
      currentMatchday: 25,
    }).toJSON(),
  );
});

test("an old season or invalid matchday cannot be silently assigned to the new season", () => {
  assert.throws(
    () => resolveReportContext("submit_report:2", fields(), SETTINGS),
    /Season wurde inzwischen geändert/,
  );
  assert.throws(
    () => resolveReportContext("submit_report", fields(), SETTINGS),
    /Season wurde inzwischen geändert/,
  );
  for (const matchday of ["0", "10", "-1", "2.5", "1e0", ""]) {
    assert.throws(
      () => resolveReportContext("submit_report:3", fields(JAN_ID, MAX_ID, matchday), SETTINGS),
      /Spieltag gehört nicht/,
    );
  }
  assert.deepEqual(
    resolveReportContext("submit_report:3", fields(), { ...SETTINGS, currentMatchday: 8 }),
    {
      season: 3,
      matchday: 7,
    },
  );
});

test("result shows season and selected matchday above the match title without a separate text line", () => {
  const message = createResultMessage("Max", "Jan", "2-0", LINK, { season: 3, matchday: 2 });
  const embed = message.embeds[0].toJSON();
  assert.equal(embed.author.name, "Season 3 · Spieltag 2");
  assert.match(embed.title, /^Liga Match: (Max vs\. Jan|Jan vs\. Max)$/);
  assert.equal(message.content, undefined);
  assert.deepEqual(message.allowedMentions, { parse: [] });
  for (const field of embed.fields.slice(0, 3)) assert.match(field.value, /^\|\| .+ \|\|$/);
});
