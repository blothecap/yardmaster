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
  contextMenu: (id: string): void => ipcRenderer.send('sessions:contextMenu', id),
  shellEnsure: (id: string): Promise<boolean> => ipcRenderer.invoke('shell:ensure', id),
  shellIsRunning: (id: string): Promise<boolean> => ipcRenderer.invoke('shell:isRunning', id),
  shellInput: (id: string, data: string): void => ipcRenderer.send('shell:input', { id, data }),
  shellResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('shell:resize', { id, cols, rows }),
  onShellData: (cb: (id: string, data: string) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, p: { id: string; data: string }): void => cb(p.id, p.data)
    ipcRenderer.on('shell:data', h)
    return () => ipcRenderer.removeListener('shell:data', h)
  },
  onShellExit: (cb: (id: string) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('shell:exit', h)
    return () => ipcRenderer.removeListener('shell:exit', h)
  },
  onStartRename: (cb: (id: string) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('sessions:startRename', h)
    return () => ipcRenderer.removeListener('sessions:startRename', h)
  },
  onChanged: (cb: (views: SessionView[]) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, views: SessionView[]): void => cb(views)
    ipcRenderer.on('sessions:changed', h)
    return () => ipcRenderer.removeListener('sessions:changed', h)
  },
  onData: (cb: (id: string, data: string) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, p: { id: string; data: string }): void => cb(p.id, p.data)
    ipcRenderer.on('sessions:data', h)
    return () => ipcRenderer.removeListener('sessions:data', h)
  },
  onFocus: (cb: (id: string) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('sessions:focus', h)
    return () => ipcRenderer.removeListener('sessions:focus', h)
  },
  onShortcut: (cb: (action: ShortcutAction) => void): (() => void) => {
    const h = (_e: Electron.IpcRendererEvent, action: ShortcutAction): void => cb(action)
    ipcRenderer.on('app:shortcut', h)
    return () => ipcRenderer.removeListener('app:shortcut', h)
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
