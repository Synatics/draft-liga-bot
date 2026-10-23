const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join, resolve, relative, isAbsolute, sep } = require("node:path");
const { causedError } = require("../shared/diagnostics");
const { writeJsonAtomic } = require("./json-storage");
const { buildRounds } = require("../league/season-rounds");

/** @typedef {import('../shared/data-types').SeasonSettings} SeasonSettings */

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
  if (settings.rounds) {
    const round = seasonProgress(settings, now).currentRound;
    return round?.kind === "league" ? round.matchday : undefined;
  }
  return Math.min(settings.matchdays, Math.max(1, calendarWeek(settings.startDate, now)));
}

function calendarWeek(startDate, now) {
  const start = normalizeStartDate(startDate).split("-").map(Number);
  const parts = Object.fromEntries(
    berlinDate
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  // Compare calendar dates, not elapsed hours: DST weeks can have 167 or 169 hours.
  const days = (calendarDate(parts.year, parts.month, parts.day) - calendarDate(...start)) / DAY_MS;
  return Math.floor(days / 7) + 1;
}

function seasonProgress(settings, now = new Date()) {
  const week = calendarWeek(settings.startDate, now);
  const current = settings.rounds[Math.min(settings.rounds.length - 1, Math.max(0, week - 1))];
  return {
    week,
    currentRound: structuredClone(current),
    status:
      week < 1
        ? "upcoming"
        : week > settings.rounds.length
          ? "finished"
          : current.kind === "break"
            ? "redraft"
            : "active",
    ...(current.kind === "break" ? { nextRound: structuredClone(settings.rounds[week]) } : {}),
  };
}

function checkInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new LeagueSettingsError(`${label} muss eine ganze Zahl zwischen 1 und ${maximum} sein.`);
  }
}

function validateSettings(settings, allowHistory = true) {
  if (!settings || typeof settings !== "object")
    throw new LeagueSettingsError("Ungültige Liga-Einstellungen.");
  checkInteger(settings.season, "Die Season", 9999);
  checkInteger(settings.matchdays, "Die Anzahl der Spieltage", 25);
  if (settings.startDate !== undefined) normalizeStartDate(settings.startDate);
  if (
    settings.rounds !== undefined ||
    settings.format !== undefined ||
    settings.redraft !== undefined ||
    settings.playoffsFrom !== undefined
  ) {
    if (!settings.startDate || !settings.format || !Array.isArray(settings.rounds))
      throw new LeagueSettingsError("Ungültiger gespeicherter Seasonplan.");
    let expected;
    try {
      expected = buildRounds(settings.matchdays, settings);
    } catch (error) {
      throw new LeagueSettingsError(error.message);
    }
    if (JSON.stringify(settings.rounds) !== JSON.stringify(expected))
      throw new LeagueSettingsError("Der gespeicherte Rundenplan passt nicht zum Season-Format.");
  }
  if (
    (!settings.rounds && settings.startDate === undefined) ||
    settings.currentMatchday !== undefined
  ) {
    checkInteger(settings.currentMatchday, "Der Spieltag", settings.matchdays);
  }
  if (settings.history !== undefined) {
    if (
      !allowHistory ||
      !settings.history ||
      typeof settings.history !== "object" ||
      Array.isArray(settings.history)
    )
      throw new LeagueSettingsError("Ungültige historische Seasonpläne.");
    for (const [number, previous] of Object.entries(settings.history)) {
      validateSettings(previous, false);
      if (String(previous.season) !== number || previous.season === settings.season)
        throw new LeagueSettingsError(
          "Ein historischer Seasonplan gehört zu einer anderen Season.",
        );
    }
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
  const dataDir = resolve(
    env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || join(__dirname, "..", "..", "data"),
  );
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

  /** @param {string} guildId @returns {import('../shared/data-types').ActiveSeason} */
  get(guildId) {
    return this.getSeason(guildId, this.guilds[guildId]?.season);
  }

  /** Saved configuration without calendar progress or historical entries; safe to edit as a draft. */
  configuration(guildId) {
    const stored = this.guilds[guildId];
    if (!stored) return undefined;
    const { history, ...settings } = stored;
    return structuredClone(settings);
  }

  revision(guildId) {
    return createHash("sha256")
      .update(JSON.stringify(this.configuration(guildId) ?? null))
      .digest("hex");
  }

  getSeason(guildId, season) {
    const stored = this.guilds[guildId];
    const source = stored?.season === season ? stored : stored?.history?.[season];
    const { history, ...settings } = source ?? {};
    if (!source) {
      throw new LeagueSettingsError(
        "Die Season ist noch nicht eingerichtet. Bitte mit /liga season die Nummer, Anzahl der Spieltage und das Startdatum einstellen.",
      );
    }
    return {
      ...structuredClone(settings),
      ...(settings.startDate !== undefined
        ? { startDate: normalizeStartDate(settings.startDate) }
        : {}),
      currentMatchday: currentMatchday(settings, this.now()),
      ...(settings.rounds ? seasonProgress(settings, this.now()) : {}),
    };
  }

  setSeason(guildId, season, matchdays, startDate, options) {
    checkInteger(season, "Die Season", 9999);
    checkInteger(matchdays, "Die Anzahl der Spieltage", 25);
    let plan = {};
    if (options) {
      const format = options.format ?? "league";
      const redraft = options.redraft ?? false;
      const playoffsFrom =
        options.playoffsFrom ?? (format === "playoffs" ? "semifinal" : undefined);
      try {
        plan = {
          format,
          redraft,
          ...(playoffsFrom ? { playoffsFrom } : {}),
          rounds: buildRounds(matchdays, { format, redraft, playoffsFrom }),
        };
      } catch (error) {
        throw new LeagueSettingsError(error.message);
      }
    }
    return this.save(guildId, {
      season,
      matchdays,
      startDate: normalizeStartDate(startDate),
      ...plan,
    });
  }

  /** @param {string} guildId @param {SeasonSettings} settings @returns {import('../shared/data-types').ActiveSeason} */
  save(guildId, settings) {
    validateSettings(settings);
    const previous = this.guilds[guildId];
    const history = { ...previous?.history };
    if (previous && previous.season !== settings.season) {
      const { history: previousHistory, ...snapshot } = previous;
      history[previous.season] = snapshot;
    }
    delete history[settings.season];
    const guilds = {
      ...this.guilds,
      [guildId]: {
        ...structuredClone(settings),
        ...(Object.keys(history).length ? { history } : {}),
      },
    };
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
  seasonProgress,
};
