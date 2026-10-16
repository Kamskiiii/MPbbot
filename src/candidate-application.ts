import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
  type User,
} from 'discord.js';
import type { VpBotConfigFromApi } from './config';
import type { createApiClient } from './api';
import { ApiError } from './api';
import { applyDiscordRoleSync } from './apply-discord-role-sync';
import { inviteMembersByRoles } from './invite-thread-members';
import { setMemberNicknameFromFullName } from './nickname';
import { WELCOME_CANDIDATE_BUTTON_ID } from './welcome-panel';

export const CANDIDATE_APPLICATION_MODAL_ID = 'vp_candidate_application_modal';
export const CANDIDATE_APPROVE_BUTTON_PREFIX = 'vp_candidate_approve:';
export const CANDIDATE_APPROVE_SELECT_PREFIX = 'vp_candidate_approve_sel:';
export const CANDIDATE_REJECT_BUTTON_PREFIX = 'vp_candidate_reject:';
export const CANDIDATE_REJECT_MODAL_PREFIX = 'vp_candidate_reject_modal:';
const FIELD_FULL_NAME = 'full_name';
const FIELD_AGE = 'age';
const FIELD_HOURS = 'hours_per_week';
const FIELD_EXPERIENCE = 'arma_experience';
const FIELD_REJECT_REASON = 'reject_reason';

const EMOJI_PENDING = '⏳';

type ApiClient = ReturnType<typeof createApiClient>;

function roleLabel(guild: Guild, roleId: string): string {
  const role = guild.roles.cache.get(roleId);
  const name = role?.name?.trim() || roleId;
  return name.slice(0, 100);
}

/** Заявки на вступление настроены: канал, модераторы и список должностей. */
export function isCandidateApplicationConfigured(cfg: VpBotConfigFromApi): boolean {
  const appCh = cfg.candidateApplicationChannelId?.trim();
  const approvers = cfg.candidateApplicationApproverRoleIds ?? [];
  const positions = (cfg.positionRoleIds ?? []).map((id) => id.trim()).filter(Boolean);
  return Boolean(appCh && approvers.length && positions.length);
}

/** Уже состоит: есть любая должность из настроек. */
export function memberHasPositionRole(
  member: GuildMember,
  cfg: VpBotConfigFromApi,
): boolean {
  return (cfg.positionRoleIds ?? []).some(
    (id) => id.trim() && member.roles.cache.has(id.trim()),
  );
}

export type CandidateApplicationForm = {
  fullName: string;
  age: string;
  hoursPerWeek: string;
  armaExperience: string;
};

function clampLine(value: string, max = 900): string {
  const t = value.trim();
  if (!t) return '—';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function discordMention(userId: string): string {
  return `<@${userId}>`;
}

export function applicantIdFromCandidateMessage(message: Message): string | null {
  const content = message.content ?? '';
  if (!content.includes('Заявка на вступление')) return null;
  const m = /<@!?(\d+)>/.exec(content);
  return m?.[1] ?? null;
}

export async function findCandidateRequestIdByThread(
  api: ApiClient,
  threadId: string,
): Promise<string | null> {
  const rows = await api.getPendingRequests();
  for (const row of rows) {
    const p = row.payload as { operation?: string; data?: Record<string, unknown> };
    if (p.operation !== 'candidate_application') continue;
    const tid = p.data?.threadId;
    if (typeof tid === 'string' && tid.trim() === threadId) return row.id;
  }
  return null;
}

export function isCandidateApplicationThread(
  channel: { isThread(): boolean; parentId: string | null },
  cfg: VpBotConfigFromApi,
): boolean {
  const parentId = cfg.candidateApplicationChannelId?.trim();
  if (!parentId) return false;
  return channel.isThread() && channel.parentId === parentId;
}

export function isCandidateApplicationContext(
  message: Message,
  cfg: VpBotConfigFromApi,
): boolean {
  const chId = cfg.candidateApplicationChannelId?.trim();
  if (!chId) return false;
  const ch = message.channel;
  if (ch.id === chId) return true;
  if (!ch.isThread()) return false;
  return ch.parentId === chId;
}

export function canModerateCandidateApplication(
  member: GuildMember,
  cfg: VpBotConfigFromApi,
): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return (cfg.candidateApplicationApproverRoleIds ?? []).some((id) =>
    member.roles.cache.has(id),
  );
}

