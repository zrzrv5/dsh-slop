import { createHash } from 'node:crypto'
import { isAbsolute, posix, resolve, win32 } from 'node:path'

export type TrustMode = 'pinned' | 'user-known-hosts' | 'tofu'
export type ControlMode = 'app-managed' | 'adopt-user-master' | 'direct'

interface OpenSshTargetBase {
  readonly alias: string
  readonly port?: number
  /** Non-secret local path only. Private-key bytes never enter this contract. */
  readonly localKeyFilePath?: string
  readonly connectTimeoutSeconds: number
  readonly keepaliveSeconds: number
  readonly keepaliveMisses?: number
  readonly appKnownHosts?: string
}

export type OpenSshTarget = OpenSshTargetBase & (
  | {
      readonly controlMode: 'app-managed'
      /** Keep the app-owned master available for the broker's configured idle horizon. */
      readonly controlPersistSeconds: number
    }
  | {
      readonly controlMode: Exclude<ControlMode, 'app-managed'>
      readonly controlPersistSeconds?: never
    }
)

/** Accept an argv-safe local identity-file reference, including OpenSSH `~/` expansion. */
export function validateLocalKeyFilePath(path: string): void {
  if (path.length === 0 || path.length > 4_096 || path.trim() !== path || path.includes('\0') || /[\r\n]/u.test(path)) {
    throw new Error('invalid local SSH key file path')
  }
  if (!path.startsWith('/') && !path.startsWith('~/') && !/^[A-Za-z]:[\\/]/u.test(path) && !/^\\\\[^\\]+\\[^\\]+/u.test(path)) {
    throw new Error('local SSH key file path must be absolute or start with ~/')
  }
}

/** Accept one argv-safe OpenSSH config alias or an explicit user@host target. */
export function validateSshTarget(target: string): void {
  const alias = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
  const explicit = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
  if (!alias.test(target) && !explicit.test(target)) throw new Error('invalid OpenSSH alias or user@host target')
}

// OpenSSH creates the listening socket through a temporary sibling whose name
// adds a random suffix. Keep the configured path comfortably below Darwin's
// 103-byte sun_path payload instead of checking only the final .sock name.
const MAX_CONFIGURED_CONTROL_PATH_BYTES = 80

/**
 * Stable, instance-scoped runtime root for OpenSSH sockets.
 *
 * DSH_HOME may be arbitrarily deep, while Unix-domain socket paths are not.
 * A direct child of /tmp keeps the path bounded; the uid and an instance-root
 * digest keep separate users and DSH-SLOP homes from sharing a master.
 */
export function controlSocketRoot(instanceRoot: string, uid = process.getuid?.()): string {
  if (!isAbsolute(instanceRoot) || instanceRoot.includes('\0')) throw new Error('OpenSSH socket instance root must be an absolute NUL-free path')
  if ((uid === undefined && process.platform !== 'win32') || (uid !== undefined && (!Number.isSafeInteger(uid) || uid < 0))) throw new Error('OpenSSH ControlMaster requires a numeric Unix user id')
  const digest = createHash('sha256').update('dsh-slop/socket-root/v1\0').update(resolve(instanceRoot)).digest('hex').slice(0, 16)
  return posix.join('/tmp', `dsh-slop-${uid ?? 'wsl'}-${digest}`)
}

/** Short deterministic socket path with room for OpenSSH's temporary suffix. */
export function controlSocketPath(socketRoot: string, identity: string): string {
  if (!isAbsolute(socketRoot) || socketRoot.includes('\0')) throw new Error('OpenSSH socket root must be an absolute NUL-free path')
  const digest = createHash('sha256').update('dsh-slop/control/v1\0').update(identity).digest('hex').slice(0, 32)
  const path = posix.join(socketRoot, `${digest}.sock`)
  if (Buffer.byteLength(path) > MAX_CONFIGURED_CONTROL_PATH_BYTES) {
    throw new Error(`OpenSSH control socket path exceeds the ${MAX_CONFIGURED_CONTROL_PATH_BYTES}-byte safe limit`)
  }
  return path
}

export function sshBaseArgv(target: OpenSshTarget, socketPath?: string): string[] {
  validateSshTarget(target.alias)
  if (!Number.isInteger(target.connectTimeoutSeconds) || target.connectTimeoutSeconds < 1 || target.connectTimeoutSeconds > 300) throw new Error('invalid SSH connect timeout')
  if (!Number.isInteger(target.keepaliveSeconds) || target.keepaliveSeconds < 0 || target.keepaliveSeconds > 3600) throw new Error('invalid SSH keepalive')
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)) throw new Error('invalid SSH port')
  if (target.keepaliveMisses !== undefined && (!Number.isInteger(target.keepaliveMisses) || target.keepaliveMisses < 1 || target.keepaliveMisses > 10)) throw new Error('invalid SSH keepalive miss limit')
  if (target.localKeyFilePath !== undefined) validateLocalKeyFilePath(target.localKeyFilePath)
  const argv = ['ssh', '-o', `ConnectTimeout=${target.connectTimeoutSeconds}`, '-o', `ServerAliveInterval=${target.keepaliveSeconds}`, '-o', `ServerAliveCountMax=${target.keepaliveMisses ?? 3}`, '-o', 'BatchMode=yes']
  if (target.port !== undefined) argv.push('-p', String(target.port))
  if (target.localKeyFilePath !== undefined) argv.push('-i', target.localKeyFilePath)
  if (target.appKnownHosts !== undefined) argv.push('-o', `UserKnownHostsFile=${sshPathValue(target.appKnownHosts)}`, '-o', 'StrictHostKeyChecking=yes')
  if (target.controlMode === 'direct') argv.push('-o', 'ControlMaster=no')
  if (target.controlMode === 'app-managed') {
    if (!Number.isInteger(target.controlPersistSeconds) || target.controlPersistSeconds < 1 || target.controlPersistSeconds > 86_400) throw new Error('invalid SSH control persist timeout')
    if (socketPath === undefined) throw new Error('app-managed SSH requires a control socket')
    argv.push('-o', 'ControlMaster=auto', '-o', `ControlPersist=${target.controlPersistSeconds}`, '-o', `ControlPath=${socketPath}`)
  }
  argv.push('--', target.alias)
  return argv
}

/** One literal path in OpenSSH configuration syntax (which has its own quoting). */
export function sshPathValue(path: string): string {
  if (/[\0\r\n"]/u.test(path)) throw new Error('invalid SSH configuration path')
  const normalized = win32.isAbsolute(path) && !path.startsWith('/') ? path.replaceAll('\\', '/') : path
  return `"${normalized.replaceAll('%', '%%')}"`
}

/** Fixed remote helper invocation; request JSON is sent on stdin, never interpolated. */
export function remoteHelperArgv(target: OpenSshTarget, helperPath: string, socketPath?: string): string[] {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(helperPath) || helperPath.includes('/../')) throw new Error('invalid remote helper path')
  return [...sshBaseArgv(target, socketPath), helperPath, '--stdio-json-v1']
}
