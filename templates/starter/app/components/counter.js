import { component } from '@app/lib/component.js'
import { plural } from '@app/lib/format.js'

export const counter = component(() => ({
  count: 0,
  get label() { return plural(this.count, 'click') }
}))
