/**
 * State and IPC orchestration for the first-run wizard's bootstrap step,
 * extracted from `FirstRunWizard` (finding D4): resource names/statuses, the
 * run-history table and initial-configuration-seed side calls, the IAM
 * permission dry-run, and the derived "is this step done" gate. Entirely
 * self-contained — the shell only needs {@link UseBootstrapResourcesResult.complete}
 * to gate whether Next is enabled on this step; everything else is consumed
 * by `BootstrapStep` alone.
 */
import { useState } from 'react';
import type { IamCheckResult } from '@hyveon/desktop-preload';
import { defaultBootstrapResourceNames, type BootstrapResourceKey, type BootstrapResourceState } from './wizard.utils.js';

/** Status/message pair for a bootstrap side-effect that has no editable name field of its own (the run-history table, the initial configuration seed). */
export interface BootstrapSideResourceState {
  status: BootstrapResourceState;
  message?: string;
}

/** IAM permission dry-run state and trigger. */
export interface BootstrapIamCheckState {
  /** Latest IAM dry-run result, or `null` before the first check runs. */
  check: IamCheckResult | null;
  /** True while the IAM check is in flight. */
  checking: boolean;
  /** Set when the IAM check IPC call itself fails outright. */
  error: string | null;
}

/** Return value of {@link useBootstrapResources}. */
export interface UseBootstrapResourcesResult {
  /** Editable resource name, keyed by resource. */
  names: Record<BootstrapResourceKey, string>;
  /** Latest known status per resource. */
  statuses: Record<BootstrapResourceKey, BootstrapResourceState>;
  /** Present when a resource's status is `'failed'`. */
  messages: Partial<Record<BootstrapResourceKey, string>>;
  /** The run-history DynamoDB table's status (bootstrap-deadlock fix) — see `runsTableStatus`'s prior doc comment in the shell for why it's tracked separately from {@link names}. */
  runsTable: BootstrapSideResourceState;
  /** The initial `deployment-config.json` seed's status (fresh-install-bricking fix) — chained onto the configuration bucket call, see {@link runBootstrap}'s doc comment. */
  deploymentConfig: BootstrapSideResourceState;
  /** IAM permission dry-run state. */
  iam: BootstrapIamCheckState;
  /** True while any bootstrap call is in flight. */
  bootstrapping: boolean;
  /** True once both resources plus the run-history table and configuration seed have all reached `created`/`exists`. */
  complete: boolean;
  /** Invoked as the operator edits a resource's name field. */
  onNameChange: (resource: BootstrapResourceKey, name: string) => void;
  /**
   * Bulk-replaces {@link names} — used only by the Reconfigure prefill effect
   * to rehydrate previously-saved resource names, which arrive as a whole
   * object from `wizard.state.get()` rather than one field at a time.
   */
  setNames: (names: Record<BootstrapResourceKey, string>) => void;
  /** Runs the bootstrap IPC calls concurrently. See {@link runBootstrap}. */
  runBootstrap: () => Promise<void>;
  /** Runs the best-effort IAM permission dry-run. Never blocks wizard progression. */
  runIamCheck: () => Promise<void>;
}

/**
 * Owns every piece of state the first-run wizard's bootstrap step needs:
 * editable resource names, per-resource creation status, the run-history
 * table and initial-configuration-seed side calls, and the IAM permission
 * dry-run — plus the IPC orchestration that drives all of it.
 */
