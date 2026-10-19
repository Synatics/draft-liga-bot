const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { Collection, ChannelType, MessageFlags, PermissionFlagsBits: P, PermissionsBitField } = require("discord.js");
const { MatchStore, matchData, revisionOf } = require("./match-store");
const { ReportManager } = require("./report-manager");
const { ReportPublisher } = require("./report-publisher");
const { createResultMessage } = require("./reports");
const { resultMessages } = require("./search-commands");
const { managementCommands, openManagement, handleManagementComponent, handleRemovalAutocomplete, correctionModal } = require("./report-management");

const GUILD = "300000000000000001", CHANNEL = "400000000000000001", MESSAGE = "500000000000000001";
const JAN = "200000000000000001", MAX = "200000000000000002", OTHER = "200000000000000003";
const BOT = "600000000000000001", ROLE = "100000000000000001";
const permissions = (...extras) => new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, ...extras]);

function setup(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "pokemon-liga-management-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "matches.json");
  const store = new MatchStore(filePath);
  const data = { guildId: GUILD, channelId: CHANNEL, season: 4, matchday: 1,
    players: [{ id: JAN, name: "Jan" }, { id: MAX, name: "Max" }], link: "https://example.org/original" };
  const record = store.add(data);
  store.setPublication(record.id, { status: "sending" });
  store.setPublication(record.id, { status: "published", messageId: MESSAGE });
  const edits = [], deletions = [], fetches = [];
  let deleted = false;
  const message = { id: MESSAGE, author: { id: BOT },
    embeds: createResultMessage("Jan", "Max", "2-0", data.link, data).embeds.map((embed) => embed.toJSON()),
    async edit(payload) { edits.push(payload); this.embeds = payload.embeds; },
    async delete() { deletions.push(MESSAGE); deleted = true; },
  };
  const channel = { id: CHANNEL, guildId: GUILD, type: ChannelType.GuildText,
    permissionsFor: () => permissions(),
    members: { cache: new Collection([[JAN, {}]]), async fetch() { return { id: JAN }; } },
    messages: { async fetch(options) {
      fetches.push(options);
      assert.equal(options.message, MESSAGE);
      assert.equal(options.force, true);
      if (deleted) throw Object.assign(new Error("Unknown Message"), { code: 10008, status: 404 });
      return message;
    } },
    async send() { assert.fail("Management must never send a new result post"); },
  };
  const members = new Collection([JAN, MAX, OTHER].map((id, index) => [id, {
    id, displayName: ["Jan", "Max", "Lennart"][index], user: { bot: false, username: `user${index}` },
    roles: { cache: new Collection([[ROLE, {}]]) },
  }]));
  const guild = { id: GUILD,
    channels: { cache: new Collection([[CHANNEL, channel]]), async fetch(id) { assert.equal(id, CHANNEL); return channel; } },
    members: { cache: members, async fetch({ user }) {
      if (!members.has(user)) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
      return members.get(user);
    } },
  };
  const manager = new ReportManager(store);
  const settings = { get: () => ({ season: 4, matchdays: 9 }) };
  const interaction = (overrides = {}) => ({
    guild, channel, channelId: CHANNEL, client: { user: { id: BOT } },
    member: members.get(JAN), memberPermissions: permissions(), user: { id: JAN }, targetMessage: message,
    commandName: "Report korrigieren",
    async showModal(modal) { this.modal = modal.toJSON(); },
    async reply(payload) { this.response = payload; },
    async deferReply(payload) { this.deferred = true; this.defer = payload; },
    async deferUpdate() { this.deferred = true; },
    async editReply(payload) { this.response = payload; },
    async update(payload) { this.response = payload; }, ...overrides,
  });
  const current = () => store.get(record.id, GUILD);
  const change = (overrides = {}, score = "1-0") => {
    const target = matchData({ ...data, matchday: 2, link: "https://example.org/corrected", ...overrides });
    return { kind: "edit", target, embed: createResultMessage(target.players[0].name,
      target.players[1].name, score, target.link, target).embeds[0].toJSON() };
  };
  const apply = (operation = change()) => manager.apply(record.id, GUILD, channel, BOT, operation, revisionOf(current()));
  const fields = (overrides = {}) => {
    const values = { winner: JAN, loser: MAX, score: "1-0", link: "https://example.org/corrected", ...overrides };
    return { getStringSelectValues: (name) => [values[name]], getTextInputValue: (name) => values[name] };
  };
  return { directory, filePath, store, manager, record, data, message, channel, guild, members, settings,
    edits, deletions, fetches, interaction, current, change, apply, fields,
    removePost() { deleted = true; }, isDeleted: () => deleted };
}

