import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import { Redis } from "ioredis";
import { logger } from "../utils/logger.js";
import { parseRedisUrl } from "../utils/redisUrl.js";

const TOKEN_KEY = "sitebot:locus:jwt";
const TOKEN_TTL_SEC = 29 * 24 * 60 * 60;

export class InsufficientCreditsError extends Error {
  constructor(message = "Insufficient Locus credits") {
    super(message);
    this.name = "InsufficientCreditsError";
  }
}


function buildApiBase(): string {
  const fromEnv = process.env.LOCUS_BUILD_API_BASE?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const isBeta = (process.env.LOCUS_API_KEY || "").includes("_beta_") || (process.env.LOCUS_API_KEY || "").startsWith("claw_dev_");
  if (isBeta) return "https://beta-api.buildwithlocus.com/v1";
  return "https://api.buildwithlocus.com/v1";
}

let redisSingleton: Redis | null = null;
function redis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redisSingleton) {
    try {
      redisSingleton = new Redis(parseRedisUrl(url));
      redisSingleton.on("error", (e: Error) =>
        logger.warn("Redis error (locus token cache)", { err: String(e) }),
      );
    } catch (e) {
      logger.warn("Redis unavailable for Locus token cache", { err: String(e) });
      return null;
    }
  }
  return redisSingleton;
}

