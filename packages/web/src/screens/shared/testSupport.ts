// Shared by the 2j screen tests: mount a project tab on the mock API with the providers the app shell gives it.
import { computed, type Component } from 'vue'
import { mount } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { API_KEY } from '@/api'
import { createMockApi, type MockApi } from '@/api/mock'
import { createProjectsStore, PROJECTS_KEY } from '@/app/projects'
import { createSessionsStore, SESSIONS_KEY } from '@/app/sessions'
import { createAppRouter } from '@/app/router'
import { PROJECT_KEY } from '@/screens/project/useProject'

export async function mountProjectScreen(
  component: Component,
  path: string,
  api: MockApi = createMockApi(),
  project = 'odin',
) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  const detail = await api.getProject(project)
  const wrapper = mount(component, {
    attachTo: document.body,
    global: {
      plugins: [router],
      provide: {
        [API_KEY as symbol]: api,
        [PROJECTS_KEY as symbol]: createProjectsStore(api),
        [SESSIONS_KEY as symbol]: createSessionsStore(api),
        [PROJECT_KEY as symbol]: {
          detail: computed(() => detail),
          setDetail: () => {},
          reload: async () => {},
        },
      },
    },
  })
  return { api, router, wrapper }
}

/** Mount a screen that doesn't need a project route (Home, History, forms) with the app shell's providers. */
export async function mountScreen(
  component: Component,
  path: string,
  api: MockApi = createMockApi(),
  props: Record<string, unknown> = {},
) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  const projects = createProjectsStore(api)
  const sessions = createSessionsStore(api)
  projects.start()
  sessions.start()
  const wrapper = mount(component, {
    attachTo: document.body,
    props,
    global: {
      plugins: [router],
      provide: {
        [API_KEY as symbol]: api,
        [PROJECTS_KEY as symbol]: projects,
        [SESSIONS_KEY as symbol]: sessions,
      },
    },
  })
  return { api, router, wrapper, projects, sessions }
}
