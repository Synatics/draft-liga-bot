const { randomBytes } = require("node:crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { LeagueSettingsError, normalizeStartDate } = require("./league-settings");
const { isLeagueManager, currentMember } = require("./permissions");
const { FORMAT_NAMES, STAGE_NAMES, buildRounds, roundLabel } = require("./season-rounds");

const SESSION_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;
const privateReply = { flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } };
const id = (session, action) => `season:${action}:${session.id}:${session.revision}`;
const button = (session, action, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id(session, action)).setLabel(label).setStyle(style);

function input(name, label, value, maximum, description) {
  const component = new TextInputBuilder()
    .setCustomId(name)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(maximum);
  if (value) component.setValue(String(value).slice(0, maximum));
  return new LabelBuilder()
    .setLabel(label)
    .setDescription(description)
    .setTextInputComponent(component);
}

function select(name, label, choices, selected, description) {
  const component = new StringSelectMenuBuilder()
    .setCustomId(name)
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true)
    .addOptions(
      Object.entries(choices).map(([value, text]) => ({
        value,
        label: text,
        default: value === selected,
      })),
    );
  return new LabelBuilder()
    .setLabel(label)
    .setDescription(description)
    .setStringSelectMenuComponent(component);
}

function basicsModal(session) {
  const raw = session.raw;
  return new ModalBuilder()
    .setCustomId(id(session, "basics"))
    .setTitle("Season · Grunddaten")
    .addLabelComponents(
      input(
        "number",
        "Season-Nummer",
        raw.number,
        4,
        "Nummer beibehalten zum Korrigieren; für eine neue Season eine neue Nummer wählen.",
      ),
      input(
        "days",
        "Reguläre Spieltage insgesamt",
        raw.days,
        2,
        "Ohne Playoffs. Bei Hin-/Rückrunde beide Hälften zusammen, z. B. 18 für 9 + 9.",
      ),
      input(
        "start",
        "Startdatum (Montag)",
        raw.start,
        10,
        "TT.MM.JJJJ oder JJJJ-MM-TT, z. B. 26.10.2026.",
      ),
      select(
        "format",
        "Season-Format",
        FORMAT_NAMES,
        raw.format,
        "Weitere Einstellungen folgen passend zum gewählten Format.",
      ),
    );
}

function detailsModal(session) {
  const draft = session.draft;
  const modal = new ModalBuilder()
    .setCustomId(id(session, "details"))
    .setTitle("Season · Weitere Einstellungen")
    .addLabelComponents(
      select(
        "redraft",
        "Redraft-Woche",
        { no: "Nein", yes: "Ja" },
        draft.redraft ? "yes" : "no",
        draft.format === "home-away"
          ? "Eine spielfreie Woche zwischen Hin- und Rückrunde."
          : "Eine spielfreie Woche vor den Playoffs.",
      ),
    );
  if (draft.format === "playoffs")
    modal.addLabelComponents(
      select(
        "playoffs",
        "Erste Playoff-Runde",
        STAGE_NAMES,
        draft.playoffsFrom ?? "semifinal",
        "Alle folgenden Runden bis zum Finale werden automatisch ergänzt.",
      ),
    );
  return modal;
}

function readChoice(fields, name, choices) {
  let values;
  try {
    values = fields.getStringSelectValues(name);
  } catch {
    /* Handle forged or incomplete modal submissions as input errors. */
  }
  if (!Array.isArray(values) || values.length !== 1 || !Object.hasOwn(choices, values[0]))
    throw new LeagueSettingsError("Bitte alle Auswahllisten mit einem gültigen Wert ausfüllen.");
  return values[0];
}

function readText(fields, name) {
  let value;
  try {
    value = fields.getTextInputValue(name);
  } catch {
    /* Missing fields are input errors. */
  }
  if (typeof value !== "string")
    throw new LeagueSettingsError("Bitte alle Grunddaten vollständig ausfüllen.");
  return value.trim();
}

function parseBasics(session, fields) {
  const raw = {
    number: readText(fields, "number"),
    days: readText(fields, "days"),
    start: readText(fields, "start"),
    format: readChoice(fields, "format", FORMAT_NAMES),
  };
  session.raw = raw;
  if (!/^[1-9]\d{0,3}$/.test(raw.number))
    throw new LeagueSettingsError("Die Season-Nummer muss eine ganze Zahl von 1 bis 9999 sein.");
  if (!/^[1-9]\d?$/.test(raw.days) || Number(raw.days) > 25)
    throw new LeagueSettingsError("Bitte 1 bis 25 reguläre Spieltage eingeben.");
  if (raw.format === "home-away" && Number(raw.days) % 2 !== 0)
    throw new LeagueSettingsError(
      "Bei Hin- und Rückrunde muss die Gesamtzahl gerade sein, z. B. 18 für zweimal 9.",
    );
  const draft = {
    season: Number(raw.number),
    matchdays: Number(raw.days),
    startDate: normalizeStartDate(raw.start),
    format: raw.format,
    redraft: raw.format === "league" ? false : session.draft.redraft,
    ...(raw.format === "playoffs"
      ? { playoffsFrom: session.draft.playoffsFrom ?? "semifinal" }
      : {}),
  };
  session.draft = draft;
}

