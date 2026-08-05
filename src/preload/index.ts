import { contextBridge, ipcRenderer } from 'electron'
import type { SessionView, ShortcutAction } from '../shared/types'

export interface InitState {
  claudeFound: boolean
  corruptBackupPath: string | null
  home: string
  sessions: SessionView[]
}

const api = {
  init: (): Promise<InitState> => ipcRenderer.invoke('app:init'),
  create: (name: string, cwd: string): Promise<SessionView> =>
    ipcRenderer.invoke('sessions:create', { name, cwd }),
  activate: (id: string): Promise<void> => ipcRenderer.invoke('sessions:activate', id),
  setActive: (id: string | null): Promise<void> => ipcRenderer.invoke('sessions:setActive', id),
  rename: (id: string, name: string): Promise<void> => ipcRenderer.invoke('sessions:rename', { id, name }),
  close: (id: string): Promise<void> => ipcRenderer.invoke('sessions:close', id),
  remove: (id: string): Promise<void> => ipcRenderer.invoke('sessions:remove', id),
  reorder: (ids: string[]): Promise<void> => ipcRenderer.invoke('sessions:reorder', ids),
  input: (id: string, data: string): void => ipcRenderer.send('sessions:input', { id, data }),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('sessions:resize', { id, cols, rows }),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('app:pickDirectory'),
  onChanged: (cb: (views: SessionView[]) => void): void => {
    ipcRenderer.on('sessions:changed', (_e, views) => cb(views))
  },
  onData: (cb: (id: string, data: string) => void): void => {
    ipcRenderer.on('sessions:data', (_e, { id, data }) => cb(id, data))
  },
  onFocus: (cb: (id: string) => void): void => {
    ipcRenderer.on('sessions:focus', (_e, id) => cb(id))
  },
  onShortcut: (cb: (action: ShortcutAction) => void): void => {
    ipcRenderer.on('app:shortcut', (_e, action) => cb(action))
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
