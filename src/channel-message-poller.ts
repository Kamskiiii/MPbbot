import {
  ChannelType,
  type Attachment,
  type Client,
  type GuildBasedChannel,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import type { createApiClient } from './api';
import { formatMessageContentForSite } from './format-message-content';

type ApiFactory = (base: string) => ReturnType<typeof createApiClient>;
type PollerLog = (message: string, error?: unknown) => void;

export type PollerController = {
  start: () => void;
  stop: () => void;
};

const INTERVAL_MS = 5_000;
const MESSAGE_LIMIT = 100;
const IMAGE_MIME = /^image\//i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;

function isImageAttachment(att: Attachment): boolean {
  if (att.contentType && IMAGE_MIME.test(att.contentType)) return true;
  const name = att.name?.toLowerCase() ?? '';
  return IMAGE_EXT.test(name);
}

function collectImageUrls(msg: Message): string[] {
  return [...msg.attachments.values()]
    .filter(isImageAttachment)
    .map((a) => a.url)
    .filter(Boolean)
    .slice(0, 20);
}

function canReadHistory(ch: GuildBasedChannel | null): boolean {
  if (!ch) return false;
  return (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement ||
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  );
}

function isThreadChannel(ch: GuildBasedChannel): boolean {
  return (
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  );
}

/** Метаданные ветки у сообщения родителя; у ответов внутри ветки — null. */
function collectThreadMeta(
  msg: Message,
  insideThread: boolean,
): {
  threadId: string | null;
  threadName: string | null;
  threadMessageCount: number | null;
} {
  if (insideThread || !msg.hasThread) {
    return { threadId: null, threadName: null, threadMessageCount: null };
  }
  const thread = msg.thread;
  // У ветки из сообщения id совпадает с id стартового сообщения.
  const threadId = thread?.id ?? msg.id;
  const count =
    thread &&
    typeof thread.messageCount === 'number' &&
    thread.messageCount >= 0
      ? thread.messageCount
      : null;
  return {
    threadId,
    threadName: thread?.name?.trim() || null,
    threadMessageCount: count,
  };
}

/**
 * Очередь: загрузка последних сообщений канала ВП для сайта.
 */
export function startChannelMessagePoller(
  client: Client,
  backendUrl: string,
  apiForUrl: ApiFactory,
  logWarn: PollerLog = (message, error) => console.warn(message, error),
): PollerController {
  let timer: NodeJS.Timeout | null = null;
  let tickBusy = false;

  const tick = async () => {
    if (!client.isReady()) return;
    if (tickBusy) return;
    tickBusy = true;
    try {
      const api = apiForUrl(backendUrl);
      const { items } = await api.getPendingChannelMessageJobs();
      if (!items.length) return;

      for (const job of items) {
        try {
          const channel = await client.channels.fetch(job.channelId);
          if (!channel || !('guild' in channel) || !channel.guild) {
            await api.ackChannelMessageJob({
              jobId: job.jobId,
              error: 'Канал не найден или недоступен боту',
            });
            continue;
          }

          if (!canReadHistory(channel as GuildBasedChannel)) {
            await api.ackChannelMessageJob({
              jobId: job.jobId,
              error:
                'История доступна только для текстовых каналов, объявлений и веток',
            });
            continue;
          }

          const guild = channel.guild;
          const textChannel = channel as TextBasedChannel;
          const insideThread = isThreadChannel(channel as GuildBasedChannel);
          const fetched = await textChannel.messages.fetch({
            limit: MESSAGE_LIMIT,
          });

          const nickCache = new Map<string, string>();
          const resolveNick = async (
            userId: string,
            username: string,
          ): Promise<string> => {
            if (nickCache.has(userId)) return nickCache.get(userId)!;
            try {
              const member = await guild.members.fetch(userId);
              const nick =
                member.nickname?.trim() ||
                member.displayName?.trim() ||
                username;
              nickCache.set(userId, nick);
              return nick;
            } catch {
              nickCache.set(userId, username);
              return username;
            }
          };

          const sorted = [...fetched.values()].sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          );

          const messages = [];
          for (const msg of sorted as Message[]) {
            const username = msg.author.username;
            const authorNick = await resolveNick(msg.author.id, username);
            const content = await formatMessageContentForSite(msg, guild);
            const threadMeta = collectThreadMeta(msg, insideThread);
            messages.push({
              id: msg.id,
              content,
              createdAt: msg.createdAt.toISOString(),
              authorId: msg.author.id,
              authorNick,
              authorUsername: username,
              imageUrls: collectImageUrls(msg),
              ...threadMeta,
            });
          }

          await api.ackChannelMessageJob({
            jobId: job.jobId,
            messages,
          });
        } catch (e) {
          logWarn(`channel-message-job ${job.jobId}`, e);
          const errMsg =
            e && typeof e === 'object' && 'message' in e
              ? String((e as { message: unknown }).message)
              : 'Не удалось загрузить сообщения';
          await api
            .ackChannelMessageJob({
              jobId: job.jobId,
              error: errMsg.slice(0, 1000),
            })
            .catch(() => undefined);
        }
      }
    } catch (e) {
      logWarn('channel-message-poller', e);
    } finally {
      tickBusy = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), INTERVAL_MS);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
