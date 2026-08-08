import { describe, it, expect } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { RpcErrorMessageFilter } from './rpc-error-message.filter.js';

describe('RpcErrorMessageFilter', () => {
  const filter = new RpcErrorMessageFilter();
  // catch() never reads `host`, so an empty object stands in for the real
  // ArgumentsHost NestJS would pass.
  const host = {} as Parameters<RpcErrorMessageFilter['catch']>[1];

  it('should preserve the message of a plain Error', async () => {
    const result = filter.catch(new Error('discordBotTokenSecretArn not in the deployed stack outputs.'), host);

    await expect(firstValueFrom(result)).rejects.toThrow(
      'discordBotTokenSecretArn not in the deployed stack outputs.',
    );
  });

  it('should preserve the message of an Error subclass with non-cloneable custom fields', async () => {
    const awsLikeError = Object.assign(new Error('The security token included in the request is invalid.'), {
      $metadata: { httpStatusCode: 403 },
    });

    const result = filter.catch(awsLikeError, host);

    await expect(firstValueFrom(result)).rejects.toThrow(
      'The security token included in the request is invalid.',
    );
  });

  it('should stringify a non-Error rejection instead of losing it to a generic message', async () => {
    const result = filter.catch('a bare string rejection', host);

    await expect(firstValueFrom(result)).rejects.toThrow('a bare string rejection');
  });
});
