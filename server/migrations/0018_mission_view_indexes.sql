-- Mission View reads a2a_task_events by context (listEventsByContext and the
-- workspace missions aggregation).  The table previously had only (seq) and
-- (task_id, seq) indexes, so every context read full-scanned the event log.
create index if not exists a2a_task_events_context_seq_idx
  on a2a_task_events (context_id, seq);
