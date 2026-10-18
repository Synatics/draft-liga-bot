const { ChannelType, MessageFlags, PermissionFlagsBits, escapeMarkdown } = require("discord.js");

class SearchError extends Error {}

const searchCommand = {
  name: "suchen",
  description: "Findet die Replays eines Spielers aus einer Season",
  contexts: [0],
  options: [
    { name: "season", description: "Welche Season?", type: 4, required: true, min_value: 1, max_value: 9999 },
    { name: "name", description: "Spielernamen eingeben und einen Vorschlag auswählen", type: 3,
      required: true, autocomplete: true, min_length: 1, max_length: 100 },
    { name: "spieltag", description: "Optional: nur Replays von diesem Spieltag", type: 4,
      required: false, min_value: 1, max_value: 25 },
  ],
};

function visibleMatches(interaction, store) {
  if (!interaction.guild) return [];
  return store.list(interaction.guild.id).filter((match) => {
    const channel = interaction.guild.channels.cache.get(match.channelId);
    const permissions = channel?.permissionsFor(interaction.member);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) return false;
    if (channel.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads) &&
        !channel.members.cache.has(interaction.user.id)) return false;
    return true;
  });
}

function seasonPlayers(matches, season) {
  const players = new Map();
  for (const match of matches.filter((entry) => entry.season === season)) {
    for (const player of match.players) {
      const previous = players.get(player.id);
      players.set(player.id, { ...player, aliases: new Set([...(previous?.aliases || []), player.name]) });
    }
  }
  return [...players.values()].sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id));
}

function playerChoices(matches, season, input) {
  const players = seasonPlayers(matches, season);
  const query = input.trim().toLocaleLowerCase("de");
  return players.filter((player) => [...player.aliases].some((name) => name.toLocaleLowerCase("de").includes(query)))
    .slice(0, 25).map((player) => ({
      name: players.some((other) => other.id !== player.id && other.name === player.name)
        ? `${player.name.slice(0, 76)} · ${player.id}` : player.name,
      value: player.id,
    }));
}

function resolvePlayer(matches, season, input) {
  const players = seasonPlayers(matches, season);
  const selected = players.find((player) => player.id === input);
  if (selected) return selected;
  const query = input.trim().toLocaleLowerCase("de");
  const found = players.filter((player) => [...player.aliases].some((name) => name.toLocaleLowerCase("de") === query));
  if (found.length > 1) throw new SearchError("Mehrere Teilnehmer haben diesen Namen. Bitte wähle einen Vorschlag im Feld „name“ aus.");
  return found[0];
}

function resultMessages(matches) {
  const messages = [];
  let content = "";
  for (const match of [...matches].sort((a, b) => a.matchday - b.matchday)) {
    const names = match.players.map((player) => escapeMarkdown(player.name.replace(/[\r\n]/g, " "))).join(" vs. ");
    const line = `**Spieltag ${match.matchday} · ${names}**\n<${match.link}>`;
    if (content && content.length + line.length + 2 > 2000) {
      messages.push(content);
      content = "";
    }
    content += (content ? "\n\n" : "") + line;
  }
  if (content) messages.push(content);
  return messages;
}

async function handleSearchAutocomplete(interaction, store) {
  const season = interaction.options.getInteger("season");
  const focused = interaction.options.getFocused(true);
  const choices = focused.name === "name" && season
    ? playerChoices(visibleMatches(interaction, store), season, String(focused.value)) : [];
  await interaction.respond(choices);
}

async function handleSearchCommand(interaction, store) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  if (!interaction.guild) throw new SearchError("Bitte verwende /suchen auf dem Liga-Server.");
  const season = interaction.options.getInteger("season", true);
  const matchday = interaction.options.getInteger("spieltag");
  if (!Number.isInteger(season) || season < 1 || season > 9999 ||
      (matchday !== null && matchday !== undefined && (!Number.isInteger(matchday) || matchday < 1 || matchday > 25))) {
    throw new SearchError("Bitte wähle eine Season zwischen 1 und 9999 und optional einen Spieltag zwischen 1 und 25.");
  }
  const matches = visibleMatches(interaction, store);
  const player = resolvePlayer(matches, season, interaction.options.getString("name", true));
  const found = player ? matches.filter((match) => match.season === season &&
    (matchday == null || match.matchday === matchday) && match.players.some((entry) => entry.id === player.id)) : [];
  const messages = resultMessages(found);
  if (!messages.length) {
    await interaction.editReply({ content: "Keine passenden Replays gefunden. Es werden nur seit diesem Update gespeicherte Reports aus für dich lesbaren Kanälen durchsucht.",
      allowedMentions: { parse: [] } });
    return;
  }
  let delivered = 0;
  for (const content of messages) {
    try {
      await interaction.user.send({ content, flags: [MessageFlags.SuppressEmbeds], allowedMentions: { parse: [] } });
      delivered++;
    } catch (error) {
      const blocked = [50007, 50278].includes(Number(error.code));
      if (!blocked) console.error("Fehler beim Senden der Suchergebnisse per DM:", error);
      const progress = delivered ? `${delivered} von ${messages.length} Nachrichten wurden zugestellt. ` : "";
      const hint = blocked
        ? "Bitte erlaube Direktnachrichten von Servermitgliedern und prüfe, ob du den Bot blockiert hast."
        : "Bitte versuche die Suche später erneut.";
      await interaction.editReply({
        content: `❌ Die Suchergebnisse konnten nicht vollständig per DM gesendet werden. ${progress}${hint}`,
        allowedMentions: { parse: [] },
      });
      return;
    }
  }
  await interaction.editReply({
    content: `✅ Ich habe dir ${found.length} ${found.length === 1 ? "Replay" : "Replays"} per DM geschickt.`,
    allowedMentions: { parse: [] },
  });
}

module.exports = { SearchError, searchCommand, handleSearchCommand, handleSearchAutocomplete, playerChoices, resultMessages };
