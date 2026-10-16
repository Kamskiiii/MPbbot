import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * 1) корневой `.env` репозитория
 * 2) `vp-bot/.env` — перекрывает совпадающие ключи
 */
export function loadEnvFiles(): void {
  const here = __dirname;
  const repoRoot = resolve(here, '..', '..');
  const botRoot = resolve(here, '..');
  const rootEnv = resolve(repoRoot, '.env');
  const botEnv = resolve(botRoot, '.env');
  if (existsSync(rootEnv)) {
    config({ path: rootEnv });
  }
  if (existsSync(botEnv)) {
    config({ path: botEnv, override: true });
  }
}

loadEnvFiles();
