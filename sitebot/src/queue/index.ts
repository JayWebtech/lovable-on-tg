import "dotenv/config";
import { Bot, type Context } from "grammy";
import { Worker } from "bullmq";
import { parseRedisUrl } from "../utils/redisUrl.js";
import { logger } from "../utils/logger.js";
import { createBuildProcessor } from "./jobs/buildSite.js";
import { createPaymentTimerProcessor } from "./jobs/paymentTimers.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.error("TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  logger.error("REDIS_URL missing");
  process.exit(1);
}

const connection = parseRedisUrl(redisUrl);
const bot = new Bot<Context>(token);

const buildWorker = new Worker("site-builds", createBuildProcessor(bot), {
  connection,
  concurrency: 3,
});

const timerWorker = new Worker("payment-timers", createPaymentTimerProcessor(bot), {
  connection,
  concurrency: 2,
});

buildWorker.on("failed", (j, e) => logger.error("build job failed", { id: j?.id, err: String(e) }));
timerWorker.on("failed", (j, e) => logger.error("timer job failed", { id: j?.id, err: String(e) }));

logger.info("SiteBot workers listening");

async function shutdown(): Promise<void> {
  await buildWorker.close();
  await timerWorker.close();
  await bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
