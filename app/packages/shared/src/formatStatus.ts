import { HTTPS_CONNECT_PORT, type ConnectPort } from './gameServerPorts.js';
import type { GameStatus } from './types.js';

/**
 * Render a connect-message template, substituting `{host}`, `{ip}`, `{port}`,
 * and `{game}` placeholders with the supplied values.
 *
 * @remarks
 * When `port` is {@link HTTPS_CONNECT_PORT} and a host is known, `{host}:{port}` renders as
 * `https://{host}` (a template already carrying `http(s)://` keeps its scheme); any other `{port}` renders as `443`.
 *
 * @param template - The connect-message template (e.g. `'connect at {host}:{port}'`).
 * @param values - Substitution values; `host`/`ip` default to `''` and `port` to `undefined` (rendered empty) when omitted.
 * @returns The template with every placeholder substituted.
 */
export function renderConnectMessage(
  template: string,
  values: { host?: string; ip?: string; port?: ConnectPort; game: string },
): string {
  const isHttps = values.port === HTTPS_CONNECT_PORT;
  const source =
    isHttps && values.host
      ? template.replace(/(https?:\/\/)?\{host\}:\{port\}/g, (_match, scheme?: string) => `${scheme ?? 'https://'}{host}`)
      : template;
  const port = isHttps ? '443' : values.port !== undefined ? String(values.port) : '';
  return source
    .replace(/\{host\}/g, values.host ?? '')
    .replace(/\{ip\}/g, values.ip ?? '')
    .replace(/\{port\}/g, port)
    .replace(/\{game\}/g, values.game);
}

/**
 * Render a game's status as a Discord-ready message.
 *
 * When `connectMessage` is provided and state is `running`, it is rendered on
 * a second line with host, ip, port, and game placeholders substituted.
 * When absent, falls back to the original single-line address suffix, rendered as `https://{host}` for
 * {@link HTTPS_CONNECT_PORT} games.
 *
 * @param port - First exposed port for the port placeholder, or {@link HTTPS_CONNECT_PORT} (optional).
 */
export function formatGameStatus(status: GameStatus, connectMessage?: string, port?: ConnectPort): string {
  const emoji =
    status.state === 'running' ? '🟢'
    : status.state === 'starting' ? '🟡'
    : status.state === 'stopped' ? '⚫'
    : '⚠️';
  const host = status.hostname ?? status.publicIp;
  const statusLine = `${emoji} **${status.game}**: ${status.state}`;

  if (connectMessage && status.state === 'running') {
    const rendered = renderConnectMessage(connectMessage, { host, ip: status.publicIp, port, game: status.game });
    return `${statusLine}\n${rendered}`;
  }

  const shown = host && port === HTTPS_CONNECT_PORT ? `https://${host}` : host;
  const addr = shown ? ` — \`${shown}\`` : '';
  return `${statusLine}${addr}`;
}
