/**
 * @typedef {'open' | 'blocked' | 'done'} Status
 * @typedef {{ title: string, status: Status, due: string | null, workspaceId: string }} Task
 */

export const tables = {
  tasks: { database: 'main', id: 'tasks', columns: ['title', 'status', 'due', 'workspaceId'] },
  workspaces: { database: 'main', id: 'workspaces', columns: ['name', 'plan'] }
}

/** @type {Status[]} */
export const statuses = ['open', 'blocked', 'done']

/** @type {{ titleMax: number }} */
export const limits = { titleMax: 80 }

/**
 * @param {Partial<Task>} task
 * @returns {Partial<Record<keyof Task, string>>}
 */
export function validateTask(task) {
  const errors = {}
  if (!task.title || !task.title.trim()) errors.title = 'required'
  else if (task.title.length > limits.titleMax) errors.title = 'too-long'
  if (!statuses.includes(task.status)) errors.status = 'unknown-status'
  return errors
}
