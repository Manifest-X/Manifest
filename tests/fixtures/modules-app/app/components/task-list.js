import { pluralize } from '@app/lib/format.js'
import { openTasks, matches } from '@app/lib/tasks.mjs'

export function taskList() {
  return {
    query: '',
    get tasks() { return Array.isArray(this.$x.tasks) ? this.$x.tasks : [] },
    get visible() { return this.tasks.filter(t => matches(t, this.query)) },
    get summary() { return `${pluralize(openTasks(this.tasks).length, 'open task')} of ${this.tasks.length}` },
    label(task) { return (task.done ? '✓ ' : '') + task.title }
  }
}
