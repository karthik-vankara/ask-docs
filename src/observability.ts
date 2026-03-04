/**
 * Langfuse Tracing Utilities
 * 
 * IMPORTANT: observability-init.ts must be imported FIRST before using these functions
 */

import {
  startActiveObservation,
  updateActiveTrace,
  getLangfuseTracer,
  getActiveTraceId,
} from "@langfuse/tracing";

// ─── Langfuse Integration (OpenTelemetry-based) ────────────────────────────────
// Following: https://langfuse.com/docs/observability/sdk/instrumentation
// 
// The OpenTelemetry SDK is initialized in observability-init.ts
// which configures the Langfuse span exporter
//

// Export core tracing utilities
export { startActiveObservation, updateActiveTrace, getLangfuseTracer, getActiveTraceId };

// Graceful shutdown helper
export async function flushTraces(): Promise<void> {
  // The SDK automatically flushes events in the background
  // but add a small delay to ensure events are batched
  return new Promise((resolve) => setTimeout(resolve, 500));
}
