# Add-game wizard draft persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an in-progress add-game wizard draft survive closing and relaunching the whole Electron app, with an explicit Resume/Discard banner on the games page.

**Architecture:** A new `GameWizardDraft`/`StoredGameWizardDraft` shape lives on `ElectronStoreService`'s schema; a new `GameWizardDraftService` owns get/save/clear against it; three new `games.draft.*` IPC handlers on `GamesController` expose it to the renderer through the existing preload bridge; `AddGameWizard` debounce-autosaves and flushes on close, and `GamesPage` reads the draft on mount and renders a Resume/Discard banner.

**Tech Stack:** NestJS (`@MessagePattern`/`@Payload`) desktop-main IPC controllers, `electron-store`-backed `ElectronStoreService`, React function components with hooks, Vitest + `@testing-library/react` + `userEvent`.

## Global Constraints

- Every new `@MessagePattern` handler starts with `logger.debug('GamesController: <pattern> invoked')` as its first statement (`.claude/rules/logging.md`).
- No raw `process.env` in business logic; no secret values ever logged.
- TSDoc on every new exported function/interface/class, using only tags from the TSDoc spec, `@param name - description` (hyphen form), structured summary → `@remarks` → `@param` → `@returns` (`.claude/rules/tsdoc-tags.md`).
- Test names read as sentences starting with "should".
- No `as unknown as T` in tests — use `Partial<T>` + a single `as T`, or `vi.mocked(fn)`.
- Run `npm run app:lint` and `npm run app:typecheck` after any TSDoc-bearing or type-level change; both must stay clean.

---

## Task 1: `GameWizardDraft` type + `ElectronStoreService` schema key

**Files:**
- Modify: `app/packages/desktop-main/src/services/ElectronStoreService.ts`
- Test: `app/packages/desktop-main/src/services/ElectronStoreService.test.ts` (existing file — extend it)

**Interfaces:**
- Produces: `GameWizardDraft` (draft field shape), `StoredGameWizardDraft` (`{ draft: GameWizardDraft; stepIndex: number; savedAt: string }`), and `AppStoreSchema['addGameWizardDraft']?: StoredGameWizardDraft`.

- [ ] **Step 1: Write the failing test**

Find `ElectronStoreService.test.ts`'s existing `describe('get/set/delete', ...)`-style block (or equivalent top-level key coverage) and add:

```ts
describe('addGameWizardDraft', () => {
  const sampleDraft: StoredGameWizardDraft = {
    draft: {
      name: 'mygame',
      image: 'some/image',
      connect_message: '',
      cpu: 256,
      memory: 512,
      ports: [],
      volumes: [],
      file_seeds: [],
      environment: [],
      https: false,
    },
    stepIndex: 2,
    savedAt: '2026-08-09T00:00:00.000Z',
  };

  it('should return undefined when no draft has been saved', () => {
    const service = new ElectronStoreService(makeSafeStorage());
    expect(service.get('addGameWizardDraft')).toBeUndefined();
  });

  it('should round-trip a saved draft through get/set', () => {
    const service = new ElectronStoreService(makeSafeStorage());
    service.set('addGameWizardDraft', sampleDraft);
    expect(service.get('addGameWizardDraft')).toEqual(sampleDraft);
  });

  it('should remove the draft entirely via delete', () => {
    const service = new ElectronStoreService(makeSafeStorage());
    service.set('addGameWizardDraft', sampleDraft);
    service.delete('addGameWizardDraft');
    expect(service.get('addGameWizardDraft')).toBeUndefined();
  });
});
```

Add `import type { GameWizardDraft, StoredGameWizardDraft } from './ElectronStoreService.js';` to the test file's import block if `GameWizardDraft`/`StoredGameWizardDraft` aren't already imported, and use whatever `makeSafeStorage()` (or equivalent existing helper) the file already defines for constructing an `ElectronStoreService` outside Electron — read the top of the existing test file first and reuse its established helper name instead of inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- ElectronStoreService.test.ts`
Expected: FAIL — `Property 'addGameWizardDraft' does not exist on type 'AppStoreSchema'` (or a Vitest type error), since the schema key doesn't exist yet.

- [ ] **Step 3: Add the type and schema key**

In `ElectronStoreService.ts`, add just above `export interface AppStoreSchema {` (after the existing `OrphanedRollbackRecord` interface, before the `AppStoreSchema` doc comment):

```ts
/**
 * In-progress add-game wizard field values, mirroring `WizardDraft` in
 * `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts` —
 * that file is the source of truth; keep this copy in sync with it. Not
 * secret in the general case, but may contain operator-entered environment
 * variable values the operator considers sensitive — see
 * {@link StoredGameWizardDraft}'s doc comment for the at-rest posture this
 * accepts.
 */
export interface GameWizardDraft {
  name: string;
  image: string;
  connect_message: string;
  cpu: number | null;
  memory: number | null;
  ports: { container: number | null; protocol: string }[];
  volumes: { name: string; container_path: string }[];
  file_seeds: { path: string; content: string; content_base64: string; mode: string }[];
  environment: { name: string; value: string }[];
  https: boolean;
}

/**
 * A saved add-game wizard draft plus which step the operator was on and
 * when it was last autosaved. Written/read via
 * {@link GameWizardDraftService}, never directly through
 * {@link ElectronStoreService.get}/{@link ElectronStoreService.set} from
 * outside that service.
 *
 * @remarks
 * Stored in plaintext, matching the storage posture of the eventual
 * `deployment-config.json` write this draft becomes on submit — neither is
 * field-level encrypted, unlike the AWS/pasted-credentials/passphrase
 * fields above, which are genuine secrets.
 */
export interface StoredGameWizardDraft {
  draft: GameWizardDraft;
  stepIndex: number;
  /** ISO-8601 timestamp of the most recent autosave. */
  savedAt: string;
}
```

Then add one field to `AppStoreSchema` (after the `pulumi?: { ... };` field, before the interface's closing `}`):

```ts
  /**
   * The single in-progress add-game wizard draft, if any — see
   * {@link StoredGameWizardDraft}. Only one slot exists: only one add-game
   * wizard can be open in the UI at a time.
   */
  addGameWizardDraft?: StoredGameWizardDraft;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- ElectronStoreService.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and typecheck**

