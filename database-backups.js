const { mkdirSync, readdirSync, lstatSync, renameSync, unlinkSync, rmdirSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const { LigaDatabase, DATABASE_NAME } = require("./database");
const { KEEP_COUNT } = require("./data-backups");

const NAME = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}$/;

class SqliteBackups {
  constructor(filePath, { now = () => new Date(), keepCount = KEEP_COUNT } = {}) {
    if (!Number.isSafeInteger(keepCount) || keepCount < 1) throw new Error("Ungültige Anzahl aufzubewahrender Backups.");
    this.filePath = resolve(filePath);
    this.directory = join(dirname(this.filePath), "sqlite-backups");
    this.now = now;
    this.keepCount = keepCount;
  }

  check(path) {
    if (!lstatSync(path).isFile()) throw new Error("Die Sicherung muss eine reguläre SQLite-Datei sein.");
    const database = new LigaDatabase(path, { readOnly: true });
    database.close();
  }

  create({ force = false } = {}) {
    mkdirSync(this.directory, { recursive: true });
    if (!lstatSync(this.directory).isDirectory()) throw new Error("Der Backup-Ordner muss ein echtes Verzeichnis sein.");
    const backups = readdirSync(this.directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && NAME.test(entry.name))
      .map((entry) => entry.name).sort();
    const timestamp = this.now().toISOString();
    if (!force) for (const name of backups.filter((entry) => entry.startsWith(`backup-${timestamp.slice(0, 10)}T`)).reverse()) {
      try { this.check(join(this.directory, name, DATABASE_NAME)); return { created: false, path: join(this.directory, name), cleanupErrors: [] }; } catch { /* Ignore incomplete copies. */ }
    }
    const name = `backup-${timestamp.replace(/[:.]/g, "-")}-${randomUUID()}`;
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const destination = join(this.directory, name);
    mkdirSync(temporary);
    let database;
    try {
      database = new LigaDatabase(this.filePath, { readOnly: true });
      database.backup(join(temporary, DATABASE_NAME));
      database.close();
      database = undefined;
      this.check(join(temporary, DATABASE_NAME));
      renameSync(temporary, destination);
    } catch (error) {
      database?.close();
      try { unlinkSync(join(temporary, DATABASE_NAME)); } catch { /* Only remove our own temporary file. */ }
      try { rmdirSync(temporary); } catch { /* Preserve unexpected files. */ }
      throw error;
    }
    const cleanupErrors = [];
    const completed = [...backups, name].sort();
    for (const obsolete of completed.slice(0, Math.max(0, completed.length - this.keepCount))) {
      const path = join(this.directory, obsolete);
      try {
        const entries = readdirSync(path);
        if (entries.length !== 1 || entries[0] !== DATABASE_NAME || !lstatSync(join(path, DATABASE_NAME)).isFile()) {
          throw new Error("Unerwarteter Inhalt; die Sicherung wurde beibehalten.");
        }
        unlinkSync(join(path, DATABASE_NAME));
        rmdirSync(path);
      } catch (error) { cleanupErrors.push(`${obsolete}: ${error.message}`); }
    }
    return { created: true, path: destination, cleanupErrors };
  }
}

module.exports = { SqliteBackups };
