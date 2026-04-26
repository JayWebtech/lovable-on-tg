import { eq, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { builds } from "../../db/schema.js";
import { getRedis } from "../../redisClient.js";
import { startDomainContactWizard } from "../domainContactWizard.js";
import type { SiteBotContext } from "../context.js";

export async function handleCallbackQuery(ctx: SiteBotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from || !ctx.chat) return;

  if (data.startsWith("domain:")) {
    const buildId = data.slice("domain:".length);
    const tid = BigInt(ctx.from.id);
    const [b] = await db
      .select()
      .from(builds)
      .where(and(eq(builds.id, buildId), eq(builds.telegramId, tid), eq(builds.status, "live")))
      .limit(1);
    if (!b) {
      await ctx.answerCallbackQuery({ text: "This build is not available.", show_alert: true });
      return;
    }
    ctx.session.awaitingDomainForBuildId = buildId;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "What domain would you like? Type a domain name like `mysite.com` or `coolbrand.io`",
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (data.startsWith("dsel:")) {
    const shortId = data.slice("dsel:".length);
    const tid = BigInt(ctx.from.id);
    const raw = await getRedis().get(`sitebot:domopt:${shortId}`);
    if (!raw) {
      await ctx.answerCallbackQuery({ text: "Selection expired. Search again.", show_alert: true });
      return;
    }
    let parsed: { buildId: string; domain: string; price: string };
    try {
      parsed = JSON.parse(raw) as { buildId: string; domain: string; price: string };
    } catch {
      await ctx.answerCallbackQuery({ text: "Invalid selection.", show_alert: true });
      return;
    }

    const [b] = await db
      .select()
      .from(builds)
      .where(and(eq(builds.id, parsed.buildId), eq(builds.telegramId, tid), eq(builds.status, "live")))
      .limit(1);
    if (!b?.locusServiceId) {
      await ctx.answerCallbackQuery({ text: "Build not ready for domains.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    await startDomainContactWizard(ctx, parsed.buildId, parsed.domain);
    return;
  }

  await ctx.answerCallbackQuery();
}
