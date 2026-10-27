import { readFile } from 'node:fs/promises'
import ssh2, { type Client as SshClient, type AnyAuthMethod, type AuthenticationType, type ClientChannel } from 'ssh2'
import type { NativeAuthPrompt } from './native-auth-flow.ts'
import type { NativeSshConfig } from './native-ssh-config.ts'
import { nativeHostVerifier } from './native-ssh-trust.ts'
import { SshConnectionError } from './ssh-broker.ts'
import type { CapturedProcess, SshConnectionProfile } from './types.ts'

const { Client, createAgent, utils } = ssh2

async function authenticationAgent(config: NativeSshConfig, path: string) {
  const agent = createAgent(path)
  if (!config.identitiesOnly) return agent
  const allowed: Buffer[] = []
  for (const identity of config.identityFiles) {
    for (const file of [identity + '.pub', identity]) {
      const data = await readFile(file).catch(() => undefined)
      if (data === undefined) continue
      const key = utils.parseKey(data)
      if (key instanceof Error || Array.isArray(key)) continue
      allowed.push(key.getPublicSSH())
      break
    }
  }
  const getIdentities = agent.getIdentities.bind(agent)
  agent.getIdentities = callback => getIdentities((error, keys) => {
    if (error) { callback(error); return }
    callback(null, keys?.filter(value => {
      const entry = typeof value === 'object' && 'pubKey' in value ? value.pubKey : value
      const material = typeof entry === 'object' && 'pubKey' in entry ? entry.pubKey : entry
      const key = typeof material === 'string' || Buffer.isBuffer(material) ? utils.parseKey(material) : material
      return !(key instanceof Error) && !Array.isArray(key) && allowed.some(bytes => bytes.equals(key.getPublicSSH()))
    }))
  })
  return agent
}

export async function openNativeConnection(config: NativeSshConfig, profile: SshConnectionProfile, signal: AbortSignal, prompt?: NativeAuthPrompt): Promise<SshClient> {
  const verify = await nativeHostVerifier(profile, config)
  signal.throwIfAborted()
  const client = new Client()
  return await new Promise<SshClient>((resolve, reject) => {
    let ready = false
    let failure: Error | undefined
    const fail = (error: Error): void => { failure ??= error; reject(failure); client.destroy() }
    const abort = (): void => fail(new Error('SSH connection cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    client.on('error', error => {
      if (ready) return
      // ssh2 emits an agent error and then tries the next authentication method.
      // A missing Windows ssh-agent must not prevent key/password/2FA fallback.
      if ('level' in error && error.level === 'agent') return
      const auth = 'level' in error && error.level === 'client-authentication'
      fail(failure ?? new SshConnectionError(auth ? 'AUTH_REQUIRED' : 'CONNECTION_UNAVAILABLE', auth ? 'Human authentication is required.' : 'Native SSH could not establish the connection. Check the endpoint, VPN and SSH configuration.'))
    })
    client.once('close', () => {
      signal.removeEventListener('abort', abort)
      if (!ready) reject(failure ?? new SshConnectionError('CONNECTION_UNAVAILABLE', 'SSH closed before authentication completed.'))
    })
    client.once('ready', () => { ready = true; signal.removeEventListener('abort', abort); resolve(client) })
    let noneTried = false, agentTried = false, keyboardTried = false, passwordTried = false, keyIndex = 0
    const nextMethod = async (methods: readonly AuthenticationType[] | null): Promise<AnyAuthMethod | undefined> => {
      signal.throwIfAborted()
      const username = config.username
      if (!noneTried) { noneTried = true; return { type: 'none', username } }
      const allows = (method: AuthenticationType): boolean => methods === null || methods.includes(method)
      if (allows('publickey')) {
        if (!agentTried && config.agent !== undefined) { agentTried = true; return { type: 'agent', username, agent: await authenticationAgent(config, config.agent) } }
        while (keyIndex < config.identityFiles.length) {
          const path = config.identityFiles[keyIndex++]!
          let key: Buffer
          try { key = await readFile(path) } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && profile.localKeyFilePath === undefined) continue
            throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The selected SSH private key could not be read.')
          }
          let parsed = utils.parseKey(key)
          if (parsed instanceof Error && /encrypted|passphrase/iu.test(parsed.message)) {
            if (prompt === undefined) continue
            parsed = utils.parseKey(key, await prompt.prompt('Private key passphrase: '))
          }
          if (parsed instanceof Error) {
            if (profile.localKeyFilePath === undefined) continue
            throw new SshConnectionError('AUTH_REQUIRED', 'The private key or its passphrase was not accepted.')
          }
          if (Array.isArray(parsed)) continue
          return { type: 'publickey', username, key: parsed }
        }
      }
      if (prompt !== undefined && config.keyboardAuthentication !== false && allows('keyboard-interactive') && !keyboardTried) {
        keyboardTried = true
        return { type: 'keyboard-interactive', username, prompt: (_name, instructions, _lang, prompts, finish) => {
          void (async () => {
            const answers: string[] = []
            for (const [index, item] of prompts.entries()) answers.push(await prompt.prompt(`${index === 0 && instructions ? `${instructions}\n` : ''}${item.prompt}`))
            signal.throwIfAborted()
            finish(answers)
          })().catch(() => fail(new SshConnectionError('AUTH_REQUIRED', 'Authentication was cancelled or expired.')))
        } }
      }
      if (prompt !== undefined && config.passwordAuthentication !== false && allows('password') && !passwordTried) { passwordTried = true; return { type: 'password', username, password: await prompt.prompt('Password: ') } }
      return undefined
    }
    try {
      client.connect({
        host: config.host, port: config.port, username: config.username,
        ...(config.algorithms === undefined ? {} : { algorithms: config.algorithms }),
        forceIPv4: config.addressFamily === 'inet', forceIPv6: config.addressFamily === 'inet6', ...(config.bindAddress === undefined ? {} : { localAddress: config.bindAddress }),
        readyTimeout: prompt === undefined ? profile.connectTimeoutSeconds * 1000 : 10 * 60_000,
        keepaliveInterval: profile.keepaliveSeconds * 1000, keepaliveCountMax: profile.keepaliveMisses ?? 3,
        hostVerifier: (key: Buffer) => {
          try { return verify(key) } catch (error) { failure = error instanceof Error ? error : new Error('Host key verification failed'); return false }
        },
        authHandler: (methods, _partial, next) => {
          void nextMethod(methods).then(method => {
            if (signal.aborted) { abort(); return }
            if (method === undefined) fail(new SshConnectionError('AUTH_REQUIRED', 'Human authentication is required.'))
            else next(method)
          }, error => fail(error instanceof SshConnectionError ? error : new SshConnectionError('AUTH_REQUIRED', 'Authentication failed.')))
        },
      })
    } catch (error) {
      // Only expose the library's bounded algorithm diagnostic, not arbitrary
      // error text that could contain authentication material.
      const detail = error instanceof Error && /^Unsupported algorithm: [A-Za-z0-9@._+-]{1,128}$/u.test(error.message) ? ` ${error.message}.` : ''
      const failure = new SshConnectionError('CONNECTION_UNAVAILABLE', `Native SSH configuration is invalid.${detail}`)
      failure.cause = error
      fail(failure)
    }
  })
}

