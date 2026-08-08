# Add game-server environment variable UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create and edit a game server's environment variables from the add-game wizard and the edit-game form, which today have no UI for the `environment` field at all.

**Architecture:** Add a sixth wizard step ("Environment") that manages a `WizardDraftEnvironmentVariable[]` list on the shared `WizardDraft`, following the exact `file_seeds` sub-editor pattern already used by `StorageStep`. Wire the new step into both the add-game wizard (dialog, stepwise) and the edit-game form (flat cards, same step components), add a shared validator rule for empty/duplicate names, and delete the edit-form's carry-forward hack now that the draft models the field for real.

**Tech Stack:** React 18 + TypeScript, Vitest + Testing Library (`@testing-library/react`, `@testing-library/user-event`) for component tests, Zod for the shared validator, existing `@/components/ui/*` primitives (`Button`, `Input`, `Label`, `Card`).

## Global Constraints

- Test names read as sentences starting with "should" (`it('should ...')`), per `CLAUDE.md`.
- TSDoc (not ad hoc JSDoc) on non-trivial functions, helpers, and notable constants, including test-file helpers — tag order: summary, `@remarks`, `@example`, `@typeParam`, `@param` (declaration order, `@param name - description` hyphen form), `@returns`, `@throws`, modifier tags last. Run `npm run app:lint` after writing any TSDoc comment (`tsdoc/syntax: 'error'`).
- No `as unknown as T` casts in tests; prefer `vi.mocked(fn)` and `Partial<T>` + a single `as T` for service-shaped stubs.
- No raw `process.env` in business logic (not applicable to this change — no env-access code is touched).
- This is a single, small PR — not a stack, per `.claude/rules/pr-stacking.md`.
- Every `@MessagePattern` IPC handler logs on entry (not applicable — no new IPC handlers in this change; `environment` already flows through the existing `games.create`/`games.update` handlers unchanged).

---

## Task 1: Shared validator rule (`checkEnvironmentVariables`)

**Files:**
- Modify: `app/packages/shared/src/gameServerValidator.ts`
- Test: `app/packages/shared/src/gameServerValidator.test.ts`

**Interfaces:**
- Consumes: `GameServerEntryInput` (existing type, already has `environment?: { name: string; value: string }[]` via `gameServerSchema`), `GameServerValidationIssue { path: string; message: string }` (existing).
- Produces: `function checkEnvironmentVariables(entry: GameServerEntryInput): GameServerValidationIssue[]` — called from `validateGameServer`'s post-parse success branch.

- [ ] **Step 1: Write the failing tests**

Open `app/packages/shared/src/gameServerValidator.test.ts` and add a new `describe` block right after the existing `describe('absolute paths', ...)` block (after its closing `});` at line 205):

```typescript
  describe('environment variables', () => {
    it('should accept distinct, non-empty environment variable names', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          environment: [
            { name: 'EULA', value: 'TRUE' },
            { name: 'DIFFICULTY', value: 'hard' },
          ],
        }),
        [],
      );
      expect(result.success).toBe(true);
    });

    it('should reject a blank environment variable name', () => {
      const result = validateGameServer(
        'game',
        makeProposed({ environment: [{ name: '', value: 'TRUE' }] }),
        [],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'environment[0].name')).toBe(true);
      }
    });

    it('should reject duplicate environment variable names within one entry', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          environment: [
            { name: 'EULA', value: 'TRUE' },
            { name: 'EULA', value: 'FALSE' },
          ],
        }),
        [],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'environment[1].name')).toBe(true);
      }
    });

    it('should accept an entry with no environment field at all', () => {
      const result = validateGameServer('game', makeProposed(), []);
      expect(result.success).toBe(true);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run app:test -- gameServerValidator --run`
Expected: FAIL — the two rejection tests fail because `result.success` is `true` (no rule exists yet to reject an empty or duplicate name).

- [ ] **Step 3: Implement `checkEnvironmentVariables`**

In `app/packages/shared/src/gameServerValidator.ts`, add this function right after `checkAbsolutePaths` (after its closing `}` around line 275):

