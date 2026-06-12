import { useQuery } from '@tanstack/react-query'
import { getBackendJson } from '../../../shared/api/backendClient'
import { realtimePolling } from '../../realtime/queryPolling'
import { missionKeys } from './useMissionDetailQuery'
import type { WorkspaceMissionsResponse } from '../../../shared/types/missions'

export function useWorkspaceMissionsQuery(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: workspaceId ? missionKeys.list(workspaceId) : ['missions', 'list', 'missing'],
    queryFn: () =>
      getBackendJson<WorkspaceMissionsResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId!)}/missions`
      ),
    enabled: Boolean(workspaceId),
    staleTime: 5_000,
    refetchInterval: realtimePolling.refetchInterval
  })
}
