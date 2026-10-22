const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const {
  ApplicationCommandType,
  Collection,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits: P,
  PermissionsBitField,
} = require("discord.js");
const { MatchStore, matchData, revisionOf } = require("./match-store");
const { ReportManager } = require("./report-manager");
const { ReportPublisher } = require("./report-publisher");
const { createResultMessage } = require("./reports");
const { resultMessages, handleSearchCommand } = require("./search-commands");
const {
  managementCommands,
  openManagement,
  handleManagementComponent,
  handleRemovalAutocomplete,
  correctionModal,
} = require("./report-management");
const { installReportButtons } = require("./report-buttons");

const GUILD = "300000000000000001",
  CHANNEL = "400000000000000001",
  MESSAGE = "500000000000000001";
const JAN = "200000000000000001",
  MAX = "200000000000000002",
  OTHER = "200000000000000003";
const ADMIN = "200000000000000004";
const BOT = "600000000000000001",
  ROLE = "100000000000000001";
const permissions = (...extras) =>
  new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, ...extras]);

function setup(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "pokemon-liga-management-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "matches.json");
  const store = new MatchStore(filePath);
  const data = {
    guildId: GUILD,
    channelId: CHANNEL,
    season: 4,
    matchday: 1,
    players: [
      { id: JAN, name: "Jan" },
      { id: MAX, name: "Max" },
    ],
    link: "https://example.org/original",
    reporter: { id: JAN, name: "Jan" },
    result: { winnerId: JAN, loserId: MAX, score: "2-0" },
  };
  const record = store.add(data);
  store.setPublication(record.id, { status: "sending" });
  store.setPublication(record.id, { status: "published", messageId: MESSAGE });
  const edits = [],
    deletions = [],
    fetches = [];
  let deleted = false;
  const message = {
    id: MESSAGE,
    author: { id: BOT },
    embeds: createResultMessage("Jan", "Max", "2-0", data.link, data).embeds.map((embed) =>
      embed.toJSON(),
    ),
    async edit(payload) {
      edits.push(payload);
      this.embeds = payload.embeds;
    },
    async delete() {
      deletions.push(MESSAGE);
      deleted = true;
    },
  };
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: ChannelType.GuildText,
    permissionsFor: () => permissions(),
    members: {
      cache: new Collection([[JAN, {}]]),
      async fetch() {
        return { id: JAN };
      },
    },
    messages: {
      async fetch(options) {
        fetches.push(options);
        assert.equal(options.message, MESSAGE);
        assert.equal(options.force, true);
        if (deleted)
          throw Object.assign(new Error("Unknown Message"), { code: 10008, status: 404 });
        return message;
      },
    },
    async send() {
      assert.fail("Management must never send a new result post");
    },
  };
  const members = new Collection(
    [JAN, MAX, OTHER].map((id, index) => [
      id,
      {
        id,
        displayName: ["Jan", "Max", "Lennart"][index],
        user: { bot: false, username: `user${index}` },
        permissions: permissions(),
        roles: { cache: new Collection([[ROLE, {}]]) },
      },
    ]),
  );
  members.set(ADMIN, {
    id: ADMIN,
    displayName: "Admin",
    user: { bot: false },
    roles: { cache: new Collection() },
    permissions: permissions(P.ManageGuild),
  });
  const guild = {
    id: GUILD,
    channels: {
      cache: new Collection([[CHANNEL, channel]]),
      async fetch(id) {
        assert.equal(id, CHANNEL);
        return channel;
      },
    },
    members: {
      cache: members,
      async fetch({ user }) {
        if (!members.has(user)) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        return members.get(user);
      },
    },
  };
  const manager = new ReportManager(store);
  const settings = { get: () => ({ season: 4, matchdays: 9 }) };
  const interaction = (overrides = {}) => ({
    guild,
    channel,
    channelId: CHANNEL,
    client: { user: { id: BOT } },
    member: members.get(JAN),
    memberPermissions: permissions(),
    user: { id: JAN },
    message,
    customId: `report:edit:${record.id}`,
    async showModal(modal) {
      this.modal = modal.toJSON();
    },
    async reply(payload) {
      this.response = payload;
    },
    async deferReply(payload) {
      this.deferred = true;
      this.defer = payload;
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async editReply(payload) {
      this.response = payload;
    },
    async update(payload) {
      this.response = payload;
    },
    ...overrides,
  });
  const current = () => store.get(record.id, GUILD);
  const change = (overrides = {}, score = "1-0") => {
    const target = matchData({
      ...data,
      result: undefined,
      matchday: 2,
      link: "https://example.org/corrected",
      ...overrides,
    });
    return {
      kind: "edit",
      target,
      embed: createResultMessage(
        target.players[0].name,
        target.players[1].name,
        score,
        target.link,
        target,
      ).embeds[0].toJSON(),
    };
  };
  const apply = (operation = change()) =>
    manager.apply(record.id, GUILD, channel, BOT, operation, revisionOf(current()));
  const fields = (overrides = {}) => {
    const values = {
      matchday: "1",
      winner: JAN,
      loser: MAX,
      score: "1-0",
      link: "https://example.org/corrected",
      ...overrides,
    };
    return {
      getStringSelectValues: (name) =>
        Array.isArray(values[name]) ? values[name] : [values[name]],
      getTextInputValue: (name) => values[name],
    };
  };
  return {
    directory,
    filePath,
    store,
    manager,
    record,
    data,
    message,
    channel,
    guild,
    members,
    settings,
    edits,
    deletions,
    fetches,
    interaction,
    admin: (overrides) =>
      interaction({
        user: { id: ADMIN },
        member: members.get(ADMIN),
        memberPermissions: permissions(P.ManageGuild),
        ...overrides,
      }),
    current,
    change,
    apply,
    fields,
    removePost() {
      deleted = true;
    },
    isDeleted: () => deleted,
  };
}

