import type { Bot, Context } from "grammy";
import type { Express, Request, Response } from "express";
import type { IncomingHttpHeaders } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { builds, payments, users } from "../db/schema.js";
import { cancelPaymentTimerJobs, siteBuildQueue } from "../queue/connection.js";
import { logger } from "../utils/logger.js";
import { verifyWebhookSignature } from "./paymentVerify.js";
import { handleDomainPaymentConfirmed } from "../services/domain.js";

type PaidMetadata = {
  buildId: string;
  telegramId: string;
  chatId?: string;
  type?: string;
  domain?: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** Session id from `X-Session-Id` header or JSON `data.sessionId` / `data.id` (Pay with Locus webhooks). */
function extractCheckoutSessionId(json: unknown, headers: IncomingHttpHeaders): string | null {
  const xs = headers["x-session-id"];
  const hdrVal = Array.isArray(xs) ? xs[0] : xs;
  if (typeof hdrVal === "string" && hdrVal.trim()) return hdrVal.trim();

  const root = asRecord(json);
  if (!root) return null;
  const data = asRecord(root.data);
  if (!data) return null;
  if (typeof data.sessionId === "string" && data.sessionId.trim()) return data.sessionId.trim();
  if (typeof data.id === "string" && data.id.trim()) return data.id.trim();
  return null;
}

function parsePaidEvent(body: unknown): {
  sessionId: string;
  amountStr: string;
  paymentId?: string;
  metadata: PaidMetadata;
} | null {
  const root = asRecord(body);
  if (!root) return null;

  const official = root.event === "checkout.session.paid";
  const alt = root.type === "payment.confirmed";
  if (!official && !alt) return null;

  const data = asRecord(root.data);
  if (!data) return null;

  const sessionId =
    (typeof data.sessionId === "string" && data.sessionId) ||
    (typeof data.id === "string" && data.id) ||
    "";
  if (!sessionId) return null;

  const amountRaw = data.amount ?? data.amountUsdc;
  const amountStr =
    typeof amountRaw === "number" && Number.isFinite(amountRaw)
      ? amountRaw.toFixed(2)
      : typeof amountRaw === "string"
        ? amountRaw
        : "";

  const metaRaw = asRecord(data.metadata) ?? {};
  const buildId = typeof metaRaw.buildId === "string" ? metaRaw.buildId : "";
  const telegramId = typeof metaRaw.telegramId === "string" ? metaRaw.telegramId : "";
  const typeStr = typeof metaRaw.type === "string" ? metaRaw.type : undefined;

  if (!telegramId || (!buildId && typeStr !== "credit_purchase")) return null;

  const metadata: PaidMetadata = {
    buildId,
    telegramId,
    chatId: typeof metaRaw.chatId === "string" ? metaRaw.chatId : undefined,
    type: typeof metaRaw.type === "string" ? metaRaw.type : undefined,
    domain: typeof metaRaw.domain === "string" ? metaRaw.domain : undefined,
  };

  const paymentId =
    (typeof data.paymentId === "string" && data.paymentId) ||
    (typeof data.paymentTxHash === "string" && data.paymentTxHash) ||
    undefined;

  return { sessionId, amountStr: amountStr || "0.00", paymentId, metadata };
}

function sanitizeAmount(s: string): string {
  return /^\d+(\.\d{1,2})?$/.test(s) ? s : "0.00";
}

async function processPaidEvent(bot: Bot<Context>, parsed: NonNullable<ReturnType<typeof parsePaidEvent>>): Promise<void> {
  const { sessionId, amountStr: rawAmount, paymentId, metadata } = parsed;
  const amountStr = sanitizeAmount(rawAmount);
  const type = metadata.type ?? "standard_build";
  const telegramId = BigInt(metadata.telegramId);
  const chatIdStr = metadata.chatId ?? metadata.telegramId;

  const [existing] = await db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).limit(1);
  if (existing?.status === "confirmed") {
    return;
  }

  if (!existing) {
    logger.warn("Payment row missing for session; creating from webhook", { sessionId });
    await db.insert(payments).values({
      buildId: metadata.buildId || null,
      telegramId,
      checkoutSessionId: sessionId,
      amountUsdc: amountStr,
      status: "pending",
    });
  }

  const [updated] = await db
    .update(payments)
    .set({
      status: "confirmed",
      confirmedAt: new Date(),
      locusPaymentId: paymentId ?? null,
    })
    .where(and(eq(payments.checkoutSessionId, sessionId), eq(payments.status, "pending")))
    .returning();

  if (!updated) {
    const [again] = await db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).limit(1);
    if (again?.status === "confirmed") return;
    logger.error("Could not confirm payment row", { sessionId });
    return;
  }

  if (type === "domain_purchase") {
    await handleDomainPaymentConfirmed(
      bot,
      metadata.buildId,
      metadata.telegramId,
      metadata.domain,
      metadata.chatId ?? metadata.telegramId,
    );
    return;
  }

  if (type === "credit_purchase") {
    const [urow] = await db.select({ totalSpentUsdc: users.totalSpentUsdc, credits: users.credits }).from(users).where(eq(users.telegramId, telegramId));
    const prev = Number(urow?.totalSpentUsdc ?? 0);
    const prevCreds = Number(urow?.credits ?? 0);
    const next = (prev + Number.parseFloat(amountStr)).toFixed(2);
    
    await db.update(users).set({ 
      totalSpentUsdc: next,
      credits: prevCreds + 1,
    }).where(eq(users.telegramId, telegramId));

    await bot.api
      .sendMessage(
        chatIdStr,
        `✅ *Payment confirmed!* $${amountStr} USDC received.\n\n🎟️ You now have **${prevCreds + 1}** Build Credit(s) available!\n\n_Send a description of your site to automatically consume a credit and begin building._`,
        { parse_mode: "Markdown" },
      )
      .catch((e) => logger.warn("credit_purchase telegram failed", { err: String(e) }));
    return;
  }

  const [build] = await db.select().from(builds).where(eq(builds.id, metadata.buildId)).limit(1);
  if (!build) {
    logger.error("Build not found for payment", { buildId: metadata.buildId });
    return;
  }

  await db
    .update(builds)
    .set({
      status: "queued",
      paymentConfirmedAt: new Date(),
      amountUsdc: amountStr,
    })
    .where(eq(builds.id, metadata.buildId));

  const [urow] = await db.select({ totalSpentUsdc: users.totalSpentUsdc }).from(users).where(eq(users.telegramId, telegramId));
  const prev = Number(urow?.totalSpentUsdc ?? 0);
  const next = (prev + Number.parseFloat(amountStr)).toFixed(2);
  await db.update(users).set({ totalSpentUsdc: next }).where(eq(users.telegramId, telegramId));

  await cancelPaymentTimerJobs(metadata.buildId);

  const messageId = build.paymentPromptMessageId ?? 0;
  const chatForJob = String(build.paymentPromptChatId ?? build.telegramId);

  try {
    await siteBuildQueue.add(
      "build",
      {
        buildId: metadata.buildId,
        telegramId: String(build.telegramId),
        chatId: chatForJob,
        messageId,
        prompt: build.prompt,
      },
      { jobId: `build-${metadata.buildId}` },
    );
  } catch (e) {
    if (!String(e).includes("duplicate") && !String(e).includes("Duplicate")) {
      throw e;
    }
  }

  await bot.api
    .sendMessage(
      chatIdStr,
      `✅ *Payment confirmed!* $${amountStr} USDC received.\n\n🔨 Building your site now...\n\n_Build ID: ${metadata.buildId}_`,
      { parse_mode: "Markdown" },
    )
    .catch((e) => logger.warn("post-payment telegram failed", { err: String(e) }));
}

