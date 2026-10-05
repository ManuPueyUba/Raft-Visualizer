import type { TraceStep } from './types'

export class Tracer {
  steps: TraceStep[] = []

  line(line: string, text?: string) {
    this.steps.push({ line, kind: 'line', text })
  }

  cond(line: string, expr: string, values: string, result: boolean): boolean {
    this.steps.push({ line, kind: 'cond', expr, values, result })
    return result
  }

  set(line: string, name: string, value: unknown) {
    this.steps.push({ line, kind: 'set', text: `${name} ← ${fmt(value)}` })
  }

  note(line: string, text: string) {
    this.steps.push({ line, kind: 'note', text })
  }
}

export function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' && !Number.isFinite(v)) return '∞'
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`
  return String(v)
}