Run: `npm run app:lint && npm run app:typecheck`
Expected: both clean (checks the new TSDoc comments parse and the schema key is well-typed).

- [ ] **Step 6: Commit**

```bash
git add app/packages/desktop-main/src/services/ElectronStoreService.ts app/packages/desktop-main/src/services/ElectronStoreService.test.ts
git commit -m "feat(desktop-main): add addGameWizardDraft to ElectronStoreService schema"
```

---

## Task 2: `GameWizardDraftService`

**Files:**
- Create: `app/packages/desktop-main/src/services/GameWizardDraftService.ts`
- Test: `app/packages/desktop-main/src/services/GameWizardDraftService.test.ts`

**Interfaces:**
- Consumes: `ElectronStoreService.get('addGameWizardDraft')`, `.set('addGameWizardDraft', StoredGameWizardDraft)`, `.delete('addGameWizardDraft')` (Task 1). `GameWizardDraft`/`StoredGameWizardDraft` types (Task 1).
- Produces: `GameWizardDraftService` with `get(): StoredGameWizardDraft | null`, `save(draft: GameWizardDraft, stepIndex: number): void`, `clear(): void` — consumed by `GamesController` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `app/packages/desktop-main/src/services/GameWizardDraftService.test.ts`:

```ts
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { GameWizardDraftService } from './GameWizardDraftService.js';
import type { ElectronStoreService, GameWizardDraft, StoredGameWizardDraft } from './ElectronStoreService.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build an `ElectronStoreService` stub whose `get`/`set`/`delete` calls are observable/overridable per test. */
function makeStore(initial?: StoredGameWizardDraft): ElectronStoreService {
  let current = initial;
  const stub: Partial<ElectronStoreService> = {
    get: vi.fn((key: string) => (key === 'addGameWizardDraft' ? current : undefined)) as ElectronStoreService['get'],
    set: vi.fn((_key: string, value: unknown) => {
      current = value as StoredGameWizardDraft;
    }) as ElectronStoreService['set'],
    delete: vi.fn(() => {
      current = undefined;
    }) as ElectronStoreService['delete'],
  };
  return stub as ElectronStoreService;
}

const sampleDraft: GameWizardDraft = {
  name: 'mygame',
  image: 'some/image',
  connect_message: '',
  cpu: 256,
  memory: 512,
  ports: [],
  volumes: [],
  file_seeds: [],
  environment: [],
  https: false,
};

describe('GameWizardDraftService', () => {
  describe('get', () => {
    it('should return null when no draft has been saved', () => {
      const service = new GameWizardDraftService(makeStore());
      expect(service.get()).toBeNull();
    });

    it('should return the saved draft when one exists', () => {
      const stored: StoredGameWizardDraft = { draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' };
      const service = new GameWizardDraftService(makeStore(stored));
      expect(service.get()).toEqual(stored);
    });

    it('should return null and log a warning when the stored entry is missing required fields', () => {
      const store = makeStore();
      vi.mocked(store.get).mockReturnValue({ draft: sampleDraft } as unknown as StoredGameWizardDraft);
      const service = new GameWizardDraftService(store);

      expect(service.get()).toBeNull();
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    });

    it('should return null and log a warning when reading throws', () => {
      const store = makeStore();
      vi.mocked(store.get).mockImplementation(() => {
        throw new Error('boom');
      });
      const service = new GameWizardDraftService(store);

      expect(service.get()).toBeNull();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
  });

  describe('save', () => {
    it('should write the draft and step index, stamping savedAt itself', () => {
      const store = makeStore();
      const service = new GameWizardDraftService(store);

      service.save(sampleDraft, 3);

      expect(store.set).toHaveBeenCalledWith(
        'addGameWizardDraft',
        expect.objectContaining({ draft: sampleDraft, stepIndex: 3, savedAt: expect.any(String) }),
      );
    });

    it('should not throw when the underlying write fails', () => {
      const store = makeStore();
      vi.mocked(store.set).mockImplementation(() => {
        throw new Error('disk full');
      });
      const service = new GameWizardDraftService(store);

      expect(() => service.save(sampleDraft, 0)).not.toThrow();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    });
  });

  describe('clear', () => {
    it('should delete the stored draft', () => {
      const stored: StoredGameWizardDraft = { draft: sampleDraft, stepIndex: 0, savedAt: '2026-08-09T00:00:00.000Z' };
      const store = makeStore(stored);
      const service = new GameWizardDraftService(store);

      service.clear();

      expect(store.delete).toHaveBeenCalledWith('addGameWizardDraft');
    });

    it('should not throw when the underlying delete fails', () => {
      const store = makeStore();
      vi.mocked(store.delete).mockImplementation(() => {
        throw new Error('locked');
      });
      const service = new GameWizardDraftService(store);

      expect(() => service.clear()).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- GameWizardDraftService.test.ts`
Expected: FAIL — `Cannot find module './GameWizardDraftService.js'`.

- [ ] **Step 3: Write the implementation**

