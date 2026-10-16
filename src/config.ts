export type VpBotConfigFromApi = {
  guildId: string | null;
  welcomeChannelId: string | null;
  guestRoleId: string | null;
  candidateRoleId: string | null;
  candidateApplicationChannelId: string | null;
  candidateApplicationApproverRoleIds: string[];
  positionRoleIds: string[];
  positionCategoryRoleId: string | null;
  punishmentRoleIds: string[];
  punishmentCategoryRoleId: string | null;
  otherRoleIds: string[];
  otherCategoryRoleId: string | null;
  roleRequestChannelId: string | null;
  roleRequestApproverRoleIds: string[];
  leaveRequestChannelId: string | null;
  leaveApproverRoleIds: string[];
  leaveNotifyChannelId: string | null;
  leaveActiveRoleId: string | null;
  actionsPanelChannelId: string | null;
  actionsPanelMessageId: string | null;
  actionsPanelSyncRequested: boolean;
  welcomePanelTitle: string | null;
  welcomePanelDescription: string | null;
  welcomePanelThumbnailUrl: string | null;
  welcomePanelImageUrl: string | null;
  welcomePanelMessageId: string | null;
  welcomePanelSyncRequested: boolean;
  channelCatalogSyncRequested: boolean;
  googleFormInvestigatorRoleId: string | null;
  googleFormInvestigatorChoicesSyncRequested: boolean;
  wantedPanelChannelId: string | null;
  wantedPanelMessageId: string | null;
  wantedPanelSyncRequested: boolean;
  wantedOperatorRoleIds: string[];
  wantedAlertChannelIds: string[];
  wantedAlertRoleIds: string[];
  wantedAlertGifUrl: string | null;
};

export function loadStaticEnv() {
  const token = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
  const secret = (process.env.VP_DISCORD_BOT_SECRET ?? '').trim();
  const backendFallback = (
    process.env.BACKEND_PUBLIC_URL ?? 'http://127.0.0.1:3000'
  )
    .trim()
    .replace(/\/+$/, '');
  const rawMc = (process.env.VP_MESSAGE_CONTENT_INTENT ?? '').trim().toLowerCase();
  const messageContentIntent =
    rawMc === '1' || rawMc === 'true' || rawMc === 'yes';

  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN не задан');
  }
  if (!secret) {
    throw new Error('VP_DISCORD_BOT_SECRET не задан');
  }

  return { token, secret, backendFallback, messageContentIntent };
}
