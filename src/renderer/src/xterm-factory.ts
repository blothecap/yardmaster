import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function createTerm(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: "'SF Mono', 'Menlo', monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    theme: {
      background: '#0f0f0f',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
      selectionBackground: '#333333'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  return { term, fit }
}
