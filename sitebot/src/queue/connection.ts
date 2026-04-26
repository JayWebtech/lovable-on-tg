import { Queue } from "bullmq";
import { parseRedisUrl } from "../utils/redisUrl.js";
import { logger } from "../utils/logger.js";

function connectionOpts() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for BullMQ");
  return parseRedisUrl(url);
}

export const siteBuildQueue = new Queue<import("./types.js").BuildJobData>("site-builds", {
  connection: connectionOpts(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export const paymentTimerQueue = new Queue<import("./types.js").PaymentTimerJobData>(
  "payment-timers",
  {
    connection: connectionOpts(),
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 200 },
    },
  },
);

export async function cancelPaymentTimerJobs(buildId: string): Promise<void> {
  try {
    const j1 = await paymentTimerQueue.getJob(`remind-${buildId}`);
    const j2 = await paymentTimerQueue.getJob(`expire-${buildId}`);
    await j1?.remove();
    await j2?.remove();
  } catch (e) {
    logger.warn("cancelPaymentTimerJobs", { buildId, err: String(e) });
  }
}
