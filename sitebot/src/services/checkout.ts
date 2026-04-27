import axios, { type AxiosInstance } from "axios";
import { logger } from "../utils/logger.js";

export const PRICES = {
  STANDARD_BUILD: Number.parseFloat(process.env.PRICE_STANDARD_BUILD ?? "1.50"),
  DOMAIN_BUILD: Number.parseFloat(process.env.PRICE_DOMAIN_BUILD ?? "3.00"),
} as const;

function checkoutBase(): string {
  const fromEnv = process.env.LOCUS_CHECKOUT_API_BASE?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const buildBase = (process.env.LOCUS_API_BASE ?? "").toLowerCase();
  if (buildBase.includes("paywithlocus.com") || buildBase.includes("beta-api.paywithlocus")) {
    return (process.env.LOCUS_API_BASE ?? "").replace(/\/$/, "");
  }
  return "https://api.paywithlocus.com/api";
}

function client(): AxiosInstance {
  const apiKey = process.env.LOCUS_API_KEY;
  if (!apiKey) throw new Error("LOCUS_API_KEY is required for checkout");
  return axios.create({
    baseURL: checkoutBase(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 30_000,
    validateStatus: () => true,
  });
}

function extractWebhookSecret(d: Record<string, unknown>): string | undefined {
  for (const k of ["webhookSecret", "webhook_secret", "signingSecret", "signing_secret"] as const) {
    const v = d[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export type CreateCheckoutSessionResult = {
  sessionId: string;
  checkoutUrl: string;
  /** Present when Pay with Locus returns a signing secret for this session (`whsec_…`). */
  webhookSecret?: string;
};

function unwrapSessionPayload(data: unknown): CreateCheckoutSessionResult {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (o.success === true && o.data && typeof o.data === "object") {
      const d = o.data as Record<string, unknown>;
      const id = typeof d.id === "string" ? d.id : "";
      const url =
        (typeof d.checkoutUrl === "string" ? d.checkoutUrl : undefined) ??
        (typeof d.url === "string" ? d.url : "");
      if (id && url) {
        return { sessionId: id, checkoutUrl: url, webhookSecret: extractWebhookSecret(d) };
      }
    }
    const id = typeof o.id === "string" ? o.id : "";
    const url =
      (typeof o.checkoutUrl === "string" ? o.checkoutUrl : undefined) ??
      (typeof o.url === "string" ? o.url : "");
    if (id && url) {
      return { sessionId: id, checkoutUrl: url, webhookSecret: extractWebhookSecret(o) };
    }
  }
  logger.error("Unexpected checkout session response", { data });
  throw new Error("Checkout session response missing id or url");
}

export async function createSession(
  buildId: string,
  telegramId: bigint,
  chatId: bigint,
  amount: number,
): Promise<CreateCheckoutSessionResult> {
  const botUrl = process.env.BOT_PUBLIC_URL?.replace(/\/$/, "");
  if (!botUrl) throw new Error("BOT_PUBLIC_URL is required");
  const c = client();
  const body = {
    amount: amount.toFixed(2),
    currency: "USDC",
    description: "SiteBot — AI Website Build",
    metadata: {
      buildId,
      telegramId: String(telegramId),
      chatId: String(chatId),
      type: "standard_build",
    },
    webhookUrl: `${botUrl}/webhook/payment`,
    successMessage: "✅ Payment confirmed! Your site is being built now.",
    cancelUrl: null,
  };
  const res = await c.post("/checkout/sessions", body);
  if (res.status >= 400) {
    logger.error("createSession failed", { 
      status: res.status, 
      data: res.data,
      baseURL: checkoutBase(),
      payload: body 
    });
    throw new Error(`Checkout createSession HTTP ${res.status}`);
  }
  logger.info("createSession raw HTTP response:", { data: res.data });
  return unwrapSessionPayload(res.data);
}

export async function createDomainSession(
  buildId: string,
  telegramId: bigint,
  chatId: bigint,
  domain: string,
  amount: number,
): Promise<CreateCheckoutSessionResult> {
  const botUrl = process.env.BOT_PUBLIC_URL?.replace(/\/$/, "");
  if (!botUrl) throw new Error("BOT_PUBLIC_URL is required");
  const c = client();
  const body = {
    amount: amount.toFixed(2),
    currency: "USDC",
    description: `SiteBot — Custom Domain: ${domain}`,
    metadata: {
      buildId,
      telegramId: String(telegramId),
      chatId: String(chatId),
      type: "domain_purchase",
      domain,
    },
    webhookUrl: `${botUrl}/webhook/payment`,
    successMessage: "✅ Domain payment received. Registering your domain...",
    cancelUrl: null,
  };
  const res = await c.post("/checkout/sessions", body);
  if (res.status >= 400) {
    logger.error("createDomainSession failed", { 
      status: res.status, 
      data: res.data,
      baseURL: checkoutBase(),
      payload: body 
    });
    throw new Error(`Checkout createDomainSession HTTP ${res.status}`);
  }
  logger.info("createDomainSession raw HTTP response:", { data: res.data });
  return unwrapSessionPayload(res.data);
}

export async function createCreditSession(
  telegramId: bigint,
  chatId: bigint,
  amount: number,
): Promise<CreateCheckoutSessionResult> {
  const botUrl = process.env.BOT_PUBLIC_URL?.replace(/\/$/, "");
  if (!botUrl) throw new Error("BOT_PUBLIC_URL is required");
  const c = client();
  const body = {
    amount: amount.toFixed(2),
    currency: "USDC",
    description: "SiteBot — Buy 1 Build Credit",
    metadata: {
      telegramId: String(telegramId),
      chatId: String(chatId),
      type: "credit_purchase",
    },
    webhookUrl: `${botUrl}/webhook/payment`,
    successMessage: "✅ Build Credit purchased successfully!",
    cancelUrl: null,
  };
  const res = await c.post("/checkout/sessions", body);
  if (res.status >= 400) {
    logger.error("createCreditSession failed", { 
      status: res.status, 
      data: res.data,
      baseURL: checkoutBase(),
      payload: body 
    });
    throw new Error(`Checkout createCreditSession HTTP ${res.status}`);
  }
  logger.info("createCreditSession raw HTTP response:", { data: res.data });
  return unwrapSessionPayload(res.data);
}

export type CheckoutSession = {
  id: string;
  status: string;
  amount?: string;
  metadata?: Record<string, string>;
};

export async function getSession(sessionId: string): Promise<CheckoutSession> {
  const c = client();
  const res = await c.get(`/checkout/sessions/${sessionId}`);
  if (res.status >= 400) {
    throw new Error(`getSession HTTP ${res.status}`);
  }
  const payload = res.data as Record<string, unknown>;
  const data =
    payload.success === true && payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : payload;
  return {
    id: typeof data.id === "string" ? data.id : sessionId,
    status: typeof data.status === "string" ? data.status : "UNKNOWN",
    amount: typeof data.amount === "string" ? data.amount : undefined,
    metadata:
      data.metadata && typeof data.metadata === "object"
        ? (data.metadata as Record<string, string>)
        : undefined,
  };
}
