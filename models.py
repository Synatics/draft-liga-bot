import random
from dataclasses import dataclass

import discord

SPACER = "⠀"


def _capitalize(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _center_text(text: str, target_length: int = 16) -> str:
    if len(text) >= target_length:
        return text

    total_padding = target_length - len(text)
    side_padding = total_padding // 2

    return SPACER * side_padding + text + SPACER * (side_padding + total_padding % 2)


@dataclass
class MatchReport:
    winner: str
    loser: str
    score: str
    link: str

    def __post_init__(self):
        self.winner = _capitalize(self.winner.strip())
        self.loser = _capitalize(self.loser.strip())
        self.score = self.score.strip()
        self.link = self.link.strip()

    def to_embed(self) -> discord.Embed:
        first_player, second_player = random.sample([self.winner, self.loser], 2)

        return (
            discord.Embed(
                title=f"🏆 Liga Match: {first_player} vs. {second_player}",
                color=0xFFD700,
                timestamp=discord.utils.utcnow(),
            )
            .add_field(
                name="Gewinner",
                value=f"|| {_center_text(self.winner)} ||",
                inline=True,
            )
            .add_field(
                name="Verlierer",
                value=f"|| {_center_text(self.loser)} ||",
                inline=True,
            )
            .add_field(
                name="Score",
                value=f"|| {_center_text(self.score, 6)} ||",
                inline=False,
            )
            .add_field(name="Replay Link", value=self.link, inline=False)
        )
