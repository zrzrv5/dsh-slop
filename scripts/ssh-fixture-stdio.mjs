// Synthetic SSH server carried over ProxyCommand pipes; never executes commands.
import { appendFileSync, readFileSync } from 'node:fs'
import { Duplex } from 'node:stream'
import { createRequire } from 'node:module'

const ssh2 = createRequire(import.meta.url)(process.argv[5] ?? 'ssh2')
// OpenSSH backgrounds the master after authentication; this pipe server is
// the remote endpoint, not an interactive child of that original terminal.
process.on('SIGHUP', () => {})

const [hostFile, userFile, receipt] = process.argv.slice(2)
const userKey = ssh2.utils.parseKey(readFileSync(userFile))
const server = new ssh2.Server({ hostKeys: [readFileSync(hostFile)] }, client => {
  client.on('error', () => {})
  client.on('authentication', request => {
    if (request.username === 'key' && request.method === 'publickey'
      && request.key.data.equals(userKey.getPublicSSH())
      && (!request.signature || userKey.verify(request.blob, request.signature, request.hashAlgo))) return request.accept()
    if (request.username === 'interactive' && request.method === 'keyboard-interactive') {
      request.prompt([{ prompt: 'Fixture password: ', echo: false }, { prompt: 'Fixture verification code: ', echo: false }], responses => {
        if (responses[0] === 'fixture-password' && responses[1] === '654321') request.accept()
        else request.reject()
      })
      return
    }
    request.reject(['publickey', 'keyboard-interactive'])
  })
  client.on('ready', () => {
    appendFileSync(receipt, 'authenticated\n')
    client.on('session', accept => accept().on('exec', (acceptExec, reject, info) => {
      if (info.command !== 'true' && info.command !== 'fixture-probe') return reject()
      const stream = acceptExec()
      if (info.command === 'fixture-probe') stream.write('reused-session\n')
      stream.exit(0)
      stream.end()
    }))
  })
})
server.injectSocket(Duplex.from({ readable: process.stdin, writable: process.stdout }))
