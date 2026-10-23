const assert = require("node:assert/strict");
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const { Collection, PermissionsBitField, MessageFlags } = require("discord.js");
const { LigaDatabase } = require("./database");
const { LeagueSettingsStore } = require("./league-settings");
const { leagueCommand } = require("./league-commands");
const { createSeasonSetup, SESSION_MS } = require("./season-setup");
const { setupFields, setupButton } = require("./test-helpers/season-setup");

const GUILD = "300000000000000001",
  USER = "200000000000000001",
  OTHER = "200000000000000002",
  MANAGER = "100000000000000001";
const basics = (values = {}) => ({
  number: "5",
  days: "9",
  start: "26.10.2026",
  format: "playoffs",
  ...values,
});

function setup(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "liga-setup-test-"));
  const path = join(directory, "liga.sqlite");
  const db = new LigaDatabase(path);
  t.after(() => {
    db.close();
    assert.equal(dirname(directory), tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let clock = Date.parse("2026-10-26T12:00:00Z");
  const settings = new LeagueSettingsStore(path, () => new Date(clock), db);
  const members = new Collection(
    [USER, OTHER].map((id) => [
      id,
      {
        id,
        permissions: new PermissionsBitField(),
        roles: { cache: new Collection([[MANAGER, {}]]) },
      },
    ]),
  );
  let fetchMember = async (id) => members.get(id);
  const guild = {
    id: GUILD,
    members: {
      async fetch({ user, force }) {
        assert.equal(force, true);
        return fetchMember(user);
      },
    },
  };
  let wizard = createSeasonSetup({
    settingsStore: settings,
    managerRoleId: MANAGER,
    now: () => clock,
  });
  const interaction = (changes = {}, user = USER) => ({
    guild,
    user: { id: user },
    member: members.get(user),
    isModalSubmit: () => false,
    isButton: () => false,
    async showModal(modal) {
      assert.equal(
        this.isModalSubmit(),
        false,
        "Discord cannot open another modal directly from a modal submission",
      );
      assert.ok(!this.deferred && !this.replied, "Opening a modal is the initial response");
      this.modal = modal.toJSON();
    },
    async deferReply(payload) {
      assert.ok(payload.flags.includes(MessageFlags.Ephemeral));
      this.deferred = true;
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async editReply(payload) {
      this.response = payload;
    },
    async update(payload) {
      this.response = payload;
    },
    ...changes,
  });
  async function open(user = USER) {
    const item = interaction({}, user);
    await wizard.open(item);
    return item;
  }
  async function submit(item, values) {
    const next = interaction(
      { customId: item.modal.custom_id, isModalSubmit: () => true, fields: setupFields(values) },
      item.user.id,
    );
    await wizard.handle(next);
    return next;
  }
  async function click(item, action, changes = {}, user = item.user.id) {
    const next = interaction(
      { customId: setupButton(item.response, action), isButton: () => true, ...changes },
      user,
    );
    await wizard.handle(next);
    return next;
  }
  async function preview(values = {}, user = USER) {
    const opened = await open(user);
    const first = await submit(opened, basics(values));
    if (values.format === "league") return first;
    const more = await click(first, "options");
    return submit(more, {
      redraft: "yes",
      ...(values.format === "home-away" ? {} : { playoffs: "semifinal" }),
    });
  }
  return {
    db,
    settings,
    members,
    interaction,
    open,
    submit,
    click,
    preview,
    get wizard() {
      return wizard;
    },
    fetchWith(fn) {
      fetchMember = fn;
    },
    advance(ms) {
      clock += ms;
    },
    restartDialog() {
      wizard = createSeasonSetup({
        settingsStore: settings,
        managerRoleId: MANAGER,
        now: () => clock,
      });
    },
  };
}

test("season setup has no slash parameters and saves only after a private two-modal preview", async (t) => {
  const f = setup(t);
  assert.equal(leagueCommand.options.find((option) => option.name === "season").options, undefined);
  const opened = await f.open();
  assert.equal(opened.modal.components.length, 4);
  assert.deepEqual(
    opened.modal.components[3].component.options.map((option) => option.label),
    ["Liga ohne Playoffs", "Liga mit Playoffs", "Hin- und Rückrunde ohne Playoffs"],
  );
  const first = await f.submit(opened, basics());
  assert.equal(f.settings.configuration(GUILD), undefined);
  const forged = f.interaction({
    customId: setupButton(first.response, "edit").replace(":edit:", ":save:"),
    isButton: () => true,
  });
  await assert.rejects(f.wizard.handle(forged), /erst alle Einstellungen/);
  const more = await f.click(first, "options");
  assert.equal(more.modal.components.length, 2);
  assert.equal(
    more.modal.components[0].component.options.find((option) => option.default).value,
    "no",
  );
  assert.equal(
    more.modal.components[1].component.options.find((option) => option.default).value,
    "semifinal",
  );
  const preview = await f.submit(more, { redraft: "yes", playoffs: "quarterfinal" });
  const plan = preview.response.embeds[0].toJSON().description;
  assert.match(plan, /Woche 10: Redraft/);
  assert.match(plan, /Woche 11: Playoffs · Viertelfinale/);
  assert.match(plan, /Woche 13: Playoffs · Finale/);
  assert.equal(f.db.readSettings(), '{"version":1,"guilds":{}}');
  await f.click(preview, "save");
  assert.equal(f.settings.get(GUILD).redraft, true);
  assert.equal(f.settings.get(GUILD).playoffsFrom, "quarterfinal");
  assert.equal(f.settings.get(GUILD).rounds.length, 13);
  await assert.rejects(f.click(preview, "save"), /abgelaufen/);
});

test("existing values are prefilled, going back preserves extras, and canceling or closing a modal never writes settings", async (t) => {
  const f = setup(t);
  f.settings.setSeason(GUILD, 5, 18, "26.10.2026", { format: "home-away", redraft: true });
  const saved = f.db.readSettings();
  const opened = await f.open();
  assert.equal(opened.modal.components[0].component.value, "5");
  assert.equal(opened.modal.components[1].component.value, "18");
  assert.equal(
    opened.modal.components[3].component.options.find((option) => option.default).value,
    "home-away",
  );
  const first = await f.submit(opened, basics({ days: "20", format: "home-away" }));
  const more = await f.click(first, "options");
  assert.equal(more.modal.components.length, 1);
  assert.equal(
    more.modal.components[0].component.options.find((option) => option.default).value,
    "yes",
  );
  // Dismissing the modal leaves the continuation button usable.
  const reopened = await f.click(first, "options");
  const preview = await f.submit(reopened, { redraft: "yes" });
  const back = await f.click(preview, "edit");
  assert.equal(back.modal.components[1].component.value, "20");
  const corrected = await f.submit(back, basics({ days: "18", format: "home-away" }));
  const details = await f.click(corrected, "options");
  assert.equal(
    details.modal.components[0].component.options.find((option) => option.default).value,
    "yes",
  );
  const final = await f.submit(details, { redraft: "yes" });
  await f.click(final, "cancel");
  assert.equal(f.db.readSettings(), saved);
  await assert.rejects(f.click(final, "save"), /abgelaufen/);
});

test("plain leagues need only the basics modal and changing formats explicitly removes incompatible extras", async (t) => {
  const f = setup(t);
  f.settings.setSeason(GUILD, 5, 9, "26.10.2026", { format: "playoffs", redraft: true });
  const preview = await f.preview({ format: "league" });
  const embed = preview.response.embeds[0].toJSON();
  assert.equal(embed.fields.find((field) => field.name === "Redraft").value, "Nein");
  assert.ok(!embed.description.includes("Playoffs"));
  assert.ok(!embed.description.includes("Redraft"));
  assert.throws(() => setupButton(preview.response, "options"));
  await f.click(preview, "save");
  assert.equal(f.settings.get(GUILD).format, "league");
  assert.equal(f.settings.get(GUILD).redraft, false);
  assert.equal(f.settings.get(GUILD).playoffsFrom, undefined);
});

test("invalid modal values can be corrected without losing the draft or writing an invalid schedule", async (t) => {
  const f = setup(t);
  const initial = await f.open();
  const badNumber = await f.submit(initial, basics({ number: "0" }));
  assert.match(badNumber.response.content, /1 bis 9999/);
  const retry = await f.click(badNumber, "edit");
  assert.equal(retry.modal.components[0].component.value, "0");
  const odd = await f.submit(retry, basics({ format: "home-away" }));
  assert.match(odd.response.content, /gerade/);
  const badDate = await f.submit(await f.click(odd, "edit"), basics({ start: "25.10.2026" }));
  assert.match(badDate.response.content, /Montag/);
  const large = await f.submit(await f.click(badDate, "edit"), basics({ days: "24" }));
  const many = await f.submit(await f.click(large, "options"), {
    redraft: "no",
    playoffs: "quarterfinal",
  });
  assert.match(many.response.content, /höchstens 25/);
  const smaller = await f.submit(await f.click(many, "edit"), basics());
  const final = await f.submit(await f.click(smaller, "options"), {
    redraft: "no",
    playoffs: "final",
  });
  assert.match(final.response.embeds[0].toJSON().description, /Woche 10: Playoffs · Finale/);
  assert.equal(f.settings.configuration(GUILD), undefined);
  await f.click(final, "cancel");
});

test("drafts reject other users/guilds, stale steps, expired sessions and forms from a previous bot instance", async (t) => {
  const f = setup(t);
  const old = await f.open();
  const opened = await f.open();
  await assert.rejects(f.submit(old, basics()), /abgelaufen/);
  const first = await f.submit(opened, basics());
  await assert.rejects(f.click(first, "options", {}, OTHER), /anderen Person/);
  await assert.rejects(
    f.click(first, "options", { guild: { id: "300000000000000002" } }),
    /anderen Person/,
  );
  const more = await f.click(first, "options");
  const preview = await f.submit(more, { redraft: "no", playoffs: "semifinal" });
  await assert.rejects(f.submit(more, { redraft: "yes", playoffs: "final" }), /veraltet/);
  f.advance(SESSION_MS + 1);
  await assert.rejects(f.click(preview, "save"), /abgelaufen/);
  const pending = await f.preview();
  f.restartDialog();
  await assert.rejects(f.click(pending, "save"), /abgelaufen/);
  assert.equal(f.settings.configuration(GUILD), undefined);
});

test("current management rights are refreshed on submit/save even when the interaction still carries an old role", async (t) => {
  const f = setup(t);
  f.members.get(OTHER).roles.cache.clear();
  await assert.rejects(f.open(OTHER), /Ligaverwaltungsrolle/);
  const preview = await f.preview();
  f.fetchWith(async (user) => ({
    id: user,
    permissions: new PermissionsBitField(),
    roles: { cache: new Collection() },
  }));
  await assert.rejects(f.click(preview, "save"), /Ligaverwaltungsrolle/);
  assert.equal(f.settings.configuration(GUILD), undefined);
  const more = await f.open();
  await assert.rejects(f.submit(more, basics()), /Ligaverwaltungsrolle/);
  f.fetchWith(async (user) => f.members.get(user));
  const valid = await f.preview();
  await f.click(valid, "save");
  assert.equal(f.settings.get(GUILD).season, 5);
});

test("two administrators cannot silently overwrite each other's settings with an older preview", async (t) => {
  const f = setup(t);
  const first = await f.preview();
  const second = await f.preview({ number: "6" }, OTHER);
  await f.click(first, "save");
  await assert.rejects(f.click(second, "save"), /inzwischen geändert/);
  assert.equal(f.settings.get(GUILD).season, 5);
  assert.equal(f.settings.get(GUILD).redraft, true);
});

test("storage failures leave settings intact and allow retry, while simultaneous confirmation writes only once", async (t) => {
  const f = setup(t);
  const preview = await f.preview();
  const save = f.db.saveSettings.bind(f.db);
  f.db.saveSettings = () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  await assert.rejects(f.click(preview, "save"), (error) => error.cause.code === "ENOSPC");
  assert.equal(f.settings.configuration(GUILD), undefined);
  let writes = 0,
    release;
  f.db.saveSettings = (guilds) => {
    writes++;
    return save(guilds);
  };
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.fetchWith(async (user) => {
    await gate;
    return f.members.get(user);
  });
  const inProgress = f.click(preview, "save");
  try {
    await assert.rejects(f.click(preview, "save"), /gerade verarbeitet/);
  } finally {
    release();
  }
  await inProgress;
  assert.equal(writes, 1);
  assert.equal(f.settings.get(GUILD).season, 5);
});
