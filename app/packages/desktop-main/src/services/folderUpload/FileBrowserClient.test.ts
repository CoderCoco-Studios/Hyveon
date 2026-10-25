import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FileBrowserClient, FileBrowserHttpError, PinMismatchError, type FileBrowserClientOptions } from './FileBrowserClient.js';
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
    await client.login();
    await client.mkdir('/Data');
    await client.mkdir('/Data');
    let counted = 0;
    await client.uploadFile({ remotePath: '/Data/a b.bin', localPath: local, size: 300_000, onBytes: (n) => (counted += n) });
    const entries = await client.list('/Data');
    await client.close();

    expect(counted).toBe(300_000);
    expect(server.files.get('/Data/a b.bin')).toBe(300_000);
    expect(entries).toEqual([{ name: 'a b.bin', isDir: false, size: 300_000 }]);
  });

  it('should return null when listing a directory that does not exist', async () => {
    const { options } = await setup(cert, cert);
    const client = new FileBrowserClient(options);
    await client.login();
    expect(await client.list('/missing')).toBeNull();
    await client.close();
  });

  it('should throw FileBrowserHttpError carrying the status when login is rejected', async () => {
    const { options } = await setup(cert, cert);
    const client = new FileBrowserClient({ ...options, password: 'wrong' });
    await expect(client.login()).rejects.toMatchObject({ name: 'FileBrowserHttpError', status: 403 });
    await client.close();
  });

  it('should abort with PinMismatchError and send nothing when the server presents a different certificate', async () => {
    const { server, options } = await setup(otherCert, cert);
    const client = new FileBrowserClient(options);
    await expect(client.login()).rejects.toBeInstanceOf(PinMismatchError);
    await client.close();
    expect(server.requests).toHaveLength(0);
  });

  it('should reject a certificate whose fingerprint differs even when the CA matches', async () => {
    const { server, options } = await setup(cert, cert);
    const client = new FileBrowserClient({ ...options, fingerprint256: otherCert.fingerprint256 });
    await expect(client.login()).rejects.toBeInstanceOf(PinMismatchError);
    await client.close();
    expect(server.requests).toHaveLength(0);
  });

  it('should surface a non-2xx upload as FileBrowserHttpError', async () => {
    const { options } = await setup(cert, cert, { onUpload: () => 500 });
    tmp = await mkdtemp(join(tmpdir(), 'fbc-'));
    const local = join(tmp, 'a.bin');
    await writeFile(local, 'hello');
    const client = new FileBrowserClient(options);
    await client.login();
    await expect(client.uploadFile({ remotePath: '/a.bin', localPath: local, size: 5, onBytes: () => undefined })).rejects.toBeInstanceOf(
      FileBrowserHttpError,
    );
    await client.close();
  });

  it('should refuse to call authenticated endpoints before login', async () => {
    const { options } = await setup(cert, cert);
    const client = new FileBrowserClient(options);
    await expect(client.list('/')).rejects.toThrow(/Not logged in/);
    await client.close();
  });
});
