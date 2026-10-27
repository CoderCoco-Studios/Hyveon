import { createReadStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { Agent, request } from 'undici';
import {
  VolumeFileError,
  type VolumeEntry,
  type VolumeFileBackend,
  type VolumeStat,
  type WriteOptions,
} from '../volumeFiles/VolumeFileBackend.js';

/** Where and how to reach one FileBrowser helper. */
export interface FileBrowserClientOptions {
  host: string;
  port: number;
  username: string;
  /** Held in process memory only; sent solely over the pinned TLS channel. */
  password: string;
  /** The per-launch certificate, used as the only trust anchor. */
  certPem: string;
  /** Expected SHA-256 fingerprint of the server certificate. */
  fingerprint256: string;
}

/** One entry of a remote directory listing. */
export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** Arguments to {@link FileBrowserApi.uploadFile}. */
export interface UploadFileArgs {
  /** Absolute path on the helper, such as `/Data/worlds/a.db`. */
  remotePath: string;
  localPath: string;
  /** Byte length announced as `Content-Length`; the stream must produce exactly this many bytes. */
  size: number;
  signal?: AbortSignal;
  /** Called with the byte count of each chunk as it is handed to the socket. */
  onBytes: (n: number) => void;
}

/** The FileBrowser REST surface the uploader depends on; fake this in tests. */
export interface FileBrowserApi {
  /** Alias of {@link VolumeFileBackend.connect}; removed once the upload engine moves onto that interface. */
  login(signal?: AbortSignal): Promise<void>;
  mkdir(remoteDir: string, options?: { existOk?: boolean; signal?: AbortSignal }): Promise<void>;
  uploadFile(args: UploadFileArgs): Promise<void>;
  /**
   * Lists `remoteDir`. An absent directory is reported as a {@link VolumeFileError} with code `not-found`; a fake may
   * return `null` instead.
   */
  list(remoteDir: string, signal?: AbortSignal): Promise<RemoteEntry[] | null>;
  close(): Promise<void>;
}

/** The server presented a certificate other than the one generated for this launch; nothing was sent. */
export class PinMismatchError extends VolumeFileError {
  constructor(message = 'The helper presented an unexpected TLS certificate; aborting without sending credentials.') {
    super('pin-mismatch', message);
    this.name = 'PinMismatchError';
  }
}

/** A non-2xx response from the helper. */
export class FileBrowserHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FileBrowserHttpError';
  }
}

/** Builds {@link FileBrowserApi} instances; a separate injectable so the upload service can be tested without sockets. */
@Injectable()
export class FileBrowserClientFactory {
  /** Creates a client bound to one helper and pinned to its certificate. */
  create(options: FileBrowserClientOptions): FileBrowserApi {
    return new FileBrowserClient(options);
  }
}

/** TLS error codes that mean "the peer is not the certificate we trust". */
const TLS_TRUST_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_PIN_MISMATCH',
]);

/** Maps a non-2xx response to the modeled {@link VolumeFileError} vocabulary. */
function toVolumeError(status: number, op: string, path: string): VolumeFileError {
  const message = `${op} ${path} failed (${status})`;
  if (status === 401 || status === 403) return new VolumeFileError('auth', message, status);
  if (status === 404) return new VolumeFileError('not-found', message, status);
  if (status === 409) return new VolumeFileError('conflict', message, status);
  return new VolumeFileError('failed', message, status);
}

/** Parses FileBrowser's RFC 3339 `modified` field; `0` when absent or malformed. */
function parseModifiedMs(modified: string | undefined): number {
  const ms = Date.parse(modified ?? '');
  return Number.isNaN(ms) ? 0 : ms;
}

/** The per-item JSON FileBrowser returns for `GET /api/resources`. */
interface ResourceJson {
  name: string;
  isDir: boolean;
  size: number;
  modified?: string;
  items?: ResourceJson[];
}

/** Maps one FileBrowser item to a {@link VolumeEntry}. */
function toVolumeEntry(item: ResourceJson): VolumeEntry {
  return { name: item.name, isDir: item.isDir, size: item.size, modifiedMs: parseModifiedMs(item.modified) };
}

