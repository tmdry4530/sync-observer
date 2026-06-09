-- 0011_audit_logs.sql
-- Audit log for destructive and security-sensitive actions.

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete set null,
  actor_participant_id uuid references participants(id),
  action text not null,
  resource_type text not null,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index audit_logs_workspace_created_idx
  on audit_logs(workspace_id, created_at desc);
