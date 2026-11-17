const { readFileSync } = require("node:fs");
const { randomBytes, createHash } = require("node:crypto");
const { EmbedBuilder } = require("discord.js");
const { causedError } = require("../shared/diagnostics");
const { writeJsonAtomic } = require("./json-storage");
const { isRound, roundOf, seasonRoundLabel } = require("../league/season-rounds");

/** @typedef {import('../shared/data-types').Match} Match */
/** @typedef {import('../shared/data-types').MatchData} MatchData */

class MatchStoreError extends Error {}

const isSnowflake = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);

function validateActor(actor) {
  if (
    actor !== undefined &&
    (!actor ||
      !isSnowflake(actor.id) ||
      typeof actor.name !== "string" ||
      !actor.name.trim() ||
      actor.name.length > 100)
  ) {
    throw new MatchStoreError("Ungültige Person für das Änderungsprotokoll.");
  }
}

function validateResult(result, players) {
  if (
    result !== undefined &&
    (!result ||
      !players.some((player) => player.id === result.winnerId) ||
      !players.some((player) => player.id === result.loserId) ||
      result.winnerId === result.loserId ||
      typeof result.score !== "string" ||
      !result.score.trim() ||
      result.score.length > 100)
  ) {
    throw new MatchStoreError("Ungültiges gespeichertes Ergebnis.");
  }
}

/** @param {Match} record @returns {import('../shared/data-types').MatchSnapshot} */
const snapshot = (record) => ({
  ...matchData(record),
  ...(record.reporter ? { reporter: record.reporter } : {}),
  ...(record.result ? { result: record.result } : {}),
});

