import { describe, expect, it } from 'vitest'
import { localAbsolutePathSchema, remotePathSchema } from '../src/primitives.ts'

describe('Host paths and remote paths', () => {
  it.each(['/tmp/a', 'C:\\Users\\Alice Smith\\file.txt', 'E:/工作/data', '\\\\server\\share\\file.txt'])('accepts a canonical local path: %s', path => {
    expect(localAbsolutePathSchema.parse(path)).toBe(path)
  })
  it.each(['C:relative', '\\root-relative', 'C:\\a\\..\\secret', 'C:/a//b', 'relative', 'C:/a\nother'])('rejects ambiguous local paths: %s', path => {
    expect(localAbsolutePathSchema.safeParse(path).success).toBe(false)
  })
  it('keeps remote paths POSIX even when the Host uses Windows', () => {
    expect(remotePathSchema.safeParse('C:\\data').success).toBe(false)
    expect(remotePathSchema.parse('/data/file')).toBe('/data/file')
  })
})
