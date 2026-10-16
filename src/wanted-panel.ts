import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { createApiClient, WantedBoardPayload, WantedClass } from './api';
import { ApiError } from './api';
import type { VpBotConfigFromApi } from './config';

type ApiClient = ReturnType<typeof createApiClient>;

export const WANTED_ADD_BUTTON_ID = 'vp_wanted_add';
export const WANTED_REMOVE_BUTTON_ID = 'vp_wanted_remove';
export const WANTED_ADD_MODAL_ID = 'vp_wanted_add_modal';
export const WANTED_CLASS_SELECT_ID = 'vp_wanted_class';
export const WANTED_REMOVE_SELECT_PREFIX = 'vp_wanted_rm_sel:';
export const WANTED_REMOVE_PAGE_PREFIX = 'vp_wanted_rm_pg:';

const FIELD_FULL_NAME = 'full_name';
const FIELD_REASON = 'reason';
const FIELD_REWARD = 'reward';
const FIELD_STEAM = 'steam64';

const PAGE_SIZE = 25;
const PENDING_TTL_MS = 10 * 60 * 1000;
const DESC_LIMIT = 1800;

const CLASS_LABELS: Record<WantedClass, string> = {
  red: 'Красный',
  yellow: 'Жёлтый',
  blue: 'Синий (наблюдение)',
};

type PendingAdd = {
  fullName: string;
  reason: string;
  reward: number;
  steam64: string | null;
  at: number;
};

const pendingAdds = new Map<string, PendingAdd>();

function clamp(value: string, max: number): string {
  const t = value.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function classDot(c: WantedClass): string {
  if (c === 'yellow') return '🟡';
  if (c === 'blue') return '🔵';
  return '🔴';
}

export function buildWantedPanelPayload(board: WantedBoardPayload): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const lines: string[] = [];
  if (board.persons.length === 0) {
    lines.push('Сейчас никто не в розыске.');
  } else {
    for (const p of board.persons) {
      const mark = p.online ? '🟢' : '⚫';
      const extra = p.online && p.serverName && p.serverName !== p.fullName
        ? ` · на сервере: ${clamp(p.serverName, 80)}`
        : '';
      lines.push(
        `${mark} ${classDot(p.wantedClass)} **${clamp(p.fullName, 80)}** · ${CLASS_LABELS[p.wantedClass]} · ${p.reward.toLocaleString('ru-RU')}${extra}`,
      );
      if (p.reason.trim()) {
        lines.push(`*${clamp(p.reason, 180)}*`);
      }
    }
  }

  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > DESC_LIMIT && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  const used = chunks.slice(0, 2);
  const omitted = Math.max(0, chunks.length - used.length);
  if (omitted > 0 && used.length > 0) {
    used[used.length - 1] = `${used[used.length - 1]}\n…ещё записи в списке на сайте`;
  }

  const embeds = used.map((desc, i) => {
    const embed = new EmbedBuilder()
      .setColor(0x9b2d30)
      .setDescription(clamp(desc, DESC_LIMIT));
    if (i === 0) {
      embed.setTitle('Розыск ВП');
      const onlineCount = board.persons.filter((p) => p.online).length;
      embed.setFooter({
        text: `Активных: ${board.persons.length} · онлайн на сервере: ${onlineCount}`,
      });
    }
    return embed;
  });

  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(WANTED_ADD_BUTTON_ID)
        .setLabel('Добавить в розыск')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(WANTED_REMOVE_BUTTON_ID)
        .setLabel('Снять с розыска')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  return { embeds, components };
}

export async function syncWantedPanel(
  client: Client,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
  board: WantedBoardPayload,
): Promise<void> {
  const chId = (board.panelChannelId ?? cfg.wantedPanelChannelId)?.trim();
  if (!chId) return;

  const botId = client.user?.id;
  if (!botId) return;

  const raw = await client.channels.fetch(chId).catch(() => null);
  if (!raw || raw.type !== ChannelType.GuildText) {
    console.warn(
      'wanted-panel: wantedPanelChannelId должен быть обычным текстовым каналом',
    );
    return;
  }
  if (cfg.guildId?.trim() && raw.guildId !== cfg.guildId.trim()) {
    console.warn('wanted-panel: канал не принадлежит указанному guildId');
    return;
  }

  const payload = buildWantedPanelPayload(board);

  const tryEdit = async (messageId: string): Promise<boolean> => {
    const msg = await raw.messages.fetch(messageId).catch(() => null);
    if (!msg || msg.author.id !== botId) return false;
    await msg.edit(payload);
    return true;
  };

  const storedId = (board.panelMessageId ?? cfg.wantedPanelMessageId)?.trim();
  if (storedId && (await tryEdit(storedId))) {
    return;
  }

  const sent = await raw.send(payload);
  await api.setWantedPanelMessageId(sent.id);
}

