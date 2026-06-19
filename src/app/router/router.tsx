import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { routes } from './routes'

// Single-page local tool: the only product is the hermes activity monitor.
// `/` redirects into it; everything else is a 404.
const MonitorPage = lazy(() => import('../../pages/monitor/MonitorPage').then((module) => ({ default: module.MonitorPage })))
const NotFoundPage = lazy(() => import('../../pages/not-found/NotFoundPage').then((module) => ({ default: module.NotFoundPage })))

function lazyPage(element: ReactNode) {
  return <Suspense fallback={<div className="page-state">화면을 불러오는 중...</div>}>{element}</Suspense>
}

export const router = createBrowserRouter([
  { path: routes.home, element: <Navigate to={routes.monitor} replace /> },
  { path: routes.monitor, element: lazyPage(<MonitorPage />) },
  { path: '*', element: lazyPage(<NotFoundPage />) }
])
