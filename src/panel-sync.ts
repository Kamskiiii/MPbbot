import type { Client } from 'discord.js';
import type { createApiClient } from './api';
import type { VpBotConfigFromApi } from './config';
import { syncActionsPanel } from './actions-panel';
import { syncWelcomePanel } from './welcome-panel';
import { syncWantedPanel } from './wanted-panel';

type ApiFactory = (base: string) => ReturnType<typeof createApiClient>;
type PollerLog = (message: string, error?: unknown) => void;

export type PollerController = {
  start: () => void;
  stop: () => void;
};

const INTERVAL_MS = 25_000;

/** Опрос API: флаги от техадмина → публикация welcome / панели действий / розыска. */
export function startPanelSyncPoller(
  client: Client,
  backendUrl: string,
  apiForUrl: ApiFactory,
  logWarn: PollerLog = (message, error) => console.warn(message, error),
): PollerController {
  let timer: NodeJS.Timeout | null = null;
  let lastWantedFingerprint: string | null = null;

  const tick = async () => {
    if (!client.isReady()) return;
    try {
      const api = apiForUrl(backendUrl);
      const cfg: VpBotConfigFromApi = await api.getBotConfig();

      if (cfg.welcomePanelSyncRequested) {
        let done = false;
        try {
          if (!cfg.welcomeChannelId?.trim() || !cfg.guestRoleId?.trim()) {
            logWarn(
              'panel-sync: задайте канал приветствия и роль гостя в /tech/vp',
            );
            done = true;
          } else {
            await syncWelcomePanel(client, cfg, api);
            done = true;
          }
        } catch (e) {
          logWarn('panel-sync: приветствие', e);
        }
        if (done) {
          await api.ackPanelSync({ welcomePanel: true });
        }
      }

      if (cfg.actionsPanelSyncRequested) {
        let done = false;
        try {
          if (!cfg.actionsPanelChannelId?.trim()) {
            logWarn(
              'panel-sync: задайте канал панели действий в /tech/vp',
            );
            done = true;
          } else {
            await syncActionsPanel(client, cfg, api);
            done = true;
          }
        } catch (e) {
          logWarn('panel-sync: панель действий', e);
        }
        if (done) {
          await api.ackPanelSync({ actionsPanel: true });
        }
      }

      if (cfg.wantedPanelChannelId?.trim()) {
        try {
          const board = await api.getWantedBoard();
          const force = Boolean(cfg.wantedPanelSyncRequested);
          const fp = board.fingerprint;
          const hasMessage = Boolean(
            (board.panelMessageId ?? cfg.wantedPanelMessageId)?.trim(),
          );
          if (force || (hasMessage && fp !== lastWantedFingerprint)) {
            await syncWantedPanel(client, cfg, api, board);
            lastWantedFingerprint = fp;
          }
          if (force) {
            await api.ackPanelSync({ wantedPanel: true });
          }
        } catch (e) {
          logWarn('panel-sync: розыск', e);
          if (cfg.wantedPanelSyncRequested) {
            await api.ackPanelSync({ wantedPanel: true }).catch(() => {});
          }
        }
      } else if (cfg.wantedPanelSyncRequested) {
        logWarn('panel-sync: задайте канал панели розыска в /tech/vp');
        await api.ackPanelSync({ wantedPanel: true });
      }
    } catch (e) {
      logWarn('panel-sync: tick', e);
    }
  };

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), INTERVAL_MS);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
