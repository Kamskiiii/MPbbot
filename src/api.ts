import type { VpBotConfigFromApi } from './config';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type VpPendingRow = {
  id: string;
  payload: Record<string, unknown>;
  status: string;
};

export type VpDiscordRoleSyncDto = {
  targetDiscordUserId: string;
  addRoleIds: string[];
  removeRoleIds: string[];
};

export type SetVpStatusResponse = {
  request: VpPendingRow;
  discordRoleSync: VpDiscordRoleSyncDto | null;
  leaveNotify: VpLeaveNotifyPayload | null;
};

export type VpLeaveNotifyPayload = {
  leaveId: string;
  channelId: string;
  applicantDiscordUserId: string;
  discordDisplayName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
};

export type VpLeaveNotifyEditJob = {
  leaveId: string;
  channelId: string;
  messageId: string;
  applicantDiscordUserId: string;
  discordDisplayName: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
  approvedByDiscordUserId: string | null;
  leaveActiveRoleId: string | null;
};

export type CreateVpRequestBody = {
  type: string;
  payload: Record<string, unknown>;
};

export type WantedClass = 'red' | 'yellow' | 'blue';

export type WantedBoardPerson = {
  id: string;
  fullName: string;
  steam64: string | null;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  online: boolean;
  serverName: string | null;
};

export type WantedBoardPayload = {
  panelChannelId: string | null;
  panelMessageId: string | null;
  panelSyncRequested: boolean;
  operatorRoleIds: string[];
  persons: WantedBoardPerson[];
  onlinePersonIds: string[];
  fingerprint: string;
};

export type WantedPersonRow = {
  id: string;
  fullName: string;
  steam64: string | null;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  active: boolean;
};

export type WantedAlertJob = {
  id: string;
  kind: 'post' | 'edit';
  sessionId: string;
  personId: string;
  channelId: string;
  messageId: string | null;
  fullName: string;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  serverName: string | null;
  gifUrl: string | null;
  pingRoleIds: string[];
};

export type WantedDossierPayload = {
  fullName: string;
  reason: string;
  wantedClass: WantedClass;
  reward: number;
  steam64: string | null;
  siteUrl: string | null;
  online: boolean;
  serverName: string | null;
  typicalWindow: string;
  medianSession: string;
  sessionCount: number;
  heatmapLines: string[];
  anomalies: string[];
  coPresence: Array<{
    name: string;
    unit: string | null;
    overlap: string;
    lift: string;
  }>;
  reliable: boolean;
  operatorRoleIds: string[];
  threadName: string;
  closed: boolean;
};

export type WantedDossierJob = {
  id: string;
  kind: 'open' | 'update' | 'close';
  personId: string;
  channelId: string;
  threadId: string | null;
  starterMessageId: string | null;
  cardMessageId: string | null;
  analyticsMessageId: string | null;
  payload: WantedDossierPayload;
};

