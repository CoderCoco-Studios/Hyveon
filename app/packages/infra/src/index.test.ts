import { describe, expect, it } from 'vitest';

describe('@hyveon/infra workspace scaffold', () => {
  it('should load the placeholder entry point without throwing', async () => {
    await expect(import('./index.js')).resolves.toBeDefined();
  });
});
