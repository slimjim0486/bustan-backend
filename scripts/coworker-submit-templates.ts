// CLI: push COWORKER_TEMPLATE_LIBRARY to Meta + sync status back.
// Run via: npm run coworker:submit-templates
// Safe to re-run. Skips templates that already exist at Meta.

import { pushAndSync } from "@/services/coworker/template-sync";

async function main() {
  console.log("[coworker] pushing template library to Meta…");
  const { pushed, synced } = await pushAndSync();

  console.log("\n=== Submitted ===");
  for (const r of pushed) {
    const id = r.metaTemplateId ? ` meta=${r.metaTemplateId}` : "";
    const msg = r.message ? ` — ${r.message}` : "";
    console.log(`  [${r.action}] ${r.name} (${r.locale} v${r.version})${id}${msg}`);
  }

  console.log("\n=== Status sync ===");
  for (const r of synced) {
    const msg = r.message ? ` — ${r.message}` : "";
    console.log(`  [${r.action}] ${r.name} (${r.locale} v${r.version})${msg}`);
  }

  const errors = pushed.filter((r) => r.action === "error");
  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) {
      console.error(`  ${e.name} (${e.locale}): ${e.message}`);
    }
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[coworker] submit failed:", error);
    process.exit(1);
  });
