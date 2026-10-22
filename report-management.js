const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, escapeMarkdown,
} = require("discord.js");
const { matchData, normalizeReplayLink, revisionOf } = require("./match-store");
const { createResultMessage } = require("./reports");
const { ReportManagementError } = require("./report-manager");
const { playerChoices, resolvePlayer } = require("./search-commands");
const { isLeagueManager, currentMember, actorOf } = require("./permissions");

const managementCommands = [
  { name: "report-entfernen", description: "Gespeicherten Report finden und löschen, auch wenn der Post schon fehlt",
    contexts: [0], options: [
      { name: "season", description: "Welche Season?", type: 4, required: true, min_value: 1, max_value: 9999 },
      { name: "name", description: "Spielernamen eingeben und einen Vorschlag auswählen", type: 3,
        required: true, autocomplete: true, min_length: 1, max_length: 100 },
      { name: "spieltag", description: "Optional: nur Reports von diesem Spieltag", type: 4,
        min_value: 1, max_value: 25 },
    ] },
];
const privateReply = { flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } };
const customId = (action, record, userId) => `manage:${action}:${record.id}:${revisionOf(record)}:${userId}`;

function maximumMatchday(record, settingsStore) {
  let settings;
  try { settings = settingsStore?.get(record.guildId); } catch { /* Historical corrections do not require a configured season. */ }
  return settings?.season === record.season ? settings.matchdays : 25;
}

function canManage(interaction, record, action, managerRoleId, member = interaction.member) {
  return interaction.guild?.id === record.guildId && (isLeagueManager(interaction, managerRoleId, member) ||
    (action === "edit" && record.reporter?.id === interaction.user.id));
}

function authorize(interaction, record, action, managerRoleId, member) {
  if (!canManage(interaction, record, action, managerRoleId, member)) {
    throw new ReportManagementError(action === "edit"
      ? "Nur die meldende Person, die Ligaverwaltung und Serververwalter dürfen diesen Report bearbeiten. Bei älteren Reports ist die meldende Person eventuell unbekannt."
      : "Nur die Ligaverwaltung und Serververwalter dürfen Reports löschen oder das Archiv bereinigen.");
  }
}

function checkChannelAccess(interaction, channel, privateMemberVerified = false, member = interaction.member) {
  const permissions = channel?.permissionsFor(member);
  if (channel?.guildId !== interaction.guild.id ||
      !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) ||
      (channel.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads) &&
       !privateMemberVerified && !channel.members.cache.has(interaction.user.id))) {
    throw new ReportManagementError("Du hast keinen Zugriff auf den Ergebniskanal bzw. diesen privaten Thread.");
  }
  return channel;
}

async function resolveChannel(interaction, record) {
  let channel;
  try { channel = await interaction.guild.channels.fetch(record.channelId); } catch {
    throw new ReportManagementError("Der Ergebniskanal konnte nicht geladen werden. Bitte Zugriff und Kanal-ID prüfen.");
  }
  if (channel?.type === ChannelType.PrivateThread &&
      !channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ManageThreads)) {
    try { await channel.members.fetch({ member: interaction.user.id, force: true }); } catch {
      throw new ReportManagementError("Du hast keinen Zugriff auf diesen privaten Thread.");
    }
    return checkChannelAccess(interaction, channel, true);
  }
  return checkChannelAccess(interaction, channel);
}

function unspoiler(value) {
  if (typeof value !== "string" || !value.startsWith("|| ") || !value.endsWith(" ||")) return "";
  return value.slice(3, -3).replace(/^\u2800+|\u2800+$/g, "").replace(/\\(.)/gs, "$1");
}

function correctionOptions(guild, record, roleId) {
  const players = new Map(record.players.map((player) => [player.id, player]));
  for (const member of guild.members.cache.values()) {
    if (!member.user.bot && member.roles.cache.has(roleId) && !players.has(member.id)) {
      players.set(member.id, { id: member.id, name: member.displayName });
    }
  }
  if (players.size > 25) throw new ReportManagementError("Für das Korrekturformular sind höchstens 25 Teilnehmer möglich.");
  return [...players.values()].sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id))
    .map((player) => ({ label: player.name, value: player.id,
      description: guild.members.cache.get(player.id)?.user.username
        ? `@${guild.members.cache.get(player.id).user.username}` : `Gespeicherter Teilnehmer · ${player.id}` }));
}

