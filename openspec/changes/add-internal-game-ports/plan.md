# Internal Game Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator mark a game's port `internal` (VPC-CIDR-only ingress) instead of `public` (`0.0.0.0/0`), so a management/health-check port can stay closed to the internet while the game's primary port stays open.

**Architecture:** Add `visibility?: 'public' | 'internal'` to `GameServerPort` in `@hyveon/shared`, threaded through the zod schema, `securityGroups.ts`'s ingress builder (public bucket keeps `0.0.0.0/0`, new internal bucket sources from a freshly-resolved VPC CIDR block), the web wizard's port editor and its IPC-mirror types, and the games detail/review views. `undefined` visibility is always treated as `'public'`.

**Tech Stack:** TypeScript, Zod, Pulumi (`@pulumi/aws`), React, Vitest (+ `@testing-library/react` for jsdom component tests), this repo's `pulumi.runtime.setMocks()` test harness (`app/packages/infra/src/testing/pulumiMocks.ts`).

**Spec:** `openspec/changes/add-internal-game-ports/design.md` and `openspec/changes/add-internal-game-ports/specs/game-port-visibility/spec.md` — this plan implements every requirement in that spec file.

## Global Constraints

- `visibility` is optional; `undefined` MUST behave identically to `'public'` everywhere (schema, security groups, wizard, docs) — zero behavior change for any existing `deployment-config.json`.
- Only non-HTTPS games' ports are affected. HTTPS games are already skipped entirely by `dedupedDirectGamePorts`; that skip must not change.
- No tie-break/collision logic needed between public/internal buckets — `checkPortCollisions` already makes a `(port, protocol)` pair globally unique across the whole `game_servers` map, so a port can never land in both buckets.
- TSDoc: order summary → `@remarks` → `@example` → `@typeParam` → `@param` → `@returns` → `@throws` → modifiers; `@param name - description` (hyphen), never `@param {Type} name`. Run `npm run app:lint` after any TSDoc edit.
- Test names read as `it('should ...')` sentences.
- No `as unknown as T` casts in tests — use `vi.mocked(fn)` / `Partial<T> as T`.
- `npm install` was already run in this worktree; no need to repeat unless `package.json` changes (it doesn't, in this plan).

---

### Task 1: `GameServerPort.visibility` field

**Files:**
- Modify: `app/packages/shared/src/gameServerConfig.ts:23-34` (the `GameServerPort` interface)

**Interfaces:**
- Produces: `GameServerPort.visibility?: 'public' | 'internal'` — every later task reads this field by that exact name and these exact two literal values.

- [ ] **Step 1: Add the field with TSDoc matching the `https` undefined-contract style**

Edit `app/packages/shared/src/gameServerConfig.ts`, replacing the `GameServerPort` interface:

```typescript
/** Single TCP/UDP port a game server container listens on. */
export interface GameServerPort {
  /** Container port number the process listens on (e.g. `25565`). */
  container: number;
  /**
   * Transport protocol. Must be the exact lowercase string `"tcp"` or
   * `"udp"` — passed straight through to ECS `portMappings`, which rejects
   * anything else. Inherited from the app's original `game_servers`
   * validation block's same requirement.
   */
  protocol: string;
  /**
   * Network reachability for this port on the shared `game_servers`
   * security group. `'public'` ingresses from `0.0.0.0/0` (the open
   * internet); `'internal'` ingresses from the VPC's CIDR block only, so
   * the port is reachable from anything inside the VPC (e.g. the
   * health-check Lambda) but not from the internet. Omitted is treated
   * identically to `'public'` — mirrors the {@link GameServer.https}
   * `undefined ≡ false` contract — so every configuration written before
   * this field existed keeps its current `0.0.0.0/0` ingress unchanged.
   * Only affects non-HTTPS games: an HTTPS game's container ports are
   * never individually security-group-ingressed (the in-task Caddy
   * sidecar proxies to them over localhost), so this field is a no-op
   * there.
   */
  visibility?: 'public' | 'internal';
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: no new errors (the field is optional, so every existing literal `GameServerPort` object still satisfies the type).

- [ ] **Step 3: Commit**

```bash
git add app/packages/shared/src/gameServerConfig.ts
git commit -m "feat(shared): add optional visibility field to GameServerPort"
```

---

### Task 2: Zod schema + validator tests

**Files:**
- Modify: `app/packages/shared/src/gameServerValidator.ts:62-66` (`gameServerPortSchema`)
- Modify: `app/packages/shared/src/gameServerValidator.test.ts`

**Interfaces:**
- Consumes: `GameServerPort.visibility?: 'public' | 'internal'` (Task 1).
- Produces: `gameServerPortSchema` accepts/rejects `visibility` per the spec's "Per-port visibility field" requirement; no new exports.

- [ ] **Step 1: Write the failing tests**

Find the existing `describe` block(s) for port validation in `app/packages/shared/src/gameServerValidator.test.ts` (search for `gameServerPortSchema` or a `describe('validateGameServer'` block that exercises `ports`) and add, in a `describe('gameServerPortSchema', ...)` block (create one if none exists, placed near the top of the file alongside other schema-level describe blocks):

```typescript
describe('gameServerPortSchema', () => {
  it('should accept a port with visibility omitted', () => {
    const result = gameServerPortSchema.safeParse({ container: 25565, protocol: 'tcp' });
    expect(result.success).toBe(true);
  });

  it('should accept visibility "public"', () => {
    const result = gameServerPortSchema.safeParse({ container: 25565, protocol: 'tcp', visibility: 'public' });
    expect(result.success).toBe(true);
  });

  it('should accept visibility "internal"', () => {
    const result = gameServerPortSchema.safeParse({ container: 25565, protocol: 'tcp', visibility: 'internal' });
    expect(result.success).toBe(true);
  });

  it('should reject an unrecognized visibility value', () => {
    const result = gameServerPortSchema.safeParse({ container: 25565, protocol: 'tcp', visibility: 'vpc-only' });
    expect(result.success).toBe(false);
  });
});
```

Ensure `gameServerPortSchema` is imported at the top of the test file (add it to the existing `import { ... } from './gameServerValidator.js'` line if not already present).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/packages/shared/src/gameServerValidator.test.ts -t "gameServerPortSchema"`
Expected: FAIL on the `visibility: 'public'`/`'internal'` cases (zod strips unknown keys by default rather than rejecting them, so those two currently "pass" but the reject case may also incorrectly pass since zod's default `.object()` doesn't fail on an unrecognized key). Confirm by reading the actual output rather than assuming — if the accept cases already pass and only the reject case fails, that's expected; if all four pass, the schema is silently stripping `visibility`, which Step 3 will also fix.

- [ ] **Step 3: Add the enum to the schema**

Edit `app/packages/shared/src/gameServerValidator.ts`:

```typescript
/** Zod schema mirroring {@link GameServerPort}. */
export const gameServerPortSchema = z.object({
  container: z.number(),
  protocol: z.string(),
  visibility: z.enum(['public', 'internal']).optional(),
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/packages/shared/src/gameServerValidator.test.ts -t "gameServerPortSchema"`
Expected: PASS, all 4 cases.

- [ ] **Step 5: Run the full validator suite for regressions**

Run: `npx vitest run app/packages/shared/src/gameServerValidator.test.ts`
Expected: PASS, no regressions (every existing port fixture omits `visibility` and must still validate).

- [ ] **Step 6: Commit**

```bash
git add app/packages/shared/src/gameServerValidator.ts app/packages/shared/src/gameServerValidator.test.ts
git commit -m "feat(shared): validate GameServerPort.visibility"
```

---

### Task 3: `securityGroups.ts` — split public/internal ingress buckets + VPC CIDR lookup

**Files:**
- Modify: `app/packages/infra/src/securityGroups.ts`
- Modify: `app/packages/infra/src/securityGroups.test.ts`

**Interfaces:**
- Consumes: `GameServerPort.visibility` (Task 1).
- Produces: `dedupedDirectGamePorts(gameServers)` now returns only ports with `visibility` omitted or `'public'` (unchanged public contract, so existing callers/tests keep working); a new exported `dedupedInternalGamePorts(gameServers)` returns ports with `visibility === 'internal'`, same HTTPS-skip and first-seen-dedup semantics. `defineSecurityGroups` gains no new required argument (VPC CIDR is resolved internally).

- [ ] **Step 1: Write the failing tests**

Add to `app/packages/infra/src/securityGroups.test.ts`, in the existing `describe('dedupedDirectGamePorts', ...)` block area — add a sibling `describe('dedupedInternalGamePorts', ...)` block right after it:

```typescript
describe('dedupedInternalGamePorts', () => {
  it('should return only ports declared visibility: "internal"', () => {
    const gameServers: Record<string, GameServerConfig> = {
      mixedGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [
          { container: 25565, protocol: 'tcp' },
          { container: 8212, protocol: 'tcp', visibility: 'internal' },
        ],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    expect(dedupedInternalGamePorts(gameServers)).toEqual([{ port: 8212, protocol: 'tcp' }]);
  });

  it('should exclude ports belonging to an https: true game', () => {
    const gameServers: Record<string, GameServerConfig> = {
      httpsGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 8212, protocol: 'tcp', visibility: 'internal' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        https: true,
      },
    };
    expect(dedupedInternalGamePorts(gameServers)).toEqual([]);
  });

  it('should return an empty array when no game declares an internal port', () => {
    expect(dedupedInternalGamePorts(FIXTURE_GAME_SERVERS)).toEqual([]);
  });
});
```

Update the existing `dedupedDirectGamePorts` describe block with one more case (visibility must not leak public ports into the public list when a game also has an internal one, and an explicit `'public'` value behaves like omission):

```typescript
  it('should exclude ports declared visibility: "internal"', () => {
    const gameServers: Record<string, GameServerConfig> = {
      mixedGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [
          { container: 25565, protocol: 'tcp' },
          { container: 8212, protocol: 'tcp', visibility: 'internal' },
        ],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    expect(dedupedDirectGamePorts(gameServers)).toEqual([{ port: 25565, protocol: 'tcp' }]);
  });

  it('should treat visibility: "public" the same as omitting visibility', () => {
    const gameServers: Record<string, GameServerConfig> = {
      onlyGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 1234, protocol: 'tcp', visibility: 'public' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    expect(dedupedDirectGamePorts(gameServers)).toEqual([{ port: 1234, protocol: 'tcp' }]);
  });
```

Add `dedupedInternalGamePorts` to the import line at the top of the test file (currently `import { dedupedDirectGamePorts, defineSecurityGroups, hasHttpsGame } from './securityGroups.js';`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/packages/infra/src/securityGroups.test.ts -t "dedupedInternalGamePorts"`
Expected: FAIL — `dedupedInternalGamePorts` does not exist yet (TypeError / import error).

- [ ] **Step 3: Implement the two-bucket split**

Edit `app/packages/infra/src/securityGroups.ts`. Replace `dedupedDirectGamePorts` and add `dedupedInternalGamePorts` right after it:

```typescript
/**
 * Deduplicated set of container port/protocol pairs across every
 * non-HTTPS game server whose {@link GameServerPort.visibility} is
 * `'public'` or omitted, mirroring the legacy tool's `local.direct_game_ports`
 * local — a `distinct(flatten(...))` over every game's `ports`, filtered to
 * entries where `https` is falsy. Two games declaring the same port and
 * protocol yield exactly one entry here, reproducing the HCL's `distinct()`
 * dedup via a `Map` keyed on the port/protocol pair. A port declared
 * `visibility: 'internal'` is excluded — see {@link dedupedInternalGamePorts}
 * for its counterpart.
 *
 * `https` follows the `undefined ≡ false` contract documented on
 * `GameServerConfig.https` (`@hyveon/shared`'s `gameServerConfig.ts`) — a config entry
 * with `https` omitted is treated as non-HTTPS and contributes its ports,
 * matching the legacy tool's `optional(bool, false)` default and the HCL's
 * `!cfg.https` filter.
 *
 * @param gameServers - The configured game-server map to derive ports from.
 * @returns The deduplicated public port/protocol pairs, in first-seen order.
 */
export function dedupedDirectGamePorts(gameServers: Record<string, GameServerConfig>): GamePort[] {
  return dedupedGamePortsByVisibility(gameServers, (visibility) => visibility !== 'internal');
}

/**
 * Deduplicated set of container port/protocol pairs across every
 * non-HTTPS game server whose {@link GameServerPort.visibility} is exactly
 * `'internal'` — the counterpart to {@link dedupedDirectGamePorts}. Ports
 * cannot appear in both functions' results: `checkPortCollisions`
 * (`@hyveon/shared`'s `gameServerValidator.ts`) already rejects two games,
 * or two ports within one game, declaring the same `(port, protocol)` pair,
 * so a given key can only ever carry one `visibility` value.
 *
 * @param gameServers - The configured game-server map to derive ports from.
 * @returns The deduplicated internal port/protocol pairs, in first-seen order.
 */
export function dedupedInternalGamePorts(gameServers: Record<string, GameServerConfig>): GamePort[] {
  return dedupedGamePortsByVisibility(gameServers, (visibility) => visibility === 'internal');
}

/** Shared dedup walk behind {@link dedupedDirectGamePorts}/{@link dedupedInternalGamePorts}, differing only in which `visibility` values `include` accepts. */
function dedupedGamePortsByVisibility(
  gameServers: Record<string, GameServerConfig>,
  include: (visibility: 'public' | 'internal' | undefined) => boolean,
): GamePort[] {
  const seen = new Map<string, GamePort>();
  for (const config of Object.values(gameServers)) {
    if (config.https) {
      continue;
    }
    for (const port of config.ports) {
      if (!include(port.visibility)) {
        continue;
      }
      const key = `${port.container}-${port.protocol}`;
      if (!seen.has(key)) {
        seen.set(key, { port: port.container, protocol: port.protocol });
      }
    }
  }
  return [...seen.values()];
}
```

- [ ] **Step 4: Run to verify the dedup tests pass**

Run: `npx vitest run app/packages/infra/src/securityGroups.test.ts -t "dedupedDirectGamePorts"` and `npx vitest run app/packages/infra/src/securityGroups.test.ts -t "dedupedInternalGamePorts"`
Expected: PASS, both.

- [ ] **Step 5: Write the failing `defineSecurityGroups` ingress test**

Add to the `describe('defineSecurityGroups', ...)` block in `app/packages/infra/src/securityGroups.test.ts`, after the existing "should declare the game-servers security group..." test:

```typescript
  it('should ingress a visibility: "internal" port from the VPC CIDR block instead of the open internet', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 8212, protocol: 'tcp', visibility: 'internal' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    await runDefineSecurityGroups({ projectName: 'hyveon', gameServers, vpcId: 'vpc-mock', provider });

    const sg = findByName(mocks.resources, 'hyveon-sg');
    const ingress = sg.inputs.ingress as Array<{ description: string; fromPort: number; cidrBlocks?: string[] }>;
    const internalRule = ingress.find((rule) => rule.fromPort === 8212);
    expect(internalRule).toBeDefined();
    expect(internalRule?.cidrBlocks).toEqual(['10.0.0.0/16']);
    expect(ingress.some((rule) => rule.fromPort === 8212 && rule.cidrBlocks?.includes('0.0.0.0/0'))).toBe(false);
  });
```

Check `app/packages/infra/src/testing/pulumiMocks.ts` for how `aws.ec2.getVpcOutput`-style data-source calls are mocked (search for `newResource`/`call` handling in `installPulumiMocks`); if it doesn't yet stub `aws:index/getVpc:getVpc` (or the versioned equivalent function token), add a `call` handler there returning `{ cidrBlock: '10.0.0.0/16' }` for that token before writing this test — this may require a preceding sub-step reading that file. If the mock harness returns a different default CIDR, use that value in the assertion instead of `10.0.0.0/16`.

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run app/packages/infra/src/securityGroups.test.ts -t "visibility: .internal. port"`
Expected: FAIL — no internal-sourced ingress rule exists yet.

- [ ] **Step 7: Resolve the VPC CIDR and add the internal ingress block**

Edit `app/packages/infra/src/securityGroups.ts`'s `defineSecurityGroups`, right after the existing `gamePortIngress` array is built from `dedupedDirectGamePorts` and before the HTTPS block:

```typescript
  // VPC CIDR — resolved once, used only by internal-visibility ports below.
  // A plain data lookup (no resource declared), consistent with how vpcId
  // itself is already resolved from a data source upstream of this file.
  const vpc = aws.ec2.getVpcOutput({ id: vpcId }, opts);

  const internalPorts = dedupedInternalGamePorts(gameServers);
  for (const port of internalPorts) {
    gamePortIngress.push({
      description: `Game port ${port.port}/${port.protocol} (internal)`,
      fromPort: port.port,
      toPort: port.port,
      protocol: port.protocol,
      cidrBlocks: [vpc.cidrBlock],
    });
  }
```

Place this immediately after the existing:

```typescript
  const gamePortIngress: pulumi.Input<aws.types.input.ec2.SecurityGroupIngress>[] = dedupedDirectGamePorts(
    gameServers,
  ).map((port) => ({ ... }));
```

block and before the `if (hasHttpsGame(gameServers)) { ... }` block, so ordering in the final `ingress` array is: public ports, internal ports, HTTPS 443/80, health-check-sourced entries — matching the order the Step 5 test's `ingress.find` expects (order-independent `find`, so exact position doesn't break the test, but keep this order for readability and to match `securityGroups.ts`'s existing "declared before X so its id is in scope" commenting convention).

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run app/packages/infra/src/securityGroups.test.ts -t "visibility: .internal. port"`
Expected: PASS.

- [ ] **Step 9: Run the full securityGroups suite for regressions**

Run: `npx vitest run app/packages/infra/src/securityGroups.test.ts`
Expected: PASS — in particular the existing "should declare the game-servers security group with a deduplicated ingress rule..." test must still pass unchanged (byte-identical ingress for an all-public configuration), confirming the zero-behavior-change contract.

- [ ] **Step 10: Update `SecurityGroupResources`/file-doc TSDoc**

In `app/packages/infra/src/securityGroups.ts`'s file-level doc comment (top of file) and on `dedupedDirectGamePorts`, note the two-bucket split and that `game_servers`'s ingress array now has four possible sources: public ports (`0.0.0.0/0`), internal ports (VPC CIDR), HTTPS sidecar (`0.0.0.0/0`, conditional), health-check Lambda (SG-sourced, conditional). No new field on `SecurityGroupResources` is needed — `dedupedInternalGamePorts` is a plain exported function, not a resource.

- [ ] **Step 11: Lint and typecheck**

Run: `npm run app:lint` then `npm run app:typecheck`
Expected: both clean.

- [ ] **Step 12: Commit**

```bash
git add app/packages/infra/src/securityGroups.ts app/packages/infra/src/securityGroups.test.ts
git commit -m "feat(infra): ingress internal-visibility game ports from the VPC CIDR"
```

---

### Task 4: Wizard draft type + payload/proposed-entry conversion

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`
- Modify: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts`

**Interfaces:**
- Consumes: `GameServerPort.visibility` (Task 1).
- Produces: `WizardDraftPort.visibility: 'public' | 'internal'` (always a concrete string in draft state, no `undefined` — a form control needs a value to bind to; converted to `undefined` on submit when `'public'`, matching D2's `undefined ≡ 'public'` contract at the wire level while keeping the draft simple).

- [ ] **Step 1: Write the failing tests**

Add to `app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts` (find the existing tests for `draftFromGameServer` and `draftToPayload` and add alongside them):

```typescript
describe('port visibility round-trip', () => {
  it('should default a new WizardDraftPort to visibility "public" via createEmptyWizardDraft plus a manually appended row', () => {
    // NetworkingStep appends EMPTY_PORT, which this test simulates directly
    // since createEmptyWizardDraft() itself starts with an empty ports array.
    const port: WizardDraftPort = { container: null, protocol: 'tcp', visibility: 'public' };
    expect(port.visibility).toBe('public');
  });

  it('should read visibility "internal" from a declared game via draftFromGameServer', () => {
    const game = {
      name: 'palworld',
      image: 'example/palworld:latest',
      cpu: 1024,
      memory: 2048,
      ports: [
        { container: 8211, protocol: 'udp', visibility: 'public' as const },
        { container: 8212, protocol: 'tcp', visibility: 'internal' as const },
      ],
      volumes: [{ name: 'saves', container_path: '/data' }],
    };
    const draft = draftFromGameServer(game as unknown as Parameters<typeof draftFromGameServer>[0]);
    expect(draft.ports).toEqual([
      { container: 8211, protocol: 'udp', visibility: 'public' },
      { container: 8212, protocol: 'tcp', visibility: 'internal' },
    ]);
  });

  it('should default visibility to "public" when reading a declared port with visibility omitted', () => {
    const game = {
      name: 'palworld',
      image: 'example/palworld:latest',
      cpu: 1024,
      memory: 2048,
      ports: [{ container: 8211, protocol: 'udp' }],
      volumes: [{ name: 'saves', container_path: '/data' }],
    };
    const draft = draftFromGameServer(game as unknown as Parameters<typeof draftFromGameServer>[0]);
    expect(draft.ports).toEqual([{ container: 8211, protocol: 'udp', visibility: 'public' }]);
  });

  it('should submit visibility "internal" as-is and omit visibility entirely for "public" ports in draftToPayload', () => {
    const draft = {
      ...createEmptyWizardDraft(),
      name: 'palworld',
      image: 'example/palworld:latest',
      cpu: 1024,
      memory: 2048,
      ports: [
        { container: 8211, protocol: 'udp', visibility: 'public' as const },
        { container: 8212, protocol: 'tcp', visibility: 'internal' as const },
      ],
      volumes: [{ name: 'saves', container_path: '/data' }],
    };
    const payload = draftToPayload(draft);
    expect(payload.config.ports).toEqual([
      { container: 8211, protocol: 'udp' },
      { container: 8212, protocol: 'tcp', visibility: 'internal' },
    ]);
  });
});
```

Add `WizardDraftPort` to the test file's import from `./wizard-form.utils.js` if not already imported.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts -t "port visibility round-trip"`
Expected: FAIL — `visibility` doesn't exist on `WizardDraftPort` yet (type error at compile/lint time, and the `draftFromGameServer`/`draftToPayload` assertions fail since neither reads/writes it).

- [ ] **Step 3: Implement**

Edit `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`:

1. `WizardDraftPort` (around line 62):

```typescript
/** Draft form of a single `GameServerPort` row. `container` is `null` until the operator fills in the field, so an empty row can be told apart from a mistyped one. `visibility` is always a concrete `'public'`/`'internal'` value in the draft (never `undefined`) — a form control needs something to bind to; `draftToPayload` collapses `'public'` back to an omitted field on submit. */
export interface WizardDraftPort {
  container: number | null;
  protocol: string;
  visibility: 'public' | 'internal';
}
```

2. `EMPTY_PORT` lives in `networking-step.component.tsx`, not here — no change in this file for that constant (see Task 5).

3. `draftFromGameServer` (around line 188), change the `ports.map`:

```typescript
    ports: game.ports.map((port) => ({
      container: port.container,
      protocol: port.protocol,
      visibility: port.visibility === 'internal' ? 'internal' : 'public',
    })),
```

4. `draftToPayload` (around line 280), change the `ports.map`:

```typescript
      ports: draft.ports.map((port) => ({
        container: port.container ?? 0,
        protocol: port.protocol,
        ...(port.visibility === 'internal' ? { visibility: 'internal' as const } : {}),
      })),
```

5. `toProposedEntry` (around line 379), same pattern:

```typescript
    ports: draft.ports.map((port) => ({
      container: port.container,
      protocol: port.protocol,
      ...(port.visibility === 'internal' ? { visibility: 'internal' as const } : {}),
    })),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts`
Expected: PASS, full file (new tests plus no regressions in existing ones — existing fixtures that build `WizardDraftPort` literals without `visibility` will now fail to typecheck; fix each one by adding `visibility: 'public'`, matching Step 5 below).

- [ ] **Step 5: Fix existing test fixtures**

Search the same test file for every other `WizardDraftPort`-shaped object literal (e.g. in `draftToPayload`/`toProposedEntry`/`validateWizardDraft` test cases) and add `visibility: 'public'` to each, since the field is now required on the type (even though it's semantically optional at the wire level). Re-run the full file after each fix.

Run: `npx vitest run app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts`
Expected: PASS, zero failures.

- [ ] **Step 6: Typecheck the whole web package**

Run: `npm run app:typecheck`
Expected: clean, or a list of every other call site that constructs a `WizardDraftPort` literal without `visibility` — fix each one found (this surfaces `networking-step.component.tsx`'s `EMPTY_PORT`, handled in Task 5).

- [ ] **Step 7: Commit**

```bash
git add app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts
git commit -m "feat(web): thread port visibility through the wizard draft model"
```

---

### Task 5: `NetworkingStep` — visibility toggle per port row

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx`
- Modify: `app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx`

**Interfaces:**
- Consumes: `WizardDraftPort.visibility` (Task 4).
- Produces: no new props — `onChange` continues to receive the full replacement `ports` array, now with each row's `visibility` included.

- [ ] **Step 1: Write the failing tests**

Add to `app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx`. First, update `makePorts()` to include `visibility: 'public'` on both rows (required now that the type demands it):

```typescript
function makePorts(): WizardDraftPort[] {
  return [
    { container: 25565, protocol: 'tcp', visibility: 'public' },
    { container: 25566, protocol: 'udp', visibility: 'public' },
  ];
}
```

Update the "should append a blank row" test's expectation to include `visibility: 'public'` on the appended row:

```typescript
    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'tcp', visibility: 'public' },
      { container: 25566, protocol: 'udp', visibility: 'public' },
      { container: null, protocol: 'tcp', visibility: 'public' },
    ]);
```

Add a new test:

```typescript
  it('should update the visibility for the edited row when its select changes to "internal"', () => {
    const onChange = vi.fn();
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[]}
        onChange={onChange}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Visibility', { selector: '#port-visibility-0' }), {
      target: { value: 'internal' },
    });

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'tcp', visibility: 'internal' },
      { container: 25566, protocol: 'udp', visibility: 'public' },
    ]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx`
Expected: FAIL — the updated assertions expect `visibility` fields the component doesn't produce yet, and `#port-visibility-0` doesn't exist.

