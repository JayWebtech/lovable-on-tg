import { logger } from "./utils/logger.js";

logger.info("🚀 Initializing SiteBot (Bot + Queue Worker)...");

await import("./bot/index.js");
await import("./queue/index.js");