const rows = (payload) => payload.components.map((row) => row.toJSON().components);
const removalOptions = ({ season = 4, name = JAN, matchday = null } = {}) => ({
  getInteger: (key) => key === "season" ? season : matchday,
  getString: () => name,
  getFocused: () => ({ name: "name", value: name }),
});
const addPublished = (f, overrides = {}, messageId = String(BigInt(MESSAGE) + BigInt(f.store.list(GUILD).length))) => {
  const record = f.store.add({ ...f.data, ...overrides });
  f.store.setPublication(record.id, { status: "sending" });
  f.store.setPublication(record.id, { status: "published", messageId });
  return f.store.get(record.id, record.guildId);
};

async function openCorrection(f, { season = f.current().season, matchday = f.current().matchday } = {}) {
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE, f.settings);
  let prompt = command.response;
  if (season !== f.current().season) {
    const select = f.interaction({ targetMessage: undefined, message: { embeds: prompt.embeds },
      customId: rows(prompt)[0][0].custom_id,
      values: [rows(prompt)[0][0].options.some((option) => option.value === String(season)) ? String(season) : "other"] });
    await handleManagementComponent(select, f.store, f.manager, ROLE, f.settings);
    if (select.modal) {
      const number = f.interaction({ targetMessage: undefined, message: { embeds: prompt.embeds },
        customId: select.modal.custom_id, fields: { getTextInputValue: () => String(season) } });
      await handleManagementComponent(number, f.store, f.manager, ROLE, f.settings);
      prompt = number.response;
    } else prompt = select.response;
  }
  if (!rows(prompt)[1][0].options.some((option) => option.default && option.value === String(matchday))) {
    const day = f.interaction({ targetMessage: undefined, message: { embeds: prompt.embeds },
      customId: rows(prompt)[1][0].custom_id, values: [String(matchday)] });
    await handleManagementComponent(day, f.store, f.manager, ROLE, f.settings);
    prompt = day.response;
  }
  const button = f.interaction({ targetMessage: undefined, message: { embeds: prompt.embeds }, customId: rows(prompt)[2][0].custom_id });
  await handleManagementComponent(button, f.store, f.manager, ROLE, f.settings);
  button.picker = prompt;
  return button;
}

test("season choices use this server's history and configuration and retain defaults within Discord's option limit", async (t) => {
  const f = setup(t);
  for (let season = 1; season <= 35; season++) {
    if (season !== 4) f.store.add({ ...f.data, season });
  }
  f.store.add({ ...f.data, guildId: "300000000000000002", season: 9999 });
  f.settings.get = () => ({ season: 40, matchdays: 9 });
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE, f.settings);
  const options = rows(command.response)[0][0].options;
  assert.equal(options.length, 25);
  assert.equal(options.filter((option) => option.default).length, 1);
  assert.equal(options.find((option) => option.default).value, "4");
  for (const value of ["4", "35", "40", "other"]) assert.ok(options.some((option) => option.value === value));
  assert.ok(!options.some((option) => option.value === "9999"));
});

test("switching to a shorter season clamps the day and preserves the preview without saving a correction", async (t) => {
  const f = setup(t);
  f.store.save([{ ...f.current(), season: 3, matchday: 20 }]);
  const original = f.current();
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE, f.settings);
  assert.equal(rows(command.response)[1][0].options.length, 25);
  const select = f.interaction({ targetMessage: undefined, message: { embeds: command.response.embeds },
    customId: rows(command.response)[0][0].custom_id, values: ["4"] });
  await handleManagementComponent(select, f.store, f.manager, ROLE, f.settings);
  const days = rows(select.response)[1][0].options;
  assert.equal(days.length, 9);
  assert.equal(days.find((option) => option.default).value, "9");
  assert.deepEqual(select.response.embeds, f.message.embeds);
  assert.deepEqual(f.current(), original);
  assert.equal(f.edits.length, 0);
});

