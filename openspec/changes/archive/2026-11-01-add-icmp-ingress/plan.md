# ICMP Echo Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a game declare ICMP echo (ping) reachability as a `ports` entry (`protocol: 'icmp'`, `container` = ICMP type) that provisions a security-group rule, so Palworld's community-server-browser joins work without manual SG drift.

**Architecture:** One protocol union extension flowing through the existing ports fan-out: shared zod/deep validation → infra SG derivation (`icmp` rule, `fromPort`=type, `toPort`=-1) with ECS `portMappings` exclusion → wizard protocol dropdown. Cross-game `icmp` duplicates are allowed (visibility-consistent) and deduped at the SG.

**Tech Stack:** TypeScript npm workspaces, zod (`@hyveon/shared`), Pulumi AWS (`@hyveon/infra`), React + vitest/jsdom (`@hyveon/web`).

**Spec:** `openspec/changes/add-icmp-ingress/specs/game-port-visibility/spec.md` (design: `openspec/changes/add-icmp-ingress/design.md`)

## Global Constraints

- Existing configs must validate unchanged and preview with zero infra diff (spec §MODIFIED, design Goals).
- `icmp` on `https: true` games stays rejected (existing deep-validation rule, message updated only if it enumerates protocols).
- TSDoc per `.claude/rules/tsdoc-tags.md`; comments per `comment-conciseness.md`; tests per `testing-conventions.md`.
- Pre-PR gate: `npm run app:lint`, `npm run app:typecheck`, `npm run app:test`, `npm run app:test:e2e` (wizard changed).

---

### Task 1: Shared validation — ICMP type range

**Files:**
- Modify: `app/packages/shared/src/gameServerConfig.ts` (GameServerPort TSDoc, ~L23-49)
- Modify: `app/packages/shared/src/gameServerValidator.ts` (deep validation near the https protocol rule, ~L627-660)
- Test: `app/packages/shared/src/gameServerValidator.test.ts`

**Interfaces:**
- Consumes: `gameServerPortSchema` (`z.object({ container: z.number(), protocol: z.string(), visibility: z.enum(['public','internal']).optional() })`) — unchanged shape.
- Produces: validation issues with `message` mentioning "ICMP type" and "0 and 255" that Tasks 3's wizard `messageFor` can surface.

