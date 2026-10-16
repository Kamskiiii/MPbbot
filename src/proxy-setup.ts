/**
 * Прокси для Discord Gateway (WebSocket) и REST.
 * Импорт сразу после load-env и до discord.js.
 *
 * Env: DISCORD_PROXY=socks5://127.0.0.1:10808
 *
 * На Node @discordjs/ws берёт WebSocket из require('ws'), НЕ из globalThis
 * (shouldUseGlobalFetchAndWebSocket === false). Патчим Module.require('ws').
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export type DiscordProxyRestAgent = Dispatcher;

const WS_HANDSHAKE_MS = 120_000;
const LOCAL_HTTP = 'http://127.0.0.1:10809';
const LOCAL_SOCKS = 'socks5h://127.0.0.1:10808';

let restAgent: DiscordProxyRestAgent | undefined;
let proxyUrl: string | undefined;

function resolveProxyUrlRaw(): string | undefined {
  const raw =
    process.env.DISCORD_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    '';
  return raw || undefined;
}

function isSocksUrl(url: string): boolean {
  return /^socks5?h?:\/\//i.test(url);
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1'
  );
}

function normalizeSocks(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'socks5:' || u.protocol === 'socks:') {
      u.protocol = 'socks5h:';
    }
    return u.toString();
  } catch {
    return url;
  }
}

function splitProxies(raw: string): { rest: string; ws: string; note?: string } {
  const overrideRest = process.env.DISCORD_PROXY_REST?.trim();
  const overrideWs = process.env.DISCORD_PROXY_WS?.trim();
  if (overrideRest || overrideWs) {
    const rest = overrideRest || (isSocksUrl(raw) ? LOCAL_HTTP : raw);
    const ws =
      overrideWs || (isSocksUrl(raw) ? normalizeSocks(raw) : LOCAL_SOCKS);
    if (isSocksUrl(rest)) {
      throw new Error(
        'DISCORD_PROXY_REST должен быть http(s):// — undici не принимает socks',
      );
    }
    return { rest, ws };
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { rest: raw, ws: raw };
  }

  const local = isLocalHost(u.hostname);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');

  if (isSocksUrl(raw)) {
    if (local && (port === '10808' || port === '1080' || !u.port)) {
      return {
        rest: LOCAL_HTTP,
        ws: LOCAL_SOCKS,
        note: 'REST :10809 + патч require("ws") → SOCKS',
      };
    }
    throw new Error(
      'Задайте DISCORD_PROXY_REST=http://… и DISCORD_PROXY_WS=socks5h://…',
    );
  }

  if (
    local &&
    (u.protocol === 'http:' || u.protocol === 'https:') &&
    port === '10809'
  ) {
    return {
      rest: LOCAL_HTTP,
      ws: LOCAL_SOCKS,
      note: 'REST :10809 + патч require("ws") → SOCKS',
    };
  }

  return { rest: raw, ws: raw };
}

function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    return '(invalid-proxy-url)';
  }
}

function createWsAgent(url: string): object {
  if (isSocksUrl(url)) {
    return new SocksProxyAgent(normalizeSocks(url));
  }
  return new HttpsProxyAgent(url);
}

function isWsModuleId(id: string, parent: NodeModule | undefined): boolean {
  if (id === 'ws') return true;
  try {
    const resolved = (Module as unknown as {
      _resolveFilename: (r: string, p: NodeModule | undefined) => string;
    })._resolveFilename(id, parent);
    const norm = resolved.replace(/\\/g, '/');
    return /\/node_modules\/ws\/(index\.js)?$/.test(norm) || norm.endsWith('/node_modules/ws');
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WsCtor = any;

function wrapWsExports(wsMod: WsCtor, agent: object): WsCtor {
  if (wsMod && (wsMod as { __vdvProxied?: boolean }).__vdvProxied) {
    return wsMod;
  }

  const Original: WsCtor =
    typeof wsMod === 'function'
      ? wsMod
      : wsMod?.WebSocket || wsMod?.default || wsMod;

  class ProxiedWebSocket extends Original {
    constructor(
      address: string | URL,
      protocols?: unknown,
      options?: Record<string, unknown>,
    ) {
      let protos: string | string[] | undefined;
      let opts: Record<string, unknown> | undefined = options;
      if (
        protocols !== undefined &&
        typeof protocols === 'object' &&
        !Array.isArray(protocols)
      ) {
        opts = protocols as Record<string, unknown>;
        protos = undefined;
      } else {
        protos = protocols as string | string[] | undefined;
      }

      super(address, protos, {
        ...opts,
        agent,
        handshakeTimeout: (opts?.handshakeTimeout as number) ?? WS_HANDSHAKE_MS,
      });

      this.on('error', (err: Error) => {
        console.warn(`Discord WebSocket (прокси): ${err.message}`);
      });
    }
  }

  // Статики CONNECTING/OPEN/… уже наследуются; Object.assign падает (read-only).
  (ProxiedWebSocket as { __vdvProxied?: boolean }).__vdvProxied = true;

  if (typeof wsMod === 'function') {
    const out = ProxiedWebSocket as WsCtor;
    out.WebSocket = ProxiedWebSocket;
    out.default = ProxiedWebSocket;
    out.__vdvProxied = true;
    return out;
  }

  return {
    ...wsMod,
    WebSocket: ProxiedWebSocket,
    default: ProxiedWebSocket,
    __vdvProxied: true,
  };
}

function installWsRequireHook(agent: object): void {
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (
    this: NodeModule,
    id: string,
  ): unknown {
    const mod = originalRequire.apply(this, arguments as unknown as [string]);
    if (isWsModuleId(id, this)) {
      return wrapWsExports(mod, agent);
    }
    return mod;
  };

  // Прогрев кэша: следующий require('ws') из @discordjs/ws получит обёртку
  const nodeRequire = createRequire(__filename);
  try {
    const wsPath = nodeRequire.resolve('ws');
    const raw = originalRequire.call({ filename: __filename } as NodeModule, wsPath);
    const wrapped = wrapWsExports(raw, agent);
    const cached = nodeRequire.cache[wsPath];
    if (cached) cached.exports = wrapped;
    (globalThis as { WebSocket?: unknown }).WebSocket = wrapped.WebSocket || wrapped;
  } catch (e) {
    console.warn('Discord-прокси: не удалось прогреть ws:', e);
  }
}

const raw = resolveProxyUrlRaw();
if (raw) {
  try {
    const { rest, ws, note } = splitProxies(raw);
    proxyUrl = ws;
    restAgent = new ProxyAgent(rest);
    try {
      setGlobalDispatcher(restAgent);
    } catch (e) {
      console.warn('setGlobalDispatcher:', e);
    }
    installWsRequireHook(createWsAgent(ws));
    console.info(
      `Discord-прокси: REST ${redactProxyUrl(rest)} | WS ${redactProxyUrl(ws)}` +
        (note ? ` (${note})` : ''),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Discord-прокси: ошибка конфигурации: ${msg}`);
    throw e;
  }
}

export function getDiscordProxyRestAgent(): DiscordProxyRestAgent | undefined {
  return restAgent;
}

export function getDiscordProxyUrl(): string | undefined {
  return proxyUrl;
}
