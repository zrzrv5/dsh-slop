import { describe, expectTypeOf, it } from 'vitest'
import type {
  AccessChallengeReference,
  AuthFlowStartResponse,
  HostTrustDecisionRequest,
  MachineArchiveRequest,
  RemoteMethod,
  RemoteRequest,
  RemoteResponse,
} from '../src/remote-client.ts'
import type { MachineProjection, SnapshotProjection } from '../src/types.ts'

type ExpectedBrowserRemoteMethod =
  | 'slop.snapshot'
  | 'slop.machine.list'
  | 'slop.machine.get'
  | 'slop.machine.archive'
  | 'slop.hostTrust.decide'
  | 'slop.authFlow.start'
  | 'slop.authFlow.status'
  | 'slop.authFlow.cancel'
  | 'slop.transferProgress.get'

describe('Machine browser remote contract', () => {
  it('contains exactly the Machine transport', () => {
    expectTypeOf<RemoteMethod>().toEqualTypeOf<ExpectedBrowserRemoteMethod>()
  })

  it('keeps inventory revisions exact', () => {
    expectTypeOf<RemoteRequest<'slop.machine.archive'>>().toEqualTypeOf<MachineArchiveRequest>()
    expectTypeOf<RemoteResponse<'slop.machine.get'>>().toEqualTypeOf<MachineProjection>()
  })

  it('keeps protected access outside ordinary Chat text', () => {
    expectTypeOf<RemoteRequest<'slop.authFlow.start'>>().toEqualTypeOf<AccessChallengeReference>()
    expectTypeOf<RemoteResponse<'slop.authFlow.start'>>().toEqualTypeOf<AuthFlowStartResponse>()
    expectTypeOf<RemoteRequest<'slop.hostTrust.decide'>>().toEqualTypeOf<HostTrustDecisionRequest>()
  })

  it('exposes the Machine connection baseline', () => {
    expectTypeOf<RemoteResponse<'slop.snapshot'>['snapshot']>().toEqualTypeOf<SnapshotProjection>()
  })
})
