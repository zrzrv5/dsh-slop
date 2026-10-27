import { ChatCard } from './ChatCard.tsx'
import styles from './ChatStatus.module.css'
import { useState, type ReactNode } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { useSlopUi } from './context.tsx'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function parse(value: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(value)) } catch { return undefined }
}

export function remoteShellModel(block: ToolCallViewProps['block']) {
  const settled = 'kind' in block
  const call = settled ? block.call : block
  const preparing = !settled && block.phase === 'preparing'
  const argsRaw = call != null && 'argsRaw' in call ? call.argsRaw : ''
  const args = block.args
  const raw = settled ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''
  const wire = parse(raw)
  const value = wire?.ok === true ? object(wire.value) : wire
  const error = wire?.ok === false ? object(wire.error) : undefined
  const exitCode = typeof value?.exitCode === 'number' ? value.exitCode : undefined
  const timedOut = value?.timedOut === true
  const interrupted = typeof value?.signal === 'string' || error?.code === 'ABORTED' || error?.code === 'OPERATION_CANCELLED'
  const control = object(value?.discoveryControl)
  const failed = settled && (block.isError || wire?.ok === false || timedOut || interrupted || (exitCode !== undefined && exitCode !== 0))
  const stdout = typeof value?.stdout === 'string' ? value.stdout : undefined
  const stderr = typeof value?.stderr === 'string' ? value.stderr : undefined
  const command = args.text('command')
  const workdir = args.text('workdir')
  const machineId = args.text('machineId')
  const machineName = [args.text('machineName'), args.text('machineAlias'), value?.machineAlias].find((name): name is string => typeof name === 'string')
  const duration = settled && block.callTime !== null ? Math.max(0, block.time - block.callTime) : undefined
  return { settled, preparing, raw, command, workdir, machineId, machineName, stdout, stderr, exitCode, duration,
    argsRaw,
    outputNotice: typeof value?.outputNotice === 'string' ? value.outputNotice : undefined,
    error: typeof error?.message === 'string' ? error.message : undefined,
    status: preparing ? 'Preparing' : !settled ? 'Running' : timedOut ? 'Timed out' : interrupted ? 'Interrupted' : failed ? 'Failed' : control !== undefined ? 'Discovery control' : exitCode === 0 ? 'Completed' : 'Result received',
    tone: failed ? 'red' : !settled || exitCode === undefined ? 'yellow' : 'green',
  }
}

/** Public keyed Tool view is shared by native calls and PTC child calls. */
export function RemoteShellView({ block, inspect }: Pick<ToolCallViewProps, 'block' | 'inspect'>): ReactNode {
  const [open, setOpen] = useState(false)
  const { snapshot } = useSlopUi()
  const model = remoteShellModel(block)
  const connection = snapshot?.machineConnections.find(row => row.machineId === model.machineId && row.freshness === 'current')
  const status = !model.settled && connection?.connection.state === 'blocked' ? 'Waiting for Machine access' : model.status
  const machine = connection?.machineLabel
    ?? model.machineName ?? model.machineId ?? 'Machine'
  return <article className={styles['slop-remote-shell']} aria-label={`Remote shell · ${machine}`}>
    <DisclosureRow title={`Remote shell · ${machine}`} open={open} expandable onToggle={() => setOpen(!open)} expandOnRowClick keepContentWhenOpen
      icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="m3 4 4 4-4 4m6 0h4" /></svg>}
      collapsedContent={<span className={styles['slop-shell-summary']}><code title={model.command} className={styles['slop-shell-preview']}>{model.command ?? (model.preparing ? 'Preparing remote shell…' : 'Machine discovery request')}</code><span className={styles[`slop-chat-${model.tone}`]}>{status}{model.duration === undefined ? '' : ` · ${(model.duration / 1000).toFixed(1)}s`}{model.exitCode === undefined ? '' : ` · exit ${model.exitCode}`}</span></span>}>
    <ChatCard>
    {model.workdir === undefined ? null : <div className={styles['slop-shell-workdir']}>{model.workdir}</div>}
    {model.command === undefined ? <div className={styles['slop-shell-workdir']}>{model.preparing ? 'Preparing command arguments…' : 'Machine discovery request'}</div> : <pre className={styles['slop-shell-command']}><code>{model.command}</code></pre>}
    {model.error === undefined ? null : <p className={styles['slop-chat-red']}>{model.error}</p>}
    {model.outputNotice === undefined ? null : <p className={styles['slop-chat-yellow']}>{model.outputNotice}</p>}
    {!model.settled && !model.preparing ? <small className={styles['slop-shell-wait']}>Waiting for remote command output or Machine access…</small> : null}
    {([['stdout', model.stdout], ['stderr', model.stderr]] satisfies [string, string | undefined][]).map(([label, output]) => !output ? null : <details key={label} open={output.length < 2000}>
      <summary>{label} · {output.trimEnd().split('\n').length} {output.trimEnd().split('\n').length === 1 ? 'line' : 'lines'}</summary><pre>{output.slice(0, 32_768)}{output.length > 32_768 ? '\n… Output preview truncated. Open raw evidence for the full result.' : ''}</pre>
    </details>)}
    {model.settled && model.stdout === '' && model.stderr === '' ? <small className={styles['slop-shell-wait']}>No output</small> : null}
    <details className={styles['slop-shell-raw']}><summary>Raw evidence</summary><pre>{model.argsRaw}</pre><pre>{model.raw}</pre></details>
    {inspect === undefined ? null : <button type="button" className={styles['slop-shell-inspect']} onClick={inspect}>Inspect call</button>}
    </ChatCard>
    </DisclosureRow>
  </article>
}
