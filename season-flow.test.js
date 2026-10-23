const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const {
  Collection,
  ChannelType,
  PermissionFlagsBits: P,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");
const { LigaDatabase } = require("./database");
const { LeagueSettingsStore } = require("./league-settings");
const { MatchStore } = require("./match-store");
const { ReportPublisher } = require("./report-publisher");
const { ReportManager } = require("./report-manager");
const { createInteractionHandler } = require("./interactions");
const { logFiles } = require("./audit-commands");
const { configureSeason } = require("./test-helpers/season-setup");

const GUILD = "300000000000000001",
  CHANNEL = "400000000000000001",
  BOT = "600000000000000001";
const JAN = "200000000000000001",
  MAX = "200000000000000002",
  ADMIN = "200000000000000003";
const ROLE = "100000000000000001",
  MANAGER = "100000000000000002";

function setup(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "liga-season-flow-test-"));
  const path = join(directory, "liga.sqlite");
  let database, settings, store, route;
  let now = new Date("2026-12-28T12:00:00Z");
  t.after(() => {
    database.close();
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const posts = new Map(),
    sent = [],
    errors = [],
    dms = [];
  const members = new Collection(
    [
      [JAN, "Jan"],
      [MAX, "Max"],
      [ADMIN, "Verwaltung"],
    ].map(([id, name]) => [
      id,
      {
        id,
        displayName: name,
        user: { id, username: name, bot: false },
        permissions: new PermissionsBitField(),
        roles: { cache: new Collection([[id === ADMIN ? MANAGER : ROLE, {}]]) },
      },
    ]),
  );
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]),
    messages: {
      async fetch({ message }) {
        const post = posts.get(message);
        if (!post) throw Object.assign(new Error("Unknown Message"), { code: 10008, status: 404 });
        return post;
      },
    },
    async send(payload) {
      const id = String(500000000000000001n + BigInt(sent.length));
      const post = {
        id,
        author: { id: BOT },
        embeds: payload.embeds.map((embed) => embed.toJSON()),
        async edit(changes) {
          this.embeds = changes.embeds;
          this.edits = (this.edits || 0) + 1;
        },
        async delete() {
          posts.delete(id);
        },
      };
      sent.push(post);
      posts.set(id, post);
      return post;
    },
  };
  const guild = {
    id: GUILD,
    roles: {
      cache: new Collection([
        [ROLE, {}],
        [MANAGER, {}],
      ]),
    },
    members: {
      cache: members,
      async fetch({ user }) {
        return members.get(user);
      },
    },
    channels: {
      cache: new Collection([[CHANNEL, channel]]),
      async fetch(id) {
        return this.cache.get(id);
      },
    },
  };
  const config = { participantRoleId: ROLE, managerRoleId: MANAGER };
  const options = (values) => ({
    getInteger: (name) => values[name] ?? null,
    getString: (name) => values[name] ?? null,
    getBoolean: (name) => values[name] ?? null,
    get: (name) => (values[name] == null ? null : { value: values[name] }),
    getSubcommand: () => values.subcommand,
    getFocused: () => values.focused,
  });
  const interaction = (changes = {}, userId = JAN) => ({
    guild,
    channel,
    channelId: CHANNEL,
    client: { user: { id: BOT } },
    user: {
      id: userId,
      async send(payload) {
        dms.push(payload);
      },
    },
    member: members.get(userId),
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    async showModal(modal) {
      this.modal = modal.toJSON();
    },
    async reply(payload) {
      this.response = payload;
      this.replied = true;
    },
    async deferReply(payload) {
      this.defer = payload;
      this.deferred = true;
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
    async respond(choices) {
      this.choices = choices;
    },
    ...changes,
  });
  const fields = (values) => ({
    getStringSelectValues: (name) => (Array.isArray(values[name]) ? values[name] : [values[name]]),
    getTextInputValue: (name) => values[name],
  });
  function restart() {
    database?.close();
    database = new LigaDatabase(path);
    settings = new LeagueSettingsStore(path, () => now, database);
    store = new MatchStore(path, database);
    route = createInteractionHandler({
      config,
      database,
      settingsStore: settings,
      matchStore: store,
      reportPublisher: new ReportPublisher(store),
      reportManager: new ReportManager(store),
      memberLoader: { isLoaded: () => true },
      logger: {
        log() {},
        error(value) {
          errors.push(value);
        },
      },
    });
  }
  restart();
  const handle = async (item) => {
    await route(item);
    return item;
  };
  const command = (name, values = {}, user = JAN) =>
    handle(
      interaction(
        { commandName: name, isChatInputCommand: () => true, options: options(values) },
        user,
      ),
    );
  const button = (post, kind, user = JAN) =>
    handle(
      interaction(
        {
          customId: `report:${kind}:${store.findByMessage(GUILD, CHANNEL, post.id).id}`,
          message: post,
          isButton: () => true,
        },
        user,
      ),
    );
  const submit = (modal, values) =>
    handle(
      interaction({
        customId: modal.custom_id,
        isModalSubmit: () => true,
        fields: fields({
          winner: JAN,
          loser: MAX,
          score: "2-0",
          link: "https://example.org/replay",
          ...values,
        }),
      }),
    );
  return {
    channel,
    guild,
    posts,
    sent,
    errors,
    dms,
    options,
    interaction,
    fields,
    handle,
    command,
    button,
    submit,
    restart,
    get database() {
      return database;
    },
    get settings() {
      return settings;
    },
    get store() {
      return store;
    },
    at(date) {
      now = new Date(date);
    },
    configure(values = {}) {
      return configureSeason({
        handle,
        interaction,
        user: ADMIN,
        values: {
          nummer: 5,
          spieltage: 9,
          startdatum: "19.10.2026",
          format: "playoffs",
          redraft: true,
          ...values,
        },
      });
    },
    async report(round, link = "https://example.org/replay") {
      const opened = await command("report");
      assert.ok(opened.modal, JSON.stringify(opened.response));
      return submit(opened.modal, { round, link });
    },
  };
}

