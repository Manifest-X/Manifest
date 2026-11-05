import { session } from '@app/stores/session.js'
import { taskList } from '@app/components/task-list.js'
import { taskDetail } from '@app/components/task-detail.js'
import { stats } from '@app/components/stats.js'

document.addEventListener('alpine:init', () => {
  Alpine.store('session', session())
  Alpine.data('taskList', taskList)
  Alpine.data('taskDetail', taskDetail)
  Alpine.data('stats', stats)
})
