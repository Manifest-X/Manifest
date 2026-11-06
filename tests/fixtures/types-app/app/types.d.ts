import type { Task } from '../shared/model.js'
import type { Session } from './stores/session.js'

declare module 'mnfst' {
  interface ManifestRows { tasks: Task }
  interface ManifestStores { session: Session }
}
