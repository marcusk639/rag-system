/**
 * Thin observability wrapper around @sentry/node.
 *
 * Call `initMonitoring` once per process at startup with the optional DSN from
 * config. All exports are safe no-ops when the DSN is absent — call them
 * unconditionally without guards in the app code.
 */
import * as Sentry from "@sentry/node";

export function initMonitoring(dsn: string | undefined): void {
  if (!dsn) return;
  Sentry.init({ dsn });
}

/**
 * Report an error to Sentry with optional structured context.
 * No-op when Sentry is not initialised (DSN absent).
 */
export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  Sentry.withScope((scope: Sentry.Scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureException(err);
  });
}
