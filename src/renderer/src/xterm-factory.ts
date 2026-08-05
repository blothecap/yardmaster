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
      background: '#16161e',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#2f334d'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  return { term, fit }
}
