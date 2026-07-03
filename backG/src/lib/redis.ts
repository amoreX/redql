import redis, { Redis } from "ioredis";
const URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export function createRedis(): Redis {
  // factory here cuz pub sub need specia connection
  const c = new Redis(URL, { maxRetriesPerRequest: null });
  c.on("error", (e) => {
    console.error("Redis", e.message);
  });
  return c;
}
