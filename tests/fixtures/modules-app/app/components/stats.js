import { pluralize } from '@app/lib/format.js'

export function stats() {
  return {
    get text() { return pluralize(Array.isArray(this.$x.tasks) ? this.$x.tasks.length : 0, 'task') + ' in total' }
  }
}