```typescript
/**
 * Validates `environment[].name`: rejects an empty name, and rejects a name
 * that duplicates an earlier row's name within the same entry. No
 * constraint is placed on `value`, or on `name`'s character set/casing —
 * container images vary too much to assume a universal naming convention.
 */
function checkEnvironmentVariables(entry: GameServerEntryInput): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];
  const seenNames = new Set<string>();

  entry.environment?.forEach((variable, index) => {
    if (variable.name.length === 0) {
      issues.push({
        path: `environment[${index}].name`,
        message: `environment[${index}].name must not be empty.`,
      });
      return;
    }

    if (seenNames.has(variable.name)) {
      issues.push({
        path: `environment[${index}].name`,
        message: `environment[${index}].name "${variable.name}" duplicates an earlier environment variable in the same entry.`,
      });
      return;
    }

    seenNames.add(variable.name);
  });

  return issues;
}
```

Then wire it into `validateGameServer`'s post-parse success branch (around line 443-447), adding it alongside the existing checks:

```typescript
  } else {
    issues.push(...checkFargateCpuMemoryPairing(parsed.data));
    issues.push(...checkAbsolutePaths(parsed.data));
    issues.push(...checkEnvironmentVariables(parsed.data));
    issues.push(...checkConnectMessagePlaceholders(parsed.data.connect_message));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run app:test -- gameServerValidator --run`
Expected: PASS — all four new tests green, and every pre-existing test in the file still passes (this function only adds new issues when `environment` rows are actually empty/duplicated; it never touches entries without an `environment` field).

- [ ] **Step 5: Lint and commit**

Run: `npm run app:lint`
Expected: clean (the new function's doc comment must pass `tsdoc/syntax`).

```bash
git add app/packages/shared/src/gameServerValidator.ts app/packages/shared/src/gameServerValidator.test.ts
git commit -m "feat(shared): reject empty/duplicate environment variable names"
```

---

## Task 2: `WizardDraft` gains a real `environment` field

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`
- Test: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts`

**Interfaces:**
- Produces: `interface WizardDraftEnvironmentVariable { name: string; value: string }`; `WizardDraft.environment: WizardDraftEnvironmentVariable[]`; `WIZARD_STEPS` gains `'environment'` between `'storage'` and `'review'`; `function validateEnvironmentStep(draft, existingGames, mode?): GameServerValidationIssue[]`.
- Consumes (later tasks rely on these exact names): `WizardDraftEnvironmentVariable`, `WizardDraft['environment']`, `validateEnvironmentStep`.

- [ ] **Step 1: Write the failing tests**

Open `app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts`. Find the existing test(s) around `createEmptyWizardDraft`, `draftFromGameServer`, `draftToPayload`, and `stepForIssuePath` (grep the file for `describe('createEmptyWizardDraft'` etc. to find exact insertion points — follow the file's existing per-function `describe` block structure). Add these cases (adjust to fit alongside existing assertions in the same style — e.g. if `createEmptyWizardDraft`'s test already asserts the full returned object with `toEqual`, add `environment: []` to that expected object rather than a new test):

```typescript
  it('should include an empty environment array in a freshly-created draft', () => {
    expect(createEmptyWizardDraft().environment).toEqual([]);
  });

  it('should map environment rows from a GameServer onto the draft', () => {
    const draft = draftFromGameServer({
      name: 'mygame',
      image: 'itzg/minecraft-server',
      cpu: 1024,
      memory: 2048,
      ports: [],
      volumes: [{ name: 'data', container_path: '/data' }],
      environment: [{ name: 'EULA', value: 'TRUE' }],
    });
    expect(draft.environment).toEqual([{ name: 'EULA', value: 'TRUE' }]);
  });

  it('should default environment to an empty array when the GameServer has none declared', () => {
    const draft = draftFromGameServer({
      name: 'mygame',
      image: 'itzg/minecraft-server',
      cpu: 1024,
      memory: 2048,
      ports: [],
      volumes: [{ name: 'data', container_path: '/data' }],
    });
    expect(draft.environment).toEqual([]);
  });

  it('should include environment rows in the create payload when present', () => {
    const draft = { ...createEmptyWizardDraft(), environment: [{ name: 'EULA', value: 'TRUE' }] };
    expect(draftToPayload(draft).config.environment).toEqual([{ name: 'EULA', value: 'TRUE' }]);
  });

  it('should omit environment from the create payload when empty', () => {
    const draft = createEmptyWizardDraft();
    expect(draftToPayload(draft).config.environment).toBeUndefined();
  });

  it('should route an environment[N].name issue to the environment step', () => {
    expect(stepForIssuePath('environment[0].name')).toBe('environment');
  });
```

Also add `environment: []` (or the appropriate populated array) to every existing `WizardDraft`-shaped object literal already hand-built elsewhere in this test file for other test cases (search the file for `cpu: 1024` or `https: false` as anchors — every literal that already includes `file_seeds` needs an `environment` sibling added, since `WizardDraft` is about to become a required-field superset).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run app:test -- wizard-form.utils --run`
Expected: FAIL — `environment` is `undefined` on `createEmptyWizardDraft()`'s result, `draftFromGameServer` doesn't read it, `draftToPayload`'s `config` has no `environment` key, `stepForIssuePath('environment[0].name')` currently returns `'review'` (the `default` fallback branch).

- [ ] **Step 3: Implement the draft field, converters, and step routing**

In `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`:

Add the new draft-row type right after `WizardDraftFileSeed` (after its closing `}` around line 65):

```typescript
/** Draft form of a single `GameServerEnvironmentVariable` row. */
export interface WizardDraftEnvironmentVariable {
  name: string;
  value: string;
}
```

Add `environment` to the `WizardDraft` interface (after `file_seeds: WizardDraftFileSeed[];`):

```typescript
  environment: WizardDraftEnvironmentVariable[];