function validatePublication(publication) {
  if (
    !publication ||
    !["pending", "sending", "published"].includes(publication.status) ||
    (publication.status === "published"
      ? !isSnowflake(publication.messageId)
      : publication.messageId !== undefined)
  ) {
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
  if (
    !match ||
    !isSnowflake(match.guildId) ||
    !isSnowflake(match.channelId) ||
    !Number.isInteger(match.season) ||
    match.season < 1 ||
    match.season > 9999 ||
    !Array.isArray(match.players) ||
    match.players.length !== 2 ||
    match.players.some(
      (player) =>
        !player ||
        !isSnowflake(player.id) ||
        typeof player.name !== "string" ||
        !player.name.trim() ||
        player.name.length > 100,
    ) ||
    match.players[0].id === match.players[1].id
  ) {
    throw new MatchStoreError("Ungültige Daten für das Replay-Archiv.");
  }
  if (
    match.round !== undefined
      ? !isRound(match.round) ||
        (match.round.kind === "league"
          ? match.matchday !== match.round.matchday
          : match.matchday !== undefined)
      : !Number.isInteger(match.matchday) || match.matchday < 1 || match.matchday > 25
  ) {
    throw new MatchStoreError("Ungültige Daten für die Runde im Replay-Archiv.");
  }
  normalizeReplayLink(match.link);
  validateActor(match.reporter);
  validateResult(match.result, match.players);
  if (
    match.createdAt !== undefined &&
    (typeof match.createdAt !== "string" || !Number.isFinite(Date.parse(match.createdAt)))
  ) {
    throw new MatchStoreError("Ungültiger Erstellungszeitpunkt.");
  }
  if (match.controlsVersion !== undefined && match.controlsVersion !== 1)
    throw new MatchStoreError("Ungültige Button-Version.");
  // Older archives have neither field. Partial metadata must not silently enable a retry.
  if (match.id !== undefined || match.publication !== undefined) {
    if (typeof match.id !== "string" || !/^[a-f0-9]{24}$/.test(match.id)) {
      throw new MatchStoreError("Ungültige Match-ID im Replay-Archiv.");
    }
    validatePublication(match.publication);
  }
  if (
    match.revision !== undefined &&
    (!Number.isSafeInteger(match.revision) || match.revision < 0)
  ) {
    throw new MatchStoreError("Ungültige Report-Version im Replay-Archiv.");
  }
  if (match.change !== undefined) {
    if (match.publication?.status !== "published")
      throw new MatchStoreError("Änderungen benötigen einen veröffentlichten Report.");
    validateChange(match.change, match);
  }
}

/** @param {Match} match @returns {MatchData} */
function matchData(match) {
  validateMatch(match);
  return {
    guildId: match.guildId,
    channelId: match.channelId,
    season: match.season,
    ...(match.matchday !== undefined ? { matchday: match.matchday } : {}),
    ...(match.round !== undefined ? { round: structuredClone(match.round) } : {}),
    players: match.players
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    link: normalizeReplayLink(match.link),
  };
}

function sameMatch(a, b) {
  return (
    a.guildId === b.guildId &&
    a.channelId === b.channelId &&
    a.season === b.season &&
    roundOf(a).id === roundOf(b).id &&
    normalizeReplayLink(a.link) === normalizeReplayLink(b.link) &&
    a.players
      .map((player) => player.id)
      .sort()
      .join() ===
      b.players
        .map((player) => player.id)
        .sort()
        .join()
  );
}

function revisionOf(match) {
  return createHash("sha256").update(JSON.stringify(match)).digest("hex").slice(0, 16);
}

function validateChange(change, match) {
  if (!change || !["edit", "delete"].includes(change.kind))
    throw new MatchStoreError("Ungültige laufende Report-Änderung.");
  validateActor(change.actor);
  if (change.kind === "delete") {
    if (Object.keys(change).some((key) => !["kind", "actor"].includes(key)))
      throw new MatchStoreError("Ungültiger Löschauftrag.");
    return;
  }
  const target = change.target;
  if (
    Object.keys(change)
      .filter((key) => !["actor", "result"].includes(key))
      .sort()
      .join() !== "embed,kind,target"
  )
    throw new MatchStoreError("Ungültige Korrekturdaten.");
  if (
    !target ||
    Object.keys(target)
      .filter((key) => !["round", "matchday"].includes(key))
      .sort()
      .join() !== "channelId,guildId,link,players,season"
  ) {
    throw new MatchStoreError("Ungültige Korrekturdaten.");
  }
  validateMatch(target);
  validateResult(change.result, target.players);
  if (target.guildId !== match.guildId || target.channelId !== match.channelId) {
    throw new MatchStoreError(
      "Ein Report kann nicht auf einen anderen Server oder in einen anderen Kanal verschoben werden.",
    );
  }
  try {
    const embed = new EmbedBuilder(change.embed).toJSON();
    if (
      embed.author?.name !== seasonRoundLabel(target) ||
      embed.fields?.map((field) => field.name).join() !== "Gewinner,Verlierer,Score,Replay Link" ||
      embed.fields
        .slice(0, 3)
        .some((field) => !field.value.startsWith("|| ") || !field.value.endsWith(" ||")) ||
      embed.fields[3].value !== target.link
    )
      throw new Error();
  } catch {
    throw new MatchStoreError("Ungültiger Ergebnispost für die Korrektur.");
  }
}

/** @param {string} text @returns {{version: 1, matches: Match[]}} */
function parseMatchesDocument(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.matches))
    throw new Error("Ungültiges Dateiformat des Replay-Archivs");
  const ids = new Set();
  for (const match of data.matches) {
    validateMatch(match);
    if (match.id && ids.has(match.id)) throw new Error("Doppelte Match-ID");
    if (match.id) ids.add(match.id);
  }
  return data;
}

