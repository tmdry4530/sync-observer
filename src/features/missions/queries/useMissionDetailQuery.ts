import { useQuery } from '@tanstack/react-query'
import { getBackendJson } from '../../../shared/api/backendClient'
import { realtimePolling } from '../../realtime/queryPolling'
import type { MissionDetailResponse } from '../../../shared/types/missions'

export const missionKeys = {
  all: ['missions'] as const,
  detail: (contextId: string) => [...missionKeys.all, 'detail', contextId] as const,
  list: (workspaceId: string) => [...missionKeys.all, 'list', workspaceId] as const
}

export function useMissionDetailQuery(contextId: string | null | undefined) {
  return useQuery({
    queryKey: contextId ? missionKeys.detail(contextId) : ['missions', 'detail', 'missing'],
    queryFn: () =>
      getBackendJson<MissionDetailResponse>(
        `/api/missions/${encodeURIComponent(contextId!)}`
      ),
    enabled: Boolean(contextId),
    staleTime: 1_000,
    refetchInterval: realtimePolling.refetchInterval
  })
}
