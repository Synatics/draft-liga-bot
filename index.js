const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
require("dotenv").config();

const SPACER = "⠀";

function centerText(text, targetLength = 16) {
  // Falls der Text schon zu lang ist, lassen wir ihn so
  if (text.length >= targetLength) return text;

  const totalPadding = targetLength - text.length;
  const sidePadding = Math.floor(totalPadding / 2);

  // Wir bauen den String: Leerzeichen links + Text + Leerzeichen rechts
  return (
    SPACER.repeat(sidePadding) +
    text +
    SPACER.repeat(sidePadding + (totalPadding % 2))
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const capitalize = (s) => s && s[0].toUpperCase() + s.slice(1);

const commands = [
  {
    name: "report",
    description: "Öffnet das Formular um ein Match-Ergebnis einzutragen",
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
  // A. MODAL ÖFFNEN: Wenn /report getippt wird
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === "report"
  ) {
    const modal = new ModalBuilder()
      .setCustomId("submit_report")
      .setTitle("Match Report");

    // Die 4 Felder (Identisch wie vorher)
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("winner")
          .setLabel("Gewinner (Vorname)")
          .setPlaceholder("z.B. Ash")
          .setStyle(TextInputStyle.Short)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("loser")
          .setLabel("Verlierer (Vorname)")
          .setPlaceholder("z.B. Gary")
          .setStyle(TextInputStyle.Short)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("score")
          .setLabel("Ergebnis")
          .setPlaceholder("z.B. 2-0")
          .setStyle(TextInputStyle.Short)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("link")
          .setLabel("Replay Link")
          .setPlaceholder("https://...")
          .setStyle(TextInputStyle.Paragraph)
      )
    );

    // WICHTIG: Das muss die ERSTE Antwort auf den Befehl sein!
    await interaction.showModal(modal);
  }

  // B. DATEN VERARBEITEN (Identisch wie vorher)
  if (interaction.isModalSubmit() && interaction.customId === "submit_report") {
    try {
      const winner = capitalize(interaction.fields.getTextInputValue("winner"));
      const loser = capitalize(interaction.fields.getTextInputValue("loser"));
      const score = interaction.fields.getTextInputValue("score");
      const link = interaction.fields.getTextInputValue("link");

      const resultEmbed = new EmbedBuilder()
        .setTitle(`🏆 Liga Match: ${winner} vs. ${loser}`)
        .setColor("#FFD700")
        .addFields(
          {
            name: "Gewinner",
            value: `|| ${centerText(winner)} ||`,
            inline: true,
          },
          {
            name: "Verlierer",
            value: `|| ${centerText(loser)} ||`,
            inline: true,
          },
          {
            name: "Score",
            value: `|| ${centerText(score, (targetLength = 6))} ||`,
            inline: false,
          },
          { name: "Replay Link", value: link, inline: false }
        )
        .setFooter({ text: `Eingetragen von ${interaction.user.username}` })
        .setTimestamp();

      // Ins Channel senden
      await interaction.channel.send({
        embeds: [resultEmbed],
        //flags: [MessageFlags.SuppressEmbeds], // Suppress Embeds (Vorschau unterdrücken)
      });

      // Dem User, der den Befehl ausgeführt hat, eine "unsichtbare" Bestätigung geben
      await interaction.reply({
        content: "✅ Ergebnis erfolgreich gepostet!",
        flags: [MessageFlags.Ephemeral], // Nur für den User sichtbar
      });
    } catch (error) {
      console.error("Fehler beim Verarbeiten des Modals:", error);
      await interaction.reply({
        content:
          "❌ Es gab einen Fehler beim Verarbeiten deines Reports. Bitte versuche es erneut.",
        flags: [MessageFlags.Ephemeral],
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
