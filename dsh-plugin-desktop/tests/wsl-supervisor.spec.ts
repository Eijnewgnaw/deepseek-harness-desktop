import { describe, expect, it, vi } from 'vitest'
import {
  prepareWslHostRuntime,
  WslHostHandle,
  type WslHostExit,
} from '../src/wsl-supervisor.ts'
import type { DesktopCommandCapture, DesktopCommandResult } from '../src/wsl.ts'

function result(stdout = '', exitCode = 0, stderr = ''): DesktopCommandResult {
  return {
    exitCode,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  }
}

describe('managed WSL Host runtime', () => {
  it('uses an already verified exact-version runtime without npm mutation', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v22.19.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      return result()
    })
    const runtime = await prepareWslHostRuntime({
      distribution: 'Ubuntu-24.04', productVersion: '2.0.2', capture,
    })

    expect(runtime.installed).toBe(false)
    expect(runtime.hostEntryPath).toBe(
      '/home/alice/.local/share/dsh-desktop/runtime/2.0.2/node_modules/dsh-plugin-desktop/lib/wsl-host.js',
    )
    expect(capture.mock.calls.some(call => call[1].includes('install'))).toBe(false)
  })

  it('installs an exact package without a shell and verifies it before launch', async () => {
    let verifyCount = 0
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args, _options) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v24.1.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      if (args.includes('install')) return result('added packages')
      verifyCount += 1
      return result('', verifyCount === 1 ? 2 : 0)
    })
    const runtime = await prepareWslHostRuntime({
      distribution: 'Ubuntu',
      productVersion: '2.0.2',
      packageSpecifier: '/mnt/c/DSH Desktop/dsh-plugin-desktop.tgz',
      capture,
    })

    expect(runtime.installed).toBe(true)
    const install = capture.mock.calls.find(call => call[1].includes('install'))
    expect(install?.[0]).toBe('wsl.exe')
    expect(install?.[1]).toContain('/mnt/c/DSH Desktop/dsh-plugin-desktop.tgz')
    const specifierIndex = install?.[1].indexOf('/mnt/c/DSH Desktop/dsh-plugin-desktop.tgz') ?? -1
    expect(specifierIndex).toBeGreaterThan(0)
    expect(install?.[1][specifierIndex - 1]).toBe('--')
    expect(install?.[1]).not.toContain('sh')
    expect(install?.[2]).toMatchObject({ timeoutMs: 600_000 })
    expect(verifyCount).toBe(2)
  })

  it('fails closed when npm exits unsuccessfully', async () => {
    const capture = vi.fn<DesktopCommandCapture>(async (_executable, args) => {
      if (args.includes('uname')) return result('Linux\n')
      if (args.includes('--version') && args.includes('node')) return result('v22.19.0\n')
      if (args.includes('--version') && args.includes('npm')) return result('11.6.0\n')
      if (args.includes('--version') && args.includes('bash')) return result('GNU bash, version 5.2.21\n')
      if (args.includes('sh')) return result('/home/alice')
      if (args.includes('install')) return result('', 1, 'npm failed safely')
      return result('', 2)
    })
    await expect(prepareWslHostRuntime({
      distribution: 'Ubuntu', productVersion: '2.0.2', capture,
    })).rejects.toThrow('npm failed safely')
  })

  it('arms abnormal-exit shutdown only after the remote health commit succeeds', async () => {
    let resolveExit!: (value: WslHostExit) => void
    const exited = new Promise<WslHostExit>(resolve => { resolveExit = resolve })
    const peer = {
      call: vi.fn(async () => null),
      close: vi.fn(),
    }
    const bridge = { dispose: vi.fn(async () => {}) }
    const child = {
      killed: false,
      kill: vi.fn(),
      stdin: { end: vi.fn() },
    }
    const requestQuit = vi.fn()
    const releaseControlHandlers = vi.fn()
    const handle = new WslHostHandle(
      {
        prerequisites: {
          distribution: 'Ubuntu-24.04',
          homeDir: '/home/alice',
          nodeVersion: 'v22.19.0',
          npmVersion: '11.6.0',
          bashVersion: 'GNU bash, version 5.2.21',
        },
        runtimeRoot: '/home/alice/.local/share/dsh-desktop/runtime/2.0.2',
        packageRoot: '/home/alice/.local/share/dsh-desktop/runtime/2.0.2/node_modules/dsh-plugin-desktop',
        hostEntryPath: '/home/alice/.local/share/dsh-desktop/runtime/2.0.2/node_modules/dsh-plugin-desktop/lib/wsl-host.js',
        stateDir: '/home/alice/.local/state/dsh-desktop',
        homeDir: '/home/alice/.local/share/dsh-desktop/home',
        installed: false,
      },
      {
        generationId: 'generation-1',
        profileName: 'desktop',
        profileDir: '/home/alice/.local/share/dsh-desktop/home/profiles/desktop',
        homeDir: '/home/alice/.local/share/dsh-desktop/home',
        port: 43120,
        selectedProfile: 'desktop',
      },
      peer as never,
      bridge as never,
      child as never,
      exited,
      1_000,
      requestQuit,
      releaseControlHandlers,
    )

    await handle.commitHealthy()
    expect(peer.call).toHaveBeenCalledWith('host/health.commit', { generationId: 'generation-1' })
    resolveExit({ exitCode: 0, signal: null })
    await exited
    await Promise.resolve()

    expect(requestQuit).toHaveBeenCalledWith(1)
  })
})
