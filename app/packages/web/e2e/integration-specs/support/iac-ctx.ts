import type { IpcMainInvokeEvent } from 'electron';

/** One `sender.send(channel, message)` call recorded by a {@link makeFakeIacCtx} fake. */
export interface FakeIacSenderCall {
  channel: string;
  message: unknown;
}

/**
 * The fake `ctx` plus call-tracking surface {@link makeFakeIacCtx} returns.
 */
export interface FakeIacCtx {
  /** The fake `ctx` to pass as `IacController.plan`/`.apply`/`.destroy`'s second argument. */
  ctx: { evt: IpcMainInvokeEvent };
  /** Every `sender.send(...)` call recorded, in order. */
  sentMessages: FakeIacSenderCall[];
  /** Fires every listener registered via `sender.once('destroyed', ...)` — lets a spec simulate the renderer window closing mid-run. */
  fireDestroyed: () => void;
}

/**
 * Builds a fake `ctx: { evt: { sender } }` second argument for
 * `IacController.plan`/`.apply`/`.destroy` — the shape those handlers pull a
 * `WebContents`-like `sender` out of (`send`/`isDestroyed`/`once`/
 * `removeListener`) to stream chunk/end messages and detect the renderer
 * window closing mid-run.
 *
 * Ported from `iac.controller.test.ts`'s vitest-only `makeCtx()`: that file
 * is excluded from `tsc` (`desktop-main/tsconfig.json` excludes
 * `src/**\/*.test.ts`), so its `vi.fn()`-based mock never has to satisfy
 * Electron's real `IpcMainInvokeEvent`/`WebContents` types structurally.
 * This harness has no vitest mocking utility available, and its specs ARE
 * typechecked (`typecheck:full` includes `e2e/**\/*`), so calls are tracked
 * with a plain array instead of `vi.fn()`, and the fake is cast to the real
 * Electron types via `as unknown as` — those interfaces are far too large
 * for a four-method fake to satisfy structurally, and this is the same
 * escape hatch `iac.controller.test.ts`'s own `makeCtx()` reaches for
 * (`{ evt: { sender } } as unknown as { evt: { sender: typeof sender } }`).
 */
export function makeFakeIacCtx(): FakeIacCtx {
  const sentMessages: FakeIacSenderCall[] = [];
  const destroyedListeners: Array<() => void> = [];

  const sender = {
    send: (channel: string, message: unknown) => {
      sentMessages.push({ channel, message });
    },
    isDestroyed: () => false,
    once: (event: string, listener: () => void) => {
      if (event === 'destroyed') destroyedListeners.push(listener);
    },
    removeListener: () => {
      /* no-op — no spec in this suite needs to assert listener removal */
    },
  };

  const ctx = { evt: { sender } } as unknown as { evt: IpcMainInvokeEvent };

  return {
    ctx,
    sentMessages,
    fireDestroyed: () => destroyedListeners.forEach((listener) => listener()),
  };
}

/**
 * Polls `fakeCtx.sentMessages` (populated by the fake `sender.send(...)`
 * {@link makeFakeIacCtx} installs) until a message on `channel` appears, or
 * throws once `timeoutMs` has elapsed. `IacController.plan`/`.apply`/
 * `.destroy` resolve their ack promise before their fire-and-forget streaming
 * loop has necessarily finished pushing every chunk/end message, so a spec
 * that wants an operation's terminal result must wait for the end-channel
 * message rather than assuming it's already present the instant `dispatch`
 * resolves.
 */
export async function waitForIacMessage(
  fakeCtx: FakeIacCtx,
  channel: string,
  timeoutMs = 5000,
): Promise<FakeIacSenderCall> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = fakeCtx.sentMessages.find((call) => call.channel === channel);
    if (found) return found;
    if (Date.now() > deadline) {
      const seen = fakeCtx.sentMessages.map((call) => call.channel).join(', ') || '(none)';
      throw new Error(`Timed out waiting for a "${channel}" message; channels seen so far: ${seen}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
