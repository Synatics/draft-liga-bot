const { createHash } = require("node:crypto");
const FORMAT_NAMES = {
  league: "Liga ohne Playoffs",
  playoffs: "Liga mit Playoffs",
  "home-away": "Hin- und Rückrunde ohne Playoffs",
};

const PLAYOFF_STAGES = ["round-of-16", "quarterfinal", "semifinal", "final"];
const STAGE_NAMES = {
  "round-of-16": "Achtelfinale",
  quarterfinal: "Viertelfinale",
  semifinal: "Halbfinale",
  final: "Finale",
};

function leagueRound(matchday, leg) {
  return { id: `matchday-${matchday}`, kind: "league", matchday, ...(leg ? { leg } : {}) };
}

function isRound(round, allowBreak = false) {
  if (!round || typeof round !== "object" || Array.isArray(round)) return false;
  if (round.kind === "break") {
    return allowBreak && round.id === "redraft" && Object.keys(round).sort().join() === "id,kind";
  }
  if (round.kind === "playoffs") {
    return PLAYOFF_STAGES.includes(round.id) && Object.keys(round).sort().join() === "id,kind";
  }
  return (
    round.kind === "league" &&
    Number.isInteger(round.matchday) &&
    round.matchday >= 1 &&
    round.matchday <= 25 &&
    round.id === `matchday-${round.matchday}` &&
    (round.leg === undefined || ["first", "second"].includes(round.leg)) &&
    Object.keys(round).sort().join() ===
      (round.leg === undefined ? "id,kind,matchday" : "id,kind,leg,matchday")
  );
}

function buildRounds(matchdays, { format = "league", redraft = false, playoffsFrom } = {}) {
  if (!Number.isInteger(matchdays) || matchdays < 1 || matchdays > 25)
    throw new Error("Die Anzahl der Spieltage muss zwischen 1 und 25 liegen.");
  if (!["league", "playoffs", "home-away"].includes(format))
    throw new Error("Bitte ein gültiges Season-Format auswählen.");
  if (typeof redraft !== "boolean") throw new Error("Redraft muss Ja oder Nein sein.");
  if (format !== "playoffs" && playoffsFrom !== undefined)
    throw new Error("Eine erste Playoff-Runde ist nur beim Format Liga mit Playoffs möglich.");
  if (format === "league" && redraft)
    throw new Error("Eine Redraft-Woche benötigt eine folgende Rückrunde oder Playoffs.");
  if (format === "home-away" && matchdays % 2 !== 0)
    throw new Error(
      "Für Hin- und Rückrunde muss die Gesamtzahl der Spieltage gerade sein, z. B. 18 für zweimal 9.",
    );
  const rounds = [];
  for (let day = 1; day <= matchdays; day++) {
    if (format === "home-away" && redraft && day === matchdays / 2 + 1)
      rounds.push({ id: "redraft", kind: "break" });
    rounds.push(
      leagueRound(
        day,
        format === "home-away" ? (day <= matchdays / 2 ? "first" : "second") : undefined,
      ),
    );
  }
  if (format === "playoffs") {
    const first = playoffsFrom ?? "semifinal";
    if (!PLAYOFF_STAGES.includes(first))
      throw new Error("Bitte eine gültige erste Playoff-Runde auswählen.");
    if (redraft) rounds.push({ id: "redraft", kind: "break" });
    rounds.push(
      ...PLAYOFF_STAGES.slice(PLAYOFF_STAGES.indexOf(first)).map((id) => ({
        id,
        kind: "playoffs",
      })),
    );
  }
  if (rounds.filter((round) => round.kind !== "break").length > 25)
    throw new Error(
      "Das Report-Dropdown unterstützt insgesamt höchstens 25 spielbare Runden einschließlich Playoffs. Bitte weniger reguläre Spieltage wählen.",
    );
  return rounds;
}

function playableRounds(settings) {
  return settings.rounds
    ? settings.rounds.filter((round) => round.kind !== "break")
    : Array.from({ length: settings.matchdays }, (_, index) => leagueRound(index + 1));
}

function roundOf(match) {
  return match.round ?? leagueRound(match.matchday);
}

function roundLabel(round) {
  if (round.kind === "break") return "Redraft";
  if (round.kind === "playoffs") return `Playoffs · ${STAGE_NAMES[round.id]}`;
  return `${round.leg === "first" ? "Hinrunde · " : round.leg === "second" ? "Rückrunde · " : ""}Spieltag ${round.matchday}`;
}

const matchRoundLabel = (match) => roundLabel(roundOf(match));
const seasonRoundLabel = (match) => `Season ${match.season} · ${matchRoundLabel(match)}`;
const roundFields = (round) => ({
  round: structuredClone(round),
  ...(round.kind === "league" ? { matchday: round.matchday } : {}),
});
const roundOrder = (match) => {
  const round = roundOf(match);
  return round.kind === "league" ? round.matchday : 100 + PLAYOFF_STAGES.indexOf(round.id);
};
const planToken = (settings) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        season: settings.season,
        startDate: settings.startDate,
        rounds: settings.rounds,
      }),
    )
    .digest("hex")
    .slice(0, 12);

function selectedRound(fields, field, rounds) {
  let values;
  try {
    values = fields.getStringSelectValues(field);
  } catch {
    return undefined;
  }
  return Array.isArray(values) && values.length === 1
    ? rounds.find((round) => round.id === values[0])
    : undefined;
}

function resolveRoundFilter(input, matches) {
  if (PLAYOFF_STAGES.includes(input) || /^matchday-([1-9]|1\d|2[0-5])$/.test(input)) return input;
  const text = String(input).trim().toLocaleLowerCase("de");
  return matches
    .map(roundOf)
    .find(
      (round) =>
        roundLabel(round).toLocaleLowerCase("de") === text ||
        STAGE_NAMES[round.id]?.toLocaleLowerCase("de") === text,
    )?.id;
}

function roundChoices(matches, input) {
  const query = String(input).trim().toLocaleLowerCase("de");
  const rounds = new Map(
    [...matches]
      .sort((a, b) => roundOrder(a) - roundOrder(b))
      .map((match) => [roundOf(match).id, roundOf(match)]),
  );
  return [...rounds.values()]
    .filter((round) => roundLabel(round).toLocaleLowerCase("de").includes(query))
    .slice(0, 25)
    .map((round) => ({ name: roundLabel(round), value: round.id }));
}

module.exports = {
  FORMAT_NAMES,
  PLAYOFF_STAGES,
  STAGE_NAMES,
  leagueRound,
  isRound,
  buildRounds,
  playableRounds,
  roundOf,
  roundLabel,
  matchRoundLabel,
  seasonRoundLabel,
  roundFields,
  roundOrder,
  planToken,
  selectedRound,
  resolveRoundFilter,
  roundChoices,
};