test("season commands, pause status and report routing publish explicit playoff rounds with persistent duplicate protection", async (t) => {
  const f = setup(t);
  const configured = await f.configure();
  assert.match(configured.response.content, /Playoffs · Halbfinale/);
  assert.equal(f.settings.get(GUILD).rounds.length, 12);
  f.at("2026-12-21T12:00:00Z");
  const status = await f.command("liga", { subcommand: "status" }, ADMIN);
  assert.match(status.response.content, /Redraft/);
  assert.match(status.response.content, /Nächste Woche: Playoffs · Halbfinale/);
  const opened = await f.command("report");
  assert.ok(!opened.modal.components[0].component.options.some((option) => option.default));
  const invalid = await f.submit(opened.modal, { round: "redraft" });
  assert.match(invalid.response.content, /spielbare Runde/);
  assert.equal(f.sent.length, 0);
  const late = await f.submit(opened.modal, { round: "matchday-9" });
  assert.match(late.response.content, /erfolgreich/);
  assert.equal(f.sent[0].embeds[0].author.name, "Season 5 · Spieltag 9");
  f.at("2026-12-28T12:00:00Z");
  await f.report("semifinal");
  const post = f.sent[1];
  assert.equal(post.embeds[0].author.name, "Season 5 · Playoffs · Halbfinale");
  assert.match(post.embeds[0].title, /^Liga Match: (Jan vs\. Max|Max vs\. Jan)$/);
  assert.ok(
    post.embeds[0].fields
      .slice(0, 3)
      .every((field) => field.value.startsWith("|| ") && field.value.endsWith(" ||")),
  );
  assert.equal(f.store.list(GUILD)[1].matchday, undefined);
  f.restart();
  const duplicate = await f.report("semifinal");
  assert.match(duplicate.response.content, /bereits gepostet/);
  assert.equal(f.sent.length, 2);
  assert.equal(f.database.auditEvents(GUILD, 5).length, 2);
  assert.equal(f.errors.length, 0);
});

