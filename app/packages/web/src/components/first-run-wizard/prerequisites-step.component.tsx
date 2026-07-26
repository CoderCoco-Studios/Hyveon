import { CheckCircle2, XCircle, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import type { PrerequisiteCheckResult, PrerequisitesReport, TerraformPrerequisiteCheckResult } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { Badge } from '@/components/ui/badge.component';
import { detectOs, type DetectedOs } from './wizard.utils.js';

/** Props for {@link PrerequisitesStep}. */
export interface PrerequisitesStepProps {
  /** Latest detection result, or `null` before the first check resolves. */
  report: PrerequisitesReport | null;
  /** True while a check (initial or Re-check) is in flight. */
  checking: boolean;
  /** Set when the detection call itself fails (e.g. IPC bridge unavailable). */
  error: string | null;
  /** Invoked by the Re-check button. */
  onRecheck: () => void;
}

/** Per-OS install instructions and vendor links for a single tool. */
const INSTALL_INSTRUCTIONS: Record<'terraform' | 'aws', Record<DetectedOs, string>> = {
  terraform: {
    macos: 'brew tap hashicorp/tap && brew install hashicorp/tap/terraform',
    windows: 'winget install Hashicorp.Terraform',
    linux: 'Download the binary and place it on PATH, or use your distro’s package manager (e.g. apt install terraform on distros with the HashiCorp apt repo configured).',
    unknown: 'See the install guide linked below for your platform.',
  },
  aws: {
    macos: 'brew install awscli',
    windows: 'Download and run the AWS CLI MSI installer.',
    linux: 'Use your distro’s package manager, or the official bundled installer (curl + unzip + ./aws/install).',
    unknown: 'See the install guide linked below for your platform.',
  },
};

const VENDOR_LINKS: Record<'terraform' | 'aws', string> = {
  terraform: 'https://developer.hashicorp.com/terraform/install',
  aws: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
};

const TOOL_LABELS: Record<'terraform' | 'aws', string> = {
  terraform: 'Terraform',
  aws: 'AWS CLI',
};

/**
 * First step of the first-run wizard (#184): detects `terraform` and `aws`
 * on `PATH` and blocks progression until both are present (and, for
 * Terraform, meet the minimum supported version). Never offers to install
 * anything itself — only instructions, a vendor link, and a Re-check button,
 * per the locked wizard design (no auto-install, no auto-grant).
 */
export function PrerequisitesStep({ report, checking, error, onRecheck }: PrerequisitesStepProps) {
  const os = detectOs();

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Hyveon needs <code>terraform</code> and the <code>aws</code> CLI on your <code>PATH</code> before it can
        bootstrap your AWS account. Install any missing tool below, then select Re-check.
      </p>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-red)]">
          {error}
        </p>
      )}

      {!report && checking && !error && <p className="text-sm text-muted-foreground">Checking…</p>}

      {report && (
        <div className="space-y-4">
          <ToolRow tool="terraform" result={report.terraform} os={os} />
          <ToolRow tool="aws" result={report.aws} os={os} />
        </div>
      )}

      <Button type="button" variant="outline" onClick={onRecheck} disabled={checking}>
        {checking && <Loader2 className="animate-spin" />}
        Re-check
      </Button>
    </div>
  );
}

/** Renders detection status, version, and (when missing/below-minimum) install instructions for one tool. */
function ToolRow({
  tool,
  result,
  os,
}: {
  tool: 'terraform' | 'aws';
  result: PrerequisiteCheckResult | TerraformPrerequisiteCheckResult;
  os: DetectedOs;
}) {
  const minimumSatisfied = 'minimumVersionSatisfied' in result ? result.minimumVersionSatisfied : undefined;
  const belowMinimum = minimumSatisfied === false;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        {result.found && !belowMinimum && <CheckCircle2 className="size-4 text-[var(--color-green)]" />}
        {result.found && belowMinimum && <AlertTriangle className="size-4 text-[var(--color-amber)]" />}
        {!result.found && <XCircle className="size-4 text-[var(--color-red)]" />}
        <span className="font-medium">{TOOL_LABELS[tool]}</span>
        {result.found ? (
          <Badge variant={belowMinimum ? 'warning' : 'success'}>
            {result.version ? `Found v${result.version}` : 'Found'}
          </Badge>
        ) : (
          <Badge variant="destructive">Not found</Badge>
        )}
      </div>

      {belowMinimum && (
        <p className="text-xs text-[var(--color-amber)]">
          Version {result.version} is below the minimum supported version. Please upgrade.
        </p>
      )}

      {(!result.found || belowMinimum) && (
        <div className="text-xs text-muted-foreground space-y-1">
          <p>{INSTALL_INSTRUCTIONS[tool][os]}</p>
          <a
            href={VENDOR_LINKS[tool]}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline"
          >
            Install guide <ExternalLink className="size-3" />
          </a>
        </div>
      )}
    </div>
  );
}
