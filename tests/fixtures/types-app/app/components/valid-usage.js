import { component } from '@app/lib/component.js'

document.addEventListener('alpine:init', () => {
  Alpine.store('cart', { items: [], add(p) { this.items.push(p) } })
  Alpine.data('validUsage', validUsage)
})

export const validUsage = component(() => ({
  get cartSize() { return Alpine.store('cart').items.length + this.$store.cart.items.length },
  get chained() { return this.$x.team.$search('a', 'name').$query([['equal', 'role', 'lead']]).length },
  get registered() { return this.$x.later && this.$x.later.length },
  focus() { this.$refs.input.value = '' },
  async rename(id) {
    const row = await this.$x.tasks.$update(id, { title: 'Renamed' })
    return row.title
  },
  async renameMany() {
    const rows = await this.$x.tasks.$update([{ id: 'a', data: { status: 'done' } }])
    return rows.length
  },
  async pages() { const p = await this.$x.tasks.$page(2, 10); return p.totalPages }
}))
