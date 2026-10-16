import {
  ChannelType,
  Client,
  type TextChannel,
  type Guild,
} from 'discord.js';
import type { createApiClient } from './api';
import { applyDiscordRoleSync } from './apply-discord-role-sync';
import { buildLeaveNotifyEmbed } from './leave-request';

type ApiFactory = (baseUrl: string) => ReturnType<typeof createApiClient>;

const INTERVAL_MS = 25_000;

async function resolveGuild(
  client: Client,
  channelId: string,
): Promise<Guild | null> {
  if (channelId) {
    const raw = await client.channels.fetch(channelId).catch(() => null);
    if (raw && 'guild' in raw && raw.guild) return raw.guild;
  }
  return client.guilds.cache.first() ?? null;
}

export function startLeaveNotifyPoller(
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
      const { items } = await api.getPendingLeaveNotifyEdits();
      for (const job of items) {
        try {
          const guild = await resolveGuild(client, job.channelId);
          const roleId = job.leaveActiveRoleId?.trim();
          if (roleId && job.applicantDiscordUserId && guild) {
            await applyDiscordRoleSync(guild, {
              targetDiscordUserId: job.applicantDiscordUserId,
              addRoleIds: [],
              removeRoleIds: [roleId],
            });
          }

          if (job.channelId?.trim() && job.messageId?.trim()) {
            const raw = await client.channels
              .fetch(job.channelId)
              .catch(() => null);
            if (
              raw &&
              raw.type === ChannelType.GuildText &&
              'messages' in raw
            ) {
              const channel = raw as TextChannel;
              const msg = await channel.messages
                .fetch(job.messageId)
                .catch(() => null);
              if (msg) {
                const embed = buildLeaveNotifyEmbed({
                  applicantDiscordUserId: job.applicantDiscordUserId,
                  discordDisplayName: job.discordDisplayName,
                  startDate: job.startDate,
                  endDate: job.endDate,
                  reason: job.reason,
                  status: 'finished',
                });
                await msg.edit({ embeds: [embed] });
              }

              const approver = job.approvedByDiscordUserId?.trim();
              const applicant = job.applicantDiscordUserId?.trim();
              if (approver && applicant) {
                await channel
                  .send({
                    content: `<@${approver}> Отпуск <@${applicant}> завершён.`,
                    allowedMentions: { users: [approver, applicant] },
                  })
                  .catch((e) =>
                    console.warn('leave-notify: ping approver', e),
                  );
              }
            }
          }

          await api.ackLeaveNotifyEdit(job.leaveId);
        } catch (e) {
          console.warn('leave-notify-poller: job', job.leaveId, e);
          await api
            .ackLeaveNotifyEdit(
              job.leaveId,
              e instanceof Error ? e.message : String(e),
            )
            .catch(() => undefined);
        }
      }
    } catch (e) {
      console.warn('leave-notify-poller', e);
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
