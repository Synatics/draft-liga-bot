import logging
import os

import discord
from discord.ext import commands
from dotenv import load_dotenv

load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")


class LigaBot(commands.Bot):
    def __init__(self):
        # command_prefix wird nie genutzt (nur Slash-Commands), ist bei commands.Bot aber Pflicht.
        super().__init__(command_prefix="!", intents=discord.Intents(guilds=True))

    async def setup_hook(self):
        await self.load_extension("cogs.matches")
        await self.tree.sync()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    bot = LigaBot()
    bot.run(DISCORD_TOKEN)