class MatchStore {
  /**
   * @param {string} filePath JSON path, or database path when storage is supplied.
   * @param {import('./database').LigaDatabase} [storage]
   */
  constructor(filePath, storage) {
    this.filePath = filePath;
    this.storage = storage;
    if (storage) return;
    /** @type {Match[]} Only used by the legacy JSON file adapter. */
    this.matches = [];
    try {
      const data = parseMatchesDocument(readFileSync(filePath, "utf8"));
      this.matches = data.matches;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw causedError(
          MatchStoreError,
          "Das Replay-Archiv konnte nicht gelesen werden. Bitte Datenspeicher und Dateiformat prüfen.",
          error,
          { operation: "archive.read", file: "matches.json" },
        );
      }
      // Check the data directory before the bot accepts its first report.
      this.saveJson([]);
    }
  }

  /** @param {string} guildId @param {number} [season] @returns {Match[]} */
  list(guildId, season, { candidatesOnly = false, publishedOnly = false } = {}) {
    try {
      if (this.storage)
        return candidatesOnly
          ? this.storage.replayCandidates(guildId, season, publishedOnly)
          : this.storage.listMatches(guildId, season, publishedOnly);
      return structuredClone(
        this.matches.filter(
          (match) =>
            match.guildId === guildId &&
            (season === undefined || match.season === season) &&
            (!publishedOnly || match.publication?.status === "published"),
        ),
      );
    } catch (error) {
      throw causedError(
        MatchStoreError,
        "Das Replay-Archiv konnte nicht gelesen werden. Bitte den Datenspeicher prüfen.",
        error,
        { operation: "archive.read", file: "liga.sqlite", guildId, season },
      );
    }
  }

  findReplays(guildId, season, playerId, channelIds, filters) {
    if (this.storage)
      return this.storage.findReplays(guildId, season, playerId, channelIds, filters);
    return this.list(guildId, season).filter(
      (match) =>
        channelIds.includes(match.channelId) &&
        (filters.matchday == null || match.matchday === filters.matchday) &&
        (!filters.roundId || roundOf(match).id === filters.roundId) &&
        match.players.some((player) => player.id === playerId),
    );
  }

  lookup(id, guildId) {
    if (typeof id !== "string") return undefined;
    const match = this.storage
      ? this.storage.getReport(id, guildId)
      : this.matches.find(
          (entry) => entry.id === id && (guildId === undefined || entry.guildId === guildId),
        );
    return match?.id === id ? match : undefined;
  }

  /** @param {string} id @param {string} guildId @returns {Match} */
  get(id, guildId) {
    const match = guildId && this.lookup(id, guildId);
    if (!match)
      throw new MatchStoreError(
        "Dieser Report wurde im Archiv nicht gefunden oder bereits entfernt.",
      );
    return structuredClone(match);
  }

  findByMessage(guildId, channelId, messageId) {
    const found = this.storage
      ? this.storage.reportsByMessage(guildId, channelId, messageId)
      : this.matches.filter(
          (entry) =>
            entry.guildId === guildId &&
            entry.channelId === channelId &&
            entry.publication?.messageId === messageId,
        );
    if (found.length !== 1)
      throw new MatchStoreError(
        "Dieser Post ist nicht eindeutig mit dem Replay-Archiv verknüpft. Ältere Posts ohne gespeicherte Nachrichten-ID müssen manuell geprüft werden.",
      );
    return structuredClone(found[0]);
  }

  missingButtons() {
    return this.storage
      ? this.storage.reportsMissingButtons()
      : this.matches.filter(
          (entry) => entry.publication?.status === "published" && entry.controlsVersion !== 1,
        );
  }

  /** @param {import('../shared/data-types').MatchSnapshot} match @returns {Match} */
  add(match) {
    // Keep the match identity independent of the winner; ownership is stored separately.
    /** @type {Match} */
    const record = matchData(match);
    record.id = randomBytes(12).toString("hex");
    record.publication = { status: "pending" };
    if (match.reporter) record.reporter = structuredClone(match.reporter);
    if (match.result) record.result = structuredClone(match.result);
    if (match.reporter) record.createdAt = new Date().toISOString();
    return this.persist(record);
  }

  beginChange(id, guildId, expectedRevision, change, actor) {
    const match = this.get(id, guildId);
    if (revisionOf(match) !== expectedRevision || (match.change && change.kind !== "delete")) {
      throw new MatchStoreError(
        "Dieser Report wurde inzwischen geändert. Bitte öffne die Aktion erneut am Ergebnispost.",
      );
    }
    if (match.publication?.status !== "published")
      throw new MatchStoreError("Der Report wurde noch nicht bestätigt veröffentlicht.");
    const operation = { ...structuredClone(change), ...(actor ? { actor } : {}) };
    validateChange(operation, match);
    this.persist({ ...match, change: operation }, match);
  }

  finishChange(id, guildId, cancel = false, actor) {
    const match = this.get(id, guildId);
    if (!match.change) throw new MatchStoreError("Für diesen Report läuft keine Änderung.");
    if (!cancel && match.change.kind === "delete") {
      this.persist(null, match, {
        id: `${id}:deleted:${(match.revision || 0) + 1}`,
        action: "deleted",
        guildId,
        season: match.season,
        channelId: match.channelId,
        reportId: id,
        messageId: match.publication.messageId,
        actor: match.change.actor || actor || null,
        before: snapshot(match),
        after: null,
      });
      return;
    }
    const { change, ...previous } = match;
    const record = cancel
      ? previous
      : {
          ...previous,
          matchday: undefined,
          round: undefined,
          ...change.target,
          result: change.result,
          controlsVersion: 1,
          revision: (match.revision || 0) + 1,
        };
    this.persist(
      record,
      match,
      cancel
        ? undefined
        : {
            id: `${id}:edited:${record.revision}`,
            action: "edited",
            guildId,
            season: record.season,
            channelId: record.channelId,
            reportId: id,
            messageId: record.publication.messageId,
            actor: change.actor || actor || null,
            before: snapshot(previous),
            after: snapshot(record),
          },
    );
  }

  setPublication(id, publication) {
    validatePublication(publication);
    const match = this.lookup(id);
    if (!match) throw new MatchStoreError("Das Match wurde im Replay-Archiv nicht gefunden.");
    const previous = match.publication.status;
    const next = publication.status;
    if (!(
      (previous === "pending" && next === "sending") ||
      (previous === "sending" && ["pending", "published"].includes(next))
    )) {
      throw new MatchStoreError("Ungültiger Wechsel des Veröffentlichungsstatus.");
    }
    const record = {
      ...match,
      publication: { ...publication },
      ...(publication.status === "published" ? { controlsVersion: 1 } : {}),
    };
    this.persist(
      record,
      match,
      publication.status !== "published"
        ? undefined
        : {
            id: `${id}:created`,
            action: "created",
            guildId: record.guildId,
            season: record.season,
            channelId: record.channelId,
            reportId: id,
            messageId: publication.messageId,
            actor: record.reporter || null,
            before: null,
            after: snapshot(record),
          },
    );
  }

  markControlsInstalled(id, guildId) {
    const record = this.get(id, guildId);
    this.persist({ ...record, controlsVersion: 1 }, record);
  }

  findDuplicate(target, exceptId) {
    const candidates = this.storage ? this.storage.possibleDuplicates(target) : this.matches;
    // An interrupted edit reserves both its original match and its proposed target.
    return candidates.find(
      (entry) =>
        (exceptId === undefined || entry.id !== exceptId) &&
        (sameMatch(entry, target) ||
          (entry.change?.kind === "edit" && sameMatch(entry.change.target, target))),
    );
  }

  /**
   * Insert, update or delete exactly one report, together with its audit event.
   * @param {Match | null} next
   * @param {Match} [previous]
   * @param {import('../shared/data-types').AuditWrite} [event]
   */
  persist(next, previous, event) {
    const record = next || previous;
    const context = {
      ...record,
      operation: "archive.write",
      file: this.storage ? "liga.sqlite" : "matches.json",
      reportId: record.id,
      messageId: record.publication?.messageId,
    };
    try {
      const write = () => {
        if (!previous) {
          const existing = this.findDuplicate(next);
          if (existing) return structuredClone(existing);
          while (this.lookup(next.id)) next.id = randomBytes(12).toString("hex");
        } else {
          if (revisionOf(this.get(previous.id, previous.guildId)) !== revisionOf(previous))
            throw new MatchStoreError(
              "Dieser Report wurde inzwischen geändert. Bitte öffne die Aktion erneut am Ergebnispost.",
            );
          if (
            !previous.change &&
            next?.change?.kind === "edit" &&
            this.findDuplicate(next.change.target, previous.id)
          )
            throw new MatchStoreError(
              "Für diese Angaben existiert bereits ein anderer Report. Bitte prüfe die Season, den Spieltag und den Replay-Link.",
            );
        }
        if (this.storage) {
          this.storage.writeReport(next, previous);
          if (event) this.storage.writeEvent(event);
        } else {
          if (!previous) this.saveJson([...this.matches, next]);
          else if (next)
            this.saveJson(this.matches.map((entry) => (entry.id === previous.id ? next : entry)));
          else this.saveJson(this.matches.filter((entry) => entry.id !== previous.id));
        }
        return structuredClone(next);
      };
      return this.storage ? this.storage.transaction(write) : write();
    } catch (error) {
      if (error instanceof MatchStoreError) throw error;
      const message = this.storage
        ? "Das Replay und sein Änderungsprotokoll konnten nicht gespeichert werden. Bitte Datenbank und freien Speicher prüfen."
        : "Das Replay konnte nicht gespeichert werden. Bitte prüfe den Datenordner bzw. das Railway-Volume.";
      throw causedError(MatchStoreError, message, error, context);
    }
  }

  saveJson(matches) {
    if (this.storage) throw new Error("Dieser Speicher verwendet SQLite.");
    writeJsonAtomic(this.filePath, { version: 1, matches });
    this.matches = structuredClone(matches);
  }
}

module.exports = {
  MatchStore,
  MatchStoreError,
  normalizeReplayLink,
  parseMatchesDocument,
  matchData,
  revisionOf,
  snapshot,
  validateMatch,
};
