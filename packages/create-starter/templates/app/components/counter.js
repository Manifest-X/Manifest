import { plural } from '@app/lib/format.js'

export function counter() {
  return {
    count: 0,
    get label() { return plural(this.count, 'click') }
  }
}
