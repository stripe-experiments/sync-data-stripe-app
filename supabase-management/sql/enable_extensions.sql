-- =============================================================================
-- Enable Required Extensions for Token Sweeper Cron
-- =============================================================================
-- Run this SQL in your Supabase SQL Editor before scheduling the cron job.
-- Alternatively, enable these extensions via Dashboard > Database > Extensions.

-- pg_cron: Allows scheduling recurring jobs in PostgreSQL
-- This extension is created in pg_catalog schema by default
create extension if not exists pg_cron with schema pg_catalog;

-- pg_net: Allows making HTTP requests from PostgreSQL
-- This is used by pg_cron to call the Edge Function
create extension if not exists pg_net with schema extensions;

-- Verify extensions are enabled
select extname, extversion 
from pg_extension 
where extname in ('pg_cron', 'pg_net');

