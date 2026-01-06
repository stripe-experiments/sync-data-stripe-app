#!/bin/bash
# =============================================================================
# Local Testing Script for Token Sweeper
# =============================================================================
# Tests the deployed Edge Function with a dry run.
# Run from the supabase-management directory.
#
# Usage:
#   ./scripts/test-local.sh [--force]
#
# Options:
#   --force   Skip dry run and actually refresh tokens
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check for .env file
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "Error: .env file not found"
    exit 1
fi

source "$PROJECT_DIR/.env"

if [ -z "$SUPABASE_PROJECT_REF" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
    echo "Error: Missing SUPABASE_PROJECT_REF or SUPABASE_ANON_KEY in .env"
    exit 1
fi

FUNCTION_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/token-sweeper"

# Check for --force flag
DRY_RUN="true"
if [ "$1" == "--force" ]; then
    DRY_RUN="false"
    echo -e "${YELLOW}⚠️  Running with --force: tokens WILL be refreshed${NC}"
    echo ""
    read -p "Are you sure? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled."
        exit 0
    fi
else
    echo -e "${BLUE}Running dry run (no tokens will be modified)${NC}"
fi

echo ""
echo -e "Calling: ${GREEN}${FUNCTION_URL}${NC}"
echo ""

RESPONSE=$(curl -s -X POST \
  "${FUNCTION_URL}" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -d "{\"dry_run\": ${DRY_RUN}}")

echo "Response:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
echo ""

