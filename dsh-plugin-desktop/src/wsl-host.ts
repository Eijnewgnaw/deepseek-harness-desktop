/** Linux entry that owns the complete DSH Host while Electron remains on Windows. */

import { chmodSync, createWriteStream, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  loadLayeredEnv,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { DesktopControlPeer } from './control-protocol.ts'
import { DesktopActionsService } from './desktop-actions.ts'
import {
  installDesktopPnpmRuntime,
} from './desktop-runtime-environment.ts'
import { DesktopPluginsService } from './desktop-plugins.ts'
import DesktopSettingsController from './desktop-settings-controller.ts'
import {
  desktopMarketSnapshotWithEffective,
  readDesktopMarketStateForUserData,
  selectDesktopMarketProvider,
} from './desktop-market.ts'
import { FileExporter } from './file-exporter.ts'
import {
  DesktopInstallRecoveryStore,
  desktopInstallRecoveryStatePath,
} from './install-recovery.ts'
import { LogFileSink } from './log-files.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import {
  beginDesktopProfileStartup,
  createDesktopWebProfile,
  listDesktopProfiles,
  readDesktopProfileState,
  selectDesktopProfile,
} from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { DesktopProfileCheckpoint } from './profile-checkpoint.ts'
import {
  desktopInstallAnchor,
  prepareDesktopProfile,
} from './profile.ts'
import { RemoteDesktopRuntime } from './remote-runtime.ts'
import { DesktopStartupGeneration } from './startup-generation.ts'
import { DesktopStartupStateCommit } from './startup-state-commit.ts'

const BIN_NAME = 'dsh-plugin-desktop-wsl-host'

/** Exact bootstrap inputs supplied by the Windows supervisor. */
export interface WslHostArguments {
  readonly stateDir: string
  readonly homeDir: string
}

function absoluteLinuxPath(value: string, label: string): string {
  if (!value.startsWith('/') || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error(`${BIN_NAME}: ${label} must be an absolute Linux path`)
  }
  return value
}

/** Parse a small exact argv surface; unrecognized values fail before Host boot. */
export function parseWslHostArguments(argv: readonly string[]): WslHostArguments {
  let stateDir: string | undefined
  let homeDir: string | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${BIN_NAME}: missing value for ${flag ?? 'argument'}`)
    if (flag === '--state-dir' && stateDir === undefined) stateDir = absoluteLinuxPath(value, 'state directory')
    else if (flag === '--home-dir' && homeDir === undefined) homeDir = absoluteLinuxPath(value, 'DSH home')
    else throw new Error(`${BIN_NAME}: unknown or repeated argument ${flag ?? ''}`)
  }
  if (stateDir === undefined || homeDir === undefined) {
    throw new Error(`${BIN_NAME}: --state-dir and --home-dir are required`)
  }
  return Object.freeze({ stateDir, homeDir })
}

function ensureManagedDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${BIN_NAME}: ${label} is not a real directory`)
  }
  chmodSync(path, 0o700)
}

function stderr(message: string): void {
  process.stderr.write(`${message}\n`)
}

/** Keep stdout protocol-only even if a third-party Host plugin writes a notice. */
function reserveControlOutput(): NodeJS.WritableStream {
  const output = createWriteStream('/dev/stdout', { flags: 'w', autoClose: false })
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
  return output
}

