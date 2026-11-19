// Whether the New project dialog is open, and which way it opens. One dialog for the whole app, mounted in App.vue;
// the palette, the sidebar, the Projects page and /projects/new all just call `openNewProject`.
import { ref } from 'vue'
import type { NewProjectMode } from '@/screens/projects/newProjectForm'

export const newProjectOpen = ref(false)
export const newProjectMode = ref<NewProjectMode>('new')

export function openNewProject(mode: NewProjectMode = 'new') {
  newProjectMode.value = mode
  newProjectOpen.value = true
}