export function canOperateWanted(
  member: GuildMember,
  cfg: VpBotConfigFromApi,
): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return (cfg.wantedOperatorRoleIds ?? []).some((id) =>
    member.roles.cache.has(id),
  );
}

function panelClickError(
  interaction: {
    guildId: string | null;
    channelId: string | null;
    guild: unknown;
    member: unknown;
  },
  cfg: VpBotConfigFromApi,
): string | null {
  const ch = cfg.wantedPanelChannelId?.trim();
  const guildId = cfg.guildId?.trim();
  if (!ch) return 'Панель розыска не настроена.';
  if (guildId && interaction.guildId !== guildId) {
    return 'Эта кнопка на другом сервере не действует.';
  }
  if (interaction.channelId !== ch) {
    return 'Эта кнопка здесь не действует.';
  }
  if (!interaction.guild || !interaction.member) {
    return 'Не удалось определить участника сервера.';
  }
  return null;
}

async function requireOperator(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
): Promise<GuildMember | null> {
  const clickErr = panelClickError(interaction, cfg);
  if (clickErr) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: clickErr }).catch(() => {});
    } else {
      await interaction
        .reply({ content: clickErr, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    return null;
  }
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  if (!canOperateWanted(member, cfg)) {
    const msg = 'Недостаточно прав: нужны роли операторов розыска.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg }).catch(() => {});
    } else {
      await interaction
        .reply({ content: msg, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    return null;
  }
  return member;
}

function buildAddModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(WANTED_ADD_MODAL_ID)
    .setTitle('Добавить в розыск')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_FULL_NAME)
          .setLabel('ФИО / ник')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(256),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_REASON)
          .setLabel('Причина')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_REWARD)
          .setLabel('Награда (число)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setValue('0'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(FIELD_STEAM)
          .setLabel('Steam64 (необязательно)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(32),
      ),
    );
}

function takePending(userId: string): PendingAdd | null {
  const row = pendingAdds.get(userId);
  if (!row) return null;
  if (Date.now() - row.at > PENDING_TTL_MS) {
    pendingAdds.delete(userId);
    return null;
  }
  pendingAdds.delete(userId);
  return row;
}

function removeSelectPage(
  board: WantedBoardPayload,
  page: number,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const persons = board.persons;
  const maxPage = Math.max(0, Math.ceil(persons.length / PAGE_SIZE) - 1);
  const p = Math.min(Math.max(0, page), maxPage);
  const slice = persons.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${WANTED_REMOVE_SELECT_PREFIX}${p}`)
    .setPlaceholder(
      persons.length === 0
        ? 'Список пуст'
        : `Кого снять (${p + 1}/${maxPage + 1})`,
    )
    .setDisabled(slice.length === 0)
    .addOptions(
      slice.length === 0
        ? [{ label: 'Никого нет', value: 'none' }]
        : slice.map((person) => ({
            label: clamp(person.fullName, 100),
            value: person.id,
            description: clamp(
              `${CLASS_LABELS[person.wantedClass]} · ${person.online ? 'онлайн' : 'офлайн'}`,
              100,
            ),
          })),
    );
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select),
  ];
  if (maxPage > 0) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${WANTED_REMOVE_PAGE_PREFIX}${p - 1}`)
          .setLabel('Назад')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p <= 0),
        new ButtonBuilder()
          .setCustomId(`${WANTED_REMOVE_PAGE_PREFIX}${p + 1}`)
          .setLabel('Дальше')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p >= maxPage),
      ),
    );
  }
  return rows;
}

export async function handleWantedAddButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (interaction.customId !== WANTED_ADD_BUTTON_ID) return;
  const member = await requireOperator(interaction, cfg);
  if (!member) return;
  await interaction.showModal(buildAddModal()).catch(() => {});
}

