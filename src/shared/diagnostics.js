// Log only selected diagnostic fields. Error messages, stacks and request bodies may contain secrets.
const codes = new Map(
  Object.entries({
    EACCES: "Zugriff verweigert; Dateirechte prüfen.",
    EPERM: "Vorgang nicht erlaubt; Dateirechte oder Dateisperren prüfen.",
    ENOSPC: "Datenträger voll; freien Speicher prüfen.",
    EDQUOT: "Speicherquote ausgeschöpft.",
    EROFS: "Datenträger ist schreibgeschützt.",
    EIO: "Ein-/Ausgabefehler des Datenträgers.",
    ENOENT: "Datei oder Verzeichnis fehlt.",
    ENOTDIR: "Ein Pfadbestandteil ist kein Verzeichnis.",
    EISDIR: "Ein Verzeichnis wurde statt einer Datei angegeben.",
    EEXIST: "Die Zieldatei existiert bereits.",
    EBUSY: "Datei oder Datenträger ist belegt.",
    EMFILE: "Zu viele gleichzeitig geöffnete Dateien.",
    ENFILE: "Das System kann keine weiteren Dateien öffnen.",
    ECONNRESET: "Netzwerkverbindung wurde zurückgesetzt.",
    ECONNREFUSED: "Netzwerkverbindung wurde abgelehnt.",
    ENOTFOUND: "Netzwerkadresse konnte nicht aufgelöst werden.",
    EAI_AGAIN: "Vorübergehender Fehler bei der Namensauflösung.",
    ETIMEDOUT: "Zeitlimit der Netzwerkverbindung überschritten.",
    UND_ERR_CONNECT_TIMEOUT: "Zeitlimit beim Verbindungsaufbau überschritten.",
    UND_ERR_HEADERS_TIMEOUT: "Zeitlimit beim Warten auf die Antwort überschritten.",
    UND_ERR_SOCKET: "Netzwerkverbindung wurde unterbrochen.",
    ERR_SQLITE_ERROR: "SQLite hat den Vorgang abgelehnt.",
    ERR_INVALID_STATE: "Der Vorgang ist im aktuellen Zustand nicht möglich.",
    TokenInvalid: "Discord hat das Bot-Token abgelehnt.",
    InteractionAlreadyReplied: "Die Interaktion wurde bereits beantwortet.",
    InteractionNotReplied: "Die Interaktion wurde noch nicht bestätigt.",
    BACKUP_CONTENTS: "Unerwarteter Backup-Inhalt; die Sicherung wurde beibehalten.",
  }),
);
const sqliteCodes = new Map([
  [1, ["SQLITE_ERROR", "Allgemeiner SQLite-Fehler."]],
  [3, ["SQLITE_PERM", "SQLite-Zugriff verweigert; Dateirechte prüfen."]],
  [5, ["SQLITE_BUSY", "Die Datenbank wird durch einen anderen Zugriff blockiert."]],
  [6, ["SQLITE_LOCKED", "Eine Datenbanktabelle ist gesperrt."]],
  [7, ["SQLITE_NOMEM", "Nicht genügend Arbeitsspeicher für SQLite."]],
  [8, ["SQLITE_READONLY", "Die Datenbank ist schreibgeschützt."]],
  [10, ["SQLITE_IOERR", "Ein-/Ausgabefehler beim Datenbankzugriff."]],
  [11, ["SQLITE_CORRUPT", "Die Datenbank ist beschädigt."]],
  [
    13,
    ["SQLITE_FULL", "SQLite kann nicht weiter schreiben; Datenträger oder Datenbanklimit voll."],
  ],
  [14, ["SQLITE_CANTOPEN", "Die Datenbank kann nicht geöffnet werden; Pfad und Rechte prüfen."]],
  [17, ["SQLITE_SCHEMA", "Das Datenbankschema wurde geändert."]],
  [19, ["SQLITE_CONSTRAINT", "Eine Datenbankbedingung wurde verletzt."]],
  [21, ["SQLITE_MISUSE", "Ungültige Verwendung der Datenbankverbindung."]],
  [26, ["SQLITE_NOTADB", "Die Datei ist keine lesbare SQLite-Datenbank."]],
]);
const discordCodes = new Map([
  [10003, "Discord-Kanal nicht gefunden."],
  [10007, "Discord-Mitglied nicht gefunden."],
  [10008, "Discord-Nachricht nicht gefunden."],
  [10062, "Die Discord-Interaktion ist abgelaufen."],
  [50001, "Discord-Zugriff fehlt."],
  [50007, "Direktnachrichten sind gesperrt."],
  [50013, "Discord-Berechtigungen fehlen."],
  [50035, "Discord hat die Nachrichtendaten abgelehnt."],
]);
const types = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "AbortError",
  "DiscordAPIError",
  "HTTPError",
  "RateLimitError",
  "StartupError",
  "MatchStoreError",
  "LeagueSettingsError",
  "ReportError",
  "ReportManagementError",
  "SearchError",
]);
const operations = new Set([
  "startup",
  "storage.check",
  "database.open",
  "database.close",
  "discord.register",
  "discord.login",
  "discord.connection",
  "discord.close",
  "archive.read",
  "archive.write",
  "settings.read",
  "settings.write",
  "members.load",
  "buttons.install",
  "interaction",
  "interaction.autocomplete",
  "interaction.reply",
  "report.publish",
  "report.status",
  "report.edit",
  "report.delete",
  "search.dm",
  "audit.dm",
  "backup.create",
  "backup.cleanup",
]);
const commands = new Set(["report", "liga", "suchen", "report-entfernen"]);
const files = new Set(["liga.sqlite", "league-settings.json", "matches.json"]);

