# Langfuse JS SDK: Proper LLM Cost Tracking Research

## Executive Summary

Langfuse has a **specific cost tracking mechanism** that requires using `usage_details` and `cost_details` objects on **generation observations**. Costs show up automatically in the Langfuse dashboard based on model + token counts when you configure model definitions or provide manual cost calculations.

---

## 1. API Architecture: @langfuse/tracing vs @langfuse/client

### @langfuse/tracing (Instrumentation API)
- **Purpose**: High-level OpenTelemetry-based decorator/instrumentation API
- **Runtime**: Node.js 20+
- **Use Case**: Creating observations with Python-like decorator pattern or context managers
- **Key Methods**:
  - `@observe()` - decorator for automatic function tracing
  - `.start_as_current_observation()` - context manager style (async-aware)
  - `.start_observation()` - manual observation creation
- **Best For**: Adding observability with minimal code changes

### @langfuse/client (Direct API Client)
- **Purpose**: Low-level universal JavaScript API client
- **Runtime**: Works in Node.js, browser, any JS environment
- **Use Case**: Direct API interactions, custom integrations
- **Key Methods**:
  - Direct REST API calls to Langfuse backend
  - Raw observation/trace creation
- **Best For**: Advanced use cases, integrations with specific frameworks

### Key Difference
- **@langfuse/tracing**: Wrapper around OpenTelemetry, decorator-style, automatic context propagation
- **@langfuse/client**: Direct client, more low-level control, universal compatibility
- **Both** work together and can be mixed in the same application

---

## 2. Cost Tracking Mechanism in Langfuse

### NOT Through Metadata
❌ **Incorrect**: Putting costs in `metadata` or as arbitrary span attributes
- Metadata is for custom data, not recognized for cost tracking
- Won't appear in dashboard's Cost column

### Correct Approach: usage_details + cost_details
✅ **Use generation-level fields** on the observation:

```typescript
interface UsageDetails {
  input?: number;           // input tokens
  output?: number;          // output tokens
  total?: number;           // total tokens
  cache_read_input_tokens?: number;
  audio_tokens?: number;
  image_tokens?: number;
  // ... other custom token types
}

interface CostDetails {
  input?: number;           // cost in USD for input
  output?: number;          // cost in USD for output
  cache_read_input_tokens?: number;
  // ... corresponding to usage types
  total?: number;           // total cost in USD
}
```

**Only observations of type `generation` and `embedding` support cost tracking.**

---

## 3. Field Locations for Costs

### Cost Appears in Dashboard
The **Cost column** in the Langfuse dashboard shows:
1. **Automatically inferred** from model + token counts (if model definition exists)
2. **Manually ingested** via `cost_details` field
3. **Inferred from usage** - if you provide token counts, Langfuse can calculate cost if model pricing is defined

### These Fields Actually Show Costs
- ✅ `generation.usage_details` - token counts (input, output, total, etc.)
- ✅ `generation.cost_details` - USD cost breakdown by token type
- ❌ `metadata.cost` - won't show in Cost column
- ❌ `span.attributes.cost` - incorrect observation type

---

## 4. Two Approaches to Cost Calculation

### Approach 1: Automatic (Recommended when possible)
**Langfuse infers cost automatically IF:**
1. You set `model` parameter on generation
2. Model definition exists in Langfuse (built-in or custom)
3. You provide `usage_details` with token counts

```typescript
// Langfuse will automatically calculate cost
generation.update({
  model: "gpt-4o",
  usage_details: {
    input: 100,
    output: 50,
    total: 150
  }
  // No need for cost_details - it will be inferred!
});
```

**Supported Built-in Models**:
- OpenAI: gpt-4o, gpt-4-turbo, gpt-3.5-turbo, etc.
- Anthropic: claude-3-opus, claude-3-sonnet, claude-3-haiku
- Google: gemini-pro, gemini-2.5-pro, etc.

### Approach 2: Manual Calculation
**When you need explicit cost control:**

```typescript
generation.update({
  model: "gpt-4o",
  usage_details: {
    input: 100,
    output: 50,
    cache_read_input_tokens: 10,
    total: 160
  },
  cost_details: {
    input: 0.0015,      // $0.015 per 1000 tokens
    output: 0.006,      // $0.06 per 1000 tokens
    cache_read_input_tokens: 0.0003,  // cheaper cached tokens
    total: 0.0225       // sum of above
  }
});
```

---

## 5. How to Track Costs: Step-by-Step

### Using @langfuse/tracing (Recommended for your use case)

