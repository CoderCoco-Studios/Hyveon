import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { EphemeralCert } from '../services/folderUpload/ephemeralCert.js';

/** Behaviour switches for {@link startFakeFileBrowser}. */
export interface FakeFileBrowserOptions {
  cert: EphemeralCert;
  username?: string;
  password?: string;
  /** Called before an upload is stored; return a status code to reject it, `'drop'` to kill the socket, or nothing to accept. */
  onUpload?: (path: string, attempt: number) => number | 'drop' | void;
  /** Files that already exist on the "volume" (absolute path to size). */
  seed?: Record<string, number>;
  /** Per-file RFC 3339 modification times; files not listed here report {@link DEFAULT_MODIFIED}. */
  seedModified?: Record<string, string>;
  /** Exact bytes served by `GET /api/raw` for a file; others serve `size` repetitions of `0x61`. Also seeds the file. */
  seedContent?: Record<string, Buffer>;
}

/** Modification time reported for every entry without a `seedModified` override. */
export const DEFAULT_MODIFIED = '2026-01-01T00:00:00Z';

/** Body of the fake `?algo=zip` response: a zip local-file-header signature, not a real archive. */
export const FAKE_ZIP_BODY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

/** A running fake FileBrowser helper and the state it observed. */
export interface FakeFileBrowser {
  port: number;
  /** Absolute remote path to stored byte length. */
  files: Map<string, number>;
  dirs: Set<string>;
  /** Every request received, in order (login bodies are not recorded). */
  requests: { method: string; url: string; auth?: string }[];
  close(): Promise<void>;
}

/** Reads and discards a request body, returning how many bytes it carried. */
async function drain(req: IncomingMessage): Promise<number> {
  let n = 0;
  for await (const chunk of req) n += (chunk as Buffer).length;
  return n;
}

/**
 * Starts an HTTPS server on 127.0.0.1 that speaks the slice of the FileBrowser REST API the uploader uses
 * (`/api/login`, `POST`/`GET`/`PATCH`/`DELETE /api/resources/...`). Test seam for the client and the end-to-end upload tests.
 */
export async function startFakeFileBrowser(options: FakeFileBrowserOptions): Promise<FakeFileBrowser> {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'secret';
  const files = new Map<string, number>(Object.entries(options.seed ?? {}));
  for (const [p, content] of Object.entries(options.seedContent ?? {})) files.set(p, content.length);
  const modifiedOf = (path: string): string => options.seedModified?.[path] ?? DEFAULT_MODIFIED;
  const dirs = new Set<string>(['/']);
  for (const p of files.keys()) {
    const parts = p.split('/').filter(Boolean).slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) dirs.add('/' + parts.slice(0, i).join('/'));
  }
  const requests: FakeFileBrowser['requests'] = [];
  const attempts = new Map<string, number>();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'https://x');
    requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['x-auth'] as string | undefined });

    if (url.pathname === '/api/login') {
      const body = JSON.parse(Buffer.concat(await collect(req)).toString('utf8')) as { username: string; password: string };
      if (body.username === username && body.password === password) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('fake-jwt');
      } else {
        res.writeHead(403).end();
      }
      return;
    }
    if (req.headers['x-auth'] !== 'fake-jwt') {
      await drain(req);
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/raw')) {
      const rawPath = decodeURIComponent(url.pathname.replace(/^\/api\/raw/, '')) || '/';
      if (url.searchParams.get('algo') === 'zip') {
        if (!dirs.has(rawPath.replace(/\/+$/, '') || '/')) return void res.writeHead(404).end();
        return void res.writeHead(200, { 'content-type': 'application/zip' }).end(FAKE_ZIP_BODY);
      }
      const size = files.get(rawPath);
      if (size === undefined) return void res.writeHead(404).end();
      const body = options.seedContent?.[rawPath] ?? Buffer.alloc(size, 0x61);
      return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
    }
    const resource = decodeURIComponent(url.pathname.replace(/^\/api\/resources/, '')) || '/';
    if (req.method === 'POST' && resource.endsWith('/')) {
      await drain(req);
      const dir = resource.replace(/\/+$/, '') || '/';
      if (dirs.has(dir)) return void res.writeHead(409).end();
      dirs.add(dir);
      return void res.writeHead(200).end();
    }
    if (req.method === 'POST') {
      const attempt = (attempts.get(resource) ?? 0) + 1;
      attempts.set(resource, attempt);
      const verdict = options.onUpload?.(resource, attempt);
      if (verdict === 'drop') return void req.socket.destroy();
      const size = await drain(req);
      if (typeof verdict === 'number') return void res.writeHead(verdict).end();
      if (url.searchParams.get('override') === 'false' && files.has(resource)) return void res.writeHead(409).end();
      files.set(resource, size);
      return void res.writeHead(200).end();
    }
    if (req.method === 'PATCH' && url.searchParams.get('action') === 'rename') {
      const destination = url.searchParams.get('destination') ?? '';
      const from = resource.replace(/\/+$/, '');
      const to = destination.replace(/\/+$/, '');
      const isFile = files.has(from);
      if (!isFile && !dirs.has(from)) return void res.writeHead(404).end();
      if (files.has(to) || dirs.has(to)) return void res.writeHead(409).end();
      const rebase = (p: string): string => to + p.slice(from.length);
      if (isFile) {
        files.set(to, files.get(from)!);
        files.delete(from);
      } else {
        for (const [f, size] of [...files]) {
          if (f.startsWith(`${from}/`)) {
            files.delete(f);
            files.set(rebase(f), size);
          }
        }
        for (const d of [...dirs]) {
          if (d === from || d.startsWith(`${from}/`)) {
            dirs.delete(d);
            dirs.add(rebase(d));
          }
        }
      }
      const parts = to.split('/').filter(Boolean).slice(0, -1);
      for (let i = 1; i <= parts.length; i += 1) dirs.add('/' + parts.slice(0, i).join('/'));
      return void res.writeHead(200).end();
    }
    if (req.method === 'DELETE') {
      const target = resource.replace(/\/+$/, '');
      if (files.delete(target)) return void res.writeHead(204).end();
      if (target === '' || !dirs.has(target)) return void res.writeHead(404).end();
      for (const f of [...files.keys()]) if (f.startsWith(`${target}/`)) files.delete(f);
      for (const d of [...dirs]) if (d === target || d.startsWith(`${target}/`)) dirs.delete(d);
      return void res.writeHead(204).end();
    }
    if (req.method === 'GET' && !resource.endsWith('/') && files.has(resource)) {
      const name = resource.slice(resource.lastIndexOf('/') + 1);
      const body = { name, isDir: false, size: files.get(resource), modified: modifiedOf(resource) };
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
    if (req.method === 'GET') {
      const dir = resource.replace(/\/+$/, '') || '/';
      if (!dirs.has(dir)) return void res.writeHead(404).end();
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const items: { name: string; isDir: boolean; size: number; modified: string }[] = [];
      for (const d of dirs) {
        if (d !== dir && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) items.push({ name: d.slice(prefix.length), isDir: true, size: 0, modified: modifiedOf(d) });
      }
      for (const [f, size] of files) {
        if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) items.push({ name: f.slice(prefix.length), isDir: false, size, modified: modifiedOf(f) });
      }
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: dir.slice(dir.lastIndexOf('/') + 1), isDir: true, size: 0, modified: modifiedOf(dir), items }));
    }
    res.writeHead(405).end();
  };

  const server: Server = createServer({ cert: options.cert.certPem, key: options.cert.keyPem }, (req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    files,
    dirs,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function collect(req: IncomingMessage): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks;
}
