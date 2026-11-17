const {
  ApplicationCommandOptionType,
  InteractionContextType,
  MessageFlags,
  escapeMarkdown,
} = require("discord.js");
const { logError, interactionContext } = require("../shared/diagnostics");
const { currentLeagueMember, readableChannelIds } = require("../shared/permissions");
const { PlayerNames, SearchError } = require("./player-names");
const {
  matchRoundLabel,
  roundOrder,
  roundChoices,
  resolveRoundFilter,
} = require("../league/season-rounds");

const searchCommand = {
  name: "suchen",
  description: "Findet die Replays eines Spielers aus einer Season",
  contexts: [InteractionContextType.Guild],
  options: [
    {
      name: "season",
      description: "Welche Season?",
      type: ApplicationCommandOptionType.Integer,
      required: true,
      min_value: 1,
      max_value: 9999,
    },
    {
      name: "name",
      description: "Spielernamen eingeben und einen Vorschlag auswählen",
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
      min_length: 1,
      max_length: 100,
    },
    {
      name: "spieltag",
      description: "Optional: nur Replays von diesem Spieltag",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      min_value: 1,
      max_value: 25,
    },
    {
      name: "runde",
      description: "Optional: konkrete Liga- oder Playoff-Runde auswählen (alternativ zu spieltag)",
      type: ApplicationCommandOptionType.String,
      autocomplete: true,
      max_length: 100,
    },
  ],
};

async function visibleMatches(interaction, store, season, member) {
  const matches = store.list(interaction.guild.id, season, { candidatesOnly: true });
  const readable = new Set(
    await readableChannelIds(
      interaction,
      matches.map((match) => match.channelId),
      member,
    ),
  );
  return matches.filter((match) => readable.has(match.channelId));
}

function seasonPlayers(matches, season) {
  return new PlayerNames(
    matches.filter((match) => match.season === season).flatMap((match) => match.players),
  );
}

function playerChoices(matches, season, input) {
  return seasonPlayers(matches, season).choices(input);
}

function resolvePlayer(matches, season, input) {
  return seasonPlayers(matches, season).resolve(input);
}

function resultMessages(matches) {
  const messages = [];
  let content = "";
  for (const match of [...matches].sort((a, b) => roundOrder(a) - roundOrder(b))) {
    const names = match.players
      .map((player) => escapeMarkdown(player.name.replace(/[\r\n]/g, " ")))
      .join(" vs. ");
    const line = `**${matchRoundLabel(match)} · ${names}**\n<${match.link}>`;
    if (content && content.length + line.length + 2 > 2000) {
      messages.push(content);
      content = "";
    }
    content += (content ? "\n\n" : "") + line;
  }
  if (content) messages.push(content);
  return messages;
}

async function handleSearchAutocomplete(interaction, store, config = {}) {
  const member = await currentLeagueMember(interaction, config);
  if (!member) {
    await interaction.respond([]);
    return;
  }
  const season = interaction.options.getInteger("season");
  const focused = interaction.options.getFocused(true);
  if (focused.name === "runde") {
    await interaction.respond(
      season
        ? roundChoices(
            (await visibleMatches(interaction, store, season, member)).filter(
              (match) => match.season === season,
            ),
            focused.value,
          )
        : [],
    );
    return;
  }
  const choices =
    focused.name === "name" && season
      ? playerChoices(
          await visibleMatches(interaction, store, season, member),
          season,
          String(focused.value),
        )
      : [];
  await interaction.respond(choices);
}

async function handleSearchCommand(interaction, store, config = {}) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  if (!interaction.guild) throw new SearchError("Bitte verwende /suchen auf dem Liga-Server.");
  const member = await currentLeagueMember(interaction, config);
  if (!member)
    throw new SearchError("Nur Teilnehmer und die Ligaverwaltung dürfen Replays suchen.");
  const season = interaction.options.getInteger("season", true);
  const matchday = interaction.options.getInteger("spieltag");
  if (
    !Number.isInteger(season) ||
    season < 1 ||
    season > 9999 ||
    (matchday !== null &&
      matchday !== undefined &&
      (!Number.isInteger(matchday) || matchday < 1 || matchday > 25))
  ) {
    throw new SearchError(
      "Bitte wähle eine Season zwischen 1 und 9999 und optional einen Spieltag zwischen 1 und 25.",
    );
  }
  const matches = await visibleMatches(interaction, store, season, member);
  const roundInput = interaction.options.get?.("runde")?.value;
  const roundId = roundInput == null ? undefined : resolveRoundFilter(roundInput, matches);
  if (roundInput != null && (!roundId || matchday != null))
    throw new SearchError(
      "Bitte eine gültige Runde auswählen und entweder runde oder spieltag verwenden.",
    );
  const player = resolvePlayer(matches, season, interaction.options.getString("name", true));
  const found = player
    ? store.findReplays(
        interaction.guild.id,
        season,
        player.id,
        [...new Set(matches.map((match) => match.channelId))],
        { matchday, roundId },
      )
    : [];
  const messages = resultMessages(found);
  if (!messages.length) {
    await interaction.editReply({
      content:
        "Keine passenden Replays gefunden. Es werden nur seit diesem Update gespeicherte Reports aus für dich lesbaren Kanälen durchsucht.",
      allowedMentions: { parse: [] },
    });
    return;
  }
  let delivered = 0;
  for (const content of messages) {
    try {
      await interaction.user.send({
        content,
        flags: [MessageFlags.SuppressEmbeds],
        allowedMentions: { parse: [] },
      });
      delivered++;
    } catch (error) {
      const blocked = [50007, 50278].includes(Number(error.code));
      if (!blocked)
        logError("Fehler beim Senden der Suchergebnisse per DM:", error, {
          ...interactionContext(interaction),
          season,
          operation: "search.dm",
        });
      const progress = delivered
        ? `${delivered} von ${messages.length} Nachrichten wurden zugestellt. `
        : "";
      const hint = blocked
        ? "Bitte erlaube Direktnachrichten von Servermitgliedern und prüfe, ob du den Bot blockiert hast."
        : "Bitte versuche die Suche später erneut.";
      await interaction.editReply({
        content: `Die Suchergebnisse konnten nicht vollständig per DM gesendet werden. ${progress}${hint}`,
        allowedMentions: { parse: [] },
      });
      return;
    }
  }
  await interaction.editReply({
    content: `Ich habe dir ${found.length} ${found.length === 1 ? "Replay" : "Replays"} per DM geschickt.`,
    allowedMentions: { parse: [] },
  });
}

module.exports = {
  SearchError,
  searchCommand,
  handleSearchCommand,
  handleSearchAutocomplete,
  playerChoices,
  resolvePlayer,
  resultMessages,
};
