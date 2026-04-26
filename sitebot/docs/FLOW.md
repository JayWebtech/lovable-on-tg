# SiteBot — Complete flow (how it works)

This document describes the **end-to-end behavior** of SiteBot as implemented: what runs where, which systems are called, and how data moves from a Telegram message to a live URL (and optionally a custom domain).

---

## 1. Components (who does what)

| Piece | Role |
|-------|------|
| **Bot process** (`src/bot/index.ts`) | Telegram updates (polling or webhook), user commands, text/callback handlers, **Express** on `HTTP_PORT` for `/health` and `POST /webhook/payment`. |
| **Worker process** (`src/queue/index.ts`) | **BullMQ** consumers: `site-builds` (deploy pipeline) and `payment-timers` (reminders / expiry). |
| **PostgreSQL** | Users, builds, payments — source of truth for status and billing linkage. |
| **Redis** | BullMQ queues, per-user **rate limit** (ZSET sliding window), **Grammy session** storage, optional **Locus JWT cache**. |
| **Anthropic Claude** | Generates single-file HTML from the user prompt (streaming API, assembled to final text). |
| **Locus Checkout** (Pay with Locus) | Creates **checkout sessions**; sends webhooks when a session is paid. |
| **Locus Build** (PaaS at `api.buildwithlocus.com/v1`, or `LOCUS_BUILD_API_BASE`) | Auth exchange → projects → environments → **S3/git-push** services → deployments → optional **domains**. When `LOCUS_API_BASE` is hackathon beta (`beta-api.paywithlocus.com/api`), SiteBot still calls Build on this host. |

Two processes must run in production: **bot** and **worker**. They share the same `.env`, database, and Redis.

---

## 2. High-level lifecycle (standard website build)

```mermaid
sequenceDiagram
  participant U as User (Telegram)
  participant B as SiteBot process
  participant DB as PostgreSQL
  participant R as Redis
  participant C as Locus Checkout
  participant W as Worker process
  participant CL as Claude API
  participant L as Locus Build API
  participant G as Locus Git

  U->>B: Text prompt (not a command)
  B->>R: Rate limit token (if allowed)
  B->>DB: Insert build awaiting_payment + payment pending
  B->>C: POST checkout session (metadata buildId, chatId, …)
  C-->>B: sessionId + checkoutUrl
  B->>DB: Save checkout ids + payment prompt message ids
  B->>R: Schedule remind + expire jobs
  B->>U: Message with Pay button

  U->>C: Pays USDC (hosted checkout)
  C->>B: POST /webhook/payment (signed)
  B->>DB: Confirm payment, build queued, bump user spend
  B->>R: Cancel timer jobs; enqueue site-builds job
  B->>U: Payment confirmed

  W->>DB: Status generating → … → live/failed
  W->>CL: Generate HTML
  W->>L: Create project, env, S3 service
  W->>G: git push bundle (HTML + Node server + Dockerfile)
  W->>L: Create deployment, poll until healthy
  W->>DB: Save site URL, completed_at, expires_at
  W->>U: Live URL + domain upsell button
```

---

## 3. User entry: commands vs. “build me a site”

### Commands (handled first)

- **`/start`** — Ensures a `users` row exists; sends welcome text.  
- **`/help`** — Short usage explanation.  
- **`/status`** — Last five `builds` for this Telegram user (status, prompt snippet, amount, rough age).  
- **`/domain`** — If the user has a **live** build, sets **session** flag `awaitingDomainForBuildId` so the **next text message** is interpreted as a domain query (not a new site prompt).

### Plain text (not starting with `/`)

1. If **`awaitingDomainForBuildId`** is set → **domain name flow** (section 7), not a new paid build.  
2. Otherwise → **new build payment flow** (section 4), if length is **10–500** characters.  
3. Before creating a build, **`consumeBuildRateToken`** runs against Redis (`ratelimit:builds:{telegramId}` sliding ~1 hour, max **`MAX_BUILDS_PER_HOUR`**). If exceeded, the user gets a rate-limit message and **no** row is created.

---

## 4. New build: from prompt to “awaiting payment”

**Handler:** `src/bot/handlers/message.ts`

1. **Upsert user** (`users` by `telegram_id`).  
2. **Insert `builds`** row:  
   - `status = awaiting_payment`  
   - `prompt` = full text  
   - `amount_usdc` = standard price (from env / `PRICES.STANDARD_BUILD`)  
3. **Checkout session** — `src/services/checkout.ts` → `POST {LOCUS_CHECKOUT_API_BASE}/checkout/sessions` with Bearer **`LOCUS_API_KEY`**, body includes:  
   - `amount` (string, e.g. `"1.50"`), `currency: "USDC"`  
   - `metadata`: `buildId`, `telegramId`, **`chatId`** (for notifications in groups), `type: "standard_build"`  
   - `webhookUrl` = `{BOT_PUBLIC_URL}/webhook/payment`  
