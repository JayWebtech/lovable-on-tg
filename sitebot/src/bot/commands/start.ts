import type { SiteBotContext } from "../context.js";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";

export async function handleStart(ctx: SiteBotContext): Promise<void> {
  if (!ctx.from) return;
  ctx.session.domainPurchaseWizard = undefined;
  ctx.session.awaitingDomainForBuildId = undefined;
  const tid = BigInt(ctx.from.id);
  const existing = await db.select().from(users).where(eq(users.telegramId, tid)).limit(1);
  if (existing.length === 0) {
    await db.insert(users).values({
      telegramId: tid,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name,
    });
  }

  await ctx.reply(
    `🚀 *Welcome to SiteBot!*

I build and deploy websites from a single description using AI.

Just send me a message describing your website, like:
• "A landing page for my coffee shop in Lagos"
• "A portfolio site for a photographer"
• "A coming soon page for my fintech startup"

I'll generate it, deploy it, and give you a live URL in minutes.

Commands:
/status — Check your active builds
/help — How to use SiteBot
/domain — Buy a custom domain for your last live site`,
    { parse_mode: "Markdown" },
  );
}