function planEmbed(session, saved = false) {
  const draft = session.draft;
  const embed = new EmbedBuilder()
    .setTitle(`Season ${draft.season} · ${saved ? "gespeichert" : "Plan prüfen"}`)
    .setColor("#FFD700")
    .addFields(
      { name: "Format", value: FORMAT_NAMES[draft.format] },
      { name: "Reguläre Spieltage", value: String(draft.matchdays), inline: true },
      { name: "Startdatum", value: draft.startDate.split("-").reverse().join("."), inline: true },
    );
  if (session.step === "preview") {
    const rounds = buildRounds(draft.matchdays, draft);
    embed.addFields({
      name: "Redraft",
      value: draft.redraft ? "Ja · eine Woche" : "Nein",
      inline: true,
    });
    if (draft.playoffsFrom)
      embed.addFields({
        name: "Playoffs ab",
        value: STAGE_NAMES[draft.playoffsFrom],
        inline: true,
      });
    embed.setDescription(
      rounds.map((round, index) => `Woche ${index + 1}: ${roundLabel(round)}`).join("\n"),
    );
  }
  return embed;
}

function prompt(session, error) {
  const row = new ActionRowBuilder();
  if (session.step === "preview")
    row.addComponents(button(session, "save", "Season speichern", ButtonStyle.Success));
  if (session.step === "options")
    row.addComponents(button(session, "options", "Weiter", ButtonStyle.Primary));
  row.addComponents(
    button(
      session,
      "edit",
      session.step === "basics" ? "Eingaben korrigieren" : "Grunddaten ändern",
    ),
  );
  if (session.step === "preview" && session.draft.format !== "league")
    row.addComponents(button(session, "options", "Weitere Einstellungen ändern"));
  row.addComponents(button(session, "cancel", "Abbrechen"));
  return {
    content: error
      ? `${error.message}\nNoch nichts gespeichert. Bitte die Eingaben korrigieren.`
      : session.step === "preview"
        ? "Bitte den Wochenplan prüfen. Erst „Season speichern“ übernimmt die Einstellungen. Bereits gepostete Ergebnisse behalten ihre gespeicherte Runde."
        : "Die Grunddaten sind übernommen. Über „Weiter“ legst du die weiteren Einstellungen fest. Noch nichts gespeichert.",
    embeds: session.step === "basics" ? [] : [planEmbed(session)],
    components: [row],
    allowedMentions: { parse: [] },
  };
}