```typescript
import { observe, getClient } from "@langfuse/tracing";

const langfuse = getClient();

@observe({ as_type: "generation" })
async function callLLM(prompt: string) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 100
  });

  // Update generation with usage and cost
  langfuse.updateCurrentGeneration({
    model: "gpt-4o",
    usage_details: {
      input: response.usage.prompt_tokens,
      output: response.usage.completion_tokens,
      total: response.usage.total_tokens
    },
    // Costs are auto-calculated from model pricing if available
    // OR manually set:
    cost_details: {
      input: (response.usage.prompt_tokens / 1000) * 0.03,
      output: (response.usage.completion_tokens / 1000) * 0.06,
      total: ((response.usage.prompt_tokens / 1000) * 0.03) + 
             ((response.usage.completion_tokens / 1000) * 0.06)
    }
  });

  return response.choices[0].message.content;
}
```

### Using context manager pattern

```typescript
with langfuse.start_as_current_observation(
  as_type="generation",
  name="gpt-call",
  model="gpt-4o"
) as generation:
  response = openai_client.chat.completions.create(...)
  
  generation.update(
    output=response.choices[0].message.content,
    usage_details={
      "input": response.usage.prompt_tokens,
      "output": response.usage.completion_tokens,
    },
    # Costs auto-calculated if model pricing is set up
  )
```

### Using @langfuse/client (Lower-level API)

```typescript
import { Langfuse } from "@langfuse/client";

const langfuse = new Langfuse();

// Create generation directly
const generation = langfuse.createGeneration({
  name: "llm-call",
  model: "gpt-4o",
  input: "Your prompt",
  // Start timing automatically captured
});

// Later, after LLM response
const response = await llm.call(...);

// End generation with usage/cost
generation.end({
  output: response.text,
  usage_details: {
    input: response.tokens.input,
    output: response.tokens.output,
    total: response.tokens.total
  },
  cost_details: {
    input: calculateInputCost(response.tokens.input),
    output: calculateOutputCost(response.tokens.output),
    total: calculateTotalCost(response)
  }
});

await langfuse.flush();
```

---

## 6. Token Types and How They Map

### Standard Token Fields (automatically recognized)
| Field | Usage | Recognized By |
|-------|-------|---------------|
| `input` | Input/prompt tokens | All LLM providers |
| `output` | Output/completion tokens | All LLM providers |
| `total` | Sum of input + output | Automatically calculated if missing |
| `cache_read_input_tokens` | Cached input tokens (Claude, GPT-4) | Pricing tiers |
| `cached_tokens` | Alternative name for cached tokens | Alternate format |
| `audio_tokens` | Audio input tokens (GPT-4o) | OpenAI models |
| `image_tokens` | Image input tokens | Multi-modal models |
| `reasoning_tokens` | Reasoning tokens (o1 models) | OpenAI reasoning models |

### OpenAI Compatibility
Langfuse accepts OpenAI's usage format and remaps it:
```typescript
// OpenAI format (automatically mapped)
usage_details: {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  prompt_tokens_details: {
    cached_tokens: 10,
    audio_tokens: 5
  },
  completion_tokens_details: {
    reasoning_tokens: 20
  }
}

// Becomes (internally)
usage_details: {
  input: 100,
  output: 50,
  total: 150,
  input_cached_tokens: 10,
  input_audio_tokens: 5,
  output_reasoning_tokens: 20
}
```

---

## 7. Cost Inference: When Langfuse Auto-Calculates

### Automatic Cost Calculation Requires:
1. **Model is set**: `generation.model = "gpt-4o"`
2. **Usage is provided**: `usage_details` with at least `input` and `output`
3. **Model pricing is defined**: Either built-in or custom definition in Langfuse

### Model Pricing Tiers (Advanced)
For models with context-dependent pricing (Claude 3.5 Sonnet, Gemini 2.5 Pro):
- Large Context window (>200K) = higher price
- Langfuse automatically applies correct tier based on token count conditions

---

## 8. What Shows in the Dashboard

### Cost Column Displays:
- **If cost_details provided**: Shows exact USD cost breakdown
- **If cost_details NOT provided but usage_details + model is set**: Inferred cost
- **If no usage/cost data**: Empty/unknown

### Generation Detail View Shows:
```
Input:           100 tokens ($0.001)
Output:          50 tokens ($0.003)
Cache Read:      10 tokens ($0.0002)
─────────────────────────────────
Total:           150 tokens | $0.0042
```

### Nesting in Traces:
- All child generations' costs are **summarized at the trace level**
- Dashboard shows total cost for entire trace
- Can drill down to individual generation costs

---

## 9. Integration with Your current RAG Pipeline

### Current Setup Analysis
Your project has:
- OpenAI calls for generation
- Hybrid retrieval (BM25 + embeddings)
- Possible caching

### Recommended Implementation

