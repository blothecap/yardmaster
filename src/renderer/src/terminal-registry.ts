import type { Terminal } from '@xterm/xterm'

const terminals = new Map<string, Terminal>()

export function registerTerminal(id: string, term: Terminal): void {
  terminals.set(id, term)
}

export function unregisterTerminal(id: string): void {
  terminals.get(id)?.dispose()
  terminals.delete(id)
}

export function getTerminal(id: string): Terminal | undefined {
  return terminals.get(id)
}