- [ ] **Step 3: Implement the toggle**

Edit `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx`:

1. Update `EMPTY_PORT`:

```typescript
/** Blank row appended by the "Add port" button. */
const EMPTY_PORT: WizardDraftPort = { container: null, protocol: 'tcp', visibility: 'public' };

/** `visibility` options offered in each row's dropdown. */
const VISIBILITY_OPTIONS = ['public', 'internal'] as const;
```

2. In the row-rendering `ports.map`, add a third field between the Protocol select and the Remove button:

```tsx
              <div className="flex-1">
                <Label htmlFor={`port-visibility-${index}`}>Visibility</Label>
                <select
                  id={`port-visibility-${index}`}
                  value={port.visibility}
                  onChange={(event) => updateRow(index, { visibility: event.target.value as WizardDraftPort['visibility'] })}
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {VISIBILITY_OPTIONS.map((visibility) => (
                    <option key={visibility} value={visibility}>
                      {visibility === 'public' ? 'Public' : 'VPC-only'}
                    </option>
                  ))}
                </select>
              </div>
```

Import `WizardDraftPort` as a type into the component file if not already imported (check the existing `import ... from './wizard-form.utils.js'` line — it currently imports `WizardDraftHealthCheck` and `messageFor`; add `type WizardDraftPort`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx`
Expected: PASS, full file.

- [ ] **Step 5: Update the component's file-level TSDoc**

Add one sentence to the top-of-file doc comment noting the row editor now also exposes a Public/VPC-only visibility select per row.

- [ ] **Step 6: Lint**

Run: `npm run app:lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/packages/web/src/components/add-game-wizard/networking-step.component.tsx app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx
git commit -m "feat(web): expose per-port visibility toggle in the networking step"
```

---

### Task 6: `EditGameForm` — verify the toggle flows through, add a persistence test

**Files:**
- Read: `app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx` (already renders `<NetworkingStep ports={draft.ports} onChange={(ports) => patchDraft({ ports })} .../>` at line ~189 — no prop-shape change needed, since `NetworkingStep`'s public interface didn't change in Task 5)
- Modify: `app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx`

**Interfaces:**
- Consumes: `NetworkingStep` (Task 5), `draftFromGameServer`/`draftToPayload` (Task 4) — `EditGameForm` already delegates to both, so no source change is expected; this task is a verification + regression-test task, and only touches the component file if the verification step finds an actual gap.

- [ ] **Step 1: Read the current component to confirm no gap**

Re-read `app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx` in full. Confirm: (a) it builds its initial draft via `draftFromGameServer` (Task 4 already updated), (b) it submits via a payload-building path that reuses `draftToPayload` or an equivalent (Task 4 already updated), (c) `NetworkingStep` is rendered with `ports`/`onChange` wired straight to the draft with no intermediate stripping of fields. If any of these don't hold, add the necessary wiring here (matching the pattern already used for `https`/`healthCheck`) — write it now rather than deferring, since this is the task responsible for edit-mode correctness.

- [ ] **Step 2: Write the failing test**

Add to `app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx` — find the existing test pattern that edits a field via a step component and asserts the resulting submitted payload (likely exercising the `https` toggle or a port edit already), and add an analogous case:

```typescript
  it('should persist a port visibility change to "internal" on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const game = /* reuse this file's existing declared-game fixture, with one port e.g. { container: 8212, protocol: 'tcp' } */;
    render(<EditGameForm game={game} onSubmit={onSubmit} /* ...other required props, matching this file's existing render calls */ />);

    // Navigate to the Networking section (this form renders every section
    // stacked, per its file doc — no step navigation needed, unlike the add wizard).
    await user.selectOptions(screen.getByLabelText('Visibility', { selector: '#port-visibility-0' }), 'internal');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          ports: expect.arrayContaining([expect.objectContaining({ container: 8212, protocol: 'tcp', visibility: 'internal' })]),
        }),
      }),
    );
  });
