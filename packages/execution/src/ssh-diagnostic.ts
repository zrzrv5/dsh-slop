import { stripVTControlCharacters } from 'node:util'

/** Keep useful stderr while bounding model context and removing terminal control. */
export function sshDiagnostic(text: string, limit = 1024): string {
  const tail = stripVTControlCharacters(text.slice(-8192)).split('\r').join('\n')
  const plain = Array.from(tail).filter(char => char === '\n' || char === '\t' || (char.codePointAt(0)! >= 32 && char.codePointAt(0)! !== 127)).join('')
  return plain.trim().slice(-limit)
}
