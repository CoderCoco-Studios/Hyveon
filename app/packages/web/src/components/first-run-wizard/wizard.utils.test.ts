import { describe, it, expect } from 'vitest';
import { defaultBootstrapResourceNames, formatDeployPrincipal } from './wizard.utils.js';

describe('defaultBootstrapResourceNames', () => {
  // @spec APP-WIZARD-BOOT-013
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

describe('formatDeployPrincipal', () => {
  // @spec APP-WIZARD-CREDS-010
  it('should name the IAM user and account when both are known', () => {
    expect(formatDeployPrincipal({ accountId: '123456789012', userName: 'my-deployer' })).toBe(
      'my-deployer (account 123456789012)',
    );
  });

  // @spec APP-WIZARD-CREDS-010
  it('should name only the account when no IAM user name was resolved', () => {
    expect(formatDeployPrincipal({ accountId: '123456789012' })).toBe('AWS account 123456789012');
  });

  // @spec APP-WIZARD-CREDS-010
  it('should fall back to a generic label when nothing was resolved', () => {
    expect(formatDeployPrincipal(undefined)).toBe('AWS account (guided setup)');
  });
});
