import { CheckCircle2, Copy, ExternalLink, Loader2, RotateCcw } from 'lucide-react';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';

/** Props for {@link GuidedIamTemplateScreen}. */
export interface GuidedIamTemplateScreenProps {
  /** True exactly while `guidedIamPrepareTemplate()` is owed and hasn't settled either way. */
  preparingTemplate: boolean;
  templateError: string | null;
  /** Clears `templateError`, which re-triggers the render effect in the parent. */
  onRetryTemplate: () => void;
  templatePath: string | null;
  onCopyPath: () => void;
  pathCopied: boolean;
  openingConsole: boolean;
  onOpenConsole: () => void;
  consoleError: string | null;
  consoleOpened: boolean;
  consoleUrl: string | null;
  /** Moves from `template` to `intake`, persisting `awaiting-key-intake`. */
  onContinueToIntake: () => void;
}

/** `template` phase: renders `iam-bootstrap.yaml`, offers "Copy Path"/"Open AWS Console", then hands off to key entry. */
export function GuidedIamTemplateScreen({
  preparingTemplate,
  templateError,
  onRetryTemplate,
  templatePath,
  onCopyPath,
  pathCopied,
  openingConsole,
  onOpenConsole,
  consoleError,
  consoleOpened,
  consoleUrl,
  onContinueToIntake,
}: GuidedIamTemplateScreenProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Upload the rendered CloudFormation template in the AWS console to create a bootstrap IAM user, then come back
        here with the access key it outputs.
      </p>

      {preparingTemplate && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Rendering the CloudFormation template…
        </div>
      )}

      {templateError && (
        <div className="space-y-2">
          <InlineAlert message={templateError} />
          <Button type="button" variant="outline" onClick={onRetryTemplate}>
            <RotateCcw className="size-4" />
            Retry
          </Button>
        </div>
      )}

      {templatePath && (
        <div className="space-y-2">
          <Label htmlFor="wizard-guided-iam-template-path">Template path</Label>
          <div className="flex items-center gap-2">
            <Input id="wizard-guided-iam-template-path" value={templatePath} readOnly />
            <Button type="button" variant="outline" size="sm" onClick={onCopyPath} aria-label="Copy template path">
              <Copy className="size-3" />
            </Button>
          </div>
          {pathCopied && (
            <p className="flex items-center gap-1 text-sm text-[var(--color-green)]">
              <CheckCircle2 className="size-4" />
              Path copied.
            </p>
          )}
        </div>
      )}

      {templatePath && (
        <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
          <Button type="button" variant="outline" onClick={onOpenConsole} disabled={openingConsole}>
            {openingConsole && <Loader2 className="animate-spin" />}
            <ExternalLink className="size-4" />
            Open AWS Console
          </Button>

          <InlineAlert message={consoleError} />

          {consoleOpened && (
            <p className="flex items-center gap-1 text-sm text-[var(--color-green)]">
              <CheckCircle2 className="size-4" />
              Opened in your default browser.
            </p>
          )}

          {consoleUrl && (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                Could not open a browser automatically — open this URL manually:
              </p>
              <Input
                value={consoleUrl}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                aria-label="AWS console URL"
              />
            </div>
          )}
        </div>
      )}

      {templatePath && (
        <Button type="button" onClick={onContinueToIntake}>
          Continue to key entry
        </Button>
      )}
    </div>
  );
}
