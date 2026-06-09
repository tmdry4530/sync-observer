-- 0010_jobs.sql
-- Postgres-backed job queue (SKIP LOCKED claim) for the agent/push workers.

create type job_status as enum ('queued', 'running', 'completed', 'failed', 'canceled');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  queue_name text not null,
  job_type text not null,
  status job_status not null default 'queued',
  payload jsonb not null,
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_claim_idx
  on jobs(queue_name, status, run_after, created_at)
  where status = 'queued';

create trigger jobs_set_updated_at
before update on jobs
for each row execute function set_updated_at();
