import 'reflect-metadata';
import { expect } from 'vitest';

/**
 * The metadata key NestJS stores on each method decorated with `@MessagePattern`.
 * Asserting this value is the only automated guard that prevents a typo in a
 * controller from silently breaking IPC — calling the method directly (as most
 * tests do) succeeds regardless of what string is registered with the transport.
 */
export const PATTERN_METADATA_KEY = 'microservices:pattern';

/**
 * Asserts that every `[method, channel]` pair in `rows` is the exact
 * `@MessagePattern` registered for that method on `proto`.
 * @param proto - the controller's prototype, e.g. `GamesController.prototype`
 * @param rows - `[methodName, channelName]` pairs, one per `@MessagePattern` handler on the controller
 */
export function expectChannels<T extends object>(proto: T, rows: ReadonlyArray<[keyof T, string]>): void {
  for (const [method, channel] of rows) {
    const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, proto[method] as object);
    expect(pattern).toEqual([channel]);
  }
}
