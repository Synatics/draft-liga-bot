const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const { Events, Routes } = require("discord.js");
const { LeagueSettingsStore } = require("./league-settings");
const { MatchStore } = require("./match-store");
const { StartupError, readConfiguration, prepareStartup, connectDiscord, failStartup } = require("./startup");

const TOKEN = "opaque-test-token-never-log-this";
const CLIENT = "600000000000000001";
const ROLE = "100000000000000001";
const environment = (directory, overrides = {}) => ({
  DISCORD_TOKEN: TOKEN, CLIENT_ID: CLIENT, PARTICIPANT_ROLE_ID: ROLE, DATA_DIR: directory, ...overrides,
});
const config = readConfiguration(environment());

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "pokemon-liga-startup-test-"));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function fakeDiscord({ registrationError, loginError, ready = true } = {}) {
  const client = new EventEmitter();
  const calls = [], logs = [];
  let signal;
  client.login = async (token) => {
    assert.equal(token, TOKEN);
    calls.push("login");
    if (loginError) throw loginError;
    if (ready) client.emit(Events.ClientReady);
    return token;
  };
  const rest = {
    async put(route, options) {
      calls.push("register");
      assert.equal(route, Routes.applicationCommands(CLIENT));
      assert.deepEqual(options.body, [{ name: "report" }]);
      signal = options.signal;
      if (registrationError) throw registrationError;
    },
    clearHashSweeper() { calls.push("clear-hashes"); },
    clearHandlerSweeper() { calls.push("clear-handlers"); },
  };
  return { client, rest, calls, logs, get signal() { return signal; },
    options: { logger: { log(message) { logs.push(message); } }, timeoutMs: 1000 } };
}

const connect = (fake, options = {}) => connectDiscord(fake.client, fake.rest, [{ name: "report" }], config,
  { ...fake.options, ...options });

test("configuration reports all missing or invalid required values without revealing any values", () => {
  assert.throws(() => readConfiguration({}), (error) => {
    assert.ok(error instanceof StartupError);
    for (const name of ["DISCORD_TOKEN", "CLIENT_ID", "PARTICIPANT_ROLE_ID"]) assert.ok(error.message.includes(name));
    return true;
  });
  for (const overrides of [
    { DISCORD_TOKEN: "dein-bot-token" }, { DISCORD_TOKEN: "Bot do-not-log-this-secret" },
    { CLIENT_ID: "deine-application-id" }, { CLIENT_ID: "0".repeat(18) },
    { PARTICIPANT_ROLE_ID: "@Teilnehmer" }, { PARTICIPANT_ROLE_ID: "123456789012345678901" }, { DATA_DIR: " " },
  ]) {
    assert.throws(() => readConfiguration(environment(undefined, overrides)), (error) => {
      assert.ok(error instanceof StartupError);
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!error.message.includes("do-not-log-this-secret"));
      return true;
    });
  }
});

test("configuration trims surrounding whitespace and accepts opaque tokens without depending on a token format", () => {
  assert.deepEqual(readConfiguration(environment(undefined, {
    DISCORD_TOKEN: ` ${TOKEN}\n`, CLIENT_ID: ` ${CLIENT} `, PARTICIPANT_ROLE_ID: `\t${ROLE}`,
  })), { token: TOKEN, clientId: CLIENT, participantRoleId: ROLE });
  assert.equal(readConfiguration(environment(undefined, { DISCORD_TOKEN: "future.token-format_123" })).token,
    "future.token-format_123");
});

test("invalid configuration and an invalid Railway volume fail before creating a data directory", (t) => {
  const parent = temporaryDirectory(t);
  const directory = join(parent, "uncreated-data");
  assert.throws(() => prepareStartup(environment(directory, { DISCORD_TOKEN: "" })), /DISCORD_TOKEN/);
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => prepareStartup(environment(directory, { RAILWAY_ENVIRONMENT_ID: "test" })), /Volume/);
  assert.equal(fs.existsSync(directory), false);
});

test("a fresh installation checks storage, leaves no probes and still permits configuring its first season", (t) => {
  const directory = temporaryDirectory(t);
  const state = prepareStartup(environment(directory));
  assert.equal(state.config.participantRoleId, ROLE);
  assert.throws(() => state.settingsStore.get("guild"), /noch nicht eingerichtet/);
  assert.equal(state.matchStore.list("guild").length, 0);
  assert.deepEqual(fs.readdirSync(directory), ["matches.json"]);
  state.settingsStore.setSeason("guild", 4, 9, "19.10.2026");
  assert.equal(new LeagueSettingsStore(state.settingsPath).get("guild").season, 4);
});

