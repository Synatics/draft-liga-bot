const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
}); // WICHTIG: GuildMembers Intent!

// --- KONFIGURATION ---
const LIGA_ROLE_ID = "HIER_DEINE_ROLLEN_ID_REIN"; // <--- HIER EINFÜGEN!

// Hilfsfunktion: Baut die Optionen für das Dropdown
const SPACER = "⠀";

function centerText(text, targetLength = 25) {
  // 25 ist eine gute Breite für Namen
  if (!text) return text;
  if (text.length >= targetLength) return text;

  const totalPadding = targetLength - text.length;
  const sidePadding = Math.floor(totalPadding / 2);

  return (
    SPACER.repeat(sidePadding) +
    text +
    SPACER.repeat(sidePadding + (totalPadding % 2))
  );
}
// excludeUserId: Falls wir jemanden ausschließen wollen (damit man nicht gegen sich selbst spielt)
async function getPlayerOptions(guild, excludeUserId = null) {
  // Sicherstellen, dass alle Member geladen sind
  await guild.members.fetch();

  const role = guild.roles.cache.get(LIGA_ROLE_ID);
  if (!role) return [];

  // Filter: Nur echte User (keine Bots) und optional jemanden ausschließen
  const members = role.members.filter(
    (m) => !m.user.bot && m.id !== excludeUserId
  );

  // Optionen bauen
  return members.map((member) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(member.displayName) // Der Name, wie er auf dem Server steht
      .setDescription(member.user.username) // Der echte Username
      .setValue(member.id) // Wir nutzen die ID als Wert!
      .setEmoji("👤")
  );
}

// 1. Slash Command Registrierung
const commands = [
  {
    name: "report",
    description: "Melde ein Match-Ergebnis (Interaktiver Wizard)",
  },
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
  } catch (error) {
    console.error(error);
  }
})();

client.on("interactionCreate", async (interaction) => {
  // SCHRITT 1: Der Befehl startet -> Zeige Gewinner-Auswahl
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "report"
  ) {
    const options = await getPlayerOptions(interaction.guild);

    if (options.length === 0) {
      return interaction.reply({
        content: "Fehler: Keine Spieler mit der Liga-Rolle gefunden!",
        ephemeral: true,
      });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("select_winner")
      .setPlaceholder("Wer hat gewonnen?")
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({
      content: "Schritt 1/3: Wähle den **Gewinner**:",
      components: [row],
      ephemeral: true,
    });
  }

  // SCHRITT 2: Gewinner gewählt -> Zeige Verlierer-Auswahl
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId === "select_winner"
  ) {
    const winnerId = interaction.values[0]; // Die ID des gewählten Users

    // Wir laden die Optionen neu, aber schließen den Gewinner aus!
    // Ash kann nicht gegen Ash spielen.
    const options = await getPlayerOptions(interaction.guild, winnerId);

    // Wir speichern die winnerId in der CustomId des nächsten Menüs
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`select_loser_${winnerId}`)
      .setPlaceholder("Gegen wen?")
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    // Update der Nachricht (Wizard-Feeling)
    await interaction.update({
      content: `Gewinner: <@${winnerId}>\nSchritt 2/3: Wähle den **Verlierer**:`,
      components: [row],
    });
  }

  // SCHRITT 3: Verlierer gewählt -> Modal öffnen
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith("select_loser_")
  ) {
    const loserId = interaction.values[0];
    const winnerId = interaction.customId.split("_")[2]; // ID aus dem Namen holen

    // Modal bauen (IDs wieder weiterschleusen)
    const modal = new ModalBuilder()
      .setCustomId(`submit_match_${winnerId}_${loserId}`)
      .setTitle("Match Details");

    const scoreInput = new TextInputBuilder()
      .setCustomId("score")
      .setLabel("Ergebnis")
      .setPlaceholder("z.B. 2-0")
      .setStyle(TextInputStyle.Short);

    const linkInput = new TextInputBuilder()
      .setCustomId("link")
      .setLabel("Replay Link")
      .setStyle(TextInputStyle.Paragraph);

    modal.addComponents(
      new ActionRowBuilder().addComponents(scoreInput),
      new ActionRowBuilder().addComponents(linkInput)
    );

    await interaction.showModal(modal);
  }

  // SCHRITT 4: Finale -> Speichern & Posten
  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("submit_match_")
  ) {
    const [_, __, winnerId, loserId] = interaction.customId.split("_");

    const score = interaction.fields.getTextInputValue("score");
    const link = interaction.fields.getTextInputValue("link");

    // Wir holen uns die echten Member-Objekte, um die Namen als Text zu bekommen
    // (Wichtig, damit wir sie verlängern können)
    const winnerMember = await interaction.guild.members
      .fetch(winnerId)
      .catch(() => null);
    const loserMember = await interaction.guild.members
      .fetch(loserId)
      .catch(() => null);

    // Fallback, falls wer den Server verlassen hat
    const winnerName = winnerMember ? winnerMember.displayName : "Unbekannt";
    const loserName = loserMember ? loserMember.displayName : "Unbekannt";

    const embed = new EmbedBuilder()
      .setTitle("🏆 Liga Match Report")
      .setDescription(`Match wurde eingetragen!`)
      .setColor("#FFD700")
      .addFields(
        // Hier wenden wir centerText an:
        {
          name: "Gewinner",
          value: `|| ${centerText(winnerName, 25)} ||`, // Name als Text, zentriert & spoiler
          inline: true,
        },
        {
          name: "Verlierer",
          value: `|| ${centerText(loserName, 25)} ||`,
          inline: true,
        },
        // Auch den Score machen wir wieder hübsch breit
        {
          name: "Score",
          value: `|| ${centerText(score, 25)} ||`,
          inline: false,
        },
        {
          name: "Replay",
          value: `|| ${link} ||`,
          inline: false,
        }
      )
      .setFooter({ text: `Gemeldet von ${interaction.user.username}` })
      .setTimestamp();

    await interaction.channel.send({ embeds: [embed] });
    await interaction.update({
      content: "✅ Match gespeichert!",
      components: [],
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
