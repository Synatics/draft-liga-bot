const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  MessageFlags,
} = require("discord.js");
require("dotenv").config();
const { dirname, join } = require("node:path");
const {
  ReportError,
  checkParticipantRole,
  getParticipantOptions,
  createReportModal,
  resolveReportContext,
  resolveReportPlayers,
  createResultMessage,
} = require("./reports");
const { LeagueSettingsError, LeagueSettingsStore, settingsFilePath } = require("./league-settings");
const { leagueCommand, handleLeagueCommand } = require("./league-commands");
const { MatchStore, MatchStoreError, normalizeReplayLink } = require("./match-store");
const { ReportPublisher } = require("./report-publisher");
const { SearchError, searchCommand, handleSearchCommand, handleSearchAutocomplete } = require("./search-commands");

const participantRoleId = process.env.PARTICIPANT_ROLE_ID?.trim();
const settingsPath = settingsFilePath(process.env);
const settingsStore = new LeagueSettingsStore(settingsPath);
const matchStore = new MatchStore(join(dirname(settingsPath), "matches.json"));
const reportPublisher = new ReportPublisher(matchStore);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Load members once; GuildMembers events keep roles and nicknames current afterwards.
// /report can then open the modal immediately, within Discord's response deadline.
const loadedGuilds = new Set();
const memberLoads = new Map();

function prepareGuild(guild) {
  if (!memberLoads.has(guild.id)) {
    const load = guild.members.fetch({ time: 15000 })
      .then(() => loadedGuilds.add(guild.id))
      .finally(() => memberLoads.delete(guild.id));
    memberLoads.set(guild.id, load);
  }
  return memberLoads.get(guild.id);
}

function warmGuild(guild) {
  prepareGuild(guild).catch((error) => console.error("Fehler beim Laden der Teilnehmer:", error));
}

client.on(Events.ClientReady, () => {
  console.log("✅ Bot ist mit Discord verbunden.");
  loadedGuilds.clear();
  for (const guild of client.guilds.cache.values()) warmGuild(guild);
});
client.on(Events.GuildCreate, warmGuild);
client.on(Events.GuildDelete, (guild) => loadedGuilds.delete(guild.id));

const commands = [
  {
    name: "report",
    description: "Öffnet das Formular um ein Match-Ergebnis einzutragen",
    contexts: [0], // Guild only
  },
  leagueCommand,
  searchCommand,
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log(`✅ Slash-Befehle bei Discord registriert: ${commands.map((command) => `/${command.name}`).join(", ")}`);
  } catch (error) {
    console.error("❌ Slash-Befehle konnten nicht registriert werden:", error.code || error.name, error.message);
    console.error("Bitte CLIENT_ID, DISCORD_TOKEN und die Verbindung zu Discord prüfen.");
  }
})();