test("preflight does not rewrite valid data or discard a damaged existing settings file or archive", (t) => {
  const directory = temporaryDirectory(t);
  const settingsPath = join(directory, "league-settings.json");
  const matchesPath = join(directory, "matches.json");
  new LeagueSettingsStore(settingsPath).setSeason("guild", 4, 9, "19.10.2026");
  new MatchStore(matchesPath);
  const settings = fs.readFileSync(settingsPath, "utf8");
  const matches = fs.readFileSync(matchesPath, "utf8");
  prepareStartup(environment(directory));
  assert.equal(fs.readFileSync(settingsPath, "utf8"), settings);
  assert.equal(fs.readFileSync(matchesPath, "utf8"), matches);
  for (const [path, name] of [[settingsPath, "league-settings.json"], [matchesPath, "matches.json"]]) {
    fs.writeFileSync(path, `broken ${TOKEN}`);
    assert.throws(() => prepareStartup(environment(directory)), (error) => {
      assert.ok(error instanceof StartupError);
      assert.ok(error.message.includes(name));
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
    assert.equal(fs.readFileSync(path, "utf8"), `broken ${TOKEN}`);
    fs.writeFileSync(path, path === settingsPath ? settings : matches);
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), ["league-settings.json", "matches.json"]);
});

test("a file in place of the data directory produces an actionable storage error", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "not-a-directory");
  fs.writeFileSync(path, "must remain unchanged");
  assert.throws(() => prepareStartup(environment(path)), /Datenordner ist nicht beschreibbar/);
  assert.equal(fs.readFileSync(path, "utf8"), "must remain unchanged");
});

