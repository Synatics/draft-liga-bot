// The two participant slots keep historical names even for old replays with no known result.
// Discord IDs are TEXT: snowflakes can exceed JavaScript's safe integer range.
const SCHEMA = `
  CREATE TABLE seasons (
    guild_id TEXT NOT NULL, season INTEGER NOT NULL CHECK (season BETWEEN 1 AND 9999),
    is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
    matchdays INTEGER NOT NULL CHECK (matchdays BETWEEN 1 AND 25),
    start_date TEXT, current_matchday INTEGER, format TEXT, redraft INTEGER CHECK (redraft IN (0,1)),
    playoffs_from TEXT, rounds_json TEXT CHECK (rounds_json IS NULL OR json_valid(rounds_json)),
    PRIMARY KEY (guild_id, season)
  ) STRICT;
  CREATE UNIQUE INDEX current_season ON seasons(guild_id) WHERE is_current=1;

  CREATE TABLE reports (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    season INTEGER NOT NULL CHECK (season BETWEEN 1 AND 9999),
    matchday INTEGER CHECK (matchday BETWEEN 1 AND 25), round_id TEXT, leg TEXT,
    player1_id TEXT NOT NULL, player1_name TEXT NOT NULL, player2_id TEXT NOT NULL, player2_name TEXT NOT NULL,
    winner_id TEXT, loser_id TEXT, score TEXT, replay_url TEXT NOT NULL,
    reporter_id TEXT, reporter_name TEXT, created_at TEXT,
    publication_status TEXT CHECK (publication_status IN ('pending','sending','published')),
    message_id TEXT, revision INTEGER CHECK (revision >= 0), controls_version INTEGER CHECK (controls_version=1),
    pending_change_json TEXT CHECK (pending_change_json IS NULL OR json_valid(pending_change_json)),
    CHECK (player1_id <> player2_id),
    CHECK ((winner_id IS NULL AND loser_id IS NULL AND score IS NULL)
      OR (winner_id IS NOT NULL AND loser_id IS NOT NULL AND score IS NOT NULL
        AND ((winner_id=player1_id AND loser_id=player2_id) OR (winner_id=player2_id AND loser_id=player1_id)))),
    CHECK ((reporter_id IS NULL) = (reporter_name IS NULL)),
    CHECK ((publication_status IS 'published') = (message_id IS NOT NULL)),
    CHECK (pending_change_json IS NULL OR publication_status IS 'published'),
    CHECK ((matchday IS NOT NULL AND (round_id IS NULL OR round_id='matchday-' || matchday))
      OR (matchday IS NULL AND round_id IS NOT NULL AND round_id IN ('round-of-16','quarterfinal','semifinal','final'))),
    CHECK (leg IS NULL OR (round_id IS NOT NULL AND matchday IS NOT NULL AND leg IN ('first','second')))
  ) STRICT;
  CREATE INDEX reports_season ON reports(guild_id, season);
  CREATE INDEX reports_message ON reports(guild_id, channel_id, message_id) WHERE message_id IS NOT NULL;
  CREATE INDEX reports_winner ON reports(guild_id, winner_id, loser_id) WHERE publication_status='published';
  CREATE INDEX reports_loser ON reports(guild_id, loser_id, winner_id) WHERE publication_status='published';

  CREATE VIEW report_overview AS
    SELECT season, matchday, COALESCE(round_id, 'matchday-' || matchday) AS round_id, leg,
      player1_name, player2_name,
      CASE winner_id WHEN player1_id THEN player1_name WHEN player2_id THEN player2_name END AS winner_name,
      CASE loser_id WHEN player1_id THEN player1_name WHEN player2_id THEN player2_name END AS loser_name,
      score, replay_url, reporter_name, publication_status, guild_id, channel_id, id
    FROM reports;

  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, season INTEGER NOT NULL CHECK (season BETWEEN 1 AND 9999),
    report_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
    occurred_at TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('created','edited','deleted','imported')),
    actor_id TEXT, actor_name TEXT,
    before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
    CHECK ((actor_id IS NULL) = (actor_name IS NULL)),
    CHECK ((action IN ('edited','deleted')) = (before_json IS NOT NULL)),
    CHECK ((action <> 'deleted') = (after_json IS NOT NULL))
  ) STRICT;
  CREATE INDEX audit_season ON audit_events(guild_id, season, occurred_at);
`;

