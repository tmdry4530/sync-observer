-- 0021_agent_credential_identity.down.sql
-- Manual rollback for 0021. The migration runner ignores *.down.sql files
-- (loadMigrationFiles filters them out); this is for hand-run reversal only,
-- matching the 0020 pattern.

drop index if exists agents_identity_workspace_unique;
drop index if exists agents_credential_participant_workspace_idx;

alter table agents drop column if exists credential_participant_id;
