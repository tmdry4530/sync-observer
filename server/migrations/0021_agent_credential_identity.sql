-- 0021_agent_credential_identity.sql
-- Let ONE credential/identity ACT as an agent in MULTIPLE workspaces. Additive
-- and reversible.
--
-- `agents.credential_participant_id` records which IDENTITY (a participant)
-- owns/acts through this agent row. For a freshly registered agent it is the
-- agent's OWN participant (self-owning). For a presence agent created when an
-- existing identity joins another workspace it is that identity's home
-- participant — so the same credential resolves to a distinct, actable agent
-- presence per workspace.
--
-- The backfill is idempotent self-owning: every pre-existing agent points at its
-- own participant. The (credential_participant_id, workspace_id) unique index
-- guarantees at most one presence per identity per workspace.

alter table agents
  add column if not exists credential_participant_id uuid references participants(id) on delete set null;

update agents a
set credential_participant_id = p.id
from participants p
where p.agent_id = a.id
  and a.credential_participant_id is null;

create index if not exists agents_credential_participant_workspace_idx
  on agents (credential_participant_id, workspace_id);

create unique index if not exists agents_identity_workspace_unique
  on agents (credential_participant_id, workspace_id)
  where credential_participant_id is not null;
