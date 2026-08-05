import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { createTerm } from '../xterm-factory'
import { getTerminal, registerTerminal, unregisterTerminal } from '../terminal-registry'

interface TerminalPaneProps {
  sessionId: string
  visible: boolean
}

export default function TerminalPane({ sessionId, visible }: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const { term, fit } = createTerm()
    // handlers must exist before the first fit(), or the initial resize event is lost
    term.onData((data) => window.api.input(sessionId, data))
    term.onResize(({ cols, rows }) => window.api.resize(sessionId, cols, rows))
    term.open(containerRef.current!)
    fit.fit()
    window.api.resize(sessionId, term.cols, term.rows)
    termRef.current = term
    fitRef.current = fit

    // Replay buffered output (renderer reloads, panes mounting after spawn) before
    // going live — registering only after replay keeps ordering sane.
    let disposed = false
    window.api.buffer(sessionId).then((buf) => {
      if (disposed) return
      if (buf) term.write(buf)
      registerTerminal(sessionId, term)
    })

    const observer = new ResizeObserver(() => {
      if (containerRef.current!.offsetWidth > 0) fitRef.current?.fit()
    })
    observer.observe(containerRef.current!)
    return () => {
      disposed = true
      observer.disconnect()
      if (getTerminal(sessionId) === term) {
        unregisterTerminal(sessionId) // disposes the term via the registry
      } else {
        term.dispose() // replay never completed; term was never registered
      }
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