function reportRow(id, record) {
  const [first, second] = record.players;
  return {
    id,
    guild_id: record.guildId,
    channel_id: record.channelId,
    season: record.season,
    matchday: record.matchday ?? null,
    round_id: record.round?.id ?? null,
    leg: record.round?.leg ?? null,
    player1_id: first.id,
    player1_name: first.name,
    player2_id: second.id,
    player2_name: second.name,
    winner_id: record.result?.winnerId ?? null,
    loser_id: record.result?.loserId ?? null,
    score: record.result?.score ?? null,
    replay_url: record.link,
    reporter_id: record.reporter?.id ?? null,
    reporter_name: record.reporter?.name ?? null,
    created_at: record.createdAt ?? null,
    publication_status: record.publication?.status ?? null,
    message_id: record.publication?.messageId ?? null,
    revision: record.revision ?? null,
    controls_version: record.controlsVersion ?? null,
    pending_change_json: record.change ? JSON.stringify(record.change) : null,
  };
}

const REPLAY_COLUMNS =
  "guild_id, channel_id, season, matchday, round_id, leg, player1_id, player1_name, player2_id, player2_name";

function replayFromRow(row) {
  const record = { guildId: row.guild_id, channelId: row.channel_id, season: row.season };
  if (row.matchday !== null) record.matchday = row.matchday;
  if (row.round_id !== null) {
    record.round =
      row.matchday === null
        ? { id: row.round_id, kind: "playoffs" }
        : {
            id: row.round_id,
            kind: "league",
            matchday: row.matchday,
            ...(row.leg ? { leg: row.leg } : {}),
          };
  }
  record.players = [
    { id: row.player1_id, name: row.player1_name },
    { id: row.player2_id, name: row.player2_name },
  ];
  if (Object.hasOwn(row, "replay_url")) record.link = row.replay_url;
  return record;
}

function reportFromRow(row) {
  const record = replayFromRow(row);
  if (row.publication_status !== null) {
    record.id = row.id;
    record.publication = { status: row.publication_status };
    if (row.message_id !== null) record.publication.messageId = row.message_id;
  }
  if (row.reporter_id !== null) record.reporter = { id: row.reporter_id, name: row.reporter_name };
  if (row.winner_id !== null)
    record.result = { winnerId: row.winner_id, loserId: row.loser_id, score: row.score };
  if (row.created_at !== null) record.createdAt = row.created_at;
  if (row.controls_version !== null) record.controlsVersion = row.controls_version;
  if (row.revision !== null) record.revision = row.revision;
  if (row.pending_change_json !== null) record.change = JSON.parse(row.pending_change_json);
  return record;
}

function seasonRow(guildId, settings, current) {
  return {
    guild_id: guildId,
    season: settings.season,
    is_current: Number(current),
    matchdays: settings.matchdays,
    start_date: settings.startDate ?? null,
    current_matchday: settings.currentMatchday ?? null,
    format: settings.format ?? null,
    redraft: settings.redraft === undefined ? null : Number(settings.redraft),
    playoffs_from: settings.playoffsFrom ?? null,
    rounds_json: settings.rounds ? JSON.stringify(settings.rounds) : null,
  };
}

function seasonFromRow(row) {
  const settings = { season: row.season, matchdays: row.matchdays };
  if (row.start_date !== null) settings.startDate = row.start_date;
  if (row.current_matchday !== null) settings.currentMatchday = row.current_matchday;
  if (row.format !== null) settings.format = row.format;
  if (row.redraft !== null) settings.redraft = Boolean(row.redraft);
  if (row.playoffs_from !== null) settings.playoffsFrom = row.playoffs_from;
  if (row.rounds_json !== null) settings.rounds = JSON.parse(row.rounds_json);
  return settings;
}

function eventRow(event) {
  return {
    id: event.id,
    guild_id: event.guildId,
    season: event.season,
    report_id: event.reportId,
    channel_id: event.channelId,
    message_id: event.messageId,
    occurred_at: event.at,
    action: event.action,
    actor_id: event.actor?.id ?? null,
    actor_name: event.actor?.name ?? null,
    before_json: event.before ? JSON.stringify(event.before) : null,
    after_json: event.after ? JSON.stringify(event.after) : null,
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    season: row.season,
    reportId: row.report_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    at: row.occurred_at,
    action: row.action,
    actor: row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name },
    before: JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
  };
}

module.exports = {
  SCHEMA,
  REPLAY_COLUMNS,
  reportRow,
  reportFromRow,
  replayFromRow,
  seasonRow,
  seasonFromRow,
  eventRow,
  eventFromRow,
};