/** One independent exec channel; deadlines never imply the remote command stopped. */
export async function captureNativeCommand(client: SshClient, argv: readonly string[], stdin: Uint8Array | undefined, timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal): Promise<CapturedProcess> {
  signal?.throwIfAborted()
  if (!argv.length || argv.some(part => !part || part.includes('\0'))) throw new Error('Remote argv must be nonempty and NUL-free')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid command bounds')
  return await new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined, settled = false, exitCode: number | null = null
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let stdoutSize = 0, stderrSize = 0
    const finish = (error?: Error, timedOut = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      client.removeListener('close', disconnected)
      channel?.close()
      if (error) reject(error)
      else resolve({ argv, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal: null, timedOut })
    }
    const abort = (): void => finish(new Error('SSH command cancelled; it may still be running remotely.'))
    const disconnected = (): void => finish(new SshConnectionError('CONNECTION_UNAVAILABLE', 'SSH disconnected after dispatch. The remote command may have run; inspect its state before retrying.'))
    const timer = setTimeout(() => finish(undefined, true), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    client.once('close', disconnected)
    client.exec(argv.join(' '), (error, stream) => {
      if (settled) { stream?.close(); return }
      if (error) { finish(new SshConnectionError('CONNECTION_UNAVAILABLE', 'SSH could not open the command channel.')); return }
      channel = stream
      const append = (raw: Buffer, isError: boolean): void => {
        if (settled) return
        const size = (isError ? stderrSize : stdoutSize) + raw.length
        if (size > maxOutputBytes) { finish(new Error(`SSH output exceeded ${maxOutputBytes} bytes; the remote command may still be running.`)); return }
        if (isError) { stderr.push(raw); stderrSize = size } else { stdout.push(raw); stdoutSize = size }
      }
      stream.on('data', (data: Buffer) => append(data, false))
      stream.stderr.on('data', (data: Buffer) => append(data, true))
      stream.on('error', disconnected)
      stream.on('exit', (code: number | null) => { exitCode = Number.isInteger(code) ? code : null })
      stream.once('close', () => exitCode === null ? disconnected() : finish())
      stream.end(stdin)
    })
  })
}
