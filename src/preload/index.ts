import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', { ping: (): string => 'pong' })
