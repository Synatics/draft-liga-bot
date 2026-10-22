const { Client, Events, GatewayIntentBits, REST } = require("discord.js");
const { prepareStartup, connectDiscord, cleanupStartup } = require("./startup");
const { ReportPublisher } = require("./report-publisher");
const { ReportManager } = require("./report-manager");
const { commands, createInteractionHandler } = require("./interactions");
const { startAutomaticBackups } = require("./data-backups");
const { SqliteBackups } = require("./database-backups");
const { installReportButtons } = require("./report-buttons");
const { logError } = require("./diagnostics");

// The caller owns the returned handles after success. Failed starts close them and throw;
// only the CLI entry point decides whether to exit the process.
async function startBot({
  env = process.env,
  logger = console,
  prepare = prepareStartup,
  createClient = (options) => new Client(options),
  createRest = (options) => new REST(options),
  scheduleBackups = startAutomaticBackups,
} = {}) {
  let state, client;
  try {
    state = prepare(env);
    const { config, databasePath, settingsStore, matchStore } = state;
    logger.log("✅ Konfiguration und Datenspeicher geprüft.");
    const reportPublisher = new ReportPublisher(matchStore);
    const reportManager = new ReportManager(matchStore);
    client = createClient({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    });

    // Load members once; GuildMembers events keep roles and nicknames current afterwards.
    // /report can then open the modal immediately, within Discord's response deadline.
    const loadedGuilds = new Set();
    const memberLoads = new Map();

    function prepareGuild(guild) {
      if (!memberLoads.has(guild.id)) {
        const load = guild.members
          .fetch({ time: 15000 })
          .then(() => loadedGuilds.add(guild.id))
          .finally(() => memberLoads.delete(guild.id));
        memberLoads.set(guild.id, load);
      }
      return memberLoads.get(guild.id);
    }

    function warmGuild(guild) {
      prepareGuild(guild).catch((error) =>
        logError(
          "Fehler beim Laden der Teilnehmer:",
          error,
          { operation: "members.load", guildId: guild.id },
          logger,
        ),
      );
    }

    client.on(Events.Error, (error) =>
      logError(
        "Fehler der Discord-Verbindung:",
        error,
        { operation: "discord.connection" },
        logger,
      ),
    );
    client.on(Events.ClientReady, () => {
      logger.log("✅ Bot ist mit Discord verbunden.");
      loadedGuilds.clear();
      for (const guild of client.guilds.cache.values()) warmGuild(guild);
      installReportButtons(client, matchStore, logger).catch((error) =>
        logError(
          "Ältere Ergebnisposts konnten nicht mit Buttons ergänzt werden.",
          error,
          { operation: "buttons.install" },
          logger,
        ),
      );
    });
    client.on(Events.GuildCreate, warmGuild);
    client.on(Events.GuildDelete, (guild) => loadedGuilds.delete(guild.id));

    const memberLoader = { isLoaded: (guildId) => loadedGuilds.has(guildId), warm: warmGuild };
    client.on(
      Events.InteractionCreate,
      createInteractionHandler({
        config,
        database: state.database,
        settingsStore,
        matchStore,
        reportPublisher,
        reportManager,
        memberLoader,
        logger,
      }),
    );
    const rest = createRest({ version: "10", timeout: 15_000, retries: 1 }).setToken(config.token);
    await connectDiscord(client, rest, commands, config, { logger });
    const backupTimer = scheduleBackups(new SqliteBackups(databasePath), logger);
    return {
      client,
      database: state.database,
      databasePath,
      settingsStore,
      matchStore,
      backupTimer,
    };
  } catch (error) {
    await cleanupStartup(client, state?.database, { logger });
    throw error;
  }
}

module.exports = { startBot };
