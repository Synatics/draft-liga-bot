const { MessageFlags } = require("discord.js");
const { ReportError } = require("./reports");
const { LeagueSettingsError } = require("./league-settings");
const { leagueCommand, handleLeagueCommand } = require("./league-commands");
const { MatchStoreError } = require("./match-store");
const { ReportManagementError } = require("./report-manager");
const {
  managementCommands,
  openManagement,
  handleManagementComponent,
  handleRemovalAutocomplete,
} = require("./report-management");
const {
  SearchError,
  searchCommand,
  handleSearchCommand,
  handleSearchAutocomplete,
} = require("./search-commands");
const { reportCommand, createReportHandler } = require("./report-handler");
const { logError, interactionContext } = require("./diagnostics");
const { createSeasonSetup } = require("./season-setup");

const commands = [reportCommand, leagueCommand, searchCommand, ...managementCommands];

function createInteractionHandler({
  config,
  database,
  settingsStore,
  matchStore,
  reportPublisher,
  reportManager,
  memberLoader,
  logger = console,
  seasonSetup = createSeasonSetup({ settingsStore, managerRoleId: config.managerRoleId }),
}) {
  const { participantRoleId, managerRoleId } = config;
  const handleReport = createReportHandler({
    config,
    settingsStore,
    reportPublisher,
    memberLoader,
    logger,
  });
  return async function handleInteraction(interaction) {
    const isReportCommand =
      interaction.isChatInputCommand() && interaction.commandName === "report";
    const isLeagueCommand = interaction.isChatInputCommand() && interaction.commandName === "liga";
    const isSeasonSetup =
      (interaction.isButton?.() || interaction.isModalSubmit()) &&
      /^season:/.test(interaction.customId);
    const isSearchCommand =
      interaction.isChatInputCommand() && interaction.commandName === "suchen";
    const isSearchAutocomplete =
      interaction.isAutocomplete() && interaction.commandName === "suchen";
    const isRemovalAutocomplete =
      interaction.isAutocomplete() && interaction.commandName === "report-entfernen";
    const isManagementCommand =
      interaction.isChatInputCommand() && interaction.commandName === "report-entfernen";
    const isManagementComponent =
      (interaction.isButton?.() ||
        interaction.isStringSelectMenu?.() ||
        interaction.isModalSubmit()) &&
      /^(?:manage|report):/.test(interaction.customId);
    const isReportSubmit =
      interaction.isModalSubmit() &&
      (interaction.customId === "submit_report" ||
        interaction.customId.startsWith("submit_report:"));
    if (
      !isReportCommand &&
      !isReportSubmit &&
      !isLeagueCommand &&
      !isSeasonSetup &&
      !isSearchCommand &&
      !isSearchAutocomplete &&
      !isRemovalAutocomplete &&
      !isManagementCommand &&
      !isManagementComponent
    )
      return;
    const logContext = interactionContext(interaction);

    try {
      if (isSeasonSetup) {
        await seasonSetup.handle(interaction);
        return;
      }
      if (isRemovalAutocomplete) {
        await handleRemovalAutocomplete(interaction, matchStore, managerRoleId);
        return;
      }
      if (isManagementCommand) {
        await openManagement(
          interaction,
          matchStore,
          reportManager,
          participantRoleId,
          settingsStore,
          managerRoleId,
        );
        return;
      }
      if (isManagementComponent) {
        await handleManagementComponent(
          interaction,
          matchStore,
          reportManager,
          participantRoleId,
          settingsStore,
          managerRoleId,
        );
        return;
      }
      if (isSearchAutocomplete) {
        await handleSearchAutocomplete(interaction, matchStore);
        return;
      }
      if (isSearchCommand) {
        await handleSearchCommand(interaction, matchStore);
        return;
      }
      if (isLeagueCommand) {
        await handleLeagueCommand(interaction, settingsStore, database, config, seasonSetup);
        return;
      }
      await handleReport(interaction);
    } catch (error) {
      if (isSearchAutocomplete || isRemovalAutocomplete) {
        logError(
          "Fehler bei den Suchvorschlägen:",
          error,
          { ...logContext, operation: "interaction.autocomplete" },
          logger,
        );
        if (!interaction.responded) {
          try {
            await interaction.respond([]);
          } catch {
            /* The autocomplete interaction may have expired. */
          }
        }
        return;
      }
      const expected =
        error instanceof ReportError ||
        error instanceof LeagueSettingsError ||
        error instanceof MatchStoreError ||
        error instanceof SearchError ||
        error instanceof ReportManagementError;
      if (!expected || Object.hasOwn(error, "cause"))
        logError(
          "Fehler beim Verarbeiten des Reports:",
          error,
          { ...logContext, operation: "interaction" },
          logger,
        );
      const content = expected
        ? `❌ ${error.message}`
        : "❌ Es gab einen Fehler beim Verarbeiten des Befehls. Bitte versuche es erneut.";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content });
        } else {
          await interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        }
      } catch (replyError) {
        logError(
          "Fehler beim Senden der Rückmeldung:",
          replyError,
          { ...logContext, operation: "interaction.reply" },
          logger,
        );
      }
    }
  };
}

module.exports = { commands, createInteractionHandler };
