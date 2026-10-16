import './load-env';
/** До discord.js: патчит WebSocket при DISCORD_PROXY. */
import { getDiscordProxyRestAgent } from './proxy-setup';
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { applyDiscordRoleSync } from './apply-discord-role-sync';
import { createApiClient, ApiError } from './api';
import { loadStaticEnv, type VpBotConfigFromApi } from './config';
import { startPanelSyncPoller } from './panel-sync';
import { startChannelCatalogPoller } from './channel-catalog-poller';
import { startChannelMessagePoller } from './channel-message-poller';
import { startLeaveNotifyPoller } from './leave-notify-poller';
import { startFormDiscordThreadPoller } from './form-discord-thread-poller';
import { startInvestigatorChoicesPoller } from './investigator-choices-poller';
import {
  CANDIDATE_APPLICATION_MODAL_ID,
  CANDIDATE_APPROVE_BUTTON_PREFIX,
  CANDIDATE_APPROVE_SELECT_PREFIX,
  CANDIDATE_REJECT_BUTTON_PREFIX,
  CANDIDATE_REJECT_MODAL_PREFIX,
  dmApplicantAboutNewThreadMessage,
  findCandidateRequestIdByThread,
  handleCandidateApplicationModalSubmit,
  handleCandidateApproveButton,
  handleCandidateApproveSelect,
  handleCandidateRejectButton,
  handleCandidateRejectModalSubmit,
  handleWelcomeCandidateButton,
  isCandidateApplicationContext,
} from './candidate-application';
import {
  canModerateLeaveRequest,
  findLeaveRequestIdByThread,
  handleLeaveApplicationModalSubmit,
  handleLeaveRejectButton,
  handleLeaveRejectModalSubmit,
  handleWelcomeLeaveButton,
  isLeaveRequestContext,
  LEAVE_APPLICATION_MODAL_ID,
  LEAVE_REJECT_BUTTON_PREFIX,
  LEAVE_REJECT_MODAL_PREFIX,
  postLeaveNotifyMessage,
  purgeLeaveRequestThread,
  ACTIONS_LEAVE_BUTTON_ID,
} from './leave-request';
import {
  canModerateRoleRequest,
  findRoleRequestIdByThread,
  handleRoleRequestRejectButton,
  handleRoleRequestRejectModalSubmit,
  handleRoleRequestSelect,
  handleRoleRequestSubmit,
  handleWelcomeRoleRequestButton,
  isRoleRequestContext,
  purgeRoleRequestThread,
  ROLE_REQUEST_OTHER_SELECT_PREFIX,
  ROLE_REQUEST_POSITION_SELECT_PREFIX,
  ROLE_REQUEST_REJECT_BUTTON_PREFIX,
  ROLE_REQUEST_REJECT_MODAL_PREFIX,
  ROLE_REQUEST_SUBMIT_PREFIX,
  ACTIONS_ROLE_REQUEST_BUTTON_ID,
} from './role-request';
import {
  handleWelcomeGuestButton,
  handleWelcomeGuestModalSubmit,
  VP_GUEST_APPLICATION_MODAL_ID,
  WELCOME_CANDIDATE_BUTTON_ID,
  WELCOME_GUEST_BUTTON_ID,
} from './welcome-panel';
import {
  handleWantedAddButton,
  handleWantedAddModalSubmit,
  handleWantedClassSelect,
  handleWantedRemoveButton,
  handleWantedRemovePageButton,
  handleWantedRemoveSelect,
  WANTED_ADD_BUTTON_ID,
  WANTED_ADD_MODAL_ID,
  WANTED_CLASS_SELECT_ID,
  WANTED_REMOVE_BUTTON_ID,
  WANTED_REMOVE_PAGE_PREFIX,
  WANTED_REMOVE_SELECT_PREFIX,
} from './wanted-panel';
import {
  TRAINING_REQUEST_BUTTON_ID,
  handleTrainingRequestButton,
} from './training-request';
import { startWantedAlertPoller } from './wanted-alert-poller';
import { startWantedDossierPoller } from './wanted-dossier-poller';

function errorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  const ne = e as NodeJS.ErrnoException | undefined;
  if (ne?.code && typeof ne.code === 'string') return ne.code;
  return undefined;
}

function isRetryableDiscordConnectError(e: unknown): boolean {
  if (errorCode(e) === 'TokenInvalid') return false;
  const codes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  const c = errorCode(e);
  return c ? codes.has(c) : false;
}