/** Private, bounded drafts per bot instance. Only the final save writes league settings. */
function createSeasonSetup({ settingsStore, managerRoleId, now = Date.now }) {
  const sessions = new Map();
  function authorize(interaction, member = interaction.member) {
    if (!isLeagueManager(interaction, managerRoleId, member))
      throw new LeagueSettingsError("Zum Verwalten der Liga brauchst du die Ligaverwaltungsrolle.");
  }
  function active(session) {
    if (sessions.get(session.id) !== session || session.expiresAt <= now()) {
      sessions.delete(session.id);
      throw new LeagueSettingsError(
        "Dieser Einrichtungsdialog ist abgelaufen oder bereits abgeschlossen. Bitte /liga season erneut öffnen.",
      );
    }
  }
  function prune() {
    for (const session of sessions.values())
      if (session.expiresAt <= now()) sessions.delete(session.id);
  }
  async function open(interaction) {
    authorize(interaction);
    prune();
    for (const session of sessions.values())
      if (session.guildId === interaction.guild.id && session.userId === interaction.user.id) {
        if (session.busy)
          throw new LeagueSettingsError(
            "Dein Einrichtungsdialog wird gerade verarbeitet. Bitte kurz warten.",
          );
        sessions.delete(session.id);
      }
    if (sessions.size >= MAX_SESSIONS)
      throw new LeagueSettingsError(
        "Es sind gerade zu viele Einrichtungsdialoge offen. Bitte später erneut versuchen.",
      );
    const saved = settingsStore.configuration(interaction.guild.id);
    const draft = {
      season: saved?.season ?? 1,
      matchdays: saved?.matchdays ?? 9,
      startDate: saved?.startDate ?? "",
      format: saved?.format ?? "league",
      redraft: saved?.redraft ?? false,
      ...(saved?.playoffsFrom ? { playoffsFrom: saved.playoffsFrom } : {}),
    };
    const session = {
      id: randomBytes(12).toString("hex"),
      revision: 0,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      baseRevision: settingsStore.revision(interaction.guild.id),
      draft,
      raw: {
        number: String(draft.season),
        days: String(draft.matchdays),
        start: draft.startDate,
        format: draft.format,
      },
      step: "basics",
      forms: new Set(["basics"]),
      expiresAt: now() + SESSION_MS,
      busy: false,
    };
    sessions.set(session.id, session);
    try {
      await interaction.showModal(basicsModal(session));
    } catch (error) {
      sessions.delete(session.id);
      throw error;
    }
  }
  async function handle(interaction) {
    const parsed =
      /^season:(basics|details|edit|options|save|cancel):([a-f0-9]{24}):(\d{1,6})$/.exec(
        interaction.customId,
      );
    const session = parsed && sessions.get(parsed[2]);
    if (
      !session ||
      session.guildId !== interaction.guild?.id ||
      session.userId !== interaction.user.id
    )
      throw new LeagueSettingsError(
        "Dieser Einrichtungsdialog gehört zu einer anderen Person oder ist abgelaufen. Bitte /liga season erneut öffnen.",
      );
    active(session);
    if (session.revision !== Number(parsed[3]))
      throw new LeagueSettingsError(
        "Dieser Schritt ist veraltet. Bitte die neueste Nachricht des Einrichtungsdialogs verwenden.",
      );
    if (session.busy)
      throw new LeagueSettingsError(
        "Dieser Einrichtungsdialog wird gerade verarbeitet. Bitte kurz warten.",
      );
    const action = parsed[1];
    const modal = interaction.isModalSubmit();
    if (
      (modal && !["basics", "details"].includes(action)) ||
      (!modal && !interaction.isButton?.()) ||
      (!modal && ["basics", "details"].includes(action))
    )
      throw new LeagueSettingsError("Diese Aktion ist ungültig. Bitte /liga season erneut öffnen.");
    if (action === "cancel") {
      sessions.delete(session.id);
      await interaction.update({
        content: "Einrichtung abgebrochen. Es wurden keine Einstellungen gespeichert.",
        components: [],
        embeds: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    authorize(interaction);
    if (action === "edit" || action === "options") {
      if (action === "options" && session.step === "basics")
        throw new LeagueSettingsError("Bitte erst die Grunddaten ausfüllen.");
      if (action === "options" && session.draft.format === "league")
        throw new LeagueSettingsError("Dieses Format benötigt keine weiteren Einstellungen.");
      const form = action === "edit" ? "basics" : "details";
      session.forms.add(form);
      await interaction.showModal(form === "basics" ? basicsModal(session) : detailsModal(session));
      return;
    }
    if (modal && !session.forms.has(action))
      throw new LeagueSettingsError(
        "Dieses Formular wurde nicht geöffnet. Bitte den vorgesehenen Schritt verwenden.",
      );
    if (action === "save" && session.step !== "preview")
      throw new LeagueSettingsError(
        "Bitte erst alle Einstellungen ausfüllen und den Wochenplan prüfen.",
      );
    session.busy = true;
    try {
      if (modal) await interaction.deferReply(privateReply);
      else await interaction.deferUpdate();
      const member = await currentMember(interaction);
      active(session);
      authorize(interaction, member);
      if (action === "save") {
        if (settingsStore.revision(session.guildId) !== session.baseRevision)
          throw new LeagueSettingsError(
            "Die Liga-Einstellungen wurden inzwischen geändert. Bitte /liga season erneut öffnen und die aktuellen Werte prüfen.",
          );
        const draft = session.draft;
        buildRounds(draft.matchdays, draft);
        const result = settingsStore.setSeason(
          session.guildId,
          draft.season,
          draft.matchdays,
          draft.startDate,
          {
            format: draft.format,
            redraft: draft.redraft,
            ...(draft.playoffsFrom ? { playoffsFrom: draft.playoffsFrom } : {}),
          },
        );
        sessions.delete(session.id);
        await interaction.editReply({
          content: `Season ${result.season} · ${roundLabel(result.currentRound)} gespeichert. Der Wochenwechsel erfolgt automatisch montags um 00:00 Uhr deutscher Zeit.`,
          embeds: [planEmbed(session, true)],
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      let inputError;
      try {
        if (action === "basics") {
          parseBasics(session, interaction.fields);
          session.step = session.draft.format === "league" ? "preview" : "options";
        } else {
          session.draft.redraft =
            readChoice(interaction.fields, "redraft", { yes: true, no: false }) === "yes";
          if (session.draft.format === "playoffs")
            session.draft.playoffsFrom = readChoice(interaction.fields, "playoffs", STAGE_NAMES);
          try {
            buildRounds(session.draft.matchdays, session.draft);
          } catch (error) {
            throw new LeagueSettingsError(error.message);
          }
          session.step = "preview";
        }
      } catch (error) {
        if (!(error instanceof LeagueSettingsError) || Object.hasOwn(error, "cause")) throw error;
        inputError = error;
        session.step = action === "basics" ? "basics" : "options";
      }
      session.revision++;
      session.forms.clear();
      await interaction.editReply(prompt(session, inputError));
    } finally {
      session.busy = false;
    }
  }
  return { open, handle };
}

module.exports = { createSeasonSetup, SESSION_MS };
