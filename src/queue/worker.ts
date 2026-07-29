async function main() {
  console.log("No standalone legacy workers are registered.");
}

main().catch((error) => {
  console.error("Worker failed to start", error);
  process.exit(1);
});
