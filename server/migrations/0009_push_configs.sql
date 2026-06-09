-- 0009_push_configs.sql
-- A2A push notification configs (webhook targets) per task.

create table a2a_push_notification_configs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references a2a_tasks(id) on delete cascade,
  config_id text not null,
  url text not null,
  auth_scheme text not null default 'Bearer',
  auth_credentials_hash text,
  authentication jsonb not null default '{}'::jsonb,
  created_by_participant_id uuid references participants(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,

  unique (task_id, config_id)
);

create index a2a_push_configs_task_idx
  on a2a_push_notification_configs(task_id)
  where deleted_at is null;
