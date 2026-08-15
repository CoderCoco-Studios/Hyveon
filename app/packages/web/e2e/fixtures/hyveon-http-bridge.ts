/**
 * Browser-side test shim that installs `window.hyveon` as a thin HTTP forwarder.
 *
 * Production builds receive `window.hyveon` from the Electron preload script, but
 * the tier-1 `chromium` Playwright project runs the web bundle in a plain
 * browser with no Electron host. Since `api.service.ts` now talks exclusively
 * to `window.hyveon.*`, this shim re-routes each IPC-shaped call back to the
 * matching `/api/*` HTTP endpoint — which is exactly what the chromium
 * stub-based specs already provide via `page.route`. That keeps every
 * existing stub and HTTP-contract assertion working unchanged while the app
 * speaks IPC. The tier-1 `electron` project drives the real preload bridge
 * instead, and tier-2 integration specs exercise the app through the
 * in-process IPC test harness — neither uses this shim.
 *
 * Pass this function (not a call to it) to `page.addInitScript` so it runs in
 * the browser before any app code:
 *
 * ```ts
 * await page.addInitScript(installHyveonHttpBridge);
 * ```
 *
 * It is intentionally self-contained — it closes over no module-scope bindings —
 * because Playwright serialises it to source and re-evaluates it in the page.
 * The Nest API no longer requires a bearer token, so calls go out with only the
 * headers each request supplies.
 */
export function installHyveonHttpBridge(): void {
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(path, init);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  };

  const post = (path: string): Promise<unknown> => call(path, { method: 'POST' });
  const del = (path: string): Promise<unknown> => call(path, { method: 'DELETE' });
  const withBody = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  (window as unknown as Record<string, unknown>)['hyveon'] = {
    env: { get: () => call('/api/env') },
    games: {
      list: () => call('/api/games'),
      status: () => call('/api/status'),
      getStatus: (game: string) => call(`/api/status/${game}`),
      start: (game: string) => post(`/api/start/${game}`),
      stop: (game: string) => post(`/api/stop/${game}`),
    },
    costs: {
      estimate: () => call('/api/costs/estimate'),
    },
    files: {
      list: (game: string) => call(`/api/files/${game}`),
      start: (game: string) => post(`/api/files/${game}/start`),
      stop: (game: string) => post(`/api/files/${game}/stop`),
    },
    discord: {
      getConfig: () => call('/api/discord/config'),
      putConfig: (body: unknown) => call('/api/discord/config', withBody('PUT', body)),
      addGuild: (guildId: string) => call('/api/discord/guilds', withBody('POST', { guildId })),
      removeGuild: (guildId: string) => del(`/api/discord/guilds/${guildId}`),
      registerCommands: (guildId: string) => post(`/api/discord/guilds/${guildId}/register-commands`),
      putAdmins: (body: unknown) => call('/api/discord/admins', withBody('PUT', body)),
      putPermission: (game: string, body: unknown) =>
        call(`/api/discord/permissions/${game}`, withBody('PUT', body)),
      deletePermission: (game: string) => del(`/api/discord/permissions/${game}`),
    },
    drift: {
      get: () => call('/api/drift'),
    },
    audit: {
      list: (opts?: { limit?: number; before?: string }) => {
        const params = new URLSearchParams();
        if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
        if (opts?.before !== undefined) params.set('before', opts.before);
        const qs = params.toString();
        return call(`/api/audit${qs ? `?${qs}` : ''}`);
      },
    },
    diagnostics: {
      tail: () => call('/api/diagnostics/tail'),
      path: () => call('/api/diagnostics/path'),
    },
    // Logs are IPC-only in production with no HTTP route; tier-1 overrides this
    // with a data-backed stub (see `stubApis`) and no tier-2 spec visits /logs,
    // so this forwarder exists only for shape completeness.
    logs: {
      get: (game: string, limit?: number) =>
        call(`/api/logs/${game}${limit ? `?limit=${limit}` : ''}`),
      stream: async function* () {},
      lambda: {
        get: async (functionKey: string) => ({ functionKey, lines: [] }),
        stream: async function* () {},
      },
    },
    // The deployment-settings editor is IPC-only in production with no HTTP
    // route — same situation as `logs` above. `get()` resolves
    // a `setup_incomplete` result rather than throwing: `DeploymentSettingsForm`
    // already renders that outcome as a quiet informational message (not a
    // red alert), which is the closest honest stand-in this HTTP-less shim
    // can give for "no real deployment configuration in this test tier". No
    // chromium spec exercises the settings form's real read/write behaviour
    // (that's covered by the `web` Vitest project's own component test), so
    // this stub exists only so `/settings` doesn't render an "IPC bridge not
    // available" error for a namespace that, from the chromium tier's own
    // perspective, actually is unavailable.
    iac: {
      settings: {
        get: async () => ({
          ok: false,
          code: 'setup_incomplete',
          message: 'Deployment settings are not available in this test tier (no HTTP route — see hyveon-http-bridge.ts).',
        }),
        update: async () => {
          throw new Error('iac.settings.update has no HTTP route in the chromium e2e tier.');
        },
        // Task 10.4's `iac.settings.engineVersion` is IPC-only in production
        // with no HTTP route — same situation as `get`/`update` above.
        // `resolvedVersion: null` is a real, valid result shape (Settings'
        // Cloud Setup row renders it as "not yet provisioned"), so this stub
        // resolves rather than throws: no chromium spec exercises the engine
        // version row's real content (that's covered by the `web` Vitest
        // project's own `settings.page.test.tsx`), but every spec that
        // merely visits `/settings` needs this call to resolve instead of
        // throwing `TypeError: settings.engineVersion is not a function`,
        // which the page's mount effect does not catch — that class of
        // error is a synchronous throw, not a rejected promise.
        engineVersion: async () => ({ resolvedVersion: null }),
        // Same situation and same "resolve, don't throw" rationale as
        // `engineVersion` above — the Updates section's mount effect calls
        // this unconditionally, so a chromium spec that merely visits
        // `/settings` needs it to resolve, not throw `TypeError:
        // settings.autoUpdateGet is not a function`.
        autoUpdateGet: async () => ({ ok: true, enableAutoUpdate: false }),
        autoUpdateUpdate: async () => ({
          ok: false,
          code: 'error',
          message: 'iac.settings.autoUpdate.update has no HTTP route in the chromium e2e tier.',
        }),
      },
    },
  };
}