const rows = (payload) => payload.components.map((row) => row.toJSON().components);
const removalOptions = ({ season = 4, name = JAN, matchday = null } = {}) => ({
  getInteger: (key) => (key === "season" ? season : matchday),
  getString: () => name,
  getFocused: () => ({ name: "name", value: name }),
});
const addPublished = (
  f,
  overrides = {},
  messageId = String(BigInt(MESSAGE) + BigInt(f.store.list(GUILD).length)),
) => {
  const match = { ...f.data, ...overrides };
  if (overrides.players && !overrides.result)
    match.result = { winnerId: match.players[0].id, loserId: match.players[1].id, score: "2-0" };
  const record = f.store.add(match);
  f.store.setPublication(record.id, { status: "sending" });
  f.store.setPublication(record.id, { status: "published", messageId });
  return f.store.get(record.id, record.guildId);
};

async function openCorrection(f) {
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE, f.settings);
  return command;
}

test("historical corrections keep the original season and offer all 25 days without current season settings", async (t) => {
  const f = setup(t);
  f.store.save([{ ...f.current(), season: 3, matchday: 20 }]);
  const command = await openCorrection(f);
  const days = command.modal.components[0].component.options;
  assert.equal(days.length, 25);
  assert.equal(days.find((option) => option.default).value, "20");
  assert.match(command.modal.title, /Season 3$/);
  f.settings.get = () => {
    throw new Error("No active season");
  };
  await handleManagementComponent(
    f.interaction({ customId: command.modal.custom_id, fields: f.fields({ matchday: "25" }) }),
    f.store,
    f.manager,
    ROLE,
    f.settings,
  );
  assert.equal(f.current().season, 3);
  assert.equal(f.current().matchday, 25);
  assert.equal(f.message.embeds[0].author.name, "Season 3 · Spieltag 25");
});

test("opening the modal leaves data unchanged and requires a valid day if the old day exceeds the new limit", async (t) => {
  const f = setup(t);
  f.store.save([{ ...f.current(), matchday: 10 }]);
  const original = f.current();
  const command = await openCorrection(f);
  const days = command.modal.components[0].component.options;
  assert.equal(days.length, 9);
  assert.equal(
    days.some((option) => option.default),
    false,
  );
  assert.deepEqual(f.current(), original);
  assert.equal(f.edits.length, 0);
  assert.equal(f.fetches.length, 0);
});

test("submitting a correction rechecks the currently configured day limit", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  f.settings.get = () => ({ season: 4, matchdays: 8 });
  await assert.rejects(
    handleManagementComponent(
      f.interaction({ customId: command.modal.custom_id, fields: f.fields({ matchday: "9" }) }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /Spieltag gehört nicht/,
  );
  assert.equal(f.edits.length, 0);
});

test("edits update the existing post, search metadata and persistent duplicate protection together", async (t) => {
  const f = setup(t);
  assert.equal(await f.apply(), "edit");
  assert.equal(f.edits.length, 1);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
  assert.equal(f.edits[0].embeds[0].author.name, "Season 4 · Spieltag 2");
  const restarted = new MatchStore(f.filePath);
  assert.equal(restarted.get(f.record.id, GUILD).publication.messageId, MESSAGE);
  assert.equal(restarted.get(f.record.id, GUILD).change, undefined);
  assert.match(resultMessages(restarted.list(GUILD))[0], /Spieltag 2.*Jan vs\. Max/);
  assert.ok(resultMessages(restarted.list(GUILD))[0].includes("corrected"));
  assert.ok(!fs.readFileSync(f.filePath, "utf8").includes('"Score"'));
  assert.equal(
    (await new ReportPublisher(restarted).publish(f.change().target, f.channel, {})).status,
    "duplicate",
  );
});

test("deletion removes the same post and its searchable record and permits a fresh report afterwards", async (t) => {
  const f = setup(t);
  assert.equal(await f.apply({ kind: "delete" }), "delete");
  assert.equal(f.deletions.length, 1);
  const restarted = new MatchStore(f.filePath);
  assert.deepEqual(resultMessages(restarted.list(GUILD)), []);
  assert.notEqual(restarted.add(f.data).id, f.record.id);
});

test("a write failure before a change cannot edit or delete any Discord message", async (t) => {
  const f = setup(t);
  f.store.filePath = join(f.filePath, "invalid.json");
  await assert.rejects(f.apply(), /nicht gespeichert/);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.current().change, undefined);
  f.store.filePath = f.filePath;
  assert.equal(await f.apply(), "edit", "The per-report lock is released after a storage failure");
});

