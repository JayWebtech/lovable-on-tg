import { desc, eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { builds } from "../../db/schema.js";
import type { SiteBotContext } from "../context.js";

export async function handleDomainCommand(ctx: SiteBotContext): Promise<void> {
  if (!ctx.from) return;
  const tid = BigInt(ctx.from.id);
  const [last] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.telegramId, tid), eq(builds.status, "live")))
    .orderBy(desc(builds.createdAt))
    .limit(1);

  if (!last) {
    await ctx.reply("You need a live site first. Complete a build, then run /domain again.");
    return;
  }

  ctx.session.domainPurchaseWizard = undefined;
  ctx.session.awaitingDomainForBuildId = last.id;
  await ctx.reply(
    `I'll help you add a domain to your latest live site (_build ${last.id}_).

Reply with a name like \`mysite.com\` or \`brand.io\`, or tap *Buy Custom Domain* on your live-site message.`,
    { parse_mode: "Markdown" },
  );
}
