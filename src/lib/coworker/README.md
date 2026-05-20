# Coworker

Sous Chef delivered to restaurant owners over WhatsApp, on Bustan's own WABA.

## What this is

A new **delivery surface**, not a new brain. The brain (OwnerWhisper +
OwnerChatMessage + OwnerChatMemory + OWNER_TOOLS) already exists and powers
the dashboard's Sous Chef dock. The Coworker reuses all of it and adds:

1. A Bustan-owned WhatsApp Business Account (separate from the per-restaurant
   `WhatsAppIntegration` used for customer ordering).
2. 4 utility templates Bustan owns and submits to Meta once: Daily Brief
   (full + lite) × (English + Arabic).
3. A daily fan-out cron that sends the appropriate Daily Brief to each
   enrolled owner.
4. An inbound webhook that routes WhatsApp replies into the existing Sous
   Chef LLM loop.

## Architectural separation

| | Coworker | Customer Ordering |
|---|---|---|
| Meta App | A separate Bustan app | The existing app (Tech Provider review pending) |
| WABA | One — Bustan's (`COWORKER_WABA_ID`) | Many — each restaurant's, via Embedded Signup |
| Templates | Bustan-owned, library defined in `templates.ts` | Per-restaurant `WhatsAppTemplate` |
| Tokens | Single system-user token in env | Per-restaurant `accessTokenCipher` |
| Tech Provider approval needed? | **No** | Yes |

These do NOT share code paths at the Meta layer. `lib/whatsapp-business.ts`
is for ordering; `lib/coworker/meta-client.ts` is for the Coworker. The
duplication is intentional — the auth model and failure modes diverge.

## Runtime gates (in order)

1. `env.COWORKER_ENABLED` — global off switch. When false, the worker never
   starts, send paths short-circuit, and webhooks 200 silently.
2. `env.COWORKER_DRY_RUN` — when true, every send is rerouted to
   `COWORKER_DRY_RUN_PHONE`. The recipient persisted on `CoworkerMessage`
   is the real owner, the actual recipient is the pilot phone. `dryRun=true`
   is set on the row so it's auditable.
3. Per-owner `status` ∈ {`pilot`, `active`, `paused`, `opted_out`} — only
   `pilot` and `active` receive the daily brief.

## Env vars

```
COWORKER_ENABLED=false
COWORKER_DRY_RUN=true
COWORKER_DRY_RUN_PHONE=+9715XXXXXXXX   # required when DRY_RUN=true
COWORKER_WABA_ID=...
COWORKER_PHONE_NUMBER_ID=...
COWORKER_ACCESS_TOKEN=...              # system-user permanent token
COWORKER_WEBHOOK_VERIFY_TOKEN=...      # ≥16 chars, set in Meta webhook config
COWORKER_APP_SECRET=...                # verifies X-Hub-Signature-256
COWORKER_DISPLAY_PHONE=+971...         # what we show owners to save
COWORKER_UTILITY_COST_USD=0.02         # for cost tracking
```

## Day-1 rollout

1. Provision the WhatsApp Business Account + verify the phone number.
2. Set env vars in Railway. Leave `COWORKER_ENABLED=false` initially.
3. Run the migration: `npx prisma migrate deploy`.
4. Flip `COWORKER_ENABLED=true`, keep `COWORKER_DRY_RUN=true`.
5. From admin/coworker: **Sync library → DB**, then **Submit to Meta**.
6. Wait 1–24h for template approvals; click **Sync status** to refresh.
7. Enroll yourself from `/dashboard/coworker` for at least one restaurant.
8. From admin/coworker: **Send brief now** for your enrolment — verify the
   message lands on `COWORKER_DRY_RUN_PHONE`.
9. When happy: flip `COWORKER_DRY_RUN=false`. The 04:00 UTC cron now lands
   briefs at 08:00 GST for every enrolled owner.

## To kill the feature

Flip `COWORKER_ENABLED=false`. That's it:

- Webhook handler 200s without doing anything.
- Send pipeline throws 503 from `requireCredentials()`.
- Cron worker logs `disabled` on start and returns.
- Frontend `/dashboard/coworker` shows a waitlist message instead of the enrol form.
- Admin page still works — operators can inspect templates without sending.

To remove completely: drop the route mounts in `index.ts`, drop the worker
start, drop the migration (only if no data — otherwise leave the tables).

## Key files

```
backend/
  prisma/schema.prisma                          # CoworkerOwner, CoworkerTemplate, CoworkerMessage
  prisma/migrations/.../migration.sql           # migration
  src/lib/env.ts                                # env vars (COWORKER_*)
  src/lib/coworker/
    meta-client.ts                              # Bustan-WABA-scoped Graph API client
    templates.ts                                # 4-template library + validator + renderer
    templates.test.ts                           # 10 unit tests
    README.md                                   # this file
  src/services/coworker/
    template-sync.ts                            # idempotent push + status sync
    daily-brief.ts                              # planner: full vs lite + variable rendering
    daily-brief.test.ts                         # 7 unit tests
    sender.ts                                   # CoworkerMessage write-through send pipeline
    agent.ts                                    # LLM agent (reuses owner-chat tools)
  src/queue/
    coworker-daily-brief.ts                     # 04:00 UTC cron + per-owner send worker
  src/routes/
    coworker.ts                                 # owner-facing enroll/update/optout
    coworker-admin.ts                           # admin templates + pilots + send-now
    coworker-webhooks.ts                        # Meta verification + inbound + status events
  scripts/coworker-submit-templates.ts          # one-shot CLI

frontend/
  app/dashboard/coworker/page.tsx               # owner enroll/status surface
  app/admin/coworker/page.tsx
  components/admin/coworker-admin-page.tsx     # admin templates + pilots dashboard
  lib/api-client.ts                             # apiClient.{getCoworker*, …}
```
