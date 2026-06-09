-- 0005_agents.sql
-- Workspace agents and their hashed access tokens.

create type agent_role as enum (
  'planner',
  'builder',
  'reviewer',
  'doc_writer',
  'orchestrator'
);

create type agent_runtime_status as enum (
  'idle',
  'running',
  'waiting_for_input',
  'auth_required',
  'failed',
  'disabled'
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  display_name text not null,
  description text,
  role agent_role not null,
  status agent_runtime_status not null default 'idle',
  model_provider text,
  model_name text,
  system_policy jsonb not null default '{}'::jsonb,
  agent_card jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, slug)
);

create index agents_workspace_idx on agents(workspace_id);

create trigger agents_set_updated_at
before update on agents
for each row execute function set_updated_at();

alter table participants
  add constraint participants_agent_fk
  foreign key (agent_id) references agents(id) on delete cascade;

create table agent_tokens (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  token_hash text not null unique,
  scopes text[] not null default array[]::text[],
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index agent_tokens_agent_idx
  on agent_tokens(agent_id)
  where revoked_at is null;
