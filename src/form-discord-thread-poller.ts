import {
  ChannelType,
  Client,
  type TextChannel,
} from 'discord.js';
import type { createApiClient } from './api';

type ApiFactory = (baseUrl: string) => ReturnType<typeof createApiClient>;

const INTERVAL_MS = 25_000;

export function startFormDiscordThreadPoller(
  client: Client,
  backendUrl: string,
  apiForUrl: ApiFactory,
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const api = apiForUrl(backendUrl);
      const { items } = await api.getPendingFormDiscordThreadJobs();
      for (const job of items) {
        try {
          const raw = await client.channels
            .fetch(job.channelId)
            .catch(() => null);
          if (!raw || raw.type !== ChannelType.GuildText || !('messages' in raw)) {
            throw new Error('Канал не найден или не текстовый');
          }
          const channel = raw as TextChannel;
          const msg = await channel.messages.fetch(job.messageId).catch(() => null);
          if (!msg) {
            throw new Error('Сообщение webhook не найдено');
          }
          const thread = await msg.startThread({
            name: job.threadName.slice(0, 100),
            autoArchiveDuration: 10080,
          });
          await api.ackFormDiscordThreadJob({
            jobId: job.jobId,
            threadId: thread.id,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.warn('form-discord-thread-poller: job', job.jobId, e);
          await api
            .ackFormDiscordThreadJob({
              jobId: job.jobId,
              error: message,
            })
            .catch(() => undefined);
        }
      }
    } catch (e) {
      console.warn('form-discord-thread-poller', e);
    } finally {
      busy = false;
    }
  }

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
