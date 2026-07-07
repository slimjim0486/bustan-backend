// OpenAI image generation (GPT Image 2) for Ad Studio.
//
// Operator-selectable provider — the dashboard regen UI lets a paid-role
// owner pick "GPT Image 2" instead of the default Gemini path. GPT Image
// is best-in-class for product / food photography per operator testing
// but costs ~5x Gemini, so it's gated to a per-restaurant daily cap.
//
// Cost / billing: a successful generation logs $OPENAI_IMAGE_COST_USD to
// the AiUsage ledger so the global Ad Studio USD ceiling enforces
// across providers. Failures don't bill.

import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

interface OpenAiImageInput {
  prompt: string;
  // 1024x1024 is the GPT Image default; 1024x1536 portrait + 1536x1024
  // landscape are also supported. Bustan's Ad Studio uses square hero
  // tiles, so default to square.
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  // "high" matches the cost constant in env. "medium" / "low" cheaper
  // but visibly worse for food photography.
  quality?: "high" | "medium" | "low";
}

interface OpenAiImageResult {
  buffer: Buffer;
  contentType: string;
  extension: string;
  model: string;
}

interface OpenAiResponseImage {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface OpenAiResponse {
  data?: OpenAiResponseImage[];
  error?: { message?: string; type?: string; code?: string };
}

const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";

export async function generateOpenAiImage(
  input: OpenAiImageInput
): Promise<OpenAiImageResult> {
  if (!env.OPENAI_API_KEY) {
    throw new ApiError(
      "OpenAI image generation is not configured. Set OPENAI_API_KEY before allowing GPT Image regenerations.",
      503
    );
  }
  if (!input.prompt?.trim()) {
    throw new ApiError("OpenAI image generation requires a non-empty prompt.", 400);
  }

  const timeoutMs = env.OPENAI_IMAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const model = env.OPENAI_IMAGE_MODEL;
  console.log(`[openai-image] request model=${model} timeoutMs=${timeoutMs}`);

  let response: Response;
  try {
    response = await fetch(OPENAI_IMAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        size: input.size ?? "1024x1024",
        quality: input.quality ?? "high",
        n: 1,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("OpenAI image generation timed out.", 504);
    }
    // Don't leak the API key path or local hostnames.
    throw new ApiError("OpenAI image generation request failed.", 502);
  }
  clearTimeout(timeout);

  let payload: OpenAiResponse | null = null;
  try {
    payload = (await response.json()) as OpenAiResponse;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    // SEC-1 + SEC-2 fix: NEVER echo the upstream error message verbatim.
    // OpenAI error strings can include org IDs, billing state, account
    // identifiers, and model-availability hints — all visible through
    // errorResponse(c, error) to any Pro operator. Log server-side for
    // debugging, return a generic phrase keyed only on status class.
    console.error(
      "[openai-image] upstream error",
      response.status,
      payload?.error?.code ?? null,
      payload?.error?.type ?? null
    );
    const { clientStatus, clientMessage } = mapOpenAiErrorStatus(response.status);
    throw new ApiError(clientMessage, clientStatus);
  }

  const first = payload?.data?.[0];
  if (!first?.b64_json) {
    throw new ApiError("OpenAI image generation returned no image.", 502);
  }
  // SEC-11 fix: bound the synchronous Buffer.from allocation. A
  // 1024x1024 PNG is ~1-3MB; b64-encoded ~4MB. An adversarial / runaway
  // upstream returning a 30MB+ payload would block the event loop on
  // decode. 20MB b64 ceiling = ~15MB image, generous for any sane size.
  if (first.b64_json.length > 20_000_000) {
    throw new ApiError("OpenAI image generation returned an oversized payload.", 502);
  }

  return {
    buffer: Buffer.from(first.b64_json, "base64"),
    contentType: "image/png",
    extension: "png",
    model,
  };
}

/**
 * Map upstream HTTP status to a sanitized client status + generic message.
 * Auth, billing, and quota states all collapse to 503 (server-side
 * misconfiguration) so the operator-facing copy doesn't leak provider
 * detail. Rate-limit (429) passes through so the dashboard can show a
 * retry hint.
 */
function mapOpenAiErrorStatus(upstream: number): {
  clientStatus: number;
  clientMessage: string;
} {
  if (upstream === 401 || upstream === 402 || upstream === 403) {
    return {
      clientStatus: 503,
      clientMessage: "GPT Image is temporarily unavailable.",
    };
  }
  if (upstream === 429) {
    return {
      clientStatus: 429,
      clientMessage: "GPT Image is rate-limited. Try again in a moment.",
    };
  }
  if (upstream === 400 || upstream === 422) {
    // Prompt was rejected (safety / content policy / bad input).
    return {
      clientStatus: 400,
      clientMessage:
        "GPT Image rejected this prompt. Try a different angle or switch to Gemini.",
    };
  }
  return {
    clientStatus: 502,
    clientMessage: "GPT Image generation failed.",
  };
}