function safeContext(context = {}) {
  if (!context || typeof context !== "object") return {};
  const result = {};
  for (const key of ["guildId", "channelId", "userId", "messageId"]) {
    if (typeof context[key] === "string" && /^\d{17,20}$/.test(context[key]))
      result[key] = context[key];
  }
  if (typeof context.reportId === "string" && /^[a-f0-9]{24}$/.test(context.reportId))
    result.reportId = context.reportId;
  for (const [key, maximum] of [
    ["season", 9999],
    ["matchday", 25],
  ]) {
    if (Number.isInteger(context[key]) && context[key] >= 1 && context[key] <= maximum)
      result[key] = context[key];
  }
  if (operations.has(context.operation)) result.operation = context.operation;
  if (commands.has(context.command)) result.command = context.command;
  if (files.has(context.file)) result.file = context.file;
  if (
    typeof context.backupName === "string" &&
    /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}$/.test(context.backupName)
  ) {
    result.backupName = context.backupName;
  }
  return result;
}

function causedError(ErrorType, message, cause, context) {
  const error = new ErrorType(message, { cause });
  error.context = safeContext(context);
  return error;
}

function errorChain(error) {
  const chain = [],
    seen = new Set();
  const visit = (current) => {
    if (!current || typeof current !== "object" || seen.has(current) || chain.length >= 12) return;
    seen.add(current);
    chain.push(current);
    visit(current.cause);
    if (Array.isArray(current.errors))
      for (const nested of current.errors.slice(0, 12)) visit(nested);
  };
  visit(error);
  return chain;
}

function describeError(error) {
  const type = error.constructor?.name;
  const result = { type: types.has(type) ? type : "Error" };
  if (codes.has(error.code))
    Object.assign(result, { code: error.code, hint: codes.get(error.code) });
  if (
    (typeof error.code === "number" ||
      (typeof error.code === "string" && /^\d{1,7}$/.test(error.code))) &&
    Number.isSafeInteger(Number(error.code)) &&
    Number(error.code) >= 0 &&
    Number(error.code) <= 9999999
  ) {
    result.discordCode = Number(error.code);
    result.hint = discordCodes.get(result.discordCode) || "Discord hat den Vorgang abgelehnt.";
  }
  if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599)
    result.httpStatus = error.status;
  if (
    error.code === "ERR_SQLITE_ERROR" &&
    Number.isInteger(error.errcode) &&
    error.errcode >= 0 &&
    error.errcode <= 2147483647
  ) {
    result.sqliteCode = error.errcode;
    const primary = sqliteCodes.get(error.errcode & 255);
    if (primary) [result.sqliteName, result.hint] = primary;
  }
  if (type === "SyntaxError")
    result.hint = "Ungültiges Datenformat; die Datei konnte nicht eingelesen werden.";
  return { ...result, ...safeContext(error.context) };
}

function logError(message, error, context = {}, logger = console) {
  const chain = errorChain(error);
  const inherited = Object.assign(
    {},
    ...chain.map((entry) => safeContext(entry.context)).reverse(),
  );
  const details = {
    timestamp: new Date().toISOString(),
    ...inherited,
    ...safeContext(context),
    causes: chain.length ? chain.map(describeError) : [{ type: "Error" }],
  };
  logger.error(`${message} ${JSON.stringify(details)}`);
}

function interactionContext(interaction) {
  const context = {
    guildId: interaction.guild?.id,
    channelId: interaction.channelId,
    userId: interaction.user?.id,
    command: interaction.commandName,
  };
  const match =
    /^(?:report:(?:edit|delete)|manage:(?:edit|delete|cancel)):([a-f0-9]{24})(?::|$)/.exec(
      interaction.customId || "",
    );
  if (match) context.reportId = match[1];
  if (interaction.customId?.startsWith("report:")) context.messageId = interaction.message?.id;
  return safeContext(context);
}

module.exports = { causedError, logError, interactionContext };