function threadIdFromPrefixedCustomId(prefix: string, customId: string): string | null {
  if (!customId.startsWith(prefix)) return null;
  const id = customId.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

export function buildCandidateRejectModal(threadId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${CANDIDATE_REJECT_MODAL_PREFIX}${threadId}`)
    .setTitle('Отклонение заявки')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_REJECT_REASON)
          .setLabel('Причина отклонения')
          .setPlaceholder('Сообщение уйдёт заявителю в личные сообщения')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

export function buildCandidateModerationButtonRow(
  threadId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CANDIDATE_APPROVE_BUTTON_PREFIX}${threadId}`)
      .setLabel('Одобрить')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CANDIDATE_REJECT_BUTTON_PREFIX}${threadId}`)
      .setLabel('Отклонить')
      .setStyle(ButtonStyle.Danger),
  );
}

/** @deprecated используйте buildCandidateModerationButtonRow */
export function buildCandidateRejectButtonRow(
  threadId: string,
): ActionRowBuilder<ButtonBuilder> {
  return buildCandidateModerationButtonRow(threadId);
}

function buildCandidatePositionSelectRow(
  guild: Guild,
  cfg: VpBotConfigFromApi,
  threadId: string,
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const positions = (cfg.positionRoleIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 25);
  if (!positions.length) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CANDIDATE_APPROVE_SELECT_PREFIX}${threadId}`)
      .setPlaceholder('Выберите должность')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        positions.map((id) => ({
          label: roleLabel(guild, id),
          value: id,
        })),
      ),
  );
}

