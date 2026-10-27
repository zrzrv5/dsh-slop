import type {
  MachineArchiveRequest,
  RemoteMethod,
  RemoteRequest,
  RemoteResponse,
  SlopRemoteClient,
} from './remote-client.ts'
import type {
  MachineId,
  MachineProjection,
  ProjectionEvent,
  RemoteFailure,
  RemoteResult,
  SnapshotProjection,
} from './types.ts'

const now = '2026-08-21T12:00:00.000Z'
const localMachine = '018f0000-0000-7000-8000-000000000001' as MachineId
const clusterMachine = '018f0000-0000-7000-8000-000000000002' as MachineId

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function fail(code: RemoteFailure['code'], message: string, retryable = false): RemoteResult<never> {
  return { ok: false, error: { code, message, retryable } }
}

export function createFixtureSnapshot(): SnapshotProjection {
  return {
    schemaVersion: 1,
    feedId: 'slop',
    asOfCursor: '12',
    snapshotToken: 'snapshot-demo',
    machineConnections: [{
      schemaVersion: 1,
      id: `${clusterMachine}:ssh:atlas`,
      ownerPrincipalId: 'local-owner',
      machineId: clusterMachine,
      machineLabel: 'Atlas cluster',
      connectionIdentityDigest: 'sha256:connection-demo',
      freshness: 'stale',
      connection: { state: 'stale', lastReadyAt: now, reason: 'Authentication is required.' },
      waitingSessionCount: 0,
      actions: [],
      revision: 2,
      updatedAt: now,
    }],
  }
}

function fixtureMachines(): readonly MachineProjection[] {
  return [
    {
      id: localMachine,
      name: 'Local workstation',
      kind: 'local',
      state: 'ready',
      connectionState: 'ready',
      storageRoot: '/Users/you/projects',
      revision: 4,
      accessProfileRevision: 1,
      baseConfiguration: {
        name: 'Local workstation',
        access: { kind: 'local' },
        declaredRoots: [{ id: 'work', role: 'work', label: 'Primary Work', path: { kind: 'local', path: '/Users/you/projects' } }],
        preferredExecutionProviderId: 'local',
      },
    },
    {
      id: clusterMachine,
      name: 'Atlas cluster',
      kind: 'ssh',
      state: 'degraded',
      connectionState: 'auth-required',
      sshAlias: 'atlas',
      username: 'researcher',
      host: 'atlas.example.edu',
      port: 22,
      trustMode: 'pinned',
      scheduler: 'slurm',
      workPath: '/work/researcher',
      scratchPath: '/scratch/researcher',
      revision: 7,
      accessProfileRevision: 3,
      baseConfiguration: {
        name: 'Atlas cluster',
        access: {
          kind: 'ssh',
          target: { kind: 'config-alias', alias: 'atlas' },
          controlOwnership: 'app-managed',
          trustPolicy: {
            kind: 'pinned',
            expectedFingerprints: ['SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
          },
          vpn: { kind: 'none' },
          authentication: { kind: 'interactive' },
          timeouts: { connectSeconds: 30, keepaliveSeconds: 30, keepaliveMisses: 3, idleSeconds: 900 },
        },
        declaredRoots: [
          { id: 'work', role: 'work', label: 'Primary Work', path: { kind: 'remote', path: '/work/researcher' } },
          { id: 'scratch', role: 'scratch', label: 'Scratch', path: { kind: 'remote', path: '/scratch/researcher' } },
        ],
        preferredExecutionProviderId: 'slurm',
      },
    },
  ]
}

/** Deterministic Machine-only transport used by browser tests. */
export class MockSlopClient implements SlopRemoteClient {
  private snapshot: SnapshotProjection
  private machines = fixtureMachines()
  private readonly listeners = new Set<(event: ProjectionEvent) => void>()

  constructor(snapshot: SnapshotProjection = createFixtureSnapshot()) {
    this.snapshot = structuredClone(snapshot)
  }

  get currentSnapshot(): SnapshotProjection {
    return this.snapshot
  }

  emit(event: ProjectionEvent): void {
    if (event.projection === 'machine-connection') {
      const rows = this.snapshot.machineConnections.filter(row => row.id !== event.id)
      this.snapshot = {
        ...this.snapshot,
        asOfCursor: event.cursor,
        machineConnections: event.change === 'remove'
          ? rows
          : [...rows, event.value as SnapshotProjection['machineConnections'][number]],
      }
    }
    for (const listener of this.listeners) listener(event)
  }

  async call<M extends RemoteMethod>(method: M, request: RemoteRequest<M>): Promise<RemoteResult<RemoteResponse<M>>> {
    return await this.dispatch(method, request) as RemoteResult<RemoteResponse<M>>
  }

  readonly events = {
    subscribe: (
      _feedId: 'slop',
      _cursor: string,
      _token: string,
      onEvent: (event: ProjectionEvent) => void,
      onState?: (state: 'subscribed' | 'resync-required' | 'offline') => void,
    ): (() => void) => {
      this.listeners.add(onEvent)
      onState?.('subscribed')
      return () => { this.listeners.delete(onEvent) }
    },
  }

  private dispatch(method: RemoteMethod, request: unknown): RemoteResult<unknown> {
    switch (method) {
      case 'slop.snapshot': return ok({ snapshot: this.snapshot, complete: true })
      case 'slop.machine.list': return ok(this.machines)
      case 'slop.machine.get': {
        const machine = this.machines.find(item => item.id === (request as { machineId: MachineId }).machineId)
        return machine === undefined ? fail('NOT_FOUND', 'Machine not found.') : ok(machine)
      }
      case 'slop.machine.archive': return this.archiveMachine(request as MachineArchiveRequest)
      case 'slop.hostTrust.decide': {
        const input = request as {
          challengeId: string
          expectedChallengeRevision: number
          decision: 'trust-once' | 'trust-and-pin' | 'reject'
          fingerprint: string
        }
        return ok({
          challenge: { id: input.challengeId, revision: input.expectedChallengeRevision + 1 },
          decision: { decision: input.decision, fingerprint: input.fingerprint },
        })
      }
      case 'slop.authFlow.start': {
        const input = request as { challengeId: string; expectedChallengeRevision: number }
        return ok({
          scope: 'machine',
          authFlowId: 'auth-demo',
          carrierFlowId: 'carrier-demo',
          challenge: { id: input.challengeId, revision: input.expectedChallengeRevision + 1 },
          expiresAt: '2026-08-21T13:00:00.000Z',
        })
      }
      case 'slop.authFlow.status': return ok({ state: 'pending', resumed: false })
      case 'slop.authFlow.cancel': return ok({ cancelled: true })
      default: return fail('UNAVAILABLE', `Mock transport does not implement ${String(method)}.`)
    }
  }

  private archiveMachine(request: MachineArchiveRequest): RemoteResult<MachineProjection> {
    const current = this.machines.find(machine => machine.id === request.machineId)
    if (current === undefined) return fail('NOT_FOUND', 'Machine not found.')
    if (current.revision !== request.expectedMachineRevision
      || current.accessProfileRevision !== request.expectedAccessProfileRevision) {
      return fail('STALE', 'Machine or AccessProfile revision conflict.')
    }
    const archived: MachineProjection = {
      ...current,
      state: 'archived',
      revision: current.revision + 1,
      archivedAt: now,
    }
    this.machines = this.machines.filter(machine => machine.id !== archived.id)
    return ok(archived)
  }
}

export function createMockSlopClient(snapshot?: SnapshotProjection): MockSlopClient {
  return new MockSlopClient(snapshot)
}
