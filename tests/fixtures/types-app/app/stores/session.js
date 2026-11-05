/** @typedef {{ starred: string[], toggle(id: string): void, readonly summary: string }} Session */

/** @returns {Session} */
export function session() {
  return {
    starred: [],
    toggle(id) {
      this.starred = this.starred.includes(id) ? this.starred.filter(s => s !== id) : [...this.starred, id]
    },
    get summary() { return `${this.starred.length} starred` }
  }
}