test("an unlisted season can be entered separately and canceling discards all selections", async (t) => {
  const f = setup(t);
  const original = f.current();
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE, f.settings);
  const select = f.interaction({ targetMessage: undefined, message: { embeds: command.response.embeds },
    customId: rows(command.response)[0][0].custom_id, values: ["other"] });
  await handleManagementComponent(select, f.store, f.manager, ROLE, f.settings);
  assert.equal(select.modal.components.length, 1);
  assert.equal(select.modal.components[0].component.custom_id, "season");
  for (const value of ["0", "10000", "4 / 3", ""]) {
    await assert.rejects(handleManagementComponent(f.interaction({ customId: select.modal.custom_id,
      fields: { getTextInputValue: () => value } }), f.store, f.manager, ROLE, f.settings), /gültige Season/);
  }
  const number = f.interaction({ targetMessage: undefined, message: { embeds: command.response.embeds },
    customId: select.modal.custom_id, fields: { getTextInputValue: () => " 9999 " } });
  await handleManagementComponent(number, f.store, f.manager, ROLE, f.settings);
  assert.equal(rows(number.response)[0][0].options.find((option) => option.default).value, "9999");
  assert.equal(rows(number.response)[1][0].options.length, 25);
  const cancel = f.interaction({ customId: rows(number.response)[2][1].custom_id });
  await handleManagementComponent(cancel, f.store, f.manager, ROLE, f.settings);
  assert.deepEqual(cancel.response.components, []);
  assert.deepEqual(cancel.response.embeds, []);
  assert.deepEqual(f.current(), original);
  assert.equal(f.edits.length, 0);
  assert.equal(f.fetches.length, 0);
});

test("picker actions reject another user or a stale revision and final submission rechecks the configured day limit", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f, { matchday: 9 });
  const customId = rows(command.picker)[0][0].custom_id;
  await assert.rejects(handleManagementComponent(f.interaction({ customId, values: ["other"], user: { id: OTHER } }),
    f.store, f.manager, ROLE, f.settings), /anderen Person/);
  f.settings.get = () => ({ season: 4, matchdays: 8 });
  await assert.rejects(handleManagementComponent(f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
    f.store, f.manager, ROLE, f.settings), /Spieltag gehört nicht/);
  f.store.save([{ ...f.current(), revision: 1 }]);
  await assert.rejects(handleManagementComponent(f.interaction({ customId, values: ["other"] }),
    f.store, f.manager, ROLE, f.settings), /inzwischen geändert/);
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
  assert.equal((await new ReportPublisher(restarted).publish(f.change().target, f.channel, {})).status, "duplicate");
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
  f.message.edit = async (payload) => { await edit(payload); f.store.filePath = join(f.filePath, "invalid.json"); };
  await assert.rejects(f.apply(), /Post wurde geändert.*Archiv/);
  const restarted = new MatchStore(f.filePath);
  const pending = restarted.get(f.record.id, GUILD);
  assert.equal(pending.change.kind, "edit");
  const publisher = new ReportPublisher(restarted);
  assert.equal((await publisher.publish(f.data, f.channel, {})).status, "maintenance");
  assert.equal((await publisher.publish(f.change().target, f.channel, {})).status, "maintenance");
  f.message.edit = edit;
  assert.equal(await new ReportManager(restarted).apply(f.record.id, GUILD, f.channel, BOT), "edit");
  assert.equal(restarted.get(f.record.id, GUILD).matchday, 2);
  assert.equal(f.edits.length, 2);
});

test("ambiguous edit and delete responses can be retried after a restart without creating another post", async (t) => {
  for (const kind of ["edit", "delete"]) {
    const f = setup(t);
    const action = f.message[kind].bind(f.message);
    f.message[kind] = async (...args) => { await action(...args); throw new Error("network timeout"); };
    await assert.rejects(f.apply(kind === "edit" ? f.change() : { kind }), /Ausgang.*unklar/);
    const restarted = new MatchStore(f.filePath);
    assert.equal(restarted.get(f.record.id, GUILD).change.kind, kind);
    f.message[kind] = action;
    assert.equal(await new ReportManager(restarted).apply(f.record.id, GUILD, f.channel, BOT), kind);
    assert.equal(restarted.list(GUILD).length, kind === "edit" ? 1 : 0);
  }
});

