import { useState } from 'react';
import type { HyveonLambdaLogsApi } from '@hyveon/desktop-preload';
import { LAMBDA_FUNCTION_KEYS, type LambdaFunctionKey } from '@hyveon/shared';
import { Button } from '../components/ui/button.component.js';
import { LogTailView } from '../components/log-tail-view.component.js';
import { useLogTail, NO_HYVEON_LOG_TAIL_API, type LogTailApi } from '../hooks/use-log-tail.hook.js';

/**
 * Narrows `window.hyveon.logs.lambda`'s `LambdaFunctionKey`-typed methods
 * down to {@link LogTailApi}'s generic `string`-typed shape. `useLogTail` is
 * shared with the game-logs page and so is written against a plain
 * `target: string`; the cast back to `LambdaFunctionKey` here is safe
 * because this page only ever passes values drawn from
 * {@link LAMBDA_FUNCTION_KEYS} as `target`.
 *
 * @param api - The real `window.hyveon.logs.lambda` bridge.
 * @returns A {@link LogTailApi}-shaped adaptor over `api`.
 */
function toLogTailApi(api: HyveonLambdaLogsApi): LogTailApi {
  return {
    // `useLogTail` always calls `get(target)` with no `limit` — forwarding
    // `limit` unconditionally would pass an explicit `undefined` second
    // argument to `api.get`, which is observably different from omitting
    // it (e.g. to a `toHaveBeenCalledWith('watchdog')` assertion in tests).
    get: (target, limit) =>
      limit === undefined ? api.get(target as LambdaFunctionKey) : api.get(target as LambdaFunctionKey, limit),
    stream: (target) => api.stream(target as LambdaFunctionKey),
    getOlder: (target, beforeTimestamp, limit) => api.getOlder(target as LambdaFunctionKey, beforeTimestamp, limit),
    getNewer: (target, afterTimestamp, limit, excludeEventIds) =>
      api.getNewer(target as LambdaFunctionKey, afterTimestamp, limit, excludeEventIds),
  };
}

/**
 * Infrastructure Logs route (`/logs/infrastructure`) — live-tails CloudWatch
 * logs for a picked Lambda function. The tail engine itself is
 * {@link useLogTail} (design.md D6) and the shared header/controls/log-stream/
 * footer shell is {@link LogTailView}, both shared with `LogsPage` (`/logs`);
 * this page owns only the fixed 5-option {@link LambdaFunctionKey} picker and
 * `window.hyveon.logs.lambda` wiring.
 */
export function InfrastructureLogsPage() {
  const [selectedFunction, setSelectedFunction] = useState<LambdaFunctionKey>('watchdog');

  const tail = useLogTail(
    selectedFunction,
    window.hyveon ? toLogTailApi(window.hyveon.logs.lambda) : NO_HYVEON_LOG_TAIL_API,
  );

  return (
    <LogTailView
      title="Infrastructure Logs"
      subtitle="CloudWatch tail for the selected Lambda function."
      emptyMessage="Waiting for log lines…"
      tail={tail}
      error={tail.error}
      beforeControls={
        // Fixed 5-option set — never needs to collapse for space, unlike LogsPage's game combobox.
        <div className="flex flex-wrap gap-2">
          {LAMBDA_FUNCTION_KEYS.map((fn) => (
            <Button
              key={fn}
              variant={selectedFunction === fn ? 'default' : 'secondary'}
              size="sm"
              onClick={() => setSelectedFunction(fn)}
              aria-pressed={selectedFunction === fn}
            >
              {fn}
            </Button>
          ))}
        </div>
      }
    />
  );
}
