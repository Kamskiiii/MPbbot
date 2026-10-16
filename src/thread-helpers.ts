import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Guild,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { inviteMembersByRoles } from './invite-thread-members';

export async function purgeAndDeleteThread(thread: ThreadChannel): Promise<void> {
  const maxAge = 14 * 24 * 60 * 60 * 1000;
  try {
    while (true) {
      const batch = await thread.messages.fetch({ limit: 100 });
      if (batch.size === 0) break;
      const recent = batch.filter((m) => Date.now() - m.createdTimestamp < maxAge);
      if (recent.size > 0) {
        await thread.bulkDelete(recent);
      }
      for (const m of batch.values()) {
        if (Date.now() - m.createdTimestamp >= maxAge) {
          try {
            await m.delete();
          } catch {
            /* старое сообщение */
          }
        }
      }
      if (batch.size < 100) break;
    }
  } catch (e) {
    console.warn('purge thread', e);
  }
  try {
    await thread.delete();
  } catch (e) {
    console.warn('delete thread', e);
  }
}

export async function openPrivateApplicationThread(params: {
  guild: Guild;
  parentChannelId: string;
  applicantId: string;
  approverRoleIds: string[];
  threadTitle: string;
  placeholderContent: string;
}): Promise<{ thread: ThreadChannel; channelPlaceholder: Message }> {
  const parent = await params.guild.channels.fetch(params.parentChannelId);
  if (!parent?.isTextBased() || parent.isDMBased()) {
    throw new Error('Канал заявок должен быть текстовым каналом на сервере.');
  }
  if (
    parent.type === ChannelType.GuildVoice ||
    parent.type === ChannelType.GuildStageVoice
  ) {
    throw new Error('Канал заявок не может быть голосовым или сценой.');
  }
  if (!('threads' in parent)) {
    throw new Error(
      'Этот тип канала не поддерживает ветки (нужен текстовый канал или объявления).',
    );
  }
  const threadParent = parent as TextChannel;
  const name =
    params.threadTitle
      .replace(/[^\w\u0400-\u04FF\s—–\-]/g, '')
      .trim()
      .slice(0, 100) || 'Заявка';

  const channelPlaceholder = await threadParent.send({
    content: params.placeholderContent,
  });

  let thread: ThreadChannel;
  try {
    thread = await threadParent.threads.create({
      name,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      invitable: false,
    });
  } catch (e) {
    await channelPlaceholder.delete().catch(() => {});
    const hint = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Не удалось создать приватную ветку (${hint}). Нужны права «Создавать приватные ветки».`,
    );
  }

  try {
    await thread.members.add(params.applicantId);
  } catch {
    /* уже в ветке или нет прав */
  }

  const approverRoleIds = params.approverRoleIds
    .map((id) => id.trim())
    .filter(Boolean);
  await inviteMembersByRoles(
    thread,
    params.guild,
    approverRoleIds,
    new Set([params.applicantId]),
  );

  return { thread, channelPlaceholder };
}
