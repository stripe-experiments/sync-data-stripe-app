-- =============================================================================
-- Schedule Token Sweeper Cron Job
-- =============================================================================
-- This SQL creates a cron job that runs every 30 minutes and calls
-- the token-sweeper Edge Function to refresh expiring OAuth tokens.
--
-- BEFORE RUNNING: Replace these placeholders:
--   YOUR_PROJECT_REF  -> Your Supabase project reference (e.g., "xyzcompany")
--   YOUR_ANON_KEY     -> Your Supabase anon key (from Settings > API)
-- =============================================================================

-- First, remove any existing job with this name (safe to run multiple times)
select cron.unschedule('token_sweeper_30m')
where exists (
  select 1 from cron.job where jobname = 'token_sweeper_30m'
);

-- Schedule the token sweeper to run every 30 minutes
select cron.schedule(
  'token_sweeper_30m',           -- Job name
  '*/30 * * * *',                -- Cron expression: every 30 minutes
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/token-sweeper',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_ANON_KEY'
    ),
    body := jsonb_build_object(
      'triggered_by', 'pg_cron',
      'dry_run', false
    )
  ) as request_id;
  $$
);

-- Verify the job was created
select jobid, jobname, schedule, command 
from cron.job 
where jobname = 'token_sweeper_30m';

-- =============================================================================
-- Useful queries for monitoring
-- =============================================================================

-- View recent job runs:
-- select * from cron.job_run_details 
-- where jobid = (select jobid from cron.job where jobname = 'token_sweeper_30m')
-- order by start_time desc 
-- limit 20;

-- Pause the job:
-- select cron.unschedule('token_sweeper_30m');

-- Check all scheduled jobs:
-- select * from cron.job;

