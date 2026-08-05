import { describe, it, expect } from 'vitest';
import { defaultBootstrapResourceNames } from './wizard.utils.js';

describe('defaultBootstrapResourceNames', () => {
  it('should derive resource names from the default project name when none is given', () => {
    expect(defaultBootstrapResourceNames()).toEqual({
      stateBucket: 'hyveon-tfstate',
      configurationBucket: 'hyveon-config',
    });
  });

  it('should derive resource names from a custom project name', () => {
    expect(defaultBootstrapResourceNames('my-project')).toEqual({
      stateBucket: 'my-project-tfstate',
      configurationBucket: 'my-project-config',
    });
  });
});
