import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  ChannelType,
} from 'discord.js';
import type { VpBotConfigFromApi } from './config';

export const TRAINING_REQUEST_BUTTON_ID = 'vp_training_request_btn';


export async function handleTrainingRequestButton(
  interaction: ButtonInteraction,
  cfg: VpBotConfigFromApi,
): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({ content: 'Ошибка контекста сервера.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

 
  const trainingCfg = (cfg as any).training || {};
  const instructorRoleId = trainingCfg.instructorRoleId as string | undefined;

  const member = interaction.member;
  const user = interaction.user;
  const userName = member && 'displayName' in member ? member.displayName : user.username;

  try {
    const channel = interaction.channel;
    if (!channel.isTextBased() || channel.isDMBased()) {
      await interaction.editReply({ content: 'Эту кнопку можно нажать только в текстовом канале сервера.' });
      return;
    }


    const threadName = `обучение-${userName}`.slice(0, 100);
    const thread = await (channel as any).threads.create({
    name: threadName,
    autoArchiveDuration: 1440,
    type: ChannelType.PrivateThread,
    reason: `Запрос обучения от ${userName}`,
  });


    await thread.members.add(user.id);

    const instructorMention = instructorRoleId ? `<@&${instructorRoleId}>` : 'Инструкторы';

    const embed = new EmbedBuilder()
      .setTitle('🎓 Запрос на обучение')
      .setDescription(
        `Пользователь **${userName}** запросил проведение обучения.\n\n` +
          `Ответственные: ${instructorMention}\n` +
          `Пожалуйста, ожидайте ответа. В этой ветке можно обсудить детали и время.`
      )
      .setColor(0x3498db)
      .setTimestamp();

    await thread.send({
      content: `<@${user.id}> ${instructorRoleId ? `<@&${instructorRoleId}>` : ''}`,
      embeds: [embed],
    });

    await interaction.editReply({
      content: `Тикет по обучению успешно создан: <#${thread.id}>`,
    });
  } catch (e) {
    console.error('handleTrainingRequestButton error:', e);
    await interaction.editReply({
      content: 'Не удалось создать тикет обучения. Проверьте права бота (Manage Threads / Create Private Threads).',
    });
  }
}