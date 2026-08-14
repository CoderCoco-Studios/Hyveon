## 1. Schema and validation

- [x] 1.1 Add `visibility?: 'public' | 'internal'` to `GameServerPort` in
      `app/packages/shared/src/gameServerConfig.ts`, with TSDoc documenting
      the `undefined ≡ 'public'` contract (mirroring `GameServerConfig.https`).
- [x] 1.2 Add the `visibility` enum to the port zod schema in
      `app/packages/shared/src/gameServerValidator.ts`.
- [x] 1.3 Unit tests in `gameServerValidator.test.ts`: a port with
      `visibility` omitted validates; `'public'`/`'internal'` validate; any
      other string is rejected.

## 2. Security-group ingress

- [x] 2.1 In `app/packages/infra/src/securityGroups.ts`, split
      `dedupedDirectGamePorts` (or add a sibling function) so it returns
      separate public and internal `GamePort[]` buckets, keeping the
      existing HTTPS skip and first-seen dedup semantics per port/protocol
      key.
- [x] 2.2 In `defineSecurityGroups`, resolve the VPC's CIDR block via
      `aws.ec2.getVpcOutput({ id: vpcId })`.
- [x] 2.3 Build a second ingress-entry block for internal ports sourced
      from the resolved VPC CIDR (`cidrBlocks: [vpcCidr]`), and concatenate
      it with the existing public/HTTPS/health-check-sourced entries on
      `game_servers`.
- [x] 2.4 Update TSDoc on `dedupedDirectGamePorts`/`SecurityGroupResources`
      to describe the two ingress sources.
- [x] 2.5 Unit tests in `securityGroups.test.ts`: a game with one public
      and one internal port produces exactly one `0.0.0.0/0`-sourced rule
      and one VPC-CIDR-sourced rule; an all-public configuration produces
      byte-identical ingress to before this change (regression check for
      the zero-behavior-change contract); an HTTPS game's `visibility`
      value has no effect on its ingress.

## 3. Wizard UI

- [x] 3.1 Add a per-port visibility control (Public / VPC-only, default
      Public) to
      `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx`.
- [x] 3.2 Add the same control to
      `app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx`.
- [x] 3.3 Show each port's visibility in
      `app/packages/web/src/components/add-game-wizard/review-step.component.tsx`
      and in the games detail view
      (`app/packages/web/src/pages/game-detail.page.tsx`) if that page
      lists ports.
- [x] 3.4 Component/routed-page tests for the new control (jsdom project,
      per `docs/docs/components/integration-tests.md` conventions):
      networking-step defaults new ports to Public; edit-game-form persists
      a change to Internal; review-step and game-detail render the
      visibility value.

## 4. Documentation

- [x] 4.1 Update `docs/docs/components/infra.md`'s ingress-rule
      description to cover public vs. internal port ingress and the VPC
      CIDR source.
- [x] 4.2 Note in the relevant `docs/docs/app/` wizard/games page(s) that a
      port can be marked VPC-only, and what that means for reachability.

## 5. Verification

- [x] 5.1 `npm run app:lint` clean.
- [x] 5.2 `npm run app:typecheck` clean.
- [x] 5.3 `npm run app:test` full unit suite green.
- [x] 5.4 `npm run app:test:integration` (Pulumi orchestration/security-group
      code changed).