function correctionModal(interaction, record, roleId, settingsStore) {
  const message = interaction.message;
  const fields = message?.embeds?.[0]?.fields || [];
  const options = correctionOptions(interaction.guild, record, roleId);
  const playerSelect = (id, label, field) => {
    const candidates = record.players.filter((player) => player.name === unspoiler(fields.find((entry) => entry.name === field)?.value));
    return new LabelBuilder().setLabel(label).setStringSelectMenuComponent(
      new StringSelectMenuBuilder().setCustomId(id).setPlaceholder("Teilnehmer auswählen")
        .setMinValues(1).setMaxValues(1).setRequired(true).addOptions(options.map((option) => ({ ...option,
          default: candidates.length === 1 && option.value === candidates[0].id })))
    );
  };
  const score = unspoiler(fields.find((entry) => entry.name === "Score")?.value);
  const scoreInput = new TextInputBuilder().setCustomId("score").setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(100).setPlaceholder("z.B. 2-0");
  if (score && score.length <= 100) scoreInput.setValue(score);
  return new ModalBuilder().setCustomId(customId("edit", record, interaction.user.id))
    .setTitle(`Report korrigieren · Season ${record.season}`)
    .addLabelComponents(
      new LabelBuilder().setLabel("Spieltag").setStringSelectMenuComponent(
        new StringSelectMenuBuilder().setCustomId("matchday").setPlaceholder("Spieltag auswählen")
          .setMinValues(1).setMaxValues(1).setRequired(true)
          .addOptions(Array.from({ length: maximumMatchday(record, settingsStore) }, (_, index) => ({
            label: `Spieltag ${index + 1}`, value: String(index + 1), default: index + 1 === record.matchday,
          })))
      ),
      playerSelect("winner", "Gewinner", "Gewinner"), playerSelect("loser", "Verlierer", "Verlierer"),
      new LabelBuilder().setLabel("Ergebnis").setTextInputComponent(scoreInput),
      new LabelBuilder().setLabel("Replay Link").setTextInputComponent(new TextInputBuilder().setCustomId("link")
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1024).setValue(record.link))
    );
}

