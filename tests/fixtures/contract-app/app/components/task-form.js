import { limits, statuses, validateTask } from '@shared/contract.js'

export function taskForm() {
  return {
    title: '',
    status: 'open',
    statuses,
    titleMax: limits.titleMax,
    errors: {},
    result: '',
    get valid() { return Object.keys(validateTask(this)).length === 0 },
    async submit() {
      this.errors = validateTask(this)
      if (!this.valid) return
      const res = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: this.title, status: this.status }) })
      const body = await res.json()
      this.errors = body.errors || {}
      this.result = res.ok ? `Saved: ${body.task.title}` : ''
    }
  }
}