Create `app/packages/desktop-main/src/services/GameWizardDraftService.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { logger } from '../logger.js';
import { ElectronStoreService, type GameWizardDraft, type StoredGameWizardDraft } from './ElectronStoreService.js';

/**
 * Owns the single in-progress add-game wizard draft slot in
 * `ElectronStoreService`. A corrupt or unexpectedly-shaped stored entry is
 * treated the same as no draft — {@link get} never throws and never returns
 * a value the caller can't trust, matching `FirstRunWizardService`'s
 * degrade-on-corruption behavior for its own resumable state.
 */
@Injectable()
export class GameWizardDraftService {
  constructor(private readonly store: ElectronStoreService) {}

  /**
   * Reads the saved draft, if any.
   *
   * @returns The saved draft, or `null` if none is saved or the stored
   *   entry is corrupt/unreadable.
   */
  get(): StoredGameWizardDraft | null {
    try {
      const stored = this.store.get('addGameWizardDraft');
      if (!isStoredGameWizardDraft(stored)) return null;
      return stored;
    } catch (err) {
      logger.warn(`GameWizardDraftService: failed to read draft, treating as absent (${errorMessage(err)})`);
      return null;
    }
  }

  /**
   * Saves `draft` and `stepIndex`, stamping `savedAt` with the current time.
   * Failures are logged and swallowed — autosave is best-effort and must
   * never interrupt the operator mid-wizard.
   *
   * @param draft - The current wizard field values.
   * @param stepIndex - The wizard step the operator was on when this save fired.
   */
  save(draft: GameWizardDraft, stepIndex: number): void {
    try {
      this.store.set('addGameWizardDraft', { draft, stepIndex, savedAt: new Date().toISOString() });
    } catch (err) {
      logger.warn(`GameWizardDraftService: failed to save draft (${errorMessage(err)})`);
    }
  }

  /** Deletes the saved draft, if any. A no-op (still logged on failure) if none was saved. */
  clear(): void {
    try {
      this.store.delete('addGameWizardDraft');
    } catch (err) {
      logger.warn(`GameWizardDraftService: failed to clear draft (${errorMessage(err)})`);
    }
  }
}

/** Narrows `value` to a well-formed {@link StoredGameWizardDraft} — never partially trusting a malformed read. */
function isStoredGameWizardDraft(value: unknown): value is StoredGameWizardDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredGameWizardDraft>;
  if (typeof candidate.stepIndex !== 'number' || typeof candidate.savedAt !== 'string') return false;
  return isGameWizardDraft(candidate.draft);
}

/** Narrows `value` to a well-formed {@link GameWizardDraft}. */
function isGameWizardDraft(value: unknown): value is GameWizardDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GameWizardDraft>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.image === 'string' &&
    typeof candidate.connect_message === 'string' &&
    (typeof candidate.cpu === 'number' || candidate.cpu === null) &&
    (typeof candidate.memory === 'number' || candidate.memory === null) &&
    Array.isArray(candidate.ports) &&
    Array.isArray(candidate.volumes) &&
    Array.isArray(candidate.file_seeds) &&
    Array.isArray(candidate.environment) &&
    typeof candidate.https === 'boolean'
  );
}

/** `Error.message` for a genuine `Error`, or `String(err)` otherwise — never logs a raw thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- GameWizardDraftService.test.ts`
Expected: PASS (all cases from Step 1).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run app:lint && npm run app:typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add app/packages/desktop-main/src/services/GameWizardDraftService.ts app/packages/desktop-main/src/services/GameWizardDraftService.test.ts
git commit -m "feat(desktop-main): add GameWizardDraftService"
```

---

## Task 3: `games.draft.*` IPC handlers + module wiring

**Files:**
- Modify: `app/packages/desktop-main/src/controllers/games.controller.ts`
- Modify: `app/packages/desktop-main/src/app.module.ts`
- Modify: `app/packages/desktop-main/src/controllers/games.controller.test.ts`

**Interfaces:**
- Consumes: `GameWizardDraftService` (Task 2), `StoredGameWizardDraft`/`GameWizardDraft` (Task 1).
- Produces: IPC channels `games.draft.get` → `StoredGameWizardDraft | null`, `games.draft.save` (payload `{ draft: GameWizardDraft; stepIndex: number }`) → `void`, `games.draft.clear` → `void`. Consumed by the preload bridge in Task 4.

- [ ] **Step 1: Write the failing test**

Read the top of the existing `games.controller.test.ts` (already shown above — `makeConfig`/`makeEcs`/`makeDeploymentConfig`/`makeGamesWrite` helpers, `PATTERN_METADATA_KEY`, and however the file currently instantiates `GamesController`) and add, following the same helper style:

```ts
import type { GameWizardDraftService } from '../services/GameWizardDraftService.js';
import type { StoredGameWizardDraft } from '../services/ElectronStoreService.js';

/** Build a `GameWizardDraftService` stub with all three methods pre-wired. */
function makeGameWizardDraft(): GameWizardDraftService {
  return {
    get: vi.fn().mockReturnValue(null),
    save: vi.fn(),
    clear: vi.fn(),
  } as Partial<GameWizardDraftService> as GameWizardDraftService;
}