test("write and rename failures are detected by preflight and its own temporary file is cleaned up", (t) => {
  const directory = temporaryDirectory(t);
  for (const operation of ["writeFileSync", "renameSync"]) {
    const module = { exports: {} };
    runInNewContext(fs.readFileSync(require.resolve("./startup"), "utf8"), {
      module,
      require(name) {
        return name === "node:fs" ? { ...fs, [operation]() { throw new Error(`disk failure ${TOKEN}`); } } : require(name);
      },
    });
    assert.throws(() => module.exports.verifyDataDirectory(directory), /nicht beschreibbar/);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test("Discord startup registers first, waits for readiness and releases temporary listeners and timers", async () => {
  const fake = fakeDiscord({ ready: false });
  let finished = false;
  const promise = connect(fake).then(() => { finished = true; });
  await new Promise(setImmediate);
  assert.deepEqual(fake.calls, ["register", "login"]);
  assert.equal(finished, false);
  fake.client.emit(Events.ClientReady);
  await promise;
  assert.equal(finished, true);
  assert.equal(fake.signal.aborted, true);
  assert.equal(fake.client.listenerCount(Events.ClientReady), 0);
  assert.equal(fake.client.listenerCount(Events.Error), 0);
  assert.deepEqual(fake.calls.slice(-2), ["clear-hashes", "clear-handlers"]);
  assert.equal(fake.logs.length, 1);
});

test("failed registration never logs in or prints request data or credentials", async () => {
  const fake = fakeDiscord({ registrationError: new Error(`HTTP request Authorization: Bot ${TOKEN}`) });
  await assert.rejects(connect(fake), (error) => {
    assert.ok(error instanceof StartupError);
    assert.match(error.message, /Slash-Befehle.*CLIENT_ID/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.ok(!fake.calls.includes("login"));
  assert.deepEqual(fake.logs, []);
  assert.equal(fake.signal.aborted, true);
});

test("rejected logins and gateway errors identify token or intent issues without exposing raw errors", async () => {
  for (const [error, expected] of [
    [Object.assign(new Error(TOKEN), { code: "TokenInvalid" }), /Token abgelehnt/],
    [Object.assign(new Error(TOKEN), { status: 401 }), /Token abgelehnt/],
    [Object.assign(new Error(TOKEN), { code: 4014 }), /Server Members Intent/],
    [new Error(`Used disallowed intents: ${TOKEN}`), /Server Members Intent/],
    [new Error(`Socket closed: ${TOKEN}`), /Anmeldung ist fehlgeschlagen/],
  ]) {
    const fake = fakeDiscord({ loginError: error });
    await assert.rejects(connect(fake), (failure) => {
      assert.match(failure.message, expected);
      assert.ok(!failure.message.includes(TOKEN));
      return true;
    });
    assert.equal(fake.client.listenerCount(Events.ClientReady), 0);
    assert.equal(fake.client.listenerCount(Events.Error), 0);
  }
  const fake = fakeDiscord({ ready: false });
  const promise = connect(fake);
  await new Promise(setImmediate);
  fake.client.emit(Events.Error, new Error(TOKEN));
  await assert.rejects(promise, /Anmeldung ist fehlgeschlagen/);
});

test("a stalled registration times out and a late response cannot begin a login afterwards", async () => {
  const fake = fakeDiscord();
  let finishRegistration, signal;
  fake.rest.put = (route, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finishRegistration = resolve; });
  };
  await assert.rejects(connect(fake, { timeoutMs: 5 }), /60 Sekunden/);
  assert.equal(signal.aborted, true);
  finishRegistration();
  await new Promise(setImmediate);
  assert.ok(!fake.calls.includes("login"));
  assert.deepEqual(fake.logs, []);
});

test("an unready connection times out even when login resolves, without leaving readiness listeners", async () => {
  const fake = fakeDiscord({ ready: false });
  await assert.rejects(connect(fake, { timeoutMs: 5 }), /60 Sekunden/);
  assert.equal(fake.client.listenerCount(Events.ClientReady), 0);
  assert.equal(fake.client.listenerCount(Events.Error), 0);
});

test("fatal startup errors close the client and exit with code one even when cleanup fails or hangs", async () => {
  for (const mode of ["success", "reject", "hang"]) {
    const logs = [], events = [];
    const runtime = { exit(code) { events.push(["exit", code]); } };
    const client = { destroy() {
      events.push(["destroy"]);
      if (mode === "reject") return Promise.reject(new Error(TOKEN));
      if (mode === "hang") return new Promise(() => {});
      return Promise.resolve();
    } };
    await failStartup(new Error(`request ${TOKEN}`), client, {
      logger: { error(message) { logs.push(message); } }, runtime, timeoutMs: 5,
    });
    assert.equal(runtime.exitCode, 1);
    assert.deepEqual(events, [["destroy"], ["exit", 1]]);
    assert.ok(logs.every((message) => !message.includes(TOKEN)));
    assert.match(logs[0], /Bot-Start abgebrochen/);
  }
});

test("the real entry point exits with code one on invalid config or damaged data before any Discord request", (t) => {
  const directory = temporaryDirectory(t);
  const run = (env) => spawnSync(process.execPath, [require.resolve("./index")], {
    cwd: directory, encoding: "utf8", timeout: 5000,
    env: { ...process.env, RAILWAY_ENVIRONMENT_ID: "", RAILWAY_VOLUME_MOUNT_PATH: "", ...env },
  });
  const missingPath = join(directory, "uncreated");
  const missing = run(environment(missingPath, { DISCORD_TOKEN: "" }));
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /Bot-Start abgebrochen.*DISCORD_TOKEN/);
  assert.ok(!missing.stdout.includes("verbunden"));
  assert.equal(fs.existsSync(missingPath), false);
  fs.writeFileSync(join(directory, "league-settings.json"), `damaged ${TOKEN}`);
  const damaged = run(environment(directory));
  assert.equal(damaged.status, 1, damaged.stderr);
  assert.match(damaged.stderr, /league-settings.json/);
  assert.ok(!damaged.stderr.includes(TOKEN));
  assert.ok(!damaged.stdout.includes("registriert"));
  assert.equal(fs.existsSync(join(directory, "matches.json")), false);
});

test("entry-point registration and login failures stop the client without starting backups", { timeout: 3000 }, async (t) => {
  for (const stage of ["register", "login"]) {
    const directory = temporaryDirectory(t);
    const calls = [], logs = [];
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const runtime = { env: environment(directory), exit(code) { calls.push(["exit", code]); resolveExit(); } };
    const logger = { log(message) { logs.push(message); }, error(message) { logs.push(message); } };
    runInNewContext(fs.readFileSync(require.resolve("./index"), "utf8"), {
      process: runtime, console: logger,
      require(name) {
        if (name === "dotenv") return { config() {} };
        if (name === "discord.js") return {
          ...require(name),
          Client: class extends EventEmitter {
            async login() { calls.push(["login"]); throw new Error(TOKEN); }
            async destroy() { calls.push(["destroy"]); }
          },
          REST: class {
            setToken() { return this; }
            async put() {
              calls.push(["register"]);
              if (stage === "register") throw new Error(TOKEN);
            }
            clearHashSweeper() {}
            clearHandlerSweeper() {}
          },
        };
        if (name === "./startup") return {
          ...require(name),
          connectDiscord(client, rest, commands, config) {
            return require(name).connectDiscord(client, rest, commands, config, { logger });
          },
          failStartup(error, client) { return require(name).failStartup(error, client, { logger, runtime }); },
        };
        if (name === "./data-backups") return {
          ...require(name), startAutomaticBackups() { calls.push(["backup"]); },
        };
        return require(name);
      },
    });
    await exited;
    assert.deepEqual(calls, stage === "register"
      ? [["register"], ["destroy"], ["exit", 1]]
      : [["register"], ["login"], ["destroy"], ["exit", 1]]);
    assert.equal(runtime.exitCode, 1);
    assert.ok(logs.some((message) => message.includes("Bot-Start abgebrochen")));
    assert.ok(logs.every((message) => !message.includes(TOKEN) && !message.includes("mit Discord verbunden")));
  }
});
