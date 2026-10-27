import { join } from 'node:path'
import {
  EXECUTION_AUTHORITY_DOMAINS,
  LOCAL_OWNER_PRINCIPAL_ID,
  accessChallengeSchema,
  accessProfileSchema,
  connectionIdentityDigestFor,
  hostTrustDecisionSchema,
  redesignMachineSchema,
  type AccessChallenge,
  type MachineId,
  type RelationalAuthority,
  type Sha256,
} from '@dsh-slop/core'
import type { SshConnectionProfile } from './types.ts'

interface ConnectionTrustOverrideSource {
  get(machineId: MachineId, profile: SshConnectionProfile): Promise<SshConnectionProfile['trust'] | undefined>
}

interface ActiveTrustOverride {
  readonly identity: Sha256
  readonly fingerprint: string
  readonly generation: number
}

/**
 * Applies accepted TOFU/user-known-hosts decisions without rewriting the
 * AccessProfile revision that exact pending waiters depend on.
 */
export class AuthorityConnectionTrustOverrides implements ConnectionTrustOverrideSource {
  private readonly acceptedOnce = new Map<MachineId, ActiveTrustOverride>()

  constructor(
    private readonly authority: RelationalAuthority,
    private readonly trustRoot: string,
  ) {}

  activateOnce(challenge: AccessChallenge, fingerprint: string): void {
    this.acceptedOnce.set(challenge.machineId, {
      identity: challenge.connectionIdentityDigest,
      fingerprint,
      generation: challenge.generation,
    })
  }

  getKnownHostsPath(machineId: MachineId): string {
    return join(this.trustRoot, `${machineId}.known_hosts`)
  }

  async get(
    machineId: MachineId,
    _profile: SshConnectionProfile,
  ): Promise<SshConnectionProfile['trust'] | undefined> {
    const current = this.currentIdentity(machineId)
    if (current === undefined) return undefined
    const transient = this.acceptedOnce.get(machineId)
    if (transient?.identity === current.identity && transient.generation === current.generation) {
      return this.pinned(machineId, transient.fingerprint)
    }

    const durable = this.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'host-trust-decision', 500)
      .map(record => hostTrustDecisionSchema.parse(record.value))
      .filter(decision => decision.decision === 'trust-and-pin')
      .flatMap(decision => {
        const challengeRecord = this.authority.get(
          LOCAL_OWNER_PRINCIPAL_ID,
          'access-challenge',
          decision.challengeId,
        )
        if (challengeRecord === undefined) return []
        const challenge = accessChallengeSchema.parse(challengeRecord.value)
        return challenge.machineId === machineId
          && challenge.connectionIdentityDigest === current.identity
          && challenge.generation === current.generation
          && decision.challengeRevision < challenge.revision
          ? [{ decision, challenge }]
          : []
      })
      .sort((left, right) => right.decision.decidedAt.localeCompare(left.decision.decidedAt))[0]
    return durable === undefined ? undefined : this.pinned(machineId, durable.decision.fingerprint)
  }

  private pinned(machineId: MachineId, fingerprint: string): SshConnectionProfile['trust'] {
    return {
      mode: 'pinned',
      expectedFingerprints: [fingerprint],
      appKnownHostsPath: this.getKnownHostsPath(machineId),
    }
  }

  private currentIdentity(machineId: MachineId): Readonly<{ identity: Sha256; generation: number }> | undefined {
    const machineRecord = this.authority.get(
      LOCAL_OWNER_PRINCIPAL_ID,
      EXECUTION_AUTHORITY_DOMAINS.machine,
      machineId,
    )
    if (machineRecord === undefined) return undefined
    const machine = redesignMachineSchema.parse(machineRecord.value)
    const accessRecord = this.authority.get(
      LOCAL_OWNER_PRINCIPAL_ID,
      EXECUTION_AUTHORITY_DOMAINS.accessProfile,
      machine.accessProfileId,
    )
    if (accessRecord === undefined) return undefined
    const access = accessProfileSchema.parse(accessRecord.value)
    if (machineRecord.revision !== machine.revision || accessRecord.revision !== access.revision) return undefined
    return { identity: connectionIdentityDigestFor(machine, access), generation: access.revision }
  }
}
