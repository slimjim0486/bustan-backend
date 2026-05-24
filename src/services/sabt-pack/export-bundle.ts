// Sabt Pack download bundle builder.
//
// Unlike the Ad Studio Meta kit (paid-ads: audiences, pixel events, campaign
// JSON), a Sabt Pack is *organic* weekly content the owner posts by hand. So
// the bundle is shaped for posting, not for Ads Manager: one folder per slot
// holding its image(s) + a ready-to-paste caption, plus an all-in-one
// captions.md and a posting-schedule README.
//
// Output structure:
//   README.md
//   captions.md
//   manifest.json
//   posts/
//     slot-1-slideshow/{frame-1.jpg … caption.txt}
//     slot-2-reel-cover/{image.jpg, caption.txt}
//     …
//     slot-7-google-business-post/{image.jpg, caption.txt}

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import JSZip from "jszip";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { uploadBuffer } from "@/services/r2";
import { prisma } from "@/lib/prisma";
import { isAllowedImageHost } from "@/services/ad-studio-ai/export-bundle";

const EXPORT_FOLDER = "sabt-pack-exports";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const FETCH_IMAGE_TIMEOUT_MS = 15_000;
const FETCH_IMAGE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB hard cap per image
const MAX_BUNDLE_BYTES = 60 * 1024 * 1024; // 60 MB — 7 slots × slideshow frames

// Human labels + folder slugs per slot format. Mirrors the frontend
// SABT_PACK_SLOT_FORMAT_LABEL so the ZIP reads the same as the review UI.
const SLOT_META: Record<string, { label: string; folder: string; platform: string }> = {
  slideshow_5_4_5: { label: "Slideshow / TikTok Photo Mode", folder: "slideshow", platform: "Instagram / TikTok" },
  ig_reel_still_9_16: { label: "Reel cover still", folder: "reel-cover", platform: "Instagram Reel" },
  ig_feed_4_5: { label: "Instagram Feed", folder: "instagram-feed", platform: "Instagram Feed" },
  carousel_1_1: { label: "Carousel / Snap", folder: "carousel", platform: "Instagram / Snapchat" },
  gbp_1_91_1: { label: "Google Business image", folder: "google-business-image", platform: "Google Business" },
  wa_status_9_16: { label: "WhatsApp Status", folder: "whatsapp-status", platform: "WhatsApp" },
  gbp_post_1_91_1: { label: "Google Business post", folder: "google-business-post", platform: "Google Business" },
};

function slotMeta(format: string | null) {
  return (format && SLOT_META[format]) || { label: format ?? "Post", folder: "post", platform: "Social" };
}

let signClient: S3Client | null = null;
function getSignClient() {
  if (signClient) return signClient;
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new ApiError("R2 credentials are not configured", 503);
  }
  signClient = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return signClient;
}

export interface SabtPackExportSlot {
  slot: number | null;
  format: string | null;
  headline: string;
  primaryText: string;
  ctaText: string;
  headlineAr: string | null;
  primaryTextAr: string | null;
  ctaTextAr: string | null;
  heroImageUrl: string | null;
  slideshowFrames: string[] | null;
  gbpPostBody: string | null;
  scheduledFor: Date | string | null;
}

export interface SabtPackExportInput {
  projectId: string;
  restaurantId: string;
  restaurantName: string;
  weekStartDate: Date | string | null;
  themeOfWeek: string | null;
  slots: SabtPackExportSlot[];
}

export interface SabtPackExportResult {
  fileKey: string;
  fileUrl: string;
  signedUrl: string;
  expiresAt: Date;
  fileSizeBytes: number;
  manifest: Record<string, unknown>;
}

/**
 * Build a Sabt Pack download ZIP (images + captions, organised per slot),
 * upload to R2, persist an AdExport row, and return a signed download URL.
 *
 * Per-image fetch failures are tolerated (the caption still ships) so one
 * dead image URL can't sink the whole download.
 */
