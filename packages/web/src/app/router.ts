import {
  createRouter,
  createWebHistory,
  type RouteLocation,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router'

/** The tabs of a project, in order. */
export const PROJECT_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'files', label: 'Files' },
  { id: 'outputs', label: 'Outputs' },
  { id: 'resources', label: 'Resources' },
  { id: 'settings', label: 'Settings' },
] as const

export type ProjectSection = (typeof PROJECT_SECTIONS)[number]['id']

declare module 'vue-router' {
  interface RouteMeta {
    /** Which project tab this route is, for the layout's tab strip and the breadcrumb. */
    section?: ProjectSection
    /** Breadcrumb label for non-project pages. */
    crumb?: string
  }
}

// Each screen's file.
const sectionScreens: Record<ProjectSection, () => Promise<unknown>> = {
  overview: () => import('@/screens/project/overview/OverviewScreen.vue'),
  sessions: () => import('@/screens/project/sessions/ProjectSessionsScreen.vue'),
  files: () => import('@/screens/project/files/FilesScreen.vue'),
  outputs: () => import('@/screens/project/outputs/OutputsScreen.vue'),
  resources: () => import('@/screens/project/resources/ResourcesScreen.vue'),
  settings: () => import('@/screens/project/settings/ProjectSettingsScreen.vue'),
}

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('@/screens/home/HomeScreen.vue') },
  {
    path: '/s/:id',
    name: 'session',
    meta: { crumb: 'Session' },
    props: true,
    component: () => import('@/screens/session/SessionScreen.vue'),
  },
  {
    path: '/sessions',
    alias: '/history',
    name: 'history',
    meta: { crumb: 'Sessions' },
    component: () => import('@/screens/history/HistoryScreen.vue'),
  },
  {
    path: '/projects',
    name: 'projects',
    meta: { crumb: 'Projects' },
    component: () => import('@/screens/projects/ProjectsScreen.vue'),
  },
  {
    path: '/projects/new',
    name: 'add-project',
    meta: { crumb: 'Add project' },
    component: () => import('@/screens/projects/AddProjectScreen.vue'),
  },
  {
    path: '/p/:name',
    component: () => import('@/screens/project/ProjectLayout.vue'),
    props: true,
    children: [
      { path: '', redirect: to => ({ name: 'project-overview', params: to.params }) },
      // Old tabs (D8): kept as named routes so existing links and bookmarks land on a live view. The work queue,
      // backlog and roadmap are gone; their links open the Overview.
      ...(['work', 'backlog', 'roadmap'] as const).map(id => ({
        path: id,
        name: `project-${id}`,
        redirect: (to: RouteLocation) => ({ name: 'project-overview', params: to.params }),
      })),
      {
        path: 'library',
        name: 'project-library',
        redirect: to => ({ name: 'project-resources', params: to.params, query: to.query }),
      },
      ...PROJECT_SECTIONS.map(s => ({
        path: s.id,
        name: `project-${s.id}`,
        meta: { section: s.id },
        component: sectionScreens[s.id],
      })),
    ],
  },
  {
    path: '/library',
    name: 'library',
    meta: { crumb: 'Library' },
    component: () => import('@/screens/library/LibraryScreen.vue'),
  },
  {
    path: '/library/:kind/:id',
    name: 'library-asset',
    meta: { crumb: 'Library' },
    props: true,
    component: () => import('@/screens/library/AssetScreen.vue'),
  },
  { path: '/ux/:view', name: 'ux', component: () => import('@/screens/ux/UxSweep.vue') },
  {
    path: '/mcp',
    name: 'mcp',
    meta: { crumb: 'MCP servers' },
    component: () => import('@/screens/mcp/McpScreen.vue'),
  },
  {
    path: '/compare',
    name: 'compare',
    meta: { crumb: 'Compare' },
    component: () => import('@/screens/compare/CompareScreen.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    meta: { crumb: 'Settings' },
    component: () => import('@/screens/settings/SettingsScreen.vue'),
  },
  {
    path: '/:rest(.*)*',
    name: 'not-found',
    meta: { crumb: 'Not found' },
    component: () => import('@/screens/NotFoundScreen.vue'),
  },
]

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes })
}
