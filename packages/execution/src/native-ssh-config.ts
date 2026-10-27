import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { validateSshTarget } from '@dsh-slop/operations'
import type { ProcessDriver, SshConnectionProfile } from './types.ts'
import { SshConnectionError } from './ssh-broker.ts'
import { nativeAlgorithms } from './native-ssh-algorithms.ts'
import type { Algorithms } from 'ssh2'

export interface NativeSshConfig {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly identityFiles: readonly string[]
  readonly agent?: string
  readonly identitiesOnly?: boolean
  readonly knownHostsFiles: readonly string[]
  readonly hostKeyAlias?: string
  readonly passwordAuthentication?: boolean
  readonly keyboardAuthentication?: boolean
  readonly addressFamily?: 'inet' | 'inet6'
  readonly bindAddress?: string
  readonly algorithms?: Algorithms
}

export type NativeConfigResolver = (profile: SshConnectionProfile) => Promise<NativeSshConfig>

export function nativeSshPath(value: string): string {
  const expanded = value.replace(/^__PROGRAMDATA__(?=[\\/])/u, process.env.ProgramData ?? 'C:\\ProgramData')
  const path = expanded === '~' ? homedir() : /^~[\\/]/u.test(expanded) ? join(homedir(), expanded.slice(2)) : expanded
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path) || /%[A-Za-z%]|\$\{/u.test(path)) throw new Error('SSH paths must be absolute or home-relative, with resolved substitutions.')
  return path
}

/** OpenSSH owns config parsing; it is only used for local -G expansion on Windows. */
export function nativeConfigResolver(driver: ProcessDriver, cwd: string): NativeConfigResolver {
  return async profile => {
    validateSshTarget(profile.alias)
    let result
    try {
      result = await driver.capture({ argv: ['ssh', '-G', ...(profile.port === undefined ? [] : ['-p', String(profile.port)]), '--', profile.alias], cwd, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 })
    } catch { throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'Windows OpenSSH Client is required to read SSH configuration. Install the Windows optional feature; WSL is not required.') }
    if (result.exitCode !== 0 || result.timedOut) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'Windows OpenSSH could not resolve the SSH configuration.')
    try { return parseNativeSshConfig(Buffer.from(result.stdout).toString('utf8'), profile) }
    catch (error) { throw error instanceof SshConnectionError ? error : new SshConnectionError('CONNECTION_UNAVAILABLE', error instanceof Error ? error.message : 'Native SSH configuration is invalid.') }
  }
}

export function parseNativeSshConfig(text: string, profile: SshConnectionProfile): NativeSshConfig {
  const values = new Map<string, string[]>()
  for (const line of text.split(/\r?\n/u)) {
    const split = line.indexOf(' ')
    if (split < 1) continue
    const key = line.slice(0, split).toLowerCase()
    values.set(key, [...values.get(key) ?? [], line.slice(split + 1).trim()])
  }
  const first = (key: string): string | undefined => values.get(key)?.[0]
  for (const key of ['proxycommand', 'proxyjump', 'certificatefile', 'localcommand', 'pkcs11provider', 'securitykeyprovider', 'bindinterface']) {
    const value = first(key)
    if (value !== undefined && !['none', 'internal'].includes(value)) throw new SshConnectionError('CONNECTION_UNAVAILABLE', `Native Windows SSH does not support ${key}. Use a direct target or explicitly select DSH_SLOP_SSH_BACKEND=wsl for this configuration.`)
  }
  const host = first('hostname'), username = first('user'), port = Number(first('port') ?? 22)
  if (!host || !username || /[\0\r\n]/u.test(host + username) || !Number.isInteger(port) || port < 1 || port > 65535) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'SSH configuration has an invalid hostname, user or port.')
  if (first('forwardagent') === 'yes') throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'Native Windows SSH does not forward the local agent. Use the WSL backend for ForwardAgent.')
  const publicKey = !['no', 'false'].includes(first('pubkeyauthentication') ?? 'yes')
  const agentValue = first('identityagent')
  const agent = !publicKey || agentValue === 'none' ? undefined : agentValue === undefined || agentValue === 'SSH_AUTH_SOCK'
    ? process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    : agentValue
  const identityFiles = !publicKey ? [] : profile.localKeyFilePath === undefined ? values.get('identityfile') ?? [] : [profile.localKeyFilePath]
  // Windows -G removes quotes even inside paths with spaces. A new absolute
  // drive/UNC/home path marks the next entry; never split a Windows username.
  const paths = [first('userknownhostsfile'), first('globalknownhostsfile')].flatMap(value => value === undefined || value === 'none' ? [] : value.split(/\s+(?="?(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/|__PROGRAMDATA__[\\/]))/u)).map(value => nativeSshPath(value.replace(/^"|"$/gu, '')))
  const hostKeyAlias = first('hostkeyalias')
  const addressFamily = first('addressfamily'), bindAddress = first('bindaddress')
  return { host, port, username, identityFiles: identityFiles.filter(path => path !== 'none').map(nativeSshPath), knownHostsFiles: paths, ...(agent === undefined ? {} : { agent }), identitiesOnly: first('identitiesonly') === 'yes', ...(hostKeyAlias === undefined || hostKeyAlias === 'none' ? {} : { hostKeyAlias }), passwordAuthentication: first('passwordauthentication') !== 'no', keyboardAuthentication: first('kbdinteractiveauthentication') !== 'no', ...(addressFamily === 'inet' || addressFamily === 'inet6' ? { addressFamily } : {}), ...(bindAddress === undefined || bindAddress === 'none' ? {} : { bindAddress }), algorithms: nativeAlgorithms(first) }
}
