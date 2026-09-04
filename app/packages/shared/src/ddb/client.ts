import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let cached: DynamoDBDocumentClient | null = null;

/**
 * Lazy-instantiated DynamoDB DocumentClient. Reads `AWS_REGION_` (trailing underscore — Lambda
 * reserves `AWS_REGION` itself), then `AWS_REGION`, then `AWS_DEFAULT_REGION`, falling back to
 * `us-east-1` if none are set.
 *
 * Cached for the lifetime of the Lambda/Node process — no teardown needed.
 */
export function getDocClient(): DynamoDBDocumentClient {
  if (!cached) {
    const region =
      process.env['AWS_REGION_'] ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
    cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  }
  return cached;
}

/** Reset the cached client. Only used in tests. */
export function __resetDocClient(): void {
  cached = null;
}
