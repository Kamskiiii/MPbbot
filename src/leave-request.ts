import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type ThreadChannel,
  type User,
} from 'discord.js';
import type { VpBotConfigFromApi } from './config';
import type { createApiClient, VpLeaveNotifyPayload } from './api';
import { ApiError } from './api';
import {
  openPrivateApplicationThread,
  purgeAndDeleteThread,
} from './thread-helpers';

export const ACTIONS_LEAVE_BUTTON_ID = 'vp_actions_leave_request';
/** @deprecated alias */
export const WELCOME_LEAVE_BUTTON_ID = ACTIONS_LEAVE_BUTTON_ID;
export const LEAVE_APPLICATION_MODAL_ID = 'vp_leave_application_modal';
export const LEAVE_REJECT_BUTTON_PREFIX = 'vp_leave_reject:';
export const LEAVE_REJECT_MODAL_PREFIX = 'vp_leave_reject_modal:';

const FIELD_START = 'start_date';
const FIELD_END = 'end_date';
const FIELD_REASON = 'reason';
const FIELD_REJECT_REASON = 'reject_reason';
const EMOJI_PENDING = '⏳';

type ApiClient = ReturnType<typeof createApiClient>;

function clampLine(value: string, max = 900): string {
  const t = value.trim();
  if (!t) return '—';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function discordMention(userId: string): string {
  return `<@${userId}>`;
}

/** Парсит dd.mm.yyyy или yyyy-mm-dd → yyyy-mm-dd. */
export function parseLeaveDateInput(raw: string): string | null {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function formatYmdRu(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return ymd;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

export function isLeaveRequestConfigured(cfg: VpBotConfigFromApi): boolean {
  const ch = cfg.leaveRequestChannelId?.trim();
  const approvers = cfg.leaveApproverRoleIds ?? [];
  return Boolean(ch && approvers.length);
}

export function isLeaveRequestThread(
  channel: { isThread(): boolean; parentId: string | null },
  cfg: VpBotConfigFromApi,
): boolean {
  const parentId = cfg.leaveRequestChannelId?.trim();
  if (!parentId) return false;
  return channel.isThread() && channel.parentId === parentId;
}

export function isLeaveRequestContext(
  message: Message,
  cfg: VpBotConfigFromApi,
): boolean {
  const chId = cfg.leaveRequestChannelId?.trim();
  if (!chId) return false;
  const ch = message.channel;
  if (ch.id === chId) return true;
  if (!ch.isThread()) return false;
  return ch.parentId === chId;
}

export function canModerateLeaveRequest(
  member: GuildMember,
  cfg: VpBotConfigFromApi,
): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return (cfg.leaveApproverRoleIds ?? []).some((id) =>
    member.roles.cache.has(id),
  );
}

function threadIdFromPrefixedCustomId(
  prefix: string,
  customId: string,
): string | null {
  if (!customId.startsWith(prefix)) return null;
  const id = customId.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

export async function findLeaveRequestIdByThread(
  api: ApiClient,
  threadId: string,
): Promise<string | null> {
  const rows = await api.getPendingRequests();
  for (const row of rows) {
    const p = row.payload as {
      operation?: string;
      data?: Record<string, unknown>;
    };
    if (p.operation !== 'leave_request') continue;
    const tid = p.data?.threadId;
    if (typeof tid === 'string' && tid.trim() === threadId) return row.id;
  }
  return null;
}

function buildLeaveModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(LEAVE_APPLICATION_MODAL_ID)
    .setTitle('Заявка на отпуск')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_START)
          .setLabel('С (дд.мм.гггг)')
          .setPlaceholder('01.03.2026')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(16),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_END)
          .setLabel('По (дд.мм.гггг)')
          .setPlaceholder('15.03.2026')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(16),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_REASON)
          .setLabel('Причина (необязательно)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000),
      ),
    );
}

function buildLeaveRejectButtonRow(
  threadId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LEAVE_REJECT_BUTTON_PREFIX}${threadId}`)
      .setLabel('Отклонить')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildLeaveRejectModal(threadId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${LEAVE_REJECT_MODAL_PREFIX}${threadId}`)
    .setTitle('Отклонение отпуска')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_REJECT_REASON)
          .setLabel('Причина отклонения')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

export function buildLeaveNotifyEmbed(params: {
  applicantDiscordUserId: string;
  discordDisplayName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: 'active' | 'finished';
}): EmbedBuilder {
  const name =
    params.discordDisplayName?.trim() ||
    `ID ${params.applicantDiscordUserId}`;
  const embed = new EmbedBuilder()
    .setTitle(params.status === 'active' ? 'Отпуск' : 'Отпуск завершён')
    .setColor(params.status === 'active' ? 0x3498db : 0x95a5a6)
    .addFields(
      {
        name: 'Участник',
        value: `${discordMention(params.applicantDiscordUserId)} (${clampLine(name, 80)})`,
      },
      {
        name: 'Период',
        value: `${formatYmdRu(params.startDate)} — ${formatYmdRu(params.endDate)}`,
      },
      {
        name: 'Статус',
        value: params.status === 'active' ? 'В отпуске' : 'Завершён',
      },
    )
    .setTimestamp(new Date());
  if (params.reason?.trim()) {
    embed.addFields({
      name: 'Причина',
      value: clampLine(params.reason, 1000),
    });
  }
  return embed;
}

