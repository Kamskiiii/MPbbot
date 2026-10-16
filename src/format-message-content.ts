import type { Guild, Message, Role } from 'discord.js';

const DEFAULT_ROLE_COLOR = '#f23f43';

function roleHex(role: Role | null | undefined): string {
  if (!role || role.color === 0) return DEFAULT_ROLE_COLOR;
  const hex = role.hexColor?.trim();
  if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  return DEFAULT_ROLE_COLOR;
}

function enc(label: string): string {
  return encodeURIComponent(label);
}

function markerRole(name: string, hex: string): string {
  return `{{r:${hex}:${enc(name)}}}`;
}

function markerUser(name: string): string {
  return `{{u:${enc(name)}}}`;
}

function markerChannel(name: string): string {
  return `{{c:${enc(name)}}}`;
}

/**
 * Заменяет Discord-упоминания на маркеры для цветного рендера на сайте.
 * Роль: {{r:#hex:urlencodedName}}
 * Юзер: {{u:urlencodedName}}
 * Канал: {{c:urlencodedName}}
 */
export async function formatMessageContentForSite(
  message: Message,
  guild: Guild,
): Promise<string> {
  let content = message.content ?? '';
  if (!content) return content;

  const roleCache = new Map<string, { name: string; hex: string }>();
  const resolveRole = async (
    roleId: string,
  ): Promise<{ name: string; hex: string }> => {
    if (roleCache.has(roleId)) return roleCache.get(roleId)!;
    const fromMention = message.mentions.roles.get(roleId);
    if (fromMention) {
      const row = {
        name: fromMention.name.trim() || roleId,
        hex: roleHex(fromMention),
      };
      roleCache.set(roleId, row);
      return row;
    }
    const cached = guild.roles.cache.get(roleId);
    if (cached) {
      const row = {
        name: cached.name.trim() || roleId,
        hex: roleHex(cached),
      };
      roleCache.set(roleId, row);
      return row;
    }
    try {
      const role = await guild.roles.fetch(roleId);
      const row = {
        name: role?.name?.trim() || roleId,
        hex: roleHex(role),
      };
      roleCache.set(roleId, row);
      return row;
    } catch {
      const row = { name: roleId, hex: DEFAULT_ROLE_COLOR };
      roleCache.set(roleId, row);
      return row;
    }
  };

  const userCache = new Map<string, string>();
  const resolveUserLabel = async (userId: string): Promise<string> => {
    if (userCache.has(userId)) return userCache.get(userId)!;
    const member =
      message.mentions.members?.get(userId) ??
      guild.members.cache.get(userId);
    if (member) {
      const label =
        member.nickname?.trim() ||
        member.displayName?.trim() ||
        member.user.username;
      userCache.set(userId, label);
      return label;
    }
    const user = message.mentions.users.get(userId);
    if (user) {
      const label = user.displayName?.trim() || user.username;
      userCache.set(userId, label);
      return label;
    }
    try {
      const fetched = await guild.members.fetch(userId);
      const label =
        fetched.nickname?.trim() ||
        fetched.displayName?.trim() ||
        fetched.user.username;
      userCache.set(userId, label);
      return label;
    } catch {
      try {
        const u = await message.client.users.fetch(userId);
        const label = u.displayName?.trim() || u.username;
        userCache.set(userId, label);
        return label;
      } catch {
        userCache.set(userId, userId);
        return userId;
      }
    }
  };

  const roleIds = new Set<string>();
  for (const m of content.matchAll(/<@&(\d{17,20})>/g)) {
    roleIds.add(m[1]!);
  }
  for (const roleId of roleIds) {
    const { name, hex } = await resolveRole(roleId);
    content = content.split(`<@&${roleId}>`).join(markerRole(name, hex));
  }

  const userIds = new Set<string>();
  for (const m of content.matchAll(/<@!?(\d{17,20})>/g)) {
    userIds.add(m[1]!);
  }
  for (const userId of userIds) {
    const label = await resolveUserLabel(userId);
    const token = markerUser(label);
    content = content.split(`<@!${userId}>`).join(token);
    content = content.split(`<@${userId}>`).join(token);
  }

  const channelIds = new Set<string>();
  for (const m of content.matchAll(/<#(\d{17,20})>/g)) {
    channelIds.add(m[1]!);
  }
  for (const channelId of channelIds) {
    const fromMention = message.mentions.channels.get(channelId);
    let name: string | null =
      fromMention && 'name' in fromMention && fromMention.name
        ? fromMention.name
        : null;
    if (!name) {
      const cached = guild.channels.cache.get(channelId);
      if (cached && 'name' in cached) name = cached.name;
    }
    if (!name) {
      try {
        const ch = await guild.channels.fetch(channelId);
        if (ch && 'name' in ch) name = ch.name;
      } catch {
        name = channelId;
      }
    }
    content = content
      .split(`<#${channelId}>`)
      .join(markerChannel(name ?? channelId));
  }

  return content;
}
