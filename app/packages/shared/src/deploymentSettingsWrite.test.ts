/**
 * Tests for {@link validateDeploymentSettingsPatch} (task 9.7,
 * `migrate-iac-to-pulumi`) — the shared client+server validator behind the
 * Settings page's deployment-settings form.
 */
import { describe, it, expect } from 'vitest';
import { validateDeploymentSettingsPatch } from './deploymentSettingsWrite.js';

describe('validateDeploymentSettingsPatch', () => {
  it('should return no issues for an empty patch', () => {
    expect(validateDeploymentSettingsPatch({})).toEqual([]);
  });

  it('should return no issues for a fully valid patch', () => {
    expect(
      validateDeploymentSettingsPatch({
        projectName: 'hyveon',
        awsRegion: 'us-east-1',
        vpcCidr: '10.0.0.0/16',
        hostedZoneName: 'example.com',
        dnsTtl: 30,
        watchdogIntervalMinutes: 15,
        watchdogIdleChecks: 4,
        watchdogMinPackets: 100,
        baseAllowedGuilds: ['123456789012345678'],
        baseAdminUserIds: ['234567890123456789'],
        baseAdminRoleIds: ['345678901234567890'],
        discordApplicationId: '',
        auditTableName: '',
        runsTableName: '',
      }),
    ).toEqual([]);
  });

  describe('required non-empty strings', () => {
    it.each(['hostedZoneName', 'projectName', 'awsRegion'] as const)(
      'should reject a blank %s',
      (field) => {
        const issues = validateDeploymentSettingsPatch({ [field]: '   ' });
        expect(issues).toContainEqual({ path: field, message: 'Must not be empty.' });
      },
    );

    it('should not flag hostedZoneName when omitted from the patch (a PATCH, not a full document)', () => {
      expect(validateDeploymentSettingsPatch({ awsRegion: 'us-east-1' })).toEqual([]);
    });
  });

  describe('vpcCidr', () => {
    it('should accept a well-formed IPv4 CIDR block', () => {
      expect(validateDeploymentSettingsPatch({ vpcCidr: '172.16.0.0/12' })).toEqual([]);
    });

    it.each(['not-a-cidr', '10.0.0.0', '10.0.0.0/33', '999.0.0.0/16', ''])(
      'should reject %s as a malformed CIDR block',
      (value) => {
        const issues = validateDeploymentSettingsPatch({ vpcCidr: value });
        expect(issues).toContainEqual({
          path: 'vpcCidr',
          message: 'Must be a valid IPv4 CIDR block, e.g. "10.0.0.0/16".',
        });
      },
    );
  });

  describe('numeric fields', () => {
    it.each(['dnsTtl', 'watchdogIntervalMinutes', 'watchdogIdleChecks', 'watchdogMinPackets'] as const)(
      'should accept a positive integer for %s',
      (field) => {
        expect(validateDeploymentSettingsPatch({ [field]: 5 })).toEqual([]);
      },
    );

    it.each(['dnsTtl', 'watchdogIntervalMinutes', 'watchdogIdleChecks', 'watchdogMinPackets'] as const)(
      'should reject zero for %s',
      (field) => {
        const issues = validateDeploymentSettingsPatch({ [field]: 0 });
        expect(issues).toContainEqual({ path: field, message: 'Must be a positive whole number.' });
      },
    );

    it.each(['dnsTtl', 'watchdogIntervalMinutes', 'watchdogIdleChecks', 'watchdogMinPackets'] as const)(
      'should reject a negative value for %s',
      (field) => {
        const issues = validateDeploymentSettingsPatch({ [field]: -1 });
        expect(issues).toContainEqual({ path: field, message: 'Must be a positive whole number.' });
      },
    );

    it.each(['dnsTtl', 'watchdogIntervalMinutes', 'watchdogIdleChecks', 'watchdogMinPackets'] as const)(
      'should reject a fractional value for %s',
      (field) => {
        const issues = validateDeploymentSettingsPatch({ [field]: 1.5 });
        expect(issues).toContainEqual({ path: field, message: 'Must be a positive whole number.' });
      },
    );
  });

  describe('Discord snowflake array fields', () => {
    it.each(['baseAllowedGuilds', 'baseAdminUserIds', 'baseAdminRoleIds'] as const)(
      'should accept a well-formed snowflake list for %s',
      (field) => {
        expect(validateDeploymentSettingsPatch({ [field]: ['123456789012345678', '98765432109876543'] })).toEqual([]);
      },
    );

    it.each(['baseAllowedGuilds', 'baseAdminUserIds', 'baseAdminRoleIds'] as const)(
      'should reject a non-snowflake entry in %s, positioned by its index',
      (field) => {
        const issues = validateDeploymentSettingsPatch({ [field]: ['123456789012345678', 'not-a-snowflake'] });
        expect(issues).toContainEqual({
          path: `${field}[1]`,
          message: 'Must be a 17-20 digit Discord snowflake ID.',
        });
      },
    );

    it('should not flag an empty array (a legitimate "no guilds/admins" value)', () => {
      expect(validateDeploymentSettingsPatch({ baseAllowedGuilds: [] })).toEqual([]);
    });
  });

  describe('computed-default empty-string fields', () => {
    it.each(['auditTableName', 'runsTableName', 'discordApplicationId'] as const)(
      'should never flag an empty string for %s',
      (field) => {
        expect(validateDeploymentSettingsPatch({ [field]: '' })).toEqual([]);
      },
    );
  });

  it('should collect issues from multiple invalid fields in a single patch', () => {
    const issues = validateDeploymentSettingsPatch({
      hostedZoneName: '',
      vpcCidr: 'nope',
      dnsTtl: -5,
      baseAllowedGuilds: ['bad'],
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'hostedZoneName', message: 'Must not be empty.' },
        { path: 'vpcCidr', message: 'Must be a valid IPv4 CIDR block, e.g. "10.0.0.0/16".' },
        { path: 'dnsTtl', message: 'Must be a positive whole number.' },
        { path: 'baseAllowedGuilds[0]', message: 'Must be a 17-20 digit Discord snowflake ID.' },
      ]),
    );
    expect(issues).toHaveLength(4);
  });
});
