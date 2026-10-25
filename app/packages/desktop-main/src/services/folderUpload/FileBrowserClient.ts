import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { Agent, request } from 'undici';
import { errMessage } from '@hyveon/shared';

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
  login(signal?: AbortSignal): Promise<void>;
  mkdir(remoteDir: string, signal?: AbortSignal): Promise<void>;
  uploadFile(args: UploadFileArgs): Promise<void>;
  /** Lists `remoteDir`, or returns `null` when it does not exist. */
  list(remoteDir: string, signal?: AbortSignal): Promise<RemoteEntry[] | null>;
  close(): Promise<void>;
}

/** The server presented a certificate other than the one generated for this launch; nothing was sent. */
export class PinMismatchError extends Error {
  constructor(message = 'The helper presented an unexpected TLS certificate; aborting without sending credentials.') {
    super(message);
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
 * `X-Auth`), `POST /api/resources/<path>` (creates missing parent directories), `GET /api/resources/<dir>` (404 when absent).
 */
export class FileBrowserClient implements FileBrowserApi {
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

  /** Authenticates and stores the JWT for subsequent calls. Throws {@link PinMismatchError} on an untrusted certificate. */
  async login(signal?: AbortSignal): Promise<void> {
    const res = await this.send('POST', '/api/login', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.options.username, password: this.options.password, recaptcha: '' }),
      signal,
    });
    const text = await res.body.text();
    if (res.statusCode !== 200) throw new FileBrowserHttpError(res.statusCode, `Login failed (${res.statusCode})`);
    this.token = text.trim();
  }

  /** Creates a directory; an already-existing one is not an error. */
  async mkdir(remoteDir: string, signal?: AbortSignal): Promise<void> {
    const res = await this.send('POST', `/api/resources${encodePath(remoteDir)}/`, { headers: this.authHeaders(), signal });
    await res.body.dump();
    if (res.statusCode === 409) return;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new FileBrowserHttpError(res.statusCode, `mkdir ${remoteDir} failed (${res.statusCode})`);
    }
  }

  /** Streams a local file to `remotePath` (overwriting any partial copy) through a byte-counting transform. */
  async uploadFile({ remotePath, localPath, size, signal, onBytes }: UploadFileArgs): Promise<void> {
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        onBytes(chunk.length);
        cb(null, chunk);
      },
    });
    const source = createReadStream(localPath);
    const body = source.pipe(counter);
    source.on('error', (err) => counter.destroy(err));
    try {
      const res = await this.send('POST', `/api/resources${encodePath(remotePath)}?override=true`, {
        headers: { ...this.authHeaders(), 'content-length': String(size), 'content-type': 'application/octet-stream' },
        body,
        signal,
      });
      await res.body.dump();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new FileBrowserHttpError(res.statusCode, `upload ${remotePath} failed (${res.statusCode})`);
      }
    } finally {
      source.destroy();
      counter.destroy();
    }
  }

  /** Lists a directory's immediate children; `null` when the directory does not exist. */
  async list(remoteDir: string, signal?: AbortSignal): Promise<RemoteEntry[] | null> {
    const res = await this.send('GET', `/api/resources${encodePath(remoteDir).replace(/\/$/, '')}/`, {
      headers: this.authHeaders(),
      signal,
    });
    if (res.statusCode === 404) {
      await res.body.dump();
      return null;
    }
    if (res.statusCode !== 200) {
      await res.body.dump();
      throw new FileBrowserHttpError(res.statusCode, `list ${remoteDir} failed (${res.statusCode})`);
    }
    const json = (await res.body.json()) as { items?: { name: string; isDir: boolean; size: number }[] };
    return (json.items ?? []).map((i) => ({ name: i.name, isDir: i.isDir, size: i.size }));
  }

  /** Closes pooled connections. */
  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) throw new Error('Not logged in to the file manager helper');
    return { 'x-auth': this.token };
  }

  /** Issues one request, mapping TLS trust failures to {@link PinMismatchError} and normalizing other errors. */
  private async send(method: 'GET' | 'POST', path: string, init: Parameters<typeof request>[1]) {
    try {
      return await request(`${this.origin}${path}`, { ...init, method, dispatcher: this.dispatcher });
    } catch (err) {
      if (err instanceof PinMismatchError || isTrustFailure(err)) throw new PinMismatchError();
      throw err instanceof Error && !(err.name === 'AbortError') ? new Error(errMessage(err), { cause: err }) : err;
    }
  }
}