async function loginWithRetries(client: Client, token: string): Promise<void> {
  const attempts = 5;
  const delaysMs = [2000, 4000, 8000, 12000, 20000];
  for (let i = 0; i < attempts; i++) {
    try {
      await client.login(token);
      return;
    } catch (e) {
      if (!isRetryableDiscordConnectError(e) || i === attempts - 1) {
        throw e;
      }
      const ms = delaysMs[i] ?? 20000;
      console.warn(
        `Сеть до Discord оборвалась (${errorCode(e) ?? 'unknown'}), следующая попытка через ${ms / 1000} с (${i + 2}/${attempts})`,
      );
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

const staticEnv = loadStaticEnv();
const apiForUrl = (base: string) => createApiClient(base, staticEnv.secret);

let cachedConfig: { at: number; cfg: VpBotConfigFromApi } | null = null;
const CONFIG_TTL_MS = 15_000;

async function getConfig(): Promise<VpBotConfigFromApi> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.at < CONFIG_TTL_MS) {
    return cachedConfig.cfg;
  }
  const cfg = await apiForUrl(staticEnv.backendFallback).getBotConfig();
  cachedConfig = { at: now, cfg };
  return cfg;
}

function isApproveEmoji(name: string | null): boolean {
  return name === '✅' || name === '✔️' || name === '☑';
}

async function removeBotPendingReaction(
  client: Client,
  message: Message,
  botId: string,
): Promise<void> {
  const pending = message.reactions.cache.find(
    (r) => r.emoji.name === '⏳' && r.me,
  );
  if (!pending) return;
  try {
    await pending.users.remove(botId);
  } catch {
    /* ignore */
  }
}

/** Guilds + GuildMessages + reactions + members. MessageContent — опционально. */
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
];
if (staticEnv.messageContentIntent) {
  intents.push(GatewayIntentBits.MessageContent);
}

const discordProxyAgent = getDiscordProxyRestAgent();
const client = new Client({
  intents,
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  ...(discordProxyAgent ? { rest: { agent: discordProxyAgent } } : {}),
});

