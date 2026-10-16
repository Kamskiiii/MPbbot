import type { Guild, ThreadChannel } from 'discord.js';

const MEMBERS_CACHE_TTL_MS = 60_000;
const membersCacheOkAt = new Map<string, number>();
const membersFetchInFlight = new Map<string, Promise<void>>();

async function ensureGuildMembersCached(guild: Guild): Promise<void> {
  const guildId = guild.id;
  const now = Date.now();
  if (
    guild.members.cache.size > 0 &&
    now - (membersCacheOkAt.get(guildId) ?? 0) < MEMBERS_CACHE_TTL_MS
  ) {
    return;
  }
  const inflight = membersFetchInFlight.get(guildId);
  if (inflight) {
    await inflight;
    return;
  }
  const fetchPromise = (async () => {
    try {
      await guild.members.fetch();
      membersCacheOkAt.set(guildId, Date.now());
    } catch (e) {
      console.warn('guild.members.fetch для приглашения в ветку заявки', e);
    }
  })();
  membersFetchInFlight.set(guildId, fetchPromise);
  try {
    await fetchPromise;
  } finally {
    membersFetchInFlight.delete(guildId);
  }
}

/** Приглашает в приватную ветку участников с указанными ролями. */
export async function inviteMembersByRoles(
  thread: ThreadChannel,
  guild: Guild,
  roleIds: string[],
  alreadyInThread: Set<string> = new Set(),
): Promise<void> {
  if (!roleIds.length) return;
  await ensureGuildMembersCached(guild);
  for (const [, m] of guild.members.cache) {
    if (alreadyInThread.has(m.id)) continue;
    if (!roleIds.some((rid) => m.roles.cache.has(rid))) continue;
    try {
      await thread.members.add(m.id);
      alreadyInThread.add(m.id);
    } catch {
      /* нет прав или уже в ветке */
    }
  }
}