async function getCachedToken(): Promise<string | null> {
  const r = redis();
  if (!r) return null;
  try {
    return await r.get(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function setCachedToken(token: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.set(TOKEN_KEY, token, "EX", TOKEN_TTL_SEC);
  } catch (e) {
    logger.warn("Failed to cache Locus JWT", { err: String(e) });
  }
}

export async function getLocusJwt(): Promise<string> {
  const cached = await getCachedToken();
  if (cached) return cached;

  const apiKey = process.env.LOCUS_API_KEY;
  if (!apiKey) throw new Error("LOCUS_API_KEY is required");

  const res = await axios.post<{ token: string; expiresIn?: number }>(
    `${buildApiBase()}/auth/exchange`,
    { apiKey },
    { timeout: 30_000, validateStatus: () => true },
  );
  if (res.status >= 400 || !res.data?.token) {
    logger.error("Locus auth exchange failed", { status: res.status, data: res.data });
    throw new Error(`Locus auth exchange failed: HTTP ${res.status}`);
  }
  await setCachedToken(res.data.token);
  return res.data.token;
}

async function locusRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getLocusJwt();
  const url = `${buildApiBase()}${path.startsWith("/") ? path : `/${path}`}`;
  const cfg: AxiosRequestConfig = {
    method,
    url,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60_000,
    validateStatus: () => true,
  };
  if (body !== undefined) {
    cfg.data = body;
    cfg.headers = { ...cfg.headers, "Content-Type": "application/json" };
  }
  const res = await axios.request<T>(cfg);
  if (res.status === 402) {
    throw new InsufficientCreditsError();
  }
  if (res.status >= 400) {
    throw new Error(`Locus API ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data as T;
}

export async function createProject(name: string): Promise<{ id: string }> {
  return locusRequest("POST", "/projects", {
    name,
    description: "SiteBot generated site",
  });
}

export async function createEnvironment(
  projectId: string,
): Promise<{ id: string }> {
  return locusRequest("POST", `/projects/${projectId}/environments`, {
    name: "production",
    type: "production",
  });
}

export type CreateServiceResult = { id: string; url?: string };

export async function createS3GitService(
  projectId: string,
  environmentId: string,
  name: string,
): Promise<CreateServiceResult> {
  return locusRequest("POST", "/services", {
    projectId,
    environmentId,
    name,
    source: { type: "s3", rootDir: ".", s3Key: "dummy" },
    runtime: { port: 8080, cpu: 256, memory: 512 },
    healthCheckPath: "/health",
    buildConfig: { method: "dockerfile", dockerfile: "Dockerfile" },
  });
}

export async function deployService(serviceId: string): Promise<{ id: string }> {
  return locusRequest("POST", "/deployments", { serviceId });
}

export async function getDeployment(deploymentId: string): Promise<{ status: string; lastLogs?: string[] }> {
  return locusRequest("GET", `/deployments/${deploymentId}`);
}

export async function waitForDeployment(
  deploymentId: string,
  onStatusUpdate: (status: string) => void,
): Promise<"healthy" | "failed"> {
  const started = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  let last = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const d = await getDeployment(deploymentId);
      const status = d.status;
      if (status !== last) {
        last = status;
        onStatusUpdate(status);
      }
      if (status === "healthy") return "healthy";
      if (status === "failed" || status === "cancelled" || status === "rolled_back") return "failed";
    } catch (e: any) {
      if (e.message?.includes("401") || e.message?.includes("403") || e.message?.includes("404")) {
        return "failed"; // Fatal errors
      }
      // Log and ignore timeout or 500 errors to keep polling
      console.warn("Poll getDeployment error:", e.message);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return "failed";
}

export async function checkBalance(): Promise<number> {
  const data = await locusRequest<{ creditBalance?: number }>("GET", "/billing/balance");
  const n = data.creditBalance;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export async function whoami(): Promise<{ workspaceId: string }> {
  return locusRequest("GET", "/auth/whoami");
}

export async function getGitRemoteTemplate(): Promise<{ remoteUrl: string; usage?: string }> {
  return locusRequest("GET", "/git/remote-url");
}

export function buildGitRemoteUrl(workspaceId: string, projectId: string, credential: string): string {
  const enc = encodeURIComponent(credential);
  return `https://x:${enc}@git.buildwithlocus.com/${workspaceId}/${projectId}.git`;
}

/** Prefer API template; fall back to production git host pattern */
export async function resolveGitRemoteUrl(projectId: string): Promise<string> {
  const apiKey = process.env.LOCUS_API_KEY ?? "";
  const { workspaceId } = await whoami();
  try {
    const meta = await getGitRemoteTemplate();
    const base = meta.remoteUrl.replace(/\/$/, "");
    if (base.includes("{projectId}") || base.includes("PROJECT")) {
      return base
        .replace(/\{workspaceId\}/g, workspaceId)
        .replace(/\{projectId\}/g, projectId)
        .replace("x:YOUR_API_KEY_OR_JWT", `x:${encodeURIComponent(apiKey)}`);
    }
    const u = new URL(base);
    const host = u.host;
    const pathWs = u.pathname.replace(/\/$/, "");
    return `https://x:${encodeURIComponent(apiKey)}@${host}${pathWs}/${projectId}.git`;
  } catch {
    return buildGitRemoteUrl(workspaceId, projectId, apiKey);
  }
}

export type DomainAvailability = {
  domain: string;
  available: boolean;
  price?: string;
};

export async function checkDomainAvailability(domain: string): Promise<DomainAvailability> {
  const q = encodeURIComponent(domain);
  const data = await locusRequest<Record<string, unknown>>("GET", `/domains/check-availability?domain=${q}`);
  const available = Boolean(
    data.available ?? (data as { isAvailable?: boolean }).isAvailable ?? (data as { availableForPurchase?: boolean }).availableForPurchase,
  );
  const price =
    typeof data.price === "string"
      ? data.price
      : typeof (data as { registrationPrice?: { amount?: string } }).registrationPrice?.amount === "string"
        ? (data as { registrationPrice?: { amount?: string } }).registrationPrice!.amount
        : undefined;
  return {
    domain: typeof data.domain === "string" ? data.domain : domain,
    available,
    price,
  };
}

export type DomainSuggestion = { domain: string; price?: string };

export async function getDomainSuggestions(keywords: string): Promise<DomainSuggestion[]> {
  const q = encodeURIComponent(keywords);
  const data = await locusRequest<{ suggestions?: DomainSuggestion[] } | DomainSuggestion[]>(
    "GET",
    `/domains/suggestions?keywords=${q}`,
  );
  if (Array.isArray(data)) return data;
  return Array.isArray(data.suggestions) ? data.suggestions : [];
}

export async function searchDomains(query: string): Promise<DomainAvailability[]> {
  const trimmed = query.trim().toLowerCase();
  const primary = await checkDomainAvailability(trimmed);
  const out: DomainAvailability[] = [primary];
  if (!primary.available) {
    const sug = await getDomainSuggestions(trimmed);
    for (const s of sug.slice(0, 5)) {
      if (s.domain && s.domain !== trimmed) {
        try {
          out.push(await checkDomainAvailability(s.domain));
        } catch {
          /* skip */
        }
      }
    }
  }
  return out;
}

export type DomainContact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

/** Optional fallback when `builds.domain_contact_json` was not set (legacy paths). */
export function loadDomainContactFromEnv(): DomainContact {
  const raw = process.env.DOMAIN_CONTACT_JSON;
  if (!raw) {
    throw new Error("DOMAIN_CONTACT_JSON is not set (no registrant data on build)");
  }
  const parsed = JSON.parse(raw) as Partial<DomainContact>;
  const required: (keyof DomainContact)[] = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "addressLine1",
    "city",
    "state",
    "postalCode",
    "country",
  ];
  for (const k of required) {
    if (!parsed[k] || typeof parsed[k] !== "string") {
      throw new Error(`DOMAIN_CONTACT_JSON missing field: ${k}`);
    }
  }
  return parsed as DomainContact;
}

export async function purchaseAndAttachDomain(
  serviceId: string,
  domain: string,
  projectId: string | undefined,
  contact: DomainContact,
): Promise<void> {
  const purchase = await locusRequest<{ id?: string }>("POST", "/domains/purchase", {
    domain,
    contact,
    projectId: projectId ?? undefined,
  });
  const domainId = purchase.id;
  if (!domainId) throw new Error("Domain purchase did not return id");

  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const st = await locusRequest<{ status?: string }>("GET", `/domains/${domainId}/registration-status`);
    if (st.status === "registered") break;
    if (st.status === "failed") throw new Error("Domain registration failed");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  await locusRequest("POST", `/domains/${domainId}/attach`, { serviceId });
}

export async function deleteProject(projectId: string): Promise<void> {
  await locusRequest("DELETE", `/projects/${projectId}`);
}

export function createLocusAxios(): AxiosInstance {
  return axios.create();
}
