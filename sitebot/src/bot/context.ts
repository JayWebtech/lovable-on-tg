import type { Context, SessionFlavor } from "grammy";
import type { SessionData } from "./session.js";

/** Context after `session<SessionData>()` middleware */
export type SiteBotContext = Context & SessionFlavor<SessionData>;
