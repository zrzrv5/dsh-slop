import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_OWNER_PRINCIPAL_ID, RelationalAuthority } from '../src/authority.ts'
import { createUuidV7 } from '../src/canonical.ts'
import { machineSchema } from '../src/domain/inventory.ts'
import {
  initialMachineInfoApprovalDigest,
  initialMachineInfoSaveRequestSchema,
  machineInfoCandidateSchema,
  machineInfoUpdateRequestSchema,
  machineInfoChangeMateriality,
  machineInfoUpdateApprovalDigest,
  type MachineInfoCandidate,
  type MachineInfoChange,
  type MachineInfoUpdateRequest,
} from '../src/machine-info.ts'
import {
  MachineInfoApprovalRequiredError,
  MachineInfoService,
} from '../src/machine-info-service.ts'
import {
  accessProfileIdSchema,
  machineIdSchema,
  toInstant,
} from '../src/primitives.ts'
import { jsonValueSchema } from '../src/schemas.ts'

const roots: string[] = []
const authorities: RelationalAuthority[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'slop-machine-info-'))
  roots.push(root)
  const authority = await RelationalAuthority.open(join(root, 'authority'))
  authorities.push(authority)
  const machineId = machineIdSchema.parse(createUuidV7())
  const at = toInstant(new Date('2026-08-27T12:00:00.000Z'))
  const machine = machineSchema.parse({
    schemaVersion: 1,
    id: machineId,
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    accessProfileId: accessProfileIdSchema.parse(createUuidV7()),
    name: 'Atlas',
    declaredRoots: [],
    preferredExecutionProviderId: 'slurm',
    revision: 1,
    lifecycle: 'active',
    createdAt: at,
    updatedAt: at,
  })
  authority.transact({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    mutations: [{ kind: 'insert', domain: 'machine', id: machineId, value: jsonValueSchema.parse(machine) }],
  })
  return {
    authority,
    machineId,
    service: new MachineInfoService(authority, { now: () => new Date('2026-08-27T12:30:00.000Z') }),
  }
}

function candidate(machineId: MachineInfoCandidate['machineId']): MachineInfoCandidate {
  return {
    schemaVersion: 1,
    machineId,
    setup: {
      machineAlias: 'Atlas',
      sshTarget: 'alice@atlas.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: { home: '/home/alice', work: '/work/alice', scratch: '/scratch/alice' },
      discoveryProfile: 'deep',
    },
    customNotes: 'Use allocation chem-42 for production work.',
    approvedDiscovery: {
      summary: 'Slurm cluster with environment modules and a shared project filesystem.',
      operatingDefaults: { account: 'chem-42', partition: 'compute' },
      sections: [
        { id: 'software', kind: 'software', title: 'Software', content: 'LAMMPS 2Aug2023 is available through module lammps.' },
        { id: 'workflow', kind: 'workflow', title: 'Workflow', content: 'Submit production runs with sbatch from /work/alice.' },
      ],
    },
  }
}