test("pending edits reserve both identities and survive a successful Discord edit followed by a disk failure", async (t) => {
  const f = setup(t);
  const edit = f.message.edit.bind(f.message);
  f.message.edit = async (payload) => {
    await edit(payload);
    f.store.filePath = join(f.filePath, "invalid.json");
  };
  await assert.rejects(f.apply(), /Post wurde geändert.*Archiv/);
  const restarted = new MatchStore(f.filePath);
  const pending = restarted.get(f.record.id, GUILD);
  assert.equal(pending.change.kind, "edit");
  const publisher = new ReportPublisher(restarted);
  assert.equal((await publisher.publish(f.data, f.channel, {})).status, "maintenance");
  assert.equal((await publisher.publish(f.change().target, f.channel, {})).status, "maintenance");
  f.message.edit = edit;
  assert.equal(
    await new ReportManager(restarted).apply(f.record.id, GUILD, f.channel, BOT),
    "edit",
  );
  assert.equal(restarted.get(f.record.id, GUILD).matchday, 2);
  assert.equal(f.edits.length, 2);
});

test("ambiguous edit and delete responses can be retried after a restart without creating another post", async (t) => {
  for (const kind of ["edit", "delete"]) {
    const f = setup(t);
    const action = f.message[kind].bind(f.message);
    f.message[kind] = async (...args) => {
      await action(...args);
      throw new Error("network timeout");
    };
    await assert.rejects(f.apply(kind === "edit" ? f.change() : { kind }), /Ausgang.*unklar/);
    const restarted = new MatchStore(f.filePath);
    assert.equal(restarted.get(f.record.id, GUILD).change.kind, kind);
    f.message[kind] = action;
    assert.equal(
      await new ReportManager(restarted).apply(f.record.id, GUILD, f.channel, BOT),
      kind,
    );
    assert.equal(restarted.list(GUILD).length, kind === "edit" ? 1 : 0);
  }
});

test("a rejected fresh edit preserves the original, while a rejected retry retains its recovery data", async (t) => {
  const f = setup(t);
  const edit = f.message.edit.bind(f.message);
  f.message.edit = async () => {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  await assert.rejects(f.apply(), /nicht durchgeführt/);
  assert.equal(f.current().change, undefined);
  assert.equal(f.current().matchday, 1);
  f.message.edit = async () => {
    throw new Error("unknown delivery");
  };
  await assert.rejects(f.apply(), /unklar/);
  f.message.edit = async () => {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  await assert.rejects(f.manager.apply(f.record.id, GUILD, f.channel, BOT), /unklar/);
  assert.equal(f.current().change.kind, "edit");
  f.message.edit = edit;
  assert.equal(
    await f.apply({ kind: "delete" }),
    "delete",
    "A confirmed deletion can replace an unresolved correction",
  );
});

test("parallel mutations are blocked, duplicate targets rejected and score-only edits invalidate stale forms", async (t) => {
  const f = setup(t);
  let release;
  f.message.edit = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const previousRevision = revisionOf(f.current());
  const running = f.apply(f.change(f.data));
  await new Promise(setImmediate);
  await assert.rejects(f.manager.apply(f.record.id, GUILD, f.channel, BOT), /gerade geändert/);
  release();
  await running;
  assert.notEqual(revisionOf(f.current()), previousRevision);
  assert.throws(
    () => f.store.beginChange(f.record.id, GUILD, previousRevision, { kind: "delete" }),
    /inzwischen geändert/,
  );
  f.store.add(f.change().target);
  await assert.rejects(f.apply(), /anderer Report/);
  assert.equal(f.current().change, undefined);
});

test("foreign guilds, wrong channels and messages from another author cannot be mutated", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.manager.apply(f.record.id, "300000000000000002", f.channel, BOT),
    /nicht gefunden/,
  );
  await assert.rejects(
    f.manager.apply(f.record.id, GUILD, { ...f.channel, id: "400000000000000002" }, BOT),
    /Kanal/,
  );
  assert.equal(f.current().change, undefined);
  f.message.author.id = OTHER;
  await assert.rejects(f.apply(), /nicht durchgeführt/);
  assert.equal(f.edits.length, 0);
  assert.equal(f.current().change, undefined);
});

test("invalid persisted correction journals fail closed when loading the archive", (t) => {
  const f = setup(t);
  const original = f.current();
  for (const change of [
    { kind: "unknown" },
    { kind: "delete", extra: "bad" },
    { ...f.change(), embed: {} },
    { ...f.change(), target: { ...f.data, guildId: "300000000000000002" } },
  ]) {
    fs.writeFileSync(
      f.filePath,
      JSON.stringify({ version: 1, matches: [{ ...original, change }] }),
    );
    assert.throws(() => new MatchStore(f.filePath), /nicht gelesen/);
  }
});

