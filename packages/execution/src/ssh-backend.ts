export function sshBackend(platform = process.platform, preference = process.env.DSH_SLOP_SSH_BACKEND): 'native' | 'openssh' | 'wsl' {
  if (preference === undefined || preference === '') return platform === 'win32' ? 'native' : 'openssh'
  if (preference === 'native') return 'native'
  if (preference === 'wsl' && platform === 'win32') return 'wsl'
  if (preference === 'openssh' && platform !== 'win32') return 'openssh'
  throw new Error('Invalid DSH_SLOP_SSH_BACKEND. Windows supports native (default) or wsl; macOS/Linux support openssh (default) or native.')
}