```

Add it to `createEmptyWizardDraft`'s returned object (after `file_seeds: [],`):

```typescript
    environment: [],
```

Add it to `draftFromGameServer`'s returned object (after the `file_seeds:` mapping):

```typescript
    environment: (game.environment ?? []).map((variable) => ({ name: variable.name, value: variable.value })),
```

Add `WIZARD_STEPS`'s new entry — change:

```typescript
export const WIZARD_STEPS = ['identity', 'resources', 'networking', 'storage', 'review'] as const;
```

to:

```typescript
export const WIZARD_STEPS = ['identity', 'resources', 'networking', 'storage', 'environment', 'review'] as const;
```

Add the `'environment'` case to `stepForIssuePath`'s `switch` (after the `case 'volumes': case 'file_seeds': return 'storage';` branch):

```typescript
    case 'environment':
      return 'environment';
```

Add `environment` to `draftToPayload`'s returned `config` object (after the `file_seeds:` block), matching the `file_seeds` empty-becomes-`undefined` convention:

```typescript
      environment: draft.environment.length > 0 ? draft.environment.map((v) => ({ name: v.name, value: v.value })) : undefined,
```

Add the same field, same convention, to `toProposedEntry`'s returned object (used only for client-side validation, not submission):

```typescript
    environment:
      draft.environment.length > 0 ? draft.environment.map((v) => ({ name: v.name, value: v.value })) : undefined,