test("editing league rounds into playoffs and back updates the same post, fresh search and audit snapshots", async (t) => {
  const f = setup(t);
  await f.configure();
  await f.report("matchday-9");
  const post = f.sent[0];
  const edit = await f.button(post, "edit");
  assert.equal(edit.modal.components.length, 5);
  assert.equal(
    edit.modal.components[0].component.options.find((choice) => choice.default).value,
    "matchday-9",
  );
  const saved = await f.submit(edit.modal, { round: "semifinal", winner: MAX, loser: JAN });
  assert.match(saved.response.content, /Playoffs · Halbfinale/);
  assert.equal(post.embeds[0].author.name, "Season 5 · Playoffs · Halbfinale");
  assert.equal(f.store.list(GUILD)[0].matchday, undefined);
  assert.equal(f.store.list(GUILD)[0].result.winnerId, MAX);
  f.restart();
  await f.command("suchen", { season: 5, name: JAN, runde: "semifinal" });
  assert.match(f.dms.at(-1).content, /Playoffs · Halbfinale · Jan vs\. Max/);
  assert.ok(!f.dms.at(-1).content.includes("Spieltag 9"));
  const back = await f.button(post, "edit");
  await f.submit(back.modal, { round: "matchday-8" });
  assert.equal(post.embeds[0].author.name, "Season 5 · Spieltag 8");
  assert.equal(f.store.list(GUILD)[0].round.id, "matchday-8");
  assert.equal(f.store.list(GUILD)[0].matchday, 8);
  assert.equal(f.sent.length, 1);
  const events = f.database.auditEvents(GUILD, 5);
  assert.deepEqual(
    events.map((event) => event.action),
    ["created", "edited", "edited"],
  );
  assert.equal(events[1].before.round.id, "matchday-9");
  assert.equal(events[1].after.round.id, "semifinal");
  const text = logFiles(events, 5)[0].data.toString("utf8");
  assert.match(text, /Season 5 · Playoffs · Halbfinale/);
  assert.ok(!text.includes("undefined"));
});

test("home/away labels survive season switches, and historical forms keep their own plan while changed plans invalidate stale forms", async (t) => {
  const f = setup(t);
  await f.configure({ format: "home-away", spieltage: 18 });
  await f.report("matchday-10");
  const post = f.sent[0];
  assert.equal(post.embeds[0].author.name, "Season 5 · Rückrunde · Spieltag 10");
  const opened = await f.button(post, "edit");
  await f.configure({ nummer: 6 });
  f.restart();
  const result = await f.submit(opened.modal, { round: "matchday-9" });
  assert.match(result.response.content, /Season 5 · Hinrunde · Spieltag 9/);
  assert.equal(f.store.list(GUILD)[0].season, 5);
  const historical = await f.button(post, "edit");
  assert.ok(
    historical.modal.components[0].component.options.some(
      (option) => option.label === "Rückrunde · Spieltag 18",
    ),
  );
  assert.ok(
    !historical.modal.components[0].component.options.some(
      (option) => option.value === "semifinal",
    ),
  );
  await f.report("semifinal");
  const current = f.sent[1];
  const stale = await f.button(current, "edit");
  await f.configure({ nummer: 6, playoffs_ab: "quarterfinal" });
  const denied = await f.submit(stale.modal, { round: "final" });
  assert.match(denied.response.content, /Rundenplan wurde inzwischen geändert/);
  assert.equal(current.edits, undefined);
});

test("a failed audit write keeps a playoff edit journal across restart and resumes it once with the original actor", async (t) => {
  const f = setup(t);
  await f.configure();
  await f.report("semifinal");
  const post = f.sent[0];
  const opened = await f.button(post, "edit");
  const writeEvent = f.database.writeEvent.bind(f.database);
  f.database.writeEvent = () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  const failed = await f.submit(opened.modal, { round: "final" });
  assert.match(failed.response.content, /Archiv konnte nicht aktualisiert/);
  assert.equal(post.embeds[0].author.name, "Season 5 · Playoffs · Finale");
  assert.equal(f.store.list(GUILD)[0].round.id, "semifinal");
  assert.equal(f.store.list(GUILD)[0].change.target.round.id, "final");
  f.database.writeEvent = writeEvent;
  f.restart();
  await f.button(post, "edit", ADMIN);
  assert.equal(f.store.list(GUILD)[0].round.id, "final");
  assert.equal(f.store.list(GUILD)[0].change, undefined);
  const events = f.database.auditEvents(GUILD, 5);
  assert.equal(events.length, 2);
  assert.equal(events[1].actor.id, JAN);
  assert.equal(events[1].after.round.id, "final");
});

