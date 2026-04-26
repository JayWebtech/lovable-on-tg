# SiteBot — One-page business plan

## Problem

Millions of small businesses in West Africa and emerging markets already run sales, support, and community on Telegram. They still need simple websites for credibility, ads, and discovery—but not another dashboard or agency retainer.

## Product

SiteBot is a Telegram-native “agent business”: the user describes a site in plain language, pays in USDC via Locus Checkout, and receives a live HTTPS URL without leaving Telegram. Optional custom domains extend the same flow.

## Target market

- African SMBs and solo founders who live in Telegram groups and DMs  
- Creators, shops, and local services that need a landing page or “link in bio” replacement  
- Crypto-native users comfortable paying in USDC on mobile  

## Distribution moat

Telegram is the acquisition channel: no separate signup funnel, no app store, and viral sharing inside chats. USDC settlement via Locus Checkout matches how crypto-native users already move money.

## Unit economics (per standard build)

| Line item | Approx. USDC |
|-----------|----------------|
| Price to customer | 1.50 |
| Locus Build (service) | ~0.25 |
| Claude API | ~0.05 |
| **Gross margin** | **~1.20** |

Domain upsell at ~$3.00 USDC with ~$1.50 estimated registrar cost yields roughly ~$1.50 incremental margin when the option converts.

## Growth path

- **1,000 builds / month** → ~$1,200 contribution margin from core builds (before domains and support).  
- **10,000 builds / month** → ~$12,000 MRR-equivalent contribution before scaling costs.  
- Upsell attach rate on domains and “renew / refresh” campaigns improves LTV without changing the core SKU.

## Risks and mitigations

- **API / platform cost drift** — monitor Locus balance and Claude token usage per build; tune pricing in one place (`PRICE_*` env vars).  
- **Abuse / spam prompts** — per-user Redis sliding window on new builds; payment still required before any deploy.  
- **Support load** — keep UX copy and `/status` self-serve; route failures to a single admin Telegram ID.

## Why this fits Paygentic / Locus

SiteBot is intentionally multi-track: **Build with Locus** (projects, git-push deploy, domains), **Checkout with Locus** (USDC sessions + webhooks), and **LocusFounder** framing (autonomous acquire → pay → fulfill loop with no human in the loop after the prompt).
