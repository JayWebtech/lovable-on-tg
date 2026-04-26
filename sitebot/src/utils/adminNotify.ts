import type { Bot, Context } from "grammy";
import { logger } from "./logger.js";

export async function notifyAdmin(bot: Bot<Context>, text: string): Promise<void> {
  const raw = process.env.ADMIN_TELEGRAM_ID?.trim();
  if (!raw) return;
  try {
    await bot.api.sendMessage(raw, text);
  } catch (e) {
    logger.warn("notifyAdmin failed", { err: String(e) });
  }
}