export async function buildSabtPackBundle(input: SabtPackExportInput): Promise<SabtPackExportResult> {
  if (input.slots.length === 0) {
    throw new ApiError("Approve at least one post before downloading.", 400);
  }

  // Stable ordering by slot so the ZIP reads top-to-bottom like the UI.
  const slots = [...input.slots].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));

  const zip = new JSZip();
  const postsFolder = zip.folder("posts")!;

  const manifestSlots: Array<Record<string, unknown>> = [];

  for (const s of slots) {
    const meta = slotMeta(s.format);
    const slotLabel = `slot-${s.slot ?? "x"}-${meta.folder}`;
    const folder = postsFolder.folder(slotLabel)!;

    const imageFiles: string[] = [];

    // Slot 1 ships multiple slideshow frames; everything else is a single hero.
    if (s.slideshowFrames && s.slideshowFrames.length > 0) {
      let frameNo = 1;
      for (const url of s.slideshowFrames) {
        const name = await addImage(folder, url, `frame-${frameNo}`);
        if (name) imageFiles.push(`${slotLabel}/${name}`);
        frameNo += 1;
      }
    } else if (s.heroImageUrl) {
      const name = await addImage(folder, s.heroImageUrl, "image");
      if (name) imageFiles.push(`${slotLabel}/${name}`);
    }

    folder.file("caption.txt", buildCaptionText(s, meta));

    manifestSlots.push({
      slot: s.slot,
      format: s.format,
      platform: meta.platform,
      label: meta.label,
      folder: `posts/${slotLabel}/`,
      scheduledFor: toIso(s.scheduledFor),
      images: imageFiles,
      caption: `posts/${slotLabel}/caption.txt`,
    });
  }

  zip.file("captions.md", buildCaptionsMarkdown(input, slots));
  zip.file("README.md", buildReadme(input, slots));

  const manifest = {
    bustan: { generator: "sabt-pack", kind: "sabt_pack_zip", version: 1 },
    pack: {
      projectId: input.projectId,
      restaurantId: input.restaurantId,
      restaurantName: input.restaurantName,
      weekStartDate: toIso(input.weekStartDate),
      themeOfWeek: input.themeOfWeek,
      postCount: slots.length,
    },
    posts: manifestSlots,
    createdAt: new Date().toISOString(),
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const fileSizeBytes = buffer.length;
  if (fileSizeBytes > MAX_BUNDLE_BYTES) {
    throw new ApiError(
      `Generated pack exceeds size cap (${Math.round(fileSizeBytes / 1024 / 1024)}MB > 60MB).`,
      413
    );
  }

  const fileKey = `${EXPORT_FOLDER}/${input.restaurantId}/${input.projectId}/${Date.now()}.zip`;
  await uploadBuffer({ buffer, contentType: "application/zip", key: fileKey });

  const signedUrl = await getSignedUrl(
    getSignClient(),
    new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: fileKey }),
    { expiresIn: SIGNED_URL_TTL_SECONDS }
  );
  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);

  // Store the canonical (unsigned) URL — sign on demand to avoid persisting
  // time-limited credentials, matching the Ad Studio export convention.
  const canonicalUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${fileKey}`;
  await prisma.adExport.create({
    data: {
      projectId: input.projectId,
      format: "sabt_pack_zip",
      fileUrl: canonicalUrl,
      fileKey,
      fileSizeBytes,
      manifestJson: manifest as unknown as Prisma.InputJsonValue,
      expiresAt,
    },
  });

  return { fileKey, fileUrl: canonicalUrl, signedUrl, expiresAt, fileSizeBytes, manifest };
}

function buildCaptionText(s: SabtPackExportSlot, meta: { label: string; platform: string }): string {
  const lines: string[] = [
    `SLOT ${s.slot ?? "?"} — ${meta.label}`,
    `Platform: ${meta.platform}`,
  ];
  const day = postDay(s.scheduledFor);
  if (day) lines.push(`Suggested post day: ${day}`);
  lines.push("", "HEADLINE", s.headline, "", "CAPTION", s.primaryText, "", "CALL TO ACTION", s.ctaText);

  if (s.gbpPostBody) {
    lines.push("", "GOOGLE BUSINESS POST BODY", s.gbpPostBody);
  }

  const hasAr = s.headlineAr || s.primaryTextAr || s.ctaTextAr;
  if (hasAr) {
    lines.push("", "──────── العربية ────────");
    if (s.headlineAr) lines.push("", "العنوان", s.headlineAr);
    if (s.primaryTextAr) lines.push("", "النص", s.primaryTextAr);
    if (s.ctaTextAr) lines.push("", "زر الإجراء", s.ctaTextAr);
  }

  return lines.join("\n");
}

function buildCaptionsMarkdown(input: SabtPackExportInput, slots: SabtPackExportSlot[]): string {
  const lines: string[] = [
    `# ${input.themeOfWeek ?? "Sabt Pack"} — captions`,
    "",
    `**${input.restaurantName}** · Week of ${toIso(input.weekStartDate)?.slice(0, 10) ?? "—"}`,
    "",
    "Copy each caption straight into the matching app. Images are in `posts/`.",
    "",
  ];
  for (const s of slots) {
    const meta = slotMeta(s.format);
    lines.push(`## Slot ${s.slot ?? "?"} — ${meta.label}`);
    const day = postDay(s.scheduledFor);
    if (day) lines.push(`_Suggested post day: ${day} · ${meta.platform}_`);
    else lines.push(`_${meta.platform}_`);
    lines.push("");
    lines.push(`**${s.headline}**`, "", s.primaryText, "", `*CTA: ${s.ctaText}*`);
    if (s.gbpPostBody) lines.push("", "> Google Business post body:", "> " + s.gbpPostBody.replace(/\n/g, "\n> "));
    if (s.headlineAr || s.primaryTextAr || s.ctaTextAr) {
      lines.push("", "<div dir=\"rtl\">", "");
      if (s.headlineAr) lines.push(`**${s.headlineAr}**`, "");
      if (s.primaryTextAr) lines.push(s.primaryTextAr, "");
      if (s.ctaTextAr) lines.push(`*${s.ctaTextAr}*`);
      lines.push("", "</div>");
    }
    lines.push("", "---", "");
  }
  return lines.join("\n");
}