describe('games.draft.* handlers', () => {
  it('should register games.draft.get, games.draft.save, and games.draft.clear as MessagePatterns', () => {
    const controller = new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), makeGameWizardDraft());
    for (const [method, pattern] of [
      ['getDraft', 'games.draft.get'],
      ['saveDraft', 'games.draft.save'],
      ['clearDraft', 'games.draft.clear'],
    ] as const) {
      expect(Reflect.getMetadata(PATTERN_METADATA_KEY, controller[method])).toBe(pattern);
    }
  });

  it('should return the draft service result verbatim from games.draft.get', () => {
    const draftService = makeGameWizardDraft();
    const stored: StoredGameWizardDraft = {
      draft: {
        name: 'mygame', image: 'some/image', connect_message: '', cpu: 256, memory: 512,
        ports: [], volumes: [], file_seeds: [], environment: [], https: false,
      },
      stepIndex: 1,
      savedAt: '2026-08-09T00:00:00.000Z',
    };
    vi.mocked(draftService.get).mockReturnValue(stored);
    const controller = new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), draftService);

    expect(controller.getDraft()).toEqual(stored);
  });

  it('should forward the payload to GameWizardDraftService.save from games.draft.save', () => {
    const draftService = makeGameWizardDraft();
    const controller = new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), draftService);
    const draft = {
      name: 'mygame', image: 'some/image', connect_message: '', cpu: 256, memory: 512,
      ports: [], volumes: [], file_seeds: [], environment: [], https: false,
    };

    controller.saveDraft({ draft, stepIndex: 2 });

    expect(draftService.save).toHaveBeenCalledWith(draft, 2);
  });

  it('should call GameWizardDraftService.clear from games.draft.clear', () => {
    const draftService = makeGameWizardDraft();
    const controller = new GamesController(makeConfig(), makeEcs(), makeDeploymentConfig(), makeGamesWrite(), draftService);

    controller.clearDraft();

    expect(draftService.clear).toHaveBeenCalled();
  });
});
```

Update every other `new GamesController(...)` call already in the file to pass a 5th `makeGameWizardDraft()` argument — the constructor signature is changing in Step 3 below, so the existing calls will fail to compile otherwise.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- games.controller.test.ts`
Expected: FAIL — `Expected 4 arguments, but got 5` / `Property 'getDraft' does not exist on type 'GamesController'`.

- [ ] **Step 3: Write the implementation**

In `games.controller.ts`, add the import and constructor parameter:

```ts
import { GameWizardDraftService } from '../services/GameWizardDraftService.js';
import type { GameWizardDraft, StoredGameWizardDraft } from '../services/ElectronStoreService.js';
```

```ts
  constructor(
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly gamesWrite: GamesWriteService,
    private readonly gameWizardDraft: GameWizardDraftService,
  ) {}
```

Then add three handlers at the end of the class, before its closing `}` (after `deleteGame`):

```ts
  /**
   * Returns the saved add-game wizard draft, if any.
   *
   * Reachable via the Electron IPC transport (`games.draft.get`).
   */
  @MessagePattern('games.draft.get')
  getDraft(): StoredGameWizardDraft | null {
    logger.debug('GamesController: games.draft.get invoked');
    return this.gameWizardDraft.get();
  }

  /**
   * Saves the current add-game wizard draft and step index.
   *
   * Reachable via the Electron IPC transport (`games.draft.save`).
   */
  @MessagePattern('games.draft.save')
  saveDraft(@Payload() payload: { draft: GameWizardDraft; stepIndex: number }): void {
    logger.debug('GamesController: games.draft.save invoked');
    this.gameWizardDraft.save(payload.draft, payload.stepIndex);
  }

  /**
   * Clears the saved add-game wizard draft.
   *
   * Reachable via the Electron IPC transport (`games.draft.clear`).
   */
  @MessagePattern('games.draft.clear')
  clearDraft(): void {
    logger.debug('GamesController: games.draft.clear invoked');
    this.gameWizardDraft.clear();
  }
```

In `app.module.ts`: add the import `import { GameWizardDraftService } from './services/GameWizardDraftService.js';` alongside the other service imports, and add `GameWizardDraftService,` to the `providers:` array (after `GamesWriteService,`). `ElectronStoreModule` is already in `imports:`, so `GameWizardDraftService`'s `ElectronStoreService` dependency resolves without further changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- games.controller.test.ts`
Expected: PASS, including every pre-existing test in the file (their `new GamesController(...)` calls now compile with the 5th argument added in Step 1).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run app:lint && npm run app:typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add app/packages/desktop-main/src/controllers/games.controller.ts app/packages/desktop-main/src/controllers/games.controller.test.ts app/packages/desktop-main/src/app.module.ts
git commit -m "feat(desktop-main): add games.draft.get/save/clear IPC handlers"
```

---

## Task 4: Preload bridge

**Files:**
- Modify: `app/packages/desktop-preload/src/hyveon-api.ts`
- Modify: `app/packages/desktop-preload/src/preload.ts`
- Modify: `app/packages/desktop-preload/src/preload.test.ts`

**Interfaces:**
- Consumes: IPC channels `games.draft.get`/`games.draft.save`/`games.draft.clear` (Task 3).
- Produces: `window.hyveon.games.draft.get/save/clear`, typed via `HyveonGamesApi['draft']`. Consumed by `app.service.ts` in Task 5.

- [ ] **Step 1: Write the failing test**

In `preload.test.ts`, alongside the existing `games.create`/`games.update`/`games.delete` forwarding tests (the block shown earlier around line 171), add:

```ts
it('should forward games.draft.get to ipcRenderer.invoke when no mock is registered', async () => {
  ipcInvoke.mockResolvedValue(null);
  const games = bridge['games'] as { draft: { get: () => Promise<unknown> } };
  const result = await games.draft.get();

  expect(ipcInvoke).toHaveBeenCalledWith('games.draft.get');
  expect(result).toBeNull();
});

it('should forward games.draft.save with a single payload object to ipcRenderer.invoke', async () => {
  const games = bridge['games'] as { draft: { save: (payload: unknown) => Promise<unknown> } };
  const payload = { draft: { name: 'mygame' }, stepIndex: 2 };

  await games.draft.save(payload);

  expect(ipcInvoke).toHaveBeenCalledWith('games.draft.save', payload);
});

