import type { Dispatch, SetStateAction } from 'react';
import { type AwsRegionInfo } from '@hyveon/shared';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.component';

/** Sentinel `SelectItem` value for "enter a region manually" — Radix Select forbids an empty-string item value. */
export const OTHER_REGION_VALUE = '__other__';

/** Props for {@link GuidedIamRegionScreen}. */
export interface GuidedIamRegionScreenProps {
  /** True when a resume attempt found no recoverable region and fell back to this screen — see `guided-iam-step.component.tsx`'s resume effect. */
  resumedWithoutRegion: boolean;
  regionsByContinent: Array<[string, AwsRegionInfo[]]>;
  region: string;
  setRegion: Dispatch<SetStateAction<string>>;
  regionError: string | null;
  manualRegionEntry: boolean;
  setManualRegionEntry: Dispatch<SetStateAction<boolean>>;
  /** Validates the region and moves to the `template` phase. */
  onContinueGuided: () => void;
  /** Skips guided provisioning entirely and advances straight to the credentials step. */
  onSkipToManual: () => void;
}

/** `region` phase: the AWS region input plus the guided-vs-manual choice. */
export function GuidedIamRegionScreen({
  resumedWithoutRegion,
  regionsByContinent,
  region,
  setRegion,
  regionError,
  manualRegionEntry,
  setManualRegionEntry,
  onContinueGuided,
  onSkipToManual,
}: GuidedIamRegionScreenProps) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Hyveon can provision the AWS access it needs for you, or you can supply your own credentials.
      </p>

      {resumedWithoutRegion && (
        <p className="text-sm text-muted-foreground">
          Resuming a previous session — re-enter your AWS region to continue.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="wizard-guided-iam-region">AWS region</Label>
        {manualRegionEntry ? (
          <Input
            id="wizard-guided-iam-region"
            value={region}
            placeholder="us-east-1"
            onChange={(e) => setRegion(e.target.value)}
            autoFocus
          />
        ) : (
          <Select
            value={region}
            onValueChange={(value) => {
              if (value === OTHER_REGION_VALUE) {
                setManualRegionEntry(true);
                setRegion('');
                return;
              }
              setRegion(value);
            }}
          >
            <SelectTrigger id="wizard-guided-iam-region">
              <SelectValue placeholder="Select a region…" />
            </SelectTrigger>
            <SelectContent>
              {regionsByContinent.map(([continent, regions]) => (
                <SelectGroup key={continent}>
                  <SelectLabel>{continent}</SelectLabel>
                  {regions.map((r) => (
                    <SelectItem key={r.code} value={r.code}>
                      {r.name} — {r.code}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
              <SelectItem value={OTHER_REGION_VALUE}>Other (enter manually)</SelectItem>
            </SelectContent>
          </Select>
        )}
        <InlineAlert message={regionError} />
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={onContinueGuided}>
          Continue with guided setup
        </Button>
        <Button type="button" variant="outline" onClick={onSkipToManual}>
          I already have credentials
        </Button>
      </div>
    </div>
  );
}
