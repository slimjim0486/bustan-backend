# Bustan FAQ

Quick answers to the 35 questions we get most often. For depth on anything below, see the full [Knowledge Base](./KNOWLEDGE_BASE.md).

- **For restaurant owners** evaluating, signing up, or running their account.
- **Plain answers first**, fine print second.
- **Last reviewed:** 14 May 2026.

---

## Getting started

### 1. What is Bustan?
A growth platform for UAE restaurants. We turn your menu into a beautiful public page in about 10 minutes, then help you keep customers via WhatsApp campaigns, AI-generated ads, and built-in SEO tools — all from one dashboard.

### 2. How long does it take to get a live menu?
Most owners go from "sign up" to "page live" in **10–15 minutes**. You upload your existing menu (PDF or photo), our AI extracts everything, you review it, pick a theme, and publish.

### 3. Do I need a credit card to start?
No. Sign up, build your menu, and use the **14-day free Pro trial** without entering payment details. We email a reminder 3 days before the trial ends. If you don't pick a plan after the trial, your page goes private (Draft) — nothing is deleted.

### 4. Do I need a developer or a website already?
No to both. Bustan hosts your page at `getbustan.com/your-restaurant-name`. If you already have a website, you can either replace its menu page with a link to Bustan, or embed our widget (Pro+) inside it.

### 5. Is Bustan only for UAE restaurants?
Today, yes — the product is built for the Gulf market (currency, WhatsApp focus, Dubai-aware insights, UAE PDPL compliance). KSA and wider GCC support is on the roadmap.

---

## Plans & pricing

### 6. How much does Bustan cost?
| Plan | Price | Best for |
|---|---|---|
| **Draft** | Free | Building privately before you launch |
| **Pro** | AED 299.99 / month | One restaurant ready to publish and grow |
| **Portfolio** | AED 499.99 / month flat | 2–10 brands. 3 included, AED 99 / extra brand |
| **Enterprise** | Custom | 4+ brands, white-label, SLAs |

All paid plans include a 14-day free trial of full Pro features.

### 7. What happens at the end of the trial?
- We email you 3 days before the trial ends.
- If you've picked a plan, billing starts on day 15.
- If you haven't, your page reverts to Draft (private). All your data stays.

### 8. Can I cancel anytime?
Yes — *Dashboard → Billing → Manage billing → Cancel*. Your subscription stays active until the end of the period you've paid for. After that, your page becomes Draft. To also delete your data, email `support@getbustan.com`.

### 9. Do you offer refunds?
Fees already paid are non-refundable by default, except where UAE consumer-protection law requires a refund or where we materially reduce features you paid for. Goodwill refunds are handled case-by-case — email support.

### 10. I was on the old "Starter" plan. What now?
Existing Starter subscribers keep their **AED 99 rate locked for 12 months**, then auto-upgrade to Pro with a **3-month 50% discount** (AED 149/mo) before settling at AED 299.99. New signups don't see Starter.

### 11. Can I switch between Pro and Portfolio?
Yes. Upgrade (Pro → Portfolio) is instant with proration. Downgrade (Portfolio → Pro) takes effect at the end of the current cycle so we don't strip features mid-month.

### 12. Are prices in AED? What about VAT?
Yes, all prices and invoices are in AED. VAT (where applicable) is calculated by Stripe at checkout and itemised on every invoice in the billing portal.

---

## Menu, photos, AI

### 13. What file types can I upload for my menu?
PDF (up to 8 pages per upload), JPG, PNG, WebP, or plain text. PDFs work best. If extraction looks off, try a phone photo of the printed menu.

### 14. How accurate is the AI menu extraction?
Very high for clean menus — sections, dish names, and prices are typically 95%+ correct on the first pass. You always review the extracted draft before it commits to your live menu. If something looks wrong, edit inline or re-run extraction.

### 15. Will the AI invent dish names or ingredients?
No. Our extractor only reads what's in your file. Our description writer only uses the dish name and your existing notes — it explicitly does not add ingredients you didn't list. Our dietary tagger flags low-confidence tags for your review.

### 16. How many menu items can I have?
- **Draft:** unlimited (but the menu is private).
- **Pro and Portfolio:** unlimited.

### 17. How many photos can I attach to a dish?
Up to **10 images per item**. The first is the hero shown on cards.

### 18. How does AI dish image generation work?
Click **Generate image** on a dish. Our worker creates a food-photography-style image in 30–60 seconds using Google's Gemini model. You can add a short style modifier ("overhead, slate plate"). Failed generations don't count against your quota.

