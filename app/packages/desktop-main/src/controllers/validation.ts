import { BadRequestException } from '@nestjs/common';

/**
 * Type guard for a non-empty string.
 *
 * @param value - The value to check.
 * @returns Whether `value` is a `string` with `length > 0`.
 */
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

// @spec APP-IPC-ERR-004
/**
 * Verify a body field is either missing or an array of strings. Returns the
 * validated array (empty if the field was omitted), or throws
 * `BadRequestException` whose field message reaches the renderer through
 * `ipcErrorMessage`.
 */
export function requireStringArray(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new BadRequestException({
      success: false,
      error: `${field} must be an array of strings`,
    });
  }
  return value as string[];
}
