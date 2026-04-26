import { getRedis } from "../../redisClient.js";
import { logger } from "../../utils/logger.js";

export class BuildRateLimitError extends Error {
  constructor() {
    super("Build rate limit exceeded");
    this.name = "BuildRateLimitError";
  }
}

const WINDOW_MS = 60 * 60 * 1000;

function maxPerHour(): number {
  const n = Number.parseInt(process.env.MAX_BUILDS_PER_HOUR ?? "3", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/** Sliding window per Telegram user for starting paid builds */
export async function consumeBuildRateToken(telegramId: bigint): Promise<void> {
  try {
    const r = getRedis();
    const key = `ratelimit:builds:${telegramId}`;
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    await r.zadd(key, now, member);
    await r.zremrangebyscore(key, 0, now - WINDOW_MS);
    const count = await r.zcard(key);
    if (count > maxPerHour()) {
      await r.zrem(key, member);
      throw new BuildRateLimitError();
    }
    await r.pexpire(key, WINDOW_MS);
  } catch (e) {
    if (e instanceof BuildRateLimitError) throw e;
    logger.warn("Rate limit Redis failure; allowing request", { err: String(e) });
  }
}
