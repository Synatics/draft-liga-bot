const {
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require("discord.js");
const { validateSettings } = require("./league-settings");
const {
  playableRounds,
  roundLabel,
  roundFields,
  planToken,
  selectedRound,
  seasonRoundLabel,
} = require("./season-rounds");

const SPACER = "⠀";

class ReportError extends Error {}

function validateScore(score) {
  if (typeof score !== "string" || !score.trim() || score.length > 100) {
    throw new ReportError(
      "Bitte gib ein Ergebnis mit 1 bis 100 Zeichen ein. Nur Leerzeichen reichen nicht.",
    );
  }
}

function centerText(text, targetLength = 16) {
  const totalPadding = Math.max(0, targetLength - text.length);
  const sidePadding = Math.floor(totalPadding / 2);
  return SPACER.repeat(sidePadding) + text + SPACER.repeat(totalPadding - sidePadding);
}

function checkParticipantRole(guild, roleId) {
  if (!guild) {
    throw new ReportError("Bitte trage das Ergebnis auf dem Liga-Server ein.");
  }
  if (!roleId) {
    throw new ReportError(
      "Die Teilnehmerrolle ist noch nicht eingerichtet. Bitte hinterlege PARTICIPANT_ROLE_ID in der .env-Datei.",
    );
  }
  if (roleId === guild.id || !guild.roles.cache.has(roleId)) {
    throw new ReportError(
      "Die Teilnehmerrolle wurde auf diesem Server nicht gefunden. Bitte prüfe PARTICIPANT_ROLE_ID.",
    );
  }
}

function getParticipantOptions(guild, roleId) {
  checkParticipantRole(guild, roleId);
  const participants = [...guild.members.cache.values()]
    .filter((member) => !member.user.bot && member.roles.cache.has(roleId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "de") || a.id.localeCompare(b.id));

  if (participants.length < 2) {
    throw new ReportError("Für ein Match brauchen mindestens zwei Personen die Teilnehmerrolle.");
  }
  if (participants.length > 25) {
    throw new ReportError(
      "Das Dropdown unterstützt höchstens 25 Personen mit der Teilnehmerrolle.",
    );
  }

  const nameCounts = new Map();
  for (const member of participants) {
    nameCounts.set(member.displayName, (nameCounts.get(member.displayName) || 0) + 1);
  }

  return participants.map((member) => ({
    label: member.displayName,
    value: member.id,
    ...(nameCounts.get(member.displayName) > 1 ? { description: `@${member.user.username}` } : {}),
  }));
}

function createReportModal(participants, settings) {
  validateSettings(settings);
  const playerSelect = (customId, label) =>
    new LabelBuilder()
      .setLabel(label)
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder("Teilnehmer auswählen")
          .setMinValues(1)
          .setMaxValues(1)
          .setRequired(true)
          .addOptions(participants),
      );

  return new ModalBuilder()
    .setCustomId(
      `submit_report:${settings.season}${settings.rounds ? `:${planToken(settings)}` : ""}`,
    )
    .setTitle(`Ergebnis · Season ${settings.season}`)
    .addLabelComponents(
      new LabelBuilder().setLabel("Runde").setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId(settings.rounds ? "round" : "matchday")
          .setPlaceholder(
            settings.status === "redraft"
              ? "Redraft: Runde für ein Nachholspiel auswählen"
              : "Runde auswählen",
          )
          .setMinValues(1)
          .setMaxValues(1)
          .setRequired(true)
          .addOptions(
            playableRounds(settings).map((round) => ({
              label: roundLabel(round),
              value: settings.rounds ? round.id : String(round.matchday),
              default: settings.rounds
                ? settings.currentRound?.id === round.id
                : round.matchday === settings.currentMatchday,
            })),
          ),
      ),
      playerSelect("winner", "Gewinner"),
      playerSelect("loser", "Verlierer"),
      new LabelBuilder()
        .setLabel("Ergebnis")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("score")
            .setPlaceholder("z.B. 2-0")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Replay Link")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("link")
            .setPlaceholder("https://...")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1024)
            .setRequired(true),
        ),
    );
}

