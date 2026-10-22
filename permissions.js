const { PermissionFlagsBits: P } = require("discord.js");

function hasRole(member, roleId) {
  return Boolean(roleId && (member?.roles?.cache?.has(roleId) || (Array.isArray(member?.roles) && member.roles.includes(roleId))));
}

function isCurrentUser(interaction, member) {
  return Boolean(interaction.guild && member && (member.id || member.user?.id) === interaction.user?.id &&
    (!member.guild || member.guild.id === interaction.guild.id));
}

function isParticipant(interaction, roleId, member = interaction.member) {
  return isCurrentUser(interaction, member) && roleId !== interaction.guild.id && hasRole(member, roleId);
}

function isLeagueManager(interaction, managerRoleId, member = interaction.member) {
  // Never fall back to an older interaction's permissions after refreshing the member.
  return Boolean(isCurrentUser(interaction, member) && (member.permissions?.has?.(P.ManageGuild) ||
    (managerRoleId !== interaction.guild.id && hasRole(member, managerRoleId))));
}

function canReport(interaction, participantRoleId, managerRoleId, member = interaction.member) {
  return isParticipant(interaction, participantRoleId, member) || isLeagueManager(interaction, managerRoleId, member);
}

async function currentMember(interaction) {
  return interaction.guild.members.fetch({ user: interaction.user.id, force: true });
}

function actorOf(interaction, member = interaction.member) {
  return { id: interaction.user.id, name: (member?.displayName || interaction.user.username || interaction.user.id).slice(0, 100) };
}

module.exports = { hasRole, isParticipant, isLeagueManager, canReport, currentMember, actorOf };