test("a rejected fresh edit preserves the original, while a rejected retry retains its recovery data", async (t) => {
  const f = setup(t);
  const edit = f.message.edit.bind(f.message);
  f.message.edit = async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
  await assert.rejects(f.apply(), /nicht durchgeführt/);
  assert.equal(f.current().change, undefined);
  assert.equal(f.current().matchday, 1);
  f.message.edit = async () => { throw new Error("unknown delivery"); };
  await assert.rejects(f.apply(), /unklar/);
  f.message.edit = async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
  await assert.rejects(f.manager.apply(f.record.id, GUILD, f.channel, BOT), /unklar/);
  assert.equal(f.current().change.kind, "edit");
  f.message.edit = edit;
  assert.equal(await f.apply({ kind: "delete" }), "delete", "A confirmed deletion can replace an unresolved correction");
});

test("parallel mutations are blocked, duplicate targets rejected and score-only edits invalidate stale forms", async (t) => {
  const f = setup(t);
  let release;
  f.message.edit = () => new Promise((resolve) => { release = resolve; });
  const previousRevision = revisionOf(f.current());
  const running = f.apply(f.change(f.data));
  await new Promise(setImmediate);
  await assert.rejects(f.manager.apply(f.record.id, GUILD, f.channel, BOT), /gerade geändert/);
  release();
  await running;
  assert.notEqual(revisionOf(f.current()), previousRevision);
  assert.throws(() => f.store.beginChange(f.record.id, GUILD, previousRevision, { kind: "delete" }), /inzwischen geändert/);
  f.store.add(f.change().target);
  await assert.rejects(f.apply(), /anderer Report/);
  assert.equal(f.current().change, undefined);
});

test("foreign guilds, wrong channels and messages from another author cannot be mutated", async (t) => {
  const f = setup(t);
  await assert.rejects(f.manager.apply(f.record.id, "300000000000000002", f.channel, BOT), /nicht gefunden/);
  await assert.rejects(f.manager.apply(f.record.id, GUILD, { ...f.channel, id: "400000000000000002" }, BOT), /Kanal/);
  assert.equal(f.current().change, undefined);
  f.message.author.id = OTHER;
  await assert.rejects(f.apply(), /nicht durchgeführt/);
  assert.equal(f.edits.length, 0);
  assert.equal(f.current().change, undefined);
});

test("invalid persisted correction journals fail closed when loading the archive", (t) => {
  const f = setup(t);
  const original = f.current();
  for (const change of [{ kind: "unknown" }, { kind: "delete", extra: "bad" },
    { ...f.change(), embed: {} }, { ...f.change(), target: { ...f.data, guildId: "300000000000000002" } }]) {
    fs.writeFileSync(f.filePath, JSON.stringify({ version: 1, matches: [{ ...original, change }] }));
    assert.throws(() => new MatchStore(f.filePath), /nicht gelesen/);
  }
});

test("context-menu correction offers season and day dropdowns before a prefilled four-field modal", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  assert.equal(rows(command.picker)[0][0].options.find((option) => option.default).value, "4");
  assert.equal(rows(command.picker)[1][0].options.find((option) => option.default).value, "1");
  assert.equal(rows(command.picker)[1][0].options.length, 9);
  assert.ok(command.picker.flags.includes(MessageFlags.Ephemeral));
  assert.equal(command.modal.components.length, 4);
  assert.ok(command.modal.custom_id.length <= 100);
  const components = command.modal.components.map((label) => label.component);
  assert.equal(components[0].options.find((option) => option.default).value, JAN);
  assert.equal(components[1].options.find((option) => option.default).value, MAX);
  assert.equal(components[2].value, "2-0");
  assert.equal(components[3].value, f.data.link);
  assert.equal(f.edits.length, 0);
  assert.equal(managementCommands.filter((entry) => entry.type === 3).length, 2);
  assert.ok(managementCommands.every((entry) => entry.default_member_permissions === undefined));
});