it('should forward games.draft.clear to ipcRenderer.invoke', async () => {
  const games = bridge['games'] as { draft: { clear: () => Promise<unknown> } };

  await games.draft.clear();

  expect(ipcInvoke).toHaveBeenCalledWith('games.draft.clear');
});
```

Match whatever variable name the existing `games.create` tests use for the mocked `ipcRenderer.invoke` spy (shown as `ipcInvoke` above — read the file's top to confirm before using it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- preload.test.ts`
Expected: FAIL — `games.draft is undefined`.

- [ ] **Step 3: Write the implementation**

In `hyveon-api.ts`:

1. Add the draft types near the other `Game*` shapes (after `DeleteGamePayload`, before the `DriftKind` section):

```ts
/**
 * In-progress add-game wizard field values.
 *
 * Mirrors `GameWizardDraft` in
 * `@hyveon/desktop-main/src/services/ElectronStoreService.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface GameWizardDraft {
  name: string;
  image: string;
  connect_message: string;
  cpu: number | null;
  memory: number | null;
  ports: { container: number | null; protocol: string }[];
  volumes: { name: string; container_path: string }[];
  file_seeds: { path: string; content: string; content_base64: string; mode: string }[];
  environment: { name: string; value: string }[];
  https: boolean;
}

/**
 * A saved add-game wizard draft plus which step the operator was on and
 * when it was last autosaved.
 *
 * Mirrors `StoredGameWizardDraft` in
 * `@hyveon/desktop-main/src/services/ElectronStoreService.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface StoredGameWizardDraft {
  draft: GameWizardDraft;
  stepIndex: number;
  savedAt: string;
}
```

2. Extend `HyveonGamesApi` (the interface with `list`/`status`/`getStatus`/`start`/`stop`/`create`/`update`/`delete`) by adding one field:

```ts
  /** Save/resume/discard endpoints for the single in-progress add-game wizard draft. */
  draft: {
    /** Returns the saved draft, or `null` if none is saved. */
    get: () => Promise<StoredGameWizardDraft | null>;
    /** Saves the current draft and step index. */
    save: (payload: { draft: GameWizardDraft; stepIndex: number }) => Promise<void>;
    /** Clears the saved draft. */
    clear: () => Promise<void>;
  };
```

In `preload.ts`:

1. Add `GameWizardDraft, StoredGameWizardDraft,` to the `import type { ... } from './hyveon-api.js';` block (alphabetically among the existing `Game*` imports).
2. Extend the `api.games` object (shown earlier at preload.ts:668-680) by adding, after the `delete: (payload: DeleteGamePayload) => invoke('games.delete', payload),` line:

```ts
    draft: {
      get: () => invoke<StoredGameWizardDraft | null>('games.draft.get'),
      save: (payload: { draft: GameWizardDraft; stepIndex: number }) => invoke<void>('games.draft.save', payload),
      clear: () => invoke<void>('games.draft.clear'),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- preload.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and typecheck**

Run: `npm run app:lint && npm run app:typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add app/packages/desktop-preload/src/hyveon-api.ts app/packages/desktop-preload/src/preload.ts app/packages/desktop-preload/src/preload.test.ts
git commit -m "feat(desktop-preload): bridge games.draft.get/save/clear"
```

---

## Task 5: Renderer `api.service.ts` wrappers

**Files:**
- Modify: `app/packages/web/src/api.service.ts`

**Interfaces:**
- Consumes: `window.hyveon.games.draft.get/save/clear` (Task 4).
- Produces: `api.getGameDraft()`, `api.saveGameDraft(draft, stepIndex)`, `api.clearGameDraft()` — consumed by `AddGameWizard`/`GamesPage` in Tasks 6-7.

No dedicated test file exists for `api.service.ts` itself (its wrappers are exercised indirectly through the component tests that mock `../../api.service.js` — see Tasks 6-7's own tests). This task is implementation-only, verified by typecheck plus the consuming components' tests in later tasks.

- [ ] **Step 1: Add the type + wrapper functions**

Add near the top of `api.service.ts`, alongside the other `Game*` interfaces (after `GameListEntry`):

```ts
/**
 * In-progress add-game wizard field values.
 *
 * Mirrors `WizardDraft` in
 * `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts` —
 * that file is the source of truth; keep this copy in sync with it.
 */
export interface GameWizardDraft {
  name: string;
  image: string;
  connect_message: string;
  cpu: number | null;
  memory: number | null;
  ports: { container: number | null; protocol: string }[];
  volumes: { name: string; container_path: string }[];
  file_seeds: { path: string; content: string; content_base64: string; mode: string }[];
  environment: { name: string; value: string }[];
  https: boolean;
}

/** A saved add-game wizard draft plus which step the operator was on and when it was last autosaved. */
export interface StoredGameWizardDraft {
  draft: GameWizardDraft;
  stepIndex: number;
  savedAt: string;
}
```

Then add three wrappers to the `export const api = { ... }` object (after `deleteGame: ...`):

```ts
  getGameDraft: async (): Promise<StoredGameWizardDraft | null> =>
    hyveon().games.draft.get() as Promise<StoredGameWizardDraft | null>,
  saveGameDraft: async (draft: GameWizardDraft, stepIndex: number): Promise<void> =>
    hyveon().games.draft.save({ draft, stepIndex }) as Promise<void>,
  clearGameDraft: async (): Promise<void> => hyveon().games.draft.clear() as Promise<void>,
```

- [ ] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: clean — confirms the new wrappers match `HyveonGamesApi['draft']`'s shape from Task 4.

- [ ] **Step 3: Lint**

Run: `npm run app:lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/packages/web/src/api.service.ts
git commit -m "feat(web): add getGameDraft/saveGameDraft/clearGameDraft api wrappers"
```

---

## Task 6: `AddGameWizard` autosave, flush, clear-on-submit, resume

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx`
- Modify: `app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx`

**Interfaces:**
- Consumes: `api.getGameDraft`/`saveGameDraft`/`clearGameDraft` (Task 5), `WizardDraft`/`createEmptyWizardDraft`/`WIZARD_STEPS` (existing `wizard-form.utils.ts`).
- Produces: `AddGameWizard` accepts two new optional props, `initialDraft?: WizardDraft` and `initialStepIndex?: number` — consumed by `GamesPage` in Task 7 to resume into a saved draft.

- [ ] **Step 1: Write the failing tests**

Add to `add-game-wizard.component.test.tsx`. First, extend the `apiMock` hoisted object (Step 1's existing block at the top of the file) with the three new methods:

```ts
const apiMock = vi.hoisted(() => ({
  games: vi.fn(),
  createGame: vi.fn(),
  getGameDraft: vi.fn(),
  saveGameDraft: vi.fn(),
  clearGameDraft: vi.fn(),
}));
```

And reset them in every `beforeEach` alongside the existing resets:

```ts
apiMock.getGameDraft.mockResolvedValue(null);
apiMock.saveGameDraft.mockClear();
apiMock.clearGameDraft.mockClear();
```

Then add a new top-level `describe` block using fake timers:

```ts
describe('AddGameWizard — draft autosave', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.createGame.mockReset();
    apiMock.getGameDraft.mockResolvedValue(null);
    apiMock.saveGameDraft.mockClear();
    apiMock.clearGameDraft.mockClear();
    navigateMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not autosave while the draft is still empty', async () => {
    await openWizard();

    await vi.advanceTimersByTimeAsync(1100);

    expect(apiMock.saveGameDraft).not.toHaveBeenCalled();
  });

  it('should autosave the draft and step index after edits settle for about 1 second', async () => {
    await openWizard();
    await fillIdentityStep();

    await vi.advanceTimersByTimeAsync(1100);

    expect(apiMock.saveGameDraft).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mygame', image: 'some/image' }),
      0,
    );
  });

  it('should not autosave while the wizard is submitting', async () => {
    apiMock.createGame.mockImplementation(() => new Promise(() => {})); // never resolves
    await openWizard();
    await fillHappyPathToReview();
    apiMock.saveGameDraft.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await vi.advanceTimersByTimeAsync(1100);

    expect(apiMock.saveGameDraft).not.toHaveBeenCalled();
  });

  it('should flush a pending save immediately when the dialog closes', async () => {
    await openWizard();
    await fillIdentityStep();

    await userEvent.keyboard('{Escape}');

    expect(apiMock.saveGameDraft).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mygame', image: 'some/image' }),
      0,
    );
  });

  it('should clear the saved draft on successful submit', async () => {
    apiMock.createGame.mockResolvedValue({ ok: true, games: [] });
    await openWizard();
    await fillHappyPathToReview();

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(apiMock.clearGameDraft).toHaveBeenCalled());
  });

  it('should not clear the saved draft on a failed submit', async () => {
    apiMock.createGame.mockResolvedValue({ ok: false, code: 'error', message: 'boom' });
    await openWizard();
    await fillHappyPathToReview();

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await screen.findByRole('alert');
    expect(apiMock.clearGameDraft).not.toHaveBeenCalled();
  });
});

