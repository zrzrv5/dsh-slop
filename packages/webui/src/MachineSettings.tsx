import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSlopUi } from './context.tsx'
import type {
  MachineConnectionPresentation,
  MachineId,
  MachineProjection,
  SnapshotProjection,
} from './types.ts'
import {
  Button,
  EmptyState,
  FilterBar,
  Notice,
  Panel,
  SectionHeading,
  StatusBadge,
  TextInput,
  cx,
  formatDate,
  humanLabel,
} from './ui.tsx'

function randomKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `slop-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function freshnessRank(value: MachineConnectionPresentation['freshness']): number {
  if (value === 'current') return 2
  if (value === 'unknown') return 1
  return 0
}

/** Prefer the current access identity, then the newest compatible presentation. */
export function connectionForMachine(
  snapshot: SnapshotProjection | undefined,
  machineId: MachineId,
): MachineConnectionPresentation | undefined {
  return snapshot?.machineConnections
    .filter(item => item.machineId === machineId)
    .reduce<MachineConnectionPresentation | undefined>((selected, candidate) => {
      if (selected === undefined) return candidate
      const freshness = freshnessRank(candidate.freshness) - freshnessRank(selected.freshness)
      if (freshness !== 0) return freshness > 0 ? candidate : selected
      if (candidate.updatedAt !== selected.updatedAt) {
        return candidate.updatedAt > selected.updatedAt ? candidate : selected
      }
      return candidate.revision > selected.revision ? candidate : selected
    }, undefined)
}

function valueOrUnset(value: string | undefined): ReactNode {
  return value === undefined || value.length === 0 ? 'Not set' : <code>{value}</code>
}

function MachineDetail({
  machine,
  onBack,
  onArchive,
}: {
  readonly machine: MachineProjection
  readonly onBack: () => void
  readonly onArchive: () => Promise<void>
}): ReactNode {
  const { snapshot } = useSlopUi()
  const connection = connectionForMachine(snapshot, machine.id)
  const connectionState = machine.kind === 'local' ? 'ready' : connection?.connection.state ?? machine.connectionState
  const access = machine.baseConfiguration.access
  const target = access.kind === 'ssh'
    ? access.target.kind === 'config-alias'
      ? access.target.alias
      : `${access.target.user === undefined ? '' : `${access.target.user}@`}${access.target.host}`
    : undefined
  const authentication = access.kind === 'ssh'
    ? access.authentication.kind === 'interactive'
      ? 'Interactive sign-in / 2FA'
      : access.authentication.kind === 'ssh-agent'
        ? 'Passwordless key or SSH agent'
        : 'Provider managed'
    : 'Local DSH runtime'

  return <div className="slop-view slop-detail-view">
    <div className="slop-back-row">
      <Button variant="ghost" size="sm" onClick={onBack}>← Machines</Button>
      <span className="slop-detail-id">{machine.id}</span>
    </div>
    <SectionHeading
      title={machine.name}
      description={machine.kind === 'local' ? 'Local DSH runtime' : target ?? 'SSH target'}
      actions={<div className="slop-section-actions">
        <StatusBadge value={connectionState} />
        {machine.kind === 'local'
          ? null
          : <Button variant="ghost" size="sm" onClick={() => { void onArchive() }}>Archive</Button>}
      </div>}
    />
    {connection?.connection.state === 'blocked'
      ? <Notice tone="info">This Machine is waiting for {humanLabel(connection.connection.challenge.kind)} in the Chat that requested access.</Notice>
      : null}
    <Panel>
      <SectionHeading title="Machine record" description="Setup and corrections happen in Chat; this page is read-only." />
      <dl className="slop-definition-list">
        <div><dt>Kind</dt><dd>{humanLabel(machine.kind)}</dd></div>
        <div><dt>SSH target</dt><dd>{valueOrUnset(target)}</dd></div>
        <div><dt>Authentication</dt><dd>{authentication}</dd></div>
        <div><dt>Scheduler</dt><dd>{machine.scheduler ?? machine.schedulerPreference ?? 'Unknown'}</dd></div>
        <div><dt>Home</dt><dd>{valueOrUnset(machine.homePath)}</dd></div>
        <div><dt>Work</dt><dd>{valueOrUnset(machine.workPath)}</dd></div>
        <div><dt>Scratch</dt><dd>{valueOrUnset(machine.scratchPath)}</dd></div>
        <div><dt>Machine revision</dt><dd>{machine.revision}</dd></div>
        <div><dt>Access revision</dt><dd>{machine.accessProfileRevision}</dd></div>
        <div><dt>Connection observed</dt><dd>{connection === undefined ? 'Not yet' : formatDate(connection.updatedAt)}</dd></div>
      </dl>
    </Panel>
  </div>
}

export interface MachineSettingsProps {
  readonly initialMachineId?: string
  readonly compact?: boolean
}

/** Read-only Machine inventory. Chat owns setup, connection, discovery, and corrections. */
export function MachineSettings({ initialMachineId, compact = false }: MachineSettingsProps): ReactNode {
  const { client, reload: reloadBaseline, navigate, snapshot } = useSlopUi()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(initialMachineId)
  const [error, setError] = useState<string>()
  const [inventory, setInventory] = useState<readonly MachineProjection[]>([])
  const loadMachines = useCallback(async (): Promise<void> => {
    const result = await client.call('slop.machine.list', {})
    if (!result.ok) setError(result.error.message)
    else {
      setError(undefined)
      setInventory(result.value)
    }
  }, [client])
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([reloadBaseline(), loadMachines()])
  }, [loadMachines, reloadBaseline])
  useEffect(() => { void loadMachines() }, [loadMachines])
  const machines = useMemo(() => inventory.filter(machine => (
    machine.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    || (machine.target ?? '').toLocaleLowerCase().includes(search.toLocaleLowerCase())
  )), [inventory, search])
  const selected = inventory.find(machine => machine.id === selectedId)
  const archive = async (machine: MachineProjection): Promise<void> => {
    const result = await client.call('slop.machine.archive', {
      schemaVersion: 1,
      machineId: machine.id,
      expectedMachineRevision: machine.revision,
      expectedAccessProfileRevision: machine.accessProfileRevision,
      idempotencyKey: randomKey(),
    })
    if (!result.ok) setError(result.error.message)
    else {
      setError(undefined)
      setSelectedId(undefined)
      await refresh()
    }
  }

  if (selected !== undefined && !compact) {
    return <MachineDetail
      machine={selected}
      onBack={() => { setSelectedId(undefined) }}
      onArchive={async () => { await archive(selected) }}
    />
  }

  return <div className={cx('slop-view', compact && 'slop-view-embedded')}>
    <SectionHeading title="Machines" description="Saved Machine records and current connection state." />
    {error === undefined ? null : <Notice tone="danger">{error}</Notice>}
    <Notice tone="info">Machine setup starts in Chat with <code>/onboard-slop</code>.</Notice>
    <FilterBar>
      <TextInput
        label="Search machines"
        placeholder="Name, alias, or target"
        value={search}
        onChange={event => { setSearch(event.target.value) }}
      />
      <div className="slop-filter-spacer" />
      <Button variant="ghost" size="sm" onClick={() => { void refresh() }}>Refresh</Button>
    </FilterBar>
    <div className="slop-machine-list" role="list">
      {machines.map(machine => {
        const connection = connectionForMachine(snapshot, machine.id)
        return <button
          type="button"
          className="slop-machine-row"
          key={machine.id}
          onClick={() => {
            if (compact) navigate({ kind: 'machines', machineId: machine.id })
            else setSelectedId(machine.id)
          }}
        >
          <span className="slop-machine-mark" aria-hidden="true">{machine.kind === 'local' ? '⌂' : '⇄'}</span>
          <span className="slop-machine-main">
            <strong>{machine.name}</strong>
            <small>{machine.kind === 'local' ? 'Local host' : machine.sshAlias ?? machine.target ?? 'SSH target'} · {machine.scheduler ?? 'scheduler unknown'}</small>
          </span>
          <span className="slop-machine-meta">
            <StatusBadge value={machine.kind === 'local' ? 'ready' : connection?.connection.state ?? machine.connectionState} />
            <small>{connection === undefined ? 'Never checked' : formatDate(connection.updatedAt)}</small>
          </span>
          <span className="slop-chevron" aria-hidden="true">›</span>
        </button>
      })}
    </div>
    {machines.length === 0
      ? <EmptyState title="No machines found" description={search ? 'Try a different name or target.' : 'Use /onboard-slop in Chat to add a compute machine.'} />
      : null}
  </div>
}
