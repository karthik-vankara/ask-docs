# Langfuse Tracing Troubleshooting Guide

If you're not seeing traces in your Langfuse dashboard after running queries, follow this step-by-step guide.

## Step 1: Verify Credentials are Correct

```bash
cat .env | grep LANGFUSE
```

You should see:
```
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

**Important**: 
- If `LANGFUSE_SECRET_KEY` is missing or empty → traces CANNOT be sent
- If `LANGFUSE_PUBLIC_KEY` is missing or empty → tracing won't work
- If `LANGFUSE_BASE_URL` is wrong → traces go to wrong server
  - Use `https://cloud.langfuse.com` for EU (default)
  - Use `https://us.cloud.langfuse.com` for US region

## Step 2: Test Langfuse Connection Directly

Run the standalone SDK test:

```bash
npx tsx test-langfuse-simple.ts
```

You should see:
```
✓ Trace created!
✓ Test complete!
```

If you see errors here → SDK initialization is failing (check credentials)

If test succeeds but traces still don't appear → continue to Step 3

## Step 3: Test Query Endpoint

Start the server:
```bash
npm run dev
```

In another terminal, make a test query:
```bash
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-test-secret" \
  -H "x-user-id: debug-user" \
  -d '{"question": "test"}'
```

The query should complete successfully. Then:

1. **Wait 20-30 seconds** (Langfuse batches and processes events)
2. Go to https://cloud.langfuse.com
3. Select your project from the left sidebar
4. Click "Traces" in the top navigation
5. Look for a trace named "rag-query"
6. Filter by user ID "debug-user" if needed

## Step 4: Verify Your Langfuse Project

In Langfuse dashboard:

1. Click **Settings** (gear icon, top right)
2. Verify you have **API Keys** section
3. Ensure you copied the **Secret Key** (starts with `sk-lf-`) and **Public Key** (starts with `pk-lf-`)
4. Verify **Project** selection (top left) matches where you're looking for traces

## Step 5: Check for Common Issues

### Issue: "Authentication failed" errors in console
- **Cause**: Invalid Langfuse credentials
- **Fix**: 
  1. Get new API keys from https://cloud.langfuse.com/settings
  2. Update `.env` file
  3. Restart server (`npm run dev`)

### Issue: Traces appear empty or with missing data
- **Cause**: Function might be returning before trace data is captured
- **Fix**: Already implemented - server waits 3 seconds before responding

### Issue: Traces appear for only some queries
- **Cause**: Might be hitting errors in pipeline
- **Fix**: Check console logs for any errors during query execution

### Issue: No traces appear at all even after 5 minutes
- **Cause**: Credentials might not have *write* permissions
- **Fix**:
  1. Delete old API keys in Langfuse
  2. Create new API keys with full permissions
  3. Update `.env` and restart

## Step 6: Enable Verbose Logging

Add this to `src/api/server.ts` before the query handler:

```typescript
app.post("/query", asyncHandler(async (req, res) => {
  console.log("[TRACE] Query request received");
  console.log("[TRACE] Langfuse BASE_URL:", process.env.LANGFUSE_BASE_URL);
  console.log("[TRACE] User ID:", req.headers["x-user-id"]);
  // ... rest of handler
}));
```

Then run server and check console output for `[TRACE]` logs.

## Step 7: Test with Minimal Example

Create `test-minimal-query.ts`:

```typescript
import "dotenv/config";
import { startActiveObservation, updateActiveTrace } from "@langfuse/tracing";

async function test() {
  await startActiveObservation(
    "minimal-test-query",
    async (span) => {
      updateActiveTrace({ userId: "minimal-test" });
      span.update({
        input: { question: "What is 2+2?", topK: 5 },
        output: { answer: "4", citations: [] }
      });
    }
  );
  
  // Wait for trace to be sent
  await new Promise(r => setTimeout(r, 3000));
  console.log("✓ Check Langfuse dashboard for 'minimal-test-query' trace");
}

test().catch(console.error);
```

Run:
```bash
npx tsx test-minimal-query.ts
```

Check dashboard immediately after.

## Step 8: Verify Request Headers

The `/query` endpoint reads:
- `x-user-id` header → becomes userId in trace

Make sure you're sending this header:
```bash
curl ... -H "x-user-id: my-test-user" ...
```

## Solution Summary

Traces should appear in https://cloud.langfuse.com with:
- ✓ Valid Langfuse credentials in `.env`
- ✓ Server restarted after updating `.env`
- ✓ Query endpoint called with proper headers
- ✓ 20-30 second wait for Langfuse to process
- ✓ Correct project selected in Langfuse UI

If still no traces after all steps, check:
1. Langfuse Service Status: https://status.langfuse.com/
2. Browser console for any errors
3. Server console logs for SDK errors
4. Firewall/VPN might block langfuse.com connection

## Next Steps

Once traces appear:
- Add more nested spans for pipeline stages (retrieval, reranking, generation)
- Track token usage and costs
- Add custom metadata for debugging
- Create scores for quality evaluation