export async function handleWantedRemoveButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  if (interaction.customId !== WANTED_REMOVE_BUTTON_ID) return;
  const member = await requireOperator(interaction, cfg);
  if (!member) return;
  const board = await api.getWantedBoard();
  if (board.persons.length === 0) {
    await interaction
      .reply({
        content: 'Активный список розыска пуст.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }
  await interaction
    .reply({
      content: 'Выберите, кого снять с розыска.',
      components: removeSelectPage(board, 0),
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
}

export async function handleWantedRemovePageButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  if (!interaction.customId.startsWith(WANTED_REMOVE_PAGE_PREFIX)) return;
  const member = await requireOperator(interaction, cfg);
  if (!member) return;
  const page = Number(interaction.customId.slice(WANTED_REMOVE_PAGE_PREFIX.length));
  const board = await api.getWantedBoard();
  await interaction
    .update({
      content: 'Выберите, кого снять с розыска.',
      components: removeSelectPage(board, Number.isFinite(page) ? page : 0),
    })
    .catch(() => {});
}

export async function handleWantedAddModalSubmit(
  interaction: ModalSubmitInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (interaction.customId !== WANTED_ADD_MODAL_ID) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await requireOperator(interaction, cfg);
  if (!member) return;

  const fullName = interaction.fields.getTextInputValue(FIELD_FULL_NAME).trim();
  const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();
  const rewardRaw = interaction.fields.getTextInputValue(FIELD_REWARD).trim();
  const steamRaw = interaction.fields.getTextInputValue(FIELD_STEAM).trim();
  if (!fullName || !reason) {
    await interaction.editReply({ content: 'Укажите ФИО и причину.' });
    return;
  }
  const reward = Number.parseInt(rewardRaw.replace(/\D/g, '') || '0', 10);
  pendingAdds.set(interaction.user.id, {
    fullName,
    reason,
    reward: Number.isFinite(reward) ? Math.max(0, reward) : 0,
    steam64: steamRaw || null,
    at: Date.now(),
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(WANTED_CLASS_SELECT_ID)
    .setPlaceholder('Класс розыска')
    .addOptions([
      { label: 'Красный', value: 'red', description: 'Приоритет' },
      { label: 'Жёлтый', value: 'yellow' },
      { label: 'Синий (наблюдение)', value: 'blue' },
    ]);

  await interaction.editReply({
    content: 'Выберите класс розыска.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    ],
  });
}

export async function handleWantedClassSelect(
  interaction: StringSelectMenuInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  if (interaction.customId !== WANTED_CLASS_SELECT_ID) return;
  await interaction.deferUpdate();
  const member = await requireOperator(interaction, cfg);
  if (!member) return;

  const pending = takePending(interaction.user.id);
  if (!pending) {
    await interaction.editReply({
      content: 'Сессия истекла. Нажмите «Добавить в розыск» снова.',
      components: [],
    });
    return;
  }
  const wantedClass = interaction.values[0] as WantedClass;
  if (!wantedClass || !CLASS_LABELS[wantedClass]) {
    await interaction.editReply({
      content: 'Неизвестный класс.',
      components: [],
    });
    return;
  }
  try {
    const created = await api.createWantedPerson({
      fullName: pending.fullName,
      steam64: pending.steam64,
      reason: pending.reason,
      wantedClass,
      reward: pending.reward,
    });
    const board = await api.getWantedBoard();
    await syncWantedPanel(interaction.client, cfg, api, board);
    await interaction.editReply({
      content: `**${created.fullName}** добавлен в розыск (${CLASS_LABELS[wantedClass]}).`,
      components: [],
    });
  } catch (e) {
    console.warn('wanted-panel: create', e);
    const extra =
      e instanceof ApiError ? ` (${e.status})` : '';
    await interaction.editReply({
      content: `Не удалось добавить в розыск${extra}.`,
      components: [],
    });
  }
}

export async function handleWantedRemoveSelect(
  interaction: StringSelectMenuInteraction,
  cfg: VpBotConfigFromApi,
  api: ApiClient,
): Promise<void> {
  if (!interaction.customId.startsWith(WANTED_REMOVE_SELECT_PREFIX)) return;
  await interaction.deferUpdate();
  const member = await requireOperator(interaction, cfg);
  if (!member) return;
  const id = interaction.values[0]?.trim();
  if (!id || id === 'none') {
    await interaction.editReply({
      content: 'Никого не выбрано.',
      components: [],
    });
    return;
  }
  try {
    const row = await api.deactivateWantedPerson(id);
    const board = await api.getWantedBoard();
    await syncWantedPanel(interaction.client, cfg, api, board);
    await interaction.editReply({
      content: `**${row.fullName}** снят с розыска.`,
      components: [],
    });
  } catch (e) {
    console.warn('wanted-panel: deactivate', e);
    const extra = e instanceof ApiError ? ` (${e.status})` : '';
    await interaction.editReply({
      content: `Не удалось снять с розыска${extra}.`,
      components: [],
    });
  }
}
