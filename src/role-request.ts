import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
  type User,
} from 'discord.js';
import type { VpBotConfigFromApi } from './config';
import type { createApiClient } from './api';
import { ApiError } from './api';
import {
  openPrivateApplicationThread,
  purgeAndDeleteThread,
} from './thread-helpers';

export const ACTIONS_ROLE_REQUEST_BUTTON_ID = 'vp_actions_role_request';
/** @deprecated alias — старые сообщения welcome */
export const WELCOME_ROLE_REQUEST_BUTTON_ID = ACTIONS_ROLE_REQUEST_BUTTON_ID;
export const ROLE_REQUEST_SUBMIT_PREFIX = 'vp_role_req_submit:';
export const ROLE_REQUEST_POSITION_SELECT_PREFIX = 'vp_role_req_pos:';
export const ROLE_REQUEST_OTHER_SELECT_PREFIX = 'vp_role_req_other:';
export const ROLE_REQUEST_REJECT_BUTTON_PREFIX = 'vp_role_req_reject:';
export const ROLE_REQUEST_REJECT_MODAL_PREFIX = 'vp_role_req_reject_modal:';

const FIELD_REJECT_REASON = 'reject_reason';
const EMOJI_PENDING = '⏳';

type ApiClient = ReturnType<typeof createApiClient>;

type RoleFormState = {
  positionRoleId: string | null;
  otherRoleIds: string[];
};

/** Состояние ephemeral-формы: userId → выбор. */
const formStateByUser = new Map<string, RoleFormState>();

