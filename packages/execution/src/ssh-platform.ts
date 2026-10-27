import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { sshPathValue } from '@dsh-slop/operations'
import type { ProcessDriver } from './types.ts'

/** Windows uses Linux OpenSSH because Win32 OpenSSH cannot reuse a 2FA master. */
export class SshPlatform {
  constructor(
    private readonly local: ProcessDriver,
    private readonly cwd: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly distribution = process.env.DSH_SLOP_WSL_DISTRO,
  ) {}

  private wsl(argv: readonly string[]): readonly string[] {
    if (this.distribution !== undefined && (!this.distribution.trim() || /[\0\r\n]/u.test(this.distribution))) {
      throw new Error('DSH_SLOP_WSL_DISTRO must name an installed WSL distribution.')
    }
    return ['wsl.exe', ...(this.distribution === undefined ? [] : ['--distribution', this.distribution]), '--cd', '~', '--exec', ...argv]
  }

  private async query(argv: readonly string[]): Promise<string> {
    const result = await this.local.capture({ argv: this.wsl(argv), cwd: this.cwd, timeoutMs: 20_000, maxOutputBytes: 16_384 })
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error('Windows Machine SSH requires an installed WSL distribution with ssh, scp and ssh-keyscan. Select it with DSH_SLOP_WSL_DISTRO; its ~/.ssh/config and keys are used.')
    }
    const value = Buffer.from(result.stdout).toString('utf8').trim()
    if (!value || /[\0\r\n]/u.test(value)) throw new Error('WSL returned an invalid local path.')
    return value
  }

  private async linuxPath(path: string): Promise<string> {
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path)) return path
    const converted = await this.query(['wslpath', '-a', '-u', path])
    if (!converted.startsWith('/')) throw new Error('WSL did not return an absolute Linux path.')
    return converted
  }

  /** Translate local operands only. Remote commands and paths are never rewritten. */
  readonly prepareCommand = async (argv: readonly string[]): Promise<readonly string[]> => {
    if (this.platform !== 'win32') return argv
    const result = [...argv]
    const tool = result[0]
    const separator = result.indexOf('--')
    const optionsEnd = separator === -1 ? result.length : separator
    if (tool === 'ssh' || tool === 'scp') {
      for (let index = 1; index < optionsEnd; index++) {
        if (result[index] === '-i' || result[index] === '-F') {
          const path = result[++index]
          if (path === undefined) throw new Error('Missing SSH local path operand.')
          result[index] = await this.linuxPath(path)
        } else if (result[index]?.startsWith('UserKnownHostsFile=')) {
          const value = result[index]!.slice('UserKnownHostsFile='.length)
          const path = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replaceAll('%%', '%') : value
          result[index] = `UserKnownHostsFile=${sshPathValue(await this.linuxPath(path))}`
        }
      }
    }
    if (tool === 'scp' && separator !== -1) {
      for (let index = separator + 1; index < result.length; index++) result[index] = await this.linuxPath(result[index]!)
    }
    return this.wsl(result)
  }

  async configHome(): Promise<string> {
    if (this.platform !== 'win32') return homedir()
    const path = await this.query(['sh', '-c', 'wslpath -w "$HOME"'])
    if (!isAbsolute(path)) throw new Error('WSL SSH home must be an absolute local path.')
    return path
  }
}
