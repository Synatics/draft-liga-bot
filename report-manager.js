const { MatchStoreError } = require("./match-store");
const { reportButtons } = require("./report-buttons");
const { causedError } = require("./diagnostics");

class ReportManagementError extends Error {}

class ReportManager {
  constructor(store) {
    this.store = store;
    this.inFlight = new Set();
  }

  async apply(id, guildId, channel, botId, change, expectedRevision, actor) {
    if (this.inFlight.has(id)) throw new ReportManagementError("Dieser Report wird gerade geändert. Bitte warte kurz.");
    this.inFlight.add(id);
    try {
      const previous = this.store.get(id, guildId);
      const hadPendingChange = Boolean(previous.change);
      if (channel.id !== previous.channelId || channel.guildId !== guildId) {
        throw new ReportManagementError("Der Ergebnispost gehört nicht zu diesem Server oder Kanal.");
      }
      if (change) this.store.beginChange(id, guildId, expectedRevision, change, actor);
      const record = this.store.get(id, guildId);
      const context = { guildId, channelId: record.channelId, reportId: id, messageId: record.publication?.messageId,
        operation: record.change?.kind === "delete" ? "report.delete" : "report.edit" };
      if (!record.change) throw new ReportManagementError("Für diesen Report ist keine Änderung vorgemerkt.");
      try {
        let message;
        try { message = await channel.messages.fetch({ message: record.publication.messageId, force: true }); } catch (error) {
          if (Number(error.code) !== 10008 || record.change.kind !== "delete") throw error;
        }
        if (message && (message.author?.id !== botId || message.webhookId)) {
          throw new ReportManagementError("Es können nur eigene Ergebnisposts des Bots geändert werden.");
        }
        if (record.change.kind === "edit") {
          await message.edit({ content: "", embeds: [record.change.embed], components: reportButtons(id), allowedMentions: { parse: [] } });
        } else if (message) {
          try { await message.delete(); } catch (error) { if (Number(error.code) !== 10008) throw error; }
        }
      } catch (error) {
        const rejected = error instanceof ReportManagementError || Number(error.code) === 10008 ||
          (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408);
        if (rejected && change && !hadPendingChange) {
          try { this.store.finishChange(id, guildId, true); } catch (storageError) {
            throw causedError(ReportManagementError, "Discord hat die Änderung abgelehnt; die Vormerkung konnte aber nicht aufgehoben werden. Bitte Speicher und Kanalrechte prüfen und die Aktion erneut öffnen.",
              new AggregateError([error, storageError], "Discord-Ablehnung und fehlgeschlagene Speicherung."), context);
          }
          throw causedError(ReportManagementError, Number(error.code) === 10008
            ? "Der Ergebnispost existiert nicht mehr. Du kannst seinen Archiv-Eintrag mit /report-entfernen über Season, Spieler und optional Spieltag finden und löschen."
            : "Die Änderung wurde nicht durchgeführt. Bitte den Ergebnispost und die Kanalrechte des Bots prüfen und die Aktion erneut öffnen.", error, context);
        }
        throw causedError(ReportManagementError, "Der Ausgang der Änderung ist unklar. Sie bleibt gespeichert. Bitte dieselbe Aktion erneut am Post öffnen; der Bot wiederholt sie am bestehenden Post.", error, context);
      }
      try { this.store.finishChange(id, guildId, false, actor); } catch (error) {
        if (!(error instanceof MatchStoreError)) throw error;
        throw causedError(ReportManagementError, "Der Discord-Post wurde geändert, aber das Archiv konnte nicht aktualisiert werden. Bitte den Speicher prüfen und dieselbe Aktion erneut öffnen, um die gespeicherte Änderung abzuschließen.", error, context);
      }
      return record.change.kind;
    } finally {
      this.inFlight.delete(id);
    }
  }
}

module.exports = { ReportManager, ReportManagementError };