export function registerPaymentWebhook(app: Express, bot: Bot<Context>): void {
  app.post(
    "/webhook/payment",
    express.raw({ type: ["application/json", "application/*+json"] }),
    (req: Request, res: Response) => {
      void handlePaymentRequest(req, res, bot);
    },
  );
}

async function handlePaymentRequest(req: Request, res: Response, bot: Bot<Context>): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const sessionHint = extractCheckoutSessionId(json, req.headers);
  let secret: string | undefined;
  if (sessionHint) {
    const [row] = await db
      .select({ checkoutWebhookSecret: payments.checkoutWebhookSecret })
      .from(payments)
      .where(eq(payments.checkoutSessionId, sessionHint))
      .limit(1);
    secret = row?.checkoutWebhookSecret ?? undefined;
  }
  secret = (secret?.trim() || process.env.LOCUS_WEBHOOK_SECRET?.trim()) ?? undefined;

  // Temporarily bypass signature verification as requested
  if (!secret) {
    logger.warn("Processing webhook without signature verification (secret not found)", { sessionHint: sessionHint ?? "(none)" });
  } else if (!verifyWebhookSignature(raw, req.headers, secret)) {
    logger.warn("Processing webhook despite invalid signature (verification bypassed)");
  }

  const parsed = parsePaidEvent(json);
  if (!parsed) {
    res.status(200).json({ received: true });
    return;
  }

  try {
    await processPaidEvent(bot, parsed);
  } catch (e) {
    logger.error("processPaidEvent failed", { err: String(e) });
  }
  res.status(200).json({ received: true });
}
