import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import {
  assertAllowedPublicOrigin,
  assertRateLimit,
  getClientIp,
} from "@/lib/public-request-guards";
import { extractMenuFromSource } from "@/services/claude";

const previewExtractSchema = z
  .object({
    sourceText: z.string().max(20_000).optional(),
    fileName: z.string().max(255).optional(),
    contentType: z.string().max(120).optional(),
    base64: z.string().max(12_000_000).optional(),
  })
  .refine((data) => Boolean(data.sourceText?.trim() || data.base64), {
    message: "Provide menu text or upload a menu file to preview.",
  });

export const previewRoute = new Hono().post("/extract", async (c) => {
  try {
    const clientIp = getClientIp(c);
    assertAllowedPublicOrigin(c);
    assertRateLimit({
      key: `public-preview:${clientIp}`,
      limit: 5,
      windowMs: 10 * 60_000,
    });

    const data = previewExtractSchema.parse(await c.req.json());
    const draft = await extractMenuFromSource(data);

    if (!draft.sections.length) {
      throw new ApiError("We couldn't detect any menu sections to preview.", 422);
    }

    return c.json(draft);
  } catch (error) {
    return errorResponse(c, error);
  }
});
