#!/usr/bin/env bash
# Point Telegram updates at your public HTTPS URL (production on Locus).

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?}"
: "${TELEGRAM_WEBHOOK_URL:?}" # e.g. https://svc-xxx.buildwithlocus.com/telegram

SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"

if [[ -n "${SECRET}" ]]; then
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -d "url=${TELEGRAM_WEBHOOK_URL}" \
    -d "secret_token=${SECRET}"
else
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -d "url=${TELEGRAM_WEBHOOK_URL}"
fi

echo
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | jq .
