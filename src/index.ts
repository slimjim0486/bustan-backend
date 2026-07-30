import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

// H10: global BigInt JSON serialization. Without this, any future endpoint
// that returns OrderIntent.paymentAmountMinor will throw `TypeError: Do not
// know how to serialize a BigInt`. Latent prod-500 — fix it once globally.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
import { env } from "@/lib/env";
import { initSentry } from "@/lib/sentry";
import { seedReferenceData } from "@/lib/startup-seed";
import { startAdStudioWorker } from "@/queue/ad-studio-jobs";
import { startWhatsAppRetentionWorker } from "@/queue/whatsapp-retention";
import { startOwnerChatMemoryWorker } from "@/queue/owner-chat-memory";
import { startOwnerWhisperWorker } from "@/queue/owner-whisper";
import { startWeeklyReportWorker } from "@/queue/weekly-report";
import { startProactiveNudgeWorker } from "@/queue/proactive-nudge";
import { startGscSyncWorker } from "@/queue/gsc-sync";
import { startSabtPackWorker } from "@/queue/sabt-pack";
import { startEventStagerWorker } from "@/queue/event-stager";
import { startCompetitorIntelWorker } from "@/queue/competitor-intel";
import { startCoworkerDailyBriefWorker } from "@/queue/coworker-daily-brief";
import { startDraftShipWorker } from "@/queue/draft-ship";
import { adStudioRoute, adStudioPublicRoute } from "@/routes/ad-studio";
import { sabtPackRoute, sabtPackAdminRoute } from "@/routes/sabt-pack";
import { marketPulseRoute } from "@/routes/market-pulse";
import { adminRoute } from "@/routes/admin";
import { analyticsRoute } from "@/routes/analytics";
import { crmRoute } from "@/routes/crm";
import { portfolioRoute } from "@/routes/portfolio";
import { restaurantsRoute } from "@/routes/restaurants";
import { shortLinksRoute } from "@/routes/short-links";
import { supportRoute } from "@/routes/support";
import { subscriptionsRoute } from "@/routes/subscriptions";
import { uploadRoute } from "@/routes/upload";
import { gbpRoute } from "@/routes/gbp";
import { gscRoute } from "@/routes/gsc";
import { seoRoute } from "@/routes/seo";
import { ownerChatRoute } from "@/routes/owner-chat";
import { whatsappWebhooksRoute } from "@/routes/whatsapp-webhooks";
import { metaDataDeletionRoute } from "@/routes/meta-data-deletion";
import { clerkWebhooksRoute } from "@/routes/clerk-webhooks";
import { coworkerRoute } from "@/routes/coworker";
import { coworkerAdminRoute } from "@/routes/coworker-admin";
import { coworkerWebhooksRoute } from "@/routes/coworker-webhooks";
import { inboxRoute } from "@/routes/inbox";
import { autonomyRoute } from "@/routes/autonomy";
import { onboardingRoute } from "@/routes/onboarding";
import { servicesRoute } from "@/routes/services";
import { bookingsRoute } from "@/routes/bookings";

initSentry();

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: [env.FRONTEND_APP_URL, "https://getbustan.com"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.get("/health", (c) => c.json({ ok: true }));
app.route("/api/restaurants", restaurantsRoute);
app.route("/api/admin", adminRoute);
app.route("/api/portfolio", portfolioRoute);
app.route("/api/short-links", shortLinksRoute);
app.route("/api/crm", crmRoute);
app.route("/api/support", supportRoute);
app.route("/api/owner-chat", ownerChatRoute);
app.route("/api/subscriptions", subscriptionsRoute);
app.route("/api/analytics", analyticsRoute);
app.route("/api/upload", uploadRoute);
app.route("/api/webhooks", whatsappWebhooksRoute);
app.route("/api/webhooks", metaDataDeletionRoute);
app.route("/api/webhooks/clerk", clerkWebhooksRoute);
app.route("/api/gbp", gbpRoute);
app.route("/api/gsc", gscRoute);
app.route("/api/seo", seoRoute);
app.route("/api/ad-studio-public", adStudioPublicRoute);
app.route("/api/ad-studio", adStudioRoute);
app.route("/api/sabt-pack", sabtPackRoute);
app.route("/api/admin/sabt-pack", sabtPackAdminRoute);
app.route("/api/market-pulse", marketPulseRoute);
app.route("/api/coworker", coworkerRoute);
app.route("/api/admin/coworker", coworkerAdminRoute);
app.route("/api/webhooks", coworkerWebhooksRoute);
app.route("/api/inbox", inboxRoute);
app.route("/api/autonomy", autonomyRoute);
app.route("/api/onboarding", onboardingRoute);
app.route("/api/services", servicesRoute);
app.route("/api/bookings", bookingsRoute);

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`Bustan backend listening on http://localhost:${info.port}`);
  }
);

seedReferenceData()
  .then(() => {
    console.log("Reference data (badges + dietary tags) seeded");
  })
  .catch((error) => {
    console.error("Reference data seeding failed", error);
  });

startAdStudioWorker()
  .then(() => {
    console.log("pg-boss ad-studio worker started");
  })
  .catch((error) => {
    console.error("pg-boss ad-studio worker failed to start", error);
  });

startWhatsAppRetentionWorker()
  .then(() => {
    console.log("pg-boss whatsapp-retention worker started");
  })
  .catch((error) => {
    console.error("pg-boss whatsapp-retention worker failed to start", error);
  });

startOwnerChatMemoryWorker()
  .then(() => {
    console.log("pg-boss owner-chat-memory worker started");
  })
  .catch((error) => {
    console.error("pg-boss owner-chat-memory worker failed to start", error);
  });

startOwnerWhisperWorker()
  .then(() => {
    console.log("pg-boss owner-whisper worker started");
  })
  .catch((error) => {
    console.error("pg-boss owner-whisper worker failed to start", error);
  });

startWeeklyReportWorker()
  .then(() => {
    console.log("pg-boss weekly-report worker started");
  })
  .catch((error) => {
    console.error("pg-boss weekly-report worker failed to start", error);
  });

startProactiveNudgeWorker()
  .then(() => {
    console.log("pg-boss proactive-nudge worker started");
  })
  .catch((error) => {
    console.error("pg-boss proactive-nudge worker failed to start", error);
  });

startGscSyncWorker()
  .then(() => {
    console.log("pg-boss gsc-sync worker started");
  })
  .catch((error) => {
    console.error("pg-boss gsc-sync worker failed to start", error);
  });

startSabtPackWorker()
  .then(() => {
    console.log("pg-boss sabt-pack worker started");
  })
  .catch((error) => {
    console.error("pg-boss sabt-pack worker failed to start", error);
  });

startEventStagerWorker()
  .then(() => {
    console.log("pg-boss event-stager worker started");
  })
  .catch((error) => {
    console.error("pg-boss event-stager worker failed to start", error);
  });

startCompetitorIntelWorker()
  .then(() => {
    console.log("pg-boss competitor-intel worker started");
  })
  .catch((error) => {
    console.error("pg-boss competitor-intel worker failed to start", error);
  });

startCoworkerDailyBriefWorker()
  .then(() => {
    console.log("pg-boss coworker-daily-brief worker started");
  })
  .catch((error) => {
    console.error("pg-boss coworker-daily-brief worker failed to start", error);
  });

startDraftShipWorker()
  .then(() => {
    console.log("pg-boss draft-ship worker started");
  })
  .catch((error) => {
    console.error("pg-boss draft-ship worker failed to start", error);
  });
