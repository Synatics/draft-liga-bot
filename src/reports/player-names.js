class SearchError extends Error {}

// Each sample is a Discord ID and the display name seen at that point in time.
// The last name is the label; older names remain usable for lookup.
class PlayerNames {
  constructor(samples) {
    const byId = new Map();
    for (const { id, name } of samples) {
      let player = byId.get(id);
      if (!player) {
        player = { id, name, aliases: new Set() };
        byId.set(id, player);
      }
      player.name = name;
      player.aliases.add(name);
    }
    this.players = [...byId.values()].sort(
      (a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id),
    );
  }

  choices(input, excludeId) {
    const query = input.trim().toLocaleLowerCase("de");
    return this.players
      .filter(
        (player) =>
          player.id !== excludeId &&
          [...player.aliases].some((name) => name.toLocaleLowerCase("de").includes(query)),
      )
      .slice(0, 25)
      .map((player) => ({
        name: this.players.some((other) => other.id !== player.id && other.name === player.name)
          ? `${player.name.slice(0, 76)} · ${player.id}`
          : player.name,
        value: player.id,
      }));
  }

  resolve(input, field = "name") {
    const selected = this.players.find((player) => player.id === input);
    if (selected) return selected;
    const query = input.trim().toLocaleLowerCase("de");
    const found = this.players.filter((player) =>
      [...player.aliases].some((name) => name.toLocaleLowerCase("de") === query),
    );
    if (found.length > 1)
      throw new SearchError(
        `Mehrere Teilnehmer haben diesen Namen. Bitte wähle einen Vorschlag im Feld „${field}“ aus.`,
      );
    return found[0];
  }
}

module.exports = { PlayerNames, SearchError };
