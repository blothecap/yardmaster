import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { createTerm } from '../xterm-factory'
import { registerTerminal, unregisterTerminal } from '../terminal-registry'

interface ShellPaneProps {
  sessionId: string
  visible: boolean
}

export default function ShellPane({ sessionId, visible }: ShellPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const { term, fit } = createTerm()
    term.open(containerRef.current!)
    fit.fit()
    term.onData((data) => window.api.shellInput(sessionId, data))
    term.onResize(({ cols, rows }) => window.api.shellResize(sessionId, cols, rows))
    const registryKey = `shell:${sessionId}`
    registerTerminal(registryKey, term)
    termRef.current = term
    fitRef.current = fit

    const observer = new ResizeObserver(() => {
      if (containerRef.current!.offsetWidth > 0) fitRef.current?.fit()
    })
    observer.observe(containerRef.current!)
    return () => {
      observer.disconnect()
      unregisterTerminal(registryKey)
    }
  }, [sessionId])

  useEffect(() => {
    if (visible) {
      fitRef.current?.fit()
      termRef.current?.focus()
    }
  }, [visible])

  return (
    <div className="shell-pane" style={{ display: visible ? 'block' : 'none' }}>
      <div ref={containerRef} className="shell-pane-term" />
    </div>
  )
}
