export const tables = {
  tasks: { database: 'main', id: 'tasks', columns: ['title', 'status', 'due', 'workspaceId'] },
  workspaces: { database: 'main', id: 'workspaces', columns: ['name', 'plan'] }
}

export const statuses = ['open', 'blocked', 'done']

export const limits = {
  titleMax: 80,
  tasksPerWorkspace: { free: 50, pro: 5000 }
}

export function validateTask(task) {
  const errors = {}
  const title = typeof task.title === 'string' ? task.title.trim() : ''
  if (!title) errors.title = 'required'
  else if (title.length > limits.titleMax) errors.title = 'too-long'
  if (!statuses.includes(task.status)) errors.status = 'unknown-status'
  return errors
}