### 19. What are the monthly AI quotas?
| Feature | Pro | Portfolio |
|---|---|---|
| AI dish images | 300 / month | 300 / month per brand |
| Photo enhancement (your uploads) | 50 / month | 50 / month per brand |
| Sous Chef (diner chat) | 2,000 messages | 2,000 per brand |
| Owner Chat | 200 turns | 200 per brand |
| Ad Studio projects | 20 / month | 20 per brand |
| SEO scorecard | 2 scans / month | 4 per brand |

Quotas reset on the **1st** of every month.

### 20. Are my photos and AI images mine to use?
Yes. You own everything you upload, and AI-generated images are yours to use anywhere — Instagram, print, delivery platforms — for as long as you have an active Bustan account.

---

## Public page & sharing

### 21. What URL do I get?
`getbustan.com/your-restaurant-name`. You pick the slug during onboarding and can change it later — old slugs auto-redirect, so shared links and QR codes keep working.

### 22. Is the public page mobile-friendly?
Yes, mobile-first. Every theme is tested for mobile load times, tap targets, and structured data so it ranks well on Google.

### 23. Can I embed my menu on my own website?
Yes on Pro and Portfolio. Copy the iframe snippet from *Dashboard → Widget* and paste it into your site.

### 24. Can I remove the "Powered by Bustan" footer?
Yes on Pro and Portfolio (toggle in *Appearance → Branding*). On Draft, the footer is non-removable.

### 25. Does my menu support Arabic?
Today, the dashboard and public page render in English. Full Arabic menu fields and an RTL toggle are on the active roadmap — we'll email you when it ships.

### 26. Will my page show up on Google?
Yes — we ship full schema.org markup (`Restaurant`, `Menu`, `AggregateRating`, breadcrumbs), generate a sitemap automatically, and publish an `llms.txt` for AI assistants. Most pages start appearing in Google within 3–14 days of publishing.

---

## WhatsApp & CRM

### 27. Do I need WhatsApp Business to use Bustan?
No, it's optional. Even without connecting, your public page includes a **click-to-WhatsApp** button if you enter a phone number. To unlock the full CRM (inbox, templates, campaigns, ad attribution), connect your WhatsApp Business Account on Pro or Portfolio.

