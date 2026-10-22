const { DatabaseSync } = require("node:sqlite");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { parseSettingsDocument } = require("./league-settings");
const { parseMatchesDocument, matchData, snapshot } = require("./match-store");
const { causedError } = require("./diagnostics");

const DATABASE_NAME = "liga.sqlite";
const APPLICATION_ID = 0x444C424F;
const reportKey = (record) => record.id || `legacy-${createHash("sha256").update(JSON.stringify(matchData(record))).digest("hex")}`;

function validateEvent(event) {
  const id = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);
  if (!event.id || !id(event.guildId) || !id(event.channelId) ||
      !Number.isInteger(event.season) || event.season < 1 || event.season > 9999 ||
      !["created", "edited", "deleted", "imported"].includes(event.action) || !Number.isFinite(Date.parse(event.at)) ||
      (event.actor !== null && (!event.actor || !id(event.actor.id) || typeof event.actor.name !== "string" || !event.actor.name.trim() || event.actor.name.length > 100)) ||
      (event.messageId !== null && !id(event.messageId))) throw new Error("Ungültiger Eintrag im Änderungsprotokoll.");
  if ((event.action === "edited" || event.action === "deleted") !== Boolean(event.before) ||
      (event.action !== "deleted") !== Boolean(event.after)) throw new Error("Unvollständiger Protokolleintrag.");
  for (const state of [event.before, event.after].filter(Boolean)) {
    matchData(state);
    if (state.guildId !== event.guildId || state.channelId !== event.channelId) throw new Error("Protokolleintrag gehört zu einem anderen Server oder Kanal.");
  }
}

