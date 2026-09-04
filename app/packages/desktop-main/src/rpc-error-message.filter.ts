import { Catch } from '@nestjs/common';
import type { ArgumentsHost, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { errMessage } from '@hyveon/shared';

/**
 * Global RPC exception filter that preserves the real `.message` of any
 * exception thrown from a `@MessagePattern` handler.
 *
 * @remarks
 * Without this filter registered, NestJS's own `BaseRpcExceptionFilter`
 * handles every thrown error: for anything that is not itself an
 * `RpcException`, `handleUnknownError()` discards the original message and
 * replaces it with the constant string `'Internal server error'` before the
 * error ever reaches {@link registerIpcMainBridges}'s `firstValueFrom`
 * unwrapping in `ipc-main-bridge.ts` — so that unwrapping alone cannot
 * recover a handler's real error text. Registering this filter via
 * `app.useGlobalFilters()` makes NestJS's `RpcExceptionsHandler` invoke it
 * instead of the base filter for every pattern, preserving the message so
 * the operator/renderer see the actual failure instead of a generic one.
 *
 * `@Catch()` with no arguments matches every exception type, mirroring
 * `BaseRpcExceptionFilter`'s own catch-all scope.
 */
@Catch()
export class RpcErrorMessageFilter implements RpcExceptionFilter<unknown> {
  /**
   * Re-emits `exception` as a rejected Observable carrying only its real
   * `.message`, in place of NestJS's default generic-message behavior.
   *
   * @param exception - the exception thrown by a `@MessagePattern` handler
   * @returns an Observable that errors with a plain `Error` whose message
   * is `exception.message` (or `String(exception)` for a non-`Error` throw)
   */
  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    const message = errMessage(exception);
    return throwError(() => new Error(message));
  }
}
