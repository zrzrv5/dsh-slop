// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MachineInfoCard, type MachineInfoCardData } from '../src/MachineInfoCard.tsx'

afterEach(cleanup)

function machineInfo(): MachineInfoCardData {
  return {
    schemaVersion: 1,
    machineId: '00000000-0000-7000-8000-000000000801',
    ownerPrincipalId: 'local-owner',
    setup: {
      machineAlias: 'Atlas',
      sshTarget: 'alice@atlas.example.org',
      authentication: { kind: 'passwordless-key', localKeyFilePath: '/Users/alice/.ssh/atlas' },
      scheduler: 'slurm',
      paths: { home: '/home/alice', work: '/work/alice', scratch: '/scratch/alice' },
      discoveryProfile: 'deep',
    },
    customNotes: 'Charge production runs to chem-42. Do not use the debug partition for long jobs.',
    approvedDiscovery: {
      summary: 'Slurm cluster with environment modules and shared project storage.',
      operatingDefaults: { account: 'chem-42', partition: 'compute', queue: 'batch' },
      sections: [
        { id: 'software', kind: 'software', title: 'Software', content: 'LAMMPS 22Jul2025 is available through module lammps.' },
        { id: 'environment', kind: 'environment', title: 'Environment', content: 'Load gcc/14 before the MPI stack.' },
        { id: 'workflow', kind: 'workflow', title: 'Workflow', content: 'Submit production runs with sbatch from /work/alice.' },
      ],
    },
    revision: 3,
    initialApproval: {
      kind: 'explicit-user-approval',
      receiptId: '00000000-0000-7000-8000-000000000802',
      effectDigest: 'a'.repeat(64),
      approvedAt: '2026-08-27T12:00:00.000Z',
    },
    createdAt: '2026-08-27T12:00:00.000Z',
    updatedAt: '2026-08-27T13:30:00.000Z',
  }
}

describe('MachineInfoCard', () => {
  it('shows a compact summary while keeping every saved section in native disclosures', () => {
    const saved = machineInfo()
    render(<MachineInfoCard machineInfo={saved} />)

    const card = document.querySelector<HTMLElement>('[data-slop-presentation="machine-info"]')
    expect(card?.dataset.machineId).toBe(saved.machineId)
    expect(card?.dataset.machineInfoRevision).toBe('3')
    expect(screen.getAllByText('Atlas').length).toBeGreaterThan(0)
    expect(screen.getByText('Machine Info saved')).toBeTruthy()
    expect(screen.getByText(saved.approvedDiscovery.summary)).toBeTruthy()
    expect(screen.getAllByText('alice@atlas.example.org').length).toBeGreaterThan(0)

    const disclosures = Array.from(card?.querySelectorAll('details') ?? [])
    expect(disclosures).toHaveLength(7)
    expect(disclosures.every(disclosure => !disclosure.open)).toBe(true)
    expect(screen.getByText(saved.customNotes)).toBeTruthy()
    expect(screen.getByText(saved.approvedDiscovery.sections[0]?.content ?? '')).toBeTruthy()
    expect(screen.getByText(saved.approvedDiscovery.sections[1]?.content ?? '')).toBeTruthy()
    expect(screen.getByText(saved.approvedDiscovery.sections[2]?.content ?? '')).toBeTruthy()
    expect(screen.getByText(saved.initialApproval.effectDigest)).toBeTruthy()
  })

  it('is read-only and exposes setup details by expanding the existing disclosure control', () => {
    render(<MachineInfoCard machineInfo={machineInfo()} />)
    const card = document.querySelector<HTMLElement>('[data-slop-presentation="machine-info"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector('button, a, input, select, textarea, form')).toBeNull()

    const setupSummary = screen.getByText('Connection and paths').closest('summary')
    expect(setupSummary).not.toBeNull()
    if (setupSummary === null) throw new Error('Setup disclosure summary did not render.')
    fireEvent.click(setupSummary)
    const setup = setupSummary.parentElement
    expect(setup).toBeInstanceOf(HTMLDetailsElement)
    if (!(setup instanceof HTMLDetailsElement)) throw new Error('Setup disclosure did not render as details.')
    expect(setup.open).toBe(true)
    expect(within(setup).getByText('/Users/alice/.ssh/atlas')).toBeTruthy()
    expect(within(setup).getByText('/home/alice')).toBeTruthy()
    expect(within(setup).getByText('/work/alice')).toBeTruthy()
    expect(within(setup).getByText('/scratch/alice')).toBeTruthy()
  })
})