function deletionPrompt(interaction, record) {
  const names = record.players.map((player) => escapeMarkdown(player.name.replace(/[\r\n]/g, " "))).join(" vs. ");
  return {
    ...privateReply, content: `Report **Season ${record.season} · Spieltag ${record.matchday} · ${names}** wirklich löschen?\nReplay: <${record.link}>\nKanal: <#${record.channelId}>\n\nDer Ergebnispost und sein Suchtreffer werden entfernt. Fehlt der Post bereits, wird nur der Archiv-Eintrag entfernt.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId("delete", record, interaction.user.id)).setLabel("Ja, Report löschen").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(customId("cancel", record, interaction.user.id)).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary)
    )],
  };
}

async function removableMatches(interaction, store, managerRoleId) {
  if (!interaction.guild) return [];
  const matches = store.list(interaction.guild.id).filter((match) =>
    match.publication?.status === "published" && canManage(interaction, match, "delete", managerRoleId));
  // Verify each result channel once, including current private-thread membership.
  const access = new Map(await Promise.all([...new Set(matches.map((match) => match.channelId))].map(async (channelId) => {
    try {
      await resolveChannel(interaction, { guildId: interaction.guild.id, channelId });
      return [channelId, true];
    } catch (error) {
      if (!(error instanceof ReportManagementError)) throw error;
      return [channelId, false];
    }
  })));
  return matches.filter((match) => access.get(match.channelId));
}

async function handleRemovalAutocomplete(interaction, store, managerRoleId) {
  const season = interaction.options.getInteger("season");
  const focused = interaction.options.getFocused(true);
  await interaction.respond(focused.name === "name" && season
    ? playerChoices(await removableMatches(interaction, store, managerRoleId), season, String(focused.value)) : []);
}

const matchingRemovals = (matches, query) => matches.filter((match) => match.season === query.season &&
  (!query.matchday || match.matchday === query.matchday) && match.players.some((player) => player.id === query.playerId))
  .sort((a, b) => a.matchday - b.matchday || a.channelId.localeCompare(b.channelId) || a.id.localeCompare(b.id));

function removalPicker(interaction, matches, query, requestedPage = 0) {
  if (!matches.length) return { content: "Keine passenden Reports gefunden, die du entfernen darfst. Prüfe Season, Spieler, Spieltag und deinen Zugriff auf den Ergebniskanal.",
    components: [], allowedMentions: { parse: [] } };
  const pages = Math.ceil(matches.length / 25);
  const page = Math.min(requestedPage, pages - 1);
  const pageId = (number) => `manage:page:${interaction.user.id}:${query.season}:${query.playerId}:${query.matchday || 0}:${number}`;
  return {
    content: `**Report entfernen · Season ${query.season}**\n${matches.length} Treffer · Seite ${page + 1} von ${pages}. Bitte genau einen Report auswählen. Gelöscht wird erst nach deiner Bestätigung.`,
    allowedMentions: { parse: [] },
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`manage:pick:${interaction.user.id}`).setPlaceholder("Report auswählen").setMinValues(1).setMaxValues(1)
      .addOptions(matches.slice(page * 25, (page + 1) * 25).map((match) => ({
        label: `Spieltag ${match.matchday} · ${match.players.map((player) => player.name.replace(/[\r\n]/g, " ")).join(" vs. ")}`.slice(0, 100),
        description: match.link.slice(0, 100), value: `${match.id}:${revisionOf(match)}`,
      })))),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(pageId(Math.max(0, page - 1))).setLabel("Zurück").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(pageId(page + 1)).setLabel("Weiter").setStyle(ButtonStyle.Secondary).setDisabled(page + 1 === pages),
      new ButtonBuilder().setCustomId(`manage:stop:${interaction.user.id}`).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary)
    )],
  };
}

async function openRemoval(interaction, store, managerRoleId) {
  if (!isLeagueManager(interaction, managerRoleId)) throw new ReportManagementError("Nur die Ligaverwaltung und Serververwalter dürfen das Archiv bereinigen.");
  await interaction.deferReply(privateReply);
  const season = interaction.options.getInteger("season", true);
  const matchday = interaction.options.getInteger("spieltag");
  if (!Number.isInteger(season) || season < 1 || season > 9999 ||
      (matchday != null && (!Number.isInteger(matchday) || matchday < 1 || matchday > 25))) {
    throw new ReportManagementError("Bitte eine Season von 1–9999 und optional einen Spieltag von 1–25 auswählen.");
  }
  const matches = await removableMatches(interaction, store, managerRoleId);
  const player = resolvePlayer(matches, season, interaction.options.getString("name", true));
  const query = { season, matchday, playerId: player?.id };
  const found = matchingRemovals(matches, query);
  const { flags, ...prompt } = found.length === 1 ? deletionPrompt(interaction, found[0]) : removalPicker(interaction, found, query);
  await interaction.editReply(prompt);
}

async function handleRemovalComponent(interaction, store, managerRoleId) {
  const parsed = /^manage:(pick|page|stop):(\d{17,20})(?::([1-9]\d{0,3}):(\d{17,20}):(\d{1,2}):(\d{1,6}))?$/.exec(interaction.customId);
  if (!parsed || parsed[2] !== interaction.user.id || !interaction.guild) {
    throw new ReportManagementError("Diese Auswahl gehört zu einer anderen Person oder ist ungültig. Bitte /report-entfernen erneut verwenden.");
  }
  const [, action, , season, playerId, matchday, page] = parsed;
  if (action === "stop") {
    await interaction.update({ content: "Aktion abgebrochen.", components: [], allowedMentions: { parse: [] } });
    return;
  }
  if (action === "pick") {
    const selected = interaction.values?.length === 1 && /^([a-f0-9]{24}):([a-f0-9]{16})$/.exec(interaction.values[0]);
    if (!selected) throw new ReportManagementError("Bitte genau einen Report aus der Liste auswählen.");
    const record = store.get(selected[1], interaction.guild.id);
    authorize(interaction, record, "delete", managerRoleId);
    if (revisionOf(record) !== selected[2]) throw new ReportManagementError("Dieser Report wurde inzwischen geändert. Bitte /report-entfernen erneut verwenden.");
    await interaction.deferUpdate();
    await resolveChannel(interaction, record);
    const { flags, ...prompt } = deletionPrompt(interaction, record);
    await interaction.editReply(prompt);
    return;
  }
  if (!season || Number(matchday) > 25) throw new ReportManagementError("Diese Auswahl ist ungültig. Bitte /report-entfernen erneut verwenden.");
  await interaction.deferUpdate();
  const query = { season: Number(season), playerId, matchday: Number(matchday) };
  const matches = matchingRemovals(await removableMatches(interaction, store, managerRoleId), query);
  await interaction.editReply(removalPicker(interaction, matches, query, Number(page)));
}

async function openManagement(interaction, store, manager, roleId, settingsStore, managerRoleId) {
  if (!interaction.guild) throw new ReportManagementError("Bitte verwende die Aktion auf dem Liga-Server.");
  if (interaction.commandName === "report-entfernen") {
    await openRemoval(interaction, store, managerRoleId);
    return;
  }
  const button = /^report:(edit|delete):([a-f0-9]{24})$/.exec(interaction.customId);
  if (!button) throw new ReportManagementError("Bitte die Buttons direkt am Ergebnispost verwenden.");
  const action = button[1];
  const message = interaction.message;
  if (message?.author?.id !== interaction.client.user.id || message.webhookId) {
    throw new ReportManagementError("Bitte die Aktion direkt an einem Ergebnispost dieses Bots öffnen.");
  }
  const record = store.findByMessage(interaction.guild.id, interaction.channelId, message.id);
  if (record.id !== button[2]) throw new ReportManagementError("Dieser Button gehört zu einem anderen Report.");
  authorize(interaction, record, action, managerRoleId);
  checkChannelAccess(interaction, interaction.channel);
  if (action === "delete") {
    await interaction.reply(deletionPrompt(interaction, record));
  } else if (record.change) {
    if (record.change.kind === "delete") {
      throw new ReportManagementError("Für diesen Report ist eine Löschung vorgemerkt. Bitte den Löschen-Button verwenden und die Löschung bestätigen.");
    }
    await interaction.deferReply(privateReply);
    const channel = await resolveChannel(interaction, record);
    const member = await currentMember(interaction);
    authorize(interaction, store.get(record.id, record.guildId), action, managerRoleId, member);
    checkChannelAccess(interaction, channel, channel.type === ChannelType.PrivateThread, member);
    const kind = await manager.apply(record.id, record.guildId, channel, interaction.client.user.id,
      undefined, undefined, actorOf(interaction, member));
    await interaction.editReply({ content: kind === "delete" ? "✅ Die vorgemerkte Löschung wurde abgeschlossen."
      : "✅ Die vorgemerkte Korrektur wurde abgeschlossen. Für weitere Änderungen die Aktion erneut öffnen.", allowedMentions: { parse: [] } });
  } else {
    await interaction.showModal(correctionModal(interaction, record, roleId, settingsStore));
  }
}

async function correctionData(interaction, record, roleId, settingsStore) {
  const winner = interaction.fields.getStringSelectValues("winner");
  const loser = interaction.fields.getStringSelectValues("loser");
  if (winner.length !== 1 || loser.length !== 1 || winner[0] === loser[0]) {
    throw new ReportManagementError("Bitte zwei unterschiedliche Teilnehmer auswählen.");
  }
  const players = await Promise.all([winner[0], loser[0]].map(async (id) => {
    const previous = record.players.find((player) => player.id === id);
    if (previous) return previous;
    let member;
    try { member = await interaction.guild.members.fetch({ user: id, force: true }); } catch {
      throw new ReportManagementError("Ein neu ausgewählter Teilnehmer konnte nicht geladen werden. Bitte das Formular erneut öffnen.");
    }
    if (member.user.bot || !member.roles.cache.has(roleId)) throw new ReportManagementError("Neu ausgewählte Personen müssen die Teilnehmerrolle haben.");
    return { id: member.id, name: member.displayName };
  }));
  // Read the submitted dropdown after member lookups and keep the report's original season.
  const selectedDays = interaction.fields.getStringSelectValues("matchday");
  const matchday = Number(selectedDays[0]);
  if (selectedDays.length !== 1 || !/^[1-9]\d?$/.test(selectedDays[0]) ||
      matchday > maximumMatchday(record, settingsStore)) {
    throw new ReportManagementError("Dieser Spieltag gehört nicht zur Season des Reports. Bitte die Korrektur erneut öffnen und einen gültigen Spieltag auswählen.");
  }
  const season = record.season;
  const score = interaction.fields.getTextInputValue("score");
  if (typeof score !== "string" || !score.trim() || score.length > 100) throw new ReportManagementError("Bitte ein Ergebnis mit höchstens 100 Zeichen eingeben.");
  const target = matchData({ ...record, id: undefined, publication: undefined, change: undefined, revision: undefined, result: undefined,
    season, matchday, players, link: normalizeReplayLink(interaction.fields.getTextInputValue("link")) });
  const message = createResultMessage(players[0].name, players[1].name, score, target.link, { season, matchday });
  return { kind: "edit", target, embed: message.embeds[0].toJSON(),
    result: { winnerId: players[0].id, loserId: players[1].id, score } };
}

async function handleManagementComponent(interaction, store, manager, roleId, settingsStore, managerRoleId) {
  if (interaction.customId?.startsWith("report:")) {
    await openManagement(interaction, store, manager, roleId, settingsStore, managerRoleId);
    return;
  }
  if (/^manage:(pick|page|stop):/.test(interaction.customId)) {
    await handleRemovalComponent(interaction, store, managerRoleId);
    return;
  }
  const parsed = /^manage:(edit|delete|cancel):([a-f0-9]{24}):([a-f0-9]{16}):(\d{17,20})$/.exec(interaction.customId);
  if (!parsed || parsed[4] !== interaction.user.id) throw new ReportManagementError("Diese Aktion gehört zu einer anderen Person oder ist ungültig. Bitte erneut am Ergebnispost öffnen.");
  const [, action, id, revision] = parsed;
  if (action === "cancel") {
    await interaction.update({ content: "Aktion abgebrochen.", components: [], embeds: [], allowedMentions: { parse: [] } });
    return;
  }
  const record = store.get(id, interaction.guild?.id);
  authorize(interaction, record, action, managerRoleId);
  if (revisionOf(record) !== revision) throw new ReportManagementError("Dieser Report wurde inzwischen geändert. Bitte die Aktion erneut öffnen.");
  if (action === "edit") await interaction.deferReply(privateReply);
  else await interaction.deferUpdate();
  const channel = await resolveChannel(interaction, record);
  const change = action === "edit" ? await correctionData(interaction, record, roleId, settingsStore) : { kind: "delete" };
  // Recheck after asynchronous channel/member lookups; the store also verifies the revision.
  const member = await currentMember(interaction);
  authorize(interaction, store.get(id, record.guildId), action, managerRoleId, member);
  checkChannelAccess(interaction, channel, channel.type === ChannelType.PrivateThread, member);
  const kind = await manager.apply(id, record.guildId, channel, interaction.client.user.id, change, revision, actorOf(interaction, member));
  await interaction.editReply({ content: kind === "delete" ? "✅ Report und Suchtreffer wurden entfernt."
    : `✅ Report korrigiert: **Season ${change.target.season} · Spieltag ${change.target.matchday}**. Der vorhandene Ergebnispost und der Suchtreffer sind aktualisiert.`,
    components: [], embeds: [], allowedMentions: { parse: [] } });
}

module.exports = { managementCommands, openManagement, handleManagementComponent, handleRemovalAutocomplete, correctionModal };
