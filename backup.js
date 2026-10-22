require("dotenv").config({ quiet: true });
const { settingsFilePath, LeagueSettingsError } = require("./league-settings");
const { DataBackups } = require("./data-backups");
const { SqliteBackups } = require("./database-backups");
const { DATABASE_NAME } = require("./database");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { logError } = require("./diagnostics");

try {
  const settingsPath = settingsFilePath();
  const databasePath = join(dirname(settingsPath), DATABASE_NAME);
  const backups = existsSync(databasePath) ? new SqliteBackups(databasePath) : new DataBackups(settingsPath);
  const result = backups.create({ force: true });
  console.log(`✅ Datensicherung erstellt: ${result.path}`);
  for (const failure of result.cleanupErrors) logError("⚠️ Alte Datensicherung konnte nicht entfernt werden:",
    failure.error, { operation: "backup.cleanup", backupName: failure.backupName });
} catch (error) {
  const hint = error instanceof LeagueSettingsError ? ` ${error.message}` : "";
  logError(`❌ Datensicherung fehlgeschlagen.${hint} Bitte Datenpfad und Dateien prüfen. Den Bot vor einer manuellen Sicherung stoppen.`,
    error, { operation: "backup.create" });
  process.exitCode = 1;
}