test("match participants and server managers can manage a report, but other league members cannot", async (t) => {
  const f = setup(t);
  for (const id of [JAN, MAX]) {
    const command = f.interaction({ user: { id } });
    await openManagement(command, f.store, f.manager, ROLE);
    assert.ok(command.response.components);
  }
  await assert.rejects(openManagement(f.interaction({ user: { id: OTHER } }), f.store, f.manager, ROLE), /Nur die beiden/);
  const admin = f.interaction({ user: { id: OTHER }, memberPermissions: permissions(P.ManageGuild) });
  await openManagement(admin, f.store, f.manager, ROLE);
  assert.ok(admin.response.components);
  f.message.author.id = OTHER;
  await assert.rejects(openManagement(f.interaction(), f.store, f.manager, ROLE), /Ergebnispost dieses Bots/);
});

test("correction submission updates season, players, score and replay while keeping spoilers and mentions safe", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f, { season: 5, matchday: 3 });
  const submit = f.interaction({ customId: command.modal.custom_id,
    fields: f.fields({ winner: OTHER, score: "1-0 || @everyone" }) });
  await handleManagementComponent(submit, f.store, f.manager, ROLE, f.settings);
  assert.ok(submit.defer.flags.includes(MessageFlags.Ephemeral));
  assert.match(submit.response.content, /korrigiert/);
  assert.equal(f.current().season, 5);
  assert.equal(f.current().matchday, 3);
  assert.ok(f.current().players.some((player) => player.id === OTHER));
  assert.equal(f.edits[0].embeds[0].fields[0].value.includes("Lennart"), true);
  assert.match(f.edits[0].embeds[0].fields[2].value, /^\|\| .*\\\|\\\|.* \|\|$/);
  assert.deepEqual(f.edits[0].allowedMentions, { parse: [] });
});

test("historical participants remain selectable without the role; newly selected people must still have it", async (t) => {
  const f = setup(t);
  f.members.delete(MAX);
  const command = await openCorrection(f);
  assert.equal(command.modal.components[1].component.options.find((option) => option.default).value, MAX);
  const submit = f.interaction({ customId: command.modal.custom_id, fields: f.fields() });
  await handleManagementComponent(submit, f.store, f.manager, ROLE, f.settings);
  const fresh = await openCorrection(f);
  f.members.get(OTHER).roles.cache.clear();
  await assert.rejects(handleManagementComponent(f.interaction({ customId: fresh.modal.custom_id,
    fields: f.fields({ winner: OTHER }) }), f.store, f.manager, ROLE, f.settings), /Teilnehmerrolle/);
});

test("duplicate display names require explicit player selection instead of guessing the old winner", (t) => {
  const f = setup(t);
  const record = { ...f.current(), players: f.current().players.map((player) => ({ ...player, name: "Max" })) };
  const command = f.interaction({ targetMessage: { ...f.message,
    embeds: createResultMessage("Max", "Max", "2-0", f.data.link, f.data).embeds.map((embed) => embed.toJSON()) } });
  const modal = correctionModal(command, record, ROLE).toJSON();
  assert.equal(modal.components[0].component.options.some((option) => option.default), false);
  assert.equal(modal.components[1].component.options.some((option) => option.default), false);
});

test("invalid, foreign, stale or no-longer-authorized forms cannot change any data", async (t) => {
  const f = setup(t);
  const command = await openCorrection(f);
  for (const context of [":0:2", ":4:10", ":4:26"]) {
    await assert.rejects(handleManagementComponent(f.interaction({
      customId: command.modal.custom_id.replace(/:\d+:\d+$/, context), fields: f.fields(),
    }), f.store, f.manager, ROLE, f.settings));
  }
  for (const values of [{ winner: JAN, loser: JAN },
    { score: " " }, { link: "javascript:alert(1)" }]) {
    await assert.rejects(handleManagementComponent(f.interaction({ customId: command.modal.custom_id, fields: f.fields(values) }),
      f.store, f.manager, ROLE, f.settings));
  }
  await assert.rejects(handleManagementComponent(f.interaction({ user: { id: OTHER },
    customId: command.modal.custom_id, fields: f.fields() }), f.store, f.manager, ROLE, f.settings), /anderen Person/);
  f.store.save([{ ...f.current(), revision: 1 }]);
  await assert.rejects(handleManagementComponent(f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
    f.store, f.manager, ROLE, f.settings), /inzwischen geändert/);
  f.store.save([{ ...f.current(), players: [{ id: OTHER, name: "Lennart" }, { id: MAX, name: "Max" }] }]);
  await assert.rejects(handleManagementComponent(f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
    f.store, f.manager, ROLE, f.settings), /Nur die beiden/);
  assert.equal(f.edits.length, 0);
});

