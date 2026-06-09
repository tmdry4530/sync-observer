-- 0004_participants.sql
-- Unify humans and agents under a single participant abstraction.

create type participant_type as enum ('human', 'agent');

create table participants (
  id uuid primary key default gen_random_uuid(),
  participant_type participant_type not null,
  user_id uuid references app_users(id) on delete cascade,
  agent_id uuid,
  display_name text not null,
  avatar_url text,
  color text not null default '#64748b',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint participants_exactly_one_owner check (
    (participant_type = 'human' and user_id is not null and agent_id is null)
    or
    (participant_type = 'agent' and agent_id is not null and user_id is null)
  )
);

create unique index participants_user_unique
  on participants(user_id)
  where participant_type = 'human';

create trigger participants_set_updated_at
before update on participants
for each row execute function set_updated_at();

create type workspace_member_role as enum ('owner', 'admin', 'member', 'viewer');

alter table workspace_members
  add column if not exists participant_id uuid references participants(id),
  add column if not exists member_role workspace_member_role default 'member';

create index workspace_members_participant_idx
  on workspace_members(workspace_id, participant_id);

-- Backfill human participants for existing users (no-op on a fresh database).
insert into participants (participant_type, user_id, display_name, avatar_url, color)
select 'human', u.id, u.display_name, u.avatar_url, u.color
from app_users u
where not exists (
  select 1 from participants p where p.user_id = u.id and p.participant_type = 'human'
);

update workspace_members wm
set participant_id = p.id
from participants p
where p.user_id = wm.user_id
  and p.participant_type = 'human'
  and wm.participant_id is null;

-- Owner-member trigger now also links the owner's human participant.
create or replace function add_workspace_owner_member()
returns trigger
language plpgsql
as $$
begin
  insert into workspace_members (workspace_id, user_id, role, member_role, participant_id)
  values (
    new.id,
    new.owner_id,
    'owner',
    'owner',
    (select id from participants where user_id = new.owner_id and participant_type = 'human' limit 1)
  )
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;
