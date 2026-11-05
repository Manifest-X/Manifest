export function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function formatDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