/** Boot one immutable WSL Host and wait for its Windows owner to release it. */
export async function runWslHost(
  options: WslHostArguments,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = reserveControlOutput(),
): Promise<number> {
  if (process.platform !== 'linux') throw new Error(`${BIN_NAME}: this entry must run inside WSL`)
  ensureManagedDirectory(options.stateDir, 'state directory')
  ensureManagedDirectory(options.homeDir, 'DSH home')
  process.chdir(options.homeDir)
  process.env.DSH_HOME = options.homeDir
  const logger = { error: stderr }
  const generation = new DesktopStartupGeneration({ logger })
  const peer = new DesktopControlPeer(
    input as NodeJS.ReadableStream & import('node:stream').Readable,
    output as NodeJS.WritableStream & import('node:stream').Writable,
    { logger },
  )
  let runtime: RemoteDesktopRuntime | undefined
  let exitCode = 0
  let settle!: () => void
  const stopped = new Promise<void>(resolve => { settle = resolve })
  const releaseGeneration = (): void => {
    void generation.release().catch(cause => {
      stderr(`${BIN_NAME}: failed to release Host generation: ${cause instanceof Error ? cause.message : String(cause)}`)
    }).finally(settle)
  }
  const releaseOnEnd = (): void => { releaseGeneration() }
  input.once('end', releaseOnEnd)
  try {
    const selectionStatePath = join(options.stateDir, 'profile-selection', 'state.json')
    const pluginStatePath = join(options.stateDir, 'plugin-management', 'state.json')
    const recoveryStatePath = join(options.stateDir, 'startup-recovery', 'state.json')
    const marketStateDir = options.stateDir
    const profileStartup = beginDesktopProfileStartup(selectionStatePath, options.homeDir)
    const activeProfileName = profileStartup.profileName
    const activeProfileDir = resolveProfileDir(activeProfileName, options.homeDir)
    const installRecovery = new DesktopInstallRecoveryStore({
      statePath: desktopInstallRecoveryStatePath(options.stateDir),
      profileName: activeProfileName,
      profileDir: activeProfileDir,
      generationId: generation.id,
    })
    const recoveryClaim = await installRecovery.claim()
    if (recoveryClaim.action === 'prompt'
      || (recoveryClaim.action === 'terminal' && recoveryClaim.transaction.phase === 'manual-recovery-required')) {
      throw new Error(`${BIN_NAME}: protected plugin installation requires recovery in the WSL terminal`)
    }
    const marketSelection = readDesktopMarketStateForUserData(marketStateDir)
    const prepared = prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      options.homeDir,
      'linux',
      activeProfileName,
      pluginStatePath,
      marketSelection,
      recoveryStatePath,
    )
    const updateStatePath = join(options.stateDir, 'updates', 'state.json')
    runtime = await RemoteDesktopRuntime.connect(peer, updateStatePath)
    const pnpmBinPath = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')
    const pnpmRuntime = installDesktopPnpmRuntime({
      platform: 'linux',
      runtime: 'node',
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion: process.versions.node,
      stateDir: join(options.stateDir, 'runtime-commands'),
      environment: process.env,
    })
    const releasePnpm = generation.own(() => { pnpmRuntime.dispose() })
    const dshBootstrapPath = fileURLToPath(new URL('./desktop-cli.js', import.meta.url))
    const desktopPnpmBootstrap: DesktopPnpmBootstrap = {
      runtime: 'node',
      activeProfileName,
      activeProfileDir: prepared.profile.dir,
      homeDir: options.homeDir,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion: process.versions.node,
      nodeBinDir: pnpmRuntime.nodeBinDir,
      nodeShimPath: pnpmRuntime.nodeShimPath,
      clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
      dshBootstrapPath,
      installRecoveryStatePath: desktopInstallRecoveryStatePath(options.stateDir),
      generationId: generation.id,
      externalMarketInstallEnabled: prepared.market.effective === 'dsh-market',
    }
    let profileCheckpoint: DesktopProfileCheckpoint | undefined
    try {
      profileCheckpoint = new DesktopProfileCheckpoint({
        userDataDir: options.stateDir,
        profileDir: prepared.profile.dir,
        profileName: activeProfileName,
        provider: 'desktop-profile-wsl',
      })
    } catch (cause) {
      stderr(
        `${BIN_NAME}: healthy profile checkpoints remain unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    const startupStateCommit = new DesktopStartupStateCommit({
      profile: profileStartup,
      profileStatePath: selectionStatePath,
      installRecovery,
      quiesceForRecovery: () => generation.quiesceForRecovery(),
      logger,
    })
    let logSink: LogFileSink | undefined
    try {
      logSink = new LogFileSink(join(options.stateDir, 'logs'), {
        maxFileBytes: 10 * 1024 * 1024,
        maxDirectoryBytes: 200 * 1024 * 1024,
      })
      logSink.enforceDirectoryCap()
      logSink.purgeOlderThan(7)
      logSink.writeHeader(`--- ${BIN_NAME} ${process.version} generation ${generation.id} ---`)
    } catch (cause) {
      stderr(`${BIN_NAME}: file logging unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    const releaseResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async hostCtx => {
        generation.bindHost(hostCtx)
        hostCtx.effect(() => releasePnpm, `${BIN_NAME}: managed native Node pnpm runtime`)
        hostCtx.effect(() => releaseResolver, `${BIN_NAME}: profile package resolution`)
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime as RemoteDesktopRuntime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        await hostCtx.plugin(DesktopActionsService, {
          openTerminal: () => { runtime?.openTerminal() },
          requestRestart: async () => { await runtime?.requestRestart() },
        })
        if (prepared.market.effective === 'community-market') {
          await hostCtx.plugin(DesktopPluginsService, {
            profileName: activeProfileName,
            homeDir: options.homeDir,
            statePath: pluginStatePath,
            recoveryStatePath,
            installAnchor: desktopInstallAnchor(),
          })
        }
        if (logSink !== undefined) hostCtx.logger.exporter(new FileExporter(logSink))
        await hostCtx.plugin(DesktopProfileService, {
          current: { name: activeProfileName, dir: prepared.profile.dir },
          create: name => createDesktopWebProfile(options.homeDir, name),
          list: () => listDesktopProfiles(options.homeDir),
          persistSelection: name => { selectDesktopProfile(selectionStatePath, options.homeDir, name) },
          requestRestart: async () => { await runtime?.requestRestart() },
        })
        let pendingRestart: ReturnType<typeof setImmediate> | undefined
        const scheduleRestart = (): void => {
          pendingRestart ??= setImmediate(() => {
            pendingRestart = undefined
            void runtime?.requestRestart()
          })
        }
        hostCtx.effect(() => () => {
          if (pendingRestart !== undefined) clearImmediate(pendingRestart)
        }, `${BIN_NAME}: pending settings restart`)
        const readMarket = () => desktopMarketSnapshotWithEffective(
          readDesktopMarketStateForUserData(marketStateDir),
          prepared.market.effective,
        )
        hostCtx.provide('desktopSettingsController', new DesktopSettingsController({
          profiles: hostCtx.desktopProfiles,
          readHostTarget: () => (runtime as RemoteDesktopRuntime).hostTarget,
          selectHostTarget: async selection => { await (runtime as RemoteDesktopRuntime).selectHostTarget(selection) },
          persistProfileSelection: name => {
            selectDesktopProfile(selectionStatePath, options.homeDir, name)
          },
          readMarket,
          selectMarket: async provider => desktopMarketSnapshotWithEffective(
            await selectDesktopMarketProvider(marketStateDir, provider),
            prepared.market.effective,
          ),
          scheduleRestart,
          openTerminal: () => { runtime?.openTerminal() },
        }))
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', String(prepared.port)],
          exit: code => { peer.notify('host/exit', { code }) },
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch(cause => {
      releaseResolver()
      throw cause
    })
    generation.bindHost(ctx)
    await runtime.waitUntilScheduled()
    let healthyCommitted = false
    const removeHealthy = peer.register('host/health.commit', async params => {
      const requestedGeneration = params !== null && typeof params === 'object'
        ? (params as { generationId?: unknown }).generationId
        : undefined
      if (requestedGeneration !== generation.id) throw new Error(`${BIN_NAME}: invalid health generation`)
      if (healthyCommitted) return null
      await startupStateCommit.commitHealthy()
      try {
        profileCheckpoint?.captureHealthy()
      } catch (cause) {
        stderr(
          `${BIN_NAME}: failed to checkpoint the healthy profile configuration: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
      healthyCommitted = true
      return null
    })
    const removeShutdown = peer.register('host/shutdown', async params => {
      const requested = params !== null && typeof params === 'object'
        ? (params as { code?: unknown }).code
        : undefined
      if (requested !== undefined && !Number.isSafeInteger(requested)) {
        throw new Error(`${BIN_NAME}: invalid shutdown code`)
      }
      exitCode = typeof requested === 'number' ? requested : 0
      // Acknowledge before releasing the transport that must carry this response.
      releaseGeneration()
      return null
    })
    generation.own(removeHealthy)
    generation.own(removeShutdown)
    peer.notify('host/ready', {
      generationId: generation.id,
      profileName: activeProfileName,
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
      port: ctx.webServer.port,
      selectedProfile: readDesktopProfileState(selectionStatePath).active,
    })
    await stopped
    return exitCode
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    try { peer.notify('host/fatal', { message }) } catch {}
    stderr(`${BIN_NAME}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`)
    await generation.release().catch(releaseCause => {
      stderr(`${BIN_NAME}: failed to release startup generation: ${releaseCause instanceof Error ? releaseCause.message : String(releaseCause)}`)
    })
    return 1
  } finally {
    input.off('end', releaseOnEnd)
    runtime?.dispose()
    peer.close()
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  void runWslHost(parseWslHostArguments(process.argv.slice(2))).then(
    code => { process.exitCode = code },
    cause => {
      stderr(`${BIN_NAME}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`)
      process.exitCode = 1
    },
  )
}
