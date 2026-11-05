import { taskForm } from '@app/components/task-form.js'

document.addEventListener('alpine:init', () => {
  Alpine.data('taskForm', taskForm)
})
