# SiteBot — AI-powered website builder that lives in Telegram

> **Built for Paygentic Hackathon — Week 4: LocusFounder** (also Week 2: Build with Locus + Week 3: Checkout with Locus)

SiteBot is a production-oriented Telegram bot: users describe a site in plain text, pay **$1.50 USDC** via **Locus Checkout**, and receive a **live URL** after **Claude** generates HTML and **Locus Build** deploys a small Node wrapper. Optional **custom domains** use the same checkout pattern at **$3.00 USDC** (configure via env).

**Full step-by-step flow (components, queues, webhooks, domain path):** [docs/FLOW.md](docs/FLOW.md)

---

## Architecture

```
User (Telegram)
    │ 1. Send prompt
    ▼
SiteBot Bot
    │ 2. Create Checkout session (Pay with Locus)
    ▼
Locus Checkout ──── User pays $1.50 USDC
    │ 3. Webhook: checkout.session.paid (or payment.confirmed)
    ▼
PostgreSQL + BullMQ Worker
    │ 4. Claude generates HTML
    │ 5. Git push bundle → Locus Build (S3/git deploy)
    ▼
User receives live URL (+ optional domain upsell)
```

---

## Business model (per standard build)

| | Approx. USDC |
|---|-----|
| **Price charged** | 1.50 |
| **Locus service** | ~0.25 |
| **Claude** | ~0.05 |
| **Margin** | **~1.20** |

Domain upsell: **$3.00** charged vs ~$1.50 estimated cost → ~**$1.50** incremental margin when purchased.

---

## Locus products used

- **Build with Locus** — auth exchange, projects, environments, `source.type: "s3"` services, deployments, billing balance, domain search/purchase/attach, git-push deploy bundle.  
- **Checkout with Locus (Pay with Locus)** — `POST …/checkout/sessions`, session polling, signed webhooks (`x-signature-256` or `x-locus-signature`).  
- **Cross-track** — same repo demonstrates autonomous “agent business” flow end-to-end.

**API bases**

- **Build / PaaS:** JWT + deploy + domains go to **`https://api.buildwithlocus.com/v1`** (or set `LOCUS_BUILD_API_BASE`). Hackathon **`LOCUS_API_BASE=https://beta-api.paywithlocus.com/api`** is only for beta wallet/checkout; SiteBot still calls Build on `api.buildwithlocus.com/v1` using the same `LOCUS_API_KEY` unless you override `LOCUS_BUILD_API_BASE`.  
- **Checkout:** defaults to `https://api.paywithlocus.com/api` unless `LOCUS_CHECKOUT_API_BASE` is set (often same host as beta hackathon API).

---

## Local development

### Prerequisites

- Node.js **20+**  
- Docker (optional but recommended for Postgres + Redis)

### 1. Clone and install

```bash
cd sitebot
npm install
cp .env.example .env
# Fill TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, LOCUS_API_KEY, BOT_PUBLIC_URL, etc.
```

### 2. Database schema

With Docker Postgres running (`docker compose up -d postgres`):

```bash
export DATABASE_URL=postgresql://sitebot:sitebot_dev@localhost:5432/sitebot
npm run db:migrate
```

That applies, in order, `0000_init.sql` (tables + enums, idempotent), `0001_domain_contact_json.sql`, and `0002_checkout_webhook_secret.sql`.

**If `npm run db:migrate` ever failed with `type "build_status" already exists`:** an old duplicate migration was removed from this repo. If your DB still has a bad row in `drizzle.__drizzle_migrations` pointing at `0001_flimsy_union_jack`, delete that row, then run `npm run db:migrate` again.

Alternative without Drizzle’s migrator:

```bash
psql "$DATABASE_URL" -f src/db/migrations/0000_init.sql
psql "$DATABASE_URL" -f src/db/migrations/0001_domain_contact_json.sql
psql "$DATABASE_URL" -f src/db/migrations/0002_checkout_webhook_secret.sql
```

