import type { PriceUnresolvedAlert } from "./write-llm-call-event.js";

// Issue 5.3 (Epic 5): internal alert stub.
//
// Per this issue's own description, "a log line or Sentry message is
// sufficient for V1" -- Sentry itself isn't wired into apps/proxy until
// issue 19.2, so this is a plain, structured log line for now. It's
// intentionally the *only* place that decides how a price-unresolved
// event gets reported; when 19.2 lands, that issue only needs to swap
// this function out for a real Sentry call at the call site (wherever
// WriteLlmCallEventDeps gets assembled, e.g. the future 6.1 endpoint or
// 7.3 worker) -- write-llm-call-event.ts itself never needs to change,
// since it only depends on the alertPriceUnresolved shape, not this
// specific implementation.
//
// Uses console.warn (not console.error) because a pricing gap is a
// data-quality issue the team needs to act on, not a crash or a failed
// request -- the event itself was still written successfully.

export function alertPriceUnresolvedViaConsole(
  details: PriceUnresolvedAlert,
): void {
  console.warn(
    `[volar:pricing-gap] no PriceTable entry for provider=${details.provider} ` +
      `model=${details.model} at occurred_at=${details.occurredAt} ` +
      `(project_id=${details.projectId}). computed_cost_usd stored as null ` +
      "for this event -- add a PriceTable row (see packages/internal-cli's " +
      "add-price-version runbook) to backfill and stop future gaps.",
  );
}
