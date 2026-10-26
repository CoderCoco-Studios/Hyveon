import { describe, expect, it } from 'vitest';
import { fileManagerLogGroupName } from './fileManagerLogGroup.js';

describe('fileManagerLogGroupName', () => {
  it('should return /ecs/filebrowser-{game}', () => {
    expect(fileManagerLogGroupName('foundryvtt')).toBe('/ecs/filebrowser-foundryvtt');
  });
});