### 28. Who pays Meta for WhatsApp messages?
**You do, directly.** Meta bills your WhatsApp Business Account for messaging (rates vary by country and conversation type — see Meta's pricing page). Bustan does not mark up or take a cut.

### 29. Can I disconnect WhatsApp later?
Yes, instantly — *CRM → Setup → Disconnect*. We immediately zero out the encrypted access token and stop receiving webhooks from Meta. Your number stays yours.

### 30. What if a customer asks to be removed from WhatsApp marketing?
Anyone who replies STOP / UNSUBSCRIBE (or similar) is opted out automatically and permanently. You cannot manually re-opt them — they have to message you again to opt back in.

### 30a. What do I need ready before I can connect WhatsApp?
Five things to have at hand:
1. A **Facebook account** that admins your restaurant's Business Manager (or be ready to create a Business Manager during signup).
2. **A phone number not currently on the consumer WhatsApp app** (delete the consumer account first if it is — Meta needs the number free).
3. Your **brand display name** as it should appear in WhatsApp (e.g., "Karak House Dubai") — Meta enforces display-name rules.
4. **Live access to the phone** during signup — Meta sends a one-time 6-digit code by SMS or voice call.
5. Optional but recommended: complete **business verification** at business.facebook.com first, so you start at Tier 1 (250 recipients/24h) instead of Tier 0 (50).

Full step-by-step in the [Knowledge Base](./KNOWLEDGE_BASE.md#72-connecting-your-whatsapp-business).

### 30b. Which WhatsApp messages does Bustan send automatically vs which do I have to send?
Bustan distinguishes **transactional** (Utility) templates from **marketing** templates:

- **Automatic (Bustan sends them, no action from you):** order received, order accepted (when you tap Accept), order ready (when you tap Mark Ready), order cancelled, new-order alert to your number. These fire from the order lifecycle and don't need marketing opt-in — the customer ordering is consent for the order updates.
- **Manual (you send them, when you choose):** marketing campaigns — Inactive 30, weekend special, new promotion, review request, birthday offer. Only sent to customers who explicitly opted in.

You can't edit the wording of the transactional templates (they're managed centrally for Meta compliance), but you control everything about marketing campaigns — copy, segment, timing.

### 30c. My WhatsApp connection is stuck on "Registering" or templates are stuck on "Pending" — what now?
- **Registering > 10 minutes:** click **Verify number** in *CRM → Setup*. If still red after an hour, disconnect and reconnect — almost always a stale token.
- **Templates pending > 48h:** Meta sometimes queues novel marketing copy. Resubmit with a slight rewording to push it to the front of the queue.
- **Template rejected:** the dashboard shows Meta's reason. Most common is a URL in the body (URLs must live in button components, not body text) or missing example values. Edit and resubmit — no penalty for fixing rejections.

Full troubleshooting list: [§7.11 in the Knowledge Base](./KNOWLEDGE_BASE.md#711-troubleshooting-whatsapp-setup).

---

## WhatsApp compliance — staying out of Meta jail

### 31. Can I just send WhatsApp messages to all my customers?
No. Meta requires explicit **opt-in** before you can send marketing messages, and they actively throttle, demote, or ban numbers that spam. Bustan filters every campaign to opted-in customers only — but it's on you to get the opt-in honestly (form, paper consent, in-conversation Yes). Phone numbers from old POS lists, scraped from groups, or imported from a friend are **not** opt-in.

### 32. How often can I message a customer?
Aim for **≤ 1 marketing message per customer per week**. Two is the upper limit for high-value segments. Daily marketing messages will get your number blocked. Utility messages (booking confirmation, order ready) are separate and don't count against the marketing budget. Bustan enforces a default 24-hour cap on the same template to the same customer so you can't double-fire by accident.

### 33. What is the "quality rating" Meta keeps showing me?
A rolling 7-day score Meta calculates from how customers respond to your messages — blocks, reports, mark-as-spam.
- **Green / High:** trusted sender, keep going.
- **Yellow / Medium:** customers are reporting you. **Pause campaigns immediately.**
- **Red / Low:** at risk of suspension. Stop sending, don't try to push through. Quality recovers from a clean 7 days.

Check it in Meta's WhatsApp Manager. Bustan syncs it from Meta's API and shows it in *CRM → Setup*.

### 34. How many messages can I send per day?
Depends on your **messaging tier**, set by Meta based on quality + history. New verified businesses start at **250 unique recipients / 24h** (Tier 1). The next steps are 1k, 10k, 100k, then unlimited. Tier upgrades are automatic when you sustain volume with high quality — you don't email Meta. Bustan respects your current tier; campaigns that exceed it skip overflow messages rather than failing.

### 35. What's the 24-hour customer-service window?
Once a customer messages you, you can reply with any freeform text for the next 24 hours. After that, you can only restart the conversation with a **pre-approved template**. This is why Bustan ships a template library — and why your inbox shows you which window you're in for each conversation.

### 36. My number got throttled / quality dropped to Yellow. What now?
1. Pause all campaigns immediately.
2. Audit who you sent to — were they all opted in?
3. Send no marketing for **7 days**. Reply only to inbound conversations.
4. Re-warm at **25% of previous volume** and watch quality daily.
5. If it goes Red and you're suspended, appeal in WhatsApp Manager → Support with proof of opt-in.

The full recovery playbook is in the [Knowledge Base](./KNOWLEDGE_BASE.md#710-staying-in-good-standing-with-meta).

---

## Privacy, data, security

### 31. Where is my data stored?
Database on Railway (US, Postgres). Files and images on Cloudflare R2. Auth via Clerk. Payments via Stripe (PCI DSS Level 1). All cross-border transfers use standard contractual clauses per UAE PDPL.

### 32. Do you use my menu data to train AI models?
No. We use Anthropic's commercial Claude API, and per Anthropic's terms your data is not used to train their models. We log usage for billing and abuse-prevention only.

### 33. How do I delete my data?
Email `support@getbustan.com` from your account email. State whether you want full deletion or a specific dataset (e.g., WhatsApp CRM only). We complete eligible deletions within 30 days. Billing records are kept for 7 years per UAE commercial law; anonymised analytics may be retained indefinitely.

---

## Support

### 34. How do I contact support?
Email `support@getbustan.com` — we reply within one business day. Pro and Portfolio users can also chat with us in-app from the dashboard help bubble.

### 35. Where can I see what's coming next?
We share roadmap updates in monthly emails to active accounts. Bigger launches (Arabic support, multi-location ordering, POS sync) get their own announcements.

---

*Can't find your question? Open the full [Knowledge Base](./KNOWLEDGE_BASE.md) or email `support@getbustan.com`.*
