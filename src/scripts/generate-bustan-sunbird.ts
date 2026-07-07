/**
 * Generate the Bustan sunbird persona art — the owner-facing agent's character.
 *
 * Bustan is a refined "sunbird of the orchard": a warm, sun-hued songbird that
 * keeps the restaurant like an orchard. Produces 3 avatar states + 1 starter
 * scene and uploads them to R2 under assets/bustan-sunbird/ (served from
 * https://images.getbustan.com). Uses the existing GPT Image pipeline
 * (`generateOpenAiImage`) — the same tool as the day-arc brand art — so the
 * sunbird sits naturally beside the rest of the illustration system.
 *
 * Usage:  cd backend && npx tsx src/scripts/generate-bustan-sunbird.ts
 *         # optionally filter: npx tsx src/scripts/generate-bustan-sunbird.ts resting working
 *
 * Cost: ~$0.19 per image (OPENAI_IMAGE_COST_USD). A full run of 4 is ~$0.76.
 */

import { generateOpenAiImage } from "@/services/openai-image";
import { uploadBuffer } from "@/services/r2";

// ── Design brief — hybrid: painterly SCENES, flat/graphic AVATARS ─────────────

// Avatars: clean, legible brand mark. Flat/graphic, reads at 32px.
const STYLE_GRAPHIC = `
<style>
Clean modern FLAT/GRAPHIC illustration — a designed brand avatar, NOT photographic,
NOT painterly. Bold simple shapes, a strong readable silhouette, a limited warm
palette (amber/gold #E8A317 + soft cream + a couple of clean accent tones), minimal
flat shading, crisp edges. Think premium vector / editorial illustration, or a
refined app-icon character. Expressive through posture and silhouette with a small
subtle eye — NOT big cartoon eyes. Warm flat cream-to-amber background. Must stay
legible and full of character even at 32px.
</style>
<avoid>
No photorealism, no painterly rendering, no heavy gradients, no fine feather detail.
No text, logos, watermarks. No human features or hands. No religious or national
symbols. No cartoon-mascot/sticker feel, no big anime eyes, no cloying cuteness.
NO orchard fruit, leaves, branches, or blossoms as background decoration — the
avatar is JUST the bird on a clean calm disc. No busy background.
</avoid>`;

// Scenes: keep the warm semi-realistic painterly render (approved direction).
const STYLE_PAINTERLY = `
<style>
Premium warm semi-realistic painterly illustration with soft depth — NOT flat, NOT
cartoonish. Golden day-arc lighting in the amber #E8A317 range. The bird belongs in
an elegant "orchard at sunrise" brand world — warm, calm, quietly competent.
</style>
<avoid>
No text, logos, watermarks. No human features or hands. No religious or national
symbols. No cool/blue tones, no harsh shadows.
</avoid>`;

// Tight head-and-shoulders crop for the primary small avatars (resting/working).
const AVATAR_COMPOSITION = `
<composition>
TIGHT head-and-shoulders close-up — the bird's head and upper chest FILL most of the
square frame, cropped in close. Calm background: a single soft warm disc (cream-to-amber,
subtle or flat), NOTHING else in frame. Designed to crop to a circle and stay crisp and
characterful at 32px. Simplify ruthlessly; the bird is the whole story.
</composition>`;

// The delivering state is a full-flight pose — clean disc, olive sprig the only prop.
const FLIGHT_COMPOSITION = `
<composition>
The full bird in graceful flight, centered on a single calm warm disc (cream-to-amber),
NOTHING in the background. The small olive sprig in its beak is the only prop. Elegant,
balanced, reads clearly when cropped to a circle.
</composition>`;

const SUBJECT = `a single small orchard SUNBIRD — a refined, elegant songbird with warm
sun-hued plumage (amber/gold #E8A317 with soft cream underparts), an alert,
intelligent, gently-competent character. It reads as a bird that quietly keeps an
orchard for you.`;

type Size = "1024x1024" | "1536x1024";