```

Add the new per-step validator export, right after `validateStorageStep` (mirroring its doc-comment shape):

```typescript
/** Validates the "Environment" step: `environment` row names (non-empty, no duplicates within the entry). */
export function validateEnvironmentStep(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  return validateStep('environment', draft, existingGames, mode);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run app:test -- wizard-form.utils --run`
Expected: PASS — all new and pre-existing tests green.

- [ ] **Step 5: Typecheck, lint, and commit**

Run: `npm run app:typecheck && npm run app:lint`
Expected: clean. (Typecheck will surface every other file that builds a `WizardDraft`-shaped object without `environment` — note them, they're covered by Tasks 3-5 below; do not add ad hoc fixes here beyond this file and its test.)

```bash
git add app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts
git commit -m "feat(web): add environment field to WizardDraft and route its validation"
```

---

## Task 3: `EnvironmentStep` component

**Files:**
- Create: `app/packages/web/src/components/add-game-wizard/environment-step.component.tsx`
- Test: `app/packages/web/src/components/add-game-wizard/environment-step.component.test.tsx`

**Interfaces:**
- Consumes: `WizardDraftEnvironmentVariable`, `WizardDraft['environment']` (Task 2), `GameServerValidationIssue` (existing), UI primitives `Button`/`Input`/`Label` from `@/components/ui/*`.
- Produces: `interface EnvironmentStepProps { draft: WizardDraft; issues: GameServerValidationIssue[]; onChange: (patch: Partial<Pick<WizardDraft, 'environment'>>) => void }`; `function EnvironmentStep(props: EnvironmentStepProps): JSX.Element` — consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `app/packages/web/src/components/add-game-wizard/environment-step.component.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvironmentStep } from './environment-step.component.js';
import type { WizardDraft } from './wizard-form.utils.js';

/** Builds a minimal draft for the Environment step; only `environment` matters here. */
function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    connect_message: '',
    cpu: 1024,
    memory: 2048,
    ports: [],
    volumes: [],
    file_seeds: [],
    environment: [],
    https: false,
    ...overrides,
  };
}

