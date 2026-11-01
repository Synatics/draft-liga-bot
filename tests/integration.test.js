const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const discord = require("discord.js");
const leagueSettings = require("../src/storage/league-settings");
const { MatchStore } = require("../src/storage/match-store");
const { startBot } = require("../src/app/bot");
const { prepareStartup } = require("../src/app/startup");
const { configureSeason } = require("./helpers/season-setup");
const { planToken } = require("../src/league/season-rounds");

test("league settings, reports and role changes work together without exposing results", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pokemon-liga-index-test-"));
  let runtimeState;
  t.after(async () => {
    if (runtimeState) {
      clearInterval(runtimeState.backupTimer);
      await runtimeState.client.destroy();
      runtimeState.database.close();
    }
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  });
  const settingsPath = join(directory, "league-settings.json");
  let now = new Date("2026-10-18T12:00:00Z");
  const initialStore = new leagueSettings.LeagueSettingsStore(settingsPath, () => now);
  const roleId = "100000000000000001";
  const managerRoleId = "100000000000000002";
  const janId = "200000000000000001";
  const maxId = "200000000000000002";
  const friendId = "200000000000000003";
  const adminId = "200000000000000004";
  const channelId = "400000000000000001";
  const members = new discord.Collection(
    [janId, maxId].map((id, i) => [
      id,
      {
        id,
        displayName: ["Jan", "Max"][i],
        user: { bot: false },
        permissions: new discord.PermissionsBitField(),
        roles: { cache: new discord.Collection([[roleId, {}]]) },
      },
    ]),
  );
  members.set(friendId, {
    id: friendId,
    displayName: "Freund",
    user: { bot: false },
    permissions: new discord.PermissionsBitField(),
    roles: { cache: new discord.Collection() },
  });
  members.set(adminId, {
    id: adminId,
    displayName: "Admin",
    user: { bot: false },
    permissions: new discord.PermissionsBitField([discord.PermissionFlagsBits.ManageGuild]),
    roles: { cache: new discord.Collection([[managerRoleId, {}]]) },
  });
  const sequence = [];
  const posts = [];
  const publicMessages = new Map();
  const botId = "600000000000000001";
  let finishLoading;
  let loads = 0;
  const loading = new Promise((resolve) => {
    finishLoading = resolve;
  });
  const guild = {
    id: "300000000000000001",
    roles: {
      cache: new discord.Collection([
        [roleId, {}],
        [managerRoleId, {}],
      ]),
    },
    channels: {
      cache: new discord.Collection([
        [
          channelId,
          {
            id: channelId,
            guildId: "300000000000000001",
            messages: {
              async fetch({ message }) {
                if (!publicMessages.has(message))
                  throw Object.assign(new Error("Unknown Message"), { code: 10008, status: 404 });
                return publicMessages.get(message);
              },
            },
            permissionsFor: () =>
              new discord.PermissionsBitField([
                discord.PermissionFlagsBits.ViewChannel,
                discord.PermissionFlagsBits.ReadMessageHistory,
              ]),
          },
        ],
      ]),
    },
    members: {
      cache: members,
      async fetch(options) {
        if (!options.user) {
          loads++;
          await loading;
          return members;
        }
        sequence.push("fetch");
        assert.equal(options.force, true);
        return members.get(options.user);
      },
    },
  };
  guild.channels.fetch = async (id) => guild.channels.cache.get(id);
  initialStore.setSeason(guild.id, 3, 9, "31.08.2026");
  const client = new EventEmitter();
  client.guilds = { cache: new discord.Collection([[guild.id, guild]]) };
  client.user = { id: botId };
  client.login = async () => {
    client.emit(discord.Events.ClientReady);
  };
  client.destroy = async () => {};
  let registeredCommands;
  let failSaving = false;
  const errors = [];

  // Start the real bot with temporary SQLite storage and an offline Discord client.
  runtimeState = await startBot({
    env: {
      PARTICIPANT_ROLE_ID: roleId,
      LEAGUE_MANAGER_ROLE_ID: managerRoleId,
      CLIENT_ID: "600000000000000001",
      DISCORD_TOKEN: "test-token",
      DATA_DIR: directory,
    },
    logger: {
      log() {},
      error(...args) {
        errors.push(args);
      },
    },
    prepare(env) {
      const state = prepareStartup(env);
      state.settingsStore.now = () => now;
      const save = state.database.saveMatches.bind(state.database);
      state.database.saveMatches = (matches, event) => {
        if (failSaving)
          throw Object.assign(new Error("write failed: private-request-data"), { code: "ENOSPC" });
        save(matches, event);
      };
      return state;
    },
    createClient(options) {
      assert.ok(options.intents.includes(discord.GatewayIntentBits.GuildMembers));
      return client;
    },
    createRest() {
      return {
        setToken() {
          return this;
        },
        async put(route, { body }) {
          registeredCommands = body;
        },
        clearHashSweeper() {},
        clearHandlerSweeper() {},
      };
    },
  });
  assert.equal(errors.length, 0);
  const listener = client.listeners(discord.Events.InteractionCreate)[0];
  const handle = (interaction) => {
    interaction.isAutocomplete ||= () => false;
    return listener(interaction);
  };
  assert.equal(
    registeredCommands.find((command) => command.name === "liga").default_member_permissions,
    undefined,
  );
  assert.equal(
    registeredCommands
      .find((command) => command.name === "liga")
      .options.find((option) => option.name === "log").options[0].required,
    true,
  );
  assert.equal(
    registeredCommands.find((command) => command.name === "suchen").options[1].autocomplete,
    true,
  );
  assert.equal(
    registeredCommands.find((command) => command.name === "report-entfernen").options[1]
      .autocomplete,
    true,
  );
  assert.equal(
    registeredCommands.filter((command) => command.type === discord.ApplicationCommandType.Message)
      .length,
    0,
  );

  const command = {
    guild,
    commandName: "report",
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    user: { id: janId },
    member: members.get(janId),
    async reply(payload) {
      this.response = payload;
    },
    async showModal(modal) {
      this.modal = modal.toJSON();
    },
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

  function submission(season = 3, matchday = "7", score = "2-0") {
    const active = runtimeState.settingsStore.get(guild.id);
    const planned = active.season === season && active.rounds;
    return {
      guild,
      customId: `submit_report:${season}${planned ? `:${planToken(active)}` : ""}`,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      user: { id: janId },
      member: members.get(janId),
      channelId,
      fields: new discord.ModalSubmitFields([
        {
          component: {
            type: discord.ComponentType.StringSelect,
            customId: planned ? "round" : "matchday",
            values: [planned ? `matchday-${matchday}` : matchday],
          },
        },
        {
          component: {
            type: discord.ComponentType.StringSelect,
            customId: "winner",
            values: [janId],
          },
        },
        {
          component: {
            type: discord.ComponentType.StringSelect,
            customId: "loser",
            values: [maxId],
          },
        },
        { component: { type: discord.ComponentType.TextInput, customId: "score", value: score } },
        {
          component: {
            type: discord.ComponentType.TextInput,
            customId: "link",
            value: "https://example.org/replay",
          },
        },
      ]),
      channel: {
        async send(message) {
          posts.push(message);
          const id = String(500000000000000000n + BigInt(posts.length));
          const post = {
            id,
            author: { id: botId },
            embeds: message.embeds.map((embed) => embed.toJSON()),
            async edit(payload) {
              this.embeds = payload.embeds;
            },
            async delete() {
              publicMessages.delete(id);
            },
          };
          publicMessages.set(id, post);
          return post;
        },
      },
      async deferReply(payload) {
        sequence.push("defer");
        assert.ok(payload.flags.includes(discord.MessageFlags.Ephemeral));
        this.deferred = true;
      },
      async reply(payload) {
        this.response = payload;
      },
      async editReply(payload) {
        this.response = payload;
      },
    };
  }
  const valid = submission();
  await handle(valid);
  assert.deepEqual(sequence, ["defer", "fetch", "fetch", "fetch"]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].embeds[0].toJSON().fields[0].value, /^\|\| .+ \|\|$/);
  assert.match(valid.response.content, /erfolgreich/);
  assert.equal(posts[0].embeds[0].toJSON().author.name, "Season 3 · Spieltag 7");
  const stored = () =>
    new MatchStore(runtimeState.databasePath, runtimeState.database).list(guild.id);
  assert.equal(stored().length, 1);
  const duplicate = submission();
  await handle(duplicate);
  assert.equal(posts.length, 1, "Repeated submissions must not create a second public post");
  assert.match(duplicate.response.content, /bereits gepostet/);
  assert.match(duplicate.response.content, /500000000000000001/);
  assert.equal(stored().length, 1);

  await t.test(
    "empty, whitespace-only and oversized scores cannot create a post, archive record or log entry",
    async () => {
      const before = stored();
      const eventsBefore = runtimeState.database.auditEvents(guild.id, 3);
      const postsBefore = posts.length;
      for (const score of ["", " ", "\t\n\u00a0\u2003", "x".repeat(101)]) {
        const invalid = submission(3, "8", score);
        await handle(invalid);
        assert.match(invalid.response.content, /Ergebnis mit 1 bis 100 Zeichen/);
        assert.equal(invalid.deferred, true);
      }
      assert.equal(posts.length, postsBefore);
      assert.deepEqual(stored(), before);
      assert.deepEqual(runtimeState.database.auditEvents(guild.id, 3), eventsBefore);
      assert.equal(errors.length, 0, "Invalid scores are input errors, not technical failures");
    },
  );

  function adminCommand(subcommand, values = {}, allowed = true) {
    return {
      guild,
      commandName: "liga",
      isChatInputCommand: () => true,
      isModalSubmit: () => false,
      user: { id: allowed ? adminId : janId },
      member: members.get(allowed ? adminId : janId),
      memberPermissions: new discord.PermissionsBitField(
        allowed ? [discord.PermissionFlagsBits.ManageGuild] : [],
      ),
      options: {
        getSubcommand: () => subcommand,
        getInteger: (name) => values[name],
        getString: (name) => values[name],
      },
      async deferReply() {
        this.deferred = true;
      },
      async reply(payload) {
        this.response = payload;
      },
      async editReply(payload) {
        this.response = payload;
      },
    };
  }
  const denied = adminCommand(
    "season",
    { nummer: 4, spieltage: 18, startdatum: "19.10.2026" },
    false,
  );
  await handle(denied);
  assert.match(denied.response.content, /Ligaverwaltungsrolle/);
  assert.equal(
    new leagueSettings.LeagueSettingsStore(
      runtimeState.databasePath,
      () => now,
      runtimeState.database,
    ).get(guild.id).currentMatchday,
    7,
  );

  // Sunday 23:59:59 in Germany still uses the old week; Monday advances without a command.
  now = new Date("2026-10-18T21:59:59Z");
  await handle(command);
  assert.equal(
    command.modal.components[0].component.options.find((option) => option.default).value,
    "7",
  );
  now = new Date("2026-10-18T22:00:00Z");
  await handle(command);
  const options = command.modal.components.find((label) => label.component.custom_id === "matchday")
    .component.options;
  assert.equal(options.find((option) => option.default).value, "8");

  await handle(submission(3, "2"));
  assert.equal(posts.length, 2);
  assert.equal(posts[1].embeds[0].toJSON().author.name, "Season 3 · Spieltag 2");

  const seasonChange = await configureSeason({
    handle,
    interaction(changes) {
      return Object.assign(
        adminCommand("season"),
        {
          isChatInputCommand: () => false,
          isModalSubmit: () => false,
          async showModal(modal) {
            this.modal = modal.toJSON();
          },
          async deferUpdate() {
            this.deferred = true;
          },
        },
        changes,
      );
    },
    values: { nummer: 4, spieltage: 18, startdatum: "19.10.2026" },
  });
  assert.match(seasonChange.response.content, /Season 4 · Spieltag 1 gespeichert/);
  const oldSeason = submission(3, "7");
  await handle(oldSeason);
  assert.equal(posts.length, 2);
  assert.match(oldSeason.response.content, /Season wurde inzwischen geändert/);

  const status = adminCommand("status");
  await handle(status);
  assert.match(status.response.content, /Season 4 · Spieltag 1/);
  assert.match(status.response.content, /18 reguläre Spieltage/);

  members.get(maxId).roles.cache.delete(roleId);
  const stale = submission(4);
  await handle(stale);
  assert.equal(posts.length, 2, "A removed participant must not produce a public post");
  assert.match(stale.response.content, /nicht mehr Teilnehmer/);

  // Historical searches are independent of the current season and participant roles.
  const directMessages = [];
  const search = {
    guild,
    member: {},
    commandName: "suchen",
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    user: {
      id: janId,
      async send(payload) {
        directMessages.push(payload);
      },
    },
    options: {
      getInteger: (name) => (name === "season" ? 3 : null),
      getString: () => maxId,
    },
    async deferReply(payload) {
      assert.ok(payload.flags.includes(discord.MessageFlags.Ephemeral));
      this.deferred = true;
    },
    async editReply(payload) {
      this.response = payload;
    },
  };
  await handle(search);
  assert.equal((directMessages[0].content.match(/example.org\/replay/g) || []).length, 2);
  assert.match(directMessages[0].content, /Jan vs\. Max/);
  assert.ok(!directMessages[0].content.includes("2-0"));
  assert.match(search.response.content, /2 Replays per DM geschickt/);
  const autocomplete = {
    ...search,
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    options: { getInteger: () => 3, getFocused: () => ({ name: "name", value: "ma" }) },
    async respond(choices) {
      this.choices = choices;
    },
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
  assert.match(unsaved.response.content, /nicht gespeichert/);
  assert.match(errors[0][0], /ENOSPC/);
  assert.match(errors[0][0], new RegExp(guild.id));
  assert.match(errors[0][0], new RegExp(channelId));
  assert.ok(!errors[0][0].includes("private-request-data"));
  assert.ok(!unsaved.response.content.includes("ENOSPC"));
  assert.equal(posts.length, 2, "A storage failure must not produce a public result");
  assert.equal(stored().length, 2);
  failSaving = false;

  const failedPost = submission(4);
  failedPost.channel.send = async () => {
    throw Object.assign(new Error("Missing Permissions: private-request-data"), {
      status: 403,
      code: 50013,
      requestBody: { token: "private-request-data" },
    });
  };
  await handle(failedPost);
  assert.match(failedPost.response.content, /Replay ist für \/suchen gespeichert/);
  assert.equal(errors.length, 2);
  assert.match(errors[1][0], /Fehler beim Posten/);
  assert.match(errors[1][0], /"discordCode":50013/);
  assert.match(errors[1][0], /"reportId":"[a-f0-9]{24}"/);
  assert.ok(!errors[1][0].includes("private-request-data"));
  assert.equal(stored().length, 3);
  await handle(submission(4));
  assert.equal(
    stored().length,
    3,
    "Retrying a failed public post must not duplicate search results",
  );
  assert.equal(posts.length, 3);
  await handle(submission(4));
  assert.equal(
    posts.length,
    3,
    "A successful retry must be protected from subsequent duplicate posts",
  );

  const management = {
    guild,
    channel: guild.channels.cache.get(channelId),
    channelId,
    client,
    user: { id: janId },
    member: members.get(janId),
    memberPermissions: new discord.PermissionsBitField([]),
    message: publicMessages.get("500000000000000001"),
    customId: posts[0].components[0].toJSON().components[0].custom_id,
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
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
    async editReply(payload) {
      this.response = payload;
    },
  };
  await handle(management);
  assert.match(management.modal.title, /Report korrigieren · Season 3/);
  assert.equal(management.modal.components.length, 5);
  const correction = {
    ...management,
    isButton: () => false,
    isModalSubmit: () => true,
    customId: management.modal.custom_id,
    fields: {
      getTextInputValue: (name) => ({ score: "1-0", link: "https://example.org/corrected" })[name],
      getStringSelectValues: (name) => [
        name === "matchday" ? "3" : name === "winner" ? maxId : janId,
      ],
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      this.response = payload;
    },
  };
  await handle(correction);
  assert.match(correction.response.content, /korrigiert/);
  assert.equal(posts.length, 3, "Correcting a report edits its post instead of sending a new one");
  assert.equal(
    stored().find((match) => match.publication.messageId === "500000000000000001").matchday,
    3,
  );
  const deletion = {
    ...management,
    user: { id: adminId },
    member: members.get(adminId),
    memberPermissions: members.get(adminId).permissions,
    customId: posts[0].components[0].toJSON().components[1].custom_id,
  };
  await handle(deletion);
  const confirmation = {
    ...deletion,
    isButton: () => true,
    customId: deletion.response.components[0].toJSON().components[0].custom_id,
    async deferUpdate() {
      this.deferred = true;
    },
    async editReply(payload) {
      this.response = payload;
    },
  };
  await handle(confirmation);
  assert.match(confirmation.response.content, /entfernt/);
  assert.equal(publicMessages.has("500000000000000001"), false);
  assert.equal(stored().length, 2);
  // The slash fallback discovers a manually deleted post without its message link.
  publicMessages.delete("500000000000000002");
  const removalAutocomplete = {
    ...autocomplete,
    commandName: "report-entfernen",
    user: deletion.user,
    member: deletion.member,
    memberPermissions: deletion.memberPermissions,
  };
  await handle(removalAutocomplete);
  assert.deepEqual(removalAutocomplete.choices, [{ name: "Max", value: maxId }]);
  const removal = {
    ...search,
    user: deletion.user,
    member: deletion.member,
    commandName: "report-entfernen",
    memberPermissions: deletion.memberPermissions,
    options: { getInteger: (name) => (name === "season" ? 3 : 2), getString: () => janId },
  };
  await handle(removal);
  assert.match(removal.response.content, /Season 3 · Spieltag 2/);
  const removeMissing = {
    ...confirmation,
    customId: removal.response.components[0].toJSON().components[0].custom_id,
  };
  await handle(removeMissing);
  assert.match(removeMissing.response.content, /entfernt/);
  assert.equal(stored().length, 1);
  const logDms = [];
  const log = {
    ...search,
    commandName: "liga",
    member: members.get(janId),
    user: {
      id: janId,
      async send(payload) {
        logDms.push(payload);
      },
    },
    options: { getSubcommand: () => "log", getInteger: () => 3 },
  };
  await handle(log);
  assert.match(log.response.content, /Protokoll für Season 3/);
  assert.match(logDms[0].files[0].attachment.toString("utf8"), /GELÖSCHT/);
  const failedSuggestions = {
    ...removalAutocomplete,
    options: {
      getInteger: () => 4,
      getFocused() {
        throw new Error("Autocomplete unavailable");
      },
    },
  };
  await handle(failedSuggestions);
  assert.equal(failedSuggestions.choices.length, 0);
  assert.match(errors.at(-1)[0], /Suchvorschlägen/);

  const friend = members.get(friendId);
  const friendCommand = {
    ...command,
    modal: undefined,
    response: undefined,
    user: { id: friendId },
    member: friend,
  };
  const friendSubmission = () => {
    const request = { ...submission(4, "4"), user: { id: friendId }, member: friend };
    request.fields.fields.get("link").value = "https://example.org/friend";
    return request;
  };
  const countBefore = stored().length;
  const postsBefore = posts.length;
  await t.test("a member without either league role cannot open or submit a report", async () => {
    await handle(friendCommand);
    assert.equal(friendCommand.modal, undefined);
    assert.match(friendCommand.response.content, /Nur Teilnehmer/);
    assert.ok(friendCommand.response.flags.includes(discord.MessageFlags.Ephemeral));
    const deniedSubmission = friendSubmission();
    await handle(deniedSubmission);
    assert.match(deniedSubmission.response.content, /Nur Teilnehmer/);
    assert.equal(stored().length, countBefore);
    assert.equal(posts.length, postsBefore);
  });

  await t.test("server permissions alone cannot authorize report creation", async () => {
    for (const permission of [
      discord.PermissionFlagsBits.ManageGuild,
      discord.PermissionFlagsBits.Administrator,
    ]) {
      friend.permissions = new discord.PermissionsBitField([permission]);
      const request = friendSubmission();
      await handle(request);
      assert.match(request.response.content, /Nur Teilnehmer/);
      assert.equal(stored().length, countBefore);
      assert.equal(posts.length, postsBefore);
    }
    friend.permissions = new discord.PermissionsBitField();
  });

  await t.test(
    "revoked channel access prevents reports even while the participant role remains",
    async () => {
      friend.roles.cache.set(roleId, {});
      const fetchChannel = guild.channels.fetch;
      guild.channels.fetch = async (id) => ({
        ...(await fetchChannel(id)),
        permissionsFor: () => new discord.PermissionsBitField(),
      });
      try {
        const request = friendSubmission();
        await handle(request);
        assert.match(request.response.content, /keinen Zugriff mehr/);
        assert.equal(stored().length, countBefore);
        assert.equal(posts.length, postsBefore);
      } finally {
        guild.channels.fetch = fetchChannel;
        friend.roles.cache.clear();
      }
    },
  );

  await t.test(
    "revoking a role while a report is open prevents publication and archive writes",
    async () => {
      friend.roles.cache.set(roleId, {});
      await handle(friendCommand);
      assert.ok(friendCommand.modal);
      const staleMember = {
        ...friend,
        roles: { cache: new discord.Collection(friend.roles.cache) },
      };
      const request = { ...friendSubmission(), member: staleMember };
      friend.roles.cache.clear();
      await handle(request);
      assert.match(request.response.content, /inzwischen entzogen/);
      assert.equal(stored().length, countBefore);
      assert.equal(posts.length, postsBefore);
    },
  );

  await t.test(
    "a participant with no Discord permissions can report and edit their own post but cannot delete it",
    async () => {
      friend.roles.cache.set(roleId, {});
      const request = friendSubmission();
      await handle(request);
      assert.match(request.response.content, /erfolgreich/);
      const record = stored().find((entry) => entry.reporter?.id === friendId);
      assert.ok(record);
      const button = {
        ...management,
        user: { id: friendId },
        member: friend,
        message: publicMessages.get(record.publication.messageId),
        customId: `report:edit:${record.id}`,
      };
      await handle(button);
      assert.ok(button.modal);
      const edit = {
        ...correction,
        ...button,
        isButton: () => false,
        isModalSubmit: () => true,
        customId: button.modal.custom_id,
        fields: {
          getStringSelectValues: (name) => [
            name === "round"
              ? "matchday-4"
              : name === "matchday"
                ? "4"
                : name === "winner"
                  ? janId
                  : maxId,
          ],
          getTextInputValue: (name) => (name === "score" ? "1-0" : record.link),
        },
      };
      await handle(edit);
      assert.match(edit.response.content, /korrigiert/);
      const current = runtimeState.matchStore.get(record.id, guild.id);
      const forged = `manage:delete:${record.id}:${require("../src/storage/match-store").revisionOf(current)}:${friendId}`;
      for (const customId of [`report:delete:${record.id}`, forged]) {
        const denied = { ...confirmation, ...button, customId };
        await handle(denied);
        assert.match(denied.response.content, /Nur die Ligaverwaltung/);
        assert.ok(publicMessages.has(record.publication.messageId));
        assert.ok(runtimeState.matchStore.get(record.id, guild.id));
      }
    },
  );

  await t.test(
    "a separate management role can delete without Discord privileges; revoked roles fail at confirmation",
    async () => {
      const record = stored().find((entry) => entry.reporter?.id === friendId);
      friend.roles.cache.clear();
      friend.roles.cache.set(managerRoleId, {});
      const button = {
        ...management,
        user: { id: friendId },
        member: friend,
        message: publicMessages.get(record.publication.messageId),
        customId: `report:delete:${record.id}`,
      };
      await handle(button);
      assert.match(button.response.content, /wirklich löschen/);
      const staleMember = {
        ...friend,
        roles: { cache: new discord.Collection(friend.roles.cache) },
      };
      const confirm = {
        ...confirmation,
        ...button,
        member: staleMember,
        customId: button.response.components[0].toJSON().components[0].custom_id,
      };
      friend.roles.cache.clear();
      await handle(confirm);
      assert.match(confirm.response.content, /Nur die Ligaverwaltung/);
      assert.ok(publicMessages.has(record.publication.messageId));
      friend.roles.cache.set(managerRoleId, {});
      await handle({ ...confirm, member: friend });
      assert.equal(publicMessages.has(record.publication.messageId), false);
      assert.equal(stored().length, countBefore);
    },
  );
});
