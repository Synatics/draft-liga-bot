const { readFileSync } = require("node:fs");
const { join, resolve, relative, isAbsolute, sep } = require("node:path");
const { causedError } = require("./diagnostics");
const { writeJsonAtomic } = require("./json-storage");

/** @typedef {import('./data-types').SeasonSettings} SeasonSettings */

class LeagueSettingsError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;
const berlinDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function calendarDate(year, month, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function normalizeStartDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!iso && !german) {
    throw new LeagueSettingsError("Bitte gib das Startdatum als TT.MM.JJJJ oder JJJJ-MM-TT an.");
  }
  const [year, month, day] = (iso ? iso.slice(1) : [german[3], german[2], german[1]]).map(Number);
  const date = calendarDate(year, month, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new LeagueSettingsError("Bitte gib ein gültiges Startdatum an.");
  }
  if (date.getUTCDay() !== 1) {
    throw new LeagueSettingsError(
      "Das Startdatum muss ein Montag sein, an dem Spieltag 1 beginnt.",
    );
  }
  return date.toISOString().slice(0, 10);
}

/** @param {SeasonSettings} settings @param {Date} [now] @returns {number} */
function currentMatchday(settings, now = new Date()) {
  validateSettings(settings);
  // Keep previously saved manual settings readable until a start date is configured once.
  if (settings.startDate === undefined) return settings.currentMatchday;
  const start = normalizeStartDate(settings.startDate).split("-").map(Number);
  const parts = Object.fromEntries(
    berlinDate
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  // Compare calendar dates, not elapsed hours: DST weeks can have 167 or 169 hours.
  const days = (calendarDate(parts.year, parts.month, parts.day) - calendarDate(...start)) / DAY_MS;
  return Math.min(settings.matchdays, Math.max(1, Math.floor(days / 7) + 1));
}

function checkInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new LeagueSettingsError(`${label} muss eine ganze Zahl zwischen 1 und ${maximum} sein.`);
  }
}

function validateSettings(settings) {
  if (!settings || typeof settings !== "object")
    throw new LeagueSettingsError("Ungültige Liga-Einstellungen.");
  checkInteger(settings.season, "Die Season", 9999);
  checkInteger(settings.matchdays, "Die Anzahl der Spieltage", 25);
  if (settings.startDate !== undefined) normalizeStartDate(settings.startDate);
  if (settings.startDate === undefined || settings.currentMatchday !== undefined) {
    checkInteger(settings.currentMatchday, "Der Spieltag", settings.matchdays);
  }
}

/** @param {string} text @returns {{version: 1, guilds: Record<string, SeasonSettings>}} */
function parseSettingsDocument(text) {
  const data = JSON.parse(text);
  if (
    !data ||
    data.version !== 1 ||
    !data.guilds ||
    typeof data.guilds !== "object" ||
    Array.isArray(data.guilds)
  ) {
    throw new Error("Ungültiges Dateiformat der Liga-Einstellungen");
  }
  for (const settings of Object.values(data.guilds)) validateSettings(settings);
  return data;
}

function settingsFilePath(env = process.env) {
  if (env.RAILWAY_ENVIRONMENT_ID && !env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new LeagueSettingsError(
      "Bitte dem Bot-Service in Railway einmalig ein Volume (z.B. /data) zuordnen, damit Liga-Einstellungen und Replays erhalten bleiben.",
    );
  }
  const dataDir = resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || join(__dirname, "data"));
  if (env.RAILWAY_ENVIRONMENT_ID) {
    const withinVolume = relative(resolve(env.RAILWAY_VOLUME_MOUNT_PATH), dataDir);
    if (withinVolume === ".." || withinVolume.startsWith(`..${sep}`) || isAbsolute(withinVolume)) {
      throw new LeagueSettingsError(
        "DATA_DIR muss auf Railway innerhalb des zugeordneten Volumes liegen.",
      );
    }
  }
  return join(dataDir, "league-settings.json");
}

class LeagueSettingsStore {
  /**
   * @param {string} filePath JSON path, or database path when storage is supplied.
   * @param {() => Date} [now]
   * @param {Pick<import('./database').LigaDatabase, 'readSettings' | 'saveSettings'>} [storage]
   */
  constructor(filePath, now = () => new Date(), storage) {
    this.filePath = filePath;
    this.storage = storage;
    this.now = now;
    /** @type {Record<string, SeasonSettings>} */
    this.guilds = {};
    try {
      const data = parseSettingsDocument(
        storage ? storage.readSettings() : readFileSync(filePath, "utf8"),
      );
      this.guilds = data.guilds;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw causedError(
          LeagueSettingsError,
          "Die gespeicherten Liga-Einstellungen konnten nicht gelesen werden. Bitte Datenspeicher und Dateiformat prüfen.",
          error,
          { operation: "settings.read", file: storage ? "liga.sqlite" : "league-settings.json" },
        );
      }
    }
  }

  /** @param {string} guildId @returns {import('./data-types').ActiveSeason} */
  get(guildId) {
    const settings = this.guilds[guildId];
    if (!settings) {
      throw new LeagueSettingsError(
        "Die Season ist noch nicht eingerichtet. Bitte mit /liga season die Nummer, Anzahl der Spieltage und das Startdatum einstellen.",
      );
    }
    return {
      ...settings,
      ...(settings.startDate !== undefined
        ? { startDate: normalizeStartDate(settings.startDate) }
        : {}),
      currentMatchday: currentMatchday(settings, this.now()),
    };
  }

  setSeason(guildId, season, matchdays, startDate) {
    checkInteger(season, "Die Season", 9999);
    checkInteger(matchdays, "Die Anzahl der Spieltage", 25);
    return this.save(guildId, { season, matchdays, startDate: normalizeStartDate(startDate) });
  }

  /** @param {string} guildId @param {SeasonSettings} settings @returns {import('./data-types').ActiveSeason} */
  save(guildId, settings) {
    validateSettings(settings);
    const guilds = { ...this.guilds, [guildId]: { ...settings } };
    const context = {
      operation: "settings.write",
      file: this.storage ? "liga.sqlite" : "league-settings.json",
      guildId,
      season: settings.season,
    };
    try {
      if (this.storage) this.storage.saveSettings(guilds);
      else writeJsonAtomic(this.filePath, { version: 1, guilds });
    } catch (error) {
      const message = this.storage
        ? "Die Liga-Einstellungen konnten nicht in SQLite gespeichert werden."
        : "Die Liga-Einstellungen konnten nicht gespeichert werden. Bitte prüfe den Datenordner bzw. das Railway-Volume.";
      throw causedError(LeagueSettingsError, message, error, context);
    }
    // Publish the new settings only once they are safely stored on disk.
    this.guilds = guilds;
    return this.get(guildId);
  }
}

module.exports = {
  LeagueSettingsError,
  LeagueSettingsStore,
  settingsFilePath,
  validateSettings,
  normalizeStartDate,
  currentMatchday,
  parseSettingsDocument,
};