const VARIATIONS: { id: string; key: string; size: Size; prompt: string }[] = [
  {
    id: "resting",
    key: "assets/bustan-sunbird/bustan-avatar-resting",
    size: "1024x1024",
    prompt: `Create a single character illustration for a small circular app avatar.
<subject>
${SUBJECT} Here it is perched calmly and settled, at ease, shoulders-up / upper-body
framing, centered — a composed, trustworthy resting pose.
</subject>${STYLE_GRAPHIC}${AVATAR_COMPOSITION}`,
  },
  {
    id: "working",
    key: "assets/bustan-sunbird/bustan-avatar-working",
    size: "1024x1024",
    prompt: `Create a single character illustration for a small circular app avatar.
<subject>
${SUBJECT} Here it is alert and attentive — leaning slightly forward, wings just
lifting, focused as if working on a task for you. Upper-body framing, centered.
Poised and capable, not frantic.
</subject>${STYLE_GRAPHIC}${AVATAR_COMPOSITION}`,
  },
  {
    id: "delivering",
    key: "assets/bustan-sunbird/bustan-avatar-delivering",
    size: "1024x1024",
    prompt: `Create a single character illustration for a small circular app avatar.
<subject>
${SUBJECT} Here it is mid-flight, just arriving — wings spread in a graceful landing,
carrying a small olive sprig in its beak, "flying in with good news." Centered,
dynamic but elegant.
</subject>${STYLE_GRAPHIC}${FLIGHT_COMPOSITION}`,
  },
  {
    id: "scene-sunrise",
    key: "assets/bustan-sunbird/bustan-scene-sunrise",
    size: "1536x1024",
    prompt: `Create a wide brand illustration (not an avatar).
<subject>
${SUBJECT} Here it is perched on a slender olive branch in the foreground, looking
out over a calm orchard at sunrise. Room around the bird for an empty-state or
report illustration.
</subject>${STYLE_PAINTERLY}
<composition>
Landscape/wide frame, the bird perched to one side (rule of thirds), a warm day-arc
sunrise sky and softly suggested orchard behind. Generous negative space for a
headline. Serene, premium.
</composition>`,
  },
  {
    id: "scene-noon",
    key: "assets/bustan-sunbird/bustan-scene-noon",
    size: "1536x1024",
    prompt: `Create a wide brand illustration (not an avatar).
<subject>
${SUBJECT} Here it is perched on a slender olive branch in the foreground, looking
out over a calm orchard at bright midday. Room around the bird for an empty-state or
report illustration.
</subject>${STYLE_PAINTERLY}
<composition>
Landscape/wide frame, the bird perched to one side (rule of thirds), a luminous warm
midday day-arc sky (pale warm cream-gold, high soft sun, gentle haze — stay in the
amber/warm family, no cool blues) and softly suggested orchard behind. Generous
negative space for a headline. Keep the palette and rendering consistent with the
sunrise scene — only the light shifts to bright midday. Serene, premium.
</composition>`,
  },
  {
    id: "scene-sunset",
    key: "assets/bustan-sunbird/bustan-scene-sunset",
    size: "1536x1024",
    prompt: `Create a wide brand illustration (not an avatar).
<subject>
${SUBJECT} Here it is perched on a slender olive branch in the foreground, looking
out over a calm orchard at golden-hour sunset. Room around the bird for an empty-state
or report illustration.
</subject>${STYLE_PAINTERLY}
<composition>
Landscape/wide frame, the bird perched to one side (rule of thirds), a warm day-arc
golden-hour sunset sky (deep amber, rose and honey dusk, low warm sun) and softly
suggested orchard behind. Generous negative space for a headline. Keep the palette and
rendering consistent with the sunrise scene — only the light shifts to golden-hour
dusk. Serene, premium.
</composition>`,
  },
];

async function main() {
  const filter = process.argv.slice(2);
  const targets = filter.length
    ? VARIATIONS.filter((v) => filter.includes(v.id))
    : VARIATIONS;

  console.log(`\nBustan sunbird — generating ${targets.length} asset(s) with GPT Image\n`);
  const results: { id: string; url: string }[] = [];

  for (const v of targets) {
    try {
      console.log(`• ${v.id}  (${v.size})`);
      const generated = await generateOpenAiImage({
        prompt: v.prompt,
        size: v.size,
        quality: "high",
      });
      const { url } = await uploadBuffer({
        buffer: generated.buffer,
        contentType: generated.contentType,
        key: `${v.key}.${generated.extension}`,
      });
      console.log(`  ✓ ${url}\n`);
      results.push({ id: v.id, url });
    } catch (err) {
      console.error(`  ✗ ${v.id} failed: ${(err as Error).message}\n`);
    }
  }

  console.log("── URLs (paste approved ones into frontend/lib/agent-identity.ts) ──");
  for (const r of results) console.log(`  ${r.id.padEnd(16)} ${r.url}`);
  console.log("");
}

void main();
