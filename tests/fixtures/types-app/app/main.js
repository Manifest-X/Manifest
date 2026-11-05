import { session } from '@app/stores/session.js'
import { taskList } from '@app/components/task-list.js'

document.addEventListener('alpine:init', () => {
  Alpine.store('session', session())
  Alpine.data('taskList', taskList)
})
