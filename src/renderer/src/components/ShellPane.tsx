import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { createTerm } from '../xterm-factory'
import { getTerminal, registerTerminal, unregisterTerminal } from '../terminal-registry'

interface ShellPaneProps {
  shellId: string
  visible: boolean
}

export default function ShellPane({ shellId, visible }: ShellPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const { term, fit } = createTerm()
    // handlers must exist before the first fit(), or the initial resize event is lost
    term.onData((data) => window.api.shellInput(shellId, data))
    term.onResize(({ cols, rows }) => window.api.shellResize(shellId, cols, rows))
    term.open(containerRef.current!)
    fit.fit()
    window.api.shellResize(shellId, term.cols, term.rows)
    termRef.current = term
    fitRef.current = fit

    // Replay buffered output (pane switches unmount this component; the shell keeps
    // running in main) before going live — register only after replay for ordering.
    const registryKey = `shell:${shellId}`
    let disposed = false
    window.api.shellBuffer(shellId).then((buf) => {
      if (disposed) return
      if (buf) term.write(buf)
      registerTerminal(registryKey, term)
    })

    // The initial fit can run before 'SF Mono' finishes loading; fallback-font
    // metrics overestimate rows on tall windows, clipping the bottom of the TUI.
    // Re-fit once real font metrics are in.
    document.fonts.ready.then(() => {
      if (!disposed && containerRef.current!.offsetWidth > 0) fitRef.current?.fit()
    })

    const observer = new ResizeObserver(() => {
      if (containerRef.current!.offsetWidth > 0) fitRef.current?.fit()
    })
    observer.observe(containerRef.current!)
    return () => {
      disposed = true
      observer.disconnect()
      if (getTerminal(registryKey) === term) {
        unregisterTerminal(registryKey) // disposes via the registry
      } else {
        term.dispose() // replay never completed; never registered
      }
    }
  }, [shellId])

  useEffect(() => {
    if (!visible) return
    fitRef.current?.fit()
    termRef.current?.focus()
    // second fit next frame — catches layout that settles after display flips
    const raf = requestAnimationFrame(() => fitRef.current?.fit())
    return () => cancelAnimationFrame(raf)
  }, [visible])

  return (
    <div className="shell-pane" style={{ display: visible ? 'block' : 'none' }}>
      <div ref={containerRef} className="shell-pane-term" />
    </div>
  )
}
