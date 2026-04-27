DO $$ BEGIN
 CREATE TYPE "public"."build_status" AS ENUM('awaiting_payment', 'queued', 'generating', 'deploying', 'live', 'failed', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."payment_status" AS ENUM('pending', 'confirmed', 'expired', 'refunded');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"prompt" text NOT NULL,
	"status" "build_status" DEFAULT 'awaiting_payment' NOT NULL,
	"checkout_session_id" text,
	"checkout_url" text,
	"amount_usdc" numeric(10, 2),
	"payment_confirmed_at" timestamp with time zone,
	"locus_project_id" text,
	"locus_service_id" text,
	"locus_deployment_id" text,
	"site_url" text,
	"domain" text,
	"domain_contact_json" text,
	"error_message" text,
	"generated_html" text,
	"payment_reminder_sent" boolean DEFAULT false NOT NULL,
	"expiry_warning_sent" boolean DEFAULT false NOT NULL,
	"payment_prompt_chat_id" bigint,
	"payment_prompt_message_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"build_id" uuid,
	"telegram_id" bigint NOT NULL,
	"checkout_session_id" text NOT NULL,
	"checkout_webhook_secret" text,
	"amount_usdc" numeric(10, 2) NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"locus_payment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "payments_checkout_session_id_unique" UNIQUE("checkout_session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"first_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_builds" integer DEFAULT 0 NOT NULL,
	"total_spent_usdc" numeric(10, 2) DEFAULT '0' NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "builds" ADD CONSTRAINT "builds_telegram_id_users_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."users"("telegram_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;