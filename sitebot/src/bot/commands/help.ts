import type { SiteBotContext } from "../context.js";

export async function handleHelp(ctx: SiteBotContext): Promise<void> {
  ctx.session.domainPurchaseWizard = undefined;
  await ctx.reply(
    `*How SiteBot works*

1️⃣ Describe your site in one message (10–500 characters).
2️⃣ Tap *Pay* to complete checkout in USDC (Locus Checkout).
3️⃣ After payment confirms, SiteBot generates HTML with Claude, deploys it on Locus Build, and sends you a live URL.

You can add a custom domain after your site is live.

Use /status to see recent builds.`,
    { parse_mode: "Markdown" },
  );
}
