const { InteractionContextType, MessageFlags } = require("discord.js");
const {
  ReportError,
  checkParticipantRole,
  getParticipantOptions,
  createReportModal,
  resolveReportContext,
  resolveReportPlayers,
  createResultMessage,
  validateScore,
} = require("./report-ui");
const { normalizeReplayLink } = require("../storage/match-store");
const {
  canReport,
  currentMember,
  fetchReadableChannel,
  actorOf,
} = require("../shared/permissions");
const { logError, interactionContext } = require("../shared/diagnostics");

const reportCommand = {
  name: "report",
  description: "Öffnet das Formular um ein Match-Ergebnis einzutragen",
  contexts: [InteractionContextType.Guild],
};

function createReportHandler({
  config,
  settingsStore,
  reportPublisher,
  memberLoader,
  logger = console,
}) {
  const { participantRoleId, managerRoleId } = config;
  return async function handleReport(interaction) {
    const logContext = interactionContext(interaction);
    checkParticipantRole(interaction.guild, participantRoleId);
    if (!canReport(interaction, participantRoleId, managerRoleId)) {
      throw new ReportError("Nur Teilnehmer und die Ligaverwaltung dürfen Ergebnisse melden.");
    }

    if (interaction.isChatInputCommand()) {
      if (!memberLoader.isLoaded(interaction.guild.id)) {
        memberLoader.warm(interaction.guild);
        await interaction.reply({
          content: "Die Teilnehmerliste wird noch geladen. Bitte versuche /report gleich erneut.",
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }
      const participants = getParticipantOptions(interaction.guild, participantRoleId);
      await interaction.showModal(
        createReportModal(participants, settingsStore.get(interaction.guild.id)),
      );
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const { winner, loser, players } = await resolveReportPlayers(
      interaction.guild,
      participantRoleId,
      interaction.fields,
    );
    const member = await currentMember(interaction);
    if (!canReport(interaction, participantRoleId, managerRoleId, member)) {
      throw new ReportError(
        "Du darfst keine Ergebnisse mehr melden. Deine Teilnehmer- oder Verwaltungsberechtigung wurde inzwischen entzogen.",
      );
    }
    const score = interaction.fields.getTextInputValue("score");
    validateScore(score);
    const link = normalizeReplayLink(interaction.fields.getTextInputValue("link"));
    const channel = await fetchReadableChannel(interaction, interaction.channelId, member);
    if (!channel)
      throw new ReportError(
        "Du hast keinen Zugriff mehr auf den Ergebniskanal oder dessen Verlauf.",
      );
    // Read the season after the access lookups, in case a league manager changed it meanwhile.
    const context = resolveReportContext(
      interaction.customId,
      interaction.fields,
      settingsStore.get(interaction.guild.id),
    );
    const publication = await reportPublisher.publish(
      {
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        ...context,
        players,
        link,
        reporter: actorOf(interaction, member),
        result: { winnerId: players[0].id, loserId: players[1].id, score },
      },
      interaction.channel,
      createResultMessage(winner, loser, score, link, context),
    );
    if (publication.error)
      logError(
        publication.status === "published-unconfirmed"
          ? "Fehler beim Speichern des Versandstatus:"
          : "Fehler beim Posten des gespeicherten Reports:",
        publication.error,
        {
          ...logContext,
          ...context,
          reportId: publication.reportId,
          messageId: publication.messageId,
          operation:
            publication.status === "published-unconfirmed" ? "report.status" : "report.publish",
        },
        logger,
      );
    if (publication.storageError)
      logError(
        "Fehler beim Speichern des Versandstatus:",
        publication.storageError,
        { ...logContext, reportId: publication.reportId, operation: "report.status" },
        logger,
      );
    const messageLink = publication.messageId
      ? `https://discord.com/channels/${interaction.guild.id}/${interaction.channelId}/${publication.messageId}`
      : null;
    const replies = {
      published: "Ergebnis erfolgreich gepostet!",
      duplicate: `Dieses Match wurde bereits gepostet: <${messageLink}>`,
      "in-progress": "Dieses Match wird gerade gepostet. Bitte warte kurz.",
      maintenance:
        "Dieser Report wird gerade korrigiert oder entfernt. Bitte warte, bis die Änderung abgeschlossen ist.",
      legacy:
        "Dieses Match ist bereits im Replay-Archiv vorhanden. Da es vor dem Duplikatschutz gespeichert wurde, wird kein weiterer Ergebnis-Post erstellt. Bitte prüfe den bisherigen Post im Kanal.",
      failed:
        "Das Replay ist für /suchen gespeichert, aber der Ergebnis-Post konnte nicht gesendet werden. Bitte prüfe die Kanalrechte des Bots und versuche /report erneut.",
      "failed-unconfirmed":
        "Discord hat den Ergebnis-Post abgelehnt. Außerdem konnte der Versandstatus nicht gespeichert werden. Ein erneuter Versand wird vorsichtshalber blockiert. Bitte prüfe den Datenspeicher und den Versandstatus im Archiv.",
      uncertain:
        "Bei diesem Match ist unklar, ob Discord den Ergebnis-Post bereits erhalten hat. Damit kein doppelter Post entsteht, wird es nicht erneut gesendet. Bitte prüfe den Kanal und lass bei Bedarf den Versandstatus im Archiv prüfen.",
      "published-unconfirmed": `Das Ergebnis wurde gepostet: <${messageLink}>. Der Versandstatus konnte aber nicht gespeichert werden. Ein erneuter Versand wird vorsichtshalber blockiert. Bitte prüfe den Datenspeicher.`,
    };
    await interaction.editReply({
      content: replies[publication.status],
      flags: [MessageFlags.SuppressEmbeds],
      allowedMentions: { parse: [] },
    });
  };
}

module.exports = { reportCommand, createReportHandler };