function buildReadme(input: SabtPackExportInput, slots: SabtPackExportSlot[]): string {
  return [
    `# ${input.themeOfWeek ?? "Your Sabt Pack"}`,
    "",
    `**${input.restaurantName}**`,
    `Week of ${toIso(input.weekStartDate)?.slice(0, 10) ?? "—"} · ${slots.length} post${slots.length === 1 ? "" : "s"}`,
    "",
    "## What's inside",
    "",
    "- `captions.md` — every caption in one file, ready to copy.",
    "- `posts/` — one folder per post with its image(s) and a `caption.txt`.",
    "- `manifest.json` — machine-readable index (for automation).",
    "",
    "## Posting schedule",
    "",
    ...slots.map((s) => {
      const meta = slotMeta(s.format);
      const day = postDay(s.scheduledFor);
      return `- **Slot ${s.slot ?? "?"}** · ${meta.label} → ${meta.platform}${day ? ` · post ${day}` : ""}`;
    }),
    "",
    "## How to post",
    "",
    "1. Open `captions.md` (or the slot's `caption.txt`).",
    "2. Upload the matching image(s) from that slot's folder.",
    "3. Paste the caption, then publish.",
    "",
    "Generated by Bustan · Sabt Pack.",
  ].join("\n");
}

function postDay(scheduledFor: Date | string | null): string | null {
  if (!scheduledFor) return null;
  const d = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { weekday: "long", timeZone: "Asia/Dubai" });
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Fetch an image and add it to `folder` under `baseName.<ext>`. Returns the
 *  written filename, or null if the fetch failed (caller tolerates the gap). */
async function addImage(folder: JSZip, url: string, baseName: string): Promise<string | null> {
  try {
    const buf = await fetchImage(url);
    const ext = inferImageExt(url, buf);
    const name = `${baseName}.${ext}`;
    folder.file(name, buf);
    return name;
  } catch (error) {
    console.warn(`[sabt-pack export] image fetch failed for ${url}`, error);
    return null;
  }
}

async function fetchImage(url: string): Promise<Buffer> {
  if (!isAllowedImageHost(url)) {
    throw new Error(`Refused to fetch image from disallowed host: ${url}`);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_IMAGE_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to fetch image ${url}: ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > 0 && declaredLength > FETCH_IMAGE_MAX_BYTES) {
    throw new Error(`Image exceeds size cap (${declaredLength} bytes)`);
  }
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > FETCH_IMAGE_MAX_BYTES) {
    throw new Error(`Image exceeds size cap (${arrayBuffer.byteLength} bytes)`);
  }
  return Buffer.from(arrayBuffer);
}

function inferImageExt(url: string, buf: Buffer): "jpg" | "png" | "webp" {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 12 && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (url.toLowerCase().endsWith(".png")) return "png";
  if (url.toLowerCase().endsWith(".webp")) return "webp";
  return "jpg";
}
