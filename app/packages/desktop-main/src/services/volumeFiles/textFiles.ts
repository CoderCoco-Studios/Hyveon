import type { Readable } from 'node:stream';

// @spec HELPER-EDIT-001
/** Reads `stream` fully unless it exceeds `limit` bytes; the stream is destroyed either way. */
export async function readCapped(stream: Readable, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > limit) return null;
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}

// @spec HELPER-EDIT-001
/** Decodes strict UTF-8; `null` when the bytes are not valid. */
export function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
