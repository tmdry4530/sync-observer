-- 0008_yjs_snapshots.sql
-- Persist Yjs document snapshots in Postgres instead of the local filesystem.

create table yjs_document_snapshots (
  room_name text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  state_update bytea not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index yjs_document_snapshots_document_idx
  on yjs_document_snapshots(document_id);
