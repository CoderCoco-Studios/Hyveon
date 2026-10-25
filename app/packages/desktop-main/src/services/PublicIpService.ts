import { isIPv4 } from 'node:net';
import { Injectable } from '@nestjs/common';
import { errMessage } from '@hyveon/shared';
import { logger } from '../logger.js';

const CHECK_IP_URL = 'https://checkip.amazonaws.com';
const CHECK_IP_TIMEOUT_MS = 5000;

/** Detects the operator's current public IPv4 address, used to scope the helper's security-group rule. */
@Injectable()
export class PublicIpService {
  /**
   * Asks `checkip.amazonaws.com` for the caller's public IPv4.
   *
   * @returns The validated dotted-quad address.
   * @throws Error with a normalized message when the lookup fails or the response is not an IPv4 address.
   */
  async detect(): Promise<string> {
    try {
      const res = await fetch(CHECK_IP_URL, { signal: AbortSignal.timeout(CHECK_IP_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`checkip returned HTTP ${res.status}`);
      const ip = (await res.text()).trim();
      if (!isIPv4(ip)) throw new Error('checkip returned a value that is not an IPv4 address');
      return ip;
    } catch (err) {
      const message = errMessage(err);
      logger.warn('PublicIpService.detect: failed to detect public IP', { error: message });
      throw new Error(`Could not detect your public IP address: ${message}`);
    }
  }
}
