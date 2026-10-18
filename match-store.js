const { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } = require("node:fs");
const { dirname } = require("node:path");
const { randomUUID } = require("node:crypto");

class MatchStoreError extends Error {}

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
  const snowflake = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);
  if (!match || !snowflake(match.guildId) || !snowflake(match.channelId) ||
      !Number.isInteger(match.season) || match.season < 1 || match.season > 9999 ||
      !Number.isInteger(match.matchday) || match.matchday < 1 || match.matchday > 25 ||
      !Array.isArray(match.players) || match.players.length !== 2 ||
      match.players.some((player) => !player || !snowflake(player.id) ||
        typeof player.name !== "string" || !player.name.trim() || player.name.length > 100) ||
      match.players[0].id === match.players[1].id) {
    throw new MatchStoreError("Ungültige Daten für das Replay-Archiv.");
  }
  normalizeReplayLink(match.link);
}

class MatchStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.matches = [];
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.matches)) throw new Error("Ungültiges Dateiformat");
      for (const match of data.matches) validateMatch(match);
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
    const duplicate = this.matches.some((entry) => entry.guildId === record.guildId &&
      entry.channelId === record.channelId && entry.season === record.season &&
      entry.matchday === record.matchday && entry.link === record.link &&
      entry.players.every((player, index) => player.id === record.players[index].id));
    if (!duplicate) this.save([...this.matches, record]);
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

module.exports = { MatchStore, MatchStoreError, normalizeReplayLink };
