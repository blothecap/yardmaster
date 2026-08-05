import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { registerTerminal, unregisterTerminal } from '../terminal-registry'

interface TerminalPaneProps {
  sessionId: string
  visible: boolean
}

export default function TerminalPane({ sessionId, visible }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
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
    term.open(containerRef.current!)
    fit.fit()
    term.onData((data) => window.api.input(sessionId, data))
    term.onResize(({ cols, rows }) => window.api.resize(sessionId, cols, rows))
    registerTerminal(sessionId, term)
    termRef.current = term
    fitRef.current = fit

    const observer = new ResizeObserver(() => {
      if (containerRef.current!.offsetWidth > 0) fitRef.current?.fit()
    })
    observer.observe(containerRef.current!)
    return () => {
      observer.disconnect()
      unregisterTerminal(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    if (visible) {
      fitRef.current?.fit()
      termRef.current?.focus()
    }
  }, [visible])

  return (
    <div
      ref={containerRef}
      className="terminal-pane"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}
