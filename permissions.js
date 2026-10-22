const { PermissionFlagsBits: P } = require("discord.js");

function hasRole(member, roleId) {
  return Boolean(roleId && (member?.roles?.cache?.has(roleId) || (Array.isArray(member?.roles) && member.roles.includes(roleId))));
}

function isLeagueManager(interaction, managerRoleId, member = interaction.member) {
  const permissions = member?.permissions || interaction.memberPermissions;
  return Boolean(interaction.guild && (permissions?.has(P.ManageGuild) ||
    (managerRoleId !== interaction.guild.id && hasRole(member, managerRoleId))));
}

async function currentMember(interaction) {
  return interaction.guild.members.fetch({ user: interaction.user.id, force: true });
}

function actorOf(interaction, member = interaction.member) {
  return { id: interaction.user.id, name: (member?.displayName || interaction.user.username || interaction.user.id).slice(0, 100) };
}

module.exports = { hasRole, isLeagueManager, currentMember, actorOf };
