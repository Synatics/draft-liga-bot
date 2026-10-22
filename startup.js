const { mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { Events, Routes } = require("discord.js");
const { LeagueSettingsStore, settingsFilePath } = require("./league-settings");
const { MatchStore } = require("./match-store");
const { LigaDatabase, DATABASE_NAME } = require("./database");
const { causedError, logError } = require("./diagnostics");

const STARTUP_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 5_000;

class StartupError extends Error {}

function readConfiguration(env = process.env) {
  const value = (name) => typeof env[name] === "string" ? env[name].trim() : "";
  const token = value("DISCORD_TOKEN");
  const clientId = value("CLIENT_ID");
  const participantRoleId = value("PARTICIPANT_ROLE_ID");
  const managerRoleId = value("LEAGUE_MANAGER_ROLE_ID");
  const errors = [];
  if (!token || token === "dein-bot-token") errors.push("DISCORD_TOKEN fehlt oder enthält noch den Beispielwert.");
  else if (/\s/.test(token)) errors.push("DISCORD_TOKEN darf keine Leerzeichen enthalten; nur das Bot-Token ohne Präfix eintragen.");
  for (const [name, id] of [["CLIENT_ID", clientId], ["PARTICIPANT_ROLE_ID", participantRoleId]]) {
    if (!/^[1-9]\d{16,19}$/.test(id)) errors.push(`${name} muss eine gültige Discord-ID mit 17 bis 20 Ziffern sein.`);
  }
  if (managerRoleId && !/^[1-9]\d{16,19}$/.test(managerRoleId)) errors.push("LEAGUE_MANAGER_ROLE_ID muss eine gültige Discord-Rollen-ID sein oder leer bleiben.");
  if (managerRoleId && managerRoleId === participantRoleId) errors.push("Teilnehmerrolle und Ligaverwaltungsrolle müssen verschieden sein.");
  if (env.DATA_DIR !== undefined && (typeof env.DATA_DIR !== "string" || !env.DATA_DIR.trim())) {
    errors.push("DATA_DIR darf nicht leer sein; einen Datenpfad eintragen oder die Variable entfernen.");
  }
  if (errors.length) throw new StartupError(`${errors.join(" ")} Bitte .env bzw. die Hosting-Variablen korrigieren.`);
  return { token, clientId, participantRoleId, managerRoleId };
}

function verifyDataDirectory(directory) {
  const temporary = join(directory, `.startup-${randomUUID()}.tmp`);
  const renamed = `${temporary}.renamed`;
  let ownedPath;
  try {
    mkdirSync(directory, { recursive: true });
    const descriptor = openSync(temporary, "wx", 0o600);
    ownedPath = temporary;
    try { writeFileSync(descriptor, "startup probe\n"); } finally { closeSync(descriptor); }
    renameSync(temporary, renamed);
    ownedPath = renamed;
    unlinkSync(renamed);
    ownedPath = undefined;
  } catch (error) {
    throw causedError(StartupError, "Der Datenordner ist nicht beschreibbar. Bitte Pfad, Dateirechte und freien Speicher bzw. das Railway-Volume prüfen.",
      error, { operation: "storage.check" });
  } finally {
    if (ownedPath) try { unlinkSync(ownedPath); } catch { /* Only this startup probe is cleaned up. */ }
  }
}

function prepareStartup(env = process.env) {
  const config = readConfiguration(env);
  let settingsPath;
  try { settingsPath = settingsFilePath(env); } catch (error) { throw causedError(StartupError, error.message, error, { operation: "storage.check" }); }
  verifyDataDirectory(dirname(settingsPath));
  const databasePath = join(dirname(settingsPath), DATABASE_NAME);
  let database;
  try {
    database = new LigaDatabase(databasePath);
    const settingsStore = new LeagueSettingsStore(databasePath, () => new Date(), database);
    const matchStore = new MatchStore(databasePath, database);
    return { config, settingsPath, databasePath, database, settingsStore, matchStore };
  } catch (error) {
    try { database?.close(); } catch (closeError) {
      error = new AggregateError([error, closeError], "Datenspeicher konnte weder geladen noch geschlossen werden.", { cause: error });
    }
    throw causedError(StartupError, "Die SQLite-Datenbank bzw. die bisherigen Liga-Einstellungen und das Replay-Archiv konnten nicht geladen werden. Bitte liga.sqlite, league-settings.json, matches.json und die Dateirechte prüfen oder ein Backup wiederherstellen. Vorhandene Daten werden nicht zurückgesetzt.",
      error, { operation: "database.open", file: "liga.sqlite" });
  }
}

async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new StartupError(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function loginFailure(error) {
  if (error?.code === "TokenInvalid" || error?.status === 401 || error?.code === 4004) {
    return "Discord hat das Bot-Token abgelehnt. Bitte DISCORD_TOKEN im Developer Portal und in den Hosting-Variablen prüfen.";
  }
  if (error?.code === 4014 || /disallowed intents/i.test(error?.message || "")) {
    return "Discord hat die Gateway-Intents abgelehnt. Bitte den Server Members Intent im Discord Developer Portal aktivieren.";
  }
  return "Die Discord-Anmeldung ist fehlgeschlagen. Bitte Bot-Token, Server Members Intent und die Verbindung zu Discord prüfen.";
}

async function connectDiscord(client, rest, commands, config, { logger = console, timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  try {
    await withTimeout(async () => {
      try {
        await rest.put(Routes.applicationCommands(config.clientId), { body: commands, signal: controller.signal });
      } catch (error) {
        throw causedError(StartupError, "Slash-Befehle konnten nicht registriert werden. Bitte CLIENT_ID, das zugehörige DISCORD_TOKEN und die Verbindung zu Discord prüfen.",
          error, { operation: "discord.register" });
      }
      controller.signal.throwIfAborted();
      logger.log(`✅ Discord-Befehle registriert: ${commands.map((command) => command.type === 3
        ? `„${command.name}“` : `/${command.name}`).join(", ")}`);
      // Install the listener before login: a fast client may become ready before login resolves.
      const ready = once(client, Events.ClientReady, { signal: controller.signal });
      try {
        await Promise.all([Promise.resolve().then(() => client.login(config.token)), ready]);
      } catch (error) {
        throw causedError(StartupError, loginFailure(error), error, { operation: "discord.login" });
      }
    }, timeoutMs, "Der Discord-Start wurde nach 60 Sekunden abgebrochen. Bitte die Verbindung zu Discord und die Zugangsdaten prüfen.");
  } finally {
    controller.abort();
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  }
}

async function cleanupStartup(client, database, { logger = console, timeoutMs = CLEANUP_TIMEOUT_MS } = {}) {
  try { database?.close(); } catch (closeError) {
    logError("Datenbank konnte beim Startabbruch nicht geschlossen werden:", closeError, { operation: "database.close" }, logger);
  }
  if (client) {
    try { await withTimeout(() => client.destroy(), timeoutMs, "Discord-Verbindung konnte nicht rechtzeitig geschlossen werden."); } catch (closeError) {
      logError("Die Discord-Verbindung konnte beim Startabbruch nicht regulär geschlossen werden.",
        closeError, { operation: "discord.close" }, logger);
    }
  }
}

async function failStartup(error, client, { logger = console, runtime = process, timeoutMs = CLEANUP_TIMEOUT_MS } = {}) {
  runtime.exitCode = 1;
  logError(`❌ Bot-Start abgebrochen: ${error instanceof StartupError ? error.message : "Unerwarteter Fehler beim Initialisieren. Bitte Konfiguration und Datenspeicher prüfen."}`,
    error, {}, logger);
  await cleanupStartup(client, undefined, { logger, timeoutMs });
  runtime.exit(1);
}

module.exports = { StartupError, readConfiguration, verifyDataDirectory, prepareStartup, connectDiscord, cleanupStartup, failStartup, STARTUP_TIMEOUT_MS };
