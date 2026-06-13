import { useQuery } from '@tanstack/react-query'
import { getBackendJson } from '../../../shared/api/backendClient'
import { missionKeys } from './useMissionDetailQuery'
import type { WorkspaceMissionsResponse } from '../../../shared/types/missions'

// The mission LIST does not need realtime (1.5s) freshness — a slower poll keeps
// the aggregation query cost down. The detail view still uses realtimePolling.
const MISSION_LIST_REFETCH_INTERVAL = 10_000

export function useWorkspaceMissionsQuery(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: workspaceId ? missionKeys.list(workspaceId) : ['missions', 'list', 'missing'],
    queryFn: () =>
      getBackendJson<WorkspaceMissionsResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId!)}/missions`
      ),
    enabled: Boolean(workspaceId),
    staleTime: 5_000,
    refetchInterval: MISSION_LIST_REFETCH_INTERVAL
  })
}
