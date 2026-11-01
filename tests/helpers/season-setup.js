const assert = require("node:assert/strict");
const { ComponentType, ModalSubmitFields } = require("discord.js");

function setupFields(values) {
  return new ModalSubmitFields(
    Object.entries(values).map(([customId, value]) => ({
      type: ComponentType.Label,
      component: ["format", "redraft", "playoffs"].includes(customId)
        ? {
            type: ComponentType.StringSelect,
            customId,
            values: Array.isArray(value) ? value : [value],
          }
        : { type: ComponentType.TextInput, customId, value },
    })),
  );
}

function setupButton(payload, action) {
  const components =
    payload?.components?.flatMap((row) =>
      row.toJSON ? row.toJSON().components : row.components,
    ) ?? [];
  const button = components.find((component) =>
    component.custom_id.startsWith(`season:${action}:`),
  );
  assert.ok(button, `Missing ${action} button: ${JSON.stringify(payload)}`);
  return button.custom_id;
}

async function configureSeason({ handle, interaction, values, user }) {
  const opened = interaction(
    {
      commandName: "liga",
      isChatInputCommand: () => true,
      options: { getSubcommand: () => "season" },
    },
    user,
  );
  await handle(opened);
  assert.ok(opened.modal, JSON.stringify(opened.response));
  const basics = interaction(
    {
      customId: opened.modal.custom_id,
      isModalSubmit: () => true,
      fields: setupFields({
        number: String(values.nummer),
        days: String(values.spieltage),
        start: values.startdatum,
        format: values.format ?? "league",
      }),
    },
    user,
  );
  await handle(basics);
  let preview = basics;
  if (values.format && values.format !== "league") {
    const next = interaction(
      { customId: setupButton(basics.response, "options"), isButton: () => true },
      user,
    );
    await handle(next);
    assert.ok(next.modal, JSON.stringify(next.response));
    preview = interaction(
      {
        customId: next.modal.custom_id,
        isModalSubmit: () => true,
        fields: setupFields({
          redraft: values.redraft ? "yes" : "no",
          ...(values.format === "playoffs" ? { playoffs: values.playoffs_ab ?? "semifinal" } : {}),
        }),
      },
      user,
    );
    await handle(preview);
  }
  const save = interaction(
    { customId: setupButton(preview.response, "save"), isButton: () => true },
    user,
  );
  await handle(save);
  return save;
}

module.exports = { setupFields, setupButton, configureSeason };
