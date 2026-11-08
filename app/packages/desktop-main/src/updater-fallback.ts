import { errMessage, RELEASE_REPO, RELEASE_REPO_SLUG } from '@hyveon/shared';
import { logger } from './logger.js';

/** The primary `github` provider feed, restored after a fallback retry so the singleton isn't left on the fallback. */
export const PRIMARY_FEED = { provider: 'github', ...RELEASE_REPO } as const;

/** Releases per request; GitHub's maximum, so most repos resolve in one call. */
const RELEASES_PAGE_SIZE = 100;

const RELEASES_API_URL = `https://api.github.com/repos/${RELEASE_REPO_SLUG}/releases`;
const RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${RELEASE_REPO_SLUG}/releases/download`;
const FETCH_TIMEOUT_MS = 10_000;

/** Per-platform electron-builder update feed file a release must carry to be updatable. */
const FEED_ASSET_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'latest.yml',
  darwin: 'latest-mac.yml',
  linux: 'latest-linux.yml',
};

/** The subset of a GitHub release (REST `GET /releases`) that fallback selection reads. */
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  assets: ReadonlyArray<{ name: string }>;
}

/** Epoch ms of a release's `published_at`; missing or unparseable values sort as oldest. */
function publishedAtMs(r: GithubRelease): number {
  const ms = r.published_at ? Date.parse(r.published_at) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
}

// @spec APP-UPDATE-FALL-001, APP-UPDATE-FALL-002
/**
 * Picks the newest release an updater can actually use on `platform`.
 *
 * @remarks
 * Skips drafts, prereleases, and releases missing the platform's feed asset (e.g. a release published with no
 * assets, which makes electron-updater's primary check 404). Among the rest, the greatest `published_at` wins
 * regardless of array order; a missing or invalid `published_at` counts as oldest, and ties keep the earlier entry.
 *
 * @param releases - Releases as returned by the GitHub releases API, in any order.
 * @param platform - Node platform to match the feed asset for.
 * @returns The newest usable release, or `null` when none qualifies or the platform has no feed file.
 */
export function pickFallbackRelease(releases: readonly GithubRelease[], platform: NodeJS.Platform): GithubRelease | null {
  const feedAsset = FEED_ASSET_BY_PLATFORM[platform];
  if (!feedAsset) return null;
  let best: GithubRelease | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !(r.assets ?? []).some((a) => a.name === feedAsset)) continue;
    if (!best || publishedAtMs(r) > publishedAtMs(best)) best = r;
  }
  return best;
}

// @spec APP-UPDATE-FALL-001, APP-UPDATE-FALL-003, APP-UPDATE-FALL-007
/**
 * Resolves a generic-provider feed URL pointing at the newest release that carries a feed file for `platform`.
 *
 * @remarks
 * Pages through the whole releases list (stopping at the first short page) so an eligible older release is found
 * even when the newest pages hold only feedless releases. Any failed page aborts the lookup.
 *
 * @param platform - Node platform to resolve for.
 * @returns The release download base URL, or `null` when the lookup fails or no release qualifies.
 */
export async function resolveFallbackFeedUrl(platform: NodeJS.Platform): Promise<string | null> {
  try {
    const releases: GithubRelease[] = [];
    for (let page = 1; ; page++) {
      const res = await fetch(`${RELEASES_API_URL}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn('[updater] fallback release lookup failed', { status: res.status, page });
        return null;
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return null;
      releases.push(...(body as GithubRelease[]));
      if (body.length < RELEASES_PAGE_SIZE) break;
    }
    const release = pickFallbackRelease(releases, platform);
    return release ? `${RELEASE_DOWNLOAD_BASE_URL}/${release.tag_name}` : null;
  } catch (err) {
    logger.warn('[updater] fallback release lookup failed', { error: errMessage(err) });
    return null;
  }
}