test("the report button opens a single five-field modal with the existing day and result preselected", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  assert.equal(
    command.response,
    undefined,
    "The action opens the modal without a preliminary message",
  );
  assert.equal(command.modal.components.length, 5);
  assert.match(command.modal.title, /Season 4$/);
  assert.ok(command.modal.custom_id.length <= 100);
  const components = command.modal.components.map((label) => label.component);
  assert.deepEqual(
    components.map((component) => component.custom_id),
    ["matchday", "winner", "loser", "score", "link"],
  );
  assert.equal(components[0].options.find((option) => option.default).value, "1");
  assert.equal(components[0].options.length, 9);
  assert.equal(components[1].options.find((option) => option.default).value, JAN);
  assert.equal(components[2].options.find((option) => option.default).value, MAX);
  assert.equal(components[3].value, "2-0");
  assert.equal(components[4].value, f.data.link);
  assert.equal(f.edits.length, 0);
  assert.equal(
    managementCommands.filter((entry) => entry.type === ApplicationCommandType.Message).length,
    0,
  );
  assert.ok(managementCommands.every((entry) => entry.default_member_permissions === undefined));
});

test("only the reporter and management can edit; being the other match participant grants no permission", async (t) => {
  const f = setup(t);
  for (const id of [JAN]) {
    const command = f.interaction({ user: { id } });
    await openManagement(command, f.store, f.manager, ROLE);
    assert.ok(command.modal);
  }
  for (const id of [MAX, OTHER])
    await assert.rejects(
      openManagement(
        f.interaction({ user: { id }, member: f.members.get(id) }),
        f.store,
        f.manager,
        ROLE,
      ),
      /Nur die meldende/,
    );
  const admin = f.admin();
  await openManagement(admin, f.store, f.manager, ROLE);
  assert.ok(admin.modal);
  f.message.author.id = OTHER;
  await assert.rejects(
    openManagement(f.interaction(), f.store, f.manager, ROLE),
    /Ergebnispost dieses Bots/,
  );
});

