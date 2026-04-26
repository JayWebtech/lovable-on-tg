import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { builds } from "../../db/schema.js";
import { PRICES } from "../../services/checkout.js";
import type { SiteBotContext } from "../context.js";

function statusEmoji(status: string): string {
  switch (status) {
    case "live":
      return "✅";
    case "awaiting_payment":
      return "⏳";
    case "queued":
    case "generating":
    case "deploying":
      return "🛠️";
    case "failed":
      return "❌";
    case "expired":
      return "⌛️";
    default:
      return "•";
  }
}

function relTime(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export async function handleStatus(ctx: SiteBotContext): Promise<void> {
  if (!ctx.from) return;
  const tid = BigInt(ctx.from.id);
  const rows = await db
    .select()
    .from(builds)
    .where(eq(builds.telegramId, tid))
    .orderBy(desc(builds.createdAt))
    .limit(5);

  if (rows.length === 0) {
    await ctx.reply("You have no builds yet. Send a short description to start.");
    return;
  }

  const lines = rows.map((b, i) => {
    const em = statusEmoji(b.status);
    const amt = b.amountUsdc ? `$${b.amountUsdc} USDC` : `$${PRICES.STANDARD_BUILD.toFixed(2)} USDC`;
    const urlLine = b.siteUrl ? `\n   ${b.siteUrl}` : "";
    const title = b.prompt.length > 48 ? `${b.prompt.slice(0, 48)}…` : b.prompt;
    return `${i + 1}. ${em} *${b.status.replace(/_/g, " ")}*${urlLine}\n   _"${title}"_ — ${amt} — ${relTime(b.createdAt)}`;
  });

  await ctx.reply(`📊 *Your recent builds:*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" });
}
