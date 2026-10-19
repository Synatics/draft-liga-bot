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
const { managementCommands, openManagement, handleManagementComponent, correctionModal, messageReference } = require("./report-management");

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
    const values = { context: "4 / 2", winner: JAN, loser: MAX, score: "1-0", link: "https://example.org/corrected", ...overrides };
    return { getStringSelectValues: (name) => [values[name]], getTextInputValue: (name) => values[name] };
  };
  return { directory, filePath, store, manager, record, data, message, channel, guild, members, settings,
    edits, deletions, fetches, interaction, current, change, apply, fields,
    removePost() { deleted = true; }, isDeleted: () => deleted };
}

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

test("context-menu correction opens a real five-field modal with selected players and existing values", async (t) => {
  const f = setup(t);
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE);
  assert.equal(command.modal.components.length, 5);
  assert.ok(command.modal.custom_id.length <= 100);
  const components = command.modal.components.map((label) => label.component);
  assert.equal(components[0].value, "4 / 1");
  assert.equal(components[1].options.find((option) => option.default).value, JAN);
  assert.equal(components[2].options.find((option) => option.default).value, MAX);
  assert.equal(components[3].value, "2-0");
  assert.equal(components[4].value, f.data.link);
  assert.equal(f.edits.length, 0);
  assert.equal(managementCommands.filter((entry) => entry.type === 3).length, 2);
  assert.ok(managementCommands.every((entry) => entry.default_member_permissions === undefined));
});

test("match participants and server managers can manage a report, but other league members cannot", async (t) => {
  const f = setup(t);
  for (const id of [JAN, MAX]) {
    const command = f.interaction({ user: { id } });
    await openManagement(command, f.store, f.manager, ROLE);
    assert.ok(command.modal);
  }
  await assert.rejects(openManagement(f.interaction({ user: { id: OTHER } }), f.store, f.manager, ROLE), /Nur die beiden/);
  const admin = f.interaction({ user: { id: OTHER }, memberPermissions: permissions(P.ManageGuild) });
  await openManagement(admin, f.store, f.manager, ROLE);
  assert.ok(admin.modal);
  f.message.author.id = OTHER;
  await assert.rejects(openManagement(f.interaction(), f.store, f.manager, ROLE), /Ergebnispost dieses Bots/);
});

test("correction submission updates season, players, score and replay while keeping spoilers and mentions safe", async (t) => {
  const f = setup(t);
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE);
  const submit = f.interaction({ customId: command.modal.custom_id,
    fields: f.fields({ context: "5 / 3", winner: OTHER, score: "1-0 || @everyone" }) });
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
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE);
  assert.equal(command.modal.components[2].component.options.find((option) => option.default).value, MAX);
  const submit = f.interaction({ customId: command.modal.custom_id, fields: f.fields() });
  await handleManagementComponent(submit, f.store, f.manager, ROLE, f.settings);
  const fresh = f.interaction();
  await openManagement(fresh, f.store, f.manager, ROLE);
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
  assert.equal(modal.components[1].component.options.some((option) => option.default), false);
  assert.equal(modal.components[2].component.options.some((option) => option.default), false);
});

test("invalid, foreign, stale or no-longer-authorized forms cannot change any data", async (t) => {
  const f = setup(t);
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE);
  for (const values of [{ context: "0/2" }, { context: "4/10" }, { winner: JAN, loser: JAN },
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

test("the slash fallback removes a missing post's archive record using its original message link", async (t) => {
  const f = setup(t);
  f.removePost();
  const command = f.interaction({ commandName: "report-entfernen",
    options: { getString: () => `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}` } });
  await openManagement(command, f.store, f.manager, ROLE);
  const confirm = f.interaction({ customId: command.response.components[0].toJSON().components[0].custom_id });
  await handleManagementComponent(confirm, f.store, f.manager, ROLE, f.settings);
  assert.equal(f.store.list(GUILD).length, 0);
  assert.equal(f.deletions.length, 0);
  for (const url of ["https://evil.example/channels/1/2/3", "javascript:alert(1)", "https://discord.com/channels/@me/123"]) {
    assert.throws(() => messageReference(url), /Nachrichtenlink/);
  }
});

test("a fresh private-thread membership check rejects removed members even if the cache is stale", async (t) => {
  const f = setup(t);
  f.channel.type = ChannelType.PrivateThread;
  const command = f.interaction();
  await openManagement(command, f.store, f.manager, ROLE);
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
  assert.equal(modal.components[3].component.value, score);
});

test("opening correction cannot accidentally execute a previously pending deletion", async (t) => {
  const f = setup(t);
  f.store.beginChange(f.record.id, GUILD, revisionOf(f.current()), { kind: "delete" });
  await assert.rejects(openManagement(f.interaction(), f.store, f.manager, ROLE), /Löschung vorgemerkt/);
  assert.equal(f.deletions.length, 0);
});