- [ ] **Step 1: Write failing tests** (follow the file's existing describe/expect style)

```ts
it('accepts an icmp entry with a valid type', () => {
  const result = validateGameServer(base({ ports: [{ container: 8, protocol: 'icmp' }] }), {});
  expect(result.issues).toEqual([]);
});

it('rejects an icmp entry whose type is out of range', () => {
  const result = validateGameServer(base({ ports: [{ container: 8211, protocol: 'icmp' }] }), {});
  expect(result.issues.some((i) => i.message.includes('ICMP type') && i.message.includes('0 and 255'))).toBe(true);
});

it('still rejects icmp on an https game', () => {
  const result = validateGameServer(base({ https: true, ports: [{ container: 443, protocol: 'tcp' }, { container: 8, protocol: 'icmp' }] }), {});
  expect(result.issues.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm run app:test -w @hyveon/shared -- gameServerValidator` (first test fails only if a non-tcp/udp protocol is currently rejected for non-https games; if it passes, keep it as a pin).
- [ ] **Step 3: Implement** — in the non-https deep-validation path add:

```ts
if (port.protocol === 'icmp' && (!Number.isInteger(port.container) || port.container < 0 || port.container > 255)) {
  issues.push({
    path: `ports[${index}].container`,
    message: `ports[${index}].container is the ICMP type when protocol is "icmp" and must be an integer between 0 and 255, got ${port.container}.`,
  });
}
```

Update `GameServerPort` TSDoc: `protocol` is `"tcp"`, `"udp"`, or `"icmp"`; for `"icmp"`, `container` is the ICMP type (8 = echo request), the entry only shapes security-group ingress and is never an ECS port mapping.
- [ ] **Step 4: Run to verify PASS** — same command.
- [ ] **Step 5: Commit** — `git commit -m "feat(shared): validate icmp port entries with ICMP-type range"`

### Task 2: Shared validation — cross-game icmp collision exemption

**Files:**
- Modify: `app/packages/shared/src/gameServerValidator.ts` (`portKey` ~L554, `checkPortCollisions` ~L565)
- Test: `app/packages/shared/src/gameServerValidator.test.ts`

**Interfaces:**
- Produces: cross-game behavior Task 4's SG dedupe relies on — duplicate `8/icmp` across games reaches `defineSecurityGroups` and must dedupe to one rule.

- [ ] **Step 1: Write failing tests**

```ts
it('allows the same icmp entry on two games when visibility matches', () => {
  const existing = [{ name: 'minecraft', ports: [{ container: 8, protocol: 'icmp' }] }];
  const result = validateGameServer(base({ ports: [{ container: 8, protocol: 'icmp' }] }), { existingGameServers: existing });
  expect(result.issues).toEqual([]);
});

it('rejects the same icmp entry across games with conflicting visibility', () => {
  const existing = [{ name: 'minecraft', ports: [{ container: 8, protocol: 'icmp', visibility: 'internal' }] }];
  const result = validateGameServer(base({ ports: [{ container: 8, protocol: 'icmp' }] }), { existingGameServers: existing });
  expect(result.issues.some((i) => i.message.includes('minecraft') && i.message.includes('visibility'))).toBe(true);
});

it('still rejects a duplicate icmp entry within one game', () => {
  const result = validateGameServer(base({ ports: [{ container: 8, protocol: 'icmp' }, { container: 8, protocol: 'icmp' }] }), {});
  expect(result.issues.some((i) => i.message.includes('collides'))).toBe(true);
});
```

(Adapt `existingGameServers` plumbing to `checkPortCollisions`' actual call shape in the file — it is invoked from `validateGameServer` at ~L848.)
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** — in the cross-game branch of `checkPortCollisions`: when `port.protocol.toLowerCase() === 'icmp'`, skip the duplicate rejection; instead compare effective visibility (`(v ?? 'public')`) and push an issue naming both games when they differ:

```ts
const effective = (v?: string): string => v ?? 'public';
if (port.protocol.toLowerCase() === 'icmp') {
  if (existingPort !== undefined && effective(existingPort.visibility) !== effective(port.visibility)) {
    issues.push({
      path: `ports[${index}]`,
      message: `Port ${port.container}/icmp conflicts with existing game "${existing.name}": visibility must match across games for icmp entries (one is "${effective(existingPort.visibility)}", the other "${effective(port.visibility)}").`,
    });
  }
  continue;
}
```

- [ ] **Step 4: Run to verify PASS** — full shared suite: `npm run app:test -w @hyveon/shared`.
- [ ] **Step 5: Commit** — `git commit -m "feat(shared): exempt icmp entries from cross-game port collisions"`

### Task 3: Infra — SG rule, portMappings exclusion, GAME_PORTS

**Files:**
- Modify: `app/packages/infra/src/securityGroups.ts` (ingress mapping in `defineSecurityGroups`, ~L263-292)
- Modify: `app/packages/infra/src/ecs.ts` (`portMappings`, ~L173-177)
- Modify: `app/packages/infra/src/lambdas.ts` (`firstPortByGame`, ~L549)
- Test: the packages' existing unit-test files for these modules

**Interfaces:**
- Consumes: `dedupedDirectGamePorts` / `dedupedInternalGamePorts` (already dedupe `(port, protocol)` across games — no change needed).
- Produces: SG ingress entries where `protocol === 'icmp'` ⇒ `fromPort: port.port, toPort: -1`.

- [ ] **Step 1: Write failing tests** — assert (a) an `8/icmp` public entry yields `{ protocol: 'icmp', fromPort: 8, toPort: -1, cidrBlocks: ['0.0.0.0/0'] }` with description `ICMP type 8`; (b) an internal icmp entry sources the VPC CIDR; (c) `portMappings` for a game with `[8/icmp, 8211/udp]` contains only 8211; (d) `firstPortByGame` returns 8211 for that game. Follow each module's existing test harness (Pulumi mocks per `testing-conventions.md`).
- [ ] **Step 2: Run to verify FAIL** — `npm run app:test -w @hyveon/infra`.
- [ ] **Step 3: Implement**

`securityGroups.ts` — extract a shared rule builder used by both the public and internal loops:

```ts
const ingressRule = (port: GamePort, cidrBlocks: pulumi.Input<string>[], suffix = ''): aws.types.input.ec2.SecurityGroupIngress =>
  port.protocol === 'icmp'
    ? { description: `ICMP type ${port.port}${suffix}`, fromPort: port.port, toPort: -1, protocol: 'icmp', cidrBlocks }
    : { description: `Game port ${port.port}/${port.protocol}${suffix}`, fromPort: port.port, toPort: port.port, protocol: port.protocol, cidrBlocks };
```

`ecs.ts`:

```ts
portMappings: config.ports
  .filter((port) => port.protocol !== 'icmp')
  .map((port) => ({ containerPort: port.container, hostPort: port.container, protocol: port.protocol })),
```

`lambdas.ts` (`firstPortByGame`) — exclude icmp before the existing public-first pick:

```ts
const connectable = ports.filter((port) => port.protocol !== 'icmp');
if (connectable.length === 0) {
  continue;
}
const publicPort = connectable.find((port) => port.visibility === undefined || port.visibility === 'public');
result[game] = (publicPort ?? connectable[0]).container;
```

- [ ] **Step 4: Run to verify PASS** — `npm run app:test -w @hyveon/infra`.
- [ ] **Step 5: Commit** — `git commit -m "feat(infra): provision icmp ingress from icmp port entries"`

### Task 4: Wizard — icmp protocol option

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx` (`PROTOCOL_OPTIONS` L32, port-row field label/hint)
- Modify: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts` (port validation + `messageFor`)
- Test: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts`, `networking-step` component test (jsdom)

**Interfaces:**
- Consumes: `WizardDraftPort` (`{ container: number | null, protocol: string, visibility: 'public' | 'internal' }`), Task 1's shared validation messages.
- Produces: persisted `{ container: 8, protocol: 'icmp' }` via `draftToPayload()` — no payload shape change.

- [ ] **Step 1: Write failing tests** — utils: an icmp row with container 300 produces the 0–255 range issue, an icmp row with container 8 validates clean; component (jsdom): selecting `icmp` in the protocol dropdown sets the row's numeric value to 8 when it was blank and renders the "8 = echo request (ping)" hint.
- [ ] **Step 2: Run to verify FAIL** — `npm run app:test -w @hyveon/web -- add-game-wizard`.
- [ ] **Step 3: Implement** — add `'icmp'` to `PROTOCOL_OPTIONS`; on protocol change to `icmp` with blank container, prefill 8; render hint text under the field when `protocol === 'icmp'`; in wizard validation, mirror Task 1's range rule with message `ICMP type must be an integer between 0 and 255`.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): offer icmp protocol in the game wizard"`

### Task 5: Docs + gates

**Files:**
- Modify: `docs/docs/components/infra.md`, `docs/docs/app/` games/wizard pages, `README.md` (~L85-100 Palworld example), `docs/docs/setup.md` (~L370 Palworld example)

- [ ] **Step 1: Run the `write-docs` skill** over the diff — it maps pages and reviews via the `docs-*` evaluators. Ensure the Palworld examples gain `{ "container": 8, "protocol": "icmp" }` with a one-line "community server browser requires ping" note.
- [ ] **Step 2: Full gates** — `npm run app:lint && npm run app:typecheck && npm run app:test && npm run app:test:e2e`; all exit 0.
- [ ] **Step 3: Manual preview check `- [~]` if no live stack** — `pulumi preview` with an icmp entry shows one new SG rule; without, zero diff.
- [ ] **Step 4: Commit** — `git commit -m "docs: document icmp port entries and Palworld ping requirement"`
