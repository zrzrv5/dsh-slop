import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
const target = new URL('../lib/skills/', import.meta.url)
await mkdir(target, { recursive: true })
await cp(new URL('../../../skills/', import.meta.url), target, { recursive: true })
// Git's Windows checkout line endings must not change shipped Skill byte limits.
for (const path of await readdir(target, { recursive: true })) {
  if (!path.endsWith('.md')) continue
  const file = new URL(path.replaceAll('\\', '/'), target)
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'))
}
