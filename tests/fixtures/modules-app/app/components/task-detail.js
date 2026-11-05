import { formatDate } from '@app/lib/format.js'
import { byId } from '@app/lib/tasks.mjs'

export function taskDetail() {
  return {
    get task() {
      const tasks = Array.isArray(this.$x.tasks) ? this.$x.tasks : []
      return byId(tasks, this.$route.split('/').filter(Boolean)[1])
    },
    get due() { return this.task ? `Due ${formatDate(this.task.due)}` : '' },
    get starred() { return !!this.task && this.$store.session.isStarred(this.task.id) }
  }
}
