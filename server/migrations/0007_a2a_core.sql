-- 0007_a2a_core.sql
-- A2A contexts, tasks, messages, artifacts, and ordered task events.

create type a2a_task_state as enum (
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED'
);

create table a2a_contexts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  channel_id uuid references channels(id) on delete set null,
  document_id uuid references documents(id) on delete set null,
  created_by_participant_id uuid references participants(id),
  external_context_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index a2a_contexts_workspace_idx
  on a2a_contexts(workspace_id, created_at desc);

create trigger a2a_contexts_set_updated_at
before update on a2a_contexts
for each row execute function set_updated_at();

create table a2a_tasks (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references a2a_contexts(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  channel_id uuid references channels(id) on delete set null,
  document_id uuid references documents(id) on delete set null,
  agent_id uuid not null references agents(id) on delete cascade,
  title text,
  status_state a2a_task_state not null default 'TASK_STATE_SUBMITTED',
  status_message jsonb,
  status_updated_at timestamptz not null default now(),
  accepted_output_modes text[] not null default array['text/plain'],
  metadata jsonb not null default '{}'::jsonb,
  created_by_participant_id uuid references participants(id),
  external_task_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index a2a_tasks_context_updated_idx
  on a2a_tasks(context_id, status_updated_at desc);

create index a2a_tasks_workspace_updated_idx
  on a2a_tasks(workspace_id, status_updated_at desc);

create index a2a_tasks_status_idx
  on a2a_tasks(status_state, status_updated_at desc);

create trigger a2a_tasks_set_updated_at
before update on a2a_tasks
for each row execute function set_updated_at();

create type a2a_message_role as enum ('ROLE_USER', 'ROLE_AGENT');

create table a2a_messages (
  id uuid primary key default gen_random_uuid(),
  message_id text not null,
  task_id uuid references a2a_tasks(id) on delete cascade,
  context_id uuid not null references a2a_contexts(id) on delete cascade,
  role a2a_message_role not null,
  participant_id uuid references participants(id),
  parts jsonb not null,
  extensions text[] not null default array[]::text[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  unique(context_id, message_id)
);

create index a2a_messages_task_created_idx
  on a2a_messages(task_id, created_at asc);

create index a2a_messages_context_idx
  on a2a_messages(context_id, created_at asc);

create table a2a_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references a2a_tasks(id) on delete cascade,
  artifact_id text not null,
  name text,
  description text,
  parts jsonb not null,
  extensions text[] not null default array[]::text[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (task_id, artifact_id)
);

create index a2a_artifacts_task_idx
  on a2a_artifacts(task_id, created_at asc);

create trigger a2a_artifacts_set_updated_at
before update on a2a_artifacts
for each row execute function set_updated_at();

create type a2a_event_type as enum (
  'task_snapshot',
  'message',
  'status_update',
  'artifact_update',
  'push_delivery',
  'debug'
);

create table a2a_task_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  task_id uuid not null references a2a_tasks(id) on delete cascade,
  context_id uuid not null references a2a_contexts(id) on delete cascade,
  event_type a2a_event_type not null,
  payload jsonb not null,
  visible_to_user boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index a2a_task_events_seq_unique
  on a2a_task_events(seq);

create index a2a_task_events_task_seq_idx
  on a2a_task_events(task_id, seq asc);
