# Bustan Knowledge Base

The deep reference for everything Bustan does, written so a restaurant owner (or a support agent helping one) can find a clear answer in under 30 seconds.

- **Audience:** UAE restaurant owners, operators, marketing managers, and the diners who land on a restaurant's public Bustan page.
- **Voice:** Plain English, no jargon. Answers tell you *what to do next*.
- **Last reviewed:** 14 May 2026 (Pricing v2).
- **Quick links:** [Plans & pricing](#2-plans--pricing) · [Menu setup](#4-building-your-menu) · [WhatsApp CRM](#7-whatsapp-crm--customer-messaging) · [Billing](#11-billing-trials--cancellation) · [Privacy & data deletion](#12-privacy-data--deletion)

---

## Table of contents

1. [What Bustan is](#1-what-bustan-is)
2. [Plans & pricing](#2-plans--pricing)
3. [Getting started](#3-getting-started)
4. [Building your menu](#4-building-your-menu)
5. [Photos & dish imagery](#5-photos--dish-imagery)
6. [Your public restaurant page](#6-your-public-restaurant-page)
7. [WhatsApp CRM & customer messaging](#7-whatsapp-crm--customer-messaging)
8. [AI assistants (Sous Chef + Owner Chat)](#8-ai-assistants-sous-chef--owner-chat)
9. [Marketing: Ad Studio & Sabt Pack](#9-marketing-ad-studio--sabt-pack)
10. [Getting found: SEO, Google, locations](#10-getting-found-seo-google-locations)
11. [Billing, trials & cancellation](#11-billing-trials--cancellation)
12. [Privacy, data & deletion](#12-privacy-data--deletion)
13. [Portfolio (multi-brand operators)](#13-portfolio-multi-brand-operators)
14. [Troubleshooting & limits](#14-troubleshooting--limits)
15. [Contact & company](#15-contact--company)

---

## 1. What Bustan is

### 1.1 In one sentence
Bustan is a growth platform for UAE restaurants: we turn your menu into a beautiful, hosted public page in about 10 minutes, then keep your customers coming back with WhatsApp campaigns, SEO content, and AI-generated ads — all from one dashboard.

### 1.2 Who Bustan is for
- Independent restaurants and cafés in the UAE that want a professional online menu without hiring a developer.
- Multi-location operators and small portfolios (2–10 brands) that need to manage everything from one place.
- Restaurant marketing managers running WhatsApp, social, and Google Business Profile work for one or several locations.

### 1.3 What's in the box (high level)
- **A hosted public menu page** at `getbustan.com/your-restaurant-name`, optimised for mobile and Google.
- **AI menu extraction** from a PDF, photo, or napkin sketch.
- **AI dish photography** and photo enhancement for items you already shot.
- **A WhatsApp CRM** that connects your real WhatsApp Business number, manages templates, and runs reactivation campaigns.
- **Ad Creative Studio + Sabt Pack** that draft Meta-ready ads and a weekly social bundle for you.
- **SEO scorecard, Google Business Profile, Google Search Console** — everything your local visibility depends on.
- **An embeddable widget, short links, QR codes** to drive offline-to-online traffic.

### 1.4 What Bustan is *not* (today)
- Not a POS or payment terminal. We don't take card payments for the customer's meal.
- Not a delivery aggregator (we don't compete with Talabat/Deliveroo). We help you keep direct customers via WhatsApp.
- Not an Arabic dashboard yet. The owner dashboard is English-first; bilingual menu content and an Arabic public-page toggle are on the roadmap.

---

## 2. Plans & pricing

All paid plans bill in **AED** through Stripe and include a **14-day free trial** of full Pro features. **No credit card is required to start a trial.**

| Plan | Price | What it's for | Brands |
|---|---|---|---|
| **Draft** | Free | Build and preview your menu privately before publishing. | 1 unpublished restaurant |
| **Pro** | AED 299.99 / month | One restaurant that's ready to publish, share, and grow. | 1 brand |
| **Portfolio** | AED 499.99 / month flat | Operators managing a small brand group. | Up to 3 brands; AED 99/month per extra brand |
| **Enterprise** | Custom (from ~AED 1,200/mo) | 4+ brands, white-label, SLAs. Contact us. | Unlimited |

> Source of truth: `frontend/lib/plans.ts`, `backend/src/lib/entitlements.ts`, `docs/pricing/pricing-v2-final.md`.

### 2.1 What's included in each plan

| Feature | Draft | Pro | Portfolio |
|---|:---:|:---:|:---:|
| Hosted public page (`getbustan.com/your-slug`) | Preview only | Yes | Yes (per brand) |
| AI menu extraction from PDF/photo | Yes | Yes | Yes |
| Menu items | Unlimited (draft) | Unlimited | Unlimited |
| AI dish image generation | 10 lifetime | 300 / month | 300 / month per brand |
| Photo enhancement (your own uploads) | 3 / month | 50 / month | 50 / month per brand |
| AI menu insights (full analysis) | 1 / month, basic | 4 / month, full | 4 / month per brand, full |
| Public Sous Chef (diner chat) | — | 2,000 messages / month | 2,000 / month per brand |
| Owner Chat (your AI co-pilot) | — | 200 turns / month | 200 / month per brand |
| Ad Creative Studio projects | — | 20 / month | 20 / month per brand |
| Sabt Pack (weekly 7-post bundle) | — | Yes | Yes (per brand) |
| SEO scorecard | — | 2 / month | 4 / month per brand |
| Google Search Console dashboard | — | Yes | Yes |
| WhatsApp CRM, templates, campaigns | — | Yes | Yes |
| Short links + QR codes | — | Yes | Yes |
| Embeddable widget | — | Yes | Yes |
| Hide "Powered by Bustan" branding | — | Yes | Yes |
| Portfolio dashboard, brand switcher, menu cloning | — | — | Yes |
| Cross-brand analytics | — | — | Yes |

### 2.2 Why we charge AED 299 for Pro
Pro is positioned as a complete operating layer (menu + AI + CRM + ads + SEO) — comparable services bought separately run AED 1,500–3,000 / month in this region. The previous AED 99 "Starter" tier was discontinued in May 2026 because it underpriced the AI variable costs.

### 2.3 What happened to Starter?
- Removed for new signups in May 2026.
- Existing Starter subscribers keep their **AED 99 rate locked for 12 months**, then auto-upgrade to Pro with a **3-month 50% discount** (AED 149/mo for 3 months, then AED 299.99). Existing Starter restaurants are not forced to take any action — we email before each transition step.

### 2.4 The free trial
- **14 days. Full Pro features. No credit card.**
- Starts the moment you create your first restaurant.
- A clear countdown is shown on the dashboard. We email a reminder 3 days before it ends.
- When the trial ends, your public page goes into Draft (read-only on our side until you pick a plan). Your data is never deleted.

### 2.5 VAT and invoicing
- All prices shown on the website and in checkout are in **AED**.
- VAT, where applicable, is calculated and shown in Stripe Checkout and on the receipts Stripe emails after each successful payment.
- Stripe also stores all of your past invoices in the **billing portal** — open it from *Dashboard → Billing*.

---

## 3. Getting started

### 3.1 Creating your account
1. Click **List Your Restaurant** on the homepage.
2. Sign up with email + password (via Clerk). Google sign-in is supported. Email verification happens immediately.
3. You land in the **onboarding wizard** (`/dashboard/onboarding`).

### 3.2 The 6-step onboarding wizard
The wizard is the fastest path to a live menu. Most owners finish in under 15 minutes.

1. **Restaurant basics** — name, cuisine, location, contact phone, and the URL slug you want (e.g., `getbustan.com/zafran-house`).
2. **Upload your menu** — PDF, photo, or text. Our AI extracts every dish in seconds.
3. **Review the extracted menu** — confirm sections, prices, and descriptions. Reject anything that looks wrong.
4. **Pick photos** — accept the photos we pulled from your PDF, upload your own, or let us generate AI dish images.
5. **Choose a theme** — pick from curated themes designed for restaurant pages. You can change this anytime.
6. **Choose your trial** — Pro or Portfolio. Your page goes live the moment the trial starts. No card needed.

### 3.3 What you need before you start
- Your menu in *any* form: PDF works best, but a phone photo of a printed menu also works.
- Your business WhatsApp number (optional, but enables half of Bustan's value — connect it later if you want).
- Your Google Business Profile URL (optional, used by the SEO scorecard).
- Your logo (PNG with transparent background is ideal).

You do **not** need: a developer, a designer, hosting, a domain, or a credit card.

### 3.4 Your URL (the "slug")
- Default: `getbustan.com/your-restaurant-name` (auto-suggested from your business name).
- You can change it once in onboarding and again in *Dashboard → Appearance*. We avoid breaking shared links by keeping old slugs as redirects.
- Reserved words (`admin`, `api`, `dashboard`, etc.) cannot be used.

---

## 4. Building your menu

### 4.1 Importing your menu
The **AI Menu Import** lives at *Dashboard → AI Menu* and also runs inside onboarding. It accepts:

- **PDF menus** (up to 8 pages per upload)
- **Photos** of printed menus (JPG, PNG, WebP)
- **Plain text** (paste from a Word doc)

What we extract automatically:
- Section names in the order they appear
- Dish name
- Description (capped at 140 characters — we summarise long blurbs)
- Price in AED (anything we can't read becomes 0 and is flagged for review)

What we deliberately skip:
- Modifier menus, allergen disclaimers, legal text, "scan to order" instructions, branding boilerplate.

> Tech detail: extraction runs on Claude Sonnet (Anthropic). Failed PDFs fall back to a simpler text parser; you never lose data.

### 4.2 Reviewing the extracted menu
After extraction you land on a review screen:
- Edit any field inline. Saved on blur.
- Drag sections to reorder.
- Delete what you don't want.
- Hit **Import to my menu** when you're happy — that's when it commits to your live menu.

If the AI got something badly wrong, you can **re-run extraction** with a different file. The original draft is kept until you import.

### 4.3 The menu editor (`Dashboard → Menu`)
After import, the editor becomes your everyday workspace.

- Add or remove sections; drag to reorder.
- Add a dish: name, description, price, dietary tags, photo, sold-out toggle, time-limited toggle.
- "Bulk descriptions" button: select items missing descriptions and AI-write them in one click.
- "Tag everything" button: run the dietary tagger across the whole menu.

### 4.4 Dietary tags
Tags are visible to diners on the public page and used by the Sous Chef chat to filter recommendations.

Available tags:
- **Dietary:** vegetarian, vegan, halal
- **Allergens:** contains nuts, contains shellfish, contains soy, contains eggs
- **Dietary needs:** gluten-free, dairy-free, nut-free
- **Heat:** spicy, mild

How the AI suggests tags:
- It reads the dish name, description, and modifiers. It only suggests tags it's at least 50% confident about. Anything below 90% confidence is shown for you to review before going live.
- **You are the source of truth.** AI-suggested dietary tags are not medical advice. Always confirm them with your kitchen before publishing — especially allergens.

### 4.5 AI dish descriptions
Click **Write description** on any dish, or run a bulk job. The writer:
- Uses your restaurant's name, cuisine, and location as context.
- Keeps each description under 180 characters with sensory, Dubai-friendly language.
- **Never invents ingredients** that aren't in the dish name or your notes.

### 4.6 Menu insights (`Dashboard → Menu Insights`)
A 0–100 health score across five pillars:
- **Pricing** — outliers within sections, inconsistencies for your cuisine type
- **Descriptions** — missing or weak (< 20 characters)
- **Structure** — section count, balance, naming clarity
- **Gaps** — staple dishes a customer would expect for your cuisine that you don't have
- **Seasonal** — Dubai-aware suggestions (Ramadan, summer light dishes, tourist season Nov–Mar, National Day)

Each issue comes with a **one-click fix** — adjust price, replace description, add suggested item.

Results are cached for 24 hours per menu version, so you can refresh without re-burning your monthly analysis quota.

### 4.7 Sold-out toggle, time-limited specials, promotions
- **Sold-out toggle** (Pro+): marks an item as 86'd. It greys out on the public page and disappears from Sous Chef recommendations until you toggle it back.
- **Time-limited specials** (Pro+): set a price and an end time. Useful for "lunch special until 3 PM" or "Iftar set 6:00–7:30 PM".
- **Promotions**: highlight specific dishes in the hero of your public page with a custom badge.

### 4.8 Menu item images: how many per dish?
You can attach up to **10 images per menu item**. The first is the hero (used on cards), the rest appear in the dish detail view. Mix uploaded photos and AI-generated ones freely.

---

## 5. Photos & dish imagery

### 5.1 Three ways to get photos on the menu

1. **Pull from your PDF** — when you import a menu PDF, our AI detects photos on the page and matches them to dish names. You confirm the matches in *Dashboard → Menu Photos*.
2. **Upload your own** — drag-and-drop JPG/PNG. We auto-enhance (lighting, background, sharpening) without changing what the dish looks like.
3. **AI-generate** — click **Generate image** on a dish and the worker creates a food-photography-style image in 30–60 seconds.

### 5.2 AI dish image generation
- Powered by Google's Gemini image model.
- Generated at ~1024×1024, square JPEG.
- You can write a short prompt modifier ("on a slate plate", "overhead shot, dark wood") to nudge style.
- If a generation fails or comes back odd, hit **Regenerate** — only successful images count against your monthly quota.

**Monthly caps:** Draft 10 lifetime · Pro 300/month · Portfolio 300/month per brand. Quotas reset on the 1st of every month.

### 5.3 Photo enhancement
For photos you upload yourself. We use deterministic (non-AI) tools — brightness, saturation, background normalisation, sharpening — so the dish stays exactly the dish you served.

Three presets:
- **Clean studio** (default) — neutral background, balanced lighting.
- **Warm natural** — warmer tones, good for breakfasts, breads, comfort food.
- **Lighter background** — bright and airy, good for café and dessert menus.

**Monthly caps:** Draft 3 · Pro 50 · Portfolio 50 per brand.

### 5.4 What we **don't** do to photos
- We don't add or remove food, plates, or ingredients.
- We don't fake a luxury dining environment.
- We don't auto-watermark.

### 5.5 Image rights
- You own everything you upload.
- AI-generated images are yours to use anywhere — on your own website, social, print, delivery apps — for as long as you have an active Bustan account.

---

## 6. Your public restaurant page

### 6.1 What diners see at `getbustan.com/your-slug`
- **Hero**: logo, cover image, restaurant name, cuisine, location, "Open now / Opens at 7 PM" badge, and aggregate Google rating (stars + review count) if your Google Business Profile is connected.
- **Menu**: every section as a tabbed/scrollable group; dish cards with photo, description, price, dietary tags.
- **WhatsApp button**: floating "Order on WhatsApp" CTA, pre-filled with a friendly message when configured.
- **Delivery app buttons**: direct links to your Talabat, Deliveroo, Careem listings if you've added them.
- **"I like it"**: a simple thumbs-up on each dish, used for ranking and not shown publicly.
- **Sous Chef chat** (Pro+): a help bubble that lets diners ask questions about the menu in plain English.
- **Promotions**: featured cards above the menu when active.
- **Similar restaurants**: a small "you might also like" rail using cuisine + location.
- **Powered by Bustan footer**: tasteful link back to us, removable on Pro and Portfolio.

### 6.2 Themes
We ship a small set of curated themes (warm, modern, casual, premium, vibrant). Each is mobile-first. Change at *Dashboard → Appearance → Theme*.

You cannot upload custom CSS today. If you need fully bespoke design, talk to us about Enterprise.

### 6.3 Operating hours and "Open now"
Set day-of-week schedules with split shifts (e.g., 11:00–15:00 and 18:00–23:00) at *Dashboard → Appearance → Hours*. The hero shows:
- **Open now** in green when you're open
- **Closed — Opens at 7 PM** when you're not
- Hours are written to your page's structured data so Google can display them in search results.

### 6.4 Language
Today the public page renders in English. Arabic menu fields and an RTL toggle are on the active roadmap — we'll email you when it ships.

### 6.5 The Powered-by-Bustan footer
- On Draft, the footer is non-removable.
- On Pro and Portfolio, you can toggle it off from *Dashboard → Appearance → Branding*.

### 6.6 Sharing your page
Every restaurant gets a **share kit** in *Dashboard → Launch Kit*:
- A short link: `getbustan.com/r/XXXXXXX` (Pro+).
- A QR code (Pro+).
- An embeddable widget snippet (Pro+).
- Pre-formatted copy for Instagram, WhatsApp, and email.

---

## 7. WhatsApp CRM & customer messaging

WhatsApp is the most important channel in the Gulf. Bustan helps you actually use it — without spending the day copy-pasting into your phone.

### 7.1 Two levels of WhatsApp on Bustan

- **Click-to-WhatsApp (everyone)** — your public page has a "Order on WhatsApp" button that opens a pre-filled message to your number. No setup beyond entering your number in *Appearance*.
- **WhatsApp CRM (Pro+)** — your real **WhatsApp Business Account** connected via Meta's Embedded Signup. Bustan becomes your messaging cockpit: inbox, templates, campaigns, ad attribution.

### 7.2 Connecting your WhatsApp Business

#### Before you start — what you need ready
The Embedded Signup flow takes 5–10 minutes if you have these in hand. Gather them first so you're not jumping between tabs:

- **A Facebook account** that is an **admin on your restaurant's Facebook Business Manager**. If you don't have a Business Manager yet, Meta's flow will let you create one mid-signup — but it's smoother to set it up at [business.facebook.com](https://business.facebook.com) beforehand.
- **A phone number** that is **not already registered on regular WhatsApp**. If your existing restaurant number is on the consumer WhatsApp app, you'll need to delete that WhatsApp account first (Settings → Account → Delete my account in the app). Meta requires the number to be free of any consumer WhatsApp association before it can host a Business Account. **You'll receive a one-time verification code by SMS or voice call to this number** during signup — make sure you can answer it live.
- **A display name** for your business as it should appear in WhatsApp ("Karak House Dubai"). Meta reviews this and applies their display-name rules — no slogans, no "WhatsApp" in the name, must match your actual brand.
- **Business verification** (optional but recommended): completing it at business.facebook.com unlocks Tier 1 messaging limits immediately and avoids the Tier 0 (50 recipients/24h) bottleneck. If you skip it now, you can do it later — Bustan will still let you connect.
- **Your trade licence PDF** ready to upload if Meta asks (they sometimes do during verification). For Bustan customers operating as an FZE or LLC, the licence on file with your bank is usually accepted.

#### Step-by-step — the connection flow
1. Open *Dashboard → CRM → Setup*.
2. Click **Connect WhatsApp**. A popup window opens to Meta's Embedded Signup.
3. **Sign in to Facebook** with the account that admins your Business Manager.
4. **Select or create a Business Manager** for your restaurant.
5. **Select or create a WhatsApp Business Account (WABA)**. Most restaurants pick "Create a new one" the first time. Name it after your brand.
6. **Add a phone number** to the WABA. Enter the restaurant number, choose SMS or voice verification, and enter the 6-digit code Meta sends.
7. **Set your display name** ("Karak House"). Meta checks this against their display-name policy — if it's rejected (rare for clean brand names), you can edit and retry in seconds.
8. **Approve the permissions** Bustan requests: `whatsapp_business_messaging` (send and receive), `whatsapp_business_management` (read templates and message status), and `public_profile` (verify it's really you). These are the three permissions Meta has approved Bustan to ask for as a verified Tech Provider — Bustan never asks for more.
9. The popup closes and you're back in Bustan. Within ~5 seconds the *CRM → Setup* page flips to **✅ Connected** with your phone number and a connection timestamp.

#### What "connected" actually means
At this point Bustan has:
- An **encrypted long-lived token** for your WABA (we never see the plaintext after signup — it's encrypted at rest with a per-environment key).
- Subscribed to your **WhatsApp webhooks** automatically, so incoming customer messages start flowing into the Inbox immediately.
- Registered your phone number for use via **Meta's Cloud API** — this is what lets you message customers without running your own WhatsApp infrastructure.

#### Post-connection checklist
The *CRM → Setup* page shows a small readiness checklist. All three should turn green within an hour:

| Check | What it means | If it's still red |
|---|---|---|
| **Number registered** | Meta has activated your number on the Cloud API | Wait 2–5 min. If still red, click "Verify number" — Meta sometimes needs a second nudge |
| **Webhook subscribed** | We're receiving incoming messages from Meta | Click "Sync now". If still red, disconnect and reconnect — usually a stale token. |
| **Templates synced** | We've pulled the list of templates from your WABA | Click "Sync from Meta" in the Templates tab. First sync after connect can take 30s. |

Once all three are green, your number is **live** — customers can WhatsApp you and you can WhatsApp them within Meta's rules (see [§7.4](#74-message-templates) and [§7.10](#710-staying-in-good-standing-with-meta)).

### 7.3 Who is the "Tech Provider"?
Bustan (Jasmine Entertainment FZE) is the registered Meta **Tech Provider** for your WhatsApp Business Account. We hold encrypted tokens and route messages through Meta's Cloud API. We do **not** become the owner of your number — you keep ownership at all times and can disconnect from *CRM → Setup* in a single click.

### 7.4 Message templates

WhatsApp templates are the only way you're allowed to message a customer *outside* the 24-hour customer-service window (more on that window in [§7.10](#the-24-hour-customer-service-window)). Bustan handles two different kinds of templates and the distinction matters for both compliance and what's automated for you:

| Type | Who sends it | When | Examples on Bustan |
|---|---|---|---|
| **Transactional (Utility)** | Bustan, automatically | When an order event happens | Order received, order accepted, order ready, order cancelled |
| **Marketing** | You, intentionally | When you run a campaign | Inactive winback, weekend special, new promotion, review request, birthday offer |

The CRM → Templates tab shows both groups side by side, with status (`draft`, `pending`, `approved`, `rejected`) synced live from Meta.

#### 7.4a Transactional templates — the messages that send themselves
These are **Utility-category** templates that fire automatically as orders move through their lifecycle. You don't trigger them from the CRM page — the system does, and the customer (or restaurant) receives them in real time. No marketing opt-in required (the customer ordering from you *is* the consent for receiving order updates).

| Template | What it says | Fires when |
|---|---|---|
| **Order received** | "Thanks {{name}}! We received your order {{order_no}} from {{restaurant}}. Total: AED {{total}}. We'll message you as soon as the restaurant confirms." | Customer places a new order on your public menu page |
| **Order accepted** | "Good news! {{restaurant}} accepted your order {{order_no}}. Estimated time: {{minutes}} minutes." | You tap **Accept** on the order in your dashboard |
| **Order ready** | "Your order {{order_no}} from {{restaurant}} is ready. {{pickup or delivery instructions}}" | You tap **Mark Ready** on the order |
| **Order cancelled** | "Your order {{order_no}} was cancelled. Reason: {{reason}}. {{refund line}}" | The order is rejected, expires after 15 min, or fails payment |
| **New order alert** | "New Order {{order_no}} — Customer: {{name}} ({{phone}}). Items: {{summary}}. Total: AED {{total}}. Reply ACCEPT, REJECT, or a number." | Sent **to your restaurant's number** when a new order arrives, with quick-reply buttons |

Important properties of transactional templates:
- **You can't edit the copy.** They're managed centrally by Bustan to keep wording consistent and pre-approved across all restaurants.
- **They need Meta approval per-restaurant** before they can send. Your *CRM → Templates → Transactional* section shows the status for each one. If any are still `pending` or `draft`, hit **Sync from Meta** to refresh — first-time approval usually takes 1–24 hours.
- **Bustan submits them on your behalf.** When you connect your WABA, we automatically submit the five Utility templates for review in your name. You don't have to do anything.
- **They send via Meta's Cloud API**, not via wa.me links. That means delivery + read receipts flow back to the dashboard.

#### 7.4b Marketing templates — the ones you broadcast
These are the campaign templates you'd actually send out from the CRM. Bustan ships a starter library:

| Template | When you'd use it |
|---|---|
| **Inactive 30** | Customer hasn't ordered in 30 days — gentle re-engagement |
| **Weekend special** | Promotes a Thursday/Friday/Saturday offer |
| **New promotion** | Generic launch of a new menu or deal |
| **Review request** | Sent ~24h after an order to ask for a Google review |
| **Birthday offer** | Sent on a customer's saved birthday |

For each marketing template:
- You can **review and customise** the copy before submitting to Meta. Personalisation variables (`{{name}}`, `{{restaurant_name}}`, `{{promotion}}`) are inserted at send time.
- We submit to Meta on your behalf. Approval usually takes a few minutes to a few hours; complex marketing copy can take longer.
- **Rejection reasons** are surfaced in the dashboard. The most common ones (URLs in the body, all-caps shouting, missing example values) are caught by Bustan's policy linter *before* submission so you don't burn approval cycles.
- Resubmit with one click after editing.

Marketing templates can only be sent to **opted-in customers** (see [§7.7](#77-opt-in-and-opt-out)) and respect a per-(customer, template) 24-hour frequency cap that Bustan enforces automatically.

### 7.5 The inbox
Live, real WhatsApp conversations from your number, with:
- Unread counts and a "needs reply" queue.
- Click-to-WhatsApp ad attribution — if a customer came from a Bustan-made Meta ad, you'll see the ad name and creative inline.
- Freeform replies allowed within Meta's 24-hour customer-service window; outside that window you must use a template (we'll prompt you).

### 7.6 Campaigns
Three reactivation playbooks are pre-built:
- **30-day inactive** — sends the "Inactive 30" template to anyone who's gone quiet.
- **Weekend special** — sends to opted-in customers ahead of the weekend.
- **New promotion** — broadcast for a one-off launch.

Each campaign:
- Filters automatically to **opted-in** customers only.
- Respects per-customer frequency caps (so the same person never gets hammered).
- Logs delivery / read / failure status against each recipient.

### 7.7 Opt-in and opt-out
- A customer is **opted-in** if they messaged you first via your CTWA ad or a form, *or* you marked them opted-in based on a paper consent at the table.
- A customer is **opted-out** automatically the moment they reply STOP, UNSUBSCRIBE, or any keyword we recognise.
- **Opt-outs are permanent** in the dashboard. You cannot manually flip a customer back to opted-in — they have to message you to re-opt.
- Consent records (timestamp, source) are stored against every customer and exportable.

### 7.8 Who pays Meta for messages?
**You do.** WhatsApp Business Platform messages are billed directly by Meta to your WhatsApp Business Account. Bustan does not add a markup or take a cut. Pricing is set by Meta and varies by country and conversation type — see Meta's pricing page for the current rates.

### 7.9 Disconnecting WhatsApp
- *CRM → Setup → Disconnect*. We immediately zero out the encrypted access token and stop receiving webhooks from Meta.
- Your historical conversations stay in Bustan unless you request deletion (see [§12](#12-privacy-data--deletion)).

### 7.10 Staying in good standing with Meta

WhatsApp is the highest-leverage channel in the Gulf, and the easiest one to lose. Meta will throttle, demote, or ban numbers that spam. Treat your WhatsApp Business number like your liquor licence — you can't easily get a new one.

#### The short version (read this first)
1. Only message customers who **opted in**. No scraped or purchased lists, ever.
2. Send **fewer, better** messages. ≤1–2 marketing messages per customer per week, never daily.
3. Use **templates** for any first message or marketing outside the 24-hour reply window.
4. Honour **STOP** instantly and permanently. Bustan does this for you.
5. Watch your **quality rating** in Meta's WhatsApp Manager. If it drops to Yellow, pause campaigns immediately.

#### Get opt-in *before* you message
Meta defines opt-in as "the user has explicitly consented to receive messages from this business at this number, by a means they understand." Acceptable opt-in sources, in our order of preference:

- A **form on your website** with a clear "Yes, send me WhatsApp updates from [Restaurant]" checkbox (unchecked by default).
- A **paper consent at the table** ("Add me to the WhatsApp list for offers"), where the customer wrote their number themselves.
- **They messaged you first** through your public-page WhatsApp button or a click-to-WhatsApp ad — that counts as opt-in for the conversation and any messages within Meta's 24h window.
- **In-conversation opt-in**: at the end of a chat, ask "Can we send you Friday specials on WhatsApp?" and wait for a "Yes" before adding them.

**Never acceptable:**
- WhatsApp groups you scraped phone numbers from.
- Customer lists bought, traded, or imported from another platform without re-confirmation.
- A reservation phone number you collected for that booking — that's *not* opt-in for marketing.
- Anyone who said no, replied STOP, or didn't respond.

> **Bustan does this for you:** every campaign automatically filters to customers whose **latest consent record is opt-in**. Opt-outs are permanent in Bustan and cannot be flipped manually — your customer has to message you back to re-opt.

#### Quality rating — Green, Yellow, Red
Meta calculates a rolling quality rating from a 7-day window of customer feedback (blocks, reports, mark-as-spam). You see it in WhatsApp Manager under your phone number.

| Rating | What it means | What you should do |
|---|---|---|
| **Green (High)** | You're a trusted sender. | Keep going. Eligible for tier upgrades. |
| **Yellow (Medium)** | Warning — customers are reporting or blocking you. | Pause marketing campaigns immediately. Audit recipients. |
| **Red (Low)** | At risk of being suspended. | Stop sending. Don't try to push through — that's how numbers get banned. |

Quality drops fast (a single bad campaign can do it) and recovers slowly (typically a week of clean behaviour). **Bustan does not** control your quality rating — Meta does, based on real recipient feedback. Check it daily in WhatsApp Manager when you start running campaigns.

#### Messaging tiers (your daily marketing limit)
Meta caps how many *unique recipients* a number can message in 24 hours, in tiers tied to quality:

| Tier | Unique recipients / 24h | How to reach it |
|---|---|---|
| **Tier 0** (unverified business) | 50 | Verify your business with Meta. |
| **Tier 1** | 250 | Default after business verification. |
| **Tier 2** | 1,000 | Send to ~50% of tier limit with Green/High quality for 7 days. |
| **Tier 3** | 10,000 | Same: send ~50% of Tier 2 with Green for 7 days. |
| **Tier 4** | 100,000 | Same pattern, longer track record. |
| **Tier 5** | Unlimited | Enterprise scale, by request. |

You **don't** ask for a tier upgrade by emailing Meta — it's automatic when you sustain volume + quality. Bustan respects your current tier so it's safe to set up large campaigns: anything beyond your daily tier limit is held back and skipped with status `skipped_tier_cap` rather than failing the whole send.

#### Template categories — get this right
Every template you submit to Meta is categorised:

- **Utility** — order confirmations, booking reminders, status updates, customer-service follow-ups. **Cheapest** per message. Cannot contain promotional or sales language.
- **Marketing** — promotions, new menus, weekend specials, winback offers. **Most expensive** per message. Strictest review.
- **Authentication** — OTPs, login codes. Only relevant for account flows; restaurants almost never use this.

**The mistake that gets templates rejected (or worse, accounts flagged):** submitting a marketing template under the Utility category to save money. Meta detects this in review or after-the-fact, rejects the template, and a repeated offence will downgrade your account.

Bustan's pre-shipped templates (Inactive 30, Weekend Special, New Promotion, Review Request, Birthday Offer) are categorised correctly before submission. If you draft your own templates, **err on the side of Marketing** whenever the message has any sales intent.

#### The 24-hour customer-service window
The single most important rule to understand:

- **A customer messages you** → for the next 24 hours you can reply with **any freeform text**. No template needed.
- **No new message from the customer for 24 hours** → the window closes. You can only message them again using an approved template.

This is why "campaigns" exist: they're the *only* way to legally start a conversation with a customer who hasn't messaged you in the last 24 hours.

In the Bustan inbox, the composer shows you which window you're in for each conversation and prompts you to switch to a template when the window closes.

#### Frequency — how often is too often?
Meta doesn't publish a hard frequency cap, but every Gulf operator we've talked to who got their number throttled was sending **3+ marketing messages per customer per week**. Our recommendation:

- ≤ **1 marketing message per customer per week** is comfortable.
- **2 per week** is the maximum you should push for high-value segments (weekly specials + an event invite).
- **Daily marketing messages will get you blocked.** Don't.
- Utility messages (booking confirmation, order ready) are separate — those are expected and don't count against the marketing budget.

> **Bustan does this for you:** the campaign engine enforces a per-(customer, template) frequency cap (default **24 hours**). The same customer can never receive the same template twice within the window, even if a campaign accidentally targets them twice. We also reserve daily budget against your tier limit before sending so you can't overspend in a single day.

#### What gets your number throttled or blocked
In rough order of severity:

1. Messaging numbers that **did not opt in**. Single biggest cause of bans.
2. **High block/report rate** in a short window. One bad campaign to a stale list is enough.
3. **Daily volume spikes** — going from 50 to 1,000 messages overnight without warming up.
4. **Identical mass messages** with no personalisation, especially with marketing links.
5. **Marketing content** sent through Utility templates.
6. **Promotional content inside Authentication** templates (extremely rare for restaurants but a fast ban).
7. **Sending to disconnected or invalid numbers** repeatedly — Meta interprets this as list hygiene failure.
8. **Reported phishing or impersonation** — Meta is aggressive on consumer protection in the Gulf.

#### If your quality drops to Yellow or Red
1. **Stop all campaigns immediately.** In Bustan: *CRM → Campaigns → Pause all*. Don't try to "push through" — every additional bad message extends recovery.
2. **Audit recent campaigns.** Did you send to a list you weren't sure about? Did you double-up frequency on a segment?
3. **Tighten opt-in source.** Only send to customers who messaged you in the last 30 days, or who explicitly form-opted-in. When in doubt, exclude them.
4. **Wait 7 days** with no marketing sends. Reply only to inbound conversations within the 24h window. Quality recovers from a clean week.
5. **Re-warm gradually.** Start your next campaign at 25% of your previous volume and watch the quality rating daily.
6. **If suspended** (Red → ban): you can appeal in WhatsApp Manager → Support. Have ready: proof of opt-in for your audience, screenshots of the template, and the campaign content. Appeals work but take days.

#### Best practices that compound
- **Personalise**. Even a `{{name}}` variable lowers block rates measurably. Bustan templates support customer name, restaurant name, and recent order item.
- **Send at sensible hours.** UAE business hours, never 02:00–08:00. Friday/Saturday is your prime window.
- **Make the unsubscribe path obvious.** "Reply STOP to unsubscribe." We add this automatically to marketing templates.
- **Use Utility templates where you can.** A "Your order is on the way" message has a near-zero block rate and helps your quality score; a generic "Hi! Visit us!" tanks it.
- **A/B test small before broadcasting.** Send to 100 customers, watch the read/reply rate, then scale.
- **Watch the numbers in Bustan**: *CRM → Campaigns → [campaign]* shows delivered, read, replied, blocked. A blocked rate above 2% is a warning sign.
- **Don't import old lists in one go.** If you have 5,000 phone numbers from your POS, send a small "opt-in confirmation" campaign first to the 500 most recent customers, and only message the ones who reply yes.

#### What Bustan automates vs what's on you

| Safeguard | Bustan | You |
|---|---|---|
| Filter campaigns to opted-in customers only | ✓ | — |
| Auto opt-out on STOP / UNSUBSCRIBE keywords | ✓ | — |
| Per-(customer, template) frequency cap (default 24h) | ✓ | — |
| Daily tier-budget reservation before send | ✓ | — |
| Templates categorised correctly before submission to Meta | ✓ | — |
| Quality-rating sync from Meta API | ✓ (visible in *CRM → Setup*) | — |
| Track delivered / read / replied / blocked per campaign | ✓ | — |
| Get explicit opt-in from every recipient | — | ✓ |
| Decide *who* and *what* to send | — | ✓ |
| Monitor quality rating and pause when it slips | Surfaces it | ✓ Decides |
| Keep marketing frequency reasonable per customer | Hard-caps duplicates; you choose targets | ✓ Strategy |
| Warm-up volume on a new number | — | ✓ |

### 7.11 Troubleshooting WhatsApp setup

Most onboarding issues fall into a handful of buckets. Bustan surfaces the actual error from Meta wherever possible — but here's the field guide for the common ones.

#### Embedded Signup won't complete
- **"This number is already on WhatsApp"** — the phone you're trying to connect is registered on the consumer WhatsApp app. Open the consumer app on the phone that owns the number → Settings → Account → Delete my account. Then retry signup. After deletion, Meta takes ~10 minutes to release the number; wait before retrying.
- **"Your business is not verified"** — you can still connect at **Tier 0** (50 unique recipients per 24h), enough to test. To unlock Tier 1 (250/24h) immediately, complete business verification at [business.facebook.com](https://business.facebook.com) → Security Center → Business verification.
- **Display name was rejected by Meta** — Meta's [display-name guidelines](https://www.facebook.com/business/help/757569725593362) reject names with "WhatsApp" in them, generic terms ("Restaurant", "Cafe" alone), and brand impersonation. Use your actual restaurant brand exactly as it appears on signage. You can edit and retry within the signup popup.
- **Popup keeps redirecting back to login** — your browser is blocking third-party cookies. Allow cookies for `facebook.com` and `business.facebook.com`, then retry. Safari in strict mode is the most common culprit.
- **"Account not eligible for WhatsApp Business"** — usually means the Facebook Business Manager you're signed into doesn't have an admin role for the WABA. Sign in as a Business Manager admin or have one added.

#### Connected, but nothing is working
- **Number stuck on "Registering"** — Meta sometimes needs 5–10 minutes to activate the number on the Cloud API. Wait, then click **Verify number** in *CRM → Setup*. If it's been more than an hour, disconnect and reconnect — usually a stale token.
- **Webhook subscription failing** — means messages a customer sends you aren't reaching Bustan. Click **Re-subscribe** in *CRM → Setup*. If still failing, our team will see the error in monitoring; reach out at `support@getbustan.com` and we'll force-resubscribe from our side.
- **No inbox messages showing up** — confirm webhook is green. Also check that you're looking at the correct restaurant in the brand switcher (Portfolio users): inbox is per-brand. Send a test message from a personal phone to your business number to confirm round-trip.

#### Templates aren't approved
- **All templates stuck on "Draft"** — Bustan hasn't submitted them yet. Click **Sync from Meta** in *CRM → Templates*. For transactional templates, submission happens automatically on connect; if you connected before this feature shipped, reach out to support to backfill.
- **A template is "Pending" for more than 24h** — normal for marketing templates with novel copy; Meta sometimes queues them. If pending past 48h, you can resubmit with a slight rewording to push it back to the front of the queue.
- **Template rejected with `INVALID_FORMAT`** — usually a `{{}}` variable issue: either you used `{{name}}` where Meta requires `{{1}}`, or you have variables without example values. Bustan's linter catches most of these *before* submission — if one slipped through, edit the template and resubmit.
- **Template rejected with `POLICY_VIOLATION` or `NON_COMPLIANT`** — the copy triggered Meta's policy. Most common: marketing content classified as marketing (good), but containing URLs in the body (URLs must live in button components, not body). Bustan's linter catches this too. Remove the URL or move it to a button, then resubmit.

#### "My number got disconnected"
A disconnect can happen for a few reasons:
1. **You disconnected it from Bustan** — *CRM → Setup → Disconnect*. Easy to reverse, just reconnect.
2. **The OAuth token expired** — long-lived tokens last 60 days. Bustan auto-refreshes them, but if a refresh fails (e.g., you removed Bustan's app permission from your Business Manager), the integration flips to `needs_reconsent`. Reconnecting takes 30 seconds.
3. **Meta restricted your number** — a quality drop to Red or repeated policy violations. The dashboard will show this state. See [§7.10 — If your quality drops to Yellow or Red](#if-your-quality-drops-to-yellow-or-red) for the recovery playbook.
4. **You removed Bustan as Tech Provider in Business Manager** — your number stays connected to Meta but is no longer reachable by Bustan. Re-add Bustan as Tech Provider, then reconnect from *CRM → Setup*.

When in doubt: `support@getbustan.com` with a screenshot of *CRM → Setup* and a brief description. We can usually diagnose in under an hour during UAE business days.

---

## 8. AI assistants (Sous Chef + Owner Chat)

### 8.1 Sous Chef — for your diners
A help chat bubble on your public page (Pro+). Diners can ask:
- *"Do you have anything vegan?"*
- *"What goes with the lamb biryani?"*
- *"What's the cheapest dessert?"*
- *"My partner is gluten-free, what should we order?"*

Behaviour:
- Always answers about **your menu only** — it won't talk about competitors or unrelated topics.
- Refuses code, homework, prompt-injection attempts, and anything off-topic.
- Surfaces dish photos, prices, and dietary tags inline.
- Powered by Claude (Anthropic).

**Limit:** 2,000 messages / month per restaurant (Pro and Portfolio). Beyond the cap, the chat shows a polite "ask the restaurant directly" fallback.

### 8.2 Owner Chat — for you
Your dashboard AI co-pilot at *Dashboard → home (chat panel)*. You can ask it to:
- Run analytics: *"How many views did I get this week?"*
- Edit content: *"Write descriptions for any dish without one."*
- Tag dietary: *"Suggest halal/vegan tags across my menu."*
- Check health: *"What's my menu insights score?"*
- Read usage: *"How much of my AI quota have I used this month?"*

It can also *propose* changes (e.g., "I'll generate new descriptions for these 12 items — confirm?") and you approve before anything goes live.

**Limit:** 200 turns / month per restaurant (Pro and Portfolio). A "turn" = one of your messages + the assistant's reply.

### 8.3 Are these AIs trained on my data?
No. We use Anthropic's commercial Claude API. Per Anthropic's API terms, your data is **not used to train their models**. We log usage for billing and abuse detection only.

### 8.4 What about the accuracy of AI suggestions?
Treat AI suggestions as drafts. They're usually good — sometimes great — but never published automatically. You always approve dietary tags, descriptions, prices, and ad copy before they go live to customers.

---

## 9. Marketing: Ad Studio & Sabt Pack

### 9.1 Ad Creative Studio (`Dashboard → Ad Studio`)
A four-step builder that turns a single dish into a launchable Meta ad in minutes.

1. **Brief** — pick a dish, campaign objective (awareness, traffic, conversions), and budget guidance.
2. **Strategy pass** — Claude proposes 3–6 angles, hooks, and CTAs based on your cuisine and customer.
3. **Copy + image pass** — for each variant: headline (under 60 chars), primary text (under 220 chars), CTA, and a 1024×1024 hero image. English and Arabic copy generated together.
4. **Safety pass** — automated checks for compliance language and visual issues; flags shown before you export.

What you can do with the output:
- Export to Meta Ads Manager (CSV + image bundle, with an upload guide).
- Run as a click-to-WhatsApp ad — Bustan attributes inbox replies back to the ad creative.
- Duplicate any past project to remix the brief.

**Limits:**
- Pro: 20 projects / month, 6 variants per project, 50 GPT image generations / month before auto-fallback to Gemini.
- Portfolio: same caps **per brand**.

### 9.2 Sabt Pack — your weekly content drop
Every **Sunday 07:00 GST** (Pro and Portfolio), Bustan generates 7 ready-to-publish social posts for you, automatically.

- 7 different formats and angles (single-dish spotlight, weekly special, behind-the-scenes prompt, etc.).
- Captions in English and Arabic.
- A hero image per post.
- Delivered to your dashboard inbox. You preview, regenerate any you don't like, then download or schedule.

Why it's called *Sabt Pack*: السبت (sabt) means Saturday in Arabic. The content arrives in time for your week-starting Sunday operations meeting.

**Cost cap:** to keep image generation predictable, each weekly run is capped at ~$0.30 of image spend per restaurant; beyond the cap we re-use your existing menu photos rather than generating fresh ones.

### 9.3 Click-to-WhatsApp ads
The fastest revenue path on Bustan: a Meta ad that opens a WhatsApp conversation with your business when tapped.
- Ad Studio drafts the creative.
- WhatsApp CRM (CRM tab) shows attributed replies inline so you know which ad creative produced which customer.
- Available on Pro and Portfolio.

---

## 10. Getting found: SEO, Google, locations

### 10.1 SEO scorecard (`Dashboard → SEO Analysis`)
A 0–100 score across **five pillars**, with the issues blocking each score and a one-click fix where possible.

| Pillar | Weight | What we measure |
|---|---|---|
| Google Business Profile | 25% | Name, address, phone, website, hours, categories, photo count |
| On-page SEO | 20% | Title, meta description, canonical, mobile-friendly, image alt text, page speed |
| Rank grid | 20% | Where you rank across ~100 geo-points for local keywords (e.g., "shawarma JBR") |
| Citations | 20% | Name/address/phone consistency on Google, Talabat, Deliveroo, key directories |
| Reviews | 15% | Count, rating, recency, and whether you reply |

Data sources:
- Apify (Google Maps, rank grid, citations crawl)
- Your connected Google Business Profile
- Your live Bustan menu page

**Caching:** results cached 7 days unless inputs change.

**Limits:** Pro 2 scans / month · Portfolio 4 scans / month per brand.

### 10.2 Google Business Profile (`Dashboard → Google Business`)
Today this is a **self-reported link**: paste your GBP URL and we use it as a reference for the SEO scorecard, review-stars enrichment on your public page, and the citation audit. There's no two-way sync yet — direct GBP API integration is on the medium-term roadmap.

### 10.3 Google Search Console (`Dashboard → Search Console`)
A Pro+ read-only dashboard showing how your Bustan page performs in Google search:
- Impressions, clicks, click-through rate, average position
- Top queries you ranked for in the last 28 days
- Top landing pages

How we get the data: Bustan runs a single shared Google Search Console property and slices it per restaurant by URL path. You don't have to authenticate or configure anything — it works as soon as your page is published and Google has crawled it (usually 3–14 days post-launch).

### 10.4 The locations directory
Public pages at `getbustan.com/locations/[city]/[neighborhood]` group restaurants by area (Dubai → JBR, Marina, Downtown; Abu Dhabi → Saadiyat, Al Reem; Sharjah → Al Majaz, etc.). Restaurants are listed automatically once published.

These pages help search engines understand area-level intent and bring extra organic traffic to every brand on the platform.

### 10.5 Schema.org & rich results
Every public page is shipped with structured data Google can show as rich results:
- `Restaurant` schema (name, address, cuisine, price range, hours)
- `Menu` schema (sections, items with prices)
- `AggregateRating` (your Google rating, when connected)
- `BreadcrumbList`, `LocalBusiness`, image and `hreflang` markers when applicable

### 10.6 llms.txt
Bustan publishes an `llms.txt` at `getbustan.com/llms.txt` so AI assistants can discover the platform and your restaurant. No action required from you.

---

## 11. Billing, trials & cancellation

### 11.1 How billing works
- Payments are handled by **Stripe**. We do not store full card numbers on our servers.
- Your subscription auto-renews monthly on the date your trial ended.
- Receipts are emailed automatically and stored in the Stripe billing portal.

### 11.2 The billing portal
Click **Manage billing** at *Dashboard → Billing*. The Stripe portal lets you:
- Update card on file
- Download every invoice
- Switch plan (Pro ↔ Portfolio)
- Cancel
- Update your billing address (used for VAT)

### 11.3 Switching plans
- **Upgrade** (Pro → Portfolio) takes effect immediately. Stripe prorates the remaining days.
- **Downgrade** (Portfolio → Pro) takes effect at the end of the current cycle. We don't strip features mid-period.

### 11.4 Adding extra brands to Portfolio
Open *Dashboard → Portfolio → Brands → Add brand*. The new brand is billed at **AED 99 / month** and you'll see the line item on your next invoice. Cancel an extra brand any time — the AED 99 drops off at the next billing cycle.

### 11.5 Refunds
Per our [Terms & Conditions](https://getbustan.com/terms) §5.4:
- You can cancel any time. Cancellation stops the renewal — your plan stays active until the end of the cycle you've paid for.
- Fees already paid are **non-refundable** as a default, except where UAE Federal Law No. 15 of 2020 on Consumer Protection (or any other applicable law) requires a refund.
- If we *materially reduce* the functionality you paid for, you can request a pro-rated refund for the unused part of the cycle by emailing support within 14 days of the change.
- Goodwill refunds are handled case-by-case. Email `support@getbustan.com`.

### 11.6 Cancelling
- *Dashboard → Billing → Manage billing → Cancel subscription*, or open the Stripe portal directly.
- Your public page **stays live** until the end of the paid period, then drops back to Draft (private). Nothing is deleted; you can reactivate any time.
- To go further and delete your data, see [§12.3](#123-how-to-request-deletion).

### 11.7 Failed payment
- Stripe auto-retries failed charges over 7 days.
- You'll get email notifications from us and from Stripe.
- After all retries fail, your subscription moves to **paused**. Your page goes Draft. We don't delete anything; you can update your card and reactivate at any time.

### 11.8 Currency
All charges are in **AED**. If your card is in a different currency, your bank converts at their rate; Stripe shows the exact AED amount.

---

## 12. Privacy, data & deletion

The full policy lives at [getbustan.com/privacy](https://getbustan.com/privacy). The summary below is the practical version.

### 12.1 Who controls your data
**Jasmine Entertainment FZE**, registered in Sharjah Publishing City, UAE — the company that operates Bustan. Compliant with UAE Federal Decree-Law No. 45 of 2021 (UAE PDPL) and its Executive Regulations.

### 12.2 What we collect and why

| Category | Why we need it |
|---|---|
| Name, email, password (Clerk) | To create and secure your account |
| Restaurant name, address, hours, contact | To build your public page |
| Menu data (items, descriptions, prices, photos) | To render and improve your menu |
| Payment info (handled by Stripe; we never store card numbers) | To bill the subscription |
| Usage data (IP, browser, pages visited, AI calls) | Diagnostics, abuse prevention, plan-limit enforcement |
| WhatsApp data (numbers, messages, opt-ins) when connected | To run the CRM you opted into |

We **do not** sell your data. We do not show third-party ads on your page or in the dashboard.

### 12.3 How to request deletion
Two paths:
- **Owner-initiated:** email `support@getbustan.com` from the email on your account. State whether you want full account deletion or a specific dataset (e.g., WhatsApp CRM data only).
- **Meta-initiated (WhatsApp users):** if you remove Bustan from your Meta Business account, Meta sends us a signed deletion request and you'll see a reference code at `getbustan.com/data-deletion?code=...`.

What gets deleted (within 30 days):
- Account, restaurant, menu data, AI-generated content
- WhatsApp CRM data (numbers, conversations, templates, message logs, consent records)
- Encrypted Meta access tokens (zeroed immediately on disconnect)

What we keep, and why:
- Billing and tax records: 7 years (UAE commercial law)
- Anonymised analytics: indefinitely (cannot be tied back to you)

### 12.4 Where your data lives
- Database: Railway (US region) — Postgres
- Images and files: Cloudflare R2 (global)
- Frontend: Cloudflare Pages / Workers (edge)
- Auth: Clerk
- Payments: Stripe
- AI: Anthropic, Google (Gemini), OpenAI for some Ad Studio jobs
- WhatsApp: Meta (Cloud API)

We use standard contractual clauses for cross-border transfers per UAE PDPL Art. 22–23.

### 12.5 Your rights under UAE PDPL
Access, rectification, erasure, restriction, portability, objection, and withdrawal of consent. Email `support@getbustan.com` and reference "Data Subject Rights Request". We reply within 30 days (extendable to 90 for complex cases — we'll tell you if it's complex).

---

## 13. Portfolio (multi-brand operators)

For groups managing 2–10 brands from one team.

### 13.1 What you get on Portfolio
- **Brand switcher** in the sidebar — flip context between brands instantly.
- **Menu cloning** — duplicate a menu (or a section) from one brand to another, then tweak prices and copy per brand.
- **Cross-brand analytics** — combined view of traffic, top dishes, WhatsApp engagement.
- **QR generator per brand**, **portfolio-wide SEO scorecard**.
- **Brand-level entitlements** — each brand gets its own image quota, ad quota, etc.

### 13.2 The billing model
- AED 499.99 / month flat for the first **3 brands**.
- **AED 99 / month per extra brand** thereafter.
- Each brand is a separate live restaurant page, with its own menu, photos, WhatsApp CRM connection, and analytics.

### 13.3 Setting up Portfolio
1. Subscribe to Portfolio from *Billing*.
2. *Dashboard → Portfolio → Add brand* for each brand you want to onboard.
3. Each brand goes through its own mini-onboarding (name, URL slug, menu import). You can clone an existing brand's menu to fast-forward.
4. Once you have **3 brands set up**, the Portfolio dashboard, brand switcher, and cross-brand analytics unlock fully. Before that, you have Pro-equivalent features and the Portfolio dashboard shows a "pending setup" state.

### 13.4 Can I move to Portfolio from Pro?
Yes — *Billing → Switch plan → Portfolio*. Your existing brand becomes the first slot in your portfolio. Add new brands from the Portfolio tab.

### 13.5 Can I keep separate logins for each brand's manager?
Yes. Invite users from *Dashboard → Settings → Team* (Portfolio). Owners have admin rights across all brands; managers can be scoped to one brand.

---

## 14. Troubleshooting & limits

### 14.1 "I hit my monthly quota — what happens?"
- **Hard caps** (Ad Studio projects, photo enhancements, dish image generation on Draft, SEO scans): you'll see an upgrade prompt and the action stops until next cycle.
- **Soft caps with fallback** (Ad Studio GPT image generations): we auto-fall back to a cheaper model when you cross the threshold — the project still completes.
- **Sous Chef cap**: Public chat shows a polite "ask the restaurant directly" message until next month or until you upgrade.

Quotas reset on the **1st of every calendar month** (GST).

### 14.2 "My PDF didn't import perfectly"
- Re-run the import — the second pass often catches more.
- Try splitting a long menu into 2–3 separate PDFs (each up to 8 pages) and importing them sequentially.
- For very stylised menus (heavy fonts, photos overlapping text), upload a plain photo from your phone — it sometimes works better than a designed PDF.

### 14.3 "My AI-generated dish image looks weird"
- Hit **Regenerate** with a different prompt modifier (e.g., add "overhead shot on slate", "side view on dark wood"). Only successful generations count against your quota.
- If you're never happy, upload your own photo and use *Photo enhancement* instead.

### 14.4 "Sous Chef said something wrong about my menu"
- It only knows what's in your live menu. Update the dish (description, dietary tags) and the answer changes immediately on the next question — there's no separate "training" step.
- If you spot a hallucination (a dish or ingredient that isn't on your menu), report it from the chat itself via the flag icon.

### 14.5 "I can't connect WhatsApp"
- You must own a Meta Business Manager and have a verified WhatsApp Business Account.
- Make sure your business phone number is **not** already active on the consumer WhatsApp app. If it is, move it to WhatsApp Business or use a fresh number.
- During Embedded Signup, ensure you tick "Manage your WhatsApp Business Account" and "Send and receive messages via WhatsApp".
- If you still hit a wall, email `support@getbustan.com` with screenshots.

### 14.6 "My page won't go live"
- Check *Dashboard → Appearance → Publish status* is set to **Published**.
- Confirm your trial hasn't ended and a plan is selected (or trial is still running).
- Slug conflicts: if the slug you want is reserved (e.g., `admin`), the page won't publish. Change the slug.

### 14.7 "I want to change my URL slug after launch"
Yes — *Dashboard → Appearance → URL*. Your old slug becomes a redirect, so existing QR codes and shared links keep working.

### 14.8 "Where do I find my API keys / webhook URL?"
We don't expose a public REST API to customers today. If you need an integration, talk to us about Enterprise.

---

## 15. Contact & company

- **Support:** [support@getbustan.com](mailto:support@getbustan.com) — we respond within one business day.
- **Privacy / data subject requests:** same email, subject line "Data Subject Rights Request".
- **Sales / Enterprise:** same email, subject line "Enterprise enquiry".
- **WhatsApp:** open *Dashboard → ?* in the corner for in-app chat (Pro+).

**Legal entity:** Jasmine Entertainment FZE — Sharjah Publishing City, United Arab Emirates. Bustan is a trading name of Jasmine Entertainment FZE.

**Hosting & infra:**
- Frontend: Cloudflare Pages / Workers (edge)
- Backend: Railway (US, Postgres)
- Object storage: Cloudflare R2
- Auth: Clerk
- Payments: Stripe
- AI: Anthropic (Claude), Google (Gemini), OpenAI (Ad Studio image gen)

**Status & incidents:** if the platform is down, we communicate via email to all active users and post updates from the dashboard banner.

---

*Last reviewed 2026-05-14. This document supersedes any earlier "Help & FAQ" content. If you spot anything wrong, email support and we'll fix it.*