**File: [src/generation/rag-chain.ts](src/generation/rag-chain.ts)**
```typescript
import { observe, getClient } from "@langfuse/tracing";
import { openai } from "@ai-sdk/openai";

const langfuse = getClient();

@observe({ as_type: "generation" })
async function generateWithLangfuse(
  query: string,
  context: string[]
) {
  // Perform RAG generation with cost tracking
  const response = await openai("gpt-4o", {
    messages: [
      { role: "system", content: "You are a helpful assistant" },
      { 
        role: "user", 
        content: `Context: ${context.join("\n")}\n\nQuery: ${query}` 
      }
    ],
    max_tokens: 500
  });

  // Langfuse automatically captures usage
  langfuse.updateCurrentGeneration({
    model: "gpt-4o",
    usage_details: {
      input: response.usage?.promptTokens,
      output: response.usage?.completionTokens,
      total: response.usage?.totalTokens
    }
    // Cost will auto-calculate from model definition
  });

  return response.text;
}
```

**File: [src/api/server.ts](src/api/server.ts) - For direct cost tracking:**
```typescript
import { Langfuse } from "@langfuse/client";

const client = new Langfuse();

app.post("/query", async (req, res) => {
  const trace = client.trace({
    name: "rag-query",
    userId: req.user.id,
    sessionId: req.session.id,
    metadata: { environment: "production" }
  });

  const generation = trace.generation({
    name: "llm-call",
    model: "gpt-4o",
    input: userQuery,
    // Trace gets nested properly
  });

  const response = await llm.generate(...);

  // End with usage - THIS is what shows in Cost column
  generation.end({
    output: response.text,
    usage_details: {
      input: response.usage.prompt_tokens,
      output: response.usage.completion_tokens
    }
  });

  trace.end({
    output: { answer: response.text, citations: response.sources }
  });

  await client.flush();
  res.json({ answer: response.text });
});
```

---

## 10. Common Mistakes to Avoid

### ❌ WRONG: Using Metadata
```typescript
// This will NOT show up in Cost column
generation.update({
  metadata: { cost: 0.0042, tokens: 150 }
});
```

### ❌ WRONG: Using Arbitrary Attributes
```typescript
// This will NOT work for cost tracking
generation.update({
  attributes: { "model.cost": 0.0042 }
});
```

### ❌ WRONG: Missing Model Parameter
```typescript
// Without model, costs cannot be inferred
generation.update({
  usage_details: { input: 100, output: 50 }
  // Cost cannot be calculated - model is required
});
```

### ❌ WRONG: Using OpenTelemetry Span Attributes
```typescript
// OpenTelemetry spans don't have usage_details
const span = trace.startSpan("llm-call");
span.setAttribute("llm.usage.prompt_tokens", 100);
// This becomes a span, not generation - no cost tracking!
```

### ✅ RIGHT: Proper Generation with Costs
```typescript
generation.update({
  as_type: "generation",  // Must be generation type
  model: "gpt-4o",        // Must have model
  usage_details: {        // token counts
    input: 100,
    output: 50
  },
  cost_details: {         // optional but explicit
    input: 0.0015,
    output: 0.003
  }
});
```

---

## 11. Best Practices for Your Implementation

### 1. **Always Set Model Parameter**
```typescript
// Required for cost inference
generation.update({ model: "gpt-4o" });
```

### 2. **Capture Usage from LLM Response**
```typescript
// Most LLM SDKs provide this
generation.update({
  usage_details: {
    input: response.usage.prompt_tokens,
    output: response.usage.completion_tokens
  }
});
```

### 3. **Use Built-in Models When Possible**
Langfuse has pricing for OpenAI, Anthropic, Google - no custom definition needed

### 4. **For Custom/Self-Hosted Models: Add Model Definition**
In Langfuse dashboard Settings > Models:
- Add your model name with pricing tier
- Then usage will generate cost automatically

### 5. **Flush Before Exit (Serverless)**
```typescript
// In your request handlers
await langfuse.flush();  // Wait for data to send
```

### 6. **Wrap RAG Operations in Traces**
```typescript
// Entire RAG pipeline in one trace
with langfuse.start_as_current_observation(
  as_type="span",
  name="rag-pipeline"
) as trace:
  // Retrieval (nested)
  // Generation (nested, captures cost)  
  // Reranking (nested)
```

---

## 12. Summary: How to Get Costs in Dashboard

### 3 Steps:
1. **Create a generation observation** (not a span)
   ```typescript
   @observe({ as_type: "generation" })
   ```

2. **Set model and usage_details**
   ```typescript
   generation.update({
     model: "gpt-4o",
     usage_details: { input: 100, output: 50 }
   });
   ```

3. **That's it!** Langfuse auto-calculates and displays cost

### If Auto-Calculation Doesn't Work:
- Add custom `cost_details` field with USD amounts
- Or add model definition to Langfuse dashboard

### Verification:
- Go to Langfuse dashboard trace detail
- Look for "Cost" row showing USD amount
- Click trace to see token breakdown

---

## References
- [Langfuse Model Usage & Cost Tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
- [JS/TS SDK Instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation)
- [Langfuse SDK Overview](https://langfuse.com/docs/observability/sdk/overview)
- [JS/TS SDK GitHub](https://github.com/langfuse/langfuse-js)
