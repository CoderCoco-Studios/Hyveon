# Tasks: add-icmp-ingress

## 1. Shared type and validation (`@hyveon/shared`)

- [x] 1.1 Update `GameServerPort` TSDoc in `gameServerConfig.ts`: `protocol` accepts `'tcp' | 'udp' | 'icmp'`; for `'icmp'`, `container` is the ICMP type (0–255, 8 = echo request) and the entry is security-group-only (never an ECS port mapping).
- [x] 1.2 In `gameServerValidator.ts`, add deep validation: when `protocol === 'icmp'`, `container` must be an integer 0–255; error message names the entry index and the valid range. Confirm the existing HTTPS rule (`tcp`/`udp` only for `https: true` games) still rejects `icmp` there and its message stays accurate.
- [x] 1.3 In `checkPortCollisions`, exempt `icmp` entries from the cross-game duplicate rejection; instead reject cross-game `icmp` duplicates whose effective visibility conflicts (`'public'`/omitted vs `'internal'`), naming both games. Same-game duplicates stay rejected.
- [x] 1.4 Unit tests in `gameServerValidator.test.ts`: valid `8/icmp`; type out of range (8211); `icmp` on HTTPS game rejected; cross-game duplicate `8/icmp` same visibility accepted; conflicting visibility rejected; same-game duplicate rejected.

## 2. Infra program (`@hyveon/infra`)

- [x] 2.1 In `securityGroups.ts`, emit `icmp` ingress as `{ protocol: 'icmp', fromPort: <type>, toPort: -1 }` with a `ICMP type <n>` description, honouring `visibility` (public → `0.0.0.0/0`, internal → VPC CIDR) and existing dedupe helpers.
- [x] 2.2 In `ecs.ts`, exclude `protocol: 'icmp'` entries from the container `portMappings`.
- [x] 2.3 In `lambdas.ts`, make `firstPortByGame()` return the first non-`icmp` port.
- [x] 2.4 Unit tests: SG rule shape for public and internal `icmp` entries; cross-game dedupe to one rule; `portMappings` excludes `icmp`; `firstPortByGame` skips a leading `icmp` entry.

## 3. Wizard (`@hyveon/web`)

- [x] 3.1 Add `'icmp'` to `PROTOCOL_OPTIONS` in `networking-step.component.tsx`; when selected, present the numeric field as ICMP type with a "8 = echo request (ping)" hint and default new ICMP rows to 8.
- [x] 3.2 Extend wizard validation (`wizard-form.utils.ts`) with the 0–255 type range message for `icmp` rows.
- [x] 3.3 Component tests (jsdom, per testing conventions): selecting `icmp` defaults the field to 8 and persists `{ container: 8, protocol: 'icmp' }`; entering 300 blocks the step with the range message.

## 4. Documentation (same PR, via the `write-docs` skill)

- [x] 4.1 `docs/docs/components/infra.md`: security-group derivation now includes `icmp` entries (rule shape, no port mapping).
- [x] 4.2 Games/wizard app pages under `docs/docs/app/`: the `icmp` protocol option and ICMP-type field.
- [x] 4.3 Palworld example configs (`README.md`, `docs/docs/setup.md`): add `{ "container": 8, "protocol": "icmp" }` with a one-line note that the community server browser requires ping.

## 5. Verification gates

- [x] 5.1 `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` all green.
- [x] 5.2 `npm run app:test:e2e` (renderer/wizard surface changed).
- [~] 5.3 Manual: `pulumi preview` with an `icmp` entry shows the new SG rule; a config without `icmp` entries previews with zero diff.
