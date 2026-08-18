#!/usr/bin/env bash
set -u
APP_DIR=/opt/vaysen-ai-crm
DATA_DIR="$APP_DIR/data/external-leads"
AGENT_FILE="${BUSINESS_AGENT_FILE:-$DATA_DIR/packaging-agent.md}"
ARCHIVE_FILE="$DATA_DIR/customer-master.md"
LOG_FILE="$APP_DIR/logs/claude-lead-hunt-24h.log"
PID_FILE="$APP_DIR/logs/claude-lead-hunt-24h.pid"
PAUSE_FILE="$APP_DIR/logs/lead-hunt-vaysen.paused"
LEGACY_PAUSE_FILE="$APP_DIR/logs/lead-hunt.paused"
END_AT=$(( $(date +%s) + 24*60*60 ))
ITER=0
mkdir -p "$DATA_DIR/backups" "$APP_DIR/logs"
touch "$ARCHIVE_FILE"
if [ -f "$PAUSE_FILE" ] || [ -f "$LEGACY_PAUSE_FILE" ]; then
  echo "===== LEAD HUNT PAUSED $(date '+%Y-%m-%d %H:%M:%S') pause_file=$PAUSE_FILE =====" >> "$LOG_FILE"
  exit 0
fi
echo $$ > "$PID_FILE"
cd "$APP_DIR"
get_key() { grep '^DEEPSEEK_API_KEY=' "$APP_DIR/backend/.env" | tail -1 | cut -d= -f2-; }
QUALITY_GATE='MANDATORY QUALITY GATE:
1. Evidence first. Company, website, email, contact, phone, social links, country, and products must be copied from public pages visited through WebSearch/WebFetch. Do not use model memory as a source.
2. Accepted leads must include official website URL, email source URL, exact source page type, collection timestamp, and email verification status.
3. Email verification status must be one of official_page_verified, smtp_verified, mx_only_manual_review, unverified_rejected, role_email_manual_review.
4. Only official_page_verified or smtp_verified emails may be written as accepted/auto-send leads.
5. Role/dept emails such as info@, sales@, contact@, hello@, support@, service@, marketing@, office@, press@, legal@, privacy@, hr@, jobs@, noreply@ are NOT accepted primary outreach emails. Put them in manual review unless there is no better contact and clearly mark role_email_manual_review.
6. Guessed emails, pattern emails, inferred contacts, inferred titles, and fields without source URLs must not be written into accepted customer records. Put them only in skipped/manual-review summary.
7. Reject placeholders and fake-looking values: +81-3-1234-5678, 123-456-7890, 000-000, example.com, john@example.com, John Smith without source, phone numbers not found on a source page.
8. Exclude Mainland China, Hong Kong, Macau, Taiwan and any country/domain conflict with the target market.
9. For every skipped item, record the reason: no public email, role email only, unverified email, guessed field, country conflict, duplicate, missing source URL, irrelevant category.
10. If fewer than 5 accepted leads are found, stop at the real count. Do not fill the quota with unverified or guessed leads.'
while [ "$(date +%s)" -lt "$END_AT" ]; do
  if [ -f "$PAUSE_FILE" ] || [ -f "$LEGACY_PAUSE_FILE" ]; then echo "===== LEAD HUNT PAUSED MID-RUN $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG_FILE"; break; fi
  ITER=$((ITER+1))
  TS=$(date '+%Y-%m-%d %H:%M:%S')
  BACKUP="$DATA_DIR/backups/customer-master-$(date '+%Y%m%d-%H%M%S')-iter${ITER}.md"
  cp "$ARCHIVE_FILE" "$BACKUP" 2>/dev/null || true
  echo "===== ITERATION $ITER START $TS backup=$BACKUP =====" >> "$LOG_FILE"
  export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
  export ANTHROPIC_AUTH_TOKEN="$(get_key)"
  export ANTHROPIC_MODEL="deepseek-v4-flash"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-flash"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
  export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-flash"
  export CLAUDE_CODE_EFFORT_LEVEL="high"
  export HTTP_PROXY="http://127.0.0.1:7890"
  export HTTPS_PROXY="http://127.0.0.1:7890"
  export NO_PROXY="127.0.0.1,localhost,192.168.50.20"
  PROMPT="You are running a 24-hour B2B overseas lead discovery job for Vaysen Packaging. Read and follow the SOP/Agent file exactly: $AGENT_FILE. Read the existing master customer archive first: $ARCHIVE_FILE. Deduplicate against the archive before adding anything. In this iteration, find up to 5 high-quality overseas buyers for poly mailers, kraft paper bags, garbage bags, zip-lock bags, or other customizable flexible packaging. Prioritize brands, e-commerce sellers, packaging distributors, retail chains, logistics/fulfillment companies, food-service buyers, and procurement teams with repeat-volume demand. Use WebSearch/WebFetch to visit real public pages. Edit the archive file directly only for accepted leads that pass the quality gate. Keep manual-review and rejected findings in the iteration summary, not as accepted customer records. For every accepted lead include company/brand, country, official website, customer profile/category, products or cooperation angle, contact/title/email/source URL, social links if found, rating, outreach recommendation, evidence URLs, collection timestamp, and email confidence. Update the archive header last updated time, customer count, and batch notes. At the end print a concise iteration summary: search queries used, sources visited, accepted leads, manual-review items, rejected reasons, and next search ideas. $QUALITY_GATE"
  timeout 50m claude -p "$PROMPT" --model 'deepseek-v4-flash' --dangerously-skip-permissions --add-dir "$DATA_DIR" --output-format text >> "$LOG_FILE" 2>&1
  CODE=$?
  echo "===== ITERATION $ITER END $(date '+%Y-%m-%d %H:%M:%S') exit=$CODE =====" >> "$LOG_FILE"
  sleep 90
done
echo "===== 24H JOB COMPLETE $(date '+%Y-%m-%d %H:%M:%S') =====" >> "$LOG_FILE"
rm -f "$PID_FILE"
