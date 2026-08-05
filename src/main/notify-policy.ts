import type { SessionStatus } from '../shared/types'

export interface Transition {
  id: string
  name: string
  from: SessionStatus
  to: SessionStatus
}

/** Notify only for background sessions finishing work or needing input. */
export function shouldNotify(t: Transition, activeId: string | null): boolean {
  if (t.id === activeId) return false
  if (t.from !== 'working') return false
  return t.to === 'needs-you' || t.to === 'idle'
}
