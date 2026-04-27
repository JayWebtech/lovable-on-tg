import type { RedisOptions } from "ioredis";

export function parseRedisUrl(urlStr: string): RedisOptions {
  const u = new URL(urlStr);
  const dbPath = u.pathname.replace(/^\//, "");
  const db = dbPath ? Number.parseInt(dbPath, 10) : 0;
  return {
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: u.protocol === "rediss:" ? {} : undefined,
    retryStrategy(times: number) {
      return Math.min(times * 200, 5000);
    },
  };
}
