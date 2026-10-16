import type { Guild, GuildMember } from 'discord.js';
import type { VpDiscordRoleSyncDto } from './api';

function discordErrorCode(e: unknown): number | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    return typeof c === 'number' ? c : undefined;
  }
  return undefined;
}

function isBenignRoleRemoveError(e: unknown): boolean {
  const c = discordErrorCode(e);
  return c === 10011;
}

async function removeRolesSafe(member: GuildMember, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await member.roles.remove(ids);
  } catch (e) {
    if (isBenignRoleRemoveError(e)) return;
    for (const r of ids) {
      try {
        await member.roles.remove(r);
      } catch (e2) {
        if (isBenignRoleRemoveError(e2)) continue;
        console.warn('remove role', r, e2);
      }
    }
  }
}

async function addRolesSafe(member: GuildMember, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await member.roles.add(ids);
  } catch {
    for (const r of ids) {
      try {
        await member.roles.add(r);
      } catch (e) {
        console.warn('add role', r, e);
      }
    }
  }
}

/** Применяет add/remove ролей из ответа API после одобрения заявки. */
export async function applyDiscordRoleSync(
  guild: Guild,
  sync: VpDiscordRoleSyncDto,
): Promise<boolean> {
  const targetId = sync.targetDiscordUserId?.trim();
  if (!targetId) return false;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    console.warn('role-sync: участник не найден', targetId);
    return false;
  }
  const removeIds = [
    ...new Set((sync.removeRoleIds ?? []).map((x) => x.trim()).filter(Boolean)),
  ];
  const addIds = [
    ...new Set((sync.addRoleIds ?? []).map((x) => x.trim()).filter(Boolean)),
  ];
  await removeRolesSafe(member, removeIds);
  await addRolesSafe(member, addIds);
  return true;
}
