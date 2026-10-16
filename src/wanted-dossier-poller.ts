import {
  ChannelType,
  Client,
  EmbedBuilder,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type {
  createApiClient,
  WantedClass,
  WantedDossierJob,
} from './api';
import { inviteMembersByRoles } from './invite-thread-members';

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

function starterEmbed(job: WantedDossierJob): EmbedBuilder {
  const p = job.payload;
  const closed = p.closed || job.kind === 'close';
  return new EmbedBuilder()
    .setTitle(closed ? `Розыск · снят — ${clamp(p.fullName, 80)}` : `Розыск — ${clamp(p.fullName, 80)}`)
    .setColor(closed ? 0x95a5a6 : CLASS_COLOR[p.wantedClass] ?? 0xed4245)
    .setDescription(clamp(p.reason, 400))
    .addFields(
      { name: 'Класс', value: CLASS_LABELS[p.wantedClass] ?? p.wantedClass, inline: true },
      { name: 'Награда', value: p.reward.toLocaleString('ru-RU'), inline: true },
      {
        name: 'Статус',
        value: closed ? 'снят с розыска' : p.online ? 'на сервере' : 'офлайн',
        inline: true,
      },
    );
}

function cardEmbed(job: WantedDossierJob): EmbedBuilder {
  const p = job.payload;
  const closed = p.closed || job.kind === 'close';
  const embed = new EmbedBuilder()
    .setTitle(closed ? 'Досье · снят с розыска' : 'Досье розыска')
    .setColor(closed ? 0x95a5a6 : CLASS_COLOR[p.wantedClass] ?? 0xed4245)
    .addFields(
      { name: 'ФИО', value: clamp(p.fullName, 256), inline: true },
      { name: 'Класс', value: CLASS_LABELS[p.wantedClass] ?? p.wantedClass, inline: true },
      { name: 'Награда', value: p.reward.toLocaleString('ru-RU'), inline: true },
      { name: 'Причина', value: clamp(p.reason, 1000) },
    );
  if (p.steam64) {
    embed.addFields({ name: 'Steam64', value: p.steam64, inline: true });
  }
  if (p.serverName) {
    embed.addFields({
      name: 'Ник на сервере',
      value: clamp(p.serverName, 256),
      inline: true,
    });
  }
  embed.addFields({
    name: 'Онлайн',
    value: closed ? 'снят' : p.online ? 'сейчас на сервере' : 'офлайн',
    inline: true,
  });
  if (p.siteUrl) {
    embed.setURL(p.siteUrl);
  }
  return embed;
}

function analyticsEmbed(job: WantedDossierJob): EmbedBuilder {
  const p = job.payload;
  const heat = p.heatmapLines.length
    ? `\`\`\`\n${p.heatmapLines.map((l) => clamp(l, 80)).join('\n')}\n\`\`\``
    : '—';
  const embed = new EmbedBuilder()
    .setTitle('Аналитика онлайна')
    .setColor(0x2c3e50)
    .addFields(
      {
        name: 'Обычное окно',
        value: clamp(p.typicalWindow, 256),
        inline: true,
      },
      {
        name: 'Медиана сеанса',
        value: clamp(p.medianSession, 64),
        inline: true,
      },
      {
        name: 'Сессий за 28 дн.',
        value: String(p.sessionCount),
        inline: true,
      },
      { name: 'Тепловая карта (МСК)', value: clamp(heat, 1024) },
    );
  if (!p.reliable) {
    embed.setFooter({
      text: 'Мало сессий — паттерн пока ненадёжен. Коллектор копит историю с момента включения.',
    });
  }
  if (p.anomalies.length > 0) {
    embed.addFields({
      name: 'Странности',
      value: clamp(p.anomalies.map((a) => `• ${a}`).join('\n'), 1024),
    });
  }
  if (p.coPresence.length > 0) {
    const lines = p.coPresence.map((c) => {
      const unit = c.unit ? ` · ${c.unit}` : '';
      return `• **${clamp(c.name, 40)}**${unit} — вместе ${c.overlap}, lift ${c.lift}`;
    });
    embed.addFields({
      name: 'Часто вместе',
      value: clamp(lines.join('\n'), 1024),
    });
  } else {
    embed.addFields({
      name: 'Часто вместе',
      value: 'Пока нет устойчивых пересечений',
    });
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

async function resolveThread(
  client: Client,
  threadId: string | null | undefined,
): Promise<ThreadChannel | null> {
  const id = threadId?.trim();
  if (!id) return null;
  const raw = await client.channels.fetch(id).catch(() => null);
  if (!raw || !raw.isThread()) return null;
  const thread = raw as ThreadChannel;
  if (thread.archived) {
    await thread.setArchived(false).catch(() => undefined);
  }
  return thread;
}

async function inviteOperators(
  thread: ThreadChannel,
  job: WantedDossierJob,
): Promise<void> {
  const guild = thread.guild;
  if (!guild) return;
  const ids = job.payload.operatorRoleIds ?? [];
  if (ids.length === 0) return;
  await inviteMembersByRoles(thread, guild, ids);
}

export function startWantedDossierPoller(
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
      const { items } = await api.getPendingWantedDossierJobs();
      for (const job of items) {
        try {
          await handleJob(client, api, job);
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          console.warn('wanted-dossier:', text);
          await api
            .ackWantedDossierJob({
              jobId: job.id,
              error: text.slice(0, 500),
            })
            .catch(() => undefined);
        }
      }
    } catch (e) {
      console.warn('wanted-dossier: tick', e);
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

async function handleJob(
  client: Client,
  api: ReturnType<typeof createApiClient>,
  job: WantedDossierJob,
): Promise<void> {
  const channel = await resolveTextChannel(client, job.channelId);
  if (!channel) {
    await api.ackWantedDossierJob({
      jobId: job.id,
      error: 'Канал досье не найден или не текстовый',
    });
    return;
  }

  if (job.kind === 'open') {
    let thread = await resolveThread(client, job.threadId);
    let starterMessageId = job.starterMessageId;
    if (!thread) {
      const starter = await channel.send({
        embeds: [starterEmbed(job)],
      });
      starterMessageId = starter.id;
      thread = await starter.startThread({
        name: (job.payload.threadName || `Розыск — ${job.payload.fullName}`).slice(
          0,
          100,
        ),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      });
    } else {
      if (starterMessageId) {
        const starterMsg = await channel.messages
          .fetch(starterMessageId)
          .catch(() => null);
        if (starterMsg) {
          await starterMsg.edit({ embeds: [starterEmbed(job)] });
        }
      }
    }
    const card = await upsertThreadMessage(
      thread,
      job.cardMessageId,
      [cardEmbed(job)],
    );
    const analytics = await upsertThreadMessage(
      thread,
      job.analyticsMessageId,
      [analyticsEmbed(job)],
    );
    await inviteOperators(thread, job);
    await api.ackWantedDossierJob({
      jobId: job.id,
      threadId: thread.id,
      starterMessageId,
      cardMessageId: card,
      analyticsMessageId: analytics,
    });
    return;
  }

  const thread = await resolveThread(client, job.threadId);
  if (!thread) {
    await api.ackWantedDossierJob({
      jobId: job.id,
      error: 'Ветка досье не найдена',
    });
    return;
  }

  if (job.starterMessageId) {
    const starterMsg = await channel.messages
      .fetch(job.starterMessageId)
      .catch(() => null);
    if (starterMsg) {
      await starterMsg.edit({ embeds: [starterEmbed(job)] });
    }
  }

  const cardId = await upsertThreadMessage(
    thread,
    job.cardMessageId,
    [cardEmbed(job)],
  );
  const analyticsId = await upsertThreadMessage(
    thread,
    job.analyticsMessageId,
    [analyticsEmbed(job)],
  );

  if (job.kind === 'close') {
    await thread.setArchived(true).catch(() => undefined);
  }

  await api.ackWantedDossierJob({
    jobId: job.id,
    threadId: thread.id,
    starterMessageId: job.starterMessageId,
    cardMessageId: cardId,
    analyticsMessageId: analyticsId,
  });
}

async function upsertThreadMessage(
  thread: ThreadChannel,
  messageId: string | null | undefined,
  embeds: EmbedBuilder[],
): Promise<string> {
  const id = messageId?.trim();
  if (id) {
    const msg = await thread.messages.fetch(id).catch(() => null);
    if (msg) {
      await msg.edit({ embeds });
      return msg.id;
    }
  }
  const sent = await thread.send({ embeds });
  return sent.id;
}