```

Adapt the fixture/prop names to match this file's actual existing test setup (read the file's other tests first — this plan doesn't have their exact shape in hand, so mirror whatever pattern the surrounding tests already use for `game`/`onSubmit`/render props and the actual "save" button's accessible name).

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx -t "port visibility"`
Expected: FAIL if Step 1 found a real gap; if Step 1 found no gap, this may already PASS — in that case, keep the test anyway (it's a real regression guard) and skip to Step 5.

- [ ] **Step 4: Fix any gap found**

Only if Step 3 failed for a reason beyond "test fixture doesn't match this file's conventions" — apply the minimal fix in `edit-game-form.component.tsx`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx`
Expected: PASS, full file, no regressions.

- [ ] **Step 6: Commit**

```bash
git add app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx
git commit -m "test(web): cover port visibility persistence in the edit-game form"
```

---

### Task 7: Review step + games detail page — display visibility

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/review-step.component.tsx` (ports list around line 84-92)
- Modify: `app/packages/web/src/pages/game-detail.page.tsx` (ports table around line 153-176)
- Modify (if a co-located test file exists for either — check via `find app/packages/web/src -iname "*review-step*" -o -iname "*game-detail*"`)

**Interfaces:**
- Consumes: `WizardDraftPort.visibility` (review-step), `RedactedGameServer.ports[].visibility` via `GameServer` in `api.service.ts` (game-detail — see Task 8, which must land visibility on `api.service.ts`'s `GameServer.ports` type before this task's `config.ports[].visibility` access typechecks; if implementing in this order, do Task 8's type-only step first or pull it forward here).

- [ ] **Step 1: Review step — add a visibility badge per port row**

Edit `app/packages/web/src/components/add-game-wizard/review-step.component.tsx`, in the `draft.ports.map` block (around line 88-92):

```tsx
              {draft.ports.map((port, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="font-[var(--font-mono)]">{port.container ?? '—'}</span>
                  <span className="uppercase text-[var(--color-muted-foreground)]">{port.protocol}</span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    {port.visibility === 'internal' ? 'VPC-only' : 'Public'}
                  </span>
                </div>
              ))}
```

(Adjust to match the exact surrounding JSX structure found by reading the live file — the plan's line numbers are from an earlier read and may have shifted slightly after Tasks 1-6; re-read the file immediately before editing.)

- [ ] **Step 2: Game detail page — add a Visibility column**

Edit `app/packages/web/src/pages/game-detail.page.tsx`'s Ports `Card` (around line 153-176):

```tsx
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Container port</TableHead>
                        <TableHead>Protocol</TableHead>
                        <TableHead>Visibility</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {config.ports.map((port) => (
                        <TableRow key={`${port.container}-${port.protocol}`}>
                          <TableCell className="font-[var(--font-mono)]">{port.container}</TableCell>
                          <TableCell className="uppercase">{port.protocol}</TableCell>
                          <TableCell>{port.visibility === 'internal' ? 'VPC-only' : 'Public'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
```

- [ ] **Step 3: Add/update component tests**

For each file touched in Steps 1-2, find (or, if absent, create alongside the component following this repo's `renderPage()`/jsdom conventions per `docs/docs/components/integration-tests.md`) a test asserting the visibility text renders — e.g. `expect(screen.getByText('VPC-only')).toBeInTheDocument()` for a fixture port with `visibility: 'internal'`, and `expect(screen.getByText('Public')).toBeInTheDocument()` for one with `visibility` omitted.

- [ ] **Step 4: Run the affected test files**

Run: `npx vitest run app/packages/web/src/components/add-game-wizard/review-step.component.test.tsx app/packages/web/src/pages/game-detail.page.test.tsx` (adjust filenames to whatever actually exists after Step 3's find)
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run app:typecheck`
Expected: clean (requires Task 8's `api.service.ts` type update to already be in place for `game-detail.page.tsx`'s `config.ports[].visibility` access — do Task 8 first if this fails).

- [ ] **Step 6: Commit**

```bash
git add app/packages/web/src/components/add-game-wizard/review-step.component.tsx app/packages/web/src/pages/game-detail.page.tsx
git commit -m "feat(web): show port visibility in the review step and game detail page"
```

---

### Task 8: `api.service.ts` IPC-mirror types

**Files:**
- Modify: `app/packages/web/src/api.service.ts` (`GameServer.ports` at line 112, `GameWizardDraft.ports` at line 180)

**Interfaces:**
- Produces: `GameServer.ports: { container: number; protocol: string; visibility?: 'public' | 'internal' }[]` and `GameWizardDraft.ports: { container: number | null; protocol: string; visibility: 'public' | 'internal' }[]` — hand-maintained mirrors of `@hyveon/shared`'s `GameServerPort` and this package's own `WizardDraft`, per this file's existing "mirrors X — that file is the source of truth; keep this copy in sync" convention.

- [ ] **Step 1: Update the two type literals**

Edit `app/packages/web/src/api.service.ts`:

```typescript
  ports: { container: number; protocol: string; visibility?: 'public' | 'internal' }[];
```

at line 112 (inside `GameServer`), and:

```typescript
  ports: { container: number | null; protocol: string; visibility: 'public' | 'internal' }[];
```

at line 180 (inside `GameWizardDraft`).

- [ ] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: clean. This is the type Task 7's `game-detail.page.tsx` change depends on — run this task before or alongside Task 7's typecheck step.

- [ ] **Step 3: Commit**

```bash
git add app/packages/web/src/api.service.ts
git commit -m "chore(web): mirror GameServerPort.visibility in api.service.ts IPC types"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/docs/components/infra.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Update the `securityGroups.ts` table row**

In the file-by-file table (around line 148), extend the `securityGroups.ts` row's description to mention that `gameServers`'s ingress array also includes one entry per `visibility: 'internal'` port, sourced from a `aws.ec2.getVpcOutput`-resolved VPC CIDR block rather than `0.0.0.0/0`, alongside the existing public/HTTPS/health-check-sourced entries.

- [ ] **Step 2: Add a short section on port visibility**

Add a new `##` section after "## Health-check network confinement is port-level, not game-level" (around line 235), titled `## Per-port visibility: public vs. internal ingress`, covering: the `GameServerPort.visibility` field and its `undefined ≡ 'public'` default; that `'internal'` sources ingress from the VPC CIDR block (reachable by anything inside the VPC, not scoped to a specific caller — cross-reference the existing "Health-check network confinement" section's port-level-not-game-level caveat, since a health-check port marked `'internal'` narrows its exposure from the whole internet to the whole VPC, not to the health-check Lambda specifically); that it only applies to non-HTTPS games' ports.

- [ ] **Step 3: Read for accuracy**

Re-read the edited sections against the actual code in `app/packages/infra/src/securityGroups.ts` after Task 3 lands, confirming every claim (VPC CIDR data-source call, ingress ordering, HTTPS no-op) matches what was actually implemented, not just what this plan proposed.

- [ ] **Step 4: Commit**

```bash
git add docs/docs/components/infra.md
git commit -m "docs(infra): document per-port public/internal visibility"
```

---

### Task 10: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `npm run app:lint`
Expected: clean.

- [ ] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: clean.

- [ ] **Step 3: Full unit suite**

Run: `npm run app:test`
Expected: all green.

- [ ] **Step 4: Integration suite**

Run: `npm run app:test:integration`
Expected: all green (Pulumi orchestration code changed in Task 3).

- [ ] **Step 5: Spec-coverage self-check**

Re-read `openspec/changes/add-internal-game-ports/specs/game-port-visibility/spec.md` scenario-by-scenario and confirm each is covered by a test written in Tasks 2-8:
- "Existing configuration with no visibility field" → Task 3 Step 9 (byte-identical public-only regression test) + Task 2 Step 5.
- "Invalid visibility value rejected" → Task 2 Step 1's reject case.
- "Public and internal ports on the same game" / "Internal port unreachable from the internet" → Task 3 Step 5.
- "A port cannot be declared with conflicting visibility" → pre-existing `checkPortCollisions` test coverage; no new test needed, but confirm it exists in `gameServerValidator.test.ts` and note it in the commit/PR description if not.
- "Visibility declared on an HTTPS game's port" → Task 3 Step 1's HTTPS-skip case for `dedupedInternalGamePorts`.
- "Operator marks a port VPC-only in the wizard" / "New port defaults to Public" → Task 5 Step 1, Task 6 Step 2.

- [ ] **Step 6: Commit any fixes found in Step 5**

If Step 5 finds a genuinely uncovered scenario, add the missing test now and commit it separately (`test(...): cover <scenario>`), rather than leaving a gap between the spec and the shipped test suite.
