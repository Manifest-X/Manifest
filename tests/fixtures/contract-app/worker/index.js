import { limits, validateTask } from '../shared/contract.js'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/api/limits') return json(limits)
    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      const task = await request.json().catch(() => ({}))
      const errors = validateTask(task)
      if (Object.keys(errors).length) return json({ errors }, 422)
      return json({ task: { title: task.title.trim(), status: task.status } }, 201)
    }
    return json({ error: 'not-found' }, 404)
  }
}