Or sync schema directly in dev:

```bash
npm run db:push
```

### 3. Run Redis + Postgres + processes

```bash
docker compose up -d redis postgres
npm run dev:bot    # terminal 1 — long polling + /health + webhooks
npm run dev:worker # terminal 2 — BullMQ workers
```

Health check: `GET http://localhost:8080/health`

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `LOCUS_API_KEY` | Locus API key (`claw_*` prod or `claw_dev_*` beta) |
| `LOCUS_API_BASE` | Primary Locus API URL: hackathon beta `https://beta-api.paywithlocus.com/api`, or production Build `https://api.buildwithlocus.com/v1` |
| `LOCUS_BUILD_API_BASE` | Optional. Force Build (JWT, deploy, domains) host; defaults to `api.buildwithlocus.com/v1` when `LOCUS_API_BASE` is beta or `api.paywithlocus.com/api` |
| `LOCUS_CHECKOUT_API_BASE` | Optional; defaults to `https://api.paywithlocus.com/api` |
| `LOCUS_WEBHOOK_SECRET` | Optional **global** HMAC secret. Pay with Locus returns a **`whsec_…`** secret when you create a session with `webhookUrl`; SiteBot saves it per payment. Use this env only if you need one shared secret (e.g. API does not return `webhookSecret`). |
| `BOT_PUBLIC_URL` | Public HTTPS origin of this service (used in `webhookUrl` for Checkout) |
| `REDIS_URL` | BullMQ + rate limits + sessions |
| `DATABASE_URL` | Postgres connection string |
| `ADMIN_TELEGRAM_ID` | Numeric user id for low-balance / failure alerts |
| `PRICE_STANDARD_BUILD` | Default `1.50` |
| `PRICE_DOMAIN_BUILD` | Default `3.00` |
| `MAX_BUILDS_PER_HOUR` | Default `3` |
| `PAYMENT_TIMEOUT_MINUTES` | Default `30` (matches delayed BullMQ jobs) |
| `SITE_EXPIRY_DAYS` | Stored on build when live (cleanup is optional / future cron) |
| `HTTP_PORT` | Default `8080` |
| `TELEGRAM_WEBHOOK_URL` | If set, Telegram updates hit this URL path on the same server |
| `TELEGRAM_WEBHOOK_SECRET` | Optional `secret_token` for `setWebhook` |
| `DOMAIN_CONTACT_JSON` | Optional legacy fallback if a paid domain webhook has no stored registrant JSON (normally users enter 9 fields in chat before checkout) |
| `NODE_ENV`, `LOG_LEVEL` | Standard runtime tuning |

---

## Telegram bot token (BotFather)

1. Open Telegram → chat with **@BotFather** → `/newbot`  
2. Copy the **HTTP API token** into `TELEGRAM_BOT_TOKEN`  
3. For production, set `TELEGRAM_WEBHOOK_URL` to `https://<your-locus-service-host>/<pathname>` matching `scripts/set-webhook.sh` and the Express mount in `src/bot/index.ts`.

---

## Hackathon beta (Paygentic)

