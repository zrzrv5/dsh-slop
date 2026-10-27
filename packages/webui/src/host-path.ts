/** Display-only normalization; filesystem authorization remains on the Host. */
export function displayHostPath(value: string): string | undefined {
  if (/[\0\r\n]/u.test(value) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u.test(value)) return undefined
  return value.replaceAll('\\', '/').replace(/\/$/u, '')
}
