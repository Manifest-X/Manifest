import { component } from '@app/lib/component.js'
import { validateTask } from '@shared/contract.js'

export const taskList = component(() => ({
  query: '',
  title: '',
  /** @type {Record<string, string>} */
  errors: {},
  get visible() { return this.$x.tasks.$search(this.query, 'title') },
  get open() { return this.visible.filter(t => t.status === 'open').length },
  get workspaceNames() { return this.$x.workspaces.map(w => w.name) },
  get lead() { return this.$x.team.find(m => m.role === 'lead')?.name },
  get starred() { return this.$store.session.summary },
  async showOpen() { await this.$x.tasks.$query([['equal', 'status', 'open'], ['orderDesc', '$createdAt']]) },
  async more() { const page = await this.$x.tasks.$first(20); return page.hasMore },
  async add() {
    this.errors = validateTask({ title: this.title, status: 'open' })
    if (Object.keys(this.errors).length) return
    const task = await this.$x.tasks.$create({ title: this.title, status: 'open' })
    this.$toast.positive(`Added ${task.title}`)
  },
  /** @param {string} id */
  async finish(id) { await this.$x.tasks.$update(id, { status: 'done' }) },
  async loadMore() { if (this.$x.tasks.$hasMore) await this.$x.tasks.$more() },
  isSaving(id) { return this.$x.tasks.$saving(id) || this.$x.tasks.$pending > 0 }
}))
