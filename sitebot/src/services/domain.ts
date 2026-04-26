import { eq } from "drizzle-orm";
import type { Bot, Context } from "grammy";
import { db } from "../db/index.js";
import { builds } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import {
  loadDomainContactFromEnv,
  purchaseAndAttachDomain,
  type DomainContact,
} from "./locus.js";

function parseStoredContact(json: string): DomainContact | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const keys: (keyof DomainContact)[] = [
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
    const out: Partial<DomainContact> = {};
    for (const k of keys) {
      const v = o[k];
      if (typeof v !== "string" || v.trim().length === 0) return null;
      out[k] = v.trim();
    }
    return out as DomainContact;
  } catch {
    return null;
  }
}

export async function handleDomainPaymentConfirmed(
  bot: Bot<Context>,
  buildId: string,
  telegramIdStr: string,
  domain: string | undefined,
  notifyChatId?: string,
): Promise<void> {
  if (!domain) {
    logger.error("Domain payment missing domain in metadata", { buildId });
    return;
  }

  const [build] = await db.select().from(builds).where(eq(builds.id, buildId)).limit(1);
  if (!build || !build.locusServiceId) {
    logger.error("Build not found or missing service for domain flow", { buildId });
    return;
  }

  const chatId = notifyChatId ?? telegramIdStr;

  let contact: DomainContact | null = build.domainContactJson
    ? parseStoredContact(build.domainContactJson)
    : null;
  if (!contact) {
    try {
      contact = loadDomainContactFromEnv();
    } catch {
      logger.error("Domain payment: no contact on build and DOMAIN_CONTACT_JSON unset", { buildId });
      await bot.api.sendMessage(
        chatId,
        "⚠️ Registrant details are missing for this order. Please start the domain flow again from your live site.",
      );
      return;
    }
  }

  try {
    await bot.api.sendMessage(
      chatId,
      `🌐 Registering and attaching *${domain}* to your site...`,
      { parse_mode: "Markdown" },
    );
    await purchaseAndAttachDomain(build.locusServiceId, domain, build.locusProjectId ?? undefined, contact);
    await db
      .update(builds)
      .set({ domain, domainContactJson: null })
      .where(eq(builds.id, buildId));

    const url = build.siteUrl ?? "";
    await bot.api.sendMessage(
      chatId,
      `✅ Custom domain ready: *https://${domain}*\n\nYour service URL still works: ${url}`,
      { parse_mode: "Markdown" },
    );
  } catch (e) {
    logger.error("Domain purchase flow failed", { err: String(e), buildId });
    await bot.api.sendMessage(
      chatId,
      "⚠️ Domain registration hit an error. Support will follow up. Your site remains live on the default URL.",
    );
  }
}
