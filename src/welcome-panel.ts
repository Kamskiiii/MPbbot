import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { createApiClient } from './api';
import type { VpBotConfigFromApi } from './config';
import { setMemberNicknameFromFullName } from './nickname';

export const WELCOME_GUEST_BUTTON_ID = 'vp_welcome_guest_role';
export const WELCOME_CANDIDATE_BUTTON_ID = 'vp_welcome_candidate_role';
export const VP_GUEST_APPLICATION_MODAL_ID = 'vp_welcome_guest_modal';
const FIELD_FULL_NAME = 'full_name';

type ApiClient = ReturnType<typeof createApiClient>;

const DEFAULT_WELCOME_TITLE = 'Добро пожаловать';
const DEFAULT_WELCOME_DESCRIPTION = [
  'Нажмите кнопки ниже, чтобы получить нужные роли и доступ к каналам сервера.',
  '',
  '_Если кнопки не работают, обратитесь к администрации._',
].join('\n');

function welcomeEmbed(cfg: VpBotConfigFromApi): EmbedBuilder {
  const title = cfg.welcomePanelTitle?.trim() || DEFAULT_WELCOME_TITLE;
  const description =
    cfg.welcomePanelDescription?.trim() || DEFAULT_WELCOME_DESCRIPTION;
  const thumbnailUrl = cfg.welcomePanelThumbnailUrl?.trim();
  const imageUrl = cfg.welcomePanelImageUrl?.trim();

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x57f287);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

function welcomeComponents(cfg: VpBotConfigFromApi) {
  const guestId = cfg.guestRoleId?.trim();
  const candidateId = cfg.candidateRoleId?.trim();
  const buttons: ButtonBuilder[] = [];
  if (guestId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(WELCOME_GUEST_BUTTON_ID)
        .setLabel('Получить роль гостя')
        .setStyle(ButtonStyle.Success),
    );
  }
  if (candidateId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(WELCOME_CANDIDATE_BUTTON_ID)
        .setLabel('Получить роль кандидата')
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (buttons.length === 0) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

function buildGuestFullNameModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(VP_GUEST_APPLICATION_MODAL_ID)
    .setTitle('Роль гостя')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_FULL_NAME)
          .setLabel('ФИО / ник на сервере RED')
          .setPlaceholder('Как на сервере RED')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(128),
      ),
    );
}

/** Публикует или обновляет embed с кнопками; сохраняет id сообщения в API. */
export async function syncWelcomePanel(
  client: Client,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  const chId = cfg.welcomeChannelId?.trim();
  const guestId = cfg.guestRoleId?.trim();
  const candidateId = cfg.candidateRoleId?.trim();
  if (!chId || (!guestId && !candidateId)) return;

  const components = welcomeComponents(cfg);
  if (components.length === 0) return;

  const botId = client.user?.id;
  if (!botId) return;

  const raw = await client.channels.fetch(chId).catch(() => null);
  if (!raw || raw.type !== ChannelType.GuildText) {
    console.warn(
      'welcome-panel: канал welcomeChannelId должен быть обычным текстовым (#text)',
    );
    return;
  }

  if (cfg.guildId?.trim() && raw.guildId !== cfg.guildId.trim()) {
    console.warn('welcome-panel: канал не принадлежит указанному guildId');
    return;
  }

  const payload = {
    embeds: [welcomeEmbed(cfg)],
    components,
  };

  const tryEdit = async (messageId: string): Promise<boolean> => {
    const msg = await raw.messages.fetch(messageId).catch(() => null);
    if (!msg || msg.author.id !== botId) return false;
    await msg.edit(payload);
    return true;
  };

  const storedId = cfg.welcomePanelMessageId?.trim();
  if (storedId && (await tryEdit(storedId))) {
    return;
  }

  const sent = await raw.send(payload);
  await api.setWelcomePanelMessageId(sent.id);
}

function validateWelcomeGuestClick(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): string | null {
  const welcomeCh = cfg.welcomeChannelId?.trim();
  const guestRoleId = cfg.guestRoleId?.trim();
  const guildId = cfg.guildId?.trim();

  if (!welcomeCh || !guestRoleId) {
    return 'Панель приветствия не настроена (обратитесь к администрации).';
  }
  if (guildId && interaction.guildId !== guildId) {
    return 'Эта кнопка на другом сервере не действует.';
  }
  if (interaction.channelId !== welcomeCh) {
    return 'Эта кнопка здесь не действует.';
  }
  if (!interaction.guild || !interaction.member) {
    return 'Не удалось определить участника сервера.';
  }
  return null;
}

export async function handleWelcomeGuestButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (interaction.customId !== WELCOME_GUEST_BUTTON_ID) return;

  const clickErr = validateWelcomeGuestClick(interaction, cfg);
  if (clickErr) {
    await interaction
      .reply({ content: clickErr, flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  const guestRoleId = cfg.guestRoleId!.trim();
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  if (member.roles.cache.has(guestRoleId)) {
    await interaction
      .reply({ content: 'У вас уже есть роль гостя.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  await interaction.showModal(buildGuestFullNameModal()).catch(() => {});
}

export async function handleWelcomeGuestModalSubmit(
  interaction: ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (interaction.customId !== VP_GUEST_APPLICATION_MODAL_ID) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const welcomeCh = cfg.welcomeChannelId?.trim();
  const guestRoleId = cfg.guestRoleId?.trim();
  const guildId = cfg.guildId?.trim();

  if (!welcomeCh || !guestRoleId) {
    await interaction.editReply({
      content: 'Панель приветствия не настроена (обратитесь к администрации).',
    });
    return;
  }
  if (guildId && interaction.guildId !== guildId) {
    await interaction.editReply({
      content: 'Эта форма на другом сервере не действует.',
    });
    return;
  }
  if (!interaction.guild) {
    await interaction.editReply({
      content: 'Не удалось обработать запрос.',
    });
    return;
  }

  const fullName = interaction.fields.getTextInputValue(FIELD_FULL_NAME).trim();
  if (!fullName) {
    await interaction.editReply({
      content: 'Укажите ФИО / ник на сервере RED.',
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (member.roles.cache.has(guestRoleId)) {
    await interaction.editReply({ content: 'У вас уже есть роль гостя.' });
    return;
  }

  try {
    await setMemberNicknameFromFullName(member, fullName);
    await member.roles.add(
      guestRoleId,
      'Кнопка «Получить роль гостя» (агент ВП)',
    );
    await interaction.editReply({
      content: 'Роль **гостя** выдана. Добро пожаловать!',
    });
  } catch (e) {
    console.warn('welcome-guest: выдача роли', e);
    await interaction.editReply({
      content:
        'Не удалось выдать роль. Проверьте, что у бота есть право **Управлять ролями** и роль бота **выше** роли гостя в списке.',
    });
  }
}