describe('AddGameWizard — resuming from a saved draft', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.createGame.mockReset();
    apiMock.getGameDraft.mockResolvedValue(null);
    apiMock.saveGameDraft.mockClear();
    apiMock.clearGameDraft.mockClear();
    navigateMock.mockClear();
  });

  it('should open pre-populated with an initialDraft and initialStepIndex', async () => {
    render(
      <AddGameWizard
        initialDraft={{
          name: 'resumed', image: 'some/image', connect_message: '', cpu: 256, memory: 512,
          ports: [], volumes: [], file_seeds: [], environment: [], https: false,
        }}
        initialStepIndex={1}
      />,
    );

    await screen.findByText('Step 2 of 6: Resources');
  });
});
```

Note: the last test does not click the trigger button — resuming means the wizard should already be open. This requires the dialog's initial open state to be seeded from whether `initialDraft` was supplied (Step 3 below), not from a controlled `open` prop passed every render: a controlled prop pinned to `true` by the parent would leave `handleOpenChange(false)` unable to actually close the dialog (`open` would keep coming back from the parent on the next render), which is the wrong behavior for a dialog the operator must still be able to close/cancel. Every pre-existing test in the file renders `<AddGameWizard />` with no props and continues to use the trigger button — do not change that path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- add-game-wizard.component.test.tsx`
Expected: FAIL — `saveGameDraft`/`getGameDraft`/`clearGameDraft` not called, `initialDraft`/`initialStepIndex`/`open` props not recognized by the type.

- [ ] **Step 3: Write the implementation**

In `add-game-wizard.component.tsx`:

1. Change the import to include the new API wrapper names and the new draft type:

```ts
import { api, type GameServer, type GameWizardDraft } from '../../api.service.js';
```

2. Add props and switch `open`/`stepIndex`/`draft` to accept optional externally-supplied initial values:

```ts
/** Props accepted by {@link AddGameWizard}. All optional — every existing call site (`<AddGameWizard />`) keeps working unchanged. */
export interface AddGameWizardProps {
  /** Pre-populates the draft, e.g. when resuming a saved draft from the games-page banner. Supplying this also opens the dialog immediately, skipping the trigger-button click. */
  initialDraft?: WizardDraft;
  /** Pre-populates the step index alongside `initialDraft`. Ignored without `initialDraft`. */
  initialStepIndex?: number;
}

export function AddGameWizard({ initialDraft, initialStepIndex }: AddGameWizardProps = {}) {
  const navigate = useNavigate();

  // Seeding `open`'s initial value from `initialDraft` (rather than a
  // controlled `open` prop the parent keeps passing every render) means the
  // dialog's own `handleOpenChange(false)` remains the single source of
  // truth for closing it — a resumed wizard can still be cancelled/closed
  // normally, unlike a parent-pinned `open={true}` prop that `Dialog` would
  // never see flip back to `false`.
  const [open, setOpen] = useState(initialDraft !== undefined);
  const [stepIndex, setStepIndex] = useState(initialStepIndex ?? 0);
  const [draft, setDraft] = useState<WizardDraft>(initialDraft ?? createEmptyWizardDraft());
```

