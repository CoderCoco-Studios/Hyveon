/** Characters Windows forbids in a file name, plus control characters. */
// eslint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;

/** File-name stems Windows reserves for devices, whatever the extension. */
const WINDOWS_RESERVED_STEM = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Name used when nothing usable is left of the requested one. */
const FALLBACK_NAME = 'download';

// @spec HELPER-XFER-003
/**
 * Turns a volume entry name into one the local file system accepts, for the save dialog's default name.
 *
 * @remarks
 * Linux and macOS only forbid `/` and NUL. Windows additionally forbids `<>:"\|?*` and control characters, trailing
 * dots and spaces, and device names such as `CON` or `COM1` (with or without an extension).
 *
 * @param name - The entry's base name, possibly with a `.zip` suffix.
 * @param platform - The platform the file will be saved on.
 * @returns A usable file name; `download` when the result would be empty.
 */
export function sanitizeLocalFileName(name: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') {
    // eslint-disable-next-line no-control-regex
    return name.replace(/[/\u0000]/g, '_') || FALLBACK_NAME;
  }
  const cleaned = name.replace(WINDOWS_FORBIDDEN, '_').replace(/[. ]+$/, '');
  if (!cleaned) return FALLBACK_NAME;
  const stem = cleaned.split('.')[0] ?? cleaned;
  return WINDOWS_RESERVED_STEM.test(stem) ? `_${cleaned}` : cleaned;
}
