import type { GameStatus } from './types.js';

/**
 * Render a connect-message template, substituting `{host}`, `{ip}`, `{port}`,
 * and `{game}` placeholders with the supplied values.
 *
 * @param template - The connect-message template (e.g. `'connect at {host}:{port}'`).
 * @param values - Substitution values; `host`/`ip` default to `''` and `port` to `undefined` (rendered empty) when omitted.
 * @returns The template with every placeholder substituted.
 */
export function renderConnectMessage(
  template: string,
  values: { host?: string; ip?: string; port?: number; game: string },
): string {
  return template
    .replace(/\{host\}/g, values.host ?? '')
    .replace(/\{ip\}/g, values.ip ?? '')
    .replace(/\{port\}/g, values.port !== undefined ? String(values.port) : '')
    .replace(/\{game\}/g, values.game);
}

/**
 * Render a game's status as a Discord-ready message.
 *
 * When `connectMessage` is provided and state is `running`, it is rendered on
 * a second line with host, ip, port, and game placeholders substituted.
 * When absent, falls back to the original single-line address suffix.
 *
 * @param port - First exposed port for the port placeholder (optional).
 */
export function formatGameStatus(status: GameStatus, connectMessage?: string, port?: number): string {
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

  const addr = host ? ` — \`${host}\`` : '';
  return `${statusLine}${addr}`;
}
