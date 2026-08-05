import { app, BrowserWindow } from 'electron'
import path from 'node:path'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Claude Terminal',
    backgroundColor: '#16161e',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
