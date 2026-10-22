require("dotenv").config({ quiet: true });
const { settingsFilePath } = require("./league-settings");
const { DataBackups } = require("./data-backups");
const { SqliteBackups } = require("./database-backups");
const { DATABASE_NAME } = require("./database");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

try {
  const settingsPath = settingsFilePath();
  const databasePath = join(dirname(settingsPath), DATABASE_NAME);
  const backups = existsSync(databasePath) ? new SqliteBackups(databasePath) : new DataBackups(settingsPath);
  const result = backups.create({ force: true });
  console.log(`✅ Datensicherung erstellt: ${result.path}`);
  for (const error of result.cleanupErrors) console.error(`⚠️ Alte Datensicherung konnte nicht entfernt werden: ${error}`);
} catch (error) {
  console.error(`❌ Datensicherung fehlgeschlagen: ${error.message}`);
  console.error("Bitte Datenpfad und Dateien prüfen. Den Bot vor einer manuellen Sicherung stoppen.");
  process.exitCode = 1;
}