function resolveReportContext(customId, fields, settings) {
  validateSettings(settings);
  const match = /^submit_report:([1-9]\d*)(?::([a-f0-9]{12}))?$/.exec(customId);
  if (!match || Number(match[1]) !== settings.season) {
    throw new ReportError("Die Season wurde inzwischen geändert. Bitte öffne /report erneut.");
  }
  if (settings.rounds) {
    if (match[2] !== planToken(settings))
      throw new ReportError(
        "Der Seasonplan wurde inzwischen geändert. Bitte öffne /report erneut.",
      );
    const round = selectedRound(fields, "round", playableRounds(settings));
    if (!round)
      throw new ReportError(
        "Bitte wähle eine gültige spielbare Runde dieser Season. Während des Redrafts sind Nachholspiele über ihre Runde meldbar.",
      );
    return { season: settings.season, ...roundFields(round) };
  }
  if (match[2])
    throw new ReportError("Der Seasonplan wurde inzwischen geändert. Bitte öffne /report erneut.");
  const selectedDays = fields.getStringSelectValues("matchday");
  const matchday = Number(selectedDays[0]);
  if (
    selectedDays.length !== 1 ||
    !/^[1-9]\d*$/.test(selectedDays[0]) ||
    !Number.isSafeInteger(matchday) ||
    matchday > settings.matchdays
  ) {
    throw new ReportError(
      "Dieser Spieltag gehört nicht zur aktuellen Season. Bitte öffne /report erneut.",
    );
  }
  return { season: settings.season, matchday };
}

async function resolveReportPlayers(guild, roleId, fields) {
  checkParticipantRole(guild, roleId);
  const winnerIds = fields.getStringSelectValues("winner");
  const loserIds = fields.getStringSelectValues("loser");
  if (winnerIds.length !== 1 || loserIds.length !== 1 || winnerIds[0] === loserIds[0]) {
    throw new ReportError(
      "Bitte wähle zwei unterschiedliche Teilnehmer als Gewinner und Verlierer.",
    );
  }

  const members = await Promise.all(
    [winnerIds[0], loserIds[0]].map(async (user) => {
      try {
        return await guild.members.fetch({ user, force: true });
      } catch (error) {
        // A selected participant may have left while the form was open.
        if (error.code === 10007) return null;
        throw error;
      }
    }),
  );

  if (members.some((member) => !member || member.user.bot || !member.roles.cache.has(roleId))) {
    throw new ReportError(
      "Mindestens eine ausgewählte Person ist nicht mehr Teilnehmer. Bitte öffne /report erneut.",
    );
  }

  return {
    winner: members[0].displayName,
    loser: members[1].displayName,
    players: members.map((member) => ({ id: member.id, name: member.displayName })),
  };
}

function createResultEmbed(winner, loser, score, link) {
  const players = [escapeMarkdown(winner), escapeMarkdown(loser)];
  // Choose by position, so two people with the same nickname still work.
  if (Math.random() < 0.5) players.reverse();

  return new EmbedBuilder()
    .setTitle(`🏆 Liga Match: ${players[0]} vs. ${players[1]}`)
    .setColor("#FFD700")
    .addFields(
      { name: "Gewinner", value: `|| ${centerText(escapeMarkdown(winner))} ||`, inline: true },
      { name: "Verlierer", value: `|| ${centerText(escapeMarkdown(loser))} ||`, inline: true },
      { name: "Score", value: `|| ${centerText(escapeMarkdown(score), 6)} ||`, inline: false },
      { name: "Replay Link", value: link, inline: false },
    )
    .setTimestamp();
}

function createResultMessage(winner, loser, score, link, context) {
  const embed = createResultEmbed(winner, loser, score, link).setAuthor({
    name: seasonRoundLabel(context),
  });
  return {
    embeds: [embed],
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  ReportError,
  validateScore,
  checkParticipantRole,
  getParticipantOptions,
  createReportModal,
  resolveReportContext,
  resolveReportPlayers,
  createResultEmbed,
  createResultMessage,
};
