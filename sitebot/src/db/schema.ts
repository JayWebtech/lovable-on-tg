import {
  bigint,
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const buildStatusEnum = pgEnum("build_status", [
  "awaiting_payment",
  "queued",
  "generating",
  "deploying",
  "live",
  "failed",
  "expired",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "confirmed",
  "expired",
  "refunded",
]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull().unique(),
  username: text("username"),
  firstName: text("first_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  totalBuilds: integer("total_builds").default(0).notNull(),
  totalSpentUsdc: numeric("total_spent_usdc", { precision: 10, scale: 2 }).default("0").notNull(),
  credits: integer("credits").default(0).notNull(),
});

export const builds = pgTable("builds", {
  id: uuid("id").defaultRandom().primaryKey(),
  telegramId: bigint("telegram_id", { mode: "bigint" })
    .notNull()
    .references(() => users.telegramId, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  status: buildStatusEnum("status").notNull().default("awaiting_payment"),
  checkoutSessionId: text("checkout_session_id"),
  checkoutUrl: text("checkout_url"),
  amountUsdc: numeric("amount_usdc", { precision: 10, scale: 2 }),
  paymentConfirmedAt: timestamp("payment_confirmed_at", { withTimezone: true }),
  locusProjectId: text("locus_project_id"),
  locusServiceId: text("locus_service_id"),
  locusDeploymentId: text("locus_deployment_id"),
  siteUrl: text("site_url"),
  domain: text("domain"),
  /** Registrant JSON from Telegram wizard; cleared after successful Locus purchase */
  domainContactJson: text("domain_contact_json"),
  errorMessage: text("error_message"),
  generatedHtml: text("generated_html"),
  paymentReminderSent: boolean("payment_reminder_sent").default(false).notNull(),
  expiryWarningSent: boolean("expiry_warning_sent").default(false).notNull(),
  /** Telegram message containing the pay link (for in-place status edits) */
  paymentPromptChatId: bigint("payment_prompt_chat_id", { mode: "bigint" }),
  paymentPromptMessageId: integer("payment_prompt_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  buildId: uuid("build_id")
    .references(() => builds.id, { onDelete: "cascade" }),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull(),
  checkoutSessionId: text("checkout_session_id").notNull().unique(),
  /** Pay with Locus returns `whsec_…` when creating a session with webhookUrl; used to verify X-Signature-256 */
  checkoutWebhookSecret: text("checkout_webhook_secret"),
  amountUsdc: numeric("amount_usdc", { precision: 10, scale: 2 }).notNull(),
  status: paymentStatusEnum("status").notNull().default("pending"),
  locusPaymentId: text("locus_payment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

export const usersRelations = relations(users, ({ many }) => ({
  builds: many(builds),
}));

export const buildsRelations = relations(builds, ({ one, many }) => ({
  user: one(users, {
    fields: [builds.telegramId],
    references: [users.telegramId],
  }),
  payments: many(payments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  build: one(builds, {
    fields: [payments.buildId],
    references: [builds.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type Build = typeof builds.$inferSelect;
export type Payment = typeof payments.$inferSelect;
