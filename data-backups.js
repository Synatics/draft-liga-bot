const {
  mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, lstatSync, unlinkSync, rmdirSync,
} = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const { parseSettingsDocument } = require("./league-settings");
const { parseMatchesDocument } = require("./match-store");
const { logError } = require("./diagnostics");

const FILES = ["league-settings.json", "matches.json"];
const BACKUP_NAME = /^backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[a-f0-9-]{36}$/;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const KEEP_COUNT = 14;

class DataBackups {
  constructor(settingsPath, { now = () => new Date(), keepCount = KEEP_COUNT } = {}) {
    if (!Number.isSafeInteger(keepCount) || keepCount < 1) throw new Error("Ungültige Anzahl aufzubewahrender Backups.");
    this.dataDirectory = resolve(dirname(settingsPath));
    this.directory = join(this.dataDirectory, "backups");
    this.now = now;
    this.keepCount = keepCount;
  }

  list() {
    try {
      if (!lstatSync(this.directory).isDirectory()) throw new Error("Der Backup-Ordner muss ein echtes Verzeichnis sein.");
      return readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && BACKUP_NAME.test(entry.name))
        .map((entry) => entry.name).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  readSnapshot(directory) {
    const texts = FILES.map((name) => {
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) throw new Error(`${name} muss eine reguläre Datei sein.`);
      return readFileSync(path, "utf8");
    });
    parseSettingsDocument(texts[0]);
    parseMatchesDocument(texts[1]);
    return texts;
  }

  create({ force = false } = {}) {
    const timestamp = this.now().toISOString();
    const dayPrefix = `backup-${timestamp.slice(0, 10)}T`;
    const backups = this.list();
    if (!force) {
      // A damaged or incomplete copy must not suppress today's next backup attempt.
      for (const name of backups.filter((entry) => entry.startsWith(dayPrefix)).reverse()) {
        try {
          this.readSnapshot(join(this.directory, name));
          return { created: false, path: join(this.directory, name), cleanupErrors: [] };
        } catch { /* Try another existing snapshot or create a complete replacement. */ }
      }
    }

    // All reads and writes are synchronous: a report cannot change either file midway
    // through a backup in this process. A separate CLI backup requires a stopped bot.
    const texts = this.readSnapshot(this.dataDirectory);
    mkdirSync(this.directory, { recursive: true });
    if (!lstatSync(this.directory).isDirectory()) throw new Error("Der Backup-Ordner muss ein echtes Verzeichnis sein.");
    const name = `backup-${timestamp.replace(/[:.]/g, "-")}-${randomUUID()}`;
    const destination = join(this.directory, name);
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    mkdirSync(temporary);
    try {
      FILES.forEach((file, index) => writeFileSync(join(temporary, file), texts[index], { flag: "wx", mode: 0o600 }));
      renameSync(temporary, destination);
    } catch (error) {
      for (const file of FILES) {
        try { unlinkSync(join(temporary, file)); } catch { /* Retain unrelated files. */ }
      }
      try { rmdirSync(temporary); } catch { /* An interrupted temporary directory is never a completed backup. */ }
      throw error;
    }

    // Never remove an old copy until a new, complete backup has been committed.
    const cleanupErrors = [];
    const completed = [...backups, name].sort();
    for (const obsolete of completed.filter((entry) => entry !== name).slice(0, Math.max(0, completed.length - this.keepCount))) {
      const path = join(this.directory, obsolete);
      try {
        const entries = readdirSync(path).sort();
        const expected = [...FILES].sort();
        if (entries.length !== expected.length || !entries.every((entry, index) => entry === expected[index])) {
          throw Object.assign(new Error("Der Ordner enthält unerwartete Dateien und wurde beibehalten."), { code: "BACKUP_CONTENTS" });
        }
        if (FILES.some((file) => !lstatSync(join(path, file)).isFile())) {
          throw Object.assign(new Error("Der Ordner enthält unerwartete Dateitypen und wurde beibehalten."), { code: "BACKUP_CONTENTS" });
        }
        for (const file of FILES) unlinkSync(join(path, file));
        rmdirSync(path);
      } catch (error) {
        cleanupErrors.push({ backupName: obsolete, error });
      }
    }
    return { created: true, path: destination, cleanupErrors };
  }
}

function startAutomaticBackups(backups, logger = console) {
  const check = () => {
    try {
      const result = backups.create();
      if (result.created) logger.log(`✅ Datensicherung erstellt: ${result.path}`);
      for (const failure of result.cleanupErrors) logError("⚠️ Alte Datensicherung konnte nicht entfernt werden:",
        failure.error, { operation: "backup.cleanup", backupName: failure.backupName }, logger);
    } catch (error) {
      logError("⚠️ Datensicherung fehlgeschlagen. Bitte Datenordner und freien Speicher prüfen.", error,
        { operation: "backup.create" }, logger);
    }
  };
  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { DataBackups, startAutomaticBackups, CHECK_INTERVAL_MS, KEEP_COUNT };
