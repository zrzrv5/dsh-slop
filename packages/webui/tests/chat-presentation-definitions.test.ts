import { describe, expect, it } from 'vitest'
import type {
  ConversationMatch,
  ConversationStartMatch,
  ConversationNodeContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  machineConnectionChatDefinition,
  machineConnectionTargetFromArguments,
  machineInfoChatDefinition,
  machineInfoFromToolResult,
  machineTransferProgressChatDefinition,
  machineIdFromConnectionArguments,
  setupMachineChatDefinition,
  setupMachineInputFromToolArguments,
  setupMachineSubmissionChatDefinition,
} from '../src/chat-presentation-definitions.ts'
import { nativeTransferViewport } from '../src/ChatPresentationCards.tsx'
import { formatSetupMachineChatSubmission } from '../src/machine-setup-draft.ts'
import type { SetupMachineCardValues } from '../src/machine-setup-types.ts'

function callMatch(name: string, args: unknown, callId = 'call-1', seq = 10): ConversationStartMatch {
  return {
    event: {
      type: 'tool/call',
      surfaceOp: 'append',
      seq,
      time: 1_700_000_000_000,
      data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
    },
    view: undefined,
    role: 'start',
    location: { kind: 'unresolved' },
  } as unknown as ConversationStartMatch
}

function resultMatch(wire: unknown, callId = 'call-1', seq = 20): ConversationMatch {
  return {
    event: {
      type: 'tool/result',
      surfaceOp: 'append',
      seq,
      time: 1_700_000_001_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message-1',
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: JSON.stringify(wire) }],
          }],
        },
      },
    },
    view: undefined,
    role: 'update',
    location: { kind: 'unresolved' },
  } as unknown as ConversationMatch
}