client.once('clientReady', () => {
  console.log(`Агент ВП авторизован: ${client.user?.tag}`);
  if (!staticEnv.messageContentIntent) {
    console.warn(
      'VP_MESSAGE_CONTENT_INTENT не включён: бот стартует без privileged Message Content. ' +
        'Лента на сайте будет без текста, пока в Developer Portal не включите Message Content Intent ' +
        'и не зададите VP_MESSAGE_CONTENT_INTENT=true.',
    );
  }
  const panelPoller = startPanelSyncPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  panelPoller.start();
  const catalogPoller = startChannelCatalogPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  catalogPoller.start();
  const messagePoller = startChannelMessagePoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  messagePoller.start();
  const leaveNotifyPoller = startLeaveNotifyPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  leaveNotifyPoller.start();
  const formThreadPoller = startFormDiscordThreadPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  formThreadPoller.start();
  const investigatorPoller = startInvestigatorChoicesPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  investigatorPoller.start();
  const wantedAlertPoller = startWantedAlertPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  wantedAlertPoller.start();
  const wantedDossierPoller = startWantedDossierPoller(
    client,
    staticEnv.backendFallback,
    apiForUrl,
  );
  wantedDossierPoller.start();
  console.log(
    `Панель, каталог, лента, отпуска, ветки Form, следователи и розыск: опрос API (${staticEnv.backendFallback})`,
  );
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      const cfg = await getConfig();
      const api = apiForUrl(staticEnv.backendFallback);
      if (interaction.customId === WELCOME_GUEST_BUTTON_ID) {
        await handleWelcomeGuestButton(interaction, cfg);
        return;
      }
      if (interaction.customId === WELCOME_CANDIDATE_BUTTON_ID) {
        await handleWelcomeCandidateButton(interaction, cfg);
        return;
      }
      if (
        interaction.customId === ACTIONS_ROLE_REQUEST_BUTTON_ID ||
        interaction.customId === 'vp_welcome_role_request'
      ) {
        await handleWelcomeRoleRequestButton(interaction, cfg);
        return;
      }
      if (
        interaction.customId === ACTIONS_LEAVE_BUTTON_ID ||
        interaction.customId === 'vp_welcome_leave_request'
      ) {
        await handleWelcomeLeaveButton(interaction, cfg);
        return;
      }
      if (interaction.customId === TRAINING_REQUEST_BUTTON_ID) {
        await handleTrainingRequestButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(ROLE_REQUEST_SUBMIT_PREFIX)) {
        await handleRoleRequestSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(CANDIDATE_APPROVE_BUTTON_PREFIX)) {
        await handleCandidateApproveButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(CANDIDATE_REJECT_BUTTON_PREFIX)) {
        await handleCandidateRejectButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(ROLE_REQUEST_REJECT_BUTTON_PREFIX)) {
        await handleRoleRequestRejectButton(interaction, cfg);
        return;
      }
      if (interaction.customId.startsWith(LEAVE_REJECT_BUTTON_PREFIX)) {
        await handleLeaveRejectButton(interaction, cfg);
        return;
      }
      if (interaction.customId === WANTED_ADD_BUTTON_ID) {
        await handleWantedAddButton(interaction, cfg);
        return;
      }
      if (interaction.customId === WANTED_REMOVE_BUTTON_ID) {
        await handleWantedRemoveButton(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(WANTED_REMOVE_PAGE_PREFIX)) {
        await handleWantedRemovePageButton(interaction, cfg, api);
        return;
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      const cfg = await getConfig();
      const api = apiForUrl(staticEnv.backendFallback);
      if (interaction.customId.startsWith(CANDIDATE_APPROVE_SELECT_PREFIX)) {
        await handleCandidateApproveSelect(interaction, cfg, api);
        return;
      }
      if (
        interaction.customId.startsWith(ROLE_REQUEST_POSITION_SELECT_PREFIX) ||
        interaction.customId.startsWith(ROLE_REQUEST_OTHER_SELECT_PREFIX)
      ) {
        await handleRoleRequestSelect(interaction);
        return;
      }
      if (interaction.customId === WANTED_CLASS_SELECT_ID) {
        await handleWantedClassSelect(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(WANTED_REMOVE_SELECT_PREFIX)) {
        await handleWantedRemoveSelect(interaction, cfg, api);
        return;
      }
      return;
    }
    if (interaction.isModalSubmit()) {
      const cfg = await getConfig();
      const api = apiForUrl(staticEnv.backendFallback);
      if (interaction.customId === VP_GUEST_APPLICATION_MODAL_ID) {
        await handleWelcomeGuestModalSubmit(interaction, cfg);
        return;
      }
      if (interaction.customId === CANDIDATE_APPLICATION_MODAL_ID) {
        await handleCandidateApplicationModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId === LEAVE_APPLICATION_MODAL_ID) {
        await handleLeaveApplicationModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(CANDIDATE_REJECT_MODAL_PREFIX)) {
        await handleCandidateRejectModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(ROLE_REQUEST_REJECT_MODAL_PREFIX)) {
        await handleRoleRequestRejectModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId.startsWith(LEAVE_REJECT_MODAL_PREFIX)) {
        await handleLeaveRejectModalSubmit(interaction, cfg, api);
        return;
      }
      if (interaction.customId === WANTED_ADD_MODAL_ID) {
        await handleWantedAddModalSubmit(interaction, cfg);
      }
    }
  } catch (e) {
    console.warn('interaction: vp-agent', e);
    if (!interaction.isRepliable()) return;
    if (interaction.deferred || interaction.replied) return;
    await interaction
      .reply({
        content: 'Временная ошибка. Попробуйте позже.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild || !message.channel.isThread()) return;
    const cfg = await getConfig();
    if (!isCandidateApplicationContext(message, cfg)) return;

    const api = apiForUrl(staticEnv.backendFallback);
    const requestId = await findCandidateRequestIdByThread(
      api,
      message.channel.id,
    );
    if (!requestId) return;

    const pending = await api.getPendingRequests();
    const row = pending.find((r) => r.id === requestId);
    if (!row) return;
    const data = (row.payload as { data?: Record<string, unknown> }).data;
    const applicantId =
      typeof data?.applicantDiscordUserId === 'string'
        ? data.applicantDiscordUserId.trim()
        : null;
    if (!applicantId || message.author.id === applicantId) return;

    const applicant = await client.users.fetch(applicantId).catch(() => null);
    if (!applicant) return;

    const authorLabel =
      message.member?.displayName?.trim() ||
      message.author.displayName ||
      message.author.username;
    await dmApplicantAboutNewThreadMessage(
      applicant,
      message.channel,
      authorLabel,
      message.content ?? '',
    );
  } catch (e) {
    console.warn('messageCreate: candidate thread notify', e);
  }
});

async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return;
  try {
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }
  } catch {
    return;
  }

  const message = reaction.message;
  if (!message.guild || message.author?.id !== client.user?.id) return;
  if (!isApproveEmoji(reaction.emoji.name)) return;
  if (!message.channel.isThread()) return;

  const cfg = await getConfig();
  const api = apiForUrl(staticEnv.backendFallback);
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const botId = client.user?.id;

  // Decorative roles
  if (isRoleRequestContext(message as Message, cfg)) {
    if (!canModerateRoleRequest(member, cfg)) return;
    const reqId = await findRoleRequestIdByThread(api, message.channel.id);
    if (!reqId) return;
    try {
      const res = await api.setStatus(reqId, 'approved', user.id);
      if (res.discordRoleSync) {
        await applyDiscordRoleSync(message.guild, res.discordRoleSync);
      }
      if (botId) {
        await removeBotPendingReaction(client, message as Message, botId);
      }
      await purgeRoleRequestThread(message.channel);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      console.error('role-request approve reaction', e);
    }
    return;
  }

  // Leave
  if (isLeaveRequestContext(message as Message, cfg)) {
    if (!canModerateLeaveRequest(member, cfg)) return;
    const reqId = await findLeaveRequestIdByThread(api, message.channel.id);
    if (!reqId) return;
    try {
      const res = await api.setStatus(reqId, 'approved', user.id);
      if (res.discordRoleSync) {
        await applyDiscordRoleSync(message.guild, res.discordRoleSync);
      }
      if (res.leaveNotify) {
        await postLeaveNotifyMessage(message.guild, api, res.leaveNotify);
      }
      if (botId) {
        await removeBotPendingReaction(client, message as Message, botId);
      }
      await purgeLeaveRequestThread(message.channel);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      console.error('leave-request approve reaction', e);
    }
  }
}

client.on('messageReactionAdd', (reaction, user) => {
  void handleReaction(reaction, user);
});

void loginWithRetries(client, staticEnv.token).catch((e) => {
  console.error('Не удалось войти в Discord', e);
  process.exit(1);
});