test("the manager role can edit and delete without server permissions, and a revoked role blocks final confirmation", async (t) => {
  const f = setup(t);
  const managerRole = "100000000000000002";
  const member = f.members.get(OTHER);
  member.roles.cache.set(managerRole, {});
  member.permissions = permissions();
  const edit = f.interaction({ user: { id: OTHER }, member });
  await openManagement(edit, f.store, f.manager, ROLE, f.settings, managerRole);
  assert.ok(edit.modal);
  const remove = f.interaction({
    user: { id: OTHER },
    member,
    customId: `report:delete:${f.record.id}`,
  });
  await openManagement(remove, f.store, f.manager, ROLE, f.settings, managerRole);
  const staleMember = { ...member, roles: { cache: new Collection(member.roles.cache) } };
  member.roles.cache.delete(managerRole);
  await assert.rejects(
    handleManagementComponent(
      f.interaction({
        user: { id: OTHER },
        member: staleMember,
        customId: rows(remove.response)[0][0].custom_id,
      }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
      managerRole,
    ),
    /Nur die Ligaverwaltung/,
  );
  assert.equal(f.deletions.length, 0);
  assert.equal(f.current().change, undefined);
});

test("a reporter cannot delete through either the public button, a forged confirmation or the slash fallback", async (t) => {
  const f = setup(t);
  for (const interaction of [
    f.interaction({ customId: `report:delete:${f.record.id}` }),
    f.interaction({ customId: `manage:delete:${f.record.id}:${revisionOf(f.current())}:${JAN}` }),
    f.interaction({ commandName: "report-entfernen", options: removalOptions() }),
  ]) {
    await assert.rejects(
      interaction.commandName === "report-entfernen"
        ? openManagement(interaction, f.store, f.manager, ROLE, f.settings)
        : handleManagementComponent(interaction, f.store, f.manager, ROLE, f.settings),
      /Nur die Ligaverwaltung/,
    );
  }
  assert.equal(f.deletions.length, 0);
});

test("removing a reporter's participant role blocks both opening and submitting a correction", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  const staleMember = {
    ...f.members.get(JAN),
    roles: { cache: new Collection(f.members.get(JAN).roles.cache) },
  };
  f.members.get(JAN).roles.cache.delete(ROLE);
  await assert.rejects(
    openManagement(f.interaction(), f.store, f.manager, ROLE, f.settings),
    /aktueller Teilnehmerrolle/,
  );
  await assert.rejects(
    handleManagementComponent(
      f.interaction({ member: staleMember, customId: command.modal.custom_id, fields: f.fields() }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /aktueller Teilnehmerrolle/,
  );
  assert.equal(f.edits.length, 0);
  assert.equal(f.current().change, undefined);
});

test("stale administrative permissions cannot let a participant confirm a deletion", async (t) => {
  const f = setup(t);
  const reporter = f.members.get(JAN);
  reporter.permissions = permissions(P.ManageGuild);
  const command = f.interaction({ customId: `report:delete:${f.record.id}` });
  await openManagement(command, f.store, f.manager, ROLE, f.settings);
  const staleMember = { ...reporter };
  reporter.permissions = undefined;
  const confirmation = f.interaction({
    member: staleMember,
    memberPermissions: permissions(P.ManageGuild),
    customId: rows(command.response)[0][0].custom_id,
  });
  await assert.rejects(
    handleManagementComponent(confirmation, f.store, f.manager, ROLE, f.settings),
    /Nur die Ligaverwaltung/,
  );
  assert.equal(f.deletions.length, 0);
  assert.equal(f.current().change, undefined);
});

test("legacy reports with unknown reporters require management, and buttons must belong to the original bot post", async (t) => {
  const f = setup(t);
  f.store.save([{ ...f.current(), reporter: undefined }]);
  await assert.rejects(
    openManagement(f.interaction(), f.store, f.manager, ROLE),
    /meldende Person/,
  );
  const admin = f.admin();
  await openManagement(admin, f.store, f.manager, ROLE);
  assert.ok(admin.modal);
  await assert.rejects(
    openManagement(
      f.admin({ customId: `report:edit:${"f".repeat(24)}` }),
      f.store,
      f.manager,
      ROLE,
    ),
    /anderen Report/,
  );
  f.message.webhookId = "700000000000000001";
  await assert.rejects(openManagement(f.admin(), f.store, f.manager, ROLE), /dieses Bots/);
});

test("known older posts receive persistent buttons once; missing posts remain available for archive cleanup", async (t) => {
  const f = setup(t);
  f.store.save([{ ...f.current(), controlsVersion: undefined }]);
  const client = { user: { id: BOT }, guilds: { cache: new Collection([[GUILD, f.guild]]) } };
  await installReportButtons(client, f.store);
  assert.equal(
    f.edits[0].components[0].toJSON().components[0].custom_id,
    `report:edit:${f.record.id}`,
  );
  assert.equal(f.current().controlsVersion, 1);
  await installReportButtons(client, f.store);
  assert.equal(f.edits.length, 1);
  f.store.save([{ ...f.current(), controlsVersion: undefined }]);
  f.removePost();
  await installReportButtons(client, f.store);
  assert.equal(f.store.list(GUILD).length, 1);
  assert.equal(f.current().controlsVersion, undefined);
});

test("correction submission preserves the season and updates day, players, score and replay with spoiler protection", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  const submit = f.interaction({
    customId: command.modal.custom_id,
    fields: f.fields({ season: "5", matchday: "3", winner: OTHER, score: "1-0 || @everyone" }),
  });
  await handleManagementComponent(submit, f.store, f.manager, ROLE, f.settings);
  assert.ok(submit.defer.flags.includes(MessageFlags.Ephemeral));
  assert.match(submit.response.content, /korrigiert/);
  assert.equal(f.current().season, 4);
  assert.equal(f.current().matchday, 3);
  assert.ok(f.current().players.some((player) => player.id === OTHER));
  assert.equal(f.edits[0].embeds[0].fields[0].value.includes("Lennart"), true);
  assert.match(f.edits[0].embeds[0].fields[2].value, /^\|\| .*\\\|\\\|.* \|\|$/);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
});

test("changing day 1 to day 2 while swapping the winner updates the same post, disk and a fresh search", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  const submit = f.interaction({
    customId: command.modal.custom_id,
    fields: f.fields({ matchday: "2", winner: MAX, loser: JAN, score: "2-0", link: f.data.link }),
  });
  await handleManagementComponent(submit, f.store, f.manager, ROLE, f.settings);
  assert.equal(submit.deferred, true);
  assert.ok(submit.defer.flags.includes(MessageFlags.Ephemeral));
  assert.match(submit.response.content, /Season 4 · Spieltag 2/);
  assert.deepEqual(submit.response.embeds, []);
  assert.deepEqual(submit.response.components, []);
  assert.equal(f.message.embeds[0].author.name, "Season 4 · Spieltag 2");
  assert.ok(f.message.embeds[0].fields[0].value.includes("Max"));
  assert.ok(f.message.embeds[0].fields[1].value.includes("Jan"));
  const restarted = new MatchStore(f.filePath);
  assert.equal(restarted.get(f.record.id, GUILD).matchday, 2);
  assert.equal(restarted.get(f.record.id, GUILD).publication.messageId, MESSAGE);
  const dms = [];
  const search = f.interaction({
    user: {
      id: JAN,
      async send(payload) {
        dms.push(payload);
      },
    },
    options: { getInteger: (name) => (name === "season" ? 4 : null), getString: () => JAN },
  });
  await handleSearchCommand(search, restarted);
  assert.match(dms[0].content, /Spieltag 2/);
  assert.ok(!dms[0].content.includes("Spieltag 1"));
  const reopened = await openCorrection(f);
  assert.equal(
    reopened.modal.components[0].component.options.find((option) => option.default).value,
    "2",
  );
  assert.equal(
    reopened.modal.components[1].component.options.find((option) => option.default).value,
    MAX,
  );
});

