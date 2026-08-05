import fs from 'node:fs'
import path from 'node:path'
import type { SessionMeta } from '../shared/types'

export class Store {
  constructor(private filePath: string) {}

  load(): { sessions: SessionMeta[]; corruptBackupPath: string | null } {
    if (!fs.existsSync(this.filePath)) return { sessions: [], corruptBackupPath: null }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('sessions.json root must be an array')
      return { sessions: parsed as SessionMeta[], corruptBackupPath: null }
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      fs.renameSync(this.filePath, backup)
      return { sessions: [], corruptBackupPath: backup }
    }
  }

  save(sessions: SessionMeta[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(sessions, null, 2))
  }
}