test("playoff deletion checks management rights and the slash fallback removes manually deleted posts with their original round in the log", async (t) => {
  const f = setup(t);
  await f.configure();
  await f.report("semifinal");
  await f.report("final");
  const semi = f.sent[0],
    final = f.sent[1];
  const denied = await f.button(semi, "delete");
  assert.match(denied.response.content, /Nur die Ligaverwaltung/);
  assert.ok(denied.response.flags.includes(MessageFlags.Ephemeral));
  await semi.delete();
  const fallback = await f.command(
    "report-entfernen",
    { season: 5, name: JAN, runde: "Halbfinale" },
    ADMIN,
  );
  assert.match(fallback.response.content, /Season 5 · Playoffs · Halbfinale/);
  const confirmId = fallback.response.components[0].components[0].data.custom_id;
  await f.handle(f.interaction({ customId: confirmId, isButton: () => true }, ADMIN));
  assert.equal(f.store.list(GUILD).length, 1);
  assert.equal(f.store.list(GUILD)[0].round.id, "final");
  const prompt = await f.button(final, "delete", ADMIN);
  assert.match(prompt.response.content, /Playoffs · Finale/);
  const finalId = prompt.response.components[0].components[0].data.custom_id;
  await f.handle(f.interaction({ customId: finalId, isButton: () => true }, ADMIN));
  assert.equal(f.store.list(GUILD).length, 0);
  f.restart();
  const removed = f.database.auditEvents(GUILD, 5).filter((event) => event.action === "deleted");
  assert.deepEqual(
    removed.map((event) => event.before.round.id),
    ["semifinal", "final"],
  );
  assert.ok(removed.every((event) => event.actor.id === ADMIN));
});

test("round autocomplete respects season/channel visibility and removal pagination retains the selected round", async (t) => {
  const f = setup(t);
  await f.configure();
  await f.report("final");
  for (let i = 0; i < 26; i++) await f.report("semifinal", `https://example.org/replay-${i}`);
  const lookup = await f.handle(
    f.interaction({
      commandName: "suchen",
      isAutocomplete: () => true,
      options: f.options({ season: 5, focused: { name: "runde", value: "halb" } }),
    }),
  );
  assert.deepEqual(lookup.choices, [{ name: "Playoffs · Halbfinale", value: "semifinal" }]);
  f.channel.permissionsFor = () => new PermissionsBitField();
  const hidden = await f.handle(
    f.interaction({
      commandName: "suchen",
      isAutocomplete: () => true,
      options: f.options({ season: 5, focused: { name: "runde", value: "" } }),
    }),
  );
  assert.deepEqual(hidden.choices, []);
  f.channel.permissionsFor = () => new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]);
  const choices = await f.handle(
    f.interaction(
      {
        commandName: "report-entfernen",
        isAutocomplete: () => true,
        options: f.options({ season: 5, focused: { name: "runde", value: "halb" } }),
      },
      ADMIN,
    ),
  );
  assert.deepEqual(choices.choices, lookup.choices);
  const first = await f.command(
    "report-entfernen",
    { season: 5, name: JAN, runde: "semifinal" },
    ADMIN,
  );
  assert.match(first.response.content, /26 Treffer/);
  const pageId = first.response.components[1].components[1].data.custom_id;
  assert.ok(pageId.endsWith(":semifinal"));
  assert.ok(pageId.length <= 100);
  const next = await f.handle(f.interaction({ customId: pageId, isButton: () => true }, ADMIN));
  assert.match(next.response.content, /Seite 2 von 2/);
  const select = next.response.components[0].components[0].toJSON();
  assert.equal(select.options.length, 1);
  assert.match(select.options[0].label, /Playoffs · Halbfinale/);
  const picked = await f.handle(
    f.interaction(
      {
        customId: select.custom_id,
        values: [select.options[0].value],
        isStringSelectMenu: () => true,
      },
      ADMIN,
    ),
  );
  const confirmation = picked.response.components[0].components[0].data.custom_id;
  await f.handle(f.interaction({ customId: confirmation, isButton: () => true }, ADMIN));
  assert.equal(f.store.list(GUILD).length, 26);
  assert.equal(f.store.list(GUILD).filter((match) => match.round.id === "final").length, 1);
});
