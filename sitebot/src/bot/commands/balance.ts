import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { createCreditSession, PRICES } from "../../services/checkout.js";
import type { SiteBotContext } from "../context.js";
import { logger } from "../../utils/logger.js";

export async function handleBalance(ctx: SiteBotContext): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const tid = BigInt(ctx.from.id);
  const chatId = BigInt(ctx.chat.id);

  const [user] = await db.select({ credits: users.credits }).from(users).where(eq(users.telegramId, tid)).limit(1);
  const credits = user?.credits ?? 0;

  try {
    const { checkoutUrl } = await createCreditSession(tid, chatId, PRICES.STANDARD_BUILD);
    const kb = new InlineKeyboard().url(`🎟️ Buy 1 Credit ($${PRICES.STANDARD_BUILD.toFixed(2)} USDC)`, checkoutUrl);

    await ctx.reply(
      `⚖️ *Your Balance*\n\nBuild Credits: **${credits}**\n\n_1 Credit allows you to generate 1 website. Credits are automatically refunded if a build fails._`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  } catch (e) {
    logger.error("Failed to generate credit session link", { err: String(e) });
    await ctx.reply(`⚖️ *Your Balance*\n\nBuild Credits: **${credits}**\n\n_(Temporarily unable to generate purchase links)_`, { parse_mode: "Markdown" });
  }
}
