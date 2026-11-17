const {
  ApplicationCommandOptionType,
  InteractionContextType,
  MessageFlags,
  escapeMarkdown,
} = require("discord.js");
const {
  currentLeagueMember,
  participantMembers,
  readableChannelIds,
} = require("../shared/permissions");
const { logError, interactionContext } = require("../shared/diagnostics");
const { PlayerNames, SearchError } = require("./player-names");

const nameOption = {
  type: ApplicationCommandOptionType.String,
  autocomplete: true,
  min_length: 1,
  max_length: 100,
};
const winrateCommand = {
  name: "winrate",
  description: "Schickt dir die Winrate eines Spielers oder eines direkten Duells per DM",
  contexts: [InteractionContextType.Guild],
  options: [
    {
      ...nameOption,
      name: "spieler",
      description: "Wessen Bilanz möchtest du sehen?",
      required: true,
    },
    {
      ...nameOption,
      name: "gegner",
      description: "Optional: nur Duelle gegen diesen Spieler",
      required: false,
    },
    {
      name: "season",
      description: "Optional: nur diese Season (sonst alle Seasons)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      min_value: 1,
      max_value: 9999,
    },
  ],
};

async function winratePlayers(interaction, database, config, member, inputs = [], season) {
  const guildId = interaction.guild.id;
  const roster = participantMembers(interaction.guild, config.participantRoleId).map((player) => ({
    id: player.id,
    name: player.displayName,
  }));
  // Selected IDs from the current roster need only channel IDs and the two SQL counts.
  const fromRoster =
    inputs.length > 0 && inputs.every((value) => roster.some((player) => player.id === value));
  const channels = await readableChannelIds(
    interaction,
    database.publishedReportChannels(guildId, fromRoster ? season : undefined),
    member,
  );
  const archived = fromRoster ? [] : database.publishedPlayerNames(guildId, channels);
  return { names: new PlayerNames([...archived, ...roster]), channels };
}

async function handleWinrateAutocomplete(interaction, database, config) {
  const member = await currentLeagueMember(interaction, config);
  const focus = interaction.options.getFocused(true);
  if (!member || !["spieler", "gegner"].includes(focus.name)) {
    await interaction.respond([]);
    return;
  }
  const { names } = await winratePlayers(interaction, database, config, member);
  const other = interaction.options.getString(focus.name === "spieler" ? "gegner" : "spieler");
  await interaction.respond(names.choices(String(focus.value), other));
}

const percent = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

function winrateMessage(player, opponent, season, { wins, losses }) {
  const label = (person) => {
    const name = escapeMarkdown(person.name.replace(/[\r\n]/g, " "));
    return opponent?.name === player.name ? `${name} (${person.id})` : name;
  };
  const name = label(player);
  const title = opponent ? `${name} gegen ${label(opponent)}` : `Gesamtbilanz für ${name}`;
  const header = `**${title} · ${season === undefined ? "Alle Seasons" : `Season ${season}`}**`;
  const total = wins + losses;
  if (!total) return `${header}\nFür diese Auswahl gibt es noch keine gewerteten Matches.`;
  const games = opponent ? (total === 1 ? "Duell" : "Duelle") : total === 1 ? "Match" : "Matches";
  return [
    header,
    `${total} ${games} · ${wins} ${wins === 1 ? "Sieg" : "Siege"} · ${losses} ${losses === 1 ? "Niederlage" : "Niederlagen"}`,
    `**${percent.format((100 * wins) / total)} % Winrate für ${name}**`,
  ].join("\n");
}

async function handleWinrateCommand(interaction, database, config, logger = console) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const member = await currentLeagueMember(interaction, config);
  if (!member)
    throw new SearchError(
      "Nur Teilnehmer und die Ligaverwaltung können die Winrate auf dem Liga-Server abrufen.",
    );
  const season = interaction.options.getInteger("season") ?? undefined;
  if (season !== undefined && (!Number.isInteger(season) || season < 1 || season > 9999))
    throw new SearchError("Bitte wähle eine Season zwischen 1 und 9999.");
  const playerInput = interaction.options.getString("spieler", true);
  const opponentInput = interaction.options.getString("gegner");
  const inputs = opponentInput == null ? [playerInput] : [playerInput, opponentInput];
  const { names, channels } = await winratePlayers(
    interaction,
    database,
    config,
    member,
    inputs,
    season,
  );
  const player = names.resolve(playerInput, "spieler");
  if (!player)
    throw new SearchError("Spieler nicht gefunden. Bitte wähle einen Namen im Feld „spieler“ aus.");
  const opponent = opponentInput == null ? undefined : names.resolve(opponentInput, "gegner");
  if (opponentInput != null && !opponent)
    throw new SearchError("Gegner nicht gefunden. Bitte wähle einen Namen im Feld „gegner“ aus.");
  if (player.id === opponent?.id)
    throw new SearchError("Bitte wähle für das Duell zwei verschiedene Spieler aus.");
  const counts = database.countResults(interaction.guild.id, player.id, channels, {
    opponentId: opponent?.id,
    season,
  });
  const content = winrateMessage(player, opponent, season, counts);
  try {
    await interaction.user.send({
      content,
      flags: [MessageFlags.SuppressEmbeds],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    const blocked = [50007, 50278].includes(Number(error.code));
    if (!blocked)
      logError(
        "Fehler beim Senden der Winrate per DM:",
        error,
        { ...interactionContext(interaction), season, operation: "winrate.dm" },
        logger,
      );
    await interaction.editReply({
      content: blocked
        ? "Ich konnte dir keine DM schicken. Bitte erlaube Direktnachrichten von Servermitgliedern und prüfe, ob du den Bot blockiert hast."
        : "Die DM mit deiner Bilanz konnte nicht zugestellt werden. Bitte versuche es später erneut.",
    });
    return;
  }
  await interaction.editReply({ content: "Ich habe dir die Bilanz per DM geschickt." });
}

module.exports = { winrateCommand, handleWinrateCommand, handleWinrateAutocomplete };