function clampLine(value: string, max = 900): string {
  const t = value.trim();
  if (!t) return '—';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function discordMention(userId: string): string {
  return `<@${userId}>`;
}

function roleLabel(guild: Guild, roleId: string): string {
  const role = guild.roles.cache.get(roleId);
  const name = role?.name?.trim() || roleId;
  return name.slice(0, 100);
}

export function isRoleRequestConfigured(cfg: VpBotConfigFromApi): boolean {
  const ch = cfg.roleRequestChannelId?.trim();
  const approvers = cfg.roleRequestApproverRoleIds ?? [];
  const positions = cfg.positionRoleIds ?? [];
  const others = cfg.otherRoleIds ?? [];
  return Boolean(ch && approvers.length && (positions.length || others.length));
}

export function isRoleRequestThread(
  channel: { isThread(): boolean; parentId: string | null },
  cfg: VpBotConfigFromApi,
): boolean {
  const parentId = cfg.roleRequestChannelId?.trim();
  if (!parentId) return false;
  return channel.isThread() && channel.parentId === parentId;
}

export function isRoleRequestContext(
  message: Message,
  cfg: VpBotConfigFromApi,
): boolean {
  const chId = cfg.roleRequestChannelId?.trim();
  if (!chId) return false;
  const ch = message.channel;
  if (ch.id === chId) return true;
  if (!ch.isThread()) return false;
  return ch.parentId === chId;
}

export function canModerateRoleRequest(
  member: GuildMember,
  cfg: VpBotConfigFromApi,
): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return (cfg.roleRequestApproverRoleIds ?? []).some((id) =>
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

export async function findRoleRequestIdByThread(
  api: ApiClient,
  threadId: string,
): Promise<string | null> {
  const rows = await api.getPendingRequests();
  for (const row of rows) {
    const p = row.payload as {
      operation?: string;
      data?: Record<string, unknown>;
    };
    if (p.operation !== 'decorative_role_request') continue;
    const tid = p.data?.threadId;
    if (typeof tid === 'string' && tid.trim() === threadId) return row.id;
  }
  return null;
}

function getOrInitState(userId: string): RoleFormState {
  let s = formStateByUser.get(userId);
  if (!s) {
    s = { positionRoleId: null, otherRoleIds: [] };
    formStateByUser.set(userId, s);
  }
  return s;
}

function buildRoleFormComponents(
  guild: Guild,
  cfg: VpBotConfigFromApi,
  userId: string,
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  const positions = (cfg.positionRoleIds ?? []).map((id) => id.trim()).filter(Boolean).slice(0, 25);
  const others = (cfg.otherRoleIds ?? []).map((id) => id.trim()).filter(Boolean).slice(0, 25);

  if (positions.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${ROLE_REQUEST_POSITION_SELECT_PREFIX}${userId}`)
          .setPlaceholder('Должность (необязательно, одна)')
          .setMinValues(0)
          .setMaxValues(1)
          .addOptions(
            positions.map((id) => ({
              label: roleLabel(guild, id),
              value: id,
            })),
          ),
      ),
    );
  }

  if (others.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${ROLE_REQUEST_OTHER_SELECT_PREFIX}${userId}`)
          .setPlaceholder('Прочее (можно несколько)')
          .setMinValues(0)
          .setMaxValues(Math.min(25, others.length))
          .addOptions(
            others.map((id) => ({
              label: roleLabel(guild, id),
              value: id,
            })),
          ),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ROLE_REQUEST_SUBMIT_PREFIX}${userId}`)
        .setLabel('Отправить заявку')
        .setStyle(ButtonStyle.Primary),
    ),
  );

  return rows;
}

export async function handleWelcomeRoleRequestButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (
    interaction.customId !== ACTIONS_ROLE_REQUEST_BUTTON_ID &&
    interaction.customId !== 'vp_welcome_role_request'
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
  if (!interaction.guild) {
    await interaction
      .reply({
        content: 'Не удалось обработать запрос.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  if (!isRoleRequestConfigured(cfg)) {
    await interaction
      .reply({
        content:
          'Заявки на роли не настроены (канал, модераторы или списки ролей — обратитесь к техадмину).',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  formStateByUser.set(interaction.user.id, {
    positionRoleId: null,
    otherRoleIds: [],
  });

  await interaction
    .reply({
      content:
        'Выберите **должность** (не больше одной) и/или роли из **Прочее**, затем нажмите «Отправить заявку».',
      components: buildRoleFormComponents(
        interaction.guild,
        cfg,
        interaction.user.id,
      ),
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
}

export async function handleRoleRequestSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  const posPrefix = ROLE_REQUEST_POSITION_SELECT_PREFIX;
  const otherPrefix = ROLE_REQUEST_OTHER_SELECT_PREFIX;

  if (interaction.customId.startsWith(posPrefix)) {
    const owner = interaction.customId.slice(posPrefix.length);
    if (owner !== userId) {
      await interaction
        .reply({
          content: 'Эта форма принадлежит другому участнику.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    const state = getOrInitState(userId);
    state.positionRoleId = interaction.values[0]?.trim() || null;
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  if (interaction.customId.startsWith(otherPrefix)) {
    const owner = interaction.customId.slice(otherPrefix.length);
    if (owner !== userId) {
      await interaction
        .reply({
          content: 'Эта форма принадлежит другому участнику.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }
    const state = getOrInitState(userId);
    state.otherRoleIds = interaction.values.map((v) => v.trim()).filter(Boolean);
    await interaction.deferUpdate().catch(() => {});
  }
}

function buildRoleRejectButtonRow(
  threadId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ROLE_REQUEST_REJECT_BUTTON_PREFIX}${threadId}`)
      .setLabel('Отклонить')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildRoleRejectModal(threadId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${ROLE_REQUEST_REJECT_MODAL_PREFIX}${threadId}`)
    .setTitle('Отклонение заявки на роли')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_REJECT_REASON)
          .setLabel('Причина отклонения')
          .setPlaceholder('Сообщение уйдёт заявителю в ЛС')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

function buildRoleModerationMessage(params: {
  applicantDiscordUserId: string;
  guild: Guild;
  positionRoleId: string | null;
  otherRoleIds: string[];
}): string {
  const pos =
    params.positionRoleId != null
      ? `**${roleLabel(params.guild, params.positionRoleId)}** (\`${params.positionRoleId}\`)`
      : '—';
  const others =
    params.otherRoleIds.length > 0
      ? params.otherRoleIds
          .map((id) => `• **${roleLabel(params.guild, id)}** (\`${id}\`)`)
          .join('\n')
      : '—';

  return [
    '🎭 **Заявка на декоративные роли**',
    '',
    `👤 Заявитель: ${discordMention(params.applicantDiscordUserId)}`,
    `👔 Должность: ${pos}`,
    '',
    '📦 **Прочее**',
    others,
    '',
    '_Реакция ✅ — одобрить. Кнопка «Отклонить» — указать причину._',
  ].join('\n');
}

export async function handleRoleRequestSubmit(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  const userIdFromId = threadIdFromPrefixedCustomId(
    ROLE_REQUEST_SUBMIT_PREFIX,
    interaction.customId,
  );
  if (!userIdFromId) return;
  if (userIdFromId !== interaction.user.id) {
    await interaction
      .reply({
        content: 'Эта форма принадлежит другому участнику.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isRoleRequestConfigured(cfg) || !interaction.guild) {
    await interaction.editReply({
      content: 'Заявки на роли не настроены.',
    });
    return;
  }

  const state = formStateByUser.get(interaction.user.id) ?? {
    positionRoleId: null,
    otherRoleIds: [],
  };
  if (!state.positionRoleId && state.otherRoleIds.length === 0) {
    await interaction.editReply({
      content: 'Выберите должность и/или хотя бы одну роль из «Прочее».',
    });
    return;
  }

  const applicantId = interaction.user.id;
  const member = await interaction.guild.members.fetch(applicantId);
  const displayName = member.displayName;
  const threadTitle = `Роли — ${displayName}`.slice(0, 100);

  let thread: ThreadChannel | null = null;
  let channelPlaceholder: Message | null = null;

  try {
    const opened = await openPrivateApplicationThread({
      guild: interaction.guild,
      parentChannelId: cfg.roleRequestChannelId!.trim(),
      applicantId,
      approverRoleIds: cfg.roleRequestApproverRoleIds ?? [],
      threadTitle,
      placeholderContent: 'Создание ветки заявки на роли…',
    });
    thread = opened.thread;
    channelPlaceholder = opened.channelPlaceholder;

    await api.createRequest({
      type: 'decorative_role_request',
      payload: {
        applicantDiscordUserId: applicantId,
        threadId: thread.id,
        discordDisplayName: displayName,
        positionRoleId: state.positionRoleId,
        otherRoleIds: state.otherRoleIds,
      },
    });

    const content = buildRoleModerationMessage({
      applicantDiscordUserId: applicantId,
      guild: interaction.guild,
      positionRoleId: state.positionRoleId,
      otherRoleIds: state.otherRoleIds,
    });

    const reply = await thread.send({
      content,
      components: [buildRoleRejectButtonRow(thread.id)],
      allowedMentions: { users: [applicantId] },
    });
    try {
      await reply.react(EMOJI_PENDING);
      await reply.react('✅');
    } catch (e) {
      console.warn('react on role request message', e);
    }

    formStateByUser.delete(applicantId);

    await interaction.editReply({
      content:
        'Заявка отправлена. Дождитесь решения модератора в приватной ветке.',
    });
  } catch (e) {
    console.warn('role-request: submit', e);
    if (thread) {
      await thread.delete().catch(() => {});
    }
    const msg =
      e instanceof ApiError && e.status === 409
        ? 'У вас уже есть необработанная заявка на роли.'
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

export async function handleRoleRequestRejectButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    ROLE_REQUEST_REJECT_BUTTON_PREFIX,
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
  if (!canModerateRoleRequest(member, cfg)) {
    await interaction
      .reply({
        content: 'Недостаточно прав для отклонения заявки.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const ch = interaction.channel;
  if (!ch?.isThread() || ch.id !== threadId || !isRoleRequestThread(ch, cfg)) {
    await interaction
      .reply({
        content: 'Кнопка недействительна для этой ветки.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  await interaction.showModal(buildRoleRejectModal(threadId)).catch(() => {});
}

export async function handleRoleRequestRejectModalSubmit(
  interaction: ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  const threadId = threadIdFromPrefixedCustomId(
    ROLE_REQUEST_REJECT_MODAL_PREFIX,
    interaction.customId,
  );
  if (!threadId) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guild || !interaction.member) {
    await interaction.editReply({ content: 'Не удалось обработать запрос.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!canModerateRoleRequest(member, cfg)) {
    await interaction.editReply({
      content: 'Недостаточно прав для отклонения заявки.',
    });
    return;
  }

  const ch = interaction.channel;
  if (
    !ch?.isThread() ||
    ch.id !== threadId ||
    !isRoleRequestThread(ch, cfg)
  ) {
    await interaction.editReply({ content: 'Ветка заявки не найдена.' });
    return;
  }

  const reason = interaction.fields.getTextInputValue(FIELD_REJECT_REASON).trim();
  if (!reason) {
    await interaction.editReply({ content: 'Укажите причину отклонения.' });
    return;
  }

  const requestId = await findRoleRequestIdByThread(api, threadId);
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
        dmOk = await dmRoleRejection(applicant, reason);
      }
    }

    await purgeAndDeleteThread(ch);

    await interaction.editReply({
      content: dmOk
        ? 'Заявка отклонена. Заявителю отправлено ЛС.'
        : 'Заявка отклонена. Не удалось отправить ЛС заявителю.',
    });
  } catch (e) {
    console.warn('role-request: reject', e);
    if (e instanceof ApiError && e.status === 409) {
      await interaction.editReply({ content: 'Заявка уже была обработана.' });
      return;
    }
    await interaction.editReply({
      content: 'Не удалось отклонить заявку. Попробуйте позже.',
    });
  }
}

async function dmRoleRejection(applicant: User, reason: string): Promise<boolean> {
  try {
    await applicant.send({
      content: [
        'Ваша **заявка на роли** отклонена.',
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

export { purgeAndDeleteThread as purgeRoleRequestThread };