/** Encodes each segment of an absolute POSIX path for use after `/api/resources`. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Walks the `cause` chain of an undici/Node network error for a TLS trust failure. */
function isTrustFailure(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur instanceof Error && depth < 5; depth += 1) {
    const code = (cur as NodeJS.ErrnoException).code;
    if (code && TLS_TRUST_CODES.has(code)) return true;
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return false;
}

/**
 * FileBrowser REST client for one helper. All traffic goes through an undici dispatcher whose only trust anchor is the
 * per-launch certificate and whose server-identity check compares the certificate fingerprint, so a different
 * certificate fails the handshake before any request bytes (credential or file) are written.
 *
 * Endpoints (verified against `filebrowser/filebrowser:latest` v2.63): `POST /api/login` (plain-text JWT, sent back as
 * `X-Auth`), `POST /api/resources/<path>` (creates missing parent directories), `GET /api/resources/<dir>` (404 when absent),
 * `GET /api/raw/<path>` (file bytes) and `GET /api/raw/<dir>/?algo=zip` (zip archive).
 */
export class FileBrowserClient implements FileBrowserApi, VolumeFileBackend {
  readonly supportsArchive = true;

  private readonly dispatcher: Agent;
  private readonly origin: string;
  private token: string | null = null;

  constructor(private readonly options: FileBrowserClientOptions) {
    this.origin = `https://${options.host}:${options.port}`;
    this.dispatcher = new Agent({
      connect: {
        ca: options.certPem,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, cert) =>
          cert.fingerprint256 === options.fingerprint256 ? undefined : Object.assign(new PinMismatchError(), { code: 'ERR_PIN_MISMATCH' }),
      },
    });
  }

  /**
   * Authenticates and stores the JWT for subsequent calls.
   *
   * @param signal - Aborts the request.
   * @throws {@link PinMismatchError} on an untrusted certificate, and {@link VolumeFileError} with `auth` on rejected credentials.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    const res = await this.send('POST', '/api/login', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.options.username, password: this.options.password, recaptcha: '' }),
      signal,
    });
    const text = await res.body.text();
    if (res.statusCode !== 200) {
      const code = res.statusCode === 401 || res.statusCode === 403 ? 'auth' : 'failed';
      throw new VolumeFileError(code, `Login failed (${res.statusCode})`, res.statusCode);
    }
    this.token = text.trim();
  }

  /** Alias of {@link FileBrowserClient.connect}; removed once the upload engine moves onto {@link VolumeFileBackend}. */
  login(signal?: AbortSignal): Promise<void> {
    return this.connect(signal);
  }

  /** {@inheritDoc VolumeFileBackend.mkdir} */
  async mkdir(path: string, { existOk = false, signal }: { existOk?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const res = await this.send('POST', `/api/resources${encodePath(path)}/`, { headers: this.authHeaders(), signal });
    if (res.statusCode === 409 && existOk) {
      await res.body.dump();
      return;
    }
    await this.expectOk(res, 'mkdir', path);
    await res.body.dump();
  }

  /**
   * Streams a local file to `remotePath` (overwriting any partial copy).
   *
   * @remarks
   * A thin wrapper over {@link FileBrowserClient.writeStream}, removed once the upload engine moves onto it. A failed
   * response is rethrown as {@link FileBrowserHttpError} so the engine's retry classification keeps working.
   */
  async uploadFile({ remotePath, localPath, size, signal, onBytes }: UploadFileArgs): Promise<void> {
    try {
      await this.writeStream(remotePath, createReadStream(localPath), { size, overwrite: true, signal, onBytes });
    } catch (err) {
      if (err instanceof VolumeFileError && err.status !== undefined) throw new FileBrowserHttpError(err.status, err.message);
      throw err;
    }
  }

  /** {@inheritDoc VolumeFileBackend.writeStream} */
  async writeStream(path: string, source: Readable, { size, overwrite, signal, onBytes }: WriteOptions): Promise<void> {
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        onBytes?.(chunk.length);
        cb(null, chunk);
      },
    });
    const body = source.pipe(counter);
    source.on('error', (err) => counter.destroy(err));
    try {
      const res = await this.send('POST', `/api/resources${encodePath(path)}?override=${overwrite}`, {
        headers: { ...this.authHeaders(), 'content-length': String(size), 'content-type': 'application/octet-stream' },
        body,
        signal,
      });
      await this.expectOk(res, 'write', path);
      await res.body.dump();
    } finally {
      source.destroy();
      counter.destroy();
    }
  }

  /** {@inheritDoc VolumeFileBackend.move} */
  async move(from: string, to: string, signal?: AbortSignal): Promise<void> {
    const query = `action=rename&destination=${encodeURIComponent(to)}&override=false&rename=false`;
    const res = await this.send('PATCH', `/api/resources${encodePath(from)}?${query}`, { headers: this.authHeaders(), signal });
    await this.expectOk(res, 'move', from);
    await res.body.dump();
  }

  /** {@inheritDoc VolumeFileBackend.remove} */
  async remove(path: string, signal?: AbortSignal): Promise<void> {
    const res = await this.send('DELETE', `/api/resources${encodePath(path)}`, { headers: this.authHeaders(), signal });
    await this.expectOk(res, 'remove', path);
    await res.body.dump();
  }

  /** {@inheritDoc VolumeFileBackend.list} */
  async list(dir: string, signal?: AbortSignal): Promise<VolumeEntry[]> {
    const res = await this.send('GET', `/api/resources${encodePath(dir).replace(/\/$/, '')}/`, { headers: this.authHeaders(), signal });
    await this.expectOk(res, 'list', dir);
    const json = (await res.body.json()) as ResourceJson;
    return (json.items ?? []).map(toVolumeEntry);
  }

  /** {@inheritDoc VolumeFileBackend.stat} */
  async stat(path: string, signal?: AbortSignal): Promise<VolumeStat> {
    const res = await this.send('GET', `/api/resources${encodePath(path)}`, { headers: this.authHeaders(), signal });
    await this.expectOk(res, 'stat', path);
    return { ...toVolumeEntry((await res.body.json()) as ResourceJson), path };
  }

  /** {@inheritDoc VolumeFileBackend.readStream} */
  async readStream(path: string, signal?: AbortSignal): Promise<Readable> {
    const res = await this.send('GET', `/api/raw${encodePath(path)}`, { headers: this.authHeaders(), signal });
    await this.expectOk(res, 'read', path);
    return res.body;
  }

  /** {@inheritDoc VolumeFileBackend.archiveStream} */
  async archiveStream(dir: string, signal?: AbortSignal): Promise<Readable> {
    const res = await this.send('GET', `/api/raw${encodePath(dir).replace(/\/$/, '')}/?algo=zip`, { headers: this.authHeaders(), signal });
    await this.expectOk(res, 'archive', dir);
    return res.body;
  }

  /** Closes pooled connections. */
  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) throw new Error('Not logged in to the file manager helper');
    return { 'x-auth': this.token };
  }

  /** Drains the body and throws the mapped {@link VolumeFileError} unless the response is 2xx. */
  private async expectOk(res: Awaited<ReturnType<FileBrowserClient['send']>>, op: string, path: string): Promise<void> {
    if (res.statusCode >= 200 && res.statusCode < 300) return;
    await res.body.dump();
    throw toVolumeError(res.statusCode, op, path);
  }

  /** Issues one request, mapping TLS trust failures to {@link PinMismatchError} and other network errors to `unreachable`
   * with a fixed message, since the raw error text carries the helper's address (kept only in `cause`). */
  private async send(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, init: Parameters<typeof request>[1]) {
    try {
      return await request(`${this.origin}${path}`, { ...init, method, dispatcher: this.dispatcher });
    } catch (err) {
      if (err instanceof PinMismatchError || isTrustFailure(err)) throw new PinMismatchError();
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new VolumeFileError('unreachable', 'The file manager helper is unreachable', undefined, { cause: err });
    }
  }
}

