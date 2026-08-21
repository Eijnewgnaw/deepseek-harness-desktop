import { describe, expect, it } from 'vitest'
import { parseWslHostArguments } from '../src/wsl-host.ts'

describe('WSL Host bootstrap arguments', () => {
  it('accepts exact Linux-owned state and DSH roots', () => {
    expect(parseWslHostArguments([
      '--state-dir', '/home/alice/.local/state/dsh-desktop',
      '--home-dir', '/home/alice/.local/share/dsh-desktop/home',
    ])).toEqual({
      stateDir: '/home/alice/.local/state/dsh-desktop',
      homeDir: '/home/alice/.local/share/dsh-desktop/home',
    })
  })

  it('rejects missing, relative, repeated, and unknown arguments', () => {
    expect(() => parseWslHostArguments([])).toThrow('--state-dir and --home-dir are required')
    expect(() => parseWslHostArguments(['--state-dir', '../state', '--home-dir', '/home/a']))
      .toThrow('absolute Linux path')
    expect(() => parseWslHostArguments([
      '--state-dir', '/state', '--state-dir', '/other', '--home-dir', '/home/a',
    ])).toThrow('unknown or repeated')
    expect(() => parseWslHostArguments(['--wat', '/state'])).toThrow('unknown or repeated')
    expect(() => parseWslHostArguments([
      '--state-dir', '/state', '--home-dir', '/home/a', '--profile', 'desktop',
    ])).toThrow('unknown or repeated')
  })
})
