const { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } = require("node:fs");
const { dirname } = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");

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

  add(match) {
    validateMatch(match);
    // Store only search metadata, with a stable order independent of the winner.
    const record = {
      guildId: match.guildId,
      channelId: match.channelId,
      season: match.season,
      matchday: match.matchday,
      players: match.players.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
      link: normalizeReplayLink(match.link),
    };
    const duplicate = this.matches.find((entry) => entry.guildId === record.guildId &&
      entry.channelId === record.channelId && entry.season === record.season &&
      entry.matchday === record.matchday && entry.link === record.link &&
      entry.players.map((player) => player.id).sort().every((id, index) => id === record.players[index].id));
    if (duplicate) return structuredClone(duplicate);
    do {
      record.id = randomBytes(12).toString("hex");
    } while (this.matches.some((entry) => entry.id === record.id));
    record.publication = { status: "pending" };
    this.save([...this.matches, record]);
    return structuredClone(record);
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

module.exports = { MatchStore, MatchStoreError, normalizeReplayLink, parseMatchesDocument };
