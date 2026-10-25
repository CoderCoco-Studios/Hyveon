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
 * These calls resolve against Playwright `page.route()` stubs, not a real
 * API server, so they go out with only the headers each request supplies.
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
    // Folder upload is IPC-only in production with no HTTP route. This in-page fake scans a canned folder and
    // walks a run through starting-helper, uploading, verifying and done so specs can drive the whole UI flow.
    folderUpload: (() => {
      const listeners = new Set<(progress: unknown) => void>();
      let last: unknown = null;
      const emit = (progress: unknown): void => {
        last = progress;
        listeners.forEach((cb) => cb(progress));
      };
      const file = (relPath: string, size: number) => ({ name: relPath.split('/').pop(), kind: 'file', size, relPath });
      const scan = {
        scanId: 'e2e-scan',
        rootName: 'FoundryVTT',
        fileCount: 3,
        totalBytes: 1030,
        skippedLinks: 1,
        tree: {
          name: 'FoundryVTT',
          kind: 'dir',
          size: 1030,
          relPath: '',
          children: [
            { name: 'Config', kind: 'dir', size: 30, relPath: 'Config', children: [file('Config/a.json', 10), file('Config/b.json', 20)] },
            { name: 'Data', kind: 'dir', size: 1000, relPath: 'Data', children: [file('Data/w.db', 1000)] },
          ],
        },
      };
      const snapshot = (game: string, phase: string, bytesDone: number) => ({
        game,
        phase,
        bytesDone,
        bytesTotal: 1030,
        filesDone: bytesDone >= 1030 ? 3 : 1,
        filesTotal: 3,
        currentPath: 'Data/w.db',
        bytesPerSecond: 1024,
        etaSeconds: 1,
      });
      return {
        pickFolder: async () => scan,
        rescanSelection: async () => null,
        getSelection: async () => null,
        setSelection: async () => ({ saved: true }),
        startUpload: async (request: { game: string }) => {
          const steps: [string, number][] = [['starting-helper', 0], ['uploading', 515], ['verifying', 1030], ['done', 1030]];
          steps.forEach(([phase, bytes], i) => setTimeout(() => emit(snapshot(request.game, phase, bytes)), 100 * (i + 1)));
          return { started: true, runId: 'e2e-run' };
        },
        cancelUpload: async () => ({ cancelled: true }),
        getProgress: async () => last,
        cleanupStrayHelpers: async () => ({ stopped: [], skipped: 0, revokedRules: 0, errors: [] }),
        onProgress: (cb: (progress: unknown) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      };
    })(),
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
      // `diagnostics.exportBundle`/`.showInFolder` are IPC-only in production
      // with no HTTP route — same situation as `iac.settings.update` below.
      // Unlike `tail`/`path`, nothing calls this unconditionally on mount
      // (only an explicit "Export diagnostics bundle" click in
      // `DiagnosticsPanel`), so a throwing stub — never exercised by a
      // chromium spec that merely visits `/settings` — is correct here.
      exportBundle: () => {
        throw new Error('diagnostics.exportBundle has no HTTP route in the chromium e2e tier.');
      },
      showInFolder: () => {
        throw new Error('diagnostics.showInFolder has no HTTP route in the chromium e2e tier.');
      },
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
        // Click-triggered, not called on mount, so no spec needs this to
        // resolve merely by visiting `/settings` — added for parity with
        // the two stubs above and in case a future spec exercises the
        // "Check for Updates" button under chromium.
        autoUpdateCheck: async () => ({
          ok: false,
          message: 'iac.settings.autoUpdate.check has no HTTP route in the chromium e2e tier.',
        }),
      },
    },
  };
}
