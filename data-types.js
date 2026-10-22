/**
 * Shared storage contracts. JSDoc only; runtime validation stays in the stores.
 * Discord IDs are strings (17–20 digits), never JavaScript numbers.
 *
 * @typedef {object} Player
 * @property {string} id Discord user ID; stable even after a name or role change.
 * @property {string} name Display-name snapshot, 1–100 characters; not a live member reference.
 */

/**
 * @typedef {object} MatchData
 * @property {string} guildId Discord server ID.
 * @property {string} channelId Discord channel ID.
 * @property {number} season Integer, 1–9999.
 * @property {number} matchday Integer, 1–25.
 * @property {[Player, Player]} players Two distinct participants; stored sorted by ID, not by result.
 * @property {string} link Normalized HTTP(S) replay URL, at most 1024 characters.
 */

/** @typedef {{winnerId: string, loserId: string, score: string}} MatchResult */
/** @typedef {MatchData & {reporter?: Player, result?: MatchResult}} MatchSnapshot */

/**
 * @typedef {{status: 'pending' | 'sending', messageId?: undefined} |
 *   {status: 'published', messageId: string}} Publication
 */

/**
 * @typedef {{kind: 'delete', actor?: Player} |
 *   {kind: 'edit', target: MatchData, embed: import('discord.js').APIEmbed,
 *     actor?: Player, result?: MatchResult}} ReportChange
 */

/**
 * A stored report. Legacy imports may lack both id and publication, and also reporter/result.
 * New reports have a 24-character hex id and publication status. Pending changes are journals
 * for retrying an interrupted Discord action; revision counts completed edits.
 * @typedef {MatchSnapshot & {id?: string, publication?: Publication, createdAt?: string,
 *   revision?: number, controlsVersion?: 1, change?: ReportChange}} Match
 */

/**
 * @typedef {object} ScheduledSeason
 * @property {number} season Integer, 1–9999.
 * @property {number} matchdays Integer, 1–25.
 * @property {string} startDate Monday of matchday 1; new settings use YYYY-MM-DD.
 * @property {number} [currentMatchday] Legacy field; ignored when a start date exists.
 */

/**
 * Old manual settings remain readable until a scheduled season is configured.
 * @typedef {{season: number, matchdays: number, currentMatchday: number,
 *   startDate?: undefined}} ManualSeason
 */
/** @typedef {ScheduledSeason | ManualSeason} SeasonSettings */

/**
 * get() adds the current matchday, derived from Monday–Sunday in Europe/Berlin and
 * capped at 1..matchdays. Advancing a week does not write to storage.
 * @typedef {SeasonSettings & {currentMatchday: number}} ActiveSeason
 */

/**
 * @typedef {object} AuditWrite
 * @property {string} id Unique event ID; report ID plus action/revision.
 * @property {'created' | 'edited' | 'deleted' | 'imported'} action
 * @property {string} guildId
 * @property {number} season
 * @property {string} channelId
 * @property {string} reportId Report ID, or a legacy key for imports without an ID.
 * @property {string | null} messageId Null for imports without a confirmed Discord post.
 * @property {Player | null} actor Null when the original actor is unknown.
 * @property {MatchSnapshot | null} before Null for creation/import.
 * @property {MatchSnapshot | null} after Null for deletion.
 */

/** @typedef {AuditWrite & {at: string}} AuditEvent UTC ISO timestamp added by SQLite on write. */

module.exports = {};
