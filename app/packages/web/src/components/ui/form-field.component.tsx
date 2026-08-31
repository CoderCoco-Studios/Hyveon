import * as React from 'react';
import { cn } from '@/lib/utils.utils';

/** ARIA wiring `FormField` hands to its render-prop child. */
export interface FormFieldChildProps {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** Props for {@link FormField}. */
export interface FormFieldProps {
  /** `id` of the control; also seeds the `${id}-error` message id. */
  id: string;
  /** Field label, rendered in a `<label htmlFor={id}>`. */
  label: React.ReactNode;
  /** Validation message(s). A single string or a non-empty array renders as alert text; empty/undefined renders nothing. */
  errors?: string | string[];
  /** Optional helper text rendered below the error message(s). */
  hint?: React.ReactNode;
  className?: string;
  /** Render-prop for the field control — receives the ARIA wiring this component owns. */
  children: (props: FormFieldChildProps) => React.ReactNode;
}

/**
 * Labeled form-field wrapper that owns error-message id wiring and renders
 * its control via a render prop, since call sites wrap different element
 * types (`Input`, `<select>`, `<textarea>`, `<input type="range">`).
 *
 * @param props - {@link FormFieldProps}
 * @returns The labeled field, its control, and any error/hint text.
 */
function FormField({ id, label, errors, hint, className, children }: FormFieldProps) {
  const errorList = Array.isArray(errors) ? errors : errors ? [errors] : [];
  const hasErrors = errorList.length > 0;
  const errorId = `${id}-error`;

  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={id} className="text-sm font-medium leading-none text-[var(--color-foreground)]">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': hasErrors ? true : undefined,
        'aria-describedby': hasErrors ? errorId : undefined,
      })}
      {hasErrors && (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-red)] flex flex-col gap-0.5">
          {errorList.map((message, index) => (
            <span key={index}>{message}</span>
          ))}
        </p>
      )}
      {hint}
    </div>
  );
}

export { FormField };
