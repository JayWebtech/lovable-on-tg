import { eq, and } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { db } from "../db/index.js";
import { builds, payments } from "../db/schema.js";
import { createDomainSession, PRICES } from "../services/checkout.js";
import type { DomainContact } from "../services/locus.js";
import { logger } from "../utils/logger.js";
import type { SiteBotContext } from "./context.js";
import type { DomainPurchaseWizard } from "./session.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DOMAIN_WIZARD_STEPS: {
  key: keyof DomainContact;
  prompt: string;
  validate: (raw: string) => string | null;
}[] = [
  {
    key: "firstName",
    prompt: "Step *1/9* — Registrant **first name** (as on legal ID):",
    validate: (raw) => {
      const s = raw.trim();
      if (s.length < 1 || s.length > 60) return "Use 1–60 characters.";
      return null;
    },
  },
  {
    key: "lastName",
    prompt: "Step *2/9* — Registrant **last name**:",
    validate: (raw) => {
      const s = raw.trim();
      if (s.length < 1 || s.length > 60) return "Use 1–60 characters.";
      return null;
    },
  },
  {
    key: "email",
    prompt: "Step *3/9* — **Email** for registry notices (e.g. you@domain.com):",
    validate: (raw) => {
      const s = raw.trim();
      if (!EMAIL_RE.test(s)) return "Please send a valid email address.";
      return null;
    },
  },
  {
    key: "phone",
    prompt: "Step *4/9* — **Phone** in international format (e.g. +2348012345678):",
    validate: (raw) => {
      const s = raw.trim().replace(/\s/g, "");
      if (!/^\+?[0-9]{7,20}$/.test(s)) return "Use digits with optional leading + (7–20 digits).";
      return null;
    },
  },
  {
    key: "addressLine1",
    prompt: "Step *5/9* — **Street address** line 1:",
    validate: (raw) => {
      const s = raw.trim();
      if (s.length < 3 || s.length > 120) return "Use 3–120 characters.";
      return null;
    },
  },
  {
    key: "city",
    prompt: "Step *6/9* — **City**:",
    validate: (raw) => {
      const s = raw.trim();
      if (s.length < 1 || s.length > 60) return "Use 1–60 characters.";
      return null;
    },
  },
  {
    key: "state",
    prompt: "Step *7/9* — **State / province / region**:",
    validate: (raw) => {
      const s = raw.trim();
      if (s.length < 1 || s.length > 60) return "Use 1–60 characters.";
      return null;
    },
  },
  {
    key: "postalCode",
    prompt: "Step *8/9* — **Postal or ZIP code**:",
    validate: (raw) => {
      const s = raw.trim();
      if (s.length < 1 || s.length > 15) return "Use 1–15 characters.";
      return null;
    },
  },
  {
    key: "country",
    prompt: "Step *9/9* — **Country** as a *2-letter* ISO code (e.g. NG, US, GB):",
    validate: (raw) => {
      const s = raw.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(s)) return "Send exactly two letters (e.g. NG).";
      return null;
    },
  },
];

function answersToContact(answers: DomainPurchaseWizard["answers"]): DomainContact {
  const a = answers;
  return {
    firstName: a.firstName!,
    lastName: a.lastName!,
    email: a.email!,
    phone: a.phone!.replace(/\s/g, ""),
    addressLine1: a.addressLine1!,
    city: a.city!,
    state: a.state!,
    postalCode: a.postalCode!,
    country: a.country!.toUpperCase(),
  };
}

export async function promptDomainContactStep(ctx: SiteBotContext, stepIndex: number): Promise<void> {
  const step = DOMAIN_WIZARD_STEPS[stepIndex];
  if (!step) return;
  await ctx.reply(step.prompt, { parse_mode: "Markdown" });
}

export async function startDomainContactWizard(
  ctx: SiteBotContext,
  buildId: string,
  domain: string,
): Promise<void> {
  ctx.session.domainPurchaseWizard = {
    buildId,
    domain,
    answers: {},
    stepIndex: 0,
  };
  ctx.session.awaitingDomainForBuildId = undefined;
  await ctx.reply(
    "I'll collect **registrant contact** for the domain registry (9 short questions).\n\nSend *cancel* anytime to abort.",
    { parse_mode: "Markdown" },
  );
  await promptDomainContactStep(ctx, 0);
}

export async function handleDomainContactWizardMessage(
  ctx: SiteBotContext,
  text: string,
): Promise<boolean> {
  const w = ctx.session.domainPurchaseWizard;
  if (!w || !ctx.from || !ctx.chat) return false;

  const tid = BigInt(ctx.from.id);
  const chatId = BigInt(ctx.chat.id);
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === "cancel" || lower === "abort") {
    ctx.session.domainPurchaseWizard = undefined;
    await ctx.reply("Domain purchase cancelled.");
    return true;
  }

  const step = DOMAIN_WIZARD_STEPS[w.stepIndex];
  if (!step) {
    ctx.session.domainPurchaseWizard = undefined;
    return true;
  }

  const err = step.validate(t);
  if (err) {
    await ctx.reply(err);
    return true;
  }

  const value = step.key === "country" ? t.trim().toUpperCase() : t.trim();
  w.answers[step.key] = value;
  w.stepIndex += 1;

  if (w.stepIndex >= DOMAIN_WIZARD_STEPS.length) {
    const contact = answersToContact(w.answers);
    const [b] = await db
      .select()
      .from(builds)
      .where(and(eq(builds.id, w.buildId), eq(builds.telegramId, tid), eq(builds.status, "live")))
      .limit(1);
    if (!b?.locusServiceId) {
      ctx.session.domainPurchaseWizard = undefined;
      await ctx.reply("That site is no longer available for domain purchase.");
      return true;
    }

    try {
      await db
        .update(builds)
        .set({ domainContactJson: JSON.stringify(contact) })
        .where(eq(builds.id, w.buildId));

      const { sessionId, checkoutUrl, webhookSecret } = await createDomainSession(
        w.buildId,
        tid,
        chatId,
        w.domain,
        PRICES.DOMAIN_BUILD,
      );

      await db.insert(payments).values({
        buildId: w.buildId,
        telegramId: tid,
        checkoutSessionId: sessionId,
        checkoutWebhookSecret: webhookSecret?.trim() ?? null,
        amountUsdc: PRICES.DOMAIN_BUILD.toFixed(2),
        status: "pending",
      });

      const kb = new InlineKeyboard().url(
        `💳 Pay $${PRICES.DOMAIN_BUILD.toFixed(2)} USDC for ${w.domain}`,
        checkoutUrl,
      );
      ctx.session.domainPurchaseWizard = undefined;
      await ctx.reply(
        `Details saved. Complete payment for <b>${w.domain}</b>:\n\n<i>Build: ${w.buildId}</i>`,
        { parse_mode: "HTML", reply_markup: kb },
      );
    } catch (e) {
      logger.error("domain wizard checkout", { err: String(e) });
      await db.update(builds).set({ domainContactJson: null }).where(eq(builds.id, w.buildId));
      ctx.session.domainPurchaseWizard = undefined;
      await ctx.reply("Could not start checkout. Try again from your live site’s domain button.");
    }
    return true;
  }

  await promptDomainContactStep(ctx, w.stepIndex);
  return true;
}
