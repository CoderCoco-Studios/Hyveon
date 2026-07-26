import { describe, it, expect } from 'vitest';
import { detectOs, arePrerequisitesSatisfied, defaultBootstrapResourceNames } from './wizard.utils.js';
import type { PrerequisitesReport } from '@hyveon/desktop-preload';

describe('detectOs', () => {
  it('should detect macOS from a macOS user-agent string', () => {
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
  });

  it('should detect Windows from a Windows user-agent string', () => {
    expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
  });

  it('should detect Linux from a Linux user-agent string', () => {
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('should return unknown for an unrecognized user-agent string', () => {
    expect(detectOs('SomeOtherPlatform/1.0')).toBe('unknown');
  });
});

const SATISFIED: PrerequisitesReport = {
  terraform: { found: true, path: '/usr/local/bin/terraform', version: '1.9.0', minimumVersionSatisfied: true },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

describe('arePrerequisitesSatisfied', () => {
  it('should return false when the report is null', () => {
    expect(arePrerequisitesSatisfied(null)).toBe(false);
  });

  it('should return true when both tools are found and terraform meets the minimum version', () => {
    expect(arePrerequisitesSatisfied(SATISFIED)).toBe(true);
  });

  it('should return false when terraform is not found', () => {
    expect(arePrerequisitesSatisfied({ ...SATISFIED, terraform: { found: false } })).toBe(false);
  });

  it('should return false when aws is not found', () => {
    expect(arePrerequisitesSatisfied({ ...SATISFIED, aws: { found: false } })).toBe(false);
  });

  it('should return false when terraform is below the minimum version', () => {
    expect(
      arePrerequisitesSatisfied({
        ...SATISFIED,
        terraform: { ...SATISFIED.terraform, minimumVersionSatisfied: false },
      }),
    ).toBe(false);
  });

  it('should return true when terraform version is unparseable (minimumVersionSatisfied undefined)', () => {
    expect(
      arePrerequisitesSatisfied({
        ...SATISFIED,
        terraform: { found: true, path: '/usr/local/bin/terraform' },
      }),
    ).toBe(true);
  });
});

describe('defaultBootstrapResourceNames', () => {
  it('should derive resource names from the default project name when none is given', () => {
    expect(defaultBootstrapResourceNames()).toEqual({
      stateBucket: 'hyveon-tfstate',
      lockTable: 'hyveon-tflock',
      tfvarsBucket: 'hyveon-tfvars',
    });
  });

  it('should derive resource names from a custom project name', () => {
    expect(defaultBootstrapResourceNames('my-project')).toEqual({
      stateBucket: 'my-project-tfstate',
      lockTable: 'my-project-tflock',
      tfvarsBucket: 'my-project-tfvars',
    });
  });
});
