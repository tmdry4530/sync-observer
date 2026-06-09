-- 0012_indexes.sql
-- Cross-cutting indexes not declared inline with their tables.

create index participants_agent_idx
  on participants(agent_id)
  where participant_type = 'agent';

create index messages_agent_idx
  on messages(agent_id)
  where agent_id is not null;

create index jobs_status_idx
  on jobs(status, updated_at desc);
