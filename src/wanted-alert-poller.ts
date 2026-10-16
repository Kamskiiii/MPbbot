import {
  ChannelType,
  Client,
  EmbedBuilder,
  type TextChannel,
} from 'discord.js';
import type { createApiClient, WantedAlertJob, WantedClass } from './api';

type ApiFactory = (baseUrl: string) => ReturnType<typeof createApiClient>;

const INTERVAL_MS = 15_000;

const CLASS_LABELS: Record<WantedClass, string> = {
  red: 'Красный',
  yellow: 'Жёлтый',
  blue: 'Синий (наблюдение)',
};

const CLASS_COLOR: Record<WantedClass, number> = {
  red: 0xed4245,
  yellow: 0xfee75c,
  blue: 0x3498db,
};

function clamp(value: string, max: number): string {
  const t = value.trim();
  if (!t) return '—';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function pingContent(job: WantedAlertJob): string {
  const mentions = (job.pingRoleIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => `<@&${id}>`)
    .join(' ');
  const body = `**${clamp(job.fullName, 80)}** в розыске и сейчас на сервере. Пора бусифицировать.`;
  return mentions ? `${mentions} ${body}` : body;
}

function leftContent(job: WantedAlertJob): string {
  return `**${clamp(job.fullName, 80)}** вышел с игрового сервера.`;
}

function buildAlertEmbed(job: WantedAlertJob, left: boolean): EmbedBuilder {
  const cls = job.wantedClass;
  const embed = new EmbedBuilder()
    .setTitle(left ? 'Розыск · вышел' : 'Розыск · на сервере')
    .setColor(left ? 0x95a5a6 : CLASS_COLOR[cls] ?? 0xed4245)
    .addFields(
      { name: 'ФИО', value: clamp(job.fullName, 256), inline: true },
      {
        name: 'Класс',
        value: CLASS_LABELS[cls] ?? cls,
        inline: true,
      },
      {
        name: 'Награда',
        value: job.reward.toLocaleString('ru-RU'),
        inline: true,
      },
      {
        name: 'Причина',
        value: clamp(job.reason, 1000),
      },
    );
  if (job.serverName?.trim()) {
    embed.addFields({
      name: 'Ник на сервере',
      value: clamp(job.serverName, 256),
      inline: true,
    });
  }
  if (!left && job.gifUrl?.trim()) {
    embed.setImage(job.gifUrl.trim());
  }
  return embed;
}

async function resolveTextChannel(
  client: Client,
  channelId: string,
): Promise<TextChannel | null> {
  const raw = await client.channels.fetch(channelId).catch(() => null);
  if (!raw || raw.type !== ChannelType.GuildText) return null;
  return raw as TextChannel;
}

export function startWantedAlertPoller(
  client: Client,
  backendUrl: string,
  apiForUrl: ApiFactory,
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  async function tick(): Promise<void> {
    if (busy || !client.isReady()) return;
    busy = true;
    try {
      const api = apiForUrl(backendUrl);
      const { items } = await api.getPendingWantedAlertJobs();
      for (const job of items) {
        try {
          const channel = await resolveTextChannel(client, job.channelId);
          if (!channel) {
            await api.ackWantedAlertJob({
              jobId: job.id,
              error: 'Канал алерта не найден или не текстовый',
            });
            continue;
          }
          if (job.kind === 'post') {
            const sent = await channel.send({
              content: pingContent(job),
              embeds: [buildAlertEmbed(job, false)],
              allowedMentions: { roles: job.pingRoleIds ?? [] },
            });
            await api.ackWantedAlertJob({
              jobId: job.id,
              messageId: sent.id,
            });
          } else {
            const messageId = job.messageId?.trim();
            if (!messageId) {
              await api.ackWantedAlertJob({
                jobId: job.id,
                error: 'Нет messageId для edit',
              });
              continue;
            }
            const msg = await channel.messages.fetch(messageId).catch(() => null);
            if (msg) {
              await msg.edit({
                content: leftContent(job),
                embeds: [buildAlertEmbed(job, true)],
                allowedMentions: { parse: [] },
              });
            }
            await api.ackWantedAlertJob({ jobId: job.id, messageId });
          }
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          console.warn('wanted-alert:', text);
          await api
            .ackWantedAlertJob({
              jobId: job.id,
              error: text.slice(0, 500),
            })
            .catch(() => {});
        }
      }
    } catch (e) {
      console.warn('wanted-alert: tick', e);
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
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
