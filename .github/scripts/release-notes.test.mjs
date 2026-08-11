import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildFallbackBody, generateReleaseBody } from './release-notes.mjs';

test('buildPrompt embeds the context JSON as a fact-grounding instruction', () => {
  const prompt = buildPrompt({ commits: [{ message: 'feat: add thing' }] });
  assert.match(prompt, /grounded only in these facts/);
  assert.match(prompt, /add thing/);
});

test('buildFallbackBody renders the raw changelog under a fallback notice', () => {
  const body = buildFallbackBody('### Features\n\n- Add thing (abc123)\n');
  assert.match(body, /AI summary unavailable/);
  assert.match(body, /Add thing \(abc123\)/);
});

test('buildFallbackBody handles an empty changelog', () => {
  const body = buildFallbackBody('   \n');
  assert.match(body, /No changelog entries/);
});

test('generateReleaseBody skips the API call and falls back when no API key is set', async () => {
  const result = await generateReleaseBody({
    apiKey: '',
    contextJson: {},
    rawChangelog: '### Fixes\n\n- Fix thing (abc)\n',
  });
  assert.equal(result.usedAi, false);
  assert.match(result.body, /AI summary unavailable/);
});

test('generateReleaseBody returns the AI-generated text on success', async () => {
  const stubClient = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: '## What changed\n\n- Fixed a thing.' }],
      }),
    },
  };
  const result = await generateReleaseBody({
    apiKey: 'test-key',
    contextJson: {},
    rawChangelog: 'unused',
    client: stubClient,
  });
  assert.equal(result.usedAi, true);
  assert.equal(result.body, '## What changed\n\n- Fixed a thing.');
});

test('generateReleaseBody falls back when the API call throws', async () => {
  const stubClient = {
    messages: {
      create: async () => {
        throw new Error('boom');
      },
    },
  };
  const result = await generateReleaseBody({
    apiKey: 'test-key',
    contextJson: {},
    rawChangelog: '### Fixes\n\n- Fix thing (abc)\n',
    client: stubClient,
  });
  assert.equal(result.usedAi, false);
  assert.match(result.body, /AI summary unavailable/);
  assert.match(result.body, /Fix thing \(abc\)/);
});

test('generateReleaseBody falls back when the API returns an empty response', async () => {
  const stubClient = {
    messages: {
      create: async () => ({ content: [] }),
    },
  };
  const result = await generateReleaseBody({
    apiKey: 'test-key',
    contextJson: {},
    rawChangelog: 'fallback text',
    client: stubClient,
  });
  assert.equal(result.usedAi, false);
  assert.match(result.body, /fallback text/);
});