export function createApiClient(baseUrl: string, secret: string) {
  const headers = {
    'Content-Type': 'application/json',
    'x-bot-secret': secret,
  };

  async function parseError(res: Response): Promise<ApiError> {
    const text = await res.text();
    return new ApiError(`API ${res.status}`, res.status, text);
  }

  const root = baseUrl.replace(/\/+$/, '');

  return {
    async getBotConfig(): Promise<VpBotConfigFromApi> {
      const res = await fetch(`${root}/api/vp-agent/bot-config`, { headers });
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<VpBotConfigFromApi>;
    },

    async setWelcomePanelMessageId(messageId: string): Promise<void> {
      const res = await fetch(
        `${root}/api/vp-agent/bot-config/welcome-panel-message`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ messageId }),
        },
      );
      if (!res.ok) throw await parseError(res);
    },

    async setActionsPanelMessageId(messageId: string): Promise<void> {
      const res = await fetch(
        `${root}/api/vp-agent/bot-config/actions-panel-message`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ messageId }),
        },
      );
      if (!res.ok) throw await parseError(res);
    },

    async ackPanelSync(body: {
      welcomePanel?: boolean;
      actionsPanel?: boolean;
      wantedPanel?: boolean;
    }): Promise<void> {
      const res = await fetch(
        `${root}/api/vp-agent/bot-config/panel-sync-ack`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw await parseError(res);
    },

    async saveChannelCatalog(
      channels: {
        id: string;
        name: string;
        type: number;
        parentId: string | null;
        position: number;
      }[],
    ): Promise<void> {
      const res = await fetch(`${root}/api/vp-agent/channel-catalog`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channels }),
      });
      if (!res.ok) throw await parseError(res);
    },

    async getPendingChannelMessageJobs(): Promise<{
      items: { jobId: string; channelId: string; createdAt: string }[];
    }> {
      const res = await fetch(
        `${root}/api/vp-agent/channel-message-jobs/pending`,
        { headers },
      );
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<{
        items: { jobId: string; channelId: string; createdAt: string }[];
      }>;
    },

    async ackChannelMessageJob(body: {
      jobId: string;
      messages?: {
        id: string;
        content: string;
        createdAt: string;
        authorId: string;
        authorNick: string;
        authorUsername: string;
        imageUrls: string[];
        threadId: string | null;
        threadName: string | null;
        threadMessageCount: number | null;
      }[];
      error?: string | null;
    }): Promise<void> {
      const res = await fetch(`${root}/api/vp-agent/channel-message-jobs/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await parseError(res);
    },

    async createRequest(body: CreateVpRequestBody): Promise<VpPendingRow> {
      const res = await fetch(`${root}/api/vp-agent/requests`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<VpPendingRow>;
    },

    async getPendingRequests(): Promise<VpPendingRow[]> {
      const res = await fetch(`${root}/api/vp-agent/requests/pending`, {
        headers,
      });
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<VpPendingRow[]>;
    },

    async setStatus(
      id: string,
      status: 'approved' | 'rejected',
      moderatorDiscordUserId?: string,
      opts?: { positionRoleId?: string },
    ): Promise<SetVpStatusResponse> {
      const body: {
        status: string;
        approvedByDiscordUserId?: string;
        moderatorDiscordUserId?: string;
        positionRoleId?: string;
      } = { status };
      const modId = moderatorDiscordUserId?.trim();
      if (modId) {
        body.moderatorDiscordUserId = modId;
        if (status === 'approved') {
          body.approvedByDiscordUserId = modId;
        }
      }
      const positionRoleId = opts?.positionRoleId?.trim();
      if (positionRoleId) {
        body.positionRoleId = positionRoleId;
      }
      const res = await fetch(
        `${root}/api/vp-agent/requests/${encodeURIComponent(id)}/status`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<SetVpStatusResponse>;
    },

    async setLeaveNotifyMessage(
      leaveId: string,
      channelId: string,
      messageId: string,
    ): Promise<void> {
      const res = await fetch(
        `${root}/api/vp-agent/leaves/${encodeURIComponent(leaveId)}/notify-message`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ channelId, messageId }),
        },
      );
      if (!res.ok) throw await parseError(res);
    },

    async getPendingLeaveNotifyEdits(): Promise<{
      items: VpLeaveNotifyEditJob[];
    }> {
      const res = await fetch(
        `${root}/api/vp-agent/leave-notify-jobs/pending`,
        { headers },
      );
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<{ items: VpLeaveNotifyEditJob[] }>;
    },

    async ackLeaveNotifyEdit(
      leaveId: string,
      error?: string | null,
    ): Promise<void> {
      const res = await fetch(`${root}/api/vp-agent/leave-notify-jobs/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ leaveId, error: error ?? null }),
      });
      if (!res.ok) throw await parseError(res);
    },

    async getPendingFormDiscordThreadJobs(): Promise<{
      items: {
        jobId: string;
        channelId: string;
        messageId: string;
        threadName: string;
        createdAt: string;
      }[];
    }> {
      const res = await fetch(
        `${root}/api/vp-agent/form-discord-thread-jobs/pending`,
        { headers },
      );
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<{
        items: {
          jobId: string;
          channelId: string;
          messageId: string;
          threadName: string;
          createdAt: string;
        }[];
      }>;
    },

    async ackFormDiscordThreadJob(body: {
      jobId: string;
      threadId?: string | null;
      error?: string | null;
    }): Promise<void> {
      const res = await fetch(
        `${root}/api/vp-agent/form-discord-thread-jobs/ack`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw await parseError(res);
    },

    async saveInvestigatorChoices(choices: string[]): Promise<void> {
      const res = await fetch(
        `${root}/api/vp-agent/bot-config/investigator-choices`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ choices }),
        },
      );
      if (!res.ok) throw await parseError(res);
    },

    async setWantedPanelMessageId(messageId: string): Promise<void> {
      const res = await fetch(
        `${root}/api/vp-agent/bot-config/wanted-panel-message`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ messageId }),
        },
      );
      if (!res.ok) throw await parseError(res);
    },

    async getWantedBoard(): Promise<WantedBoardPayload> {
      const res = await fetch(`${root}/api/vp-agent/wanted-board`, { headers });
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<WantedBoardPayload>;
    },

    async createWantedPerson(body: {
      fullName: string;
      steam64?: string | null;
      reason: string;
      wantedClass: WantedClass;
      reward: number;
    }): Promise<WantedPersonRow> {
      const res = await fetch(`${root}/api/vp-agent/wanted/persons`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<WantedPersonRow>;
    },

    async deactivateWantedPerson(id: string): Promise<WantedPersonRow> {
      const res = await fetch(
        `${root}/api/vp-agent/wanted/persons/${encodeURIComponent(id)}/deactivate`,
        {
          method: 'PATCH',
          headers,
        },
      );
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<WantedPersonRow>;
    },

    async getPendingWantedAlertJobs(): Promise<{ items: WantedAlertJob[] }> {
      const res = await fetch(`${root}/api/vp-agent/wanted-alert-jobs/pending`, {
        headers,
      });
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<{ items: WantedAlertJob[] }>;
    },

    async ackWantedAlertJob(body: {
      jobId: string;
      messageId?: string | null;
      error?: string | null;
    }): Promise<void> {
      const res = await fetch(`${root}/api/vp-agent/wanted-alert-jobs/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await parseError(res);
    },

    async getPendingWantedDossierJobs(): Promise<{ items: WantedDossierJob[] }> {
      const res = await fetch(
        `${root}/api/vp-agent/wanted-dossier-jobs/pending`,
        { headers },
      );
      if (!res.ok) throw await parseError(res);
      return res.json() as Promise<{ items: WantedDossierJob[] }>;
    },

    async ackWantedDossierJob(body: {
      jobId: string;
      threadId?: string | null;
      starterMessageId?: string | null;
      cardMessageId?: string | null;
      analyticsMessageId?: string | null;
      error?: string | null;
    }): Promise<void> {
      const res = await fetch(`${root}/api/vp-agent/wanted-dossier-jobs/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await parseError(res);
    },
  };
}
