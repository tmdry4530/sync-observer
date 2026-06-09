-- 0006_messages_author.sql
-- Move message authorship from a single user_id to the participant author model.

alter table messages
  add column if not exists author_participant_id uuid references participants(id),
  add column if not exists author_type participant_type,
  add column if not exists agent_id uuid references agents(id),
  add column if not exists a2a_message_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Backfill author columns from existing user_id (no-op on a fresh database).
update messages m
set
  author_type = 'human',
  author_participant_id = p.id
from participants p
where p.user_id = m.user_id
  and p.participant_type = 'human'
  and m.author_participant_id is null;

alter table messages
  alter column author_type set not null;

-- user_id is now legacy/deprecated: agent-authored messages have no app_user,
-- so authorship is carried by author_participant_id + author_type instead.
alter table messages
  alter column user_id drop not null;

create index messages_author_participant_id_idx
  on messages(author_participant_id);

create index messages_channel_created_idx
  on messages(channel_id, created_at desc);
