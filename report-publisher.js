const { reportButtons } = require("./report-buttons");

class ReportPublisher {
  constructor(store) {
    this.store = store;
    this.inFlight = new Set();
  }

  async publish(match, channel, message) {
    const record = this.store.add(match);
    if (record.change) return { status: "maintenance" };
    if (!record.publication) return { status: "legacy" };
    if (record.publication.status === "published") {
      return { status: "duplicate", messageId: record.publication.messageId };
    }
    if (this.inFlight.has(record.id)) return { status: "in-progress" };
    // An interrupted or ambiguous send must never be retried blindly, even after a restart.
    if (record.publication.status === "sending") return { status: "uncertain" };

    this.inFlight.add(record.id);
    try {
      // Commit the reservation before the first asynchronous operation.
      this.store.setPublication(record.id, { status: "sending" });
      let sent;
      try {
        sent = await channel.send({ ...message, components: reportButtons(record.id), nonce: record.id, enforceNonce: true });
      } catch (error) {
        // A timeout or server failure may occur after Discord accepted the message.
        // Only an explicit client-error response confirms that no post was created.
        if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408) {
          try {
            this.store.setPublication(record.id, { status: "pending" });
          } catch (storageError) {
            return { status: "failed-unconfirmed", reportId: record.id, error, storageError };
          }
          return { status: "failed", reportId: record.id, error };
        }
        return { status: "uncertain", reportId: record.id, error };
      }

      try {
        this.store.setPublication(record.id, { status: "published", messageId: sent.id });
      } catch (error) {
        // The on-disk 'sending' state still prevents another post after a restart.
        return { status: "published-unconfirmed", reportId: record.id, messageId: sent.id, error };
      }
      return { status: "published", messageId: sent.id };
    } finally {
      this.inFlight.delete(record.id);
    }
  }
}

module.exports = { ReportPublisher };