4. **Update `builds`** with `checkout_session_id`, `checkout_url`.  
5. **Insert `payments`** row: `status = pending`, same session id and amount.  
6. **Reply** in Telegram with HTML formatting and an **inline URL button** (“Pay … USDC”) pointing at `checkout_url`.  
7. **Store** `payment_prompt_chat_id` and `payment_prompt_message_id` on the build (used later by the worker to **edit** status in place).  
8. **Schedule BullMQ delayed jobs** on `payment-timers`:  
   - **`remind`** — delay ≈ half of payment window, capped at 15 minutes (`paymentDelays()`).  
   - **`expire`** — delay = `PAYMENT_TIMEOUT_MINUTES` (default 30).  
   - Stable **`jobId`s** `remind-{buildId}` / `expire-{buildId}` so they can be removed after payment.

**Important:** No Claude call and no Locus deploy happen until payment is confirmed — **checkout session is always created first**.

---

## 5. Payment webhook: confirm, idempotency, queue

**Route:** `POST /webhook/payment` on the bot’s Express app (`src/webhooks/payment.ts`).

1. **Raw body** is read as a buffer (for signature verification).  
2. **Resolve signing secret:** Pay with Locus returns a per-session secret (**`whsec_…`**) in the **create checkout session** API response when `webhookUrl` is set ([docs](https://docs.paywithlocus.com)); SiteBot stores it in **`payments.checkout_webhook_secret`**. The webhook handler loads it by **`X-Session-Id`** header or `data.sessionId` in the JSON body, then falls back to optional **`LOCUS_WEBHOOK_SECRET`** env.  
3. **`verifyWebhookSignature`** (`src/webhooks/paymentVerify.ts`):  
   - **`X-Signature-256`** = `sha256=` + HMAC-SHA256 of the **UTF-8 body** (official).  
   - Else **`x-locus-signature`** (alternate / hackathon shape).  
4. **Parse event** — treats as “paid” if either:  
   - `event === "checkout.session.paid"` (official), or  
   - `type === "payment.confirmed"` (alternate).  
   Extracts `sessionId`, `amount`, `metadata` (`buildId`, `telegramId`, `chatId`, `type`, `domain` for domain flow).  
5. **Idempotency:** if `payments.checkout_session_id` already **`confirmed`**, respond `200` and stop.  
6. If no payment row exists (edge case), **insert** a pending row then **update** to confirmed in one logical path.  
7. **Branch on `metadata.type`:**  
   - **`domain_purchase`** → section 6 / 7 continuation (domain payment).  
   - **Default (`standard_build` or missing type):**  
     - Update **`payments`**: `confirmed`, `confirmed_at`, optional `locus_payment_id`.  
     - Update **`builds`**: `status = queued`, `payment_confirmed_at`, `amount_usdc`.  
     - Update **`users.total_spent_usdc`** (read-modify-write with sanitized amount).  
     - **`cancelPaymentTimerJobs(buildId)`** — removes remind/expire jobs if still queued.  
     - **`siteBuildQueue.add("build", { buildId, telegramId, chatId, messageId, prompt }, { jobId: "build-{buildId}" })`** — duplicate job id is swallowed so double webhooks do not double-build.  
     - **Telegram:** sends “Payment confirmed…” to `metadata.chatId` or `telegramId` (DMs vs groups).

8. Response **`200 { received: true }`** after processing (keep DB work bounded so Locus/webhook providers stay happy).

---

## 6. Worker: `site-builds` job (generate + deploy)

**Processor:** `src/queue/jobs/buildSite.ts` (BullMQ worker concurrency **3**, retries with backoff).

| Step | DB / UX | External |
|------|---------|------------|
| 1 | `builds.status = generating` | — |
| 2 | Edit payment prompt message (or send if no `messageId`) | — |
| 3 | — | **Claude** `generateWebsite(prompt)` with fixed system prompt; retries with backoff on failure → on failure: `builds.failed`, user message “AI generation failed…” |
| 4 | Save `generated_html` | — |
| 5 | `status = deploying`, message “Building and deploying…” | — |
| 6 | — | **Locus JWT** (`auth/exchange`, cached in Redis in `locus.ts`) |
| 7 | — | **`POST /projects`**, **`POST /projects/{id}/environments`**, **`POST /services`** with `source: { type: "s3", rootDir: "." }`, Dockerfile build, `/health`, port 8080 |
| 8 | Write temp dir: `index.html`, `server.js` (reads file), `package.json`, `Dockerfile` | — |
| 9 | — | **`git init` → commit → `git push`** to URL from **`GET /git/remote-url`** (fallback pattern with API key); triggers Locus build |
| 10 | — | **`POST /deployments`**, then **`GET /deployments/{id}`** every **15s** (status callbacks throttled to **~30s** for Telegram edits) |
| 11 | Timeout **10 min** → failed | User notified |
| 12 | **`healthy`** | `builds.status = live`, `site_url`, `completed_at`, `expires_at` (+ `users.total_builds` increment) |
| 13 | — | Final Telegram message with **Open site** URL button and **Buy Custom Domain** (`callback_data: domain:{buildId}`) |

**Insufficient Locus credits (HTTP 402):** build marked failed, **admin** notified (`ADMIN_TELEGRAM_ID`), user sees maintenance-style copy.

---

## 7. Custom domain flow (optional)

### A) Entry points

1. **Inline button** after a live site: `domain:{buildId}` → `src/bot/handlers/callback.ts` sets session and asks for a domain string.  
2. **`/domain`** — finds latest **live** build for the user and sets the same session flag.

### B) Name → availability → registrant wizard → checkout

1. User sends text like `mysite.com`.  
2. **`searchDomains`** (`src/services/locus.ts`) — `GET /domains/check-availability` and optional suggestions.  
3. For each viable option, a short id is stored in Redis (`sitebot:domopt:{id}` → JSON `{ buildId, domain, price }`) with TTL **1 hour**.  
4. User taps **`dsel:{id}`** → callback verifies build is **live** and owned by user, then starts **`startDomainContactWizard`** (`src/bot/domainContactWizard.ts`): **nine** one-message-at-a-time questions (first/last name, email, phone, address, city, state, postal code, country). User may send **`cancel`** to abort.  
5. After the last answer, SiteBot saves **`builds.domain_contact_json`** (registrant payload for Locus), then calls **`createDomainSession`** (metadata includes `type: domain_purchase`, `domain`, `chatId`), inserts a **`payments`** row **pending**, and sends the **Pay** URL for **`PRICE_DOMAIN_BUILD`**.

### C) After domain payment webhook

**Same** `/webhook/payment` handler; when `type === domain_purchase"`, **`handleDomainPaymentConfirmed`** (`src/services/domain.ts`):

- Reads **`builds.domain_contact_json`** (validated shape). If missing (legacy edge case), falls back to optional **`DOMAIN_CONTACT_JSON`** env.  
- Uses **Build API** (same base as auth exchange) + JWT: **`POST /domains/purchase`** with that contact object, polls **`GET /domains/{id}/registration-status`**, then **`POST /domains/{id}/attach`** with the build’s **`locus_service_id`**.  
- Updates **`builds.domain`** and clears **`domain_contact_json`** on success (PII not kept after completion).  
- Notifies user on **`metadata.chatId`** (or Telegram id).

---

## 8. Payment timers (`payment-timers` queue)

**Processor:** `src/queue/jobs/paymentTimers.ts`

| Job name | When it runs | If still `awaiting_payment` |
|----------|----------------|------------------------------|
| **`remind`** | ~15 min (or half window) | Sends “payment link still waiting”; sets `payment_reminder_sent`. |
| **`expire`** | End of payment window | Sets `builds.status = expired`, `payments.status = expired`, notifies user to start again. |

If the user pays in time, webhook calls **`cancelPaymentTimerJobs`** so these jobs are removed if still present.

---

## 9. Background housekeeping

| Concern | Behavior |
|---------|----------|
| **Locus balance** | On bot startup and every **hour**, `GET /billing/balance`; if **&lt; $2**, admin gets a Telegram alert. |
| **Sessions** | Redis-backed; session key = **`String(from.id)`** so behavior is per-user even in groups. |
| **Health** | `GET /health` JSON for Locus / load balancers. |
| **Telegram transport** | If **`TELEGRAM_WEBHOOK_URL`** is set, Telegram updates go to that path via **`webhookCallback`**; otherwise the bot **starts long polling**. |

---

## 10. Data model (mental map)

- **`users`** — one row per Telegram user; aggregates `total_builds`, `total_spent_usdc`.  
- **`builds`** — one row per site attempt; status is the **state machine** (`awaiting_payment` → `queued` → `generating` → `deploying` → `live` | `failed` | `expired`).  
- **`payments`** — one row per checkout session (standard or domain); **`checkout_session_id`** is unique; links to **`build_id`**.

---

## 11. Environment boundaries (quick reference)

| Traffic | Base URL | Credential |
|---------|----------|------------|
| **Checkout** session create / get | `LOCUS_CHECKOUT_API_BASE` or default Pay-with-Locus API | **`LOCUS_API_KEY`** (Bearer) |
| **Build** (projects, deploy, domains, git, billing) | **`LOCUS_BUILD_API_BASE`** or default **`https://api.buildwithlocus.com/v1`** when `LOCUS_API_BASE` is beta / Pay-with-Locus `/api` | **JWT** from **`POST /v1/auth/exchange`** (API key in body; JWT in `Authorization` on subsequent calls) |
| **Checkout webhooks** | Your **`BOT_PUBLIC_URL`** | Verify with **`LOCUS_WEBHOOK_SECRET`** |

---

This file is the canonical **“how it works”** narrative for SiteBot. For install and hackathon setup, see **`README.md`**; for economics positioning, see **`BUSINESS_PLAN.md`**.
