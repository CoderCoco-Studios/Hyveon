/**
 * CloudWatch log-group name for a game's FileBrowser helper task. Shared so the
 * infra program (which pre-creates the group) and `FileManagerService` (whose
 * container `awslogs-group` points at it) can never drift.
 *
 * @param game - Game name.
 * @returns `/ecs/filebrowser-{game}`.
 */
export function fileManagerLogGroupName(game: string): string {
  return `/ecs/filebrowser-${game}`;
}
