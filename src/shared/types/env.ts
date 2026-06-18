export interface ClientEnv {
  apiUrl: string
  wsUrl: string
  wsAuthMode: 'off' | 'agent'
  /** Local hermes-monitor collector base URL (M2). Default 127.0.0.1:8787. */
  collectorUrl: string
}

export function readClientEnv(): ClientEnv {
  const wsUrl = import.meta.env.VITE_WS_URL?.replace(/\/$/, '') || wsUrlFromCurrentOrigin() || 'ws://localhost:1234'

  return {
    apiUrl: import.meta.env.VITE_API_URL?.replace(/\/$/, '') || httpUrlFromWsUrl(wsUrl),
    wsUrl,
    wsAuthMode: readWsAuthMode(),
    collectorUrl: import.meta.env.VITE_COLLECTOR_URL?.replace(/\/$/, '') || 'http://127.0.0.1:8787'
  }
}

function wsUrlFromCurrentOrigin(): string | null {
  if (typeof window === 'undefined') return null
  if (window.location.protocol === 'https:') return `wss://${window.location.host}`
  if (window.location.protocol === 'http:') return `ws://${window.location.host}`
  return null
}

function httpUrlFromWsUrl(wsUrl: string): string {
  if (wsUrl.startsWith('wss://')) return `https://${wsUrl.slice('wss://'.length)}`
  if (wsUrl.startsWith('ws://')) return `http://${wsUrl.slice('ws://'.length)}`
  return wsUrl
}

function readWsAuthMode(): ClientEnv['wsAuthMode'] {
  const configured = import.meta.env.VITE_WS_AUTH_MODE?.trim().toLowerCase()
  if (configured === 'off' || configured === 'agent') return configured
  return 'agent'
}