export async function postLeaveNotifyMessage(
  guild: import('discord.js').Guild,
  api: ApiClient,
  payload: VpLeaveNotifyPayload,
): Promise<void> {
  const ch = await guild.channels.fetch(payload.channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || ch.isDMBased()) {
    console.warn('leave-notify: канал недоступен', payload.channelId);
    return;
  }
  const embed = buildLeaveNotifyEmbed({
    applicantDiscordUserId: payload.applicantDiscordUserId,
    discordDisplayName: payload.discordDisplayName,
    startDate: payload.startDate,
    endDate: payload.endDate,
    reason: payload.reason,
    status: 'active',
  });
  const msg = await ch.send({
    embeds: [embed],
    allowedMentions: { users: [payload.applicantDiscordUserId] },
  });
  await api.setLeaveNotifyMessage(payload.leaveId, payload.channelId, msg.id);
}

export async function handleWelcomeLeaveButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (
    interaction.customId !== ACTIONS_LEAVE_BUTTON_ID &&
    interaction.customId !== 'vp_welcome_leave_request'
  ) {
    return;
  }

  const actionsCh = cfg.actionsPanelChannelId?.trim();
  const guildId = cfg.guildId?.trim();
  if (!actionsCh) {
    await interaction
      .reply({
        content: 'Канал панели действий не настроен.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }
  if (guildId && interaction.guildId !== guildId) {
    await interaction
      .reply({
        content: 'Эта кнопка на другом сервере не действует.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }
  if (interaction.channelId !== actionsCh) {
    await interaction
      .reply({
        content: 'Эта кнопка здесь не действует.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  if (!isLeaveRequestConfigured(cfg)) {
    await interaction
      .reply({
        content:
          'Заявки на отпуск не настроены (канал или модераторы — обратитесь к техадмину).',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  await interaction.showModal(buildLeaveModal()).catch(() => {});
}

function buildLeaveModerationMessage(params: {
  applicantDiscordUserId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
}): string {
  return [
    '🏖 **Заявка на отпуск**',
    '',
    `👤 Заявитель: ${discordMention(params.applicantDiscordUserId)}`,
    `📅 С: ${formatYmdRu(params.startDate)}`,
    `📅 По: ${formatYmdRu(params.endDate)}`,
    `📝 Причина: ${params.reason ? clampLine(params.reason, 800) : '—'}`,
    '',
    '_Реакция ✅ — одобрить (сообщение в канал отпусков). «Отклонить» — с причиной._',
  ].join('\n');
}

export async function handleLeaveApplicationModalSubmit(
  interaction: ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  if (interaction.customId !== LEAVE_APPLICATION_MODAL_ID) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isLeaveRequestConfigured(cfg) || !interaction.guild) {
    await interaction.editReply({
      content: 'Заявки на отпуск не настроены.',
    });
    return;
  }

  const startRaw = interaction.fields.getTextInputValue(FIELD_START).trim();
  const endRaw = interaction.fields.getTextInputValue(FIELD_END).trim();
  const reason =
    interaction.fields.getTextInputValue(FIELD_REASON).trim() || null;

  const startDate = parseLeaveDateInput(startRaw);
  const endDate = parseLeaveDateInput(endRaw);
  if (!startDate || !endDate) {
    await interaction.editReply({
      content: 'Даты должны быть в формате дд.мм.гггг (например 01.03.2026).',
    });
    return;
  }
  if (startDate > endDate) {
    await interaction.editReply({
      content: 'Дата начала не может быть позже даты окончания.',
    });
    return;
  }

  const applicantId = interaction.user.id;
  const member = await interaction.guild.members.fetch(applicantId);
  const displayName = member.displayName;
  const threadTitle = `Отпуск — ${displayName}`.slice(0, 100);

  let thread: ThreadChannel | null = null;
  let channelPlaceholder: Message | null = null;

  try {
    const opened = await openPrivateApplicationThread({
      guild: interaction.guild,
      parentChannelId: cfg.leaveRequestChannelId!.trim(),
      applicantId,
      approverRoleIds: cfg.leaveApproverRoleIds ?? [],
      threadTitle,
      placeholderContent: 'Создание ветки заявки на отпуск…',
    });
    thread = opened.thread;
    channelPlaceholder = opened.channelPlaceholder;

    await api.createRequest({
      type: 'leave_request',
      payload: {
        applicantDiscordUserId: applicantId,
        threadId: thread.id,
        discordDisplayName: displayName,
        startDate,
        endDate,
        reason,
      },
    });

    const content = buildLeaveModerationMessage({
      applicantDiscordUserId: applicantId,
      startDate,
      endDate,
      reason,
    });

    const reply = await thread.send({
      content,
      components: [buildLeaveRejectButtonRow(thread.id)],
      allowedMentions: { users: [applicantId] },
    });
    try {
      await reply.react(EMOJI_PENDING);
      await reply.react('✅');
    } catch (e) {
      console.warn('react on leave request message', e);
    }

    await interaction.editReply({
      content: 'Заявка на отпуск отправлена. Ожидайте решения в приватной ветке.',
    });
  } catch (e) {
    console.warn('leave-request: submit', e);
    if (thread) {
      await thread.delete().catch(() => {});
    }
    const msg =
      e instanceof ApiError && e.status === 409
        ? 'У вас уже есть необработанная заявка на отпуск.'
        : e instanceof Error
          ? e.message
          : 'Не удалось создать заявку. Попробуйте позже.';
    await interaction.editReply({ content: msg });
  } finally {
    if (channelPlaceholder) {
      await channelPlaceholder.delete().catch(() => {});
    }
  }
}

export async function handleLeaveRejectButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    LEAVE_REJECT_BUTTON_PREFIX,
    interaction.customId,
  );
  if (!threadId) return;

  if (!interaction.guild || !interaction.member) {
    await interaction
      .reply({
        content: 'Не удалось обработать запрос.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canModerateLeaveRequest(member, cfg)) {
    await interaction
      .reply({
        content: 'Недостаточно прав для отклонения отпуска.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const ch = interaction.channel;
  if (!ch?.isThread() || ch.id !== threadId || !isLeaveRequestThread(ch, cfg)) {
    await interaction
      .reply({
        content: 'Кнопка недействительна для этой ветки.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  await interaction.showModal(buildLeaveRejectModal(threadId)).catch(() => {});
}

export async function handleLeaveRejectModalSubmit(
  interaction: ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    LEAVE_REJECT_MODAL_PREFIX,
    interaction.customId,
  );
  if (!threadId) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guild || !interaction.member) {
    await interaction.editReply({ content: 'Не удалось обработать запрос.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canModerateLeaveRequest(member, cfg)) {
    await interaction.editReply({
      content: 'Недостаточно прав для отклонения отпуска.',
    });
    return;
  }

  const ch = interaction.channel;
  if (
    !ch?.isThread() ||
    ch.id !== threadId ||
    !isLeaveRequestThread(ch, cfg)
  ) {
    await interaction.editReply({ content: 'Ветка заявки не найдена.' });
    return;
  }

  const reason = interaction.fields
    .getTextInputValue(FIELD_REJECT_REASON)
    .trim();
  if (!reason) {
    await interaction.editReply({ content: 'Укажите причину отклонения.' });
    return;
  }

  const requestId = await findLeaveRequestIdByThread(api, threadId);
  if (!requestId) {
    await interaction.editReply({
      content: 'Заявка уже обработана или не найдена.',
    });
    return;
  }

  const pending = await api.getPendingRequests();
  const row = pending.find((r) => r.id === requestId);
  if (!row) {
    await interaction.editReply({
      content: 'Заявка уже обработана или не найдена.',
    });
    return;
  }

  const data = (row.payload as { data?: Record<string, unknown> }).data;
  const applicantId =
    typeof data?.applicantDiscordUserId === 'string'
      ? data.applicantDiscordUserId.trim()
      : null;

  try {
    await api.setStatus(requestId, 'rejected');

    let dmOk = false;
    if (applicantId) {
      const applicant = await interaction.client.users
        .fetch(applicantId)
        .catch(() => null);
      if (applicant) {
        dmOk = await dmLeaveRejection(applicant, reason);
      }
    }

    await purgeAndDeleteThread(ch);

    await interaction.editReply({
      content: dmOk
        ? 'Заявка отклонена. Заявителю отправлено ЛС.'
        : 'Заявка отклонена. Не удалось отправить ЛС заявителю.',
    });
  } catch (e) {
    console.warn('leave-request: reject', e);
    if (e instanceof ApiError && e.status === 409) {
      await interaction.editReply({ content: 'Заявка уже была обработана.' });
      return;
    }
    await interaction.editReply({
      content: 'Не удалось отклонить заявку. Попробуйте позже.',
    });
  }
}

async function dmLeaveRejection(
  applicant: User,
  reason: string,
): Promise<boolean> {
  try {
    await applicant.send({
      content: [
        'Ваша **заявка на отпуск** отклонена.',
        '',
        '**Причина:**',
        reason.trim() || 'Причина не указана.',
      ].join('\n'),
    });
    return true;
  } catch {
    return false;
  }
}

export { purgeAndDeleteThread as purgeLeaveRequestThread };