class LigaDatabase {
  constructor(filePath, { readOnly = false, now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
    if (!readOnly) mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath, { readOnly, enableForeignKeyConstraints: true });
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      const applicationId = this.db.prepare("PRAGMA application_id").get().application_id;
      if (version === 0 && applicationId === 0 && !readOnly &&
          !this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").get()) {
        this.transaction(() => this.db.exec(`
          PRAGMA application_id=${APPLICATION_ID};
          PRAGMA user_version=1;
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE settings (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE reports (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, season INTEGER NOT NULL,
            channel_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX reports_by_season ON reports(guild_id, season);
          CREATE TABLE audit_events (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, season INTEGER NOT NULL,
            report_id TEXT NOT NULL, occurred_at TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX audit_by_season ON audit_events(guild_id, season, occurred_at);
        `));
      } else if (version !== 1 || applicationId !== APPLICATION_ID) {
        throw new Error("Unbekannte Datenbank oder nicht unterstützte Datenbankversion.");
      }
      if (!this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) {
        if (readOnly) throw new Error("Die Datenübernahme ist noch nicht abgeschlossen.");
        this.importJson();
      }
      this.validate();
    } catch (error) {
      try { this.db.close(); } catch (closeError) {
        throw new AggregateError([error, closeError], "Datenbank konnte nach einem Fehler nicht geschlossen werden.", { cause: error });
      }
      throw error;
    }
  }

  transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { if (this.db.isTransaction) this.db.exec("ROLLBACK"); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Datenbankvorgang und Rollback sind fehlgeschlagen.", { cause: error });
      }
      throw error;
    }
  }

  importJson() {
    const directory = dirname(this.filePath);
    const texts = new Map();
    for (const name of ["league-settings.json", "matches.json"]) {
      const path = join(directory, name);
      try { if (existsSync(path)) texts.set(name, readFileSync(path, "utf8")); } catch (error) {
        throw causedError(Error, "Die JSON-Daten konnten nicht für die Übernahme gelesen werden.",
          error, { file: name, operation: name === "matches.json" ? "archive.read" : "settings.read" });
      }
    }
    const parse = (name, parser, fallback) => {
      if (!texts.has(name)) return fallback;
      try { return parser(texts.get(name)); } catch (error) {
        throw causedError(Error, "Die JSON-Daten für die Übernahme sind ungültig.",
          error, { file: name, operation: name === "matches.json" ? "archive.read" : "settings.read" });
      }
    };
    const settings = parse("league-settings.json", parseSettingsDocument, { guilds: {} });
    const matches = parse("matches.json", parseMatchesDocument, { matches: [] }).matches;
    // Keep a separate, validated pre-migration copy; the original JSON is never overwritten.
    if (texts.size) {
      const backup = join(directory, `migration-json-${this.now().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
      mkdirSync(backup);
      for (const [name, text] of texts) writeFileSync(join(backup, name), text, { flag: "wx", mode: 0o600 });
    }
    this.transaction(() => {
      this.writeSettings(settings.guilds);
      this.writeMatches(matches);
      for (const record of matches) this.writeEvent({ id: `${reportKey(record)}:imported`, action: "imported",
        guildId: record.guildId, season: record.season, reportId: reportKey(record), channelId: record.channelId,
        messageId: record.publication?.messageId || null, actor: null, before: null, after: snapshot(record) });
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('initialized',?)").run(this.now().toISOString());
    });
  }

  readMatches() {
    return JSON.stringify({ version: 1, matches: this.db.prepare("SELECT data FROM reports ORDER BY rowid").all().map((row) => JSON.parse(row.data)) });
  }

  listMatches(guildId, season) {
    const rows = season === undefined
      ? this.db.prepare("SELECT data FROM reports WHERE guild_id=? ORDER BY rowid").all(guildId)
      : this.db.prepare("SELECT data FROM reports WHERE guild_id=? AND season=? ORDER BY rowid").all(guildId, season);
    return rows.map((row) => JSON.parse(row.data));
  }

  readSettings() {
    return JSON.stringify({ version: 1, guilds: Object.fromEntries(
      this.db.prepare("SELECT guild_id,data FROM settings").all().map((row) => [row.guild_id, JSON.parse(row.data)])) });
  }

  writeMatches(matches) {
    parseMatchesDocument(JSON.stringify({ version: 1, matches }));
    const remaining = new Set(matches.map(reportKey));
    for (const row of this.db.prepare("SELECT id FROM reports").all()) {
      if (!remaining.has(row.id)) this.db.prepare("DELETE FROM reports WHERE id=?").run(row.id);
    }
    const upsert = this.db.prepare(`INSERT INTO reports(id,guild_id,season,channel_id,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET guild_id=excluded.guild_id,season=excluded.season,channel_id=excluded.channel_id,data=excluded.data`);
    for (const record of matches) upsert.run(reportKey(record), record.guildId, record.season, record.channelId, JSON.stringify(record));
  }

  writeSettings(guilds) {
    parseSettingsDocument(JSON.stringify({ version: 1, guilds }));
    this.db.exec("DELETE FROM settings");
    const insert = this.db.prepare("INSERT INTO settings(guild_id,data) VALUES(?,?)");
    for (const [guildId, settings] of Object.entries(guilds)) insert.run(guildId, JSON.stringify(settings));
  }

  writeEvent(event) {
    const data = { ...event, at: this.now().toISOString() };
    validateEvent(data);
    this.db.prepare("INSERT INTO audit_events(id,guild_id,season,report_id,occurred_at,data) VALUES(?,?,?,?,?,?)")
      .run(data.id, data.guildId, data.season, data.reportId, data.at, JSON.stringify(data));
  }

  saveMatches(matches, event) {
    this.transaction(() => { this.writeMatches(matches); if (event) this.writeEvent(event); });
  }

  saveSettings(guilds) {
    this.transaction(() => this.writeSettings(guilds));
  }

  auditEvents(guildId, season) {
    if (!Number.isInteger(season) || season < 1 || season > 9999) throw new Error("Eine Season von 1 bis 9999 ist erforderlich.");
    return this.db.prepare("SELECT data FROM audit_events WHERE guild_id=? AND season=? ORDER BY occurred_at,rowid")
      .all(guildId, season).map((row) => JSON.parse(row.data));
  }

  validate() {
    if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Die SQLite-Datenbank ist beschädigt.");
    parseMatchesDocument(this.readMatches());
    parseSettingsDocument(this.readSettings());
    for (const row of this.db.prepare("SELECT * FROM reports").all()) {
      const record = JSON.parse(row.data);
      if (row.id !== reportKey(record) || row.guild_id !== record.guildId || row.season !== record.season || row.channel_id !== record.channelId) {
        throw new Error("Die Report-Indizes stimmen nicht mit den gespeicherten Angaben überein.");
      }
    }
    for (const row of this.db.prepare("SELECT * FROM audit_events").all()) {
      const event = JSON.parse(row.data);
      validateEvent(event);
      if (event.id !== row.id || event.guildId !== row.guild_id || event.season !== row.season ||
          event.reportId !== row.report_id || event.at !== row.occurred_at) {
        throw new Error("Ungültiger Eintrag im Änderungsprotokoll.");
      }
    }
  }

  backup(destination) {
    this.validate();
    this.db.prepare("VACUUM INTO ?").run(destination);
  }

  close() { this.db.close(); }
}

module.exports = { LigaDatabase, DATABASE_NAME };