(`setOpen`'s remaining internal uses become `setOpenState`; everything below this point — `existingGames`, `submitting`, etc. — is unchanged.)

3. Add a ref tracking whether the draft has ever been edited away from its initial value (so an unedited resumed draft doesn't immediately re-save itself), a debounce-timer ref, and the autosave effect. Insert after the existing `openRef` declaration:

```ts
  /** True once the operator has made at least one edit — gates autosave so an untouched (or freshly-resumed, unedited) draft never writes itself back out. */
  const hasEditedRef = useRef(false);
  /** Pending debounce timer for the autosave effect below; cleared/replaced on every draft change, flushed immediately on close/unmount. */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hasEditedRef.current || submitting) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void api.saveGameDraft(draft, stepIndex);
    }, 1000);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [draft, stepIndex, submitting]);

  /** Immediately writes any pending debounced save, bypassing the timer — call before the draft state it captured is discarded (dialog close, unmount). */
  function flushPendingSave() {
    if (saveTimerRef.current === null || !hasEditedRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    void api.saveGameDraft(draft, stepIndex);
  }

  useEffect(() => {
    return () => flushPendingSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flushPendingSave intentionally closes over the latest draft/stepIndex via the outer closure, not a dependency the effect should re-run for
  }, []);
```

4. Mark `hasEditedRef.current = true` inside `patchDraft` (the one place `draft` is ever mutated by operator input):

```ts
  function patchDraft(patch: Partial<WizardDraft>) {
    hasEditedRef.current = true;
    setServerIssues(null);
    setSubmitError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }
```

5. Update `resetWizard` to also reset `hasEditedRef`:

```ts
  function resetWizard() {
    setStepIndex(0);
    setDraft(createEmptyWizardDraft());
    setSubmitError(null);
    setServerIssues(null);
    setSubmitting(false);
    hasEditedRef.current = false;
  }
```

6. Update `handleOpenChange` to flush the pending save before resetting:

```ts
  function handleOpenChange(next: boolean) {
    openRef.current = next;
    setOpen(next);
    if (!next) {
      flushPendingSave();
      resetWizard();
    }
  }
```

7. In `handleSubmit`'s success branch, clear the saved draft right before closing:

```ts
      if (result.ok) {
        toast.success(`${payload.name} created`, {
          description: 'Run plan and apply on the Infrastructure page to deploy it.',
        });
        void api.clearGameDraft();
        handleOpenChange(false);
        navigate(`/games/${payload.name}`);
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- add-game-wizard.component.test.tsx`
Expected: PASS, including every pre-existing test in the file (the props are all optional and the uncontrolled path is unchanged).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run app:lint && npm run app:typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx
git commit -m "feat(web): autosave add-game wizard draft, resume from a saved draft"
```

---

## Task 7: Games-page resume/discard banner

**Files:**
- Modify: `app/packages/web/src/pages/games.page.tsx`
- Create: `app/packages/web/src/pages/games.page.test.tsx` (create if it doesn't already exist — check first; if it exists, extend it following its established conventions instead of the shape below)

**Interfaces:**
- Consumes: `api.getGameDraft`/`clearGameDraft` (Task 5), `AddGameWizard`'s `initialDraft`/`initialStepIndex`/`open` props (Task 6).

- [ ] **Step 1: Check for an existing test file**

Run: `find app/packages/web/src/pages -iname "games.page.test.tsx"`

If found, read it fully and match its existing mocking conventions (likely `vi.mock('../api.service.js', ...)` plus a `vi.mock('@/components/add-game-wizard/add-game-wizard.component', ...)`-style stub, given `GamesPage` mounts `AddGameWizard` twice) instead of the fresh setup below — adapt Step 2's tests into its existing `describe` structure rather than duplicating a second `apiMock`.

If not found, create it fresh per Step 2.

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GamesPage } from './games.page.js';

const apiMock = vi.hoisted(() => ({
  games: vi.fn(),
  getGameDraft: vi.fn(),
  clearGameDraft: vi.fn(),
  createGame: vi.fn(),
  drift: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const sampleDraft = {
  name: 'unfinished-game', image: 'some/image', connect_message: '', cpu: 256, memory: 512,
  ports: [], volumes: [], file_seeds: [], environment: [], https: false,
};

function renderGamesPage() {
  return render(
    <MemoryRouter>
      <GamesPage />
    </MemoryRouter>,
  );
}

describe('GamesPage — draft resume/discard banner', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.getGameDraft.mockResolvedValue(null);
    apiMock.clearGameDraft.mockClear();
    apiMock.drift.mockResolvedValue({ entries: [] });
  });

  it('should show no banner when no draft is saved', async () => {
    renderGamesPage();

    await screen.findByText('No games declared or deployed yet.');
    expect(screen.queryByText(/Unfinished draft/i)).not.toBeInTheDocument();
  });

  it('should show a Resume/Discard banner when a draft is saved', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    renderGamesPage();

    await screen.findByText(/Unfinished draft: unfinished-game/i);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a game server' })).not.toBeInTheDocument();
  });

  it('should open the wizard pre-filled when Resume is clicked', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    renderGamesPage();
    await screen.findByRole('button', { name: 'Resume' });

    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await screen.findByText('Step 3 of 6: Networking');
  });

  it('should clear the draft and hide the banner when Discard is clicked, without opening the wizard', async () => {
    apiMock.getGameDraft.mockResolvedValue({ draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' });
    renderGamesPage();
    await screen.findByRole('button', { name: 'Discard' });

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(apiMock.clearGameDraft).toHaveBeenCalled());
    expect(screen.queryByText(/Unfinished draft/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a game server' })).not.toBeInTheDocument();
  });
});
```

If `PendingChangesBanner` (mounted by the real `GamesPage`) isn't already stubbed by an existing test file, add `vi.mock('../components/pending-changes-banner.component.js', () => ({ PendingChangesBanner: () => null }));` so its own `api.drift()` polling doesn't interfere — check whether the existing file (if found in Step 1) already does this before adding a duplicate mock.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run app:test -- games.page.test.tsx`
Expected: FAIL — no banner rendered, `getGameDraft` never called.

- [ ] **Step 4: Write the implementation**

In `games.page.tsx`:

1. Add imports:

```ts
import { api, type GameListEntry, type StoredGameWizardDraft } from '../api.service.js';
```

(merge with the existing `import { api, type GameListEntry } from '../api.service.js';` line rather than duplicating it.)

2. Add draft state and a fetch effect, plus Resume/Discard handlers, inside `GamesPage` (after the existing `games`/`loading`/`error` state):

```ts
  const [draft, setDraft] = useState<StoredGameWizardDraft | null>(null);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getGameDraft()
      .then((saved) => {
        if (!cancelled) setDraft(saved);
      })
      .catch(() => {
        if (!cancelled) setDraft(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDiscardDraft() {
    await api.clearGameDraft();
    setDraft(null);
  }
```

3. Render the banner (placed above `<PendingChangesBanner />`, matching that component's own bordered-alert visual pattern) and the resumed wizard instance, inside the returned JSX:

```tsx
      {draft && !resuming && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-orange)]/40 bg-[var(--color-orange)]/10 px-4 py-3 text-sm text-[var(--color-orange)]"
        >
          <span>Unfinished draft: {draft.draft.name || 'untitled'}</span>
          <div className="flex items-center gap-3 shrink-0">
            <Button type="button" variant="outline" onClick={() => setResuming(true)}>
              Resume
            </Button>
            <Button type="button" variant="outline" onClick={() => void handleDiscardDraft()}>
              Discard
            </Button>
          </div>
        </div>
      )}
      {draft && resuming && (
        <AddGameWizard initialDraft={draft.draft} initialStepIndex={draft.stepIndex} />
      )}
```

Add `import { Button } from '@/components/ui/button.component';` to the top of the file alongside the other UI imports if not already present.

Known limitation, acceptable for this change's scope: once `resuming` becomes `true` the banner stops rendering and stays hidden even if the operator closes the resumed dialog without submitting (e.g. Escape) — the draft is still safely persisted (the flush-on-close from Task 6 fires normally), but the banner won't reappear to offer Resume again until the next full page load/app relaunch re-runs the `getGameDraft()` effect. Extending this to re-show the banner after an inline cancel is out of scope here; note it as a possible small follow-up rather than building it into this plan.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run app:test -- games.page.test.tsx`
Expected: PASS.

- [ ] **Step 6: Lint and typecheck**

Run: `npm run app:lint && npm run app:typecheck`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add app/packages/web/src/pages/games.page.tsx app/packages/web/src/pages/games.page.test.tsx
git commit -m "feat(web): resume/discard banner for a saved add-game wizard draft"
```

---

## Task 8: Documentation

**Files:**
- Modify: whichever page(s) under `docs/docs/app/` document the games page / add-game wizard.

- [ ] **Step 1: Identify and update the relevant docs page(s)**

Invoke the `write-docs` skill (per `CLAUDE.md`'s "Before opening a PR" section — a behavior change needs docs in the same PR) to update the page(s) describing the games list and add-game wizard, covering: the draft autosaves roughly every second while editing, an unfinished draft survives closing and relaunching the app, and the games page shows a Resume/Discard banner when one exists. Let the skill map the change to the exact page(s) under `docs/docs/app/` rather than guessing the filename here — it maps diffs to owning pages and runs its own accuracy/coverage/style review.

- [ ] **Step 2: Commit**

```bash
git add docs/docs/app/
git commit -m "docs(app): document add-game wizard draft persistence"
```

---

## Task 9: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full pre-PR gate**

Run: `npm run app:lint && npm run app:typecheck && npm run app:test`
Expected: all three exit 0.

- [ ] **Step 2: Run the integration suite**

This change adds new `@MessagePattern` controller handlers, so per `CLAUDE.md`'s "Before opening a PR" table, run the integration tier too:

Run: `npm run app:test:integration`
Expected: exits 0. (No new integration spec is required by this plan — the new handlers are already covered by `games.controller.test.ts`'s unit tests in Task 3 — but the existing integration suite must still pass with `GamesController`'s new constructor parameter wired into `AppModule`.)

- [ ] **Step 3: Manual smoke check** `- [~]`

Run `npm run desktop:run`, open the Games page, start the add-game wizard, fill in the Identity step, wait ~2 seconds, force-quit the app, relaunch, and confirm the Resume/Discard banner appears with the typed name and Resume reopens the wizard on the Identity step with the typed values intact. This is a manual/live-environment check not covered by an automated test in this plan — its equivalent automated coverage is Task 6's "should autosave the draft..." + "should flush a pending save..." tests and Task 7's "should open the wizard pre-filled when Resume is clicked" test, which exercise the same save/resume path against mocked IPC rather than a real running app.

No commit for this task — it's the final verification step before opening the PR.
