#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const REQUEST_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You write the "what's new" section of a GitHub release for the Hyveon project.

Rules:
- Base every statement strictly on the facts present in the supplied changelog JSON. Never invent features, fixes, or details that are not represented in a commit.
- Group related commits into short, user-facing bullet points instead of listing raw commit subjects verbatim.
- Skip internal-only changes (chores, CI, build, test, style, refactor with no user-visible effect) unless they are the only content available.
- Write in plain Markdown: a short intro sentence, then bullet points under headings such as "Features" and "Fixes" as warranted by the groups present. No preamble, no sign-off, no emoji.
- If the changelog contains no commits, say so plainly in one sentence instead of fabricating content.`;

/**
 * Builds the user-turn prompt sent to the model from git-cliff's `--context`
 * JSON output.
 *
 * @param contextJson - Parsed JSON as produced by `git-cliff --context`
 * @returns The prompt text
 */
export function buildPrompt(contextJson) {
  return `Here is the structured changelog context (git-cliff --context JSON) for this release. Write the release summary described in your instructions, grounded only in these facts:\n\n${JSON.stringify(contextJson)}`;
}

/**
 * Renders a plain-Markdown fallback release body directly from the raw
 * rendered changelog, used whenever the AI summarization step fails.
 *
 * @param rawChangelog - The rendered changelog text (git-cliff default output)
 * @returns Markdown release body text
 */
export function buildFallbackBody(rawChangelog) {
  const trimmed = rawChangelog.trim();
  const body = trimmed.length > 0 ? trimmed : '_No changelog entries for this release._';
  return `_AI summary unavailable — showing the raw changelog._\n\n${body}\n`;
}

/**
 * Calls the Claude API to produce a release summary from git-cliff context
 * JSON, falling back to the raw changelog on any error or timeout.
 *
 * @param options - Inputs for the summary attempt
 * @param options.apiKey - Anthropic API key; a missing/empty key skips the API call and falls back immediately
 * @param options.contextJson - Parsed git-cliff `--context` JSON
 * @param options.rawChangelog - Rendered changelog text used for the fallback body
 * @param options.client - Optional pre-built Anthropic client (for tests); constructed from `apiKey` otherwise
 * @returns The Markdown release body and whether the AI summary was used
 */
export async function generateReleaseBody({ apiKey, contextJson, rawChangelog, client }) {
  if (!apiKey) {
    return { body: buildFallbackBody(rawChangelog), usedAi: false };
  }

  const anthropic = client ?? new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(contextJson) }],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) {
      throw new Error('empty response from model');
    }

    return { body: text, usedAi: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`release-notes: AI summary failed, falling back to raw changelog: ${message}`);
    return { body: buildFallbackBody(rawChangelog), usedAi: false };
  }
}

async function main() {
  const contextPath = process.env.CLIFF_CONTEXT_PATH;
  const changelogPath = process.env.RAW_CHANGELOG_PATH;
  const outputPath = process.env.RELEASE_NOTES_OUTPUT_PATH;

  if (!contextPath || !changelogPath || !outputPath) {
    throw new Error(
      'release-notes: CLIFF_CONTEXT_PATH, RAW_CHANGELOG_PATH, and RELEASE_NOTES_OUTPUT_PATH must all be set',
    );
  }

  const [contextRaw, rawChangelog] = await Promise.all([
    readFile(contextPath, 'utf8'),
    readFile(changelogPath, 'utf8'),
  ]);
  const contextJson = JSON.parse(contextRaw);

  const { body, usedAi } = await generateReleaseBody({
    apiKey: process.env.ANTHROPIC_API_KEY,
    contextJson,
    rawChangelog,
  });

  await writeFile(outputPath, body, 'utf8');
  console.log(`release-notes: wrote ${usedAi ? 'AI-generated' : 'fallback'} release body to ${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
