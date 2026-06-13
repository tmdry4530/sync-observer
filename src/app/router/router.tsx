import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import { HomePage } from '../../pages/home/HomePage'
import { routes } from './routes'

const LoginPage = lazy(() => import('../../pages/auth/LoginPage').then((module) => ({ default: module.LoginPage })))
const ContractPage = lazy(() => import('../../pages/docs/ContractPage').then((module) => ({ default: module.ContractPage })))
const NotFoundPage = lazy(() => import('../../pages/not-found/NotFoundPage').then((module) => ({ default: module.NotFoundPage })))
const WorkspacePage = lazy(() => import('../../pages/workspace/WorkspacePage').then((module) => ({ default: module.WorkspacePage })))
const ProtectedAppRoute = lazy(() => import('./ProtectedAppRoute').then((module) => ({ default: module.ProtectedAppRoute })))
const WorkspaceSplitPage = lazy(() => import('../../pages/workspace/WorkspaceSplitPage').then((module) => ({ default: module.WorkspaceSplitPage })))
const WorkspaceShell = lazy(() => import('../../features/workspace/components/WorkspaceShell').then((module) => ({ default: module.WorkspaceShell })))
const MissionView = lazy(() => import('../../features/missions/components/MissionView').then((module) => ({ default: module.MissionView })))
const MissionList = lazy(() => import('../../features/missions/components/MissionList').then((module) => ({ default: module.MissionList })))

function lazyPage(element: ReactNode) {
  return <Suspense fallback={<div className="page-state">화면을 불러오는 중...</div>}>{element}</Suspense>
}

export const router = createBrowserRouter([
  { path: routes.home, element: <HomePage /> },
  { path: routes.contract, element: lazyPage(<ContractPage />) },
  { path: routes.login, element: lazyPage(<LoginPage />) },
  {
    element: lazyPage(<ProtectedAppRoute />),
    children: [
      { path: routes.workspaces, element: lazyPage(<WorkspacePage />) },
      {
        path: '/w/:workspaceId',
        element: lazyPage(<WorkspaceShell />),
        children: [
          { index: true, element: lazyPage(<WorkspaceSplitPage />) },
          { path: 'ch/:channelId', element: lazyPage(<WorkspaceSplitPage />) },
          { path: 'doc/:documentId', element: lazyPage(<WorkspaceSplitPage />) },
          { path: 'ch/:channelId/doc/:documentId', element: lazyPage(<WorkspaceSplitPage />) },
          // Mission pages live INSIDE the shell: they need the sidebar/nav,
          // workspace membership gating, realtime wiring, and store sync.
          { path: 'missions', element: lazyPage(<MissionList />) },
          { path: 'mission/:contextId', element: lazyPage(<MissionView />) }
        ]
      }
    ]
  },
  { path: '*', element: lazyPage(<NotFoundPage />) }
])
