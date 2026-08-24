/** Props for {@link InlineAlert}. */
export interface InlineAlertProps {
  /** The message to display, or `null`/empty to render nothing. */
  message: string | null;
}

/** Renders a single inline validation/error message with `role="alert"`, or nothing when there is no message. */
export function InlineAlert({ message }: InlineAlertProps) {
  if (!message) {
    return null;
  }

  return (
    <p role="alert" className="text-sm text-[var(--color-red)]">
      {message}
    </p>
  );
}
