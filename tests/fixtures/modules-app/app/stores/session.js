import { pluralize } from '@app/lib/format.js'

const KEY = 'modules-app:starred'

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || [] } catch { return [] }
}

export function session() {
  return {
    starred: read(),
    isStarred(id) { return this.starred.includes(id) },
    toggle(id) {
      this.starred = this.isStarred(id) ? this.starred.filter(s => s !== id) : [...this.starred, id]
      try { localStorage.setItem(KEY, JSON.stringify(this.starred)) } catch { }
    },
    get summary() { return `${pluralize(this.starred.length, 'task')} starred` }
  }
}
