import type { VolumeInfo } from '@hyveon/shared/volumeFiles';
import { NativeSelect } from '@/components/ui/native-select.component';
import { volumeLabel } from './volume-files.utils.js';

/** Props for {@link VolumePicker}. */
export interface VolumePickerProps {
  volumes: VolumeInfo[];
  /** Name of the selected volume. */
  selected: string | null;
  onSelect(name: string): void;
}

/** Text shown for a volume the current session layout could not mount. */
export const UNMOUNTED_VOLUME_HINT = 'Apply the infrastructure to browse this volume.';

/**
 * Select over a game's declared volumes, showing each one's name and container path.
 *
 * @remarks
 * A volume that is not mounted is listed but disabled, with {@link UNMOUNTED_VOLUME_HINT} in its label.
 *
 * @param props - See {@link VolumePickerProps}.
 */
export function VolumePicker({ volumes, selected, onSelect }: VolumePickerProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-[var(--color-muted-foreground)]">Volume</span>
      <NativeSelect
        className="w-auto min-w-48"
        value={selected ?? ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        {volumes.map((volume) => (
          <option key={volume.name} value={volume.name} disabled={!volume.mounted}>
            {volumeLabel(volume.name)}
            {volume.containerPath !== '' && volume.name !== '' ? ` (${volume.containerPath})` : ''}
            {volume.mounted ? '' : ` — ${UNMOUNTED_VOLUME_HINT}`}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}
