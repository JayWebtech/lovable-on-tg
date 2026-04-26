ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "checkout_webhook_secret" text;
