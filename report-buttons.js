const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

function reportButtons(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report:edit:${id}`).setLabel("Bearbeiten").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`report:delete:${id}`).setLabel("Löschen").setEmoji("🗑️").setStyle(ButtonStyle.Danger)
  )];
}

async function installReportButtons(client, store, logger = console) {
  for (const record of store.matches) {
    if (record.publication?.status !== "published" || record.controlsVersion === 1) continue;
    const guild = client.guilds.cache.get(record.guildId);
    if (!guild) continue;
    try {
      const channel = await guild.channels.fetch(record.channelId);
      const message = await channel.messages.fetch({ message: record.publication.messageId, force: true });
      if (message.author?.id !== client.user.id || message.webhookId) continue;
      await message.edit({ components: reportButtons(record.id), allowedMentions: { parse: [] } });
      store.markControlsInstalled(record.id, record.guildId);
    } catch (error) {
      if (Number(error.code) !== 10008) logger.error("Buttons konnten an einem älteren Ergebnispost nicht ergänzt werden. Bitte Kanalrechte prüfen.");
    }
  }
}

module.exports = { reportButtons, installReportButtons };
