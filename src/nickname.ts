import type { GuildMember } from 'discord.js';

const DISCORD_NICKNAME_MAX = 32;

function discordErrorCode(e: unknown): number | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    return typeof c === 'number' ? c : undefined;
  }
  return undefined;
}

function isMissingPermissions(e: unknown): boolean {
  return discordErrorCode(e) === 50013;
}

async function trySetGuildNickname(
  member: GuildMember,
  nick: string,
): Promise<void> {
  if ((member.nickname ?? '') === nick) return;
  try {
    await member.setNickname(nick);
  } catch (e) {
    if (isMissingPermissions(e)) {
      console.warn(
        'server nickname: нет прав (Manage Nicknames или роль бота ниже участника) — ник не изменён',
      );
      return;
    }
    console.warn(
      'server nickname (нужны права «Управлять никнеймами» и роль бота выше участника)',
      e,
    );
  }
}

export function guildNicknameFromFullName(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  return t.length > DISCORD_NICKNAME_MAX
    ? t.slice(0, DISCORD_NICKNAME_MAX)
    : t;
}

/** Серверный ник из ФИО (≤32). Ошибка прав не прерывает вызывающий поток. */
export async function setMemberNicknameFromFullName(
  member: GuildMember,
  fullName: string,
): Promise<void> {
  const nick = guildNicknameFromFullName(fullName);
  if (!nick) return;
  await trySetGuildNickname(member, nick);
}
