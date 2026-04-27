import { eq } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { db } from "../../db/index.js";
import { builds, users } from "../../db/schema.js";
import { createCreditSession, PRICES } from "../../services/checkout.js";
import { searchDomains } from "../../services/locus.js";
import { siteBuildQueue } from "../../queue/connection.js";
import { getRedis } from "../../redisClient.js";
import { logger } from "../../utils/logger.js";
import { handleDomainContactWizardMessage } from "../domainContactWizard.js";
import type { SiteBotContext } from "../context.js";

async function upsertUser(ctx: SiteBotContext): Promise<void> {
  if (!ctx.from) return;
  const tid = BigInt(ctx.from.id);
  const rows = await db.select().from(users).where(eq(users.telegramId, tid)).limit(1);
  if (rows.length === 0) {
    await db.insert(users).values({
      telegramId: tid,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name,
    });
  }
}

async function handleDomainNameInput(ctx: SiteBotContext, buildId: string, text: string): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const tid = BigInt(ctx.from.id);
  const [b] = await db.select().from(builds).where(eq(builds.id, buildId)).limit(1);
  if (!b || b.telegramId !== tid || b.status !== "live") {
    ctx.session.awaitingDomainForBuildId = undefined;
    await ctx.reply("That build is not available for domains anymore.");
    return;
  }

  const q = text.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (!q.includes(".")) {
    await ctx.reply("Please send a full domain like `mysite.com`.", { parse_mode: "Markdown" });
    return;
  }

  await ctx.reply("🔎 Searching availability…");
  const results = await searchDomains(q).catch((e) => {
    logger.error("searchDomains", { err: String(e) });
    return [];
  });
  const avail = results.filter((r) => r.available).slice(0, 6);
  if (avail.length === 0) {
    await ctx.reply("No available matches from that query. Try another name or TLD.");
    return;
  }

  const r = getRedis();
  const kb = new InlineKeyboard();
  for (const d of avail) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const price = d.price ?? PRICES.DOMAIN_BUILD.toFixed(2);
    await r.set(
      `sitebot:domopt:${id}`,
      JSON.stringify({ buildId, domain: d.domain, price }),
      "EX",
      3600,
    );
    kb.text(`${d.domain} (~$${price})`, `dsel:${id}`).row();
  }
  ctx.session.awaitingDomainForBuildId = undefined;
  await ctx.reply("Pick an available domain to continue to checkout:", { reply_markup: kb });
}

export async function handleTextMessage(ctx: SiteBotContext): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text || !ctx.from || !ctx.chat) return;
  if (text.startsWith("/")) return;

  await upsertUser(ctx);

  if (await handleDomainContactWizardMessage(ctx, text)) {
    return;
  }

  const pendingBuildId = ctx.session.awaitingDomainForBuildId;
  if (pendingBuildId) {
    await handleDomainNameInput(ctx, pendingBuildId, text);
    return;
  }

  if (text.length < 10 || text.length > 500) {
    await ctx.reply("Please send between 10 and 500 characters describing your site.");
    return;
  }

  await ctx.replyWithChatAction("typing").catch(() => { });

  /*
  try {
    await consumeBuildRateToken(BigInt(ctx.from.id));
  } catch (e) {
    if (e instanceof BuildRateLimitError) {
      await ctx.reply("⏳ You've reached the build limit (3/hour). Try again soon.");
      return;
    }
    throw e;
  }
  */

  const tid = BigInt(ctx.from.id);
  const chatId = BigInt(ctx.chat.id);

  const [userRow] = await db.select({ credits: users.credits }).from(users).where(eq(users.telegramId, tid)).limit(1);
  const credits = userRow?.credits ?? 0;

  if (credits === 0) {
    try {
      const { checkoutUrl } = await createCreditSession(tid, chatId, PRICES.STANDARD_BUILD);
      const payKb = new InlineKeyboard().url(`🎟️ Buy 1 Credit ($${PRICES.STANDARD_BUILD.toFixed(2)} USDC)`, checkoutUrl);

      await ctx.reply(
        `🌐 <b>SiteBot</b>\n\nYour Build Credit balance is <b>0</b>.\n\nPlease purchase a credit to build this site, then send your description again.`,
        { parse_mode: "HTML", reply_markup: payKb }
      );
    } catch (e) {
      logger.error("Failed to generate credit session link", { 
        err: String(e),
        telegramId: String(tid),
        chatId: String(chatId),
        price: PRICES.STANDARD_BUILD
      });
      await ctx.reply(`You don't have any Build Credits, and we couldn't generate a purchase link right now. Try again later.`);
    }
    return;
  }

  await db.update(users).set({ credits: credits - 1 }).where(eq(users.telegramId, tid));

  const [inserted] = await db
    .insert(builds)
    .values({
      telegramId: tid,
      prompt: text,
      status: "queued",
      amountUsdc: "0.00",
      paymentConfirmedAt: new Date(),
    })
    .returning({ id: builds.id });

  const buildId = inserted.id;

  const msg = await ctx.reply(
    `🌐 <b>SiteBot</b>\n\n🎟️ 1 Build Credit consumed.\n\n🔨 Building your site now...\n\n<i>Build ID: ${buildId}</i>\n<i>Remaining Credits: ${credits - 1}</i>`,
    { parse_mode: "HTML" }
  );

  try {
    await siteBuildQueue.add(
      "build",
      {
        buildId,
        telegramId: String(tid),
        chatId: String(chatId),
        messageId: msg.message_id,
        prompt: text,
      },
      { jobId: `build-${buildId}` }
    );
  } catch (e) {
    if (!String(e).includes("duplicate") && !String(e).includes("Duplicate")) {
      throw e;
    }
  }
}
