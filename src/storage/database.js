const { DatabaseSync } = require("node:sqlite");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { parseSettingsDocument, validateSettings } = require("./league-settings");
const { parseMatchesDocument, matchData, snapshot, validateMatch } = require("./match-store");
const {
  SCHEMA,
  REPLAY_COLUMNS,
  reportRow,
  reportFromRow,
  replayFromRow,
  seasonRow,
  seasonFromRow,
  eventRow,
  eventFromRow,
} = require("./sqlite-schema");
const { causedError } = require("../shared/diagnostics");

const DATABASE_NAME = "liga.sqlite";
const APPLICATION_ID = 0x444c424f;
const VERSION = 2;
const reportKey = (record) =>
  record.id ||
  `legacy-${createHash("sha256")
    .update(JSON.stringify(matchData(record)))
    .digest("hex")}`;

function validateEvent(event) {
  const id = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);
  if (
    !event.id ||
    !id(event.guildId) ||
    !id(event.channelId) ||
    !Number.isInteger(event.season) ||
    event.season < 1 ||
    event.season > 9999 ||
    !["created", "edited", "deleted", "imported"].includes(event.action) ||
    !Number.isFinite(Date.parse(event.at)) ||
    (event.actor !== null &&
      (!event.actor ||
        !id(event.actor.id) ||
        typeof event.actor.name !== "string" ||
        !event.actor.name.trim() ||
        event.actor.name.length > 100)) ||
    (event.messageId !== null && !id(event.messageId))
  )
    throw new Error("Ungültiger Eintrag im Änderungsprotokoll.");
  if (
    (event.action === "edited" || event.action === "deleted") !== Boolean(event.before) ||
    (event.action !== "deleted") !== Boolean(event.after)
  )
    throw new Error("Unvollständiger Protokolleintrag.");
  for (const state of [event.before, event.after].filter(Boolean)) {
    matchData(state);
    if (state.guildId !== event.guildId || state.channelId !== event.channelId)
      throw new Error("Protokolleintrag gehört zu einem anderen Server oder Kanal.");
  }
}

