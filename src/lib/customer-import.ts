export type NormalizedCustomerImportRow = {
  name: string;
  phone: string;
  consent: boolean;
  preferredLanguage?: "en" | "ar" | null;
  normalizedPhone: string;
  index: number;
};

/** Deduplicate by tenant phone before writing; an explicit false wins. */
export function canonicalizeCustomerImportRows(rows: NormalizedCustomerImportRow[]): NormalizedCustomerImportRow[] {
  const byPhone = new Map<string, NormalizedCustomerImportRow>();
  for (const row of rows) {
    const previous = byPhone.get(row.normalizedPhone);
    byPhone.set(row.normalizedPhone, previous ? {
      ...row,
      consent: previous.consent && row.consent,
      index: Math.min(previous.index, row.index),
    } : row);
  }
  return [...byPhone.values()];
}
