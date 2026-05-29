// Pure helpers for the Arabic menu-translation endpoint. No I/O here so they
// can be unit-tested with node:test. The route in menu.ts wires these to Claude.

type RestaurantInput = {
  name: string;
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
};
type SectionInput = { id: string; name: string; nameAr?: string | null };
type ItemInput = {
  id: string;
  name: string;
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
};

export type TranslationSource = {
  restaurant: RestaurantInput;
  sections: SectionInput[];
  items: ItemInput[];
};

export type TranslationPayload = {
  restaurant: { name?: string; description?: string };
  sections: Array<{ id: string; name: string }>;
  items: Array<{ id: string; name?: string; description?: string }>;
};

const filled = (v: string | null | undefined) => typeof v === "string" && v.trim().length > 0;

/** Reduce the menu to ONLY the English fields that still need Arabic. */
export function buildArabicTranslationPayload(src: TranslationSource): TranslationPayload {
  const restaurant: { name?: string; description?: string } = {};
  if (filled(src.restaurant.name) && !filled(src.restaurant.nameAr)) {
    restaurant.name = src.restaurant.name;
  }
  if (filled(src.restaurant.description) && !filled(src.restaurant.descriptionAr)) {
    restaurant.description = src.restaurant.description!;
  }

  const sections = src.sections
    .filter((s) => filled(s.name) && !filled(s.nameAr))
    .map((s) => ({ id: s.id, name: s.name }));

  const items = src.items
    .map((i) => {
      const out: { id: string; name?: string; description?: string } = { id: i.id };
      if (filled(i.name) && !filled(i.nameAr)) out.name = i.name;
      if (filled(i.description) && !filled(i.descriptionAr)) out.description = i.description!;
      return out;
    })
    .filter((i) => i.name !== undefined || i.description !== undefined);

  return { restaurant, sections, items };
}

export function buildArabicTranslationPrompt(payload: TranslationPayload): string {
  return [
    "You are a professional menu translator for UAE restaurants.",
    "Translate the following English restaurant menu fields into natural, appetizing Modern Standard Arabic.",
    "Keep proper nouns / brand names transliterated sensibly. Do NOT add fields that are not present.",
    "Return ONLY a JSON object with this exact shape (same ids), no commentary:",
    '{"restaurant":{"nameAr":"...","descriptionAr":"..."},"sections":[{"id":"...","nameAr":"..."}],"items":[{"id":"...","nameAr":"...","descriptionAr":"..."}]}',
    "Only include keys whose English source was provided below.",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

export type TranslationResult = {
  restaurant?: { nameAr?: string; descriptionAr?: string };
  sections: Array<{ id: string; nameAr?: string }>;
  items: Array<{ id: string; nameAr?: string; descriptionAr?: string }>;
};

/** Tolerant parse: strips ```json fences and parses the first JSON object. */
export function parseArabicTranslationResponse(text: string): TranslationResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return { sections: [], items: [] };
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return {
    restaurant: parsed.restaurant ?? undefined,
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}
