import logging
import os
import random

import discord
from discord import app_commands
from dotenv import load_dotenv

load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
logger = logging.getLogger(__name__)

SPACER = "⠀"


def center_text(text: str, target_length: int = 16) -> str:
    if len(text) >= target_length:
        return text

    total_padding = target_length - len(text)
    side_padding = total_padding // 2

    return SPACER * side_padding + text + SPACER * (side_padding + total_padding % 2)


def capitalize(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


class LigaBotClient(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents(guilds=True))
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self):
        await self.tree.sync()


client = LigaBotClient()


class MatchReportModal(discord.ui.Modal, title="Match Report"):
    winner = discord.ui.TextInput(
        label="Gewinner", placeholder="z.B. Jan", style=discord.TextStyle.short
    )
    loser = discord.ui.TextInput(
        label="Verlierer", placeholder="z.B. Lennart", style=discord.TextStyle.short
    )
    score = discord.ui.TextInput(
        label="Ergebnis", placeholder="z.B. 2-0", style=discord.TextStyle.short
    )
    link = discord.ui.TextInput(
        label="Replay Link",
        placeholder="https://...",
        style=discord.TextStyle.paragraph,
    )

    async def on_submit(self, interaction: discord.Interaction):
        try:
            winner = capitalize(self.winner.value)
            loser = capitalize(self.loser.value)
            score = self.score.value
            link = self.link.value

            first_player, second_player = random.sample([winner, loser], 2)

            result_embed = (
                discord.Embed(
                    title=f"🏆 Liga Match: {first_player} vs. {second_player}",
                    color=0xFFD700,
                    timestamp=discord.utils.utcnow(),
                )
                .add_field(
                    name="Gewinner", value=f"|| {center_text(winner)} ||", inline=True
                )
                .add_field(
                    name="Verlierer", value=f"|| {center_text(loser)} ||", inline=True
                )
                .add_field(
                    name="Score",
                    value=f"|| {center_text(score, 6)} ||",
                    inline=False,
                )
                .add_field(name="Replay Link", value=link, inline=False)
            )

            await interaction.channel.send(embed=result_embed)
            await interaction.response.send_message(
                "✅ Ergebnis erfolgreich gepostet!", ephemeral=True
            )
        except Exception:
            logger.exception("Fehler beim Verarbeiten des Modals")
            await interaction.response.send_message(
                "❌ Es gab einen Fehler beim Verarbeiten deines Reports. Bitte versuche es erneut.",
                ephemeral=True,
            )


@client.tree.command(
    name="report", description="Öffnet das Formular um ein Match-Ergebnis einzutragen"
)
async def report(interaction: discord.Interaction):
    await interaction.response.send_modal(MatchReportModal())


client.run(DISCORD_TOKEN)
