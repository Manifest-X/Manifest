import { counter } from '@app/components/counter.js'

document.addEventListener('alpine:init', () => {
  Alpine.data('counter', counter)
})
