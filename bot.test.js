const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const {
  Collection,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  PermissionsBitField,
} = require("discord.js");
const { startBot } = require("./bot");
const { prepareStartup } = require("./startup");

const TOKEN = "offline-test-token-never-log";
const CLIENT = "600000000000000001",
  ROLE = "100000000000000001";
const GUILD = "300000000000000001",
  USER = "200000000000000001";

function directory(t, beforeRemoval = async () => {}) {
  const path = fs.mkdtempSync(join(tmpdir(), "liga-bot-test-"));
  t.after(async () => {
    await beforeRemoval();
    assert.equal(dirname(path), tmpdir());
    fs.rmSync(path, { recursive: true, force: true });
  });
  return path;
}

function fixture(t, { failAt, cleanupFails = false } = {}) {
  let state,
    ready = false,
    closeCalls = 0,
    destroyCalls = 0,
    running;
  const dataDirectory = directory(t, async () => {
    if (!running) return;
    clearInterval(running.backupTimer);
    await running.client.destroy();
    running.database.close();
  });
  const calls = [],
    logs = [];
  const failure = new Error(TOKEN);
  const client = new EventEmitter();
  client.guilds = { cache: new Collection() };
  client.user = { id: CLIENT };
  client.login = async (token) => {
    assert.equal(token, TOKEN);
    calls.push("login");
    if (failAt === "login") throw failure;
    ready = true;
    client.emit(Events.ClientReady);
  };
  client.destroy = async () => {
    destroyCalls++;
    calls.push("destroy");
    if (cleanupFails) throw new Error(TOKEN);
  };
  const options = {
    env: {
      DISCORD_TOKEN: TOKEN,
      CLIENT_ID: CLIENT,
      PARTICIPANT_ROLE_ID: ROLE,
      DATA_DIR: dataDirectory,
    },
    logger: {
      log(message) {
        logs.push(message);
      },
      error(message) {
        logs.push(message);
      },
    },
    prepare(env) {
      calls.push("prepare");
      state = prepareStartup(env);
      const close = state.database.close.bind(state.database);
      state.database.close = () => {
        closeCalls++;
        calls.push("close");
        close();
        if (cleanupFails) throw new Error(TOKEN);
      };
      return state;
    },
    createClient(options) {
      calls.push("client");
      assert.deepEqual(options.intents, [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]);
      if (failAt === "client") throw failure;
      return client;
    },
    createRest(options) {
      calls.push("rest");
      assert.deepEqual(options, { version: "10", timeout: 15_000, retries: 1 });
      if (failAt === "rest") throw failure;
      return {
        setToken(token) {
          assert.equal(token, TOKEN);
          return this;
        },
        async put(route, { body }) {
          calls.push("register");
          assert.deepEqual(
            body.map((command) => command.name),
            ["report", "liga", "suchen", "report-entfernen"],
          );
          assert.equal(client.listenerCount(Events.InteractionCreate), 1);
          if (failAt === "register") throw failure;
        },
        clearHashSweeper() {},
        clearHandlerSweeper() {},
      };
    },
    scheduleBackups(backups, logger) {
      calls.push("backups");
      assert.ok(ready, "Backups must not run before Discord is ready");
      assert.equal(logger, options.logger);
      assert.equal(backups.filePath, state.databasePath);
      if (failAt === "backups") throw failure;
    },
  };
  return {
    options,
    calls,
    logs,
    failure,
    client,
    get state() {
      return state;
    },
    get closeCalls() {
      return closeCalls;
    },
    get destroyCalls() {
      return destroyCalls;
    },
    async start() {
      running = await startBot(options);
      return running;
    },
  };
}

test("importing the entry point and bot modules does not load .env, create storage or start Discord", (t) => {
  const path = directory(t);
  fs.writeFileSync(
    join(path, ".env"),
    "DISCORD_TOKEN=must-not-be-loaded\nLIGA_IMPORT_SENTINEL=must-not-be-loaded\n",
  );
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    for (const name of ['index', 'bot', 'interactions', 'report-handler']) require(${JSON.stringify(__dirname)} + '/' + name);
    assert.equal(process.env.DISCORD_TOKEN, '');
    assert.equal(process.env.LIGA_IMPORT_SENTINEL, undefined);
    assert.equal(fs.existsSync('data'), false);
    console.log('import-only');
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      DISCORD_TOKEN: "",
      CLIENT_ID: "",
      PARTICIPANT_ROLE_ID: "",
      LEAGUE_MANAGER_ROLE_ID: "",
      LIGA_IMPORT_SENTINEL: undefined,
      DATA_DIR: join(path, "data"),
      RAILWAY_ENVIRONMENT_ID: "",
      RAILWAY_VOLUME_MOUNT_PATH: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "import-only");
  assert.deepEqual(fs.readdirSync(path), [".env"]);
});