function issueApproval(authority: RelationalAuthority, effectDigest: ReturnType<typeof initialMachineInfoApprovalDigest>) {
  return authority.issueApproval({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    effectDigest,
    expiresAt: toInstant(new Date(Date.now() + 60_000)),
  })
}

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async authority => { await authority.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('MachineInfoService initial approval boundary', () => {
  it('keeps legacy relative records readable while refusing new unresolved path writes', async () => {
    const { machineId } = await fixture()
    const legacy = candidate(machineId)
    legacy.setup.paths.work = '~/Documents'
    expect(machineInfoCandidateSchema.safeParse(legacy).success).toBe(true)
    expect(initialMachineInfoSaveRequestSchema.safeParse({ candidate: legacy, approvalReceiptId: createUuidV7(), idempotencyKey: 'invalid-path' }).success).toBe(false)
    expect(machineInfoUpdateRequestSchema.safeParse({ machineId, expectedRevision: 1, explanation: 'set root', changes: [{ kind: 'set-execution-path', role: 'work', path: '~/Documents' }], idempotencyKey: 'invalid-update' }).success).toBe(false)
  })

  it('persists the complete approved context only with a digest-bound approval receipt', async () => {
    const { authority, machineId, service } = await fixture()
    const reviewed = candidate(machineId)

    expect(() => service.saveInitial({
      candidate: reviewed,
      approvalReceiptId: '00000000-0000-7000-8000-000000000999',
      idempotencyKey: 'initial-atlas',
    })).toThrow(MachineInfoApprovalRequiredError)
    expect(service.get(machineId)).toBeUndefined()

    const approval = issueApproval(authority, initialMachineInfoApprovalDigest(reviewed))
    const saved = service.saveInitial({
      candidate: reviewed,
      approvalReceiptId: approval.id,
      idempotencyKey: 'initial-atlas',
    })

    expect(saved.card).toEqual({ kind: 'emit-new-card', reason: 'initial-save' })
    expect(saved.machineInfo.customNotes).toBe(reviewed.customNotes)
    expect(saved.machineInfo.approvedDiscovery).toEqual(reviewed.approvedDiscovery)
    expect(service.contextForAgent(machineId)).toEqual(saved.machineInfo)
    expect(authority.approval(LOCAL_OWNER_PRINCIPAL_ID, approval.id)?.state).toBe('consumed')

    expect(service.saveInitial({
      candidate: reviewed,
      approvalReceiptId: approval.id,
      idempotencyKey: 'initial-atlas',
    })).toEqual(saved)
  })
})

describe('MachineInfoService graded updates', () => {
  it('applies a small evidence-backed correction without approval and records its Chat explanation', async () => {
    const { authority, machineId, service } = await fixture()
    const reviewed = candidate(machineId)
    const initialApproval = issueApproval(authority, initialMachineInfoApprovalDigest(reviewed))
    service.saveInitial({ candidate: reviewed, approvalReceiptId: initialApproval.id, idempotencyKey: 'initial' })

    const changes: MachineInfoChange[] = [{
      kind: 'correct-stale-discovery-section',
      sectionId: 'software',
      evidence: 'module avail on 2026-08-27 reports LAMMPS 22Jul2025.',
      replacement: { kind: 'software', title: 'Software', content: 'LAMMPS 22Jul2025 is available through module lammps.' },
    }]
    expect(machineInfoChangeMateriality(changes)).toBe('small')

    const result = service.update({
      machineId,
      expectedRevision: 1,
      explanation: 'Updated the LAMMPS version after checking the current module catalog.',
      changes,
      idempotencyKey: 'software-version-correction',
    })

    expect(result.card).toEqual({ kind: 'card-not-required', reason: 'small-update' })
    expect(result.machineInfo.approvedDiscovery.sections[0]?.content).toContain('22Jul2025')
    expect(result.update).toMatchObject({
      materiality: 'small',
      approval: { kind: 'not-required' },
      explanation: 'Updated the LAMMPS version after checking the current module catalog.',
      fromRevision: 1,
      toRevision: 2,
    })
    expect(service.listUpdates(machineId)).toEqual([result.update])
  })

  it('rejects a material change until the user approves its exact revision and content', async () => {
    const { authority, machineId, service } = await fixture()
    const reviewed = candidate(machineId)
    const initialApproval = issueApproval(authority, initialMachineInfoApprovalDigest(reviewed))
    service.saveInitial({ candidate: reviewed, approvalReceiptId: initialApproval.id, idempotencyKey: 'initial' })

    const request: Pick<MachineInfoUpdateRequest, 'machineId' | 'expectedRevision' | 'explanation' | 'changes'> = {
      machineId,
      expectedRevision: 1,
      explanation: 'The login endpoint moved to the new cluster head node.',
      changes: [{ kind: 'set-ssh-target', sshTarget: 'alice@atlas-new.example.org' }],
    }
    expect(machineInfoChangeMateriality(request.changes)).toBe('material')
    expect(() => service.update({ ...request, idempotencyKey: 'move-without-approval' }))
      .toThrow(MachineInfoApprovalRequiredError)
    expect(service.require(machineId).revision).toBe(1)

    const wrongApproval = issueApproval(authority, initialMachineInfoApprovalDigest(reviewed))
    expect(() => service.update({ ...request, approvalReceiptId: wrongApproval.id, idempotencyKey: 'wrong-approval' }))
      .toThrow(MachineInfoApprovalRequiredError)

    const approval = issueApproval(authority, machineInfoUpdateApprovalDigest(request))
    const result = service.update({ ...request, approvalReceiptId: approval.id, idempotencyKey: 'approved-move' })

    expect(result.machineInfo.setup.sshTarget).toBe('alice@atlas-new.example.org')
    expect(result.update.materiality).toBe('material')
    expect(result.update.approval).toMatchObject({ kind: 'explicit-user-approval', receiptId: approval.id })
    expect(result.card).toEqual({ kind: 'emit-new-card', reason: 'material-update' })
    expect(authority.approval(LOCAL_OWNER_PRINCIPAL_ID, approval.id)?.state).toBe('consumed')
  })
})
