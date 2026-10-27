import { getCiphers } from 'node:crypto'
import type { Algorithms, CipherAlgorithm, KexAlgorithm, MacAlgorithm, ServerHostKeyAlgorithm } from 'ssh2'

// Public ssh2 1.17 algorithm names, restricted to modern transports. Intersect
// with OpenSSH's resolved policy: unsupported entries never widen that policy.
const kex = ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512'] satisfies KexAlgorithm[]
const hosts = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256'] satisfies ServerHostKeyAlgorithm[]
const ciphers = ['chacha20-poly1305@openssh.com', 'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr'] satisfies CipherAlgorithm[]
// ssh2 also checks the runtime's crypto implementation. Electron's BoringSSL
// can omit ChaCha20 even when the system OpenSSH configuration advertises it.
const cryptoCipherNames: Record<(typeof ciphers)[number], string> = {
  'chacha20-poly1305@openssh.com': 'chacha20',
  'aes128-gcm@openssh.com': 'aes-128-gcm',
  'aes256-gcm@openssh.com': 'aes-256-gcm',
  'aes128-ctr': 'aes-128-ctr',
  'aes192-ctr': 'aes-192-ctr',
  'aes256-ctr': 'aes-256-ctr',
}
const macs = ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1-etm@openssh.com', 'hmac-sha1'] satisfies MacAlgorithm[]

function intersect<T extends string>(configured: string | undefined, supported: readonly T[]): T[] {
  const result = configured === undefined ? [...supported] : configured.split(',').flatMap(value => supported.filter(item => item === value))
  if (!result.length) throw new Error('The SSH algorithm policy has no native-supported algorithms. Select the WSL backend for this configuration.')
  return result
}

export function nativeAlgorithms(value: (key: string) => string | undefined, runtimeCiphers: readonly string[] = getCiphers()): Algorithms {
  return {
    kex: intersect(value('kexalgorithms'), kex),
    serverHostKey: intersect(value('hostkeyalgorithms'), hosts),
    cipher: intersect(value('ciphers'), ciphers.filter(cipher => runtimeCiphers.includes(cryptoCipherNames[cipher]))),
    hmac: intersect(value('macs'), macs),
    compress: value('compression') === 'yes' ? ['zlib@openssh.com', 'none'] : ['none'],
  }
}
