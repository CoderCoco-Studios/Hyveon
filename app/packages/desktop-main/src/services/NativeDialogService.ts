import { Injectable } from '@nestjs/common';

/** Options for {@link NativeDialogService.pickSavePath}. */
export interface SavePathOptions {
  /** Dialog window title; the OS default is used when omitted. */
  title?: string;
  /** File-type filters offered in the dialog. */
  filters?: { name: string; extensions: string[] }[];
}

/**
 * Wraps Electron's native file dialogs so every consumer shares one guarded, lazily loaded `electron` import.
 * Outside Electron (unit tests, the plain-Node integration harness) each method resolves to its "cancelled" value.
 */
@Injectable()
export class NativeDialogService {
  /**
   * Opens the native directory picker.
   *
   * @returns The chosen path, or `null` when cancelled or when not running inside Electron.
   */
  async pickDirectory(): Promise<string | null> {
    const paths = await this.open(['openDirectory']);
    return paths[0] ?? null;
  }

  /**
   * Opens the native multi-select file picker.
   *
   * @returns The chosen paths, or `[]` when cancelled or when not running inside Electron.
   */
  async pickFiles(): Promise<string[]> {
    return this.open(['openFile', 'multiSelections']);
  }

  /**
   * Opens the native save dialog.
   *
   * @param defaultName - File name (or path) pre-filled in the dialog.
   * @param options - Optional dialog title and file-type filters.
   * @returns The chosen path, or `null` when cancelled or when not running inside Electron.
   */
  async pickSavePath(defaultName: string, options: SavePathOptions = {}): Promise<string | null> {
    if (!process.versions.electron) return null;
    const { dialog } = await import('electron');
    const result = await dialog.showSaveDialog({ defaultPath: defaultName, ...options });
    return result.canceled || !result.filePath ? null : result.filePath;
  }

  /** Runs `showOpenDialog` with `properties`; `[]` when cancelled or outside Electron. */
  private async open(properties: ('openFile' | 'openDirectory' | 'multiSelections')[]): Promise<string[]> {
    if (!process.versions.electron) return [];
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({ properties });
    return result.canceled ? [] : result.filePaths;
  }
}
