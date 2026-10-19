const { mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { Events, Routes } = require("discord.js");
const { LeagueSettingsStore, settingsFilePath } = require("./league-settings");
const { MatchStore } = require("./match-store");

const STARTUP_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 5_000;

class StartupError extends Error {}

function readConfiguration(env = process.env) {
  const value = (name) => typeof env[name] === "string" ? env[name].trim() : "";
  const token = value("DISCORD_TOKEN");
  const clientId = value("CLIENT_ID");
  const participantRoleId = value("PARTICIPANT_ROLE_ID");
  const errors = [];
  if (!token || token === "dein-bot-token") errors.push("DISCORD_TOKEN fehlt oder enthält noch den Beispielwert.");
  else if (/\s/.test(token)) errors.push("DISCORD_TOKEN darf keine Leerzeichen enthalten; nur das Bot-Token ohne Präfix eintragen.");
  for (const [name, id] of [["CLIENT_ID", clientId], ["PARTICIPANT_ROLE_ID", participantRoleId]]) {
    if (!/^[1-9]\d{16,19}$/.test(id)) errors.push(`${name} muss eine gültige Discord-ID mit 17 bis 20 Ziffern sein.`);
  }
  if (env.DATA_DIR !== undefined && (typeof env.DATA_DIR !== "string" || !env.DATA_DIR.trim())) {
    errors.push("DATA_DIR darf nicht leer sein; einen Datenpfad eintragen oder die Variable entfernen.");
  }
  if (errors.length) throw new StartupError(`${errors.join(" ")} Bitte .env bzw. die Hosting-Variablen korrigieren.`);
  return { token, clientId, participantRoleId };
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
  } catch {
    throw new StartupError("Der Datenordner ist nicht beschreibbar. Bitte Pfad, Dateirechte und freien Speicher bzw. das Railway-Volume prüfen.");
  } finally {
    if (ownedPath) try { unlinkSync(ownedPath); } catch { /* Only this startup probe is cleaned up. */ }
  }
}

function prepareStartup(env = process.env) {
  const config = readConfiguration(env);
  let settingsPath;
  try { settingsPath = settingsFilePath(env); } catch (error) { throw new StartupError(error.message); }
  verifyDataDirectory(dirname(settingsPath));
  let settingsStore, matchStore;
  try { settingsStore = new LeagueSettingsStore(settingsPath); } catch {
    throw new StartupError("Die gespeicherten Liga-Einstellungen konnten nicht gelesen werden. Bitte league-settings.json prüfen oder beide Datendateien aus einem Backup wiederherstellen.");
  }
  try { matchStore = new MatchStore(join(dirname(settingsPath), "matches.json")); } catch {
    throw new StartupError("Das Replay-Archiv konnte nicht geladen oder angelegt werden. Bitte matches.json und die Dateirechte prüfen oder beide Datendateien aus einem Backup wiederherstellen.");
  }
  return { config, settingsPath, settingsStore, matchStore };
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
      } catch {
        throw new StartupError("Slash-Befehle konnten nicht registriert werden. Bitte CLIENT_ID, das zugehörige DISCORD_TOKEN und die Verbindung zu Discord prüfen.");
      }
      controller.signal.throwIfAborted();
      logger.log(`✅ Discord-Befehle registriert: ${commands.map((command) => command.type === 3
        ? `„${command.name}“` : `/${command.name}`).join(", ")}`);
      // Install the listener before login: a fast client may become ready before login resolves.
      const ready = once(client, Events.ClientReady, { signal: controller.signal });
      try {
        await Promise.all([Promise.resolve().then(() => client.login(config.token)), ready]);
      } catch (error) {
        throw new StartupError(loginFailure(error));
      }
    }, timeoutMs, "Der Discord-Start wurde nach 60 Sekunden abgebrochen. Bitte die Verbindung zu Discord und die Zugangsdaten prüfen.");
  } finally {
    controller.abort();
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  }
}

async function failStartup(error, client, { logger = console, runtime = process, timeoutMs = CLEANUP_TIMEOUT_MS } = {}) {
  runtime.exitCode = 1;
  // Raw Discord errors can include request data. Only controlled startup messages reach the log.
  logger.error(`❌ Bot-Start abgebrochen: ${error instanceof StartupError ? error.message : "Unerwarteter Fehler beim Initialisieren. Bitte Konfiguration und Datenspeicher prüfen."}`);
  if (client) {
    try { await withTimeout(() => client.destroy(), timeoutMs, "Discord-Verbindung konnte nicht rechtzeitig geschlossen werden."); } catch {
      logger.error("Die Discord-Verbindung konnte beim Startabbruch nicht regulär geschlossen werden; der Prozess wird beendet.");
    }
  }
  runtime.exit(1);
}

module.exports = { StartupError, readConfiguration, verifyDataDirectory, prepareStartup, connectDiscord, failStartup, STARTUP_TIMEOUT_MS };
