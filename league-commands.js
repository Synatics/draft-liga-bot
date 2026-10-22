const {
  ApplicationCommandOptionType,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");
const { LeagueSettingsError } = require("./league-settings");
const { isLeagueManager, currentMember } = require("./permissions");
const { handleAuditCommand } = require("./audit-commands");
const { STAGE_NAMES, roundLabel } = require("./season-rounds");

const leagueCommand = {
  name: "liga",
  description: "Seasonplan und aktuelle Runde der Liga verwalten",
  contexts: [InteractionContextType.Guild],
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "log",
      description: "Änderungsprotokoll einer Season als Datei per DM erhalten",
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: "season",
          description: "Season des Protokolls",
          required: true,
          min_value: 1,
          max_value: 9999,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "season",
      description: "Seasonplan mit Liga, Playoffs oder Hin- und Rückrunde einrichten",
      options: [
        {
          type: ApplicationCommandOptionType.Integer,
          name: "nummer",
          description: "Nummer der Season",
          required: true,
          min_value: 1,
          max_value: 9999,
        },
        {
          type: ApplicationCommandOptionType.Integer,
          name: "spieltage",
          description:
            "Reguläre Spieltage insgesamt; bei Hin-/Rückrunde beide Hälften zusammen, ohne Playoffs",
          required: true,
          min_value: 1,
          max_value: 25,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "startdatum",
          description: "Montag von Spieltag 1 (TT.MM.JJJJ oder JJJJ-MM-TT)",
          required: true,
          min_length: 10,
          max_length: 10,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "format",
          description: "Season-Format (Standard: Liga ohne Playoffs)",
          choices: [
            { name: "Liga ohne Playoffs", value: "league" },
            { name: "Liga mit Playoffs", value: "playoffs" },
            { name: "Hin- und Rückrunde ohne Playoffs", value: "home-away" },
          ],
        },
        {
          type: ApplicationCommandOptionType.Boolean,
          name: "redraft",
          description:
            "Eine Redraft-Woche vor Playoffs bzw. zwischen Hin- und Rückrunde (Standard: Nein)",
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "playoffs_ab",
          description: "Erste Playoff-Runde (bei Liga mit Playoffs Standard: Halbfinale)",
          choices: Object.entries(STAGE_NAMES).map(([value, name]) => ({ name, value })),
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "status",
      description: "Aktuelle Season, Runde oder Redraft anzeigen",
    },
  ],
};

async function handleLeagueCommand(interaction, settingsStore, database, config = {}) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "log") return handleAuditCommand(interaction, database, config);
  if (!isLeagueManager(interaction, config.managerRoleId)) {
    throw new LeagueSettingsError(
      "Zum Verwalten der Liga brauchst du die Ligaverwaltungsrolle oder „Server verwalten“.",
    );
  }
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const member = await currentMember(interaction);
  if (!isLeagueManager(interaction, config.managerRoleId, member))
    throw new LeagueSettingsError("Du darfst die Liga nicht mehr verwalten.");
  let settings;
  if (subcommand === "season") {
    const format = interaction.options.getString("format");
    const redraft = interaction.options.getBoolean?.("redraft");
    const playoffsFrom = interaction.options.getString("playoffs_ab");
    settings = settingsStore.setSeason(
      interaction.guild.id,
      interaction.options.getInteger("nummer", true),
      interaction.options.getInteger("spieltage", true),
      interaction.options.getString("startdatum", true),
      format != null || redraft != null || playoffsFrom != null
        ? {
            format: format ?? (playoffsFrom ? "playoffs" : "league"),
            redraft: redraft ?? false,
            playoffsFrom: playoffsFrom ?? undefined,
          }
        : undefined,
    );
  } else if (subcommand === "spieltag") {
    throw new LeagueSettingsError(
      "Der Spieltag wird jetzt automatisch bestimmt. Bitte das Startdatum über /liga season einstellen.",
    );
  } else if (subcommand === "status") {
    settings = settingsStore.get(interaction.guild.id);
  } else {
    throw new LeagueSettingsError("Unbekannter Liga-Befehl.");
  }
  const prefix = subcommand === "status" ? "ℹ️" : "✅ Gespeichert:";
  const schedule = settings.startDate
    ? `Start: ${settings.startDate.split("-").reverse().join(".")} · Wochenwechsel: Montag, 00:00 Uhr deutscher Zeit.`
    : "Die Wochenautomatik ist noch nicht eingerichtet. Bitte /liga season mit startdatum ausführen.";
  await interaction.editReply({
    content: settings.rounds
      ? `${prefix} Season ${settings.season} · ${roundLabel(settings.currentRound)}${settings.status === "upcoming" ? " · noch nicht gestartet" : settings.status === "finished" ? " · Season beendet" : ""}\nWoche ${Math.max(1, Math.min(settings.week, settings.rounds.length))} von ${settings.rounds.length} · ${settings.matchdays} reguläre Spieltage\n${settings.status === "redraft" ? `Nächste Woche: ${roundLabel(settings.nextRound)}\n` : ""}${schedule}`
      : `${prefix} Season ${settings.season} · Spieltag ${settings.currentMatchday} von ${settings.matchdays}\n${schedule}`,
  });
}

module.exports = { leagueCommand, handleLeagueCommand };