export function useBootstrapResources(): UseBootstrapResourcesResult {
  const [names, setNames] = useState(defaultBootstrapResourceNames());
  const [statuses, setStatuses] = useState<Record<BootstrapResourceKey, BootstrapResourceState>>({
    stateBucket: 'pending',
    configurationBucket: 'pending',
  });
  const [messages, setMessages] = useState<Partial<Record<BootstrapResourceKey, string>>>({});
  // The run-history table (bootstrap-deadlock fix): tracked separately from
  // `names`/`statuses` above rather than folded into `BootstrapResourceKey`
  // — unlike the two S3 buckets, its name is not operator-editable at this
  // point in the wizard (no `DeploymentConfig` exists yet to hold a
  // `runsTableName` override; see `WizardController.bootstrapRunsTable`'s own
  // doc comment), so it has no matching entry in `names`. Runs alongside the
  // two bucket calls (not chained after them), but its outcome DOES gate
  // `complete` below — the table is required before the first Pulumi apply
  // can ever complete (see `BootstrapService.ensureRunsTable`'s doc comment),
  // so letting the operator advance past a failed table leaves the install
  // broken until they notice and come back.
  const [runsTableStatus, setRunsTableStatus] = useState<BootstrapResourceState>('pending');
  const [runsTableMessage, setRunsTableMessage] = useState<string | undefined>(undefined);
  // The initial `deployment-config.json` seed (the fresh-install-bricking
  // fix): also tracked separately from `names`/`statuses`, mirroring
  // `runsTableStatus` above — it has no editable name field of its own (it's
  // seeded into whatever `names.configurationBucket` names). Unlike the
  // run-history table, it can only run AFTER the configuration bucket itself
  // has been created/confirmed — see {@link runBootstrap}'s configuration-
  // bucket branch below, which chains this call rather than firing it in the
  // same top-level `Promise.all` entry as the run-history table.
  const [deploymentConfigStatus, setDeploymentConfigStatus] = useState<BootstrapResourceState>('pending');
  const [deploymentConfigMessage, setDeploymentConfigMessage] = useState<string | undefined>(undefined);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [iamCheck, setIamCheck] = useState<IamCheckResult | null>(null);
  const [iamChecking, setIamChecking] = useState(false);
  const [iamError, setIamError] = useState<string | null>(null);

  function onNameChange(resource: BootstrapResourceKey, name: string) {
    setNames((current) => ({ ...current, [resource]: name }));
  }

  /**
   * Runs the bootstrap IPC calls concurrently (state bucket, configuration
   * bucket, run-history table), updating each resource's status as its call
   * settles. A failure on one resource doesn't stop the others from running,
   * and each resource's outcome (`created` / `exists` / `failed`) is
   * reported independently — no call's result masks another's.
   *
   * @remarks
   * Deliberately does not call `wizard.bootstrap.lockTable` — no such
   * channel exists: the DIY Pulumi S3 backend locks via objects in the
   * state bucket, not a DynamoDB table.
   *
   * The run-history table (`wizard.bootstrap.runsTable`) runs alongside the
   * two bucket calls in the same `Promise.all`, but is tracked via
   * {@link UseBootstrapResourcesResult.runsTable} rather than
   * {@link UseBootstrapResourcesResult.statuses}.
   *
   * The initial `deployment-config.json` seed (`wizard.bootstrap.deploymentConfig`)
   * is NOT run alongside the run-history table as an independent `Promise.all`
   * entry — it must be seeded into the configuration bucket, so it only
   * fires once the configuration-bucket call itself reports `created`/`exists`,
   * chained onto the same async branch that call runs in below. A
   * configuration-bucket failure (or the bridge being unavailable) reports
   * the seed as `failed` too, with a message explaining why, rather than
   * leaving it stuck at `pending` forever.
   */
  async function runBootstrap() {
    if (!window.hyveon) {
      const bridgeUnavailable = 'IPC bridge (window.hyveon) is not available in this context.';
      setStatuses({ stateBucket: 'failed', configurationBucket: 'failed' });
      setMessages({
        stateBucket: bridgeUnavailable,
        configurationBucket: bridgeUnavailable,
      });
      setRunsTableStatus('failed');
      setRunsTableMessage(bridgeUnavailable);
      setDeploymentConfigStatus('failed');
      setDeploymentConfigMessage(bridgeUnavailable);
      return;
    }
    setBootstrapping(true);
    setStatuses((current) => ({ ...current, stateBucket: 'creating', configurationBucket: 'creating' }));
    setMessages({});
    setRunsTableStatus('creating');
    setRunsTableMessage(undefined);
    setDeploymentConfigStatus('creating');
    setDeploymentConfigMessage(undefined);

    const stateBucketCall = (async () => {
      try {
        const result = await window.hyveon!.wizard.bootstrapStateBucket({ bucketName: names.stateBucket });
        setStatuses((current) => ({ ...current, stateBucket: result.status as BootstrapResourceState }));
        if (result.message) {
          setMessages((current) => ({ ...current, stateBucket: result.message }));
        }
      } catch (err) {
        setStatuses((current) => ({ ...current, stateBucket: 'failed' }));
        setMessages((current) => ({
          ...current,
          stateBucket: err instanceof Error ? err.message : 'Failed to bootstrap stateBucket.',
        }));
      }
    })();

    const configurationBucketCall = (async () => {
      try {
        const result = await window.hyveon!.wizard.bootstrapConfigurationBucket({
          bucketName: names.configurationBucket,
        });
        setStatuses((current) => ({ ...current, configurationBucket: result.status as BootstrapResourceState }));
        if (result.message) {
          setMessages((current) => ({ ...current, configurationBucket: result.message }));
        }
        if (result.status !== 'created' && result.status !== 'exists') {
          setDeploymentConfigStatus('failed');
          setDeploymentConfigMessage('The configuration bucket must be created before its initial configuration can be seeded.');
          return;
        }
        try {
          const seedResult = await window.hyveon!.wizard.bootstrapDeploymentConfig({
            bucketName: names.configurationBucket,
          });
          setDeploymentConfigStatus(seedResult.status as BootstrapResourceState);
          setDeploymentConfigMessage(seedResult.message);
        } catch (err) {
          setDeploymentConfigStatus('failed');
          setDeploymentConfigMessage(
            err instanceof Error ? err.message : 'Failed to seed the initial deployment configuration.',
          );
        }
      } catch (err) {
        setStatuses((current) => ({ ...current, configurationBucket: 'failed' }));
        setMessages((current) => ({
          ...current,
          configurationBucket: err instanceof Error ? err.message : 'Failed to bootstrap configurationBucket.',
        }));
        setDeploymentConfigStatus('failed');
        setDeploymentConfigMessage('The configuration bucket failed to bootstrap, so its initial configuration was not seeded.');
      }
    })();

    const runsTableCall = (async () => {
      try {
        const result = await window.hyveon!.wizard.bootstrapRunsTable();
        setRunsTableStatus(result.status as BootstrapResourceState);
        setRunsTableMessage(result.message);
      } catch (err) {
        setRunsTableStatus('failed');
        setRunsTableMessage(err instanceof Error ? err.message : 'Failed to bootstrap the run-history table.');
      }
    })();

    await Promise.all([stateBucketCall, configurationBucketCall, runsTableCall]);
    setBootstrapping(false);
  }

  /** Runs the best-effort IAM permission dry-run. Never blocks wizard progression. */
  async function runIamCheck() {
    if (!window.hyveon) {
      setIamError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setIamChecking(true);
    setIamError(null);
    try {
      const result = await window.hyveon.wizard.simulateIamPermissions();
      setIamCheck(result);
    } catch (err) {
      setIamError(err instanceof Error ? err.message : 'Failed to run the IAM permission check.');
    } finally {
      setIamChecking(false);
    }
  }

  const isResourceDone = (status: BootstrapResourceState) => status === 'created' || status === 'exists';

  const complete =
    (['stateBucket', 'configurationBucket'] as BootstrapResourceKey[]).every((resource) => isResourceDone(statuses[resource])) &&
    isResourceDone(runsTableStatus) &&
    isResourceDone(deploymentConfigStatus);

  return {
    names,
    statuses,
    messages,
    runsTable: { status: runsTableStatus, message: runsTableMessage },
    deploymentConfig: { status: deploymentConfigStatus, message: deploymentConfigMessage },
    iam: { check: iamCheck, checking: iamChecking, error: iamError },
    bootstrapping,
    complete,
    onNameChange,
    setNames,
    runBootstrap,
    runIamCheck,
  };
}
