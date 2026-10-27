import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FileBrowserClient, PinMismatchError, type FileBrowserClientOptions } from './FileBrowserClient.js';
import { VolumeFileError } from '../volumeFiles/VolumeFileBackend.js';
import { generateEphemeralCert, type EphemeralCert } from './ephemeralCert.js';
import { startFakeFileBrowser, type FakeFileBrowser } from '../../testing/fake-filebrowser-server.js';

let cert: EphemeralCert;
let otherCert: EphemeralCert;
let tmp: string;
const servers: FakeFileBrowser[] = [];

beforeAll(async () => {
  cert = await generateEphemeralCert();
  otherCert = await generateEphemeralCert();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/** Starts a fake helper and returns client options targeting it. */
async function setup(
  serverCert: EphemeralCert,
  pinned: EphemeralCert,
  extra: Partial<Parameters<typeof startFakeFileBrowser>[0]> = {},
): Promise<{ server: FakeFileBrowser; options: FileBrowserClientOptions }> {
  const server = await startFakeFileBrowser({ cert: serverCert, ...extra });
  servers.push(server);
  return {
    server,
    options: {
      host: '127.0.0.1',
      port: server.port,
      username: 'admin',
      password: 'secret',
      certPem: pinned.certPem,
      fingerprint256: pinned.fingerprint256,
    },
  };
}

describe('generateEphemeralCert', () => {
  it('should produce a distinct certificate, key and fingerprint per call', () => {
    expect(cert.fingerprint256).not.toBe(otherCert.fingerprint256);
    expect(cert.keyPem).toContain('PRIVATE KEY');
    expect(cert.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe('FileBrowserClient', () => {
  it('should log in, create directories, upload a file through the counter and list it back', async () => {
    const { server, options } = await setup(cert, cert);
    tmp = await mkdtemp(join(tmpdir(), 'fbc-'));
    const local = join(tmp, 'a.bin');
    await writeFile(local, Buffer.alloc(300_000, 7));

    const client = new FileBrowserClient(options);
    await client.connect();
    await client.mkdir('/Data');
    await client.mkdir('/Data', { existOk: true });
    let counted = 0;
    await client.writeStream('/Data/a b.bin', createReadStream(local), { size: 300_000, overwrite: true, onBytes: (n) => (counted += n) });
    const entries = await client.list('/Data');
    await client.close();

    expect(counted).toBe(300_000);
    expect(server.files.get('/Data/a b.bin')).toBe(300_000);
    expect(entries).toEqual([{ name: 'a b.bin', isDir: false, size: 300_000, modifiedMs: Date.parse('2026-01-01T00:00:00Z') }]);
  });

  it('should throw an auth VolumeFileError carrying the status when connect is rejected', async () => {
    const { options } = await setup(cert, cert);
    const client = new FileBrowserClient({ ...options, password: 'wrong' });
    await expect(client.connect()).rejects.toMatchObject({ name: 'VolumeFileError', code: 'auth', status: 403 });
    await client.close();
  });

  it('should abort with PinMismatchError and send nothing when the server presents a different certificate', async () => {
    const { server, options } = await setup(otherCert, cert);
    const client = new FileBrowserClient(options);
    await expect(client.connect()).rejects.toBeInstanceOf(PinMismatchError);
    await client.close();
    expect(server.requests).toHaveLength(0);
  });

  it('should reject a certificate whose fingerprint differs even when the CA matches', async () => {
    const { server, options } = await setup(cert, cert);
    const client = new FileBrowserClient({ ...options, fingerprint256: otherCert.fingerprint256 });
    await expect(client.connect()).rejects.toBeInstanceOf(PinMismatchError);
    await client.close();
    expect(server.requests).toHaveLength(0);
  });

  it('should surface a non-2xx upload as a VolumeFileError carrying the status', async () => {
    const { options } = await setup(cert, cert, { onUpload: () => 500 });
    tmp = await mkdtemp(join(tmpdir(), 'fbc-'));
    const local = join(tmp, 'a.bin');
    await writeFile(local, 'hello');
    const client = new FileBrowserClient(options);
    await client.connect();
    await expect(client.writeStream('/a.bin', createReadStream(local), { size: 5, overwrite: true })).rejects.toMatchObject({
      name: 'VolumeFileError',
      code: 'failed',
      status: 500,
    });
    await client.close();
  });

  it('should refuse to call authenticated endpoints before connect', async () => {
    const { options } = await setup(cert, cert);
    const client = new FileBrowserClient(options);
    await expect(client.list('/')).rejects.toThrow(/Not logged in/);
    await client.close();
  });
});

describe('FileBrowserClient read operations', () => {
  const NAME = '/Data/a #1 ?%é.txt';

  /** Starts a fake helper seeded with {@link NAME} and returns a connected client. */
  async function connected(extra: Partial<Parameters<typeof startFakeFileBrowser>[0]> = {}): Promise<FileBrowserClient> {
    const { options } = await setup(cert, cert, { seed: { [NAME]: 3 }, ...extra });
    const client = new FileBrowserClient(options);
    await client.connect();
    return client;
  }

  /** Reads a stream to completion. */
  async function collectBytes(stream: AsyncIterable<Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  it('should list entries with modification times in milliseconds', async () => {
    const client = await connected();
    const entries = await client.list('/Data');
    await client.close();
    expect(entries).toEqual([{ name: 'a #1 ?%é.txt', isDir: false, size: 3, modifiedMs: Date.parse('2026-01-01T00:00:00Z') }]);
  });

  it('should honour a per-file modification time', async () => {
    const client = await connected({ seedModified: { [NAME]: '2026-03-04T05:06:07Z' } });
    const entries = await client.list('/Data');
    await client.close();
    expect(entries[0]?.modifiedMs).toBe(Date.parse('2026-03-04T05:06:07Z'));
  });

  it('should throw not-found when listing a missing directory', async () => {
    const client = await connected();
    const failure = client.list('/missing');
    await expect(failure).rejects.toBeInstanceOf(VolumeFileError);
    await expect(failure).rejects.toMatchObject({ code: 'not-found' });
    await client.close();
  });

  it('should stat a file', async () => {
    const client = await connected();
    const stat = await client.stat(NAME);
    await client.close();
    expect(stat).toMatchObject({ path: NAME, name: 'a #1 ?%é.txt', isDir: false, size: 3 });
  });

  it('should throw not-found when statting a missing path', async () => {
    const client = await connected();
    await expect(client.stat('/Data/missing.txt')).rejects.toMatchObject({ code: 'not-found' });
    await client.close();
  });

  it('should stream raw bytes for a file', async () => {
    const content = Buffer.from('xyz');
    const client = await connected({ seedContent: { [NAME]: content } });
    const bytes = await collectBytes(await client.readStream(NAME));
    await client.close();
    expect(bytes).toEqual(content);
  });

  it('should throw not-found when reading a missing file', async () => {
    const client = await connected();
    await expect(client.readStream('/Data/missing.txt')).rejects.toMatchObject({ code: 'not-found' });
    await client.close();
  });

  it('should stream a zip for a directory archive', async () => {
    const client = await connected();
    expect(client.supportsArchive).toBe(true);
    const bytes = await collectBytes(await client.archiveStream('/Data'));
    await client.close();
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('should map 401 to auth', async () => {
    const { options } = await setup(cert, cert);
    const client = new FileBrowserClient({ ...options, password: 'wrong' });
    await expect(client.connect()).rejects.toMatchObject({ name: 'VolumeFileError', code: 'auth' });
    await client.close();
  });

  it('should fail closed on a different certificate before sending the credential', async () => {
    const { server, options } = await setup(otherCert, cert);
    const client = new FileBrowserClient(options);
    const failure = client.connect();
    await expect(failure).rejects.toBeInstanceOf(PinMismatchError);
    await expect(failure).rejects.toMatchObject({ code: 'pin-mismatch' });
    await client.close();
    expect(server.requests.filter((r) => r.url === '/api/login')).toHaveLength(0);
  });

  it('should report unreachable when nothing is listening', async () => {
    const { server, options } = await setup(cert, cert);
    await server.close();
    const client = new FileBrowserClient(options);
    const failure = await client.connect().catch((err: unknown) => err);
    expect(failure).toMatchObject({ name: 'VolumeFileError', code: 'unreachable' });
    const message = (failure as Error).message;
    expect(message).not.toContain('127.0.0.1');
    expect(message).not.toContain(String(options.port));
    expect((failure as Error).cause).toBeInstanceOf(Error);
    await client.close();
  });
});

describe('FileBrowserClient write operations', () => {
  const NAME = '/a #1 ?%é.txt';

  /** Starts a fake helper with `seed` and returns it with a connected client. */
  async function connected(seed: Record<string, number> = {}): Promise<{ server: FakeFileBrowser; client: FileBrowserClient }> {
    const { server, options } = await setup(cert, cert, { seed });
    const client = new FileBrowserClient(options);
    await client.connect();
    return { server, client };
  }

  it('should write a stream and report its bytes', async () => {
    const { server, client } = await connected();
    let counted = 0;
    await client.writeStream('/n.txt', Readable.from([Buffer.from('hello')]), { size: 5, overwrite: true, onBytes: (n) => (counted += n) });
    await client.close();
    expect(server.files.get('/n.txt')).toBe(5);
    expect(counted).toBe(5);
  });

  it('should refuse to overwrite when overwrite is false', async () => {
    const { server, client } = await connected({ '/n.txt': 2 });
    const failure = client.writeStream('/n.txt', Readable.from([Buffer.from('hello')]), { size: 5, overwrite: false });
    await expect(failure).rejects.toBeInstanceOf(VolumeFileError);
    await expect(failure).rejects.toMatchObject({ code: 'conflict' });
    await client.close();
    expect(server.files.get('/n.txt')).toBe(2);
  });

  it('should create a directory and treat an existing one as success only when existOk', async () => {
    const { server, client } = await connected();
    await client.mkdir('/d');
    await expect(client.mkdir('/d')).rejects.toMatchObject({ code: 'conflict' });
    await expect(client.mkdir('/d', { existOk: true })).resolves.toBeUndefined();
    await client.close();
    expect(server.dirs.has('/d')).toBe(true);
  });

  it('should rename a file whose name needs encoding', async () => {
    const { server, client } = await connected({ [NAME]: 3 });
    await client.move(NAME, '/b #2.txt');
    await client.close();
    expect(server.files.has('/b #2.txt')).toBe(true);
    expect(server.files.has(NAME)).toBe(false);
  });

  it('should round-trip a destination that needs encoding', async () => {
    const { server, client } = await connected({ '/src.txt': 3 });
    await client.move('/src.txt', NAME);
    await client.close();
    expect([...server.files.keys()]).toEqual([NAME]);
  });

  it('should round-trip names containing plus and percent escapes through the double-decoded destination', async () => {
    const { server, client } = await connected({ '/src.txt': 3 });
    await client.move('/src.txt', '/a+b %41.txt');
    await client.close();
    expect([...server.files.keys()]).toEqual(['/a+b %41.txt']);
  });

  it('should refuse a rename onto an existing name', async () => {
    const { server, client } = await connected({ '/a.txt': 1, '/b.txt': 2 });
    await expect(client.move('/a.txt', '/b.txt')).rejects.toMatchObject({ code: 'conflict' });
    await client.close();
    expect([...server.files.keys()].sort()).toEqual(['/a.txt', '/b.txt']);
  });

  it('should report not-found when renaming a missing source', async () => {
    const { client } = await connected();
    await expect(client.move('/missing.txt', '/b.txt')).rejects.toMatchObject({ code: 'not-found' });
    await client.close();
  });

  it('should delete a directory recursively', async () => {
    const { server, client } = await connected({ '/d/x': 1, '/d/y/z': 2, '/keep.txt': 3 });
    await client.remove('/d');
    await client.close();
    expect([...server.files.keys()]).toEqual(['/keep.txt']);
    expect([...server.dirs].some((d) => d === '/d' || d.startsWith('/d/'))).toBe(false);
  });

  it('should delete a single file and report not-found for a missing path', async () => {
    const { server, client } = await connected({ [NAME]: 3 });
    await client.remove(NAME);
    expect(server.files.size).toBe(0);
    await expect(client.remove(NAME)).rejects.toMatchObject({ code: 'not-found' });
    await client.close();
  });
});
