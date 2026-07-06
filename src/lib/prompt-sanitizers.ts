// Low-level prompt sanitizers shared by the owner system prompt and the
// standing-instructions renderer. Leaf module (imports nothing from the
// prompt builders) so both can depend on it without an import cycle.
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function isUnsafeMemoryContent(content: string): boolean {
  const normalized = content.toLowerCase();
  return [
    /system\s+(prompt|instructions?|rules?)/,
    /developer\s+(prompt|instructions?|rules?)/,
    /ignore\s+(previous|prior|above|all|your)\s+(instructions?|rules?|prompts?)/,
    /forget\s+(previous|prior|above|all|your)\s+(instructions?|rules?|prompts?)/,
    /disregard\s+(previous|prior|above|all|your)\s+(instructions?|rules?|prompts?)/,
    /reveal\s+(your|the)\s+(prompt|instructions?|tools?)/,
    /tool\s+(list|schema|definitions?|calls?)/,
    /api\s+tool\s+list/,
    /output\s+(everything|all|the\s+text)\s+(above|before)/,
    /<\/?\s*(long_term_memory|restaurant_context|capabilities|tool_usage_rules|prompt_injection_defense)\b/,
    /\[inst\]|<<\s*sys\s*>>|jailbreak|dan\s+mode/,
  ].some((pattern) => pattern.test(normalized));
}
