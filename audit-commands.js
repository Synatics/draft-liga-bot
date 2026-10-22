const {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits: P,
} = require("discord.js");
const { LeagueSettingsError } = require("./league-settings");
const { isParticipant, isLeagueManager, currentMember } = require("./permissions");
const { logError, interactionContext } = require("./diagnostics");

const clean = (value) =>
  String(value ?? "unbekannt").replace(
    // eslint-disable-next-line no-control-regex -- Escape control characters so inputs cannot forge extra log lines.
    /[\u0000-\u001f\u007f]/g,
    (character) =>
      character === "\n"
        ? "\\n"
        : character === "\r"
          ? "\\r"
          : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const time = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  dateStyle: "medium",
  timeStyle: "long",
});

function describe(snapshot) {
  if (!snapshot) return "—";
  const players = snapshot.players
    .map((player) => `${clean(player.name)} (${player.id})`)
    .join(" vs. ");
  const name = (id) => snapshot.players.find((player) => player.id === id)?.name || id;
  return [
    `Season ${snapshot.season} · Spieltag ${snapshot.matchday} · ${players}`,
    `Gewinner: ${clean(snapshot.result ? name(snapshot.result.winnerId) : undefined)}`,
    `Verlierer: ${clean(snapshot.result ? name(snapshot.result.loserId) : undefined)}`,
    `Ergebnis: ${clean(snapshot.result?.score)}`,
    `Replay: ${clean(snapshot.link)}`,
  ].join("\n");
}

function logFiles(events, season, maximumBytes = 1_000_000) {
  const header = `Draft-Liga · Änderungsprotokoll · Season ${season}\nZeitzone: Europe/Berlin\nImportierte Einträge enthalten keine erfundene frühere Änderungshistorie.\n\n`;
  const files = [];
  let content = header;
  const actions = {
    created: "ERSTELLT",
    edited: "BEARBEITET",
    deleted: "GELÖSCHT",
    imported: "AUS JSON ÜBERNOMMEN",
  };
  for (const event of events) {
    if (event.season !== season)
      throw new Error("Der Export darf nur eine ausgewählte Season enthalten.");
    const actor = event.actor
      ? `${clean(event.actor.name)} (${event.actor.id})`
      : "unbekannt (älterer Eintrag)";
    const entry =
      [
        `${time.format(new Date(event.at))} · ${actions[event.action]}`,
        `Person: ${actor}`,
        `Report: ${event.reportId} · Kanal: ${event.channelId} · Nachricht: ${event.messageId || "unbekannt"}`,
        ...(event.before ? ["Vorher:", describe(event.before)] : []),
        ...(event.after ? ["Nachher:", describe(event.after)] : []),
        "",
      ].join("\n") + "\n";
    if (Buffer.byteLength(content + entry, "utf8") > maximumBytes && content !== header) {
      files.push(content);
      content = header;
    }
    content += entry;
  }
  if (content !== header) files.push(content);
  return files.map((text, index) => ({
    name: `liga-season-${season}-log${files.length > 1 ? `-${index + 1}` : ""}.txt`,
    data: Buffer.from(text, "utf8"),
  }));
}

async function visibleEvents(interaction, events, member, managerRoleId) {
  const access = new Map();
  await Promise.all(
    [...new Set(events.map((event) => event.channelId))].map(async (id) => {
      try {
        const channel = await interaction.guild.channels.fetch(id);
        if (!channel) {
          access.set(id, isLeagueManager(interaction, managerRoleId, member));
          return;
        }
        if (channel.guildId !== interaction.guild.id) return;
        const permissions = channel.permissionsFor(member);
        if (!permissions?.has([P.ViewChannel, P.ReadMessageHistory])) return;
        if (channel.type === ChannelType.PrivateThread && !permissions.has(P.ManageThreads)) {
          await channel.members.fetch({ member: interaction.user.id, force: true });
        }
        access.set(id, true);
      } catch (error) {
        // A removed channel is auditable by management; failed permission lookups stay closed.
        if (Number(error.code) === 10003)
          access.set(id, isLeagueManager(interaction, managerRoleId, member));
      }
    }),
  );
  return events.filter((event) => access.get(event.channelId));
}

async function handleAuditCommand(interaction, database, config) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
  const season = interaction.options.getInteger("season", true);
  if (!interaction.guild || !Number.isInteger(season) || season < 1 || season > 9999) {
    throw new LeagueSettingsError(
      "Bitte auf dem Liga-Server eine Season von 1 bis 9999 auswählen.",
    );
  }
  const member = await currentMember(interaction);
  if (
    !isParticipant(interaction, config.participantRoleId, member) &&
    !isLeagueManager(interaction, config.managerRoleId, member)
  ) {
    throw new LeagueSettingsError(
      "Nur Teilnehmer, die Ligaverwaltung und Serververwalter dürfen das Protokoll anfordern.",
    );
  }
  const events = await visibleEvents(
    interaction,
    database.auditEvents(interaction.guild.id, season),
    member,
    config.managerRoleId,
  );
  const files = logFiles(events, season);
  if (!files.length) {
    await interaction.editReply({
      content: `Für Season ${season} sind keine für dich sichtbaren Protokolleinträge gespeichert.`,
    });
    return;
  }
  let delivered = 0;
  for (const file of files) {
    try {
      await interaction.user.send({
        content: `Änderungsprotokoll · Season ${season}${files.length > 1 ? ` · Teil ${delivered + 1}/${files.length}` : ""}`,
        files: [new AttachmentBuilder(file.data, { name: file.name })],
        allowedMentions: { parse: [] },
      });
      delivered++;
    } catch (error) {
      const blocked = [50007, 50278].includes(Number(error.code));
      if (!blocked)
        logError("Fehler beim Senden des Änderungsprotokolls per DM:", error, {
          ...interactionContext(interaction),
          season,
          operation: "audit.dm",
        });
      await interaction.editReply({
        content:
          `❌ Das Protokoll konnte nicht vollständig per DM zugestellt werden. ${delivered} von ${files.length} Dateien zugestellt. ` +
          (blocked
            ? "Bitte Direktnachrichten von Servermitgliedern erlauben und prüfen, ob der Bot blockiert ist."
            : "Bitte später erneut versuchen."),
      });
      return;
    }
  }
  await interaction.editReply({
    content: `✅ Das Protokoll für Season ${season} wurde dir per DM geschickt.`,
  });
}

module.exports = { handleAuditCommand, logFiles };
