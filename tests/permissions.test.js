const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Collection, PermissionFlagsBits: P, PermissionsBitField } = require("discord.js");
const { canReport, isParticipant, isLeagueManager } = require("../src/shared/permissions");

const GUILD = "300000000000000001",
  USER = "200000000000000001";
const PARTICIPANT = "100000000000000001",
  MANAGER = "100000000000000002";
const member = (roles = [], permissions = []) => ({
  id: USER,
  guild: { id: GUILD },
  roles: { cache: new Collection(roles.map((id) => [id, {}])) },
  permissions: new PermissionsBitField(permissions),
});
const interaction = (current) => ({ guild: { id: GUILD }, user: { id: USER }, member: current });

test("only league roles grant access; server permissions never replace a missing role", () => {
  for (const [roles, permissions, report, manage] of [
    [[], [], false, false],
    [[PARTICIPANT], [], true, false],
    [[MANAGER], [], true, true],
    [[PARTICIPANT, MANAGER], [], true, true],
    [[], [P.ManageGuild], false, false],
    [[], [P.Administrator], false, false],
    [[PARTICIPANT], [P.Administrator], true, false],
    [[MANAGER], [P.Administrator], true, true],
  ]) {
    const i = interaction(member(roles, permissions));
    assert.equal(canReport(i, PARTICIPANT, MANAGER), report);
    assert.equal(isLeagueManager(i, MANAGER), manage);
  }
});

test("fresh member permissions never fall back to a stale administrative interaction", () => {
  const stale = interaction(member([], [P.ManageGuild]));
  stale.memberPermissions = stale.member.permissions;
  for (const current of [
    member([PARTICIPANT]),
    { ...member([PARTICIPANT]), permissions: undefined },
  ]) {
    assert.equal(isLeagueManager(stale, MANAGER, current), false);
  }
  assert.equal(isLeagueManager(stale, MANAGER, member([MANAGER])), true);
});

test("everyone roles, another member and another server cannot grant participant or management access", () => {
  for (const current of [
    null,
    { ...member([PARTICIPANT, MANAGER]), id: "200000000000000002" },
    { ...member([PARTICIPANT, MANAGER]), guild: { id: "300000000000000002" } },
  ]) {
    const i = interaction(current);
    assert.equal(canReport(i, PARTICIPANT, MANAGER), false);
  }
  const everyone = interaction(member([GUILD]));
  assert.equal(isParticipant(everyone, GUILD), false);
  assert.equal(isLeagueManager(everyone, GUILD), false);
});