client.on(Events.InteractionCreate, async (interaction) => {
  const isReportCommand = interaction.isChatInputCommand() && interaction.commandName === "report";
  const isLeagueCommand = interaction.isChatInputCommand() && interaction.commandName === "liga";
  const isSearchCommand = interaction.isChatInputCommand() && interaction.commandName === "suchen";
  const isSearchAutocomplete = interaction.isAutocomplete() && interaction.commandName === "suchen";
  const isReportSubmit = interaction.isModalSubmit() && (
    interaction.customId === "submit_report" || interaction.customId.startsWith("submit_report:")
  );
  if (!isReportCommand && !isReportSubmit && !isLeagueCommand && !isSearchCommand && !isSearchAutocomplete) return;

  try {
    if (isSearchAutocomplete) {
      await handleSearchAutocomplete(interaction, matchStore);
      return;
    }
    if (isSearchCommand) {
      await handleSearchCommand(interaction, matchStore);
      return;
    }
    if (isLeagueCommand) {
      await handleLeagueCommand(interaction, settingsStore);
      return;
    }
    checkParticipantRole(interaction.guild, participantRoleId);

    if (isReportCommand) {
      if (!loadedGuilds.has(interaction.guild.id)) {
        warmGuild(interaction.guild);
        await interaction.reply({
          content: "Die Teilnehmerliste wird noch geladen. Bitte versuche /report gleich erneut.",
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }
      const participants = getParticipantOptions(interaction.guild, participantRoleId);
      await interaction.showModal(createReportModal(participants, settingsStore.get(interaction.guild.id)));
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const { winner, loser, players } = await resolveReportPlayers(
      interaction.guild, participantRoleId, interaction.fields
    );
    const score = interaction.fields.getTextInputValue("score");
    const link = normalizeReplayLink(interaction.fields.getTextInputValue("link"));
    // Read the season after the member lookups, in case an admin changed it meanwhile.
    const context = resolveReportContext(
      interaction.customId, interaction.fields, settingsStore.get(interaction.guild.id)
    );

    const publication = await reportPublisher.publish(
      { guildId: interaction.guild.id, channelId: interaction.channelId, ...context, players, link },
      interaction.channel,
      createResultMessage(winner, loser, score, link, context)
    );
    if (publication.error) console.error(
      publication.status === "published-unconfirmed" ? "Fehler beim Speichern des Versandstatus:" : "Fehler beim Posten des gespeicherten Reports:",
      publication.error
    );
    if (publication.storageError) console.error("Fehler beim Speichern des Versandstatus:", publication.storageError);
    const messageLink = publication.messageId
      ? `https://discord.com/channels/${interaction.guild.id}/${interaction.channelId}/${publication.messageId}` : null;
    const replies = {
      published: "✅ Ergebnis erfolgreich gepostet!",
      duplicate: `ℹ️ Dieses Match wurde bereits gepostet: <${messageLink}>`,
      "in-progress": "ℹ️ Dieses Match wird gerade gepostet. Bitte warte kurz.",
      legacy: "ℹ️ Dieses Match ist bereits im Replay-Archiv vorhanden. Da es vor dem Duplikatschutz gespeichert wurde, wird kein weiterer Ergebnis-Post erstellt. Bitte prüfe den bisherigen Post im Kanal.",
      failed: "❌ Das Replay ist für /suchen gespeichert, aber der Ergebnis-Post konnte nicht gesendet werden. Bitte prüfe die Kanalrechte des Bots und versuche /report erneut.",
      "failed-unconfirmed": "❌ Discord hat den Ergebnis-Post abgelehnt. Außerdem konnte der Versandstatus nicht gespeichert werden. Ein erneuter Versand wird vorsichtshalber blockiert. Bitte prüfe den Datenspeicher und den Versandstatus im Archiv.",
      uncertain: "⚠️ Bei diesem Match ist unklar, ob Discord den Ergebnis-Post bereits erhalten hat. Damit kein doppelter Post entsteht, wird es nicht erneut gesendet. Bitte prüfe den Kanal und lass bei Bedarf den Versandstatus im Archiv prüfen.",
      "published-unconfirmed": `⚠️ Das Ergebnis wurde gepostet: <${messageLink}>. Der Versandstatus konnte aber nicht gespeichert werden. Ein erneuter Versand wird vorsichtshalber blockiert. Bitte prüfe den Datenspeicher.`,
    };
    await interaction.editReply({
      content: replies[publication.status],
      flags: [MessageFlags.SuppressEmbeds],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (isSearchAutocomplete) {
      console.error("Fehler bei den Suchvorschlägen:", error);
      if (!interaction.responded) {
        try { await interaction.respond([]); } catch { /* The autocomplete interaction may have expired. */ }
      }
      return;
    }
    const expected = error instanceof ReportError || error instanceof LeagueSettingsError ||
      error instanceof MatchStoreError || error instanceof SearchError;
    if (!expected) console.error("Fehler beim Verarbeiten des Reports:", error);
    const content = expected
      ? `❌ ${error.message}`
      : "❌ Es gab einen Fehler beim Verarbeiten des Befehls. Bitte versuche es erneut.";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
      }
    } catch (replyError) {
      console.error("Fehler beim Senden der Rückmeldung:", replyError);
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch((error) => console.error("Bot-Start fehlgeschlagen:", error));
