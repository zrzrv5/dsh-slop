import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TraceabilityVerificationError,
  verifyTraceability,
} from '../scripts/verify-traceability.ts'

const temporaryRoots: string[] = []

async function fixture(document: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slop-traceability-'))
  temporaryRoots.push(root)
  await mkdir(join(root, 'packages/example/src'), { recursive: true })
  await mkdir(join(root, 'packages/example/tests'), { recursive: true })
  await mkdir(join(root, 'requirements'), { recursive: true })
  await writeFile(join(root, 'packages/example/package.json'), JSON.stringify({ name: '@dsh-slop/example' }))
  await writeFile(join(root, 'packages/example/src/index.ts'), 'export const publicContract = true\n')
  await writeFile(join(root, 'packages/example/tests/example.spec.ts'), "it('proves the requirement', () => {})\n")
  await writeFile(join(root, 'requirements/traceability.yml'), document)
  return root
}

const validDocument = `
schema_version: 1
requirements:
  - id: SLOP-EXAMPLE-SOURCE
    title: Example source requirement
    owner_package: "@dsh-slop/example"
    status: source-complete
    implementation:
      - file: packages/example/src/index.ts
        symbol: publicContract
    public_contracts:
      - file: packages/example/src/index.ts
        symbol: publicContract
    ui_surfaces:
      - not_applicable: This fixture is host-only.
    tests:
      - file: packages/example/tests/example.spec.ts
        title: proves the requirement
    real_system_evidence:
      required: true
      owner: release-engineering
      status: pending
      receipts: []
release_gates:
  - id: SLOP-RELEASE-EXAMPLE
    title: External example journey
    owner: release-engineering
    status: pending
    receipts: []
`

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('requirement traceability verifier', () => {
  it('accepts source-complete evidence while reporting external receipts as pending', async () => {
    const root = await fixture(validDocument)
    await expect(verifyTraceability({ rootDirectory: root })).resolves.toEqual({
      requirements: 1,
      releaseGates: 1,
      pendingReleaseGates: ['SLOP-RELEASE-EXAMPLE'],
    })
  })

  it('fails release mode until required real-system receipts exist', async () => {
    const root = await fixture(validDocument)
    await expect(verifyTraceability({ rootDirectory: root, release: true })).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.stringContaining('blocks release until real-system evidence is complete'),
        expect.stringContaining('blocks release until its real-system receipt is complete'),
      ]),
    })
  })

  it('rejects a required source row that is not source-complete', async () => {
    const root = await fixture(validDocument.replace('status: source-complete', 'status: source-incomplete'))
    await expect(verifyTraceability({ rootDirectory: root })).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.stringContaining('must be source-complete'),
      ]),
    })
  })

  it('rejects missing implementation files and invented test-title evidence', async () => {
    const root = await fixture(
      validDocument
        .replace('packages/example/src/index.ts\n        symbol: publicContract', 'packages/example/src/missing.ts\n        symbol: publicContract')
        .replace('title: proves the requirement', 'title: invented test title'),
    )
    try {
      await verifyTraceability({ rootDirectory: root })
      throw new Error('verification unexpectedly passed')
    } catch (error) {
      expect(error).toBeInstanceOf(TraceabilityVerificationError)
      const problems = (error as TraceabilityVerificationError).problems
      expect(problems).toEqual(expect.arrayContaining([
        expect.stringContaining('names a missing repository file'),
        expect.stringContaining('does not match an exact it()/test() title'),
      ]))
    }
  })
})
