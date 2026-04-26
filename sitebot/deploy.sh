#!/usr/bin/env bash
# Deploy SiteBot to Locus (Build with Locus) — fill YOUR_GITHUB_ORG/sitebot before use.

set -euo pipefail

# Build API host for curl (JWT + project/service CRUD). Beta wallet URL is not Build — see README.
APP_LOCUS_API_BASE="${LOCUS_API_BASE:-https://api.buildwithlocus.com/v1}"
APP_LOCUS_API_BASE="${APP_LOCUS_API_BASE%/}"
U="$(printf '%s' "$APP_LOCUS_API_BASE" | tr '[:upper:]' '[:lower:]')"
if [[ -n "${LOCUS_BUILD_API_BASE:-}" ]]; then
  BASE="${LOCUS_BUILD_API_BASE%/}"
elif [[ "$U" == *"beta-api.paywithlocus.com"* ]] || [[ "$U" == *"api.paywithlocus.com"* && "$U" != *"buildwithlocus"* ]]; then
  BASE="https://api.buildwithlocus.com/v1"
else
  BASE="$APP_LOCUS_API_BASE"
fi
BASE="${BASE%/}"

TOKEN="$(curl -s -X POST "${BASE}/auth/exchange" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"${LOCUS_API_KEY}\"}" | jq -r '.token')"

echo "Authenticated."

BALANCE="$(curl -s -H "Authorization: Bearer ${TOKEN}" "${BASE}/billing/balance" | jq '.creditBalance')"
echo "Balance: ${BALANCE}"

PROJECT="$(curl -s -X POST "${BASE}/projects" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"sitebot","description":"Telegram AI website builder"}')"
PROJECT_ID="$(echo "${PROJECT}" | jq -r '.id')"

ENV_JSON="$(curl -s -X POST "${BASE}/projects/${PROJECT_ID}/environments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"production","type":"production"}')"
ENV_ID="$(echo "${ENV_JSON}" | jq -r '.id')"

SERVICE="$(curl -s -X POST "${BASE}/services" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"projectId\": \"${PROJECT_ID}\",
    \"environmentId\": \"${ENV_ID}\",
    \"name\": \"sitebot\",
    \"source\": {
      \"type\": \"github\",
      \"repo\": \"YOUR_GITHUB_ORG/sitebot\",
      \"branch\": \"main\"
    },
    \"runtime\": {\"port\": 8080, \"cpu\": 512, \"memory\": 1024},
    \"healthCheckPath\": \"/health\",
    \"autoDeploy\": true
  }")"
SERVICE_ID="$(echo "${SERVICE}" | jq -r '.id')"

echo "Service ID: ${SERVICE_ID}"

curl -s -X PUT \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"variables\": {
    \"TELEGRAM_BOT_TOKEN\": \"${TELEGRAM_BOT_TOKEN}\",
    \"ANTHROPIC_API_KEY\": \"${ANTHROPIC_API_KEY}\",
    \"LOCUS_API_KEY\": \"${LOCUS_API_KEY}\",
    \"LOCUS_API_BASE\": \"${APP_LOCUS_API_BASE}\",
    \"LOCUS_CHECKOUT_API_BASE\": \"${LOCUS_CHECKOUT_API_BASE:-}\",
    \"LOCUS_WEBHOOK_SECRET\": \"${LOCUS_WEBHOOK_SECRET}\",
    \"BOT_PUBLIC_URL\": \"${BOT_PUBLIC_URL}\",
    \"REDIS_URL\": \"\${{redis.REDIS_URL}}\",
    \"DATABASE_URL\": \"\${{db.DATABASE_URL}}\",
    \"ADMIN_TELEGRAM_ID\": \"${ADMIN_TELEGRAM_ID}\"
  }}" \
  "${BASE}/variables/service/${SERVICE_ID}" >/dev/null

echo "Provisioning Postgres addon…"
curl -s -X POST "${BASE}/addons" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\":\"${PROJECT_ID}\",\"environmentId\":\"${ENV_ID}\",\"type\":\"postgres\",\"name\":\"db\"}" | jq .

echo "Provisioning Redis addon…"
curl -s -X POST "${BASE}/addons" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\":\"${PROJECT_ID}\",\"environmentId\":\"${ENV_ID}\",\"type\":\"redis\",\"name\":\"redis\"}" | jq .

DEPLOY="$(curl -s -X POST "${BASE}/deployments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"serviceId\":\"${SERVICE_ID}\"}")"
DEPLOYMENT_ID="$(echo "${DEPLOY}" | jq -r '.id')"

echo "Deployment triggered: ${DEPLOYMENT_ID}"
echo "Monitor at: https://buildwithlocus.com/dashboard"
