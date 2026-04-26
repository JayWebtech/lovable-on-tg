import { Redis } from "ioredis";
import { parseRedisUrl } from "./utils/redisUrl.js";
import { logger } from "./utils/logger.js";

let client: Redis | null = null;

export function getRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  if (!client) {
    client = new Redis(parseRedisUrl(url));
    client.on("error", (e: Error) => logger.warn("Redis client error", { err: String(e) }));
  }
  return client;
}
