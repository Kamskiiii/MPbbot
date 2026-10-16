import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
} from 'discord.js';
import type { createApiClient } from './api';
import type { VpBotConfigFromApi } from './config';
import { ACTIONS_LEAVE_BUTTON_ID } from './leave-request';
import { ACTIONS_ROLE_REQUEST_BUTTON_ID } from './role-request';

type ApiClient = ReturnType<typeof createApiClient>;

const DEFAULT_TITLE = 'Заявки';
const DEFAULT_DESCRIPTION = [
  'Используйте кнопки ниже, чтобы подать заявку на роли или отпуск.',
  '',
  '_Модерация проходит в приватных ветках._',
].join('\n');

export function isActionsRoleRequestEnabled(cfg: VpBotConfigFromApi): boolean {
  return (
    Boolean(cfg.roleRequestChannelId?.trim()) &&
    (cfg.roleRequestApproverRoleIds ?? []).length > 0 &&
    ((cfg.positionRoleIds ?? []).length > 0 ||
      (cfg.otherRoleIds ?? []).length > 0)
  );
}

export function isActionsLeaveEnabled(cfg: VpBotConfigFromApi): boolean {
  return (
    Boolean(cfg.leaveRequestChannelId?.trim()) &&
    (cfg.leaveApproverRoleIds ?? []).length > 0
  );
}

function actionsEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(DEFAULT_TITLE)
    .setDescription(DEFAULT_DESCRIPTION)
    .setColor(0x5865f2);
}

function actionsComponents(cfg: VpBotConfigFromApi) {
  const buttons: ButtonBuilder[] = [];
  if (isActionsRoleRequestEnabled(cfg)) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(ACTIONS_ROLE_REQUEST_BUTTON_ID)
        .setLabel('Запрос ролей')
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (isActionsLeaveEnabled(cfg)) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(ACTIONS_LEAVE_BUTTON_ID)
        .setLabel('Заявка на отпуск')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (buttons.length === 0) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

/** Публикует или обновляет сообщение с кнопками ролей/отпуска. */
export async function syncActionsPanel(
  client: Client,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  const chId = cfg.actionsPanelChannelId?.trim();
  if (!chId) return;

  const components = actionsComponents(cfg);
  if (components.length === 0) {
    console.warn(
      'actions-panel: нет кнопок — настройте роли/отпуск (каналы, модераторы, списки ролей)',
    );
    return;
  }

  const botId = client.user?.id;
  if (!botId) return;

  const raw = await client.channels.fetch(chId).catch(() => null);
  if (!raw || raw.type !== ChannelType.GuildText) {
    console.warn(
      'actions-panel: actionsPanelChannelId должен быть обычным текстовым каналом',
    );
    return;
  }

  if (cfg.guildId?.trim() && raw.guildId !== cfg.guildId.trim()) {
    console.warn('actions-panel: канал не принадлежит указанному guildId');
    return;
  }

  const payload = {
    embeds: [actionsEmbed()],
    components,
  };

  const tryEdit = async (messageId: string): Promise<boolean> => {
    const msg = await raw.messages.fetch(messageId).catch(() => null);
    if (!msg || msg.author.id !== botId) return false;
    await msg.edit(payload);
    return true;
  };

  const storedId = cfg.actionsPanelMessageId?.trim();
  if (storedId && (await tryEdit(storedId))) {
    return;
  }

  const sent = await raw.send(payload);
  await api.setActionsPanelMessageId(sent.id);
}
