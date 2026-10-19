const { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } = require("node:fs");
const { dirname } = require("node:path");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { EmbedBuilder } = require("discord.js");

class MatchStoreError extends Error {}

const isSnowflake = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);

function validatePublication(publication) {
  if (!publication || !["pending", "sending", "published"].includes(publication.status) ||
      (publication.status === "published" ? !isSnowflake(publication.messageId) : publication.messageId !== undefined)) {
    throw new MatchStoreError("Ungültiger Veröffentlichungsstatus im Replay-Archiv.");
  }
}

function normalizeReplayLink(value) {
  try {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(text)) throw new Error();
    const url = new URL(text);
    if (url.href.length > 1024) throw new Error();
    return url.href;
  } catch {
    throw new MatchStoreError("Bitte gib einen gültigen Replay-Link mit https:// oder http:// an.");
  }
}

function validateMatch(match) {
  if (!match || !isSnowflake(match.guildId) || !isSnowflake(match.channelId) ||
      !Number.isInteger(match.season) || match.season < 1 || match.season > 9999 ||
      !Number.isInteger(match.matchday) || match.matchday < 1 || match.matchday > 25 ||
      !Array.isArray(match.players) || match.players.length !== 2 ||
      match.players.some((player) => !player || !isSnowflake(player.id) ||
        typeof player.name !== "string" || !player.name.trim() || player.name.length > 100) ||
      match.players[0].id === match.players[1].id) {
    throw new MatchStoreError("Ungültige Daten für das Replay-Archiv.");
  }
  normalizeReplayLink(match.link);
  // Older archives have neither field. Partial metadata must not silently enable a retry.
  if (match.id !== undefined || match.publication !== undefined) {
    if (typeof match.id !== "string" || !/^[a-f0-9]{24}$/.test(match.id)) {
      throw new MatchStoreError("Ungültige Match-ID im Replay-Archiv.");
    }
    validatePublication(match.publication);
  }
  if (match.revision !== undefined && (!Number.isSafeInteger(match.revision) || match.revision < 0)) {
    throw new MatchStoreError("Ungültige Report-Version im Replay-Archiv.");
  }
  if (match.change !== undefined) {
    if (match.publication?.status !== "published") throw new MatchStoreError("Änderungen benötigen einen veröffentlichten Report.");
    validateChange(match.change, match);
  }
}

function matchData(match) {
  validateMatch(match);
  return {
    guildId: match.guildId, channelId: match.channelId, season: match.season, matchday: match.matchday,
    players: match.players.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
    link: normalizeReplayLink(match.link),
  };
}

function sameMatch(a, b) {
  return a.guildId === b.guildId && a.channelId === b.channelId && a.season === b.season &&
    a.matchday === b.matchday && normalizeReplayLink(a.link) === normalizeReplayLink(b.link) &&
    a.players.map((player) => player.id).sort().join() === b.players.map((player) => player.id).sort().join();
}

function revisionOf(match) {
  return createHash("sha256").update(JSON.stringify(match)).digest("hex").slice(0, 16);
}

function validateChange(change, match) {
  if (!change || !["edit", "delete"].includes(change.kind)) throw new MatchStoreError("Ungültige laufende Report-Änderung.");
  if (change.kind === "delete") {
    if (Object.keys(change).length !== 1) throw new MatchStoreError("Ungültiger Löschauftrag.");
    return;
  }
  const target = change.target;
  if (Object.keys(change).sort().join() !== "embed,kind,target") throw new MatchStoreError("Ungültige Korrekturdaten.");
  if (!target || Object.keys(target).sort().join() !== "channelId,guildId,link,matchday,players,season") {
    throw new MatchStoreError("Ungültige Korrekturdaten.");
  }
  validateMatch(target);
  if (target.guildId !== match.guildId || target.channelId !== match.channelId) {
    throw new MatchStoreError("Ein Report kann nicht auf einen anderen Server oder in einen anderen Kanal verschoben werden.");
  }
  try {
    const embed = new EmbedBuilder(change.embed).toJSON();
    if (embed.author?.name !== `Season ${target.season} · Spieltag ${target.matchday}` ||
        embed.fields?.map((field) => field.name).join() !== "Gewinner,Verlierer,Score,Replay Link" ||
        embed.fields.slice(0, 3).some((field) => !field.value.startsWith("|| ") || !field.value.endsWith(" ||")) ||
        embed.fields[3].value !== target.link) throw new Error();
  } catch { throw new MatchStoreError("Ungültiger Ergebnispost für die Korrektur."); }
}

function parseMatchesDocument(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.matches)) throw new Error("Ungültiges Dateiformat des Replay-Archivs");
  const ids = new Set();
  for (const match of data.matches) {
    validateMatch(match);
    if (match.id && ids.has(match.id)) throw new Error("Doppelte Match-ID");
    if (match.id) ids.add(match.id);
  }
  return data;
}

class MatchStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.matches = [];
    try {
      const data = parseMatchesDocument(readFileSync(filePath, "utf8"));
      this.matches = data.matches;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new MatchStoreError(`Das Replay-Archiv konnte nicht gelesen werden: ${error.message}`);
      }
      // Check the data directory before the bot accepts its first report.
      this.save([]);
    }
  }

  list(guildId) {
    return structuredClone(this.matches.filter((match) => match.guildId === guildId));
  }

  get(id, guildId) {
    const match = this.matches.find((entry) => entry.id === id && entry.guildId === guildId);
    if (!match) throw new MatchStoreError("Dieser Report wurde im Archiv nicht gefunden oder bereits entfernt.");
    return structuredClone(match);
  }

  findByMessage(guildId, channelId, messageId) {
    const found = this.matches.filter((entry) => entry.guildId === guildId && entry.channelId === channelId &&
      entry.publication?.messageId === messageId);
    if (found.length !== 1) throw new MatchStoreError("Dieser Post ist nicht eindeutig mit dem Replay-Archiv verknüpft. Ältere Posts ohne gespeicherte Nachrichten-ID müssen manuell geprüft werden.");
    return structuredClone(found[0]);
  }

  add(match) {
    // Store only search metadata, with a stable order independent of the winner.
    const record = matchData(match);
    const duplicate = this.matches.find((entry) => sameMatch(entry, record) ||
      (entry.change?.kind === "edit" && sameMatch(entry.change.target, record)));
    if (duplicate) return structuredClone(duplicate);
    do {
      record.id = randomBytes(12).toString("hex");
    } while (this.matches.some((entry) => entry.id === record.id));
    record.publication = { status: "pending" };
    this.save([...this.matches, record]);
    return structuredClone(record);
  }

  beginChange(id, guildId, expectedRevision, change) {
    const match = this.get(id, guildId);
    if (revisionOf(match) !== expectedRevision || (match.change && change.kind !== "delete")) {
      throw new MatchStoreError("Dieser Report wurde inzwischen geändert. Bitte öffne die Aktion erneut am Ergebnispost.");
    }
    if (match.publication?.status !== "published") throw new MatchStoreError("Der Report wurde noch nicht bestätigt veröffentlicht.");
    validateChange(change, match);
    if (change.kind === "edit" && this.matches.some((entry) => entry.id !== id &&
        (sameMatch(entry, change.target) || (entry.change?.kind === "edit" && sameMatch(entry.change.target, change.target))))) {
      throw new MatchStoreError("Für diese Angaben existiert bereits ein anderer Report. Bitte prüfe die Season, den Spieltag und den Replay-Link.");
    }
    this.save(this.matches.map((entry) => entry.id === id ? { ...entry, change: structuredClone(change) } : entry));
  }

  finishChange(id, guildId, cancel = false) {
    const match = this.get(id, guildId);
    if (!match.change) throw new MatchStoreError("Für diesen Report läuft keine Änderung.");
    if (!cancel && match.change.kind === "delete") {
      this.save(this.matches.filter((entry) => entry.id !== id));
      return;
    }
    const { change, ...previous } = match;
    const record = cancel ? previous : { ...previous, ...change.target, revision: (match.revision || 0) + 1 };
    this.save(this.matches.map((entry) => entry.id === id ? record : entry));
  }

  setPublication(id, publication) {
    validatePublication(publication);
    const index = typeof id === "string" ? this.matches.findIndex((match) => match.id === id) : -1;
    if (index < 0) throw new MatchStoreError("Das Match wurde im Replay-Archiv nicht gefunden.");
    const previous = this.matches[index].publication.status;
    const next = publication.status;
    if (!((previous === "pending" && next === "sending") ||
        (previous === "sending" && ["pending", "published"].includes(next)))) {
      throw new MatchStoreError("Ungültiger Wechsel des Veröffentlichungsstatus.");
    }
    const matches = [...this.matches];
    matches[index] = { ...matches[index], publication: { ...publication } };
    this.save(matches);
  }

  save(matches) {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(temporaryPath, JSON.stringify({ version: 1, matches }, null, 2) + "\n", { flag: "wx" });
      renameSync(temporaryPath, this.filePath);
    } catch {
      try { unlinkSync(temporaryPath); } catch { /* No temporary file may have been created. */ }
      throw new MatchStoreError("Das Replay konnte nicht gespeichert werden. Bitte prüfe den Datenordner bzw. das Railway-Volume.");
    }
    this.matches = matches;
  }
}

module.exports = { MatchStore, MatchStoreError, normalizeReplayLink, parseMatchesDocument, matchData, revisionOf };
