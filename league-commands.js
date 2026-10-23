const {
  ApplicationCommandOptionType,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");
const { LeagueSettingsError } = require("./league-settings");
const { isLeagueManager, isLeagueMember, currentMember } = require("./permissions");
const { handleAuditCommand } = require("./audit-commands");
const { roundLabel } = require("./season-rounds");

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
      description: "Season über einen geführten Dialog einrichten oder korrigieren",
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "status",
      description: "Aktuelle Season, Runde oder Redraft anzeigen",
    },
  ],
};

async function handleLeagueCommand(interaction, settingsStore, database, config = {}, seasonSetup) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "log") return handleAuditCommand(interaction, database, config);
  if (subcommand === "season") {
    if (!isLeagueManager(interaction, config.managerRoleId))
      throw new LeagueSettingsError("Zum Verwalten der Liga brauchst du die Ligaverwaltungsrolle.");
    return seasonSetup.open(interaction);
  }
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const member = await currentMember(interaction);
  if (!isLeagueMember(interaction, config.participantRoleId, config.managerRoleId, member)) {
    throw new LeagueSettingsError(
      "Nur Teilnehmer und die Ligaverwaltung dürfen den Seasonplan ansehen.",
    );
  }
  let settings;
  if (subcommand === "spieltag") {
    throw new LeagueSettingsError(
      "Der Spieltag wird jetzt automatisch bestimmt. Bitte das Startdatum über /liga season einstellen.",
    );
  } else if (subcommand === "status") {
    settings = settingsStore.get(interaction.guild.id);
  } else {
    throw new LeagueSettingsError("Unbekannter Liga-Befehl.");
  }
  const schedule = settings.startDate
    ? `Start: ${settings.startDate.split("-").reverse().join(".")} · Wochenwechsel: Montag, 00:00 Uhr deutscher Zeit.`
    : "Die Wochenautomatik ist noch nicht eingerichtet. Bitte die Ligaverwaltung das Startdatum über /liga season einstellen lassen.";
  await interaction.editReply({
    content: settings.rounds
      ? `Season ${settings.season} · ${roundLabel(settings.currentRound)}${settings.status === "upcoming" ? " · noch nicht gestartet" : settings.status === "finished" ? " · Season beendet" : ""}\nWoche ${Math.max(1, Math.min(settings.week, settings.rounds.length))} von ${settings.rounds.length} · ${settings.matchdays} reguläre Spieltage\n${settings.status === "redraft" ? `Nächste Woche: ${roundLabel(settings.nextRound)}\n` : ""}${schedule}`
      : `Season ${settings.season} · Spieltag ${settings.currentMatchday} von ${settings.matchdays}\n${schedule}`,
  });
}

module.exports = { leagueCommand, handleLeagueCommand };
