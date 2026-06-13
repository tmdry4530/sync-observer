-- The workspace missions aggregation (missionRoutes list query) filters events
-- per context with `where context_id = ? and visible_to_user`. The 0018 index
-- (context_id, seq) does not cover the visible_to_user predicate, so add a
-- partial index over the visible rows to keep the list poll cheap.
create index if not exists a2a_task_events_context_visible_idx
  on a2a_task_events (context_id) where visible_to_user;
