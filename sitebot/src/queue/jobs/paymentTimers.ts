import { eq, and } from "drizzle-orm";
import type { Bot, Context } from "grammy";
import { db } from "../../db/index.js";
import { builds, payments } from "../../db/schema.js";
import { logger } from "../../utils/logger.js";
import type { Job } from "bullmq";
import type { PaymentTimerJobData } from "../types.js";

export function createPaymentTimerProcessor(bot: Bot<Context>) {
  return async (job: Job<PaymentTimerJobData>): Promise<void> => {
    const { buildId } = job.data;
    try {
      const [b] = await db.select().from(builds).where(eq(builds.id, buildId)).limit(1);
      if (!b) return;
      if (b.status !== "awaiting_payment") return;

      const chatId = String(b.paymentPromptChatId ?? b.telegramId);

      if (job.name === "remind") {
        if (b.paymentReminderSent) return;
        await db.update(builds).set({ paymentReminderSent: true }).where(eq(builds.id, buildId));
        await bot.api.sendMessage(
          chatId,
          "⏰ *Your payment link is still waiting!*\n\n_Open the pay button on the message above within your payment window._",
          { parse_mode: "Markdown" },
        );
        return;
      }

      if (job.name === "expire") {
        await db
          .update(builds)
          .set({ status: "expired", errorMessage: "Payment window expired" })
          .where(and(eq(builds.id, buildId), eq(builds.status, "awaiting_payment")));

        await db
          .update(payments)
          .set({ status: "expired" })
          .where(and(eq(payments.buildId, buildId), eq(payments.status, "pending")));

        await bot.api.sendMessage(
          chatId,
          "❌ Payment window expired. Send your prompt again to start a new build.",
        );
      }
    } catch (e) {
      logger.error("paymentTimer job failed", { buildId, err: String(e) });
    }
  };
}
