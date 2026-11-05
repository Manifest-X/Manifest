export function openTasks(tasks) {
  return tasks.filter(t => !t.done)
}

export function matches(task, query) {
  return !query || task.title.toLowerCase().includes(query.toLowerCase())
}

export function byId(tasks, id) {
  return tasks.find(t => String(t.id) === String(id)) || null
}