test("starting the exported bot validates storage, registers before login and schedules backups only after readiness", async (t) => {
  const f = fixture(t);
  const running = await f.start();
  assert.deepEqual(f.calls, ["prepare", "client", "rest", "register", "login", "backups"]);
  assert.equal(running.client, f.client);
  assert.equal(running.database, f.state.database);
  assert.equal(running.matchStore, f.state.matchStore);
  assert.equal(f.closeCalls, 0);
  assert.equal(f.destroyCalls, 0);
  assert.ok(f.logs.every((message) => !message.includes(TOKEN)));
});

test("invalid configuration stops the exported bot before constructing Discord clients or creating storage", async (t) => {
  const path = join(directory(t), "uncreated");
  const initialExitCode = process.exitCode;
  await assert.rejects(
    startBot({
      env: { DISCORD_TOKEN: "", DATA_DIR: path },
      createClient() {
        assert.fail("Client must not be constructed");
      },
      createRest() {
        assert.fail("REST must not be constructed");
      },
      scheduleBackups() {
        assert.fail("Backups must not start");
      },
    }),
    /DISCORD_TOKEN/,
  );
  assert.equal(fs.existsSync(path), false);
  assert.equal(process.exitCode, initialExitCode);
});

test("failures at each startup stage close owned resources and reject without exiting the process", async (t) => {
  const initialExitCode = process.exitCode;
  for (const failAt of ["client", "rest", "register", "login", "backups"]) {
    const f = fixture(t, { failAt });
    await assert.rejects(f.start(), (error) => {
      assert.ok(error === f.failure || error.cause === f.failure);
      return true;
    });
    assert.equal(f.closeCalls, 1, failAt);
    assert.equal(f.destroyCalls, failAt === "client" ? 0 : 1, failAt);
    assert.equal(f.calls.includes("backups"), failAt === "backups");
    assert.throws(() => f.state.database.readMatches(), /closed|not open/i);
    assert.equal(process.exitCode, initialExitCode);
    assert.ok(f.logs.every((message) => !message.includes(TOKEN)));
  }
});

test("cleanup failures cannot hide the original startup error or print credentials", async (t) => {
  const f = fixture(t, { failAt: "rest", cleanupFails: true });
  await assert.rejects(f.start(), (error) => error === f.failure);
  assert.equal(f.closeCalls, 1);
  assert.equal(f.destroyCalls, 1);
  assert.ok(f.logs.some((message) => message.includes("Datenbank konnte")));
  assert.ok(f.logs.some((message) => message.includes("Discord-Verbindung konnte")));
  assert.ok(f.logs.every((message) => !message.includes(TOKEN)));
});

test("two exported bot instances retain separate clients, settings and interaction handlers", async (t) => {
  const first = fixture(t),
    second = fixture(t);
  const [one, two] = await Promise.all([first.start(), second.start()]);
  one.settingsStore.setSeason(GUILD, 4, 10, "19.10.2026");
  two.settingsStore.setSeason(GUILD, 5, 9, "19.10.2026");
  const status = () => {
    const member = {
      id: USER,
      permissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
      roles: { cache: new Collection([[ROLE, {}]]) },
    };
    return {
      user: { id: USER },
      member,
      guild: {
        id: GUILD,
        members: {
          async fetch() {
            return member;
          },
        },
      },
      commandName: "liga",
      options: { getSubcommand: () => "status" },
      isChatInputCommand: () => true,
      isModalSubmit: () => false,
      isAutocomplete: () => false,
      async deferReply() {
        this.deferred = true;
      },
      async editReply(payload) {
        this.response = payload;
      },
    };
  };
  const firstStatus = status(),
    secondStatus = status();
  await first.client.listeners(Events.InteractionCreate)[0](firstStatus);
  await second.client.listeners(Events.InteractionCreate)[0](secondStatus);
  assert.match(firstStatus.response.content, /Season 4/);
  assert.match(secondStatus.response.content, /Season 5/);
  assert.notEqual(one.databasePath, two.databasePath);
  assert.notEqual(one.database, two.database);
});
