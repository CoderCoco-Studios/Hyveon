// @spec APP-UPDATE-PKG-004
/** GitHub repository that hosts Hyveon releases; the updater feeds and the manual-download link derive from it. */
export const RELEASE_REPO = { owner: 'CoderCoco-Studios', repo: 'Hyveon' } as const;

/** `owner/repo` slug of {@link RELEASE_REPO}. */
export const RELEASE_REPO_SLUG = `${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`;

/** Releases page of {@link RELEASE_REPO}, offered as the manual-download escape hatch. */
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_REPO_SLUG}/releases`;