test("deletion requires a private confirmation; canceling leaves the post and search untouched", async (t) => {
  const f = setup(t);
  const command = f.interaction({ commandName: "Report löschen" });
  await openManagement(command, f.store, f.manager, ROLE);
  assert.ok(command.response.flags.includes(MessageFlags.Ephemeral));
  assert.equal(f.deletions.length, 0);
  const buttons = command.response.components[0].toJSON().components;
  const cancel = f.interaction({ customId: buttons[1].custom_id });
  await handleManagementComponent(cancel, f.store, f.manager, ROLE, f.settings);
  assert.match(cancel.response.content, /abgebrochen/);
  assert.equal(f.store.list(GUILD).length, 1);
  const confirm = f.interaction({ customId: buttons[0].custom_id });
  await handleManagementComponent(confirm, f.store, f.manager, ROLE, f.settings);
  assert.match(confirm.response.content, /entfernt/);
  assert.equal(f.isDeleted(), true);
  assert.equal(f.store.list(GUILD).length, 0);
});

test("the slash fallback finds a deleted post by season and player and removes it only after confirmation", async (t) => {
  const f = setup(t);
  f.removePost();
  const command = f.interaction({ commandName: "report-entfernen",
    options: removalOptions({ name: "jan", matchday: 1 }) });
  await openManagement(command, f.store, f.manager, ROLE);
  assert.ok(command.defer.flags.includes(MessageFlags.Ephemeral));
  assert.match(command.response.content, /Season 4 · Spieltag 1 · Jan vs\. Max/);
  assert.ok(command.response.content.includes(f.data.link));
  assert.equal(f.store.list(GUILD).length, 1);
  assert.equal(f.fetches.length, 0, "Searching does not need the original message");
  const confirm = f.interaction({ customId: command.response.components[0].toJSON().components[0].custom_id });
  await handleManagementComponent(confirm, f.store, f.manager, ROLE, f.settings);
  assert.equal(f.store.list(GUILD).length, 0);
  assert.equal(f.deletions.length, 0);
  const slash = managementCommands.find((entry) => entry.name === "report-entfernen");
  assert.deepEqual(slash.options.map((option) => option.name), ["season", "name", "spieltag"]);
  assert.equal(slash.options[1].autocomplete, true);
});

test("multiple removal matches require selecting exactly one report and confirming it", async (t) => {
  const f = setup(t);
  const second = addPublished(f, { matchday: 2, link: "https://example.org/second" });
  addPublished(f, { season: 5 }, "500000000000000003");
  const command = f.interaction({ commandName: "report-entfernen", options: removalOptions() });
  await openManagement(command, f.store, f.manager, ROLE);
  const options = rows(command.response)[0][0].options;
  assert.equal(options.length, 2);
  assert.match(options[1].label, /Spieltag 2 · Jan vs\. Max/);
  assert.equal(options[1].description, second.link);
  assert.equal(f.deletions.length, 0);
  const select = f.interaction({ customId: rows(command.response)[0][0].custom_id, values: [options[0].value] });
  await handleManagementComponent(select, f.store, f.manager, ROLE, f.settings);
  assert.match(select.response.content, /wirklich löschen/);
  assert.equal(f.deletions.length, 0);
  const confirm = f.interaction({ customId: rows(select.response)[0][0].custom_id });
  await handleManagementComponent(confirm, f.store, f.manager, ROLE, f.settings);
  assert.equal(f.deletions.length, 1);
  assert.equal(f.store.list(GUILD).length, 2);
  const specific = f.interaction({ commandName: "report-entfernen", options: removalOptions({ matchday: 2 }) });
  await openManagement(specific, f.store, f.manager, ROLE);
  assert.ok(specific.response.content.includes(second.link));
  assert.match(specific.response.content, /wirklich löschen/);
});