describe('EnvironmentStep', () => {
  it('should show an empty-state message when there are no rows', () => {
    render(<EnvironmentStep draft={makeDraft()} issues={[]} onChange={vi.fn()} />);

    expect(screen.getByText(/No environment variables configured/i)).toBeInTheDocument();
  });

  it('should call onChange with a new blank row appended when "Add variable" is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EnvironmentStep draft={makeDraft()} issues={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Add variable' }));

    expect(onChange).toHaveBeenCalledWith({ environment: [{ name: '', value: '' }] });
  });

  it('should call onChange with the edited name when a name field is typed into', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <EnvironmentStep
        draft={makeDraft({ environment: [{ name: '', value: '' }] })}
        issues={[]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByLabelText('Name'), 'E');

    expect(onChange).toHaveBeenCalledWith({ environment: [{ name: 'E', value: '' }] });
  });

  it('should call onChange with the row removed when its Remove button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <EnvironmentStep
        draft={makeDraft({
          environment: [
            { name: 'EULA', value: 'TRUE' },
            { name: 'DIFFICULTY', value: 'hard' },
          ],
        })}
        issues={[]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove environment variable 1' }));

    expect(onChange).toHaveBeenCalledWith({ environment: [{ name: 'DIFFICULTY', value: 'hard' }] });
  });

  it('should render a validation issue message next to the offending row', () => {
    render(
      <EnvironmentStep
        draft={makeDraft({ environment: [{ name: '', value: 'TRUE' }] })}
        issues={[{ path: 'environment[0].name', message: 'environment[0].name must not be empty.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('environment[0].name must not be empty.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run app:test -- environment-step --run`
Expected: FAIL — `environment-step.component.js` does not exist yet (module resolution error).

- [ ] **Step 3: Implement `EnvironmentStep`**

Create `app/packages/web/src/components/add-game-wizard/environment-step.component.tsx`:

```typescript
/**
 * "Environment" step of the add-game wizard: editable `environment` rows
 * (`name` + `value`), positioned between Storage and Review.
 *
 * A fully optional list — unlike `volumes` (min 1), there is no minimum row
 * count and every row's Remove button is always enabled. Purely
 * presentational, mirroring the rest of the wizard's "lift state up to the
 * draft" pattern: every add/remove/edit is expressed as an
 * `{ environment }` patch passed to `onChange`. Validation issues are
 * supplied by the caller (typically `validateEnvironmentStep()`) and
 * matched back to the row/field they belong to by exact path —
 * `environment[0].name`.
 */

import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import type { WizardDraft, WizardDraftEnvironmentVariable } from './wizard-form.utils.js';

/** Blank row appended by the "Add variable" button. */
const EMPTY_ENVIRONMENT_VARIABLE: WizardDraftEnvironmentVariable = { name: '', value: '' };

/** Props for {@link EnvironmentStep}. */
export interface EnvironmentStepProps {
  /** The wizard's in-progress draft; only `environment` is read here. */
  draft: WizardDraft;
  /** Validation issues for this step (e.g. from `validateEnvironmentStep()`), positioned via `environment[N].name` paths. */
  issues: GameServerValidationIssue[];
  /** Called with a partial patch of the changed field whenever the operator adds, removes, or edits a row. */
  onChange: (patch: Partial<Pick<WizardDraft, 'environment'>>) => void;
}

/** Finds the message (if any) whose issue path is exactly `path`. */
function messageFor(issues: GameServerValidationIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

/**
 * Row editor for the wizard's "Environment" step: an optional `environment`
 * list, no minimum row count.
 */
export function EnvironmentStep({ draft, issues, onChange }: EnvironmentStepProps) {
  const { environment } = draft;

  function addVariable() {
    onChange({ environment: [...environment, { ...EMPTY_ENVIRONMENT_VARIABLE }] });
  }

  function removeVariable(index: number) {
    onChange({ environment: environment.filter((_, i) => i !== index) });
  }

  function updateVariable(index: number, patch: Partial<WizardDraftEnvironmentVariable>) {
    onChange({
      environment: environment.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)),
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Environment variables</h3>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Optional — environment variables injected into the container (e.g. <code>EULA=TRUE</code>).
        </p>
      </div>

      {environment.length === 0 && (
        <p className="text-xs text-[var(--color-muted-foreground)]">No environment variables configured.</p>
      )}

      <div className="space-y-3">
        {environment.map((variable, index) => {
          const nameError = messageFor(issues, `environment[${index}].name`);

          return (
            <div
              key={index}
              data-testid={`env-row-${index}`}
              className="flex items-end gap-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3"
            >
              <div className="flex-1 space-y-1">
                <Label htmlFor={`env-name-${index}`}>Name</Label>
                <Input
                  id={`env-name-${index}`}
                  value={variable.name}
                  placeholder="EULA"
                  onChange={(event) => updateVariable(index, { name: event.target.value })}
                />
                {nameError && (
                  <p role="alert" className="text-xs text-[var(--color-red)]">
                    {nameError}
                  </p>
                )}
              </div>

              <div className="flex-1 space-y-1">
                <Label htmlFor={`env-value-${index}`}>Value</Label>
                <Input
                  id={`env-value-${index}`}
                  value={variable.value}
                  placeholder="TRUE"
                  onChange={(event) => updateVariable(index, { value: event.target.value })}
                />
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Remove environment variable ${index + 1}`}
                onClick={() => removeVariable(index)}
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>

      <Button type="button" variant="secondary" size="sm" onClick={addVariable}>
        Add variable
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run app:test -- environment-step --run`
Expected: PASS — all five tests green.

- [ ] **Step 5: Typecheck, lint, and commit**

Run: `npm run app:typecheck && npm run app:lint`
Expected: clean.

```bash
git add app/packages/web/src/components/add-game-wizard/environment-step.component.tsx app/packages/web/src/components/add-game-wizard/environment-step.component.test.tsx
git commit -m "feat(web): add EnvironmentStep row editor"
```

---

## Task 4: Wire `EnvironmentStep` into the add-game wizard and edit-game form

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx`
- Modify: `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx`
- Modify: `app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx`
- Modify: `app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx`

**Interfaces:**
- Consumes: `EnvironmentStep`/`EnvironmentStepProps` (Task 3), `WIZARD_STEPS` now including `'environment'` (Task 2).

- [ ] **Step 1: Update `add-game-wizard.component.test.tsx`'s step-count expectations first (failing)**

The new step shifts every "Step N of 5" string to "Step N of 6" and inserts one more `goNext()` hop before Review. Make these three edits:

Change the `fillHappyPathToReview` helper (around line 67-76) to pass through the new step and add an `environment` fill helper isn't required (the step is optional — zero rows is valid), just one more `goNext()`:

```typescript
async function fillHappyPathToReview() {
  await fillIdentityStep();
  await goNext(); // -> resources
  await fillResourcesStep();
  await goNext(); // -> networking (no ports required)
  await goNext(); // -> storage
  await fillStorageStep();
  await goNext(); // -> environment (no rows required)
  await goNext(); // -> review
  await screen.findByText('Step 6 of 6: Review');
}
```

Change line 156 from `'Step 1 of 5: Identity'` to `'Step 1 of 6: Identity'`.

Change line 176 from `'Step 5 of 5: Review'` to `'Step 6 of 6: Review'`.

- [ ] **Step 2: Run the wizard tests to verify they fail**

Run: `npm run app:test -- add-game-wizard.component --run`
Expected: FAIL — the component doesn't render an Environment step yet, so `goNext()`'s extra hop lands somewhere unexpected and the "Step 6 of 6" text never appears.

- [ ] **Step 3: Wire the step into `add-game-wizard.component.tsx`**

Add the import (alongside the other step imports):

```typescript
import { EnvironmentStep } from './environment-step.component.js';
```

Add `environment: 'Environment'` to `STEP_LABELS` (between `storage` and `review`):

```typescript
const STEP_LABELS: Record<WizardStep, string> = {
  identity: 'Identity',
  resources: 'Resources',
  networking: 'Networking',
  storage: 'Storage',
  environment: 'Environment',
  review: 'Review',
};
```

Render the step between Storage and Review (find `{step === 'storage' && <StorageStep ... />}` and `{step === 'review' && <ReviewStep ... />}`, insert between them):

```typescript
        {step === 'environment' && <EnvironmentStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
```

(`EnvironmentStep`'s `onChange` prop already receives the full `{ environment }` patch object, so `patchDraft` is passed directly — matching exactly how `StorageStep` is wired one line above it.)

- [ ] **Step 4: Run the wizard tests to verify they pass**

Run: `npm run app:test -- add-game-wizard.component --run`
Expected: PASS.

- [ ] **Step 5: Update `edit-game-form.component.test.tsx`'s fixtures (no test logic change needed yet)**

Open `edit-game-form.component.test.tsx`. The existing `sampleGame()` helper (around line 28-42) and `samplePayloadConfig()` helper (around line 45-57) both already include `environment: [{ name: 'EULA', value: 'true' }]` — no change needed to those two functions. Add one new test after the existing `'should not call api.updateGame for an unedited, valid draft...'` test (around line 137-147):

```typescript
  it('should call api.updateGame with an added environment variable after editing and Save', async () => {
    apiMock.updateGame.mockResolvedValue({ ok: true, games: [] });
    renderForm(<EditGameForm game={sampleGame({ environment: [] })} />);

    await screen.findByLabelText('Image');
    await userEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    await userEvent.type(screen.getByLabelText('Name'), 'DIFFICULTY');
    await userEvent.type(screen.getByLabelText('Value'), 'hard');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(apiMock.updateGame).toHaveBeenCalledWith({
        name: 'mygame',
        config: { ...samplePayloadConfig(), environment: [{ name: 'DIFFICULTY', value: 'hard' }] },
      }),
    );
  });

  it('should call api.updateGame with environment variables removed after Save', async () => {
    apiMock.updateGame.mockResolvedValue({ ok: true, games: [] });
    renderForm(<EditGameForm game={sampleGame()} />);

    await screen.findByLabelText('Image');
    await userEvent.click(screen.getByRole('button', { name: 'Remove environment variable 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(apiMock.updateGame).toHaveBeenCalledWith({
        name: 'mygame',
        config: { ...samplePayloadConfig(), environment: undefined },
      }),
    );
  });
```

- [ ] **Step 6: Run the edit-form tests to verify the new tests fail and the pre-existing ones still pass**

Run: `npm run app:test -- edit-game-form.component --run`
Expected: the two new tests FAIL (no "Add variable"/"Remove environment variable 1" button rendered yet — `EnvironmentStep` isn't wired in); every pre-existing test still PASSes (the carry-forward hack is still in place at this point, so `environment` still round-trips unchanged for an unedited save).

- [ ] **Step 7: Wire the step into `edit-game-form.component.tsx` and delete the carry-forward hack**

Add the import (alongside the other step imports):

```typescript
import { EnvironmentStep } from '../add-game-wizard/environment-step.component.js';
```

Add a new `<Card>` section after the Storage card (after its closing `</Card>` and before the `{submitError && ...}` block):

```typescript
      <Card>
        <CardHeader>
          <CardTitle>Environment</CardTitle>
        </CardHeader>
        <CardContent>
          <EnvironmentStep draft={draft} issues={issues} onChange={patchDraft} />
        </CardContent>
      </Card>
```

In `handleSave`, replace the carry-forward `UpdateGamePayload` construction:

```typescript
      const { config } = draftToPayload(draft);
      const payload: UpdateGamePayload = {
        name: game.name,
        // `environment` isn't an editable field on this form (the wizard
        // draft never had a place for it) — carry the existing declaration's
        // value forward so saving other fields doesn't wipe it out. `https`
        // is owned by the draft now, so it's already in `config`.
        config: { ...config, environment: game.environment },
      };
```

with:

```typescript
      const { config } = draftToPayload(draft);
      const payload: UpdateGamePayload = { name: game.name, config };
```

Also update the module doc comment at the top of the file (around line 26-30) — remove the bullet describing the carry-forward behavior:

```
- `environment` isn't covered by the wizard's draft shape (#99 never built
  a field for it), so whatever the declaration already had is carried
  forward unmodified in the submitted payload rather than being silently
  dropped. `https` *is* an editable draft field (see
  `add-https-toggle-to-game-form`) and needs no such carry-forward.
```

(delete this bullet entirely — `environment` is now an editable draft field exactly like `https`, so the surrounding sentence about `https` needing no special-casing now describes `environment` too and doesn't need restating).

- [ ] **Step 8: Run the edit-form tests to verify they pass**

Run: `npm run app:test -- edit-game-form.component --run`
Expected: PASS — all tests green, including the two new ones and every pre-existing one (the pre-existing "unedited save" tests still pass because `draftFromGameServer`/`draftToPayload` now carry `environment` through via the real draft field instead of the deleted hack).

- [ ] **Step 9: Typecheck, lint, and commit**

Run: `npm run app:typecheck && npm run app:lint`
Expected: clean.

```bash
git add app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx
git commit -m "feat(web): wire EnvironmentStep into add-game wizard and edit-game form"
```

---

## Task 5: Review-step summary

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/review-step.component.tsx`
- Modify: `app/packages/web/src/components/add-game-wizard/review-step.component.test.tsx`

**Interfaces:**
- Consumes: `WizardDraft['environment']` (Task 2).

- [ ] **Step 1: Write the failing tests**

Open `review-step.component.test.tsx`. Find the existing `makeDraft` helper (mirrors the one in `storage-step.component.test.tsx`) and add `environment: []` to its default return (matching the pattern used for `file_seeds: []`). Add two new tests, placed near the existing Storage-card assertions:

```typescript
  it('should render environment variable rows when present', () => {
    render(
      <ReviewStep draft={makeDraft({ environment: [{ name: 'EULA', value: 'TRUE' }] })} />,
    );

    expect(screen.getByText('Environment variables')).toBeInTheDocument();
    expect(screen.getByText('EULA')).toBeInTheDocument();
    expect(screen.getByText('TRUE')).toBeInTheDocument();
  });

  it('should omit the environment variables section when there are none', () => {
    render(<ReviewStep draft={makeDraft({ environment: [] })} />);

    expect(screen.queryByText('Environment variables')).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run app:test -- review-step.component --run`
Expected: FAIL — no "Environment variables" text is rendered anywhere yet.

- [ ] **Step 3: Add the summary section**

In `review-step.component.tsx`, add a derived flag next to the existing `hasFileSeeds` (around line 51-52):

```typescript
  const hasEnvironment = draft.environment.length > 0;
```

Add a new summary block inside the Storage `<Card>`'s `<CardContent>`, after the existing `{hasFileSeeds && (...)}` block (around line 118-131), following the exact same structure:

```typescript
          {hasEnvironment && (
            <div>
              <h4 className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
                Environment variables
              </h4>
              <ul className="space-y-1">
                {draft.environment.map((variable, index) => (
                  <li key={index} className="flex items-center justify-between gap-4 py-1 text-sm">
                    <span>{variable.name}</span>
                    <span className="font-[var(--font-mono)] text-[var(--color-muted-foreground)]">
                      {variable.value}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
```

Update the module doc comment (around line 34-49) — the sentence "Optional fields that were left blank — `connect_message` and `file_seeds` — are omitted entirely" should read "Optional fields that were left blank — `connect_message`, `file_seeds`, and `environment` — are omitted entirely" (keep the rest of the paragraph as-is).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run app:test -- review-step.component --run`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, and commit**

Run: `npm run app:typecheck && npm run app:lint`
Expected: clean.

```bash
git add app/packages/web/src/components/add-game-wizard/review-step.component.tsx app/packages/web/src/components/add-game-wizard/review-step.component.test.tsx
git commit -m "feat(web): show environment variables in the wizard review summary"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/docs/app/` page(s) describing the add-game wizard and edit-game form (locate via `grep -rl "add-game wizard\|Add game\|Storage step\|Review step" docs/docs/app/`)
- Modify: `docs/docs/components/management-app.md` if it enumerates the wizard's steps (`grep -n "Identity\|Resources\|Networking\|Storage\|Review" docs/docs/components/management-app.md`)

**Interfaces:**
- None — documentation only, no code interfaces.

- [ ] **Step 1: Locate every doc page that enumerates the wizard's steps**

Run: `grep -rln "Identity.*Resources.*Networking\|five steps\|five-step" docs/docs/`
Expected output: at least the add-game wizard's page under `docs/docs/app/` and possibly `docs/docs/components/management-app.md`. Read each match in full before editing.

- [ ] **Step 2: Update each matched page**

For each page found in Step 1, add "Environment" to the step list between "Storage" and "Review", and add one short paragraph describing the step (mirroring the existing paragraph style for e.g. the Storage step): the operator can add/remove/edit `name`/`value` rows, the list is optional (no minimum), and the same section appears in the edit-game form. Update any "five steps" wording to "six steps".

- [ ] **Step 3: Run the write-docs skill's evaluators over the touched pages**

Invoke the `write-docs` skill (per `CLAUDE.md`'s "docs in the same PR" rule) targeting the pages edited in Step 2, so the `docs-accuracy-auditor`, `docs-coverage-auditor`, and `docs-style-reviewer` agents check the edits against the real code from Tasks 1-5.

- [ ] **Step 4: Commit**

```bash
git add docs/docs/
git commit -m "docs: document the add-game wizard's Environment step"
```

---

## Task 7: Verification gate

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `npm run app:lint`
Expected: exit 0.

- [ ] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: exit 0.

- [ ] **Step 3: Full unit suite**

Run: `npm run app:test`
Expected: exit 0, every spec from Tasks 1-5 included and green.

- [ ] **Step 4: E2E**

Run: `npm run app:test:e2e`
Expected: exit 0. The renderer changed (new wizard step, new edit-form section), so this tier is required per `CLAUDE.md`'s "Before opening a PR" checklist. If any existing e2e spec drives the add-game wizard by step index/count (grep `e2e/` for `Add a game server` or step-count assertions before running), update it the same way Task 4 updated the equivalent unit test.

- [ ] **Step 5: Open the PR**

Use the `/pr` command (per `CLAUDE.md`'s "Always use `/pr`" rule) from this branch. Title must match `^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([^)]+\))?: .+$` and stay under ~70 chars, e.g.:

```
feat(web): add environment variable UI to game wizard and edit form
```