1. **Register agent** — `POST https://beta-api.paywithlocus.com/api/register` with JSON `{ "name": "SiteBot", "email": "you@example.com" }` and store `apiKey` / `ownerPrivateKey`.  
2. **Poll** `GET https://beta-api.paywithlocus.com/api/status` with `Authorization: Bearer <apiKey>` until wallet is **deployed**.  
3. **Request credits** — `POST https://beta-api.paywithlocus.com/api/gift-code-requests` with reason + GitHub URL.  
4. **Dashboard** — `https://beta.paywithlocus.com` with signup code **`PAYGENTIC`**.  
5. Point `.env` at beta: `LOCUS_API_BASE=https://beta-api.paywithlocus.com/api` and `claw_dev_*` key. Checkout uses that host; Build calls auto-target `https://api.buildwithlocus.com/v1` (see [Getting Started](https://docs.paywithlocus.com/build/getting-started.md) auth). Override with `LOCUS_BUILD_API_BASE` if Locus changes routing.

---

## Payments (for judges)

1. User sends a non-command text prompt.  
2. SiteBot creates a row in `builds` (`awaiting_payment`) and `payments` (`pending`), then calls **Locus Checkout** `POST /checkout/sessions` with metadata `{ buildId, telegramId, chatId, type }`.  
3. User taps the inline **Pay** button (hosted checkout URL).  
4. Pay with Locus sends a signed webhook to `POST /webhook/payment` on SiteBot (headers include **`X-Signature-256`** and often **`X-Session-Id`**).  
5. SiteBot verifies **HMAC-SHA256** using the **`whsec_…`** secret stored for that checkout session (from the create-session response), or optional **`LOCUS_WEBHOOK_SECRET`**. It marks the payment **confirmed**, moves the build to **queued**, enqueues BullMQ `site-builds`, and cancels reminder timers.  
6. Worker runs Claude → writes `index.html` + Express `server.js` → **git push** to Locus → waits for deployment → sends the live URL.

**No free builds:** nothing is queued until the webhook path confirms payment.

---

## Deploying SiteBot itself to Locus

1. Push this repo to GitHub and replace `YOUR_GITHUB_ORG/sitebot` in `deploy.sh`.  
2. Export required env vars (`LOCUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, …).  
3. Run `./deploy.sh` — it creates project/env/service, sets variables, provisions **Postgres** and **Redis** addons, and triggers a deployment.  
4. **Important:** Locus needs **two processes** for full functionality — the HTTP bot (`node dist/bot/index.js`) and the worker (`node dist/queue/index.js`). Create a second service from the same image/repo with the worker start command, or run both under a process supervisor for demos.

---

## Demo script (~3 minutes)

1. `/start` — read the welcome copy.  
2. Send: *“A landing page for my coffee shop in Lagos with warm colors.”*  
3. Tap **Pay $1.50 USDC** — complete checkout on the hosted page.  
4. Watch status edits on the payment message; worker deploys via Locus.  
5. Open the returned **svc-…** URL; tap **Buy Custom Domain**, answer nine short registrant questions in chat, then pay for the domain in Checkout.

---

## Example conversation

**User:** A single-page portfolio for a Lagos photographer with a gallery and contact form.  
**Bot:** Shows prompt + pay button + build id.  
**User:** Pays via Locus Checkout.  
**Bot:** “Payment confirmed… building…” then live URL with open link + domain upsell.

---

## Scripts

| Script | Role |
|--------|------|
| `npm run dev:bot` | Bot + Express (`/health`, `/webhook/payment`) |
| `npm run dev:worker` | BullMQ workers |
| `npm run build` / `start:*` | Production compile + run |
| `./deploy.sh` | Curl-driven Locus provisioning (edit GitHub repo first) |
| `./scripts/set-webhook.sh` | `setWebhook` after `TELEGRAM_WEBHOOK_URL` is live |

---

## Security & quality checklist (implemented)

- Strict TypeScript (`noImplicitAny` path via `strict` tsconfig).  
- Locus **Build** calls use **JWT** from `POST https://api.buildwithlocus.com/v1/auth/exchange` (cached in Redis), even when `LOCUS_API_BASE` is the hackathon beta URL.  
- **Checkout** calls use the **API key** as Bearer on the Pay-with-Locus base URL.  
- `LOCUS_BUILD_API_BASE` is optional; the default Build host is applied in `locus.ts` when `LOCUS_API_BASE` is a Pay-with-Locus unified `/api` URL.  
- Webhook **signature verification** + **idempotent** payment handling.  
- Generated sites use **filesystem `index.html`**, not string interpolation into JS templates (avoids template-injection footguns).  
- Per-user **sliding-window** rate limit for new builds (Redis ZSET).  
- Worker errors are contained; deployment failures notify the user and log details.

---

## License

Hackathon submission — verify licensing with your org before public reuse.