test("removal pages include every match and canceling never deletes anything", async (t) => {
  const f = setup(t);
  for (let index = 1; index < 27; index++) addPublished(f, { link: `https://example.org/${index}` }, String(BigInt(MESSAGE) + BigInt(index)));
  const command = f.interaction({ commandName: "report-entfernen", options: removalOptions() });
  await openManagement(command, f.store, f.manager, ROLE);
  assert.match(command.response.content, /27 Treffer · Seite 1 von 2/);
  const firstPage = rows(command.response)[0][0].options;
  assert.equal(firstPage.length, 25);
  const next = f.interaction({ customId: rows(command.response)[1][1].custom_id });
  await handleManagementComponent(next, f.store, f.manager, ROLE, f.settings);
  assert.match(next.response.content, /Seite 2 von 2/);
  const secondPage = rows(next.response)[0][0].options;
  assert.equal(secondPage.length, 2);
  assert.equal(new Set([...firstPage, ...secondPage].map((option) => option.value)).size, 27);
  const cancel = f.interaction({ customId: rows(next.response)[1][2].custom_id });
  await handleManagementComponent(cancel, f.store, f.manager, ROLE, f.settings);
  assert.deepEqual(cancel.response.components, []);
  assert.equal(f.deletions.length, 0);
  assert.equal(f.store.list(GUILD).length, 27);
});

test("removal suggestions and results exclude other people's reports, other servers and inaccessible private threads", async (t) => {
  const f = setup(t);
  const hiddenChannel = "400000000000000002";
  addPublished(f, { players: [{ id: OTHER, name: "Lennart" }, { id: MAX, name: "Max" }] });
  addPublished(f, { guildId: "300000000000000002", players: [{ id: JAN, name: "Fremder Server" }, { id: MAX, name: "Max" }] });
  addPublished(f, { channelId: hiddenChannel, players: [{ id: JAN, name: "Versteckt" }, { id: MAX, name: "Max" }] });
  f.store.add({ ...f.data, link: "https://example.org/pending", players: [{ id: JAN, name: "Noch nicht veröffentlicht" }, { id: MAX, name: "Max" }] });
  const fetchChannel = f.guild.channels.fetch;
  f.guild.channels.fetch = async (id) => id === hiddenChannel ? {
    ...f.channel, id: hiddenChannel, type: ChannelType.PrivateThread,
    members: { cache: new Collection([[JAN, {}]]), async fetch() { throw new Error("no longer a member"); } },
  } : fetchChannel(id);
  const autocomplete = f.interaction({ options: removalOptions({ name: "" }), async respond(choices) { this.choices = choices; } });
  await handleRemovalAutocomplete(autocomplete, f.store);
  assert.deepEqual(autocomplete.choices.map((choice) => choice.name), ["Jan", "Max"]);
  const command = f.interaction({ commandName: "report-entfernen", options: removalOptions({ name: OTHER }) });
  await openManagement(command, f.store, f.manager, ROLE);
  assert.match(command.response.content, /Keine passenden Reports/);
  const admin = f.interaction({ commandName: "report-entfernen", memberPermissions: permissions(P.ManageGuild),
    options: removalOptions({ name: OTHER }) });
  await openManagement(admin, f.store, f.manager, ROLE);
  assert.match(admin.response.content, /Lennart/);
  assert.equal(f.deletions.length, 0);
});

test("removal choices reject stale records, foreign users, revoked access and invalid filters", async (t) => {
  const f = setup(t);
  addPublished(f, { matchday: 2 });
  const command = f.interaction({ commandName: "report-entfernen", options: removalOptions() });
  await openManagement(command, f.store, f.manager, ROLE);
  const customId = rows(command.response)[0][0].custom_id;
  const values = [rows(command.response)[0][0].options[0].value];
  await assert.rejects(handleManagementComponent(f.interaction({ customId, values, user: { id: OTHER } }),
    f.store, f.manager, ROLE, f.settings), /anderen Person/);
  f.channel.permissionsFor = () => new PermissionsBitField([]);
  await assert.rejects(handleManagementComponent(f.interaction({ customId, values }),
    f.store, f.manager, ROLE, f.settings), /keinen Zugriff/);
  f.channel.permissionsFor = () => permissions();
  f.store.save(f.store.list(GUILD).map((match) => ({ ...match, revision: 1 })));
  await assert.rejects(handleManagementComponent(f.interaction({ customId, values }),
    f.store, f.manager, ROLE, f.settings), /inzwischen geändert/);
  for (const filters of [{ season: 0 }, { season: 10000 }, { matchday: 26 }]) {
    await assert.rejects(openManagement(f.interaction({ commandName: "report-entfernen", options: removalOptions(filters) }),
      f.store, f.manager, ROLE), /Season von/);
  }
  assert.equal(f.deletions.length, 0);
});

