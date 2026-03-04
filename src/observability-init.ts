/**
 * OpenTelemetry initialization for Langfuse
 * 
 * CRITICAL: This file must be imported at the TOP of your application,
 * BEFORE any other code runs.
 * 
 * @see https://langfuse.com/docs/observability/sdk/overview
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// ─── Initialize OpenTelemetry with Langfuse ──────────────────────────────────

// Verify credentials are present
const requiredEnvVars = ["LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY"];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

if (missingVars.length > 0) {
  console.warn(
    `[Langfuse] Warning: Missing environment variables: ${missingVars.join(", ")
    }. Traces will NOT be sent to Langfuse.`
  );
}

// Create and start the OpenTelemetry SDK with Langfuse exporter
// NOTE: No auto-instrumentation - we use @langfuse/tracing for explicit manual traces
// This avoids creating extra noise traces and gives us better control
const sdk = new NodeSDK({
  spanProcessors: [
    new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
      // Immediately flush spans (important for express handlers)
      // Each span is sent as soon as possible
      flushAt: 1,
      // If more than 1 span queued, flush every 100ms
      flushInterval: 100,
      // 5 second timeout for network requests
      timeout: 5000,
    }),
  ],
  // No auto-instrumentation: use @langfuse/tracing for manual control
  instrumentations: [],
});

// Start the SDK - THIS IS CRITICAL!
console.log("[Langfuse] Starting OpenTelemetry SDK...");
sdk.start();
console.log("[Langfuse] ✓ OpenTelemetry SDK started");

// Graceful shutdown handlers
const handleShutdown = async (signal: string) => {
  console.log(`[Langfuse] Received ${signal}, shutting down...`);
  try {
    await sdk.shutdown();
    console.log("[Langfuse] ✓ SDK shutdown complete");
  } catch (error) {
    console.error("[Langfuse] Error during shutdown:", error);
    process.exit(1);
  }
  process.exit(0);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

// Also ensure shutdown on normal exit
process.on("exit", async () => {
  try {
    await sdk.shutdown();
  } catch {
    // Ignore errors during exit
  }
});

export { sdk };
