import { ChannelType, type Client } from 'discord.js';
import type { createApiClient } from './api';
import type { VpBotConfigFromApi } from './config';

type ApiFactory = (base: string) => ReturnType<typeof createApiClient>;
type PollerLog = (message: string, error?: unknown) => void;

export type PollerController = {
  start: () => void;
  stop: () => void;
};

const INTERVAL_MS = 25_000;

const CATALOG_CHANNEL_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

/**
 * По флагу channelCatalogSyncRequested выгружает каналы guild ВП в API.
 */
export function startChannelCatalogPoller(
  client: Client,
  backendUrl: string,
  apiForUrl: ApiFactory,
  logWarn: PollerLog = (message, error) => console.warn(message, error),
): PollerController {
  let timer: NodeJS.Timeout | null = null;
  let tickBusy = false;

  const tick = async () => {
    if (!client.isReady()) return;
    if (tickBusy) return;
    tickBusy = true;
    try {
      const api = apiForUrl(backendUrl);
      const cfg: VpBotConfigFromApi = await api.getBotConfig();
      if (!cfg.channelCatalogSyncRequested) return;

      const gid = cfg.guildId?.trim();
      if (!gid) {
        logWarn(
          'channel-catalog: задайте Guild ID в /tech/vp, затем обновите каталог',
        );
        await api.saveChannelCatalog([]);
        return;
      }

      const guild = await client.guilds.fetch(gid);
      const channels = await guild.channels.fetch();
      const items: {
        id: string;
        name: string;
        type: number;
        parentId: string | null;
        position: number;
      }[] = [];

      for (const ch of channels.values()) {
        if (!ch) continue;
        if (!CATALOG_CHANNEL_TYPES.has(ch.type)) continue;
        items.push({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          parentId: 'parentId' in ch && ch.parentId ? ch.parentId : null,
          position: 'position' in ch ? ch.position : 0,
        });
      }

      items.sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return a.name.localeCompare(b.name, 'ru');
      });

      await api.saveChannelCatalog(items);
    } catch (e) {
      logWarn('channel-catalog-poller', e);
    } finally {
      tickBusy = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), INTERVAL_MS);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