test("removal suggestions retain historical names and require explicit selection for duplicate names", async (t) => {
  const f = setup(t);
  addPublished(f, { matchday: 2, players: [{ id: JAN, name: "Roran321" }, { id: MAX, name: "Max" }] });
  f.members.clear();
  const autocomplete = f.interaction({ options: removalOptions({ name: "ja" }), async respond(choices) { this.choices = choices; } });
  await handleRemovalAutocomplete(autocomplete, f.store);
  assert.deepEqual(autocomplete.choices, [{ name: "Roran321", value: JAN }]);
  f.store.save(f.store.list(GUILD).map((match) => ({ ...match, players: match.players.map((player) => ({ ...player, name: "Max" })) })));
  await assert.rejects(openManagement(f.interaction({ commandName: "report-entfernen", options: removalOptions({ name: "Max" }) }),
    f.store, f.manager, ROLE), /Mehrere Teilnehmer/);
  const selected = f.interaction({ commandName: "report-entfernen", options: removalOptions({ name: MAX }) });
  await openManagement(selected, f.store, f.manager, ROLE);
  assert.equal(rows(selected.response)[0][0].options.length, 2);
});

test("a fresh private-thread membership check rejects removed members even if the cache is stale", async (t) => {
  const f = setup(t);
  f.channel.type = ChannelType.PrivateThread;
  const command = await openCorrection(f);
  f.channel.members.fetch = async () => { throw new Error("not a member"); };
  await assert.rejects(handleManagementComponent(f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
    f.store, f.manager, ROLE, f.settings), /privaten Thread/);
  assert.equal(f.edits.length, 0);
  f.channel.type = ChannelType.GuildText;
  f.guild.channels.cache.clear();
  await handleManagementComponent(f.interaction({ customId: command.modal.custom_id, fields: f.fields() }),
    f.store, f.manager, ROLE, f.settings);
  assert.equal(f.edits.length, 1, "Channel loading is not limited to the cache");
});

test("a deletion survives a disk failure after Discord removed the message and resumes from a missing post", async (t) => {
  const f = setup(t);
  const remove = f.message.delete.bind(f.message);
  f.message.delete = async () => { await remove(); f.store.filePath = join(f.filePath, "invalid.json"); };
  await assert.rejects(f.apply({ kind: "delete" }), /Archiv konnte nicht aktualisiert/);
  const restarted = new MatchStore(f.filePath);
  assert.equal(restarted.get(f.record.id, GUILD).change.kind, "delete");
  assert.equal(await new ReportManager(restarted).apply(f.record.id, GUILD, f.channel, BOT), "delete");
  assert.equal(restarted.list(GUILD).length, 0);
  assert.equal(f.deletions.length, 1);
});

test("prefilling a correction reverses escaped score text without changing its backslashes or markdown", (t) => {
  const f = setup(t);
  const score = "2\\0 ** || ` @everyone";
  const command = f.interaction({ targetMessage: { ...f.message,
    embeds: createResultMessage("Jan", "Max", score, f.data.link, f.data).embeds.map((embed) => embed.toJSON()) } });
  const modal = correctionModal(command, f.current(), ROLE).toJSON();
  assert.equal(modal.components[2].component.value, score);
});

test("opening correction cannot accidentally execute a previously pending deletion", async (t) => {
  const f = setup(t);
  f.store.beginChange(f.record.id, GUILD, revisionOf(f.current()), { kind: "delete" });
  await assert.rejects(openManagement(f.interaction(), f.store, f.manager, ROLE), /Löschung vorgemerkt/);
  assert.equal(f.deletions.length, 0);
});
