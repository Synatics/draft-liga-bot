const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const discord = require("discord.js");
const reports = require("./reports");
const leagueSettings = require("./league-settings");
const leagueCommands = require("./league-commands");
const { MatchStore, MatchStoreError } = require("./match-store");
const searchCommands = require("./search-commands");

test("league settings, reports and role changes work together without exposing results", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pokemon-liga-index-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  });
  const settingsPath = join(directory, "league-settings.json");
  let now = new Date("2026-10-18T12:00:00Z");
  const initialStore = new leagueSettings.LeagueSettingsStore(settingsPath, () => now);
  const roleId = "100000000000000001";
  const janId = "200000000000000001";
  const maxId = "200000000000000002";
  const channelId = "400000000000000001";
  const members = new discord.Collection([janId, maxId].map((id, i) => [id, {
    id, displayName: ["Jan", "Max"][i], user: { bot: false },
    roles: { cache: new discord.Collection([[roleId, {}]]) },
  }]));
  const sequence = [];
  const posts = [];
  let finishLoading;
  let loads = 0;
  const loading = new Promise((resolve) => { finishLoading = resolve; });
  const guild = {
    id: "300000000000000001",
    roles: { cache: new discord.Collection([[roleId, {}]]) },
    channels: { cache: new discord.Collection([[channelId, {
      permissionsFor: () => new discord.PermissionsBitField([
        discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.ReadMessageHistory,
      ]),
    }]]) },
    members: {
      cache: members,
      async fetch(options) {
        if (!options.user) { loads++; await loading; return members; }
        sequence.push("fetch");
        assert.equal(options.force, true);
        return members.get(options.user);
      },
    },
  };
  initialStore.setSeason(guild.id, 3, 9, "31.08.2026");
  const client = new EventEmitter();
  client.guilds = { cache: new discord.Collection([[guild.id, guild]]) };
  client.login = async () => {};
  const source = readFileSync(require.resolve("./index"), "utf8");
  let registeredCommands;
  let failSaving = false;
  const errors = [];

  // Run the real entry point without reading credentials, registering commands or logging in.
  runInNewContext(source, {
    require(name) {
      if (name === "discord.js") return {
        ...discord,
        Client: class {
          constructor(options) {
            assert.ok(options.intents.includes(discord.GatewayIntentBits.GuildMembers));
            return client;
          }
        },
        REST: class {
          setToken() { return this; }
          async put(route, { body }) { registeredCommands = body; }
        },
      };
      if (name === "dotenv") return { config() {} };
      if (name === "node:path") return require(name);
      if (name === "./reports") return reports;
      if (name === "./report-publisher") return require(name);
      if (name === "./data-backups") return {
        ...require(name),
        startAutomaticBackups(backups) {
          const timer = require(name).startAutomaticBackups(backups, { log() {}, error(...args) { errors.push(args); } });
          t.after(() => clearInterval(timer));
          return timer;
        },
      };
      if (name === "./match-store") return {
        ...require(name),
        MatchStore: class extends MatchStore {
          save(matches) {
            if (failSaving) throw new MatchStoreError("Das Replay konnte nicht gespeichert werden.");
            return super.save(matches);
          }
        },
      };
      if (name === "./search-commands") return searchCommands;
      if (name === "./league-settings") return {
        ...leagueSettings,
        settingsFilePath: () => settingsPath,
        LeagueSettingsStore: class extends leagueSettings.LeagueSettingsStore {
          constructor(path) { super(path, () => now); }
        },
      };
      if (name === "./league-commands") return leagueCommands;
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: { PARTICIPANT_ROLE_ID: roleId, CLIENT_ID: "test", DISCORD_TOKEN: "test" } },
    console: { log() {}, error(...args) { errors.push(args); } },
  });
  const listener = client.listeners(discord.Events.InteractionCreate)[0];
  const handle = (interaction) => {
    interaction.isAutocomplete ||= () => false;
    return listener(interaction);
  };
  assert.equal(registeredCommands.find((command) => command.name === "liga").default_member_permissions,
    discord.PermissionFlagsBits.ManageGuild.toString());
  assert.equal(registeredCommands.find((command) => command.name === "suchen").options[1].autocomplete, true);
  client.emit(discord.Events.ClientReady);

  const command = {
    guild, commandName: "report", isChatInputCommand: () => true, isModalSubmit: () => false,
    async reply(payload) { this.response = payload; },
    async showModal(modal) { this.modal = modal.toJSON(); },
  };
  await handle(command);
  assert.match(command.response.content, /wird noch geladen/);
  assert.ok(command.response.flags.includes(discord.MessageFlags.Ephemeral));
  assert.equal(loads, 1, "Concurrent reports must share the initial member load");

  finishLoading();
  await new Promise(setImmediate);
  await handle(command);
  assert.equal(command.modal.custom_id, "submit_report:3");
  assert.equal(loads, 1, "Opening the modal must use the live member cache");

  function submission(season = 3, matchday = "7") {
    return {
      guild, customId: `submit_report:${season}`, isChatInputCommand: () => false, isModalSubmit: () => true,
      channelId,
      fields: new discord.ModalSubmitFields([
        { component: { type: discord.ComponentType.StringSelect, customId: "matchday", values: [matchday] } },
        { component: { type: discord.ComponentType.StringSelect, customId: "winner", values: [janId] } },
        { component: { type: discord.ComponentType.StringSelect, customId: "loser", values: [maxId] } },
        { component: { type: discord.ComponentType.TextInput, customId: "score", value: "2-0" } },
        { component: { type: discord.ComponentType.TextInput, customId: "link", value: "https://example.org/replay" } },
      ]),
      channel: { async send(message) {
        posts.push(message);
        return { id: String(500000000000000000n + BigInt(posts.length)) };
      } },
      async deferReply(payload) {
        sequence.push("defer");
        assert.ok(payload.flags.includes(discord.MessageFlags.Ephemeral));
        this.deferred = true;
      },
      async editReply(payload) { this.response = payload; },
    };
  }
  const valid = submission();
  await handle(valid);
  assert.deepEqual(sequence, ["defer", "fetch", "fetch"]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].embeds[0].toJSON().fields[0].value, /^\|\| .+ \|\|$/);
  assert.match(valid.response.content, /erfolgreich/);
  assert.equal(posts[0].embeds[0].toJSON().author.name, "Season 3 · Spieltag 7");
  const archivePath = join(directory, "matches.json");
  assert.equal(new MatchStore(archivePath).list(guild.id).length, 1);
  const duplicate = submission();
  await handle(duplicate);
  assert.equal(posts.length, 1, "Repeated submissions must not create a second public post");
  assert.match(duplicate.response.content, /bereits gepostet/);
  assert.match(duplicate.response.content, /500000000000000001/);
  assert.equal(new MatchStore(archivePath).list(guild.id).length, 1);

  function adminCommand(subcommand, values = {}, allowed = true) {
    return {
      guild, commandName: "liga", isChatInputCommand: () => true, isModalSubmit: () => false,
      memberPermissions: new discord.PermissionsBitField(allowed ? [discord.PermissionFlagsBits.ManageGuild] : []),
      options: {
        getSubcommand: () => subcommand,
        getInteger: (name) => values[name],
        getString: (name) => values[name],
      },
      async deferReply() { this.deferred = true; },
      async reply(payload) { this.response = payload; },
      async editReply(payload) { this.response = payload; },
    };
  }
  const denied = adminCommand("season", { nummer: 4, spieltage: 18, startdatum: "19.10.2026" }, false);
  await handle(denied);
  assert.match(denied.response.content, /Server verwalten/);
  assert.equal(new leagueSettings.LeagueSettingsStore(settingsPath, () => now).get(guild.id).currentMatchday, 7);

  // Sunday 23:59:59 in Germany still uses the old week; Monday advances without a command.
  now = new Date("2026-10-18T21:59:59Z");
  await handle(command);
  assert.equal(command.modal.components[0].component.options.find((option) => option.default).value, "7");
  now = new Date("2026-10-18T22:00:00Z");
  await handle(command);
  const options = command.modal.components.find((label) => label.component.custom_id === "matchday").component.options;
  assert.equal(options.find((option) => option.default).value, "8");

  await handle(submission(3, "2"));
  assert.equal(posts.length, 2);
  assert.equal(posts[1].embeds[0].toJSON().author.name, "Season 3 · Spieltag 2");

  const seasonChange = adminCommand("season", { nummer: 4, spieltage: 18, startdatum: "19.10.2026" });
  await handle(seasonChange);
  assert.match(seasonChange.response.content, /Season 4 · Spieltag 1 von 18/);
  assert.match(seasonChange.response.content, /Start: 19\.10\.2026/);
  const oldSeason = submission(3, "7");
  await handle(oldSeason);
  assert.equal(posts.length, 2);
  assert.match(oldSeason.response.content, /Season wurde inzwischen geändert/);

  const status = adminCommand("status");
  await handle(status);
  assert.match(status.response.content, /Season 4 · Spieltag 1 von 18/);

  members.get(maxId).roles.cache.delete(roleId);
  const stale = submission(4);
  await handle(stale);
  assert.equal(posts.length, 2, "A removed participant must not produce a public post");
  assert.match(stale.response.content, /nicht mehr Teilnehmer/);

  // Historical searches are independent of the current season and participant roles.
  const directMessages = [];
  const search = {
    guild, member: {}, commandName: "suchen", isChatInputCommand: () => true, isModalSubmit: () => false,
    user: { id: janId, async send(payload) { directMessages.push(payload); } },
    options: {
      getInteger: (name) => name === "season" ? 3 : null,
      getString: () => maxId,
    },
    async deferReply(payload) {
      assert.ok(payload.flags.includes(discord.MessageFlags.Ephemeral));
      this.deferred = true;
    },
    async editReply(payload) { this.response = payload; },
  };
  await handle(search);
  assert.equal((directMessages[0].content.match(/example.org\/replay/g) || []).length, 2);
  assert.match(directMessages[0].content, /Jan vs\. Max/);
  assert.ok(!directMessages[0].content.includes("2-0"));
  assert.match(search.response.content, /2 Replays per DM geschickt/);
  const autocomplete = {
    ...search, isChatInputCommand: () => false, isAutocomplete: () => true,
    options: { getInteger: () => 3, getFocused: () => ({ name: "name", value: "ma" }) },
    async respond(choices) { this.choices = choices; },
  };
  await handle(autocomplete);
  assert.deepEqual(autocomplete.choices, [{ name: "Max", value: maxId }]);

  members.get(maxId).roles.cache.set(roleId, {});
  const invalidLink = submission(4);
  invalidLink.fields.fields.get("link").value = "kein-link";
  await handle(invalidLink);
  assert.equal(posts.length, 2);
  assert.match(invalidLink.response.content, /gültigen Replay-Link/);

  failSaving = true;
  const unsaved = submission(4);
  await handle(unsaved);
  assert.match(unsaved.response.content, /Replay konnte nicht gespeichert/);
  assert.equal(posts.length, 2, "A storage failure must not produce a public result");
  assert.equal(new MatchStore(archivePath).list(guild.id).length, 2);
  failSaving = false;

  const failedPost = submission(4);
  failedPost.channel.send = async () => { throw Object.assign(new Error("Missing Permissions"), { status: 403, code: 50013 }); };
  await handle(failedPost);
  assert.match(failedPost.response.content, /Replay ist für \/suchen gespeichert/);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /Fehler beim Posten/);
  assert.equal(new MatchStore(archivePath).list(guild.id).length, 3);
  await handle(submission(4));
  assert.equal(new MatchStore(archivePath).list(guild.id).length, 3, "Retrying a failed public post must not duplicate search results");
  assert.equal(posts.length, 3);
  await handle(submission(4));
  assert.equal(posts.length, 3, "A successful retry must be protected from subsequent duplicate posts");
});
