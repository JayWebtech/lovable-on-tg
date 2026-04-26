import "dotenv/config";
import express from "express";
import { Bot, type Context, session, webhookCallback } from "grammy";
import { RedisAdapter } from "@grammyjs/storage-redis";
import { getRedis } from "../redisClient.js";
import { logger } from "../utils/logger.js";
import { notifyAdmin } from "../utils/adminNotify.js";
import { checkBalance } from "../services/locus.js";
import { registerPaymentWebhook } from "../webhooks/payment.js";
import type { SessionData } from "./session.js";
import type { SiteBotContext } from "./context.js";
import { handleStart } from "./commands/start.js";
import { handleHelp } from "./commands/help.js";
import { handleStatus } from "./commands/status.js";
import { handleDomainCommand } from "./commands/domain.js";
import { handleBalance } from "./commands/balance.js";
import { handleTextMessage } from "./handlers/message.js";
import { handleCallbackQuery } from "./handlers/callback.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.error("TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const bot = new Bot<SiteBotContext>(token);

bot.use(
  session({
    initial: (): SessionData => ({}),
    storage: new RedisAdapter({ instance: getRedis() }),
    getSessionKey: (ctx) => (ctx.from?.id === undefined ? undefined : String(ctx.from.id)),
  }),
);

bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("status", handleStatus);
bot.command("domain", handleDomainCommand);
bot.command("balance", handleBalance);
bot.command("buy", handleBalance);

bot.on("callback_query:data", handleCallbackQuery);
bot.on("message:text", handleTextMessage);

async function runBalanceCheck(): Promise<void> {
  try {
    const bal = await checkBalance();
    if (bal < 2) {
      await notifyAdmin(botForAlerts, `⚠️ Locus credit balance is low: $${bal.toFixed(2)} (threshold $2.00).`);
    }
  } catch (e) {
    logger.warn("Balance check skipped", { err: String(e) });
  }
}

void runBalanceCheck();
setInterval(() => void runBalanceCheck(), 60 * 60 * 1000);

const botForAlerts = bot as unknown as Bot<Context>;

const app = express();
const httpPort = Number.parseInt(process.env.HTTP_PORT ?? "8080", 10);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

registerPaymentWebhook(app, bot as unknown as Bot<Context>);

const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim();
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

if (webhookUrl) {
  const pathname = new URL(webhookUrl).pathname.replace(/\/$/, "") || "/";
  app.use(pathname, express.json());
  app.use(
    pathname,
    webhookCallback(bot as unknown as Bot<Context>, "express", { secretToken: webhookSecret }),
  );
  logger.info("Telegram webhook mounted", { pathname });
}

app.listen(httpPort, async () => {
  logger.info(`HTTP listening on ${httpPort}`);
  if (!webhookUrl) {
    await bot.start({
      onStart: (info) => {
        logger.info(`Bot @${info.username} polling…`);
      },
    });
  }
});

async function shutdown(): Promise<void> {
  await bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
