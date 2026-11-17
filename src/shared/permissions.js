const { ChannelType, PermissionFlagsBits: P } = require("discord.js");

function hasRole(member, roleId) {
  return Boolean(
    roleId &&
    (member?.roles?.cache?.has(roleId) ||
      (Array.isArray(member?.roles) && member.roles.includes(roleId))),
  );
}

function isCurrentUser(interaction, member) {
  return Boolean(
    interaction.guild &&
    member &&
    (member.id || member.user?.id) === interaction.user?.id &&
    (!member.guild || member.guild.id === interaction.guild.id),
  );
}

function isParticipant(interaction, roleId, member = interaction.member) {
  return (
    isCurrentUser(interaction, member) && roleId !== interaction.guild.id && hasRole(member, roleId)
  );
}

function isLeagueManager(interaction, managerRoleId, member = interaction.member) {
  return Boolean(
    isCurrentUser(interaction, member) &&
    managerRoleId !== interaction.guild.id &&
    hasRole(member, managerRoleId),
  );
}

function isLeagueMember(
  interaction,
  participantRoleId,
  managerRoleId,
  member = interaction.member,
) {
  return (
    isParticipant(interaction, participantRoleId, member) ||
    isLeagueManager(interaction, managerRoleId, member)
  );
}

const canReport = isLeagueMember;

async function currentMember(interaction) {
  return interaction.guild.members.fetch({ user: interaction.user.id, force: true });
}

async function currentLeagueMember(interaction, config) {
  if (!interaction.guild) return null;
  const member = await currentMember(interaction);
  return isLeagueMember(interaction, config.participantRoleId, config.managerRoleId, member)
    ? member
    : null;
}

function participantMembers(guild, roleId) {
  if (!roleId || roleId === guild.id) return [];
  return [...guild.members.cache.values()].filter(
    (member) => !member.user.bot && hasRole(member, roleId),
  );
}

async function fetchCurrentChannel(interaction, channelId) {
  const channel = await interaction.guild.channels.fetch(channelId, { force: true });
  if (!channel) return null;
  if (channel.guildId !== interaction.guild.id)
    throw new Error("Der Ergebniskanal gehört zu einem anderen Server.");
  // Thread permissions are inherited from the parent, which must be refreshed too.
  if (channel.isThread?.()) {
    const parent = await interaction.guild.channels.fetch(channel.parentId, { force: true });
    if (!parent) return null;
    if (parent.guildId !== interaction.guild.id)
      throw new Error("Der übergeordnete Kanal gehört zu einem anderen Server.");
  }
  return channel;
}

async function fetchReadableChannel(interaction, channelId, member) {
  const channel = await fetchCurrentChannel(interaction, channelId);
  if (!channel) return null;
  const permissions = channel.permissionsFor(member);
  if (!permissions?.has([P.ViewChannel, P.ReadMessageHistory])) return null;
  if (channel.type === ChannelType.PrivateThread && !permissions.has(P.ManageThreads)) {
    await channel.members.fetch({ member: interaction.user.id, force: true });
  }
  return channel;
}

async function readableChannelIds(interaction, channelIds, member) {
  const ids = await Promise.all(
    [...new Set(channelIds)].map(async (id) => {
      try {
        return (await fetchReadableChannel(interaction, id, member)) ? id : null;
      } catch {
        // Deleted channels and failed permission or thread lookups never expose archived data.
        return null;
      }
    }),
  );
  return ids.filter((id) => id !== null);
}

function actorOf(interaction, member = interaction.member) {
  return {
    id: interaction.user.id,
    name: (member?.displayName || interaction.user.username || interaction.user.id).slice(0, 100),
  };
}

module.exports = {
  hasRole,
  isParticipant,
  isLeagueManager,
  isLeagueMember,
  canReport,
  currentMember,
  currentLeagueMember,
  participantMembers,
  fetchCurrentChannel,
  fetchReadableChannel,
  readableChannelIds,
  actorOf,
};
