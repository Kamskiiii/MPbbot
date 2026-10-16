import { Client } from 'discord.js';
import type { createApiClient } from './api';

type ApiFactory = (baseUrl: string) => ReturnType<typeof createApiClient>;

const INTERVAL_MS = 25_000;

export function startInvestigatorChoicesPoller(
  client: Client,
  backendUrl: string,
  apiForUrl: ApiFactory,
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const api = apiForUrl(backendUrl);
      const cfg = await api.getBotConfig();
      if (!cfg.googleFormInvestigatorChoicesSyncRequested) return;

      const guildId = cfg.guildId?.trim();
      const roleId = cfg.googleFormInvestigatorRoleId?.trim();
      if (!guildId || !roleId) {
        await api.saveInvestigatorChoices([]);
        console.warn(
          'investigator-choices: задайте guildId и googleFormInvestigatorRoleId в /tech/vp',
        );
        return;
      }

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        throw new Error('Guild ВП не найден');
      }

      await guild.members.fetch();
      const names = [
        ...new Set(
          guild.members.cache
            .filter((m) => !m.user.bot && m.roles.cache.has(roleId))
            .map((m) => m.displayName.trim())
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b, 'ru'));

      await api.saveInvestigatorChoices(names);
    } catch (e) {
      console.warn('investigator-choices-poller', e);
    } finally {
      busy = false;
    }
  }

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
