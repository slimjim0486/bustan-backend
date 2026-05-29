// Detect the dominant script of a short message. Used to set
// Customer.preferredLanguage from inbound WhatsApp text. Returns null when
// there are no letters to judge (so callers don't overwrite on noise).
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
const LETTER = /\p{L}/u;

export function detectLanguage(text: string | null | undefined): "ar" | "en" | null {
  if (!text) return null;
  let arabic = 0;
  let letters = 0;
  for (const ch of text) {
    if (LETTER.test(ch)) {
      letters += 1;
      if (ARABIC.test(ch)) arabic += 1;
    }
  }
  if (letters === 0) return null;
  return arabic / letters >= 0.3 ? "ar" : "en";
}
