import { describe, it, expect } from 'vitest';
import { defaultBootstrapResourceNames } from './wizard.utils.js';

describe('defaultBootstrapResourceNames', () => {
  it('should derive resource names from the default project name when none is given', () => {
    expect(defaultBootstrapResourceNames()).toEqual({
      stateBucket: 'hyveon-tfstate',
      lockTable: 'hyveon-tflock',
      configurationBucket: 'hyveon-tfvars',
    });
  });

  it('should derive resource names from a custom project name', () => {
    expect(defaultBootstrapResourceNames('my-project')).toEqual({
      stateBucket: 'my-project-tfstate',
      lockTable: 'my-project-tflock',
      configurationBucket: 'my-project-tfvars',
    });
  });
});
