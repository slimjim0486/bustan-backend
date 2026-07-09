import { startMenuImageWorker } from "@/queue/image-generation";
import { startDinerConciergeWorker } from "@/queue/diner-concierge";

async function main() {
  await startMenuImageWorker();
  await startDinerConciergeWorker();
  console.log("pg-boss worker started");
}

main().catch((error) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});
