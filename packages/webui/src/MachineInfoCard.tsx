import { ChatCard } from './ChatCard.tsx'
import type { ReactNode } from 'react'
import { Disclosure, formatDate, humanLabel } from './ui.tsx'

export type MachineInfoCardAuthentication =
  | { readonly kind: 'requires-2fa' }
  | { readonly kind: 'passwordless-key'; readonly localKeyFilePath: string }

export interface MachineInfoCardDiscoverySection {
  readonly id: string
  readonly kind: 'scheduler' | 'paths' | 'accounts' | 'software' | 'environment' | 'workflow' | 'other'
  readonly title: string
  readonly content: string
}

export interface MachineInfoCardData {
  readonly schemaVersion: 1
  readonly machineId: string
  readonly ownerPrincipalId: 'local-owner'
  readonly setup: {
    readonly machineAlias?: string
    readonly sshTarget: string
    readonly authentication: MachineInfoCardAuthentication
    readonly scheduler: 'slurm' | 'pbs' | 'none' | 'unknown'
    readonly paths: {
      readonly home?: string
      readonly work?: string
      readonly scratch?: string
    }
    readonly discoveryProfile: 'ordinary' | 'deep'
  }
  readonly customNotes: string
  readonly approvedDiscovery: {
    readonly summary: string
    readonly operatingDefaults: {
      readonly account?: string
      readonly allocation?: string
      readonly partition?: string
      readonly queue?: string
    }
    readonly sections: readonly MachineInfoCardDiscoverySection[]
  }
  readonly revision: number
  readonly initialApproval: {
    readonly kind: 'explicit-user-approval'
    readonly receiptId: string
    readonly effectDigest: string
    readonly approvedAt: string
  }
  readonly createdAt: string
  readonly updatedAt: string
}

export interface MachineInfoCardProps {
  readonly machineInfo: MachineInfoCardData
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function authenticationFrom(value: unknown): MachineInfoCardAuthentication | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'requires-2fa') return { kind: 'requires-2fa' }
  if (value.kind === 'passwordless-key' && typeof value.localKeyFilePath === 'string') {
    return { kind: 'passwordless-key', localKeyFilePath: value.localKeyFilePath }
  }
  return undefined
}

function discoverySectionFrom(value: unknown): MachineInfoCardDiscoverySection | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || typeof value.content !== 'string') return undefined
  const kind = value.kind
  if (kind !== 'scheduler' && kind !== 'paths' && kind !== 'accounts' && kind !== 'software'
    && kind !== 'environment' && kind !== 'workflow' && kind !== 'other') return undefined
  return { id: value.id, kind, title: value.title, content: value.content }
}