export async function handleCandidateApproveButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    CANDIDATE_APPROVE_BUTTON_PREFIX,
    interaction.customId,
  );
  if (!threadId) return;

  if (!interaction.guild || !interaction.member) {
    await interaction
      .reply({ content: 'Не удалось обработать запрос.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canModerateCandidateApplication(member, cfg)) {
    await interaction
      .reply({
        content: 'Недостаточно прав для одобрения заявки на вступление.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  const ch = interaction.channel;
  if (!ch?.isThread() || ch.id !== threadId) {
    await interaction
      .reply({ content: 'Кнопка недействительна для этой ветки.', ephemeral: true })
      .catch(() => {});
    return;
  }

  if (!isCandidateApplicationThread(ch, cfg)) {
    await interaction
      .reply({ content: 'Эта кнопка здесь не действует.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const selectRow = buildCandidatePositionSelectRow(interaction.guild, cfg, threadId);
  if (!selectRow) {
    await interaction
      .reply({
        content:
          'В настройках не заданы роли должностей (positionRoleIds). Обратитесь к техадмину.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  await interaction
    .reply({
      content: 'Выберите должность для заявителя:',
      components: [selectRow],
      ephemeral: true,
    })
    .catch(() => {});
}

export async function handleCandidateApproveSelect(
  interaction: StringSelectMenuInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    CANDIDATE_APPROVE_SELECT_PREFIX,
    interaction.customId,
  );
  if (!threadId) return;

  await interaction.deferUpdate().catch(() => {});

  if (!interaction.guild || !interaction.member) {
    await interaction
      .followUp({ content: 'Не удалось обработать запрос.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canModerateCandidateApplication(member, cfg)) {
    await interaction
      .followUp({
        content: 'Недостаточно прав для одобрения заявки на вступление.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  const ch = interaction.channel;
  if (!ch?.isThread() || ch.id !== threadId || !isCandidateApplicationThread(ch, cfg)) {
    await interaction
      .followUp({ content: 'Ветка заявки не найдена.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const positionRoleId = interaction.values[0]?.trim();
  if (!positionRoleId) {
    await interaction
      .followUp({ content: 'Выберите должность.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const allow = new Set(
    (cfg.positionRoleIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  if (!allow.has(positionRoleId)) {
    await interaction
      .followUp({
        content: 'Выбранная должность не из списка настроек.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  const requestId = await findCandidateRequestIdByThread(api, threadId);
  if (!requestId) {
    await interaction
      .followUp({
        content: 'Заявка уже обработана или не найдена.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  try {
    const res = await api.setStatus(requestId, 'approved', interaction.user.id, {
      positionRoleId,
    });
    if (res.discordRoleSync) {
      await applyDiscordRoleSync(interaction.guild, res.discordRoleSync);
    }
    await purgeCandidateThread(ch);
    await interaction
      .followUp({
        content: `Заявка одобрена. Выдана должность: <@&${positionRoleId}>.`,
        ephemeral: true,
      })
      .catch(() => {});
  } catch (e) {
    console.warn('candidate-application: approve', e);
    if (e instanceof ApiError && e.status === 409) {
      await interaction
        .followUp({ content: 'Заявка уже была обработана.', ephemeral: true })
        .catch(() => {});
      return;
    }
    const detail =
      e instanceof ApiError && e.message ? e.message : 'Попробуйте позже.';
    await interaction
      .followUp({
        content: `Не удалось одобрить заявку. ${detail}`,
        ephemeral: true,
      })
      .catch(() => {});
  }
}

export async function handleCandidateRejectButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    CANDIDATE_REJECT_BUTTON_PREFIX,
    interaction.customId,
  );
  if (!threadId) return;

  if (!interaction.guild || !interaction.member) {
    await interaction
      .reply({ content: 'Не удалось обработать запрос.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canModerateCandidateApplication(member, cfg)) {
    await interaction
      .reply({
        content: 'Недостаточно прав для отклонения заявки на вступление.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  const ch = interaction.channel;
  if (!ch?.isThread() || ch.id !== threadId) {
    await interaction
      .reply({ content: 'Кнопка недействительна для этой ветки.', ephemeral: true })
      .catch(() => {});
    return;
  }

  if (!isCandidateApplicationThread(ch, cfg)) {
    await interaction
      .reply({ content: 'Эта кнопка здесь не действует.', ephemeral: true })
      .catch(() => {});
    return;
  }

  await interaction.showModal(buildCandidateRejectModal(threadId)).catch(() => {});
}

async function purgeCandidateThread(thread: ThreadChannel): Promise<void> {
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
    console.warn('purge candidate thread', e);
  }
  try {
    await thread.delete();
  } catch (e) {
    console.warn('delete candidate thread', e);
  }
}

async function dmApplicantAboutRejection(
  applicant: User,
  reason: string,
): Promise<boolean> {
  const text = reason.trim() || 'Причина не указана.';
  try {
    await applicant.send({
      content: [
        'Ваша **заявка на вступление** отклонена.',
        '',
        '**Причина:**',
        text,
        '',
        '_При необходимости вы можете подать новую заявку через панель приветствия._',
      ].join('\n'),
    });
    return true;
  } catch (e) {
    console.warn('Не удалось отправить ЛС об отклонении заявки кандидата', e);
    return false;
  }
}

export async function handleCandidateRejectModalSubmit(
  interaction: ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    CANDIDATE_REJECT_MODAL_PREFIX,
    interaction.customId,
  );
  if (!threadId) return;

  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guild || !interaction.member) {
    await interaction.editReply({ content: 'Не удалось обработать запрос.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canModerateCandidateApplication(member, cfg)) {
    await interaction.editReply({
      content: 'Недостаточно прав для отклонения заявки.',
    });
    return;
  }

  const ch = interaction.channel;
  if (!ch?.isThread() || ch.id !== threadId || !isCandidateApplicationThread(ch, cfg)) {
    await interaction.editReply({ content: 'Ветка заявки не найдена.' });
    return;
  }

  const reason = interaction.fields.getTextInputValue(FIELD_REJECT_REASON).trim();
  if (!reason) {
    await interaction.editReply({ content: 'Укажите причину отклонения.' });
    return;
  }

  const requestId = await findCandidateRequestIdByThread(api, threadId);
  if (!requestId) {
    await interaction.editReply({
      content: 'Заявка уже обработана или не найдена.',
    });
    return;
  }

  let applicantId: string | null = null;
  try {
    const messages = await ch.messages.fetch({ limit: 20 });
    for (const msg of messages.values()) {
      applicantId = applicantIdFromCandidateMessage(msg);
      if (applicantId) break;
    }
  } catch {
    /* fallback из API */
  }

  const pending = await api.getPendingRequests();
  const row = pending.find((r) => r.id === requestId);
  if (!row) {
    await interaction.editReply({
      content: 'Заявка уже обработана или не найдена.',
    });
    return;
  }

  if (!applicantId) {
    const data = (row.payload as { data?: Record<string, unknown> } | undefined)
      ?.data;
    const aid = data?.applicantDiscordUserId;
    if (typeof aid === 'string' && aid.trim()) applicantId = aid.trim();
  }

  try {
    await api.setStatus(requestId, 'rejected');

    let dmOk = false;
    if (applicantId) {
      const applicant = await interaction.client.users
        .fetch(applicantId)
        .catch(() => null);
      if (applicant) {
        dmOk = await dmApplicantAboutRejection(applicant, reason);
      }
    }

    await purgeCandidateThread(ch);

    await interaction.editReply({
      content: dmOk
        ? 'Заявка отклонена. Заявителю отправлено личное сообщение с причиной.'
        : 'Заявка отклонена. Не удалось отправить ЛС заявителю (возможно, закрыты личные сообщения).',
    });
  } catch (e) {
    console.warn('candidate-application: reject', e);
    if (e instanceof ApiError && e.status === 409) {
      await interaction.editReply({ content: 'Заявка уже была обработана.' });
      return;
    }
    await interaction.editReply({
      content: 'Не удалось отклонить заявку. Попробуйте позже.',
    });
  }
}

export function buildCandidateApplicationModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(CANDIDATE_APPLICATION_MODAL_ID)
    .setTitle('Заявка на вступление')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_FULL_NAME)
          .setLabel('ФИО')
          .setPlaceholder('Как на сервере RED')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(128),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_AGE)
          .setLabel('Возраст')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(8),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_HOURS)
          .setLabel('Часов в неделю')
          .setPlaceholder('Сколько планируете играть')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_EXPERIENCE)
          .setLabel('Опыт в Arma 3')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

function parseModalForm(interaction: ModalSubmitInteraction): CandidateApplicationForm {
  return {
    fullName: interaction.fields.getTextInputValue(FIELD_FULL_NAME).trim(),
    age: interaction.fields.getTextInputValue(FIELD_AGE).trim(),
    hoursPerWeek: interaction.fields.getTextInputValue(FIELD_HOURS).trim(),
    armaExperience: interaction.fields.getTextInputValue(FIELD_EXPERIENCE).trim(),
  };
}

function validateWelcomeCandidateClick(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): string | null {
  const welcomeCh = cfg.welcomeChannelId?.trim();
  const guildId = cfg.guildId?.trim();

  if (!welcomeCh) {
    return 'Канал приветствия не настроен (обратитесь к техадмину).';
  }
  if (guildId && interaction.guildId !== guildId) {
    return 'Эта кнопка на другом сервере не действует.';
  }
  if (interaction.channelId !== welcomeCh) {
    return 'Эта кнопка здесь не действует.';
  }
  if (!interaction.guild || !interaction.member) {
    return 'Не удалось обработать запрос.';
  }
  return null;
}

export async function handleWelcomeCandidateButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (interaction.customId !== WELCOME_CANDIDATE_BUTTON_ID) return;

  const clickErr = validateWelcomeCandidateClick(interaction, cfg);
  if (clickErr) {
    await interaction.reply({ content: clickErr, ephemeral: true }).catch(() => {});
    return;
  }

  if (!isCandidateApplicationConfigured(cfg)) {
    await interaction
      .reply({
        content:
          'Заявки на вступление не настроены на сервере (канал, роли модераторов или должности — обратитесь к техадмину).',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);

  if (memberHasPositionRole(member, cfg)) {
    await interaction
      .reply({
        content: 'У вас уже есть должность в подразделении — повторная заявка не нужна.',
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  await interaction.showModal(buildCandidateApplicationModal()).catch(() => {});
}

export function buildCandidateModerationMessage(params: {
  applicantDiscordUserId: string;
  form: CandidateApplicationForm;
}): string {
  const { applicantDiscordUserId, form } = params;
  const experience = clampLine(form.armaExperience, 1200);

  return [
    '📋 **Заявка на вступление**',
    '',
    `👤 Заявитель: ${discordMention(applicantDiscordUserId)}`,
    `📛 ФИО: ${clampLine(form.fullName, 120)}`,
    `🎂 Возраст: ${clampLine(form.age, 16)}`,
    `⏱ Часов в неделю: ${clampLine(form.hoursPerWeek, 64)}`,
    '',
    '🎮 **Опыт в Arma 3**',
    experience,
    '',
    '_Кнопка «Одобрить» — выбрать должность. Кнопка «Отклонить» — указать причину и уведомить заявителя в ЛС._',
  ].join('\n');
}

async function openPrivateCandidateThread(
  guild: Guild,
  cfg: VpBotConfigFromApi,
  applicantId: string,
  threadTitle: string,
): Promise<{ thread: ThreadChannel; channelPlaceholder: Message }> {
  const parentId = cfg.candidateApplicationChannelId?.trim();
  if (!parentId) {
    throw new Error(
      'В настройках бота не задан канал заявок на вступление (candidateApplicationChannelId).',
    );
  }
  const parent = await guild.channels.fetch(parentId);
  if (!parent?.isTextBased() || parent.isDMBased()) {
    throw new Error('Канал заявок на вступление должен быть текстовым каналом на сервере.');
  }
  if (
    parent.type === ChannelType.GuildVoice ||
    parent.type === ChannelType.GuildStageVoice
  ) {
    throw new Error('Канал заявок на вступление не может быть голосовым или сценой.');
  }
  if (!('threads' in parent)) {
    throw new Error(
      'Этот тип канала не поддерживает ветки (нужен текстовый канал или объявления).',
    );
  }
  const threadParent = parent as TextChannel;
  const name =
    threadTitle.replace(/[^\w\u0400-\u04FF\s—–\-]/g, '').trim().slice(0, 100) ||
    'Вступление';

  const channelPlaceholder = await threadParent.send({
    content: 'Создание ветки заявки на вступление…',
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
    await thread.members.add(applicantId);
  } catch {
    /* уже в ветке или нет прав */
  }

  const approverRoleIds = (cfg.candidateApplicationApproverRoleIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  await inviteMembersByRoles(thread, guild, approverRoleIds, new Set([applicantId]));

  return { thread, channelPlaceholder };
}

async function dmApplicantAboutCandidateThread(
  user: User,
  thread: ThreadChannel,
): Promise<void> {
  const threadUrl = thread.url;
  try {
    await user.send({
      content: [
        'Ваша **заявка на вступление** принята.',
        '',
        'Вся переписка с командованием — в **вашей приватной ветке**:',
        threadUrl,
        '',
        '_Если ссылка не открывается, откройте канал заявок на вступление и найдите ветку в списке сверху._',
        '',
        '_Вы будете получать личные сообщения при новых ответах в ветке._',
      ].join('\n'),
    });
  } catch (e) {
    console.warn(
      'Не удалось отправить ЛС заявителю кандидата (включите ЛС от участников сервера):',
      e,
    );
    await thread
      .send({
        content: `${user.toString()} Не удалось отправить вам **личное сообщение** со ссылкой на ветку (закрыты ЛС от участников сервера). Вся информация по заявке — **в этой ветке** выше.`,
        allowedMentions: { users: [user.id] },
      })
      .catch(() => {});
  }
}

export async function dmApplicantAboutNewThreadMessage(
  applicant: User,
  thread: ThreadChannel,
  authorLabel: string,
  messagePreview: string,
): Promise<void> {
  const preview =
    messagePreview.length > 300
      ? `${messagePreview.slice(0, 299)}…`
      : messagePreview;
  try {
    await applicant.send({
      content: [
        `**Новое сообщение** в вашей ветке заявки на вступление от ${authorLabel}:`,
        '',
        preview || '_(пустое сообщение или вложение)_',
        '',
        thread.url,
      ].join('\n'),
    });
  } catch (e) {
    console.warn('Не удалось уведомить заявителя о сообщении в ветке кандидата', e);
    await thread
      .send({
        content: `${applicant.toString()} Не удалось отправить **личное сообщение** о новом ответе (закрыты ЛС). Прочитайте сообщение выше в ветке.`,
        allowedMentions: { users: [applicant.id] },
      })
      .catch(() => {});
  }
}

export async function handleCandidateApplicationModalSubmit(
  interaction: ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  if (interaction.customId !== CANDIDATE_APPLICATION_MODAL_ID) return;

  await interaction.deferReply({ ephemeral: true });

  if (!isCandidateApplicationConfigured(cfg)) {
    await interaction.editReply({
      content:
        'Заявки на вступление не настроены на сервере (обратитесь к техадмину).',
    });
    return;
  }

  if (!interaction.guild) {
    await interaction.editReply({ content: 'Не удалось обработать запрос.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (memberHasPositionRole(member, cfg)) {
    await interaction.editReply({
      content: 'У вас уже есть должность в подразделении — повторная заявка не нужна.',
    });
    return;
  }

  const form = parseModalForm(interaction);
  if (!form.fullName || !form.age || !form.hoursPerWeek || !form.armaExperience) {
    await interaction.editReply({
      content: 'Заполните все поля формы.',
    });
    return;
  }

  await setMemberNicknameFromFullName(member, form.fullName);

  const applicantId = interaction.user.id;
  const displayName = member.displayName;
  const threadTitle = `Вступление — ${form.fullName}`.slice(0, 100);

  let thread: ThreadChannel | null = null;
  let channelPlaceholder: Message | null = null;

  try {
    const opened = await openPrivateCandidateThread(
      interaction.guild,
      cfg,
      applicantId,
      threadTitle,
    );
    thread = opened.thread;
    channelPlaceholder = opened.channelPlaceholder;

    await api.createRequest({
      type: 'candidate_application',
      payload: {
        applicantDiscordUserId: applicantId,
        fullName: form.fullName,
        age: form.age,
        hoursPerWeek: form.hoursPerWeek,
        armaExperience: form.armaExperience,
        threadId: thread.id,
        discordDisplayName: displayName,
      },
    });

    const content = buildCandidateModerationMessage({
      applicantDiscordUserId: applicantId,
      form,
    });

    const reply = await thread.send({
      content,
      components: [buildCandidateModerationButtonRow(thread.id)],
      allowedMentions: { users: [applicantId] },
    });
    try {
      await reply.react(EMOJI_PENDING);
    } catch (e) {
      console.warn('react on candidate application message', e);
    }

    await dmApplicantAboutCandidateThread(interaction.user, thread);

    await interaction.editReply({
      content:
        'Заявка отправлена. Проверьте **личные сообщения** — там ссылка на приватную ветку с заявкой.',
    });
  } catch (e) {
    console.warn('candidate-application: submit', e);
    if (thread) {
      await thread.delete().catch(() => {});
    }
    const msg =
      e instanceof ApiError && e.status === 409
        ? 'У вас уже есть необработанная заявка на вступление.'
        : e instanceof Error
          ? e.message
          : 'Не удалось создать заявку. Попробуйте позже или обратитесь к администрации.';
    await interaction.editReply({ content: msg });
  } finally {
    if (channelPlaceholder) {
      await channelPlaceholder.delete().catch(() => {});
    }
  }
}

export { purgeCandidateThread };