function userMatch(text: string, messageId = 'message-setup-1', seq = 30): ConversationStartMatch {
  return {
    event: {
      type: 'user/message',
      surfaceOp: 'append',
      seq,
      time: 1_700_000_002_000,
      data: {
        id: messageId,
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    },
    view: undefined,
    role: 'start',
    location: { kind: 'unresolved' },
  } as unknown as ConversationStartMatch
}

function context<State>(kind: string, id: string, start: ConversationStartMatch, state?: State): ConversationNodeContext<State> {
  return {
    key: `${kind}:${id}`,
    kind,
    id,
    matches: state === undefined ? [start] : [start, resultMatch({}, id)],
    start,
    state,
    current: new Map(),
  }
}

describe('typed chat presentation definitions', () => {
  it('does not render setup commands or blank-session events as a connection card', () => {
    for (const event of [
      { type: 'command/run', seq: 3, time: 1, data: { commandId: 'setup-command', name: 'setupmachine', args: '' } },
      { type: 'session/end-seed', seq: 4, time: 1, data: {} },
    ]) expect(setupMachineChatDefinition.match(event as never)).toBeNull()
  })

  it('renders PTC setup and protected connection events without an upstream presentation patch', () => {
    const start = {
      event: {
        type: 'tool/ptc-dispatch-start', seq: 4, time: 1,
        data: { turn: 1, step: 1, parentCallId: 'run-1', subCallId: 'ptc-1', name: 'slop_machine_connect', arguments: { machineId: 'machine-a' } },
      },
      role: 'start', location: { kind: 'unresolved' },
    } as unknown as ConversationStartMatch
    expect(machineConnectionChatDefinition.match(start.event)).toEqual({ id: 'ptc-1', role: 'start' })
    const initial = machineConnectionChatDefinition.start(context('slop-machine-connection', 'ptc-1', start), start, { previous: () => undefined })
    expect(initial).toMatchObject({ machineId: 'machine-a', toolCallId: 'ptc-1', settled: false })
    const result = {
      event: { type: 'tool/ptc-dispatch', seq: 5, time: 2, data: {
        parentCallId: 'run-1', subCallId: 'ptc-1', name: 'slop_machine_connect', arguments: { machineId: 'machine-a' }, content: [],
      } }, role: 'update', location: { kind: 'unresolved' },
    } as unknown as ConversationMatch
    expect(machineConnectionChatDefinition.match(result.event)).toEqual({ id: 'ptc-1', role: 'update' })
    const settled = machineConnectionChatDefinition.update({ ...context('slop-machine-connection', 'ptc-1', start, initial), state: initial }, result)
    expect(settled.settled).toBe(true)
    const setup = { ...start, event: { ...start.event, type: 'tool/ptc-dispatch-start', data: {
      parentCallId: 'run-1', subCallId: 'setup-1', name: 'slop_setup_machine', arguments: { name: 'compute' },
    } } } as unknown as ConversationStartMatch
    expect(setupMachineChatDefinition.match(setup.event)).toEqual({ id: 'setup-1', role: 'start' })
    expect(setupMachineChatDefinition.start(context('slop-setup-machine', 'setup-1', setup), setup, { previous: () => undefined })).toMatchObject({ input: '{"name":"compute"}', toolCallId: 'setup-1' })
  })

  it('projects transfer progress only while its Tool call is pending', () => {
    const start = callMatch('slop_machine_transfer', {
      source: { kind: 'local', path: '/tmp/a' },
      destination: { kind: 'machine', machineId: 'machine-a', path: '/tmp/a' },
    })
    expect(machineTransferProgressChatDefinition.match(start.event)).toEqual({ id: 'call-1', role: 'start' })
    const initial = machineTransferProgressChatDefinition.start(
      context('slop-machine-transfer-progress', 'call-1', start),
      start,
      { previous: () => undefined },
    )
    const running = machineTransferProgressChatDefinition.buildViewNode?.({
      ...context('slop-machine-transfer-progress', 'call-1', start, initial),
      state: initial,
    })
    expect(running).toMatchObject({ visibility: 'visible', data: { toolCallId: 'call-1', machineIds: ['machine-a'], settled: false } })
    const settled = machineTransferProgressChatDefinition.update(
      { ...context('slop-machine-transfer-progress', 'call-1', start, initial), state: initial },
      resultMatch({ ok: true }, 'call-1'),
    )
    const hidden = machineTransferProgressChatDefinition.buildViewNode?.({
      ...context('slop-machine-transfer-progress', 'call-1', start, settled),
      state: settled,
    })
    expect(hidden).toMatchObject({ visibility: 'hidden', data: { settled: true } })
  })

  it('renders carriage-return scp updates in place', () => {
    expect(nativeTransferViewport('file 10%\rfile 42%\rfile 100%\nnext 3%\rnext 9%')).toBe('file 100%\nnext 9%')
    expect(nativeTransferViewport('file 100%\r\n')).toBe('file 100%')
  })

  it('materializes the Agent-triggered Setup Machine card from bounded top-level Tool arguments', () => {
    const input = JSON.stringify({
      machineAlias: 'Nova',
      sshTarget: 'alice@login.cluster.example.edu',
      scheduler: 'slurm',
    })
    const start = callMatch('slop_setup_machine', JSON.parse(input))

    expect(setupMachineInputFromToolArguments(input)).toBe(input)
    expect(setupMachineInputFromToolArguments('[]')).toBeUndefined()
    expect(setupMachineInputFromToolArguments('not-json')).toBeUndefined()
    expect(setupMachineInputFromToolArguments(`{"notes":"${'x'.repeat(33 * 1_024)}"}`)).toBeUndefined()
    expect(setupMachineChatDefinition.match(start.event)).toEqual({ id: 'call-1', role: 'start' })
    expect(setupMachineChatDefinition.match(callMatch('slop_machine_get', {}).event)).toBeNull()

    const state = setupMachineChatDefinition.start(
      context('slop-setup-machine', 'call-1', start),
      start,
      { previous: () => undefined },
    )
    const node = setupMachineChatDefinition.buildViewNode?.({
      ...context('slop-setup-machine', 'call-1', start, state),
      state,
    })
    expect(node).toMatchObject({
      kind: 'slop-setup-machine',
      id: 'call-1',
      target: 'chat',
      location: { kind: 'session' },
      data: { input, toolCallId: 'call-1' },
    })
  })

  it('replays an accepted form against its exact setup call as read-only content', () => {
    const start = callMatch('slop_setup_machine', {})
    const initial = setupMachineChatDefinition.start(context('slop-setup-machine', 'call-1', start), start, { previous: () => undefined })
    const input = formatSetupMachineChatSubmission({ sshTarget: 'cluster', authentication: { kind: 'requires-2fa' }, scheduler: 'unknown', paths: {}, deepDiscovery: false }, 'call-1')
    const accepted = userMatch(input)
    expect(setupMachineChatDefinition.match(accepted.event)).toEqual({ id: 'call-1', role: 'update' })
    const state = setupMachineChatDefinition.update({ ...context('slop-setup-machine', 'call-1', start, initial), state: initial }, accepted)
    const node = setupMachineChatDefinition.buildViewNode?.({ ...context('slop-setup-machine', 'call-1', start, state), state })
    expect(node).toMatchObject({ location: { kind: 'session' }, data: { input, toolCallId: 'call-1' } })
  })

  it('projects an exact tagged Setup submission without changing its user message', () => {
    const values = {
      machineAlias: 'Nova',
      sshTarget: 'alice@login.cluster.example.edu',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: { work: '/work/alice' },
      deepDiscovery: false,
    } satisfies SetupMachineCardValues
    const start = userMatch(formatSetupMachineChatSubmission(values))

    expect(setupMachineSubmissionChatDefinition.match(start.event)).toEqual({ id: 'message-setup-1', role: 'start' })
    expect(setupMachineSubmissionChatDefinition.match(userMatch('ordinary user message').event)).toBeNull()

    const state = setupMachineSubmissionChatDefinition.start(
      context('slop-setup-machine-submission', 'message-setup-1', start),
      start,
      { previous: () => undefined },
    )
    const node = setupMachineSubmissionChatDefinition.buildViewNode?.({
      ...context('slop-setup-machine-submission', 'message-setup-1', start, state),
      state,
    })
    expect(node).toMatchObject({
      kind: 'slop-setup-machine-submission',
      id: 'message-setup-1',
      target: 'chat',
      anchorSeq: 30.001,
      data: { values, messageId: 'message-setup-1' },
    })
    expect(start.event).toMatchObject({ type: 'user/message', surfaceOp: 'append' })
  })

  it('materializes Machine Info only for a saved value whose result requests a card', () => {
    const machineInfo = {
      schemaVersion: 1,
      machineId: '00000000-0000-7000-8000-000000000801',
      ownerPrincipalId: 'local-owner',
      setup: {
        machineAlias: 'Atlas',
        sshTarget: 'alice@atlas.example.org',
        authentication: { kind: 'requires-2fa' },
        scheduler: 'slurm',
        paths: { work: '/work/alice' },
        discoveryProfile: 'ordinary',
      },
      customNotes: 'Use account chem-42.',
      approvedDiscovery: {
        summary: 'Slurm cluster.',
        operatingDefaults: { account: 'chem-42' },
        sections: [{ id: 'software', kind: 'software', title: 'Software', content: 'Modules are available.' }],
      },
      revision: 1,
      initialApproval: {
        kind: 'explicit-user-approval',
        receiptId: '00000000-0000-7000-8000-000000000802',
        effectDigest: 'a'.repeat(64),
        approvedAt: '2026-08-27T12:00:00.000Z',
      },
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    }
    const start = callMatch('slop_machine_info_set', { mode: 'initial', candidate: machineInfo })
    const saved = resultMatch({ schemaVersion: 1, ok: true, value: { machineInfo, card: { kind: 'emit-new-card', reason: 'initial-save' } } })
    const small = resultMatch({ schemaVersion: 1, ok: true, value: { machineInfo, card: { kind: 'card-not-required', reason: 'small-update' } } })
    const fetched = resultMatch({ schemaVersion: 1, ok: true, value: machineInfo })
    const failed = resultMatch({ schemaVersion: 1, ok: false, error: { code: 'INVALID_REQUEST', message: 'approval required', retryable: false } })

    expect(machineInfoFromToolResult(saved, 'slop_machine_info_set')).toMatchObject({ machineId: machineInfo.machineId })
    expect(machineInfoFromToolResult(small, 'slop_machine_info_set')).toBeUndefined()
    expect(machineInfoFromToolResult(fetched, 'slop_machine_info_set')).toBeUndefined()
    expect(machineInfoFromToolResult(failed, 'slop_machine_info_set')).toBeUndefined()
    expect(machineInfoChatDefinition.match(start.event)).toEqual({ id: 'call-1', role: 'start' })

    const initial = machineInfoChatDefinition.start(
      context('slop-machine-info', 'call-1', start),
      start,
      { previous: () => undefined },
    )
    const state = machineInfoChatDefinition.update(
      { ...context('slop-machine-info', 'call-1', start, initial), state: initial },
      saved,
    )
    const node = machineInfoChatDefinition.buildViewNode?.({
      ...context('slop-machine-info', 'call-1', start, state),
      state,
    })
    expect(node).toMatchObject({
      kind: 'slop-machine-info',
      id: machineInfo.machineId,
      data: { machineInfo: { machineId: machineInfo.machineId }, toolCallId: 'call-1' },
    })
  })

  it('reads only the exact top-level Machine id from connection arguments', () => {
    expect(machineIdFromConnectionArguments('{"machineId":"machine-1","purpose":"submit"}')).toBe('machine-1')
    expect(machineIdFromConnectionArguments('{"request":{"machineId":"nested"}}')).toBeUndefined()
    expect(machineIdFromConnectionArguments('not-json')).toBeUndefined()
    expect(machineConnectionTargetFromArguments('{"machineName":"Nova"}')).toEqual({ machineName: 'Nova' })
    expect(machineConnectionTargetFromArguments('{"machineId":"machine-1","machineName":"Nova"}')).toBeUndefined()
    expect(machineConnectionTargetFromArguments('{"machineAlias":"Nova"}')).toBeUndefined()

    expect(machineConnectionChatDefinition.match(callMatch('slop_machine_connect', { machineId: 'machine-1' }).event)).toEqual({ id: 'call-1', role: 'start' })
    expect(machineConnectionChatDefinition.match(callMatch('slop_machine_connect', { machineName: 'Nova' }).event)).toEqual({ id: 'call-1', role: 'start' })
    expect(machineConnectionChatDefinition.match(callMatch('slop_machine_shell', { machineId: 'machine-1', command: 'hostname' }).event)).toEqual({ id: 'call-1', role: 'start' })
    expect(machineConnectionChatDefinition.match(callMatch('slop_machine_get', { machineId: 'machine-1' }).event)).toBeNull()
  })

  it('builds a Machine connection anchor for one exact saved name', () => {
    const start = callMatch('slop_machine_connect', { machineName: 'Nova' })
    const state = machineConnectionChatDefinition.start(
      context('slop-machine-connection', 'call-1', start),
      start,
      { previous: () => undefined },
    )
    expect(machineConnectionChatDefinition.buildViewNode?.({
      ...context('slop-machine-connection', 'call-1', start, state),
      state,
    })).toMatchObject({ id: 'Nova', data: { machineName: 'Nova', settled: false } })
  })

  it('hides a Machine connection anchor under the same key after its Tool call settles', () => {
    const start = callMatch('slop_machine_shell', { machineId: 'machine-1', command: 'hostname' })
    const initial = machineConnectionChatDefinition.start(
      context('slop-machine-connection', 'call-1', start),
      start,
      { previous: () => undefined },
    )
    const settled = machineConnectionChatDefinition.update(
      { ...context('slop-machine-connection', 'call-1', start, initial), state: initial },
      resultMatch({ ok: true }),
    )

    expect(machineConnectionChatDefinition.buildViewNode?.({
      ...context('slop-machine-connection', 'call-1', start, initial),
      state: initial,
    })).toMatchObject({ kind: 'slop-machine-connection', data: { settled: false } })
    expect(settled.settled).toBe(true)
    expect(machineConnectionChatDefinition.buildViewNode?.({
      ...context('slop-machine-connection', 'call-1', start, settled),
      state: settled,
    })).toMatchObject({
      key: 'slop-machine-connection:call-1',
      visibility: 'hidden',
      data: { settled: true },
    })
  })

  it('keeps the same projection key across the incremental Machine shell lifecycle', () => {
    const call = callMatch('slop_machine_shell', { machineId: 'machine-1', command: 'hostname' })
    const initial = machineConnectionChatDefinition.start(
      context('slop-machine-connection', 'call-1', call),
      call,
      { previous: () => undefined },
    )
    const settled = machineConnectionChatDefinition.update(
      { ...context('slop-machine-connection', 'call-1', call, initial), state: initial },
      resultMatch({ ok: true }),
    )
    const initialNode = machineConnectionChatDefinition.buildViewNode?.({
      ...context('slop-machine-connection', 'call-1', call, initial),
      state: initial,
    })
    const settledNode = machineConnectionChatDefinition.buildViewNode?.({
      ...context('slop-machine-connection', 'call-1', call, settled),
      state: settled,
    })

    expect(initialNode?.key).toBe('slop-machine-connection:call-1')
    expect(settledNode?.key).toBe(initialNode?.key)
    expect(settledNode).toMatchObject({ visibility: 'hidden' })
  })

})
