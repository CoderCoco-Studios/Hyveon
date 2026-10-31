import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeDialogService } from './NativeDialogService.js';

const { showOpenDialog, showSaveDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({ dialog: { showOpenDialog, showSaveDialog } }));

describe('NativeDialogService', () => {
  const originalElectron = process.versions.electron;

  /** Marks the process as running inside (`'1.0.0'`) or outside (`undefined`) Electron. */
  function setElectron(version: string | undefined): void {
    Object.defineProperty(process.versions, 'electron', { value: version, configurable: true });
  }

  beforeEach(() => {
    showOpenDialog.mockReset();
    showSaveDialog.mockReset();
  });

  afterEach(() => {
    setElectron(originalElectron);
  });

  describe('outside Electron', () => {
    beforeEach(() => setElectron(undefined));

    it('should return null from pickDirectory', async () => {
      expect(await new NativeDialogService().pickDirectory()).toBeNull();
      expect(showOpenDialog).not.toHaveBeenCalled();
    });

    it('should return an empty list from pickFiles', async () => {
      expect(await new NativeDialogService().pickFiles()).toEqual([]);
      expect(showOpenDialog).not.toHaveBeenCalled();
    });

    it('should return null from pickSavePath', async () => {
      expect(await new NativeDialogService().pickSavePath('a.zip')).toBeNull();
      expect(showSaveDialog).not.toHaveBeenCalled();
    });
  });

  describe('inside Electron', () => {
    beforeEach(() => setElectron('1.0.0'));

    it('should open the directory picker and return the chosen path', async () => {
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/data/world'] });
      expect(await new NativeDialogService().pickDirectory()).toBe('/data/world');
      expect(showOpenDialog).toHaveBeenCalledWith({ properties: ['openDirectory'] });
    });

    it('should return null from pickDirectory when cancelled', async () => {
      showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      expect(await new NativeDialogService().pickDirectory()).toBeNull();
    });

    it('should return null from pickDirectory when no path comes back', async () => {
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
      expect(await new NativeDialogService().pickDirectory()).toBeNull();
    });

    it('should open a multi-select file picker and return every chosen path', async () => {
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a.txt', '/b.txt'] });
      expect(await new NativeDialogService().pickFiles()).toEqual(['/a.txt', '/b.txt']);
      expect(showOpenDialog).toHaveBeenCalledWith({ properties: ['openFile', 'multiSelections'] });
    });

    it('should return an empty list from pickFiles when cancelled', async () => {
      showOpenDialog.mockResolvedValue({ canceled: true, filePaths: ['/ignored.txt'] });
      expect(await new NativeDialogService().pickFiles()).toEqual([]);
    });

    it('should pass the default name to showSaveDialog', async () => {
      showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/a.zip' });
      expect(await new NativeDialogService().pickSavePath('a.zip')).toBe('/out/a.zip');
      expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'a.zip' });
    });

    it('should pass the title and filters to showSaveDialog when given', async () => {
      showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/b.zip' });
      const filters = [{ name: 'Zip archive', extensions: ['zip'] }];
      await new NativeDialogService().pickSavePath('b.zip', { title: 'Export', filters });
      expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'b.zip', title: 'Export', filters });
    });

    it('should return null from pickSavePath when cancelled', async () => {
      showSaveDialog.mockResolvedValue({ canceled: true });
      expect(await new NativeDialogService().pickSavePath('a.zip')).toBeNull();
    });

    it('should return null from pickSavePath when no file path comes back', async () => {
      showSaveDialog.mockResolvedValue({ canceled: false });
      expect(await new NativeDialogService().pickSavePath('a.zip')).toBeNull();
    });
  });
});
