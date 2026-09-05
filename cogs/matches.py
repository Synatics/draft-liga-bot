import logging

import discord
from discord import app_commands
from discord.ext import commands

from models import MatchReport

logger = logging.getLogger(__name__)


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
            report = MatchReport(
                winner=self.winner.value,
                loser=self.loser.value,
                score=self.score.value,
                link=self.link.value,
            )

            await interaction.channel.send(embed=report.to_embed())
            await interaction.response.send_message(
                "✅ Ergebnis erfolgreich gepostet!", ephemeral=True
            )
        except Exception:
            logger.exception("Fehler beim Verarbeiten des Modals")
            await interaction.response.send_message(
                "❌ Es gab einen Fehler beim Verarbeiten deines Reports. Bitte versuche es erneut.",
                ephemeral=True,
            )


class MatchesCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(
        name="report", description="Öffnet das Formular um ein Match-Ergebnis einzutragen"
    )
    async def report(self, interaction: discord.Interaction):
        await interaction.response.send_modal(MatchReportModal())


async def setup(bot: commands.Bot):
    await bot.add_cog(MatchesCog(bot))