// All table and column names below come from the fixed row mappings in sqlite-schema.js.
// Only bound parameters contain application data.
function insertRow(db, table, row, updateKeys = []) {
  const columns = Object.keys(row);
  let sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((key) => ":" + key).join(",")})`;
  if (updateKeys.length) {
    const assignments = columns
      .filter((key) => !updateKeys.includes(key))
      .map((key) => `${key}=excluded.${key}`);
    sql += ` ON CONFLICT(${updateKeys.join(",")}) DO UPDATE SET ${assignments.join(",")}`;
  }
  db.prepare(sql).run(row);
}

function schemaVersion(db) {
  const { application_id } = db.prepare("PRAGMA application_id").get();
  const { user_version } = db.prepare("PRAGMA user_version").get();
  if (
    application_id === 0 &&
    user_version === 0 &&
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table'").get()
  )
    return 0;
  if (application_id !== APPLICATION_ID || ![1, VERSION].includes(user_version))
    throw new Error("Unbekannte Datenbank oder nicht unterstützte Datenbankversion.");
  return user_version;
}

function checkIntegrity(db) {
  if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
    throw new Error("Die SQLite-Datenbank ist beschädigt.");
}

// Version 1 duplicated indexed keys inside each JSON object. Never migrate a mismatched row.
function readVersionOne(db) {
  const settings = db
    .prepare("SELECT guild_id, data FROM settings")
    .all()
    .map((row) => {
      const value = JSON.parse(row.data);
      validateSettings(value);
      return [row.guild_id, value];
    });
  const reports = db
    .prepare("SELECT * FROM reports ORDER BY rowid")
    .all()
    .map((row) => {
      const record = JSON.parse(row.data);
      validateMatch(record);
      if (
        row.id !== reportKey(record) ||
        row.guild_id !== record.guildId ||
        row.season !== record.season ||
        row.channel_id !== record.channelId
      )
        throw new Error("Die Report-Indizes stimmen nicht mit den gespeicherten Angaben überein.");
      return record;
    });
  const events = db
    .prepare("SELECT * FROM audit_events ORDER BY rowid")
    .all()
    .map((row) => {
      const event = JSON.parse(row.data);
      validateEvent(event);
      if (
        row.id !== event.id ||
        row.guild_id !== event.guildId ||
        row.season !== event.season ||
        row.report_id !== event.reportId ||
        row.occurred_at !== event.at
      )
        throw new Error("Ungültiger Eintrag im Änderungsprotokoll.");
      return event;
    });
  return { settings, reports, events };
}

function validateRows(db) {
  for (const row of db.prepare("SELECT * FROM reports").iterate()) {
    const record = reportFromRow(row);
    validateMatch(record);
    if (!record.id && !/^legacy-[a-f0-9]{64}$/.test(row.id))
      throw new Error("Ungültige gespeicherte Report-ID.");
  }
  if (db.prepare("SELECT 1 FROM seasons GROUP BY guild_id HAVING SUM(is_current) <> 1").get())
    throw new Error("Die aktive Season ist nicht eindeutig.");
  for (const row of db.prepare("SELECT * FROM seasons").iterate())
    validateSettings(seasonFromRow(row), false);
  for (const row of db.prepare("SELECT * FROM audit_events").iterate())
    validateEvent(eventFromRow(row));
}

function hasLeagueData(db, version) {
  const settingsTable = version === 1 ? "settings" : "seasons";
  return (
    db
      .prepare(
        `SELECT 1 FROM ${settingsTable} UNION ALL SELECT 1 FROM reports UNION ALL SELECT 1 FROM audit_events LIMIT 1`,
      )
      .get() !== undefined
  );
}

function requireLosslessImport(original, restored) {
  if (!isDeepStrictEqual(original, restored))
    throw new Error(
      "Die gespeicherten Angaben lassen sich nicht vollständig in das neue Datenbankschema übernehmen.",
    );
}

function closeAfterError(db, error) {
  const causes = [error];
  try {
    db.close();
  } catch (closeError) {
    causes.push(closeError);
  }
  if (causes.length > 1)
    throw new AggregateError(
      causes,
      "Datenbank konnte nach einem Fehler nicht geschlossen werden.",
      { cause: error },
    );
  throw error;
}

// Backups, including older v1 backups, can be verified and copied without upgrading their source.
function checkSnapshot(filePath, destination, { allowUninitialized = false } = {}) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  let version;
  try {
    version = schemaVersion(db);
    if (
      !version ||
      (!db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get() &&
        (!allowUninitialized || hasLeagueData(db, version)))
    )
      throw new Error("Die Datenübernahme ist noch nicht abgeschlossen.");
    checkIntegrity(db);
    if (version === 1) readVersionOne(db);
    else validateRows(db);
    if (destination) db.prepare("VACUUM INTO ?").run(destination);
  } catch (error) {
    closeAfterError(db, error);
  }
  db.close();
  return version;
}

class LigaDatabase {
  constructor(filePath, { readOnly = false, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    if (!readOnly) mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath, { readOnly, enableForeignKeyConstraints: true });
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      const version = schemaVersion(this.db);
      if (version !== VERSION && readOnly)
        throw new Error(
          "Diese Datenbank muss zuerst auf einer schreibbaren Kopie initialisiert oder migriert werden.",
        );
      if (version === 0) {
        this.transaction(() => {
          if (schemaVersion(this.db) === VERSION) return;
          this.db.exec(`PRAGMA application_id=${APPLICATION_ID};
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          ${SCHEMA}
          PRAGMA user_version=${VERSION};`);
        });
      } else if (version === 1) {
        this.migrateVersionOne();
      }
      if (!this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) {
        if (readOnly) throw new Error("Die Datenübernahme ist noch nicht abgeschlossen.");
        this.importJson();
      }
      this.validate();
    } catch (error) {
      closeAfterError(this.db, error);
    }
  }

  transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      const errors = [error];
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Datenbankvorgang und Rollback sind fehlgeschlagen.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  migrateVersionOne() {
    this.transaction(() => {
      if (schemaVersion(this.db) === VERSION) return;
      checkIntegrity(this.db);
      const { settings, reports, events } = readVersionOne(this.db);
      // Hold the writer lock while a second, read-only connection takes the rollback copy.
      const directory = join(dirname(this.filePath), `migration-sqlite-v1-${randomUUID()}`);
      mkdirSync(directory);
      const backup = join(directory, DATABASE_NAME);
      checkSnapshot(this.filePath, backup, { allowUninitialized: true });
      checkSnapshot(backup, undefined, { allowUninitialized: true });
      this.db.exec(
        "ALTER TABLE reports RENAME TO reports_v1; ALTER TABLE audit_events RENAME TO audit_events_v1;",
      );
      this.db.exec(SCHEMA);
      for (const [guildId, value] of settings) this.importSeasons(guildId, value);
      for (const record of reports) this.importReport(record);
      for (const event of events) {
        const row = eventRow(event);
        requireLosslessImport(event, eventFromRow(row));
        insertRow(this.db, "audit_events", row);
      }
      this.validate();
      this.db.exec(
        `DROP TABLE settings; DROP TABLE reports_v1; DROP TABLE audit_events_v1; PRAGMA user_version=${VERSION};`,
      );
    });
  }

  importSeasons(guildId, settings) {
    const { history, ...active } = settings;
    for (const plan of [...Object.values(history ?? {}), active]) {
      const row = seasonRow(guildId, plan, plan === active);
      requireLosslessImport(plan, seasonFromRow(row));
      insertRow(this.db, "seasons", row);
    }
  }

  importReport(record) {
    const row = reportRow(reportKey(record), record);
    requireLosslessImport(record, reportFromRow(row));
    insertRow(this.db, "reports", row);
  }

  importJson() {
    const directory = dirname(this.filePath);
    const texts = new Map();
    for (const name of ["league-settings.json", "matches.json"]) {
      const path = join(directory, name);
      try {
        if (existsSync(path)) texts.set(name, readFileSync(path, "utf8"));
      } catch (error) {
        throw causedError(
          Error,
          "Die JSON-Daten konnten nicht für die Übernahme gelesen werden.",
          error,
          { file: name, operation: name === "matches.json" ? "archive.read" : "settings.read" },
        );
      }
    }
    const parse = (name, parser, fallback) => {
      if (!texts.has(name)) return fallback;
      try {
        return parser(texts.get(name));
      } catch (error) {
        throw causedError(Error, "Die JSON-Daten für die Übernahme sind ungültig.", error, {
          file: name,
          operation: name === "matches.json" ? "archive.read" : "settings.read",
        });
      }
    };
    const settings = parse("league-settings.json", parseSettingsDocument, { guilds: {} });
    const matches = parse("matches.json", parseMatchesDocument, { matches: [] }).matches;
    // Keep a separate, validated pre-migration copy; the original JSON is never overwritten.
    if (texts.size) {
      const backup = join(
        directory,
        `migration-json-${this.now().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
      );
      mkdirSync(backup);
      for (const [name, text] of texts)
        writeFileSync(join(backup, name), text, { flag: "wx", mode: 0o600 });
    }
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) return;
      if (hasLeagueData(this.db, VERSION))
        throw new Error("Der Initialisierungsmarker einer befüllten Datenbank fehlt.");
      for (const [guildId, value] of Object.entries(settings.guilds))
        this.importSeasons(guildId, value);
      for (const record of matches) {
        this.importReport(record);
        this.writeEvent({
          id: `${reportKey(record)}:imported`,
          action: "imported",
          guildId: record.guildId,
          season: record.season,
          reportId: reportKey(record),
          channelId: record.channelId,
          messageId: record.publication?.messageId || null,
          actor: null,
          before: null,
          after: snapshot(record),
        });
      }
      this.db
        .prepare("INSERT INTO metadata(key,value) VALUES('initialized',?)")
        .run(this.now().toISOString());
    });
  }

  listMatches(guildId, season, publishedOnly = false) {
    const conditions = ["guild_id=?"];
    const values = [guildId];
    if (season !== undefined) {
      conditions.push("season=?");
      values.push(season);
    }
    if (publishedOnly) conditions.push("publication_status='published'");
    return this.db
      .prepare(`SELECT * FROM reports WHERE ${conditions.join(" AND ")} ORDER BY rowid`)
      .all(...values)
      .map(reportFromRow);
  }

  replayCandidates(guildId, season, publishedOnly) {
    const published = publishedOnly ? " AND publication_status='published'" : "";
    return this.db
      .prepare(
        `SELECT ${REPLAY_COLUMNS} FROM reports WHERE guild_id=? AND season=?${published} ORDER BY rowid`,
      )
      .all(guildId, season)
      .map(replayFromRow);
  }

  findReplays(guildId, season, playerId, channelIds, { matchday, roundId }) {
    if (!channelIds.length) return [];
    const params = {
      guild: guildId,
      season,
      player: playerId,
      channels: JSON.stringify(channelIds),
    };
    let scope =
      "guild_id=:guild AND season=:season AND (player1_id=:player OR player2_id=:player) AND channel_id IN (SELECT value FROM json_each(:channels))";
    if (matchday != null) {
      scope += " AND matchday=:day";
      params.day = matchday;
    }
    if (roundId) {
      scope += " AND COALESCE(round_id, 'matchday-' || matchday)=:round";
      params.round = roundId;
    }
    return this.db
      .prepare(`SELECT ${REPLAY_COLUMNS}, replay_url FROM reports WHERE ${scope} ORDER BY rowid`)
      .all(params)
      .map(replayFromRow);
  }

  getReport(id, guildId) {
    const row =
      guildId === undefined
        ? this.db.prepare("SELECT * FROM reports WHERE id=?").get(id)
        : this.db.prepare("SELECT * FROM reports WHERE id=? AND guild_id=?").get(id, guildId);
    return row && reportFromRow(row);
  }

  reportsByMessage(guildId, channelId, messageId) {
    return this.db
      .prepare("SELECT * FROM reports WHERE guild_id=? AND channel_id=? AND message_id=? LIMIT 2")
      .all(guildId, channelId, messageId)
      .map(reportFromRow);
  }

  possibleDuplicates(match) {
    const [a, b] = match.players.map((player) => player.id);
    // A pending edit can reserve a different season, pairing or replay before Discord confirms it.
    return this.db
      .prepare(
        `SELECT * FROM reports WHERE guild_id=? AND channel_id=?
      AND ((season=? AND ((player1_id=? AND player2_id=?) OR (player1_id=? AND player2_id=?)))
        OR pending_change_json IS NOT NULL) ORDER BY rowid`,
      )
      .all(match.guildId, match.channelId, match.season, a, b, b, a)
      .map(reportFromRow);
  }

  reportsMissingButtons() {
    return this.db
      .prepare(
        `SELECT id,guild_id,channel_id,message_id FROM reports
      WHERE publication_status='published' AND controls_version IS NULL ORDER BY rowid`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        publication: { status: "published", messageId: row.message_id },
      }));
  }

  /** Only count published results in channels the caller has checked for this guild. */
  countResults(guildId, playerId, channelIds, { opponentId, season } = {}) {
    if (!Array.isArray(channelIds))
      throw new TypeError("Die Liste lesbarer Kanäle ist erforderlich.");
    if (!channelIds.length || playerId === opponentId) return { wins: 0, losses: 0 };
    const params = { guild: guildId, player: playerId, channels: JSON.stringify(channelIds) };
    const conditions = [
      "guild_id=:guild",
      "publication_status='published'",
      "channel_id IN (SELECT value FROM json_each(:channels))",
      "(winner_id=:player OR loser_id=:player)",
    ];
    if (opponentId !== undefined) {
      conditions.push("(winner_id=:opponent OR loser_id=:opponent)");
      params.opponent = opponentId;
    }
    if (season !== undefined) {
      conditions.push("season=:season");
      params.season = season;
    }
    const { wins, losses } = this.db
      .prepare(
        `SELECT count(*) FILTER (WHERE winner_id=:player) AS wins,
      count(*) FILTER (WHERE loser_id=:player) AS losses FROM reports WHERE ${conditions.join(" AND ")}`,
      )
      .get(params);
    return { wins, losses };
  }

  /** One row, inside the caller's transaction with its audit event. */
  writeReport(record, previous) {
    if (!record) {
      this.db
        .prepare("DELETE FROM reports WHERE id=? AND guild_id=?")
        .run(previous.id, previous.guildId);
      return;
    }
    validateMatch(record);
    const row = reportRow(reportKey(record), record);
    if (!previous) {
      insertRow(this.db, "reports", row);
      return;
    }
    const assignments = Object.keys(row)
      .filter((key) => key !== "id")
      .map((key) => `${key}=:${key}`);
    this.db.prepare(`UPDATE reports SET ${assignments.join(",")} WHERE id=:id`).run(row);
  }

  getSeason(guildId, season) {
    const row =
      season === undefined
        ? this.db.prepare("SELECT * FROM seasons WHERE guild_id=? AND is_current=1").get(guildId)
        : this.db
            .prepare("SELECT * FROM seasons WHERE guild_id=? AND season=?")
            .get(guildId, season);
    return row && seasonFromRow(row);
  }

  saveSeason(guildId, settings) {
    validateSettings(settings, false);
    this.transaction(() => {
      this.db
        .prepare("UPDATE seasons SET is_current=0 WHERE guild_id=? AND is_current=1 AND season<>?")
        .run(guildId, settings.season);
      insertRow(this.db, "seasons", seasonRow(guildId, settings, true), ["guild_id", "season"]);
    });
  }

  writeEvent(event) {
    const data = { ...event, at: this.now().toISOString() };
    validateEvent(data);
    insertRow(this.db, "audit_events", eventRow(data));
  }

  auditChannels(guildId, season) {
    return this.db
      .prepare("SELECT DISTINCT channel_id FROM audit_events WHERE guild_id=? AND season=?")
      .all(guildId, season)
      .map((row) => row.channel_id);
  }

  auditEvents(guildId, season, channelIds) {
    if (!Number.isInteger(season) || season < 1 || season > 9999)
      throw new Error("Eine Season von 1 bis 9999 ist erforderlich.");
    if (channelIds && !channelIds.length) return [];
    const scope = channelIds ? " AND channel_id IN (SELECT value FROM json_each(?))" : "";
    return this.db
      .prepare(
        `SELECT * FROM audit_events WHERE guild_id=? AND season=?${scope} ORDER BY occurred_at,rowid`,
      )
      .all(guildId, season, ...(channelIds ? [JSON.stringify(channelIds)] : []))
      .map(eventFromRow);
  }

  validate() {
    checkIntegrity(this.db);
    validateRows(this.db);
  }

  close() {
    this.db.close();
  }
}

module.exports = { LigaDatabase, DATABASE_NAME, checkSnapshot };
