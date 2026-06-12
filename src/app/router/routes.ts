export const routes = {
  home: '/',
  login: '/auth/login',
  contract: '/api-contract',
  workspaces: '/workspaces',
  workspace: (workspaceId = ':workspaceId') => `/w/${workspaceId}`,
  channel: (workspaceId = ':workspaceId', channelId = ':channelId') => `/w/${workspaceId}/ch/${channelId}`,
  document: (workspaceId = ':workspaceId', documentId = ':documentId') => `/w/${workspaceId}/doc/${documentId}`,
  workbench: (workspaceId = ':workspaceId', channelId = ':channelId', documentId = ':documentId') =>
    `/w/${workspaceId}/ch/${channelId}/doc/${documentId}`,
  mission: (workspaceId = ':workspaceId', contextId = ':contextId') => `/w/${workspaceId}/mission/${contextId}`,
  missions: (workspaceId = ':workspaceId') => `/w/${workspaceId}/missions`
} as const
