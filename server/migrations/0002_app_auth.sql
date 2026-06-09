-- 0002_app_auth.sql
-- App-owned authentication, replacing Supabase Auth (auth.users + profiles).

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  avatar_url text,
  color text not null default '#64748b',
  password_hash text,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index app_users_email_lower_unique
  on app_users (lower(email));

create trigger app_users_set_updated_at
before update on app_users
for each row execute function set_updated_at();

create table auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  session_token_hash text not null unique,
  user_agent text,
  ip_hash text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index auth_sessions_user_active_idx
  on auth_sessions(user_id, expires_at desc)
  where revoked_at is null;