test("historical participants remain selectable without the role; newly selected people must still have it", async (t) => {
  const f = setup(t);
  f.members.delete(MAX);
  const command = await openCorrection(f);
  assert.equal(
    command.modal.components[2].component.options.find((option) => option.default).value,
    MAX,
  );
  const submit = f.interaction({ customId: command.modal.custom_id, fields: f.fields() });
  await handleManagementComponent(submit, f.store, f.manager, ROLE, f.settings);
  const fresh = await openCorrection(f);
  f.members.get(OTHER).roles.cache.clear();
  await assert.rejects(
    handleManagementComponent(
      f.interaction({ customId: fresh.modal.custom_id, fields: f.fields({ winner: OTHER }) }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /Teilnehmerrolle/,
  );
});

test("duplicate display names require explicit player selection instead of guessing the old winner", (t) => {
  const f = setup(t);
  const record = {
    ...f.current(),
    players: f.current().players.map((player) => ({ ...player, name: "Max" })),
  };
  const command = f.interaction({
    message: {
      ...f.message,
      embeds: createResultMessage("Max", "Max", "2-0", f.data.link, f.data).embeds.map((embed) =>
        embed.toJSON(),
      ),
    },
  });
  const modal = correctionModal(command, record, ROLE).toJSON();
  assert.equal(
    modal.components[1].component.options.some((option) => option.default),
    false,
  );
  assert.equal(
    modal.components[2].component.options.some((option) => option.default),
    false,
  );
});

test("invalid, foreign, stale or no-longer-authorized forms cannot change any data", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  for (const context of [":0:2", ":4:10", ":4:26"]) {
    await assert.rejects(
      handleManagementComponent(
        f.interaction({
          customId: command.modal.custom_id + context,
          fields: f.fields(),
        }),
        f.store,
        f.manager,
        ROLE,
        f.settings,
      ),
    );
  }
  for (const values of [
    { matchday: "0" },
    { matchday: "10" },
    { matchday: "26" },
    { matchday: [] },
    { matchday: ["1", "2"] },
    { matchday: "1.5" },
    { winner: JAN, loser: JAN },
    { score: " " },
    { score: "\t\u00a0\u2003" },
    { score: "x".repeat(101) },
    { link: "javascript:alert(1)" },
  ]) {
    await assert.rejects(
      handleManagementComponent(
        f.interaction({ customId: command.modal.custom_id, fields: f.fields(values) }),
        f.store,
        f.manager,
        ROLE,
        f.settings,
      ),
    );
  }
  await assert.rejects(
    handleManagementComponent(
      f.interaction({ user: { id: OTHER }, customId: command.modal.custom_id, fields: f.fields() }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /anderen Person/,
  );
  f.store.save([{ ...f.current(), revision: 1 }]);
  await assert.rejects(
    handleManagementComponent(
      f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /inzwischen geändert/,
  );
  f.store.save([{ ...f.current(), reporter: { id: OTHER, name: "Lennart" } }]);
  await assert.rejects(
    handleManagementComponent(
      f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /Nur die meldende/,
  );
  assert.equal(f.edits.length, 0);
});

test("deletion requires a private confirmation; canceling leaves the post and search untouched", async (t) => {
  const f = setup(t);
  const command = f.admin({ customId: `report:delete:${f.record.id}` });
  await openManagement(command, f.store, f.manager, ROLE);
  assert.ok(command.response.flags.includes(MessageFlags.Ephemeral));
  assert.equal(f.deletions.length, 0);
  const buttons = command.response.components[0].toJSON().components;
  const cancel = f.admin({ customId: buttons[1].custom_id });
  await handleManagementComponent(cancel, f.store, f.manager, ROLE, f.settings);
  assert.match(cancel.response.content, /abgebrochen/);
  assert.equal(f.store.list(GUILD).length, 1);
  const confirm = f.admin({ customId: buttons[0].custom_id });
  await handleManagementComponent(confirm, f.store, f.manager, ROLE, f.settings);
  assert.match(confirm.response.content, /entfernt/);
  assert.equal(f.isDeleted(), true);
  assert.equal(f.store.list(GUILD).length, 0);
});

test("the slash fallback finds a deleted post by season and player and removes it only after confirmation", async (t) => {
  const f = setup(t);
  f.removePost();
  const command = f.admin({
    commandName: "report-entfernen",
    options: removalOptions({ name: "jan", matchday: 1 }),
  });
  await openManagement(command, f.store, f.manager, ROLE);
  assert.ok(command.defer.flags.includes(MessageFlags.Ephemeral));
  assert.match(command.response.content, /Season 4 · Spieltag 1 · Jan vs\. Max/);
  assert.ok(command.response.content.includes(f.data.link));
  assert.equal(f.store.list(GUILD).length, 1);
  assert.equal(f.fetches.length, 0, "Searching does not need the original message");
  const confirm = f.admin({
    customId: command.response.components[0].toJSON().components[0].custom_id,
  });
  await handleManagementComponent(confirm, f.store, f.manager, ROLE, f.settings);
  assert.equal(f.store.list(GUILD).length, 0);
  assert.equal(f.deletions.length, 0);
  const slash = managementCommands.find((entry) => entry.name === "report-entfernen");
  assert.deepEqual(
    slash.options.map((option) => option.name),
    ["season", "name", "spieltag"],
  );
  assert.equal(slash.options[1].autocomplete, true);
});

test("multiple removal matches require selecting exactly one report and confirming it", async (t) => {
  const f = setup(t);
  const second = addPublished(f, { matchday: 2, link: "https://example.org/second" });
  addPublished(f, { season: 5 }, "500000000000000003");
  const command = f.admin({ commandName: "report-entfernen", options: removalOptions() });
  await openManagement(command, f.store, f.manager, ROLE);
  const options = rows(command.response)[0][0].options;
  assert.equal(options.length, 2);
  assert.match(options[1].label, /Spieltag 2 · Jan vs\. Max/);
  assert.equal(options[1].description, second.link);
  assert.equal(f.deletions.length, 0);
  const select = f.admin({
    customId: rows(command.response)[0][0].custom_id,
    values: [options[0].value],
  });
  await handleManagementComponent(select, f.store, f.manager, ROLE, f.settings);
  assert.match(select.response.content, /wirklich löschen/);
  assert.equal(f.deletions.length, 0);
  const confirm = f.admin({ customId: rows(select.response)[0][0].custom_id });
  await handleManagementComponent(confirm, f.store, f.manager, ROLE, f.settings);
  assert.equal(f.deletions.length, 1);
  assert.equal(f.store.list(GUILD).length, 2);
  const specific = f.admin({
    commandName: "report-entfernen",
    options: removalOptions({ matchday: 2 }),
  });
  await openManagement(specific, f.store, f.manager, ROLE);
  assert.ok(specific.response.content.includes(second.link));
  assert.match(specific.response.content, /wirklich löschen/);
});

test("removal pages include every match and canceling never deletes anything", async (t) => {
  const f = setup(t);
  for (let index = 1; index < 27; index++)
    addPublished(
      f,
      { link: `https://example.org/${index}` },
      String(BigInt(MESSAGE) + BigInt(index)),
    );
  const command = f.admin({ commandName: "report-entfernen", options: removalOptions() });
  await openManagement(command, f.store, f.manager, ROLE);
  assert.match(command.response.content, /27 Treffer · Seite 1 von 2/);
  const firstPage = rows(command.response)[0][0].options;
  assert.equal(firstPage.length, 25);
  const next = f.admin({ customId: rows(command.response)[1][1].custom_id });
  await handleManagementComponent(next, f.store, f.manager, ROLE, f.settings);
  assert.match(next.response.content, /Seite 2 von 2/);
  const secondPage = rows(next.response)[0][0].options;
  assert.equal(secondPage.length, 2);
  assert.equal(new Set([...firstPage, ...secondPage].map((option) => option.value)).size, 27);
  const cancel = f.admin({ customId: rows(next.response)[1][2].custom_id });
  await handleManagementComponent(cancel, f.store, f.manager, ROLE, f.settings);
  assert.deepEqual(cancel.response.components, []);
  assert.equal(f.deletions.length, 0);
  assert.equal(f.store.list(GUILD).length, 27);
});

test("removal requires management and never exposes other servers or inaccessible private threads", async (t) => {
  const f = setup(t);
  const hiddenChannel = "400000000000000002";
  addPublished(f, {
    players: [
      { id: OTHER, name: "Lennart" },
      { id: MAX, name: "Max" },
    ],
  });
  addPublished(f, {
    guildId: "300000000000000002",
    players: [
      { id: JAN, name: "Fremder Server" },
      { id: MAX, name: "Max" },
    ],
  });
  addPublished(f, {
    channelId: hiddenChannel,
    players: [
      { id: JAN, name: "Versteckt" },
      { id: MAX, name: "Max" },
    ],
  });
  f.store.add({
    ...f.data,
    link: "https://example.org/pending",
    players: [
      { id: JAN, name: "Noch nicht veröffentlicht" },
      { id: MAX, name: "Max" },
    ],
  });
  const fetchChannel = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id) =>
    id === hiddenChannel
      ? {
          ...f.channel,
          id: hiddenChannel,
          type: ChannelType.PrivateThread,
          members: {
            cache: new Collection([[JAN, {}]]),
            async fetch() {
              throw new Error("no longer a member");
            },
          },
        }
      : fetchChannel(id);
  const autocomplete = f.admin({
    options: removalOptions({ name: "" }),
    async respond(choices) {
      this.choices = choices;
    },
  });
  await handleRemovalAutocomplete(autocomplete, f.store);
  assert.deepEqual(
    autocomplete.choices.map((choice) => choice.name),
    ["Jan", "Lennart", "Max"],
  );
  const command = f.interaction({
    commandName: "report-entfernen",
    options: removalOptions({ name: OTHER }),
  });
  await assert.rejects(openManagement(command, f.store, f.manager, ROLE), /Nur die Ligaverwaltung/);
  const admin = f.admin({
    commandName: "report-entfernen",
    memberPermissions: permissions(P.ManageGuild),
    options: removalOptions({ name: OTHER }),
  });
  await openManagement(admin, f.store, f.manager, ROLE);
  assert.match(admin.response.content, /Lennart/);
  assert.equal(f.deletions.length, 0);
});

test("removal choices reject stale records, foreign users, revoked access and invalid filters", async (t) => {
  const f = setup(t);
  addPublished(f, { matchday: 2 });
  const command = f.admin({ commandName: "report-entfernen", options: removalOptions() });
  await openManagement(command, f.store, f.manager, ROLE);
  const customId = rows(command.response)[0][0].custom_id;
  const values = [rows(command.response)[0][0].options[0].value];
  await assert.rejects(
    handleManagementComponent(
      f.admin({ customId, values, user: { id: OTHER } }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /anderen Person/,
  );
  f.channel.permissionsFor = () => new PermissionsBitField([]);
  await assert.rejects(
    handleManagementComponent(f.admin({ customId, values }), f.store, f.manager, ROLE, f.settings),
    /keinen Zugriff/,
  );
  f.channel.permissionsFor = () => permissions();
  f.store.save(f.store.list(GUILD).map((match) => ({ ...match, revision: 1 })));
  await assert.rejects(
    handleManagementComponent(f.admin({ customId, values }), f.store, f.manager, ROLE, f.settings),
    /inzwischen geändert/,
  );
  for (const filters of [{ season: 0 }, { season: 10000 }, { matchday: 26 }]) {
    await assert.rejects(
      openManagement(
        f.admin({ commandName: "report-entfernen", options: removalOptions(filters) }),
        f.store,
        f.manager,
        ROLE,
      ),
      /Season von/,
    );
  }
  assert.equal(f.deletions.length, 0);
});

test("removal suggestions retain historical names and require explicit selection for duplicate names", async (t) => {
  const f = setup(t);
  addPublished(f, {
    matchday: 2,
    players: [
      { id: JAN, name: "Roran321" },
      { id: MAX, name: "Max" },
    ],
  });
  for (const id of [JAN, MAX, OTHER]) f.members.delete(id);
  const autocomplete = f.admin({
    options: removalOptions({ name: "ja" }),
    async respond(choices) {
      this.choices = choices;
    },
  });
  await handleRemovalAutocomplete(autocomplete, f.store);
  assert.deepEqual(autocomplete.choices, [{ name: "Roran321", value: JAN }]);
  f.store.save(
    f.store.list(GUILD).map((match) => ({
      ...match,
      players: match.players.map((player) => ({ ...player, name: "Max" })),
    })),
  );
  await assert.rejects(
    openManagement(
      f.admin({ commandName: "report-entfernen", options: removalOptions({ name: "Max" }) }),
      f.store,
      f.manager,
      ROLE,
    ),
    /Mehrere Teilnehmer/,
  );
  const selected = f.admin({
    commandName: "report-entfernen",
    options: removalOptions({ name: MAX }),
  });
  await openManagement(selected, f.store, f.manager, ROLE);
  assert.equal(rows(selected.response)[0][0].options.length, 2);
});

test("a fresh private-thread membership check rejects removed members even if the cache is stale", async (t) => {
  const f = setup(t);
  f.channel.type = ChannelType.PrivateThread;
  const command = await openCorrection(f);
  f.channel.members.fetch = async () => {
    throw new Error("not a member");
  };
  await assert.rejects(
    handleManagementComponent(
      f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
      f.store,
      f.manager,
      ROLE,
      f.settings,
    ),
    /privaten Thread/,
  );
  assert.equal(f.edits.length, 0);
  f.channel.type = ChannelType.GuildText;
  f.guild.channels.cache.clear();
  await handleManagementComponent(
    f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
    f.store,
    f.manager,
    ROLE,
    f.settings,
  );
  assert.equal(f.edits.length, 1, "Channel loading is not limited to the cache");
});

test("a deletion survives a disk failure after Discord removed the message and resumes from a missing post", async (t) => {
  const f = setup(t);
  const remove = f.message.delete.bind(f.message);
  f.message.delete = async () => {
    await remove();
    f.store.filePath = join(f.filePath, "invalid.json");
  };
  await assert.rejects(f.apply({ kind: "delete" }), /Archiv konnte nicht aktualisiert/);
  const restarted = new MatchStore(f.filePath);
  assert.equal(restarted.get(f.record.id, GUILD).change.kind, "delete");
  assert.equal(
    await new ReportManager(restarted).apply(f.record.id, GUILD, f.channel, BOT),
    "delete",
  );
  assert.equal(restarted.list(GUILD).length, 0);
  assert.equal(f.deletions.length, 1);
});

test("prefilling a correction reverses escaped score text without changing its backslashes or markdown", (t) => {
  const f = setup(t);
  const score = "2\\0 ** || ` @everyone";
  const command = f.interaction({
    message: {
      ...f.message,
      embeds: createResultMessage("Jan", "Max", score, f.data.link, f.data).embeds.map((embed) =>
        embed.toJSON(),
      ),
    },
  });
  const modal = correctionModal(command, f.current(), ROLE).toJSON();
  assert.equal(modal.components[3].component.value, score);
});

test("opening correction cannot accidentally execute a previously pending deletion", async (t) => {
  const f = setup(t);
  f.store.beginChange(f.record.id, GUILD, revisionOf(f.current()), { kind: "delete" });
  await assert.rejects(
    openManagement(f.interaction(), f.store, f.manager, ROLE),
    /Löschung vorgemerkt/,
  );
  assert.equal(f.deletions.length, 0);
});
