import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildIpv4WrapperScript, shellSingleQuote } from './envTokenWrapper.js';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('shellSingleQuote', () => {
  it('should wrap a plain value in single quotes', () => {
    expect(shellSingleQuote('abc')).toBe("'abc'");
  });

  it('should escape embedded single quotes', () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe('buildIpv4WrapperScript', () => {
  const tokenVar = { name: 'SERVER_IP', value: 'host=${hyveon.network.public-ipv4}:8211' };

  it('should export only token-bearing variables with the IP spliced in', () => {
    const script = buildIpv4WrapperScript({
      environment: [tokenVar, { name: 'EULA', value: 'TRUE' }],
      command: ['/start.sh'],
    });
    expect(script).toContain(`export SERVER_IP='host='"$HYVEON_PUBLIC_IPV4"':8211'`);
    expect(script).not.toContain('EULA');
  });

  it('should exec the command with each argument single-quoted', () => {
    const script = buildIpv4WrapperScript({ environment: [tokenVar], command: ['/start.sh', '--port', '8211'] });
    expect(script).toContain(`exec '/start.sh' '--port' '8211'`);
  });

  it('should quote adversarial values as inert data', () => {
    const script = buildIpv4WrapperScript({
      environment: [{ name: 'SERVER_IP', value: "'; rm -rf / #${hyveon.network.public-ipv4}" }],
      command: ['/start.sh'],
    });
    expect(script).toContain(`export SERVER_IP=''\\''; rm -rf / #'"$HYVEON_PUBLIC_IPV4"''`);
  });

  it('should throw when command is empty', () => {
    expect(() => buildIpv4WrapperScript({ environment: [tokenVar], command: [] })).toThrow(/command/);
  });

  it('should throw when no variable carries the ipv4 token', () => {
    expect(() => buildIpv4WrapperScript({ environment: [{ name: 'EULA', value: 'TRUE' }], command: ['/s'] })).toThrow(/token/);
  });

  it('should throw on a non-identifier variable name', () => {
    expect(() =>
      buildIpv4WrapperScript({ environment: [{ name: 'BAD NAME;', value: '${hyveon.network.public-ipv4}' }], command: ['/s'] }),
    ).toThrow(/identifier/);
  });
});

describe('buildIpv4WrapperScript executed under sh', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => res.end('203.0.113.7\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    url = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('should resolve the IP, export the spliced value, and exec the command', async () => {
    const script = buildIpv4WrapperScript({
      environment: [{ name: 'SERVER_IP', value: 'host=${hyveon.network.public-ipv4}:8211' }],
      command: ['/bin/sh', '-c', 'printf %s "$SERVER_IP"'],
      ipEchoUrl: url,
    });
    const { stdout } = await execFileAsync('/bin/sh', ['-c', script]);
    expect(stdout).toBe('host=203.0.113.7:8211');
  });

  it('should keep an adversarial value inert', async () => {
    const script = buildIpv4WrapperScript({
      environment: [{ name: 'SERVER_IP', value: "'; echo INJECTED #${hyveon.network.public-ipv4}" }],
      command: ['/bin/sh', '-c', 'printf %s "$SERVER_IP"'],
      ipEchoUrl: url,
    });
    const { stdout } = await execFileAsync('/bin/sh', ['-c', script]);
    expect(stdout).toBe("'; echo INJECTED #203.0.113.7");
  });
});

describe('buildIpv4WrapperScript rejects a non-IP echoed response', () => {
  let server: Server;
  let url: string;
  let requestCount: number;

  beforeAll(async () => {
    requestCount = 0;
    server = createServer((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.end('<html><body>garbage, not an IP</body></html>');
        return;
      }
      res.end('203.0.113.9\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
    url = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('should reject a garbage first response and export the valid IP from the retry', async () => {
    const script = buildIpv4WrapperScript({
      environment: [{ name: 'SERVER_IP', value: 'host=${hyveon.network.public-ipv4}:8211' }],
      command: ['/bin/sh', '-c', 'printf %s "$SERVER_IP"'],
      ipEchoUrl: url,
    });
    const { stdout } = await execFileAsync('/bin/sh', ['-c', script]);
    expect(stdout).toBe('host=203.0.113.9:8211');
    expect(requestCount).toBe(2);
  });
});
