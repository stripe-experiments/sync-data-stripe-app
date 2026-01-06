#!/bin/bash
# =============================================================================
# Token Sweeper Deployment Script
# =============================================================================
# This script helps deploy the token-sweeper Edge Function and set up secrets.
# Run from the supabase-management directory.
#
# Usage:
#   ./scripts/deploy.sh
#
# Prerequisites:
#   - Supabase CLI installed (https://supabase.com/docs/guides/cli)
#   - .env file configured with your values
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           Token Sweeper Deployment Script                  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check for .env file
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo -e "${RED}Error: .env file not found${NC}"
    echo "Please copy env.example to .env and fill in your values:"
    echo "  cp env.example .env"
    exit 1
fi

# Load environment variables
source "$PROJECT_DIR/.env"

# Validate required variables
REQUIRED_VARS=(
    "SUPABASE_PROJECT_REF"
    "SUPABASE_ANON_KEY"
    "STRIPE_SECRET_KEY_TEST"
    "STRIPE_SECRET_KEY_LIVE"
    "ENCRYPTION_KEY"
)

MISSING_VARS=()
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    echo -e "${RED}Error: Missing required environment variables:${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo "  - $var"
    done
    echo ""
    echo "Please update your .env file with these values."
    exit 1
fi

echo -e "${GREEN}✓ Environment variables loaded${NC}"
echo ""

# Check Supabase CLI
if ! command -v supabase &> /dev/null; then
    echo -e "${RED}Error: Supabase CLI not found${NC}"
    echo "Install it with: brew install supabase/tap/supabase"
    echo "Or see: https://supabase.com/docs/guides/cli"
    exit 1
fi

echo -e "${GREEN}✓ Supabase CLI found${NC}"
echo ""

# Confirm project
echo -e "${YELLOW}Target Project:${NC} $SUPABASE_PROJECT_REF"
echo ""
read -p "Continue with deployment? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled."
    exit 0
fi

echo ""
echo -e "${BLUE}Step 1: Setting secrets...${NC}"
echo ""

# Set secrets (these won't be echoed for security)
echo "Setting STRIPE_SECRET_KEY_TEST..."
supabase secrets set STRIPE_SECRET_KEY_TEST="$STRIPE_SECRET_KEY_TEST" --project-ref "$SUPABASE_PROJECT_REF"

echo "Setting STRIPE_SECRET_KEY_LIVE..."
supabase secrets set STRIPE_SECRET_KEY_LIVE="$STRIPE_SECRET_KEY_LIVE" --project-ref "$SUPABASE_PROJECT_REF"

echo "Setting ENCRYPTION_KEY..."
supabase secrets set ENCRYPTION_KEY="$ENCRYPTION_KEY" --project-ref "$SUPABASE_PROJECT_REF"

echo ""
echo -e "${GREEN}✓ Secrets set${NC}"
echo ""

echo -e "${BLUE}Step 2: Deploying Edge Function...${NC}"
echo ""

cd "$PROJECT_DIR"
supabase functions deploy token-sweeper --project-ref "$SUPABASE_PROJECT_REF"

echo ""
echo -e "${GREEN}✓ Edge Function deployed${NC}"
echo ""

# Generate the SQL with actual values
FUNCTION_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/token-sweeper"

echo -e "${BLUE}Step 3: Database Setup${NC}"
echo ""
echo -e "${YELLOW}You need to run the following SQL in your Supabase SQL Editor:${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "-- 1. Enable extensions (if not already enabled)"
echo "create extension if not exists pg_cron with schema pg_catalog;"
echo "create extension if not exists pg_net with schema extensions;"
echo ""
echo "-- 2. Schedule the cron job"
echo "select cron.unschedule('token_sweeper_30m')"
echo "where exists (select 1 from cron.job where jobname = 'token_sweeper_30m');"
echo ""
echo "select cron.schedule("
echo "  'token_sweeper_30m',"
echo "  '*/30 * * * *',"
echo "  \$\$"
echo "  select net.http_post("
echo "    url := '${FUNCTION_URL}',"
echo "    headers := jsonb_build_object("
echo "      'Content-Type', 'application/json',"
echo "      'Authorization', 'Bearer ${SUPABASE_ANON_KEY}'"
echo "    ),"
echo "    body := jsonb_build_object("
echo "      'triggered_by', 'pg_cron',"
echo "      'dry_run', false"
echo "    )"
echo "  ) as request_id;"
echo "  \$\$"
echo ");"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Also write to a file for convenience
SQL_OUTPUT="$PROJECT_DIR/sql/schedule_token_sweeper_configured.sql"
cat > "$SQL_OUTPUT" << EOF
-- =============================================================================
-- Token Sweeper Cron Job (Auto-generated with your configuration)
-- =============================================================================
-- Generated on: $(date)
-- Project: ${SUPABASE_PROJECT_REF}
-- =============================================================================

-- 1. Enable extensions (if not already enabled)
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- 2. Remove existing job if present
select cron.unschedule('token_sweeper_30m')
where exists (select 1 from cron.job where jobname = 'token_sweeper_30m');

-- 3. Schedule the cron job
select cron.schedule(
  'token_sweeper_30m',
  '*/30 * * * *',
  \$\$
  select net.http_post(
    url := '${FUNCTION_URL}',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ${SUPABASE_ANON_KEY}'
    ),
    body := jsonb_build_object(
      'triggered_by', 'pg_cron',
      'dry_run', false
    )
  ) as request_id;
  \$\$
);

-- 4. Verify the job was created
select jobid, jobname, schedule, command 
from cron.job 
where jobname = 'token_sweeper_30m';
EOF

echo -e "${GREEN}✓ SQL also saved to: sql/schedule_token_sweeper_configured.sql${NC}"
echo ""
echo -e "${YELLOW}⚠️  Don't commit this file - it contains your secret!${NC}"
echo ""

echo -e "${BLUE}Step 4: Test the function${NC}"
echo ""
echo "To test the function manually (dry run):"
echo ""
echo "curl -X POST \\"
echo "  '${FUNCTION_URL}' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'x-token-sweeper-secret: ${TOKEN_SWEEPER_SECRET}' \\"
echo "  -d '{\"dry_run\": true}'"
echo ""

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   Deployment Complete!                     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  1. Run the SQL above in your Supabase SQL Editor"
echo "  2. Test with a dry run using the curl command above"
echo "  3. Monitor logs in Supabase Dashboard > Edge Functions > token-sweeper"
echo ""

