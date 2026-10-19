require("dotenv").config({ quiet: true });
const { settingsFilePath } = require("./league-settings");
const { DataBackups } = require("./data-backups");

try {
  const result = new DataBackups(settingsFilePath()).create({ force: true });
  console.log(`✅ Datensicherung erstellt: ${result.path}`);
  for (const error of result.cleanupErrors) console.error(`⚠️ Alte Datensicherung konnte nicht entfernt werden: ${error}`);
} catch (error) {
  console.error(`❌ Datensicherung fehlgeschlagen: ${error.message}`);
  console.error("Bitte Datenpfad und Dateien prüfen. Den Bot vor einer manuellen Sicherung stoppen.");
  process.exitCode = 1;
}
