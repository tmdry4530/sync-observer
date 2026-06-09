-- 0003_core_schema.sql
-- Self-owned core collaboration schema (previously provided by Supabase public schema).
-- References app_users instead of profiles/auth.users. Authorization is app-owned (no RLS).

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  owner_id uuid not null references app_users(id) on delete cascade,
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index idx_workspace_members_user_id on workspace_members(user_id);

create table channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid not null references app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create index idx_channels_workspace_id on channels(workspace_id);

create table documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  created_by uuid not null references app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_documents_workspace_id_updated_at on documents(workspace_id, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete restrict,
  content text not null check (char_length(content) between 1 and 4000),
  client_id text,
  created_at timestamptz not null default now()
);

create index idx_messages_channel_id_created_at on messages(channel_id, created_at desc, id desc);

create unique index idx_messages_channel_client_id_unique
  on messages(channel_id, client_id)
  where client_id is not null;

create trigger documents_set_updated_at
before update on documents
for each row execute function set_updated_at();

create or replace function add_workspace_owner_member()
returns trigger
language plpgsql
as $$
begin
  insert into workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

create trigger workspaces_add_owner_member
after insert on workspaces
for each row execute function add_workspace_owner_member();
