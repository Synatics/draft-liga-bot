const {
  ActionRowBuilder, ApplicationCommandType, ButtonBuilder, ButtonStyle, ChannelType,
  LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, escapeMarkdown,
} = require("discord.js");
const { matchData, normalizeReplayLink, revisionOf } = require("./match-store");
const { createResultMessage } = require("./reports");
const { ReportManagementError } = require("./report-manager");
const { playerChoices, resolvePlayer } = require("./search-commands");

const managementCommands = [
  { name: "Report korrigieren", type: ApplicationCommandType.Message, contexts: [0] },
  { name: "Report löschen", type: ApplicationCommandType.Message, contexts: [0] },
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
const customId = (action, record, userId, context) => `manage:${action}:${record.id}:${revisionOf(record)}:${userId}` +
  (context ? `:${context.season}:${context.matchday}` : "");
const correctionDrafts = new WeakMap();

function correctionDraft(store, interaction, record, context) {
  const messageId = interaction.message?.id;
  if (!messageId) return { context };
  if (!correctionDrafts.has(store)) correctionDrafts.set(store, new Map());
  const drafts = correctionDrafts.get(store);
  const now = Date.now();
  for (const [key, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(key);
  const key = `${record.guildId}:${record.id}:${revisionOf(record)}:${interaction.user.id}:${messageId}`;
  if (!drafts.has(key)) drafts.set(key, { context, expiresAt: now + 15 * 60_000 });
  return drafts.get(key);
}

function activeSettings(settingsStore, guildId) {
  try { return settingsStore?.get(guildId); } catch { return undefined; }
}

function selectedContext(requested, settings) {
  return { season: requested.season,
    matchday: Math.min(requested.matchday, settings?.season === requested.season ? settings.matchdays : 25) };
}

function validateContext(context, settingsStore, guildId) {
  if (!context || !Number.isInteger(context.season) || context.season < 1 || context.season > 9999 ||
      !Number.isInteger(context.matchday) || context.matchday < 1 || context.matchday > 25) {
    throw new ReportManagementError("Bitte die Korrektur erneut öffnen und Season und Spieltag auswählen.");
  }
  const settings = activeSettings(settingsStore, guildId);
  if (settings?.season === context.season && context.matchday > settings.matchdays) {
    throw new ReportManagementError("Dieser Spieltag gehört nicht zur eingerichteten Season. Bitte die Korrektur erneut öffnen.");
  }
}

function contextPrompt(interaction, record, store, settingsStore, requested = record, source = interaction.targetMessage || interaction.message) {
  const settings = activeSettings(settingsStore, record.guildId);
  const maximum = settings?.season === requested.season ? settings.matchdays : 25;
  const context = selectedContext(requested, settings);
  const required = new Set([record.season, context.season, ...(settings ? [settings.season] : [])]);
  const seasons = [...new Set([...store.list(record.guildId).map((match) => match.season), ...required])]
    .sort((a, b) => b - a);
  // Reserve a choice for arbitrary season numbers; selected/current seasons always remain visible.
  const choices = [...required, ...seasons.filter((season) => !required.has(season))].slice(0, 24).sort((a, b) => b - a);
  return {
    ...privateReply,
    content: `**Report korrigieren · Schritt 1 von 2**\nSeason und Spieltag auswählen, dann auf „Weiter“ klicken.\nAusgewählt: **Season ${context.season} · Spieltag ${context.matchday}**`,
    embeds: source?.embeds?.slice(0, 1) || [],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(customId("season", record, interaction.user.id, context)).setPlaceholder("Season auswählen")
        .setMinValues(1).setMaxValues(1).addOptions([
          ...choices.map((season) => ({ label: `Season ${season}`, value: String(season), default: season === context.season })),
          { label: "Andere Season …", value: "other", description: "Eine andere Season-Nummer eingeben" },
        ])),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(customId("day", record, interaction.user.id, context)).setPlaceholder("Spieltag auswählen")
        .setMinValues(1).setMaxValues(1).addOptions(Array.from({ length: maximum }, (_, index) => ({
          label: `Spieltag ${index + 1}`, value: String(index + 1), default: index + 1 === context.matchday,
        })))),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(customId("form", record, interaction.user.id, context))
          .setLabel("Weiter: Ergebnis bearbeiten").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(customId("cancel", record, interaction.user.id)).setLabel("Abbrechen").setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

function canManage(interaction, record) {
  return interaction.guild?.id === record.guildId && (record.players.some((player) => player.id === interaction.user.id) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function authorize(interaction, record) {
  if (!canManage(interaction, record)) {
    throw new ReportManagementError("Nur die beiden Match-Teilnehmer oder Personen mit „Server verwalten“ dürfen diesen Report ändern oder löschen.");
  }
}

function checkChannelAccess(interaction, channel, privateMemberVerified = false) {
  const permissions = channel?.permissionsFor(interaction.member);
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

function correctionModal(interaction, record, roleId, context = record) {
  const message = interaction.targetMessage || interaction.message;
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
  return new ModalBuilder().setCustomId(customId("edit", record, interaction.user.id, context))
    .setTitle(`Report korrigieren · S${context.season} · ST${context.matchday}`)
    .addLabelComponents(
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

async function removableMatches(interaction, store) {
  if (!interaction.guild) return [];
  const matches = store.list(interaction.guild.id).filter((match) =>
    match.publication?.status === "published" && canManage(interaction, match));
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

async function handleRemovalAutocomplete(interaction, store) {
  const season = interaction.options.getInteger("season");
  const focused = interaction.options.getFocused(true);
  await interaction.respond(focused.name === "name" && season
    ? playerChoices(await removableMatches(interaction, store), season, String(focused.value)) : []);
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

async function openRemoval(interaction, store) {
  await interaction.deferReply(privateReply);
  const season = interaction.options.getInteger("season", true);
  const matchday = interaction.options.getInteger("spieltag");
  if (!Number.isInteger(season) || season < 1 || season > 9999 ||
      (matchday != null && (!Number.isInteger(matchday) || matchday < 1 || matchday > 25))) {
    throw new ReportManagementError("Bitte eine Season von 1–9999 und optional einen Spieltag von 1–25 auswählen.");
  }
  const matches = await removableMatches(interaction, store);
  const player = resolvePlayer(matches, season, interaction.options.getString("name", true));
  const query = { season, matchday, playerId: player?.id };
  const found = matchingRemovals(matches, query);
  const { flags, ...prompt } = found.length === 1 ? deletionPrompt(interaction, found[0]) : removalPicker(interaction, found, query);
  await interaction.editReply(prompt);
}

async function handleRemovalComponent(interaction, store) {
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
    authorize(interaction, record);
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
  const matches = matchingRemovals(await removableMatches(interaction, store), query);
  await interaction.editReply(removalPicker(interaction, matches, query, Number(page)));
}

async function openManagement(interaction, store, manager, roleId, settingsStore) {
  if (!interaction.guild) throw new ReportManagementError("Bitte verwende die Aktion auf dem Liga-Server.");
  if (interaction.commandName === "report-entfernen") {
    await openRemoval(interaction, store);
    return;
  }
  const message = interaction.targetMessage;
  if (message?.author?.id !== interaction.client.user.id || message.webhookId) {
    throw new ReportManagementError("Bitte die Aktion direkt an einem Ergebnispost dieses Bots öffnen.");
  }
  const record = store.findByMessage(interaction.guild.id, interaction.channelId, message.id);
  authorize(interaction, record);
  checkChannelAccess(interaction, interaction.channel);
  if (interaction.commandName === "Report löschen") {
    await interaction.reply(deletionPrompt(interaction, record));
  } else if (record.change) {
    if (record.change.kind === "delete") {
      throw new ReportManagementError("Für diesen Report ist eine Löschung vorgemerkt. Bitte „Report löschen“ öffnen und die Löschung bestätigen, um sie abzuschließen.");
    }
    await interaction.deferReply(privateReply);
    const channel = await resolveChannel(interaction, record);
    const kind = await manager.apply(record.id, record.guildId, channel, interaction.client.user.id);
    await interaction.editReply({ content: kind === "delete" ? "✅ Die vorgemerkte Löschung wurde abgeschlossen."
      : "✅ Die vorgemerkte Korrektur wurde abgeschlossen. Für weitere Änderungen die Aktion erneut öffnen.", allowedMentions: { parse: [] } });
  } else {
    await interaction.reply(contextPrompt(interaction, record, store, settingsStore));
  }
}

async function correctionData(interaction, record, roleId, settingsStore, context) {
  validateContext(context, settingsStore, record.guildId);
  const { season, matchday } = context;
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
  const score = interaction.fields.getTextInputValue("score");
  if (typeof score !== "string" || !score.trim() || score.length > 100) throw new ReportManagementError("Bitte ein Ergebnis mit höchstens 100 Zeichen eingeben.");
  const target = matchData({ ...record, id: undefined, publication: undefined, change: undefined, revision: undefined,
    season, matchday, players, link: normalizeReplayLink(interaction.fields.getTextInputValue("link")) });
  const message = createResultMessage(players[0].name, players[1].name, score, target.link, { season, matchday });
  return { kind: "edit", target, embed: message.embeds[0].toJSON() };
}

async function handleManagementComponent(interaction, store, manager, roleId, settingsStore) {
  if (/^manage:(pick|page|stop):/.test(interaction.customId)) {
    await handleRemovalComponent(interaction, store);
    return;
  }
  const parsed = /^manage:(edit|delete|cancel|season|day|form|number):([a-f0-9]{24}):([a-f0-9]{16}):(\d{17,20})(?::([1-9]\d{0,3}):([1-9]\d?))?$/.exec(interaction.customId);
  if (!parsed || parsed[4] !== interaction.user.id) throw new ReportManagementError("Diese Aktion gehört zu einer anderen Person oder ist ungültig. Bitte erneut am Ergebnispost öffnen.");
  const [, action, id, revision, , selectedSeason, selectedDay] = parsed;
  const context = selectedSeason ? { season: Number(selectedSeason), matchday: Number(selectedDay) } : undefined;
  if (action === "cancel") {
    await interaction.update({ content: "Aktion abgebrochen.", components: [], embeds: [], allowedMentions: { parse: [] } });
    return;
  }
  const record = store.get(id, interaction.guild?.id);
  authorize(interaction, record);
  if (revisionOf(record) !== revision) throw new ReportManagementError("Dieser Report wurde inzwischen geändert. Bitte die Aktion erneut öffnen.");
  if (["season", "day", "form", "number"].includes(action)) {
    if (record.change) throw new ReportManagementError("Für diesen Report läuft bereits eine Änderung. Bitte die Aktion erneut am Ergebnispost öffnen.");
    checkChannelAccess(interaction, interaction.channel);
    // A following click may still carry the previous custom ID until Discord applies update().
    // Keep each private picker's latest selection before awaiting that network request.
    const draft = correctionDraft(store, interaction, record, context);
    validateContext(draft.context, settingsStore, record.guildId);
    if (action === "form") {
      await interaction.showModal(correctionModal(interaction, record, roleId, draft.context));
      return;
    }
    if (action === "season" && interaction.values?.length === 1 && interaction.values[0] === "other") {
      await interaction.showModal(new ModalBuilder().setCustomId(customId("number", record, interaction.user.id, draft.context))
        .setTitle("Andere Season auswählen").addLabelComponents(new LabelBuilder().setLabel("Season")
          .setTextInputComponent(new TextInputBuilder().setCustomId("season").setStyle(TextInputStyle.Short)
            .setRequired(true).setMaxLength(4).setPlaceholder("Season-Nummer von 1 bis 9999"))));
      return;
    }
    const value = action === "number" ? interaction.fields.getTextInputValue("season").trim()
      : interaction.values?.length === 1 ? interaction.values[0] : "";
    if (!/^[1-9]\d{0,3}$/.test(value)) throw new ReportManagementError("Bitte eine gültige Season bzw. einen Spieltag auswählen.");
    const chosen = { ...draft.context, [action === "day" ? "matchday" : "season"]: Number(value) };
    if (action === "day") validateContext(chosen, settingsStore, record.guildId);
    draft.context = selectedContext(chosen, activeSettings(settingsStore, record.guildId));
    const { flags, ...prompt } = contextPrompt(interaction, record, store, settingsStore, draft.context);
    await interaction.update(prompt);
    return;
  }
  if (action === "edit" && !interaction.isFromMessage?.()) await interaction.deferReply(privateReply);
  else await interaction.deferUpdate();
  const channel = await resolveChannel(interaction, record);
  const change = action === "edit" ? await correctionData(interaction, record, roleId, settingsStore, context) : { kind: "delete" };
  // Recheck after asynchronous channel/member lookups; the store also verifies the revision.
  authorize(interaction, store.get(id, record.guildId));
  const kind = await manager.apply(id, record.guildId, channel, interaction.client.user.id, change, revision);
  await interaction.editReply({ content: kind === "delete" ? "✅ Report und Suchtreffer wurden entfernt."
    : `✅ Report korrigiert: **Season ${change.target.season} · Spieltag ${change.target.matchday}**. Der vorhandene Ergebnispost und der Suchtreffer sind aktualisiert.`,
    components: [], embeds: [], allowedMentions: { parse: [] } });
}

module.exports = { managementCommands, openManagement, handleManagementComponent, handleRemovalAutocomplete, correctionModal };