/** Validate the complete persisted value before a Tool result reaches the card. */
export function parseMachineInfoCardData(value: unknown): MachineInfoCardData | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.machineId !== 'string'
    || value.ownerPrincipalId !== 'local-owner'
    || !isRecord(value.setup)
    || !isRecord(value.approvedDiscovery)
    || !isRecord(value.initialApproval)) return undefined

  const setup = value.setup
  const discovery = value.approvedDiscovery
  const approval = value.initialApproval
  if (!isRecord(setup.paths)
    || !isRecord(discovery.operatingDefaults)
    || !Array.isArray(discovery.sections)) return undefined
  const paths = setup.paths
  const defaults = discovery.operatingDefaults
  const authentication = authenticationFrom(setup.authentication)
  const sections = discovery.sections.map(discoverySectionFrom)

  if (authentication === undefined
    || !optionalString(setup.machineAlias)
    || typeof setup.sshTarget !== 'string'
    || (setup.scheduler !== 'slurm' && setup.scheduler !== 'pbs' && setup.scheduler !== 'none' && setup.scheduler !== 'unknown')
    || !optionalString(paths.home)
    || !optionalString(paths.work)
    || !optionalString(paths.scratch)
    || (setup.discoveryProfile !== 'ordinary' && setup.discoveryProfile !== 'deep')
    || typeof value.customNotes !== 'string'
    || typeof discovery.summary !== 'string'
    || !optionalString(defaults.account)
    || !optionalString(defaults.allocation)
    || !optionalString(defaults.partition)
    || !optionalString(defaults.queue)
    || sections.some(section => section === undefined)
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || approval.kind !== 'explicit-user-approval'
    || typeof approval.receiptId !== 'string'
    || typeof approval.effectDigest !== 'string'
    || typeof approval.approvedAt !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string') return undefined

  const parsedSections: MachineInfoCardDiscoverySection[] = []
  for (const section of sections) {
    if (section === undefined) return undefined
    parsedSections.push(section)
  }
  return {
    schemaVersion: 1,
    machineId: value.machineId,
    ownerPrincipalId: 'local-owner',
    setup: {
      ...(setup.machineAlias === undefined ? {} : { machineAlias: setup.machineAlias }),
      sshTarget: setup.sshTarget,
      authentication,
      scheduler: setup.scheduler,
      paths: {
        ...(paths.home === undefined ? {} : { home: paths.home }),
        ...(paths.work === undefined ? {} : { work: paths.work }),
        ...(paths.scratch === undefined ? {} : { scratch: paths.scratch }),
      },
      discoveryProfile: setup.discoveryProfile,
    },
    customNotes: value.customNotes,
    approvedDiscovery: {
      summary: discovery.summary,
      operatingDefaults: {
        ...(defaults.account === undefined ? {} : { account: defaults.account }),
        ...(defaults.allocation === undefined ? {} : { allocation: defaults.allocation }),
        ...(defaults.partition === undefined ? {} : { partition: defaults.partition }),
        ...(defaults.queue === undefined ? {} : { queue: defaults.queue }),
      },
      sections: parsedSections,
    },
    revision: value.revision,
    initialApproval: {
      kind: 'explicit-user-approval',
      receiptId: approval.receiptId,
      effectDigest: approval.effectDigest,
      approvedAt: approval.approvedAt,
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function authenticationLabel(authentication: MachineInfoCardAuthentication): string {
  switch (authentication.kind) {
    case 'requires-2fa': return 'Password or 2FA'
    case 'passwordless-key': return 'SSH key'
    default: {
      const _exhaustive: never = authentication
      return _exhaustive
    }
  }
}

/** Read-only compact projection, with operational and audit details on demand. */
export function MachineInfoCard({ machineInfo }: MachineInfoCardProps): ReactNode {
  const title = machineInfo.setup.machineAlias ?? machineInfo.setup.sshTarget
  const defaults = Object.entries(machineInfo.approvedDiscovery.operatingDefaults)
  return <ChatCard className="slop-machine-info" data-slop-presentation="machine-info" data-machine-id={machineInfo.machineId} data-machine-info-revision={machineInfo.revision}>
    <div className="slop-machine-summary"><strong>{title}</strong><span>Machine Info saved</span><span>{humanLabel(machineInfo.setup.scheduler)}</span></div>
    {machineInfo.setup.paths.work ? <code>{machineInfo.setup.paths.work}</code> : null}
    <p>{machineInfo.approvedDiscovery.summary}</p>
    <Disclosure title="Connection and paths">
      <dl className="slop-definition-list">
        <div><dt>SSH target</dt><dd><code>{machineInfo.setup.sshTarget}</code></dd></div>
        <div><dt>Authentication</dt><dd>{authenticationLabel(machineInfo.setup.authentication)}</dd></div>
        {machineInfo.setup.authentication.kind === 'passwordless-key' ? <div><dt>Local key file</dt><dd><code>{machineInfo.setup.authentication.localKeyFilePath}</code></dd></div> : null}
        {Object.entries(machineInfo.setup.paths).map(([role, path]) => <div key={role}><dt>{humanLabel(role)}</dt><dd><code>{path}</code></dd></div>)}
      </dl>
    </Disclosure>
    {machineInfo.customNotes ? <Disclosure title="Notes"><p>{machineInfo.customNotes}</p></Disclosure> : null}
    {defaults.length ? <Disclosure title="Operating defaults"><dl className="slop-definition-list">{defaults.map(([label, value]) => <div key={label}><dt>{humanLabel(label)}</dt><dd>{value}</dd></div>)}</dl></Disclosure> : null}
    {machineInfo.approvedDiscovery.sections.map(section => <Disclosure key={section.id} title={section.title}><p className="slop-machine-section">{section.content}</p></Disclosure>)}
    <Disclosure title="Saved record" description={`Revision ${machineInfo.revision} · ${formatDate(machineInfo.updatedAt)}`}>
      <dl className="slop-definition-list">
        <div><dt>Machine ID</dt><dd><code>{machineInfo.machineId}</code></dd></div>
        <div><dt>Owner</dt><dd>{machineInfo.ownerPrincipalId}</dd></div>
        <div><dt>Created</dt><dd>{formatDate(machineInfo.createdAt)}</dd></div>
        <div><dt>Initial approval</dt><dd>{formatDate(machineInfo.initialApproval.approvedAt)}</dd></div>
        <div><dt>Approval receipt</dt><dd><code>{machineInfo.initialApproval.receiptId}</code></dd></div>
        <div><dt>Approved digest</dt><dd><code>{machineInfo.initialApproval.effectDigest}</code></dd></div>
      </dl>
    </Disclosure>
  </ChatCard>
}
