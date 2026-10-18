const {
  ApplicationCommandOptionType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const { LeagueSettingsError } = require("./league-settings");

const leagueCommand = {
  name: "liga",
  description: "Season und aktuellen Spieltag der Liga verwalten",
  contexts: [InteractionContextType.Guild],
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "season",
      description: "Season mit automatischen wöchentlichen Spieltagen einrichten",
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
          description: "Anzahl der Spieltage in dieser Season",
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
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "status",
      description: "Aktuelle Season und Spieltag anzeigen",
    },
  ],
};

async function handleLeagueCommand(interaction, settingsStore) {
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new LeagueSettingsError("Zum Verwalten der Liga brauchst du die Berechtigung „Server verwalten“.");
  }
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const subcommand = interaction.options.getSubcommand();
  let settings;
  if (subcommand === "season") {
    settings = settingsStore.setSeason(
      interaction.guild.id,
      interaction.options.getInteger("nummer", true),
      interaction.options.getInteger("spieltage", true),
      interaction.options.getString("startdatum", true)
    );
  } else if (subcommand === "spieltag") {
    throw new LeagueSettingsError(
      "Der Spieltag wird jetzt automatisch bestimmt. Bitte das Startdatum über /liga season einstellen."
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
    content: `${prefix} Season ${settings.season} · Spieltag ${settings.currentMatchday} von ${settings.matchdays}\n${schedule}`,
  });
}

module.exports = { leagueCommand, handleLeagueCommand };
