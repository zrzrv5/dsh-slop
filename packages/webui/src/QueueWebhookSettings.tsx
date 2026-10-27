import { useEffect, useState, type ReactNode } from 'react'
import { browserBoot, refreshBrowserBoot } from './browser-boot.ts'
import { useOptionalSlopUi } from './context.tsx'
import type { MachineProjection } from './types.ts'
import { Button, Checkbox, Notice, Panel, SectionHeading, SelectInput, TextInput, formatDate } from './ui.tsx'

interface Settings { revision: number; provider: 'cloudflare' | 'external'; publicOrigin: string; port: number; disabledMachineIds: string[] }
interface View { enabled: boolean; settings: Settings; tokenConfigured: boolean; receiving: boolean; connectorRunning: boolean; localService: string; error?: string; lastEventAt?: string; publicVerifiedAt?: string }
function record(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function decode(value: unknown): View {
  if (!record(value) || !record(value.settings)) throw new Error('Invalid webhook settings response')
  const s=value.settings
  if (typeof s.revision !== 'number' || typeof value.enabled !== 'boolean' || (s.provider !== 'cloudflare' && s.provider !== 'external') || typeof s.publicOrigin !== 'string' || typeof s.port !== 'number' || !Array.isArray(s.disabledMachineIds) || !s.disabledMachineIds.every(x=>typeof x==='string') || typeof value.tokenConfigured !== 'boolean' || typeof value.receiving !== 'boolean' || typeof value.connectorRunning !== 'boolean' || typeof value.localService !== 'string') throw new Error('Invalid webhook settings response')
  return { enabled: value.enabled, settings: { revision:s.revision,provider:s.provider,publicOrigin:s.publicOrigin,port:s.port,disabledMachineIds:s.disabledMachineIds }, tokenConfigured:value.tokenConfigured,receiving:value.receiving,connectorRunning:value.connectorRunning,localService:value.localService,
    ...(typeof value.error==='string'?{error:value.error}:{}),...(typeof value.lastEventAt==='string'?{lastEventAt:value.lastEventAt}:{}),...(typeof value.publicVerifiedAt==='string'?{publicVerifiedAt:value.publicVerifiedAt}:{}) }
}
async function request(method: 'GET'|'PUT'|'POST',body?:unknown): Promise<View> {
  let boot=browserBoot()??await refreshBrowserBoot()
  if(boot===undefined)throw new Error('Browser authorization is unavailable')
  const send=(nonce:string)=>fetch('/dsh-slop/queue-webhook',{method,credentials:'same-origin',headers:{'x-dsh-slop-csrf':nonce,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  let response=await send(boot.csrfNonce)
  if(response.status===403){boot=await refreshBrowserBoot();if(boot!==undefined)response=await send(boot.csrfNonce)}
  if(response.status===404)throw new Error('Webhook settings are unavailable on this Host. Restart DSH to load the updated Queue component, then refresh this page.')
  const value:unknown=await response.json().catch(()=>undefined)
  if(!response.ok)throw new Error(record(value)&&typeof value.error==='string'?value.error:'Webhook request failed')
  if(value===undefined)throw new Error('Webhook settings returned an invalid response. Refresh this page and retry.')
  return decode(value)
}

/** Optional ingress controls share the existing Queue settings and browser authority. */
export function QueueWebhookSettings(): ReactNode {
  const ui=useOptionalSlopUi()
  const [machines,setMachines]=useState<readonly MachineProjection[]>([])
  const [view,setView]=useState<View>()
  const [draft,setDraft]=useState<Settings>()
  const [token,setToken]=useState('')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState<string>()
  const adopt=(next:View)=>{setView(next);setDraft(next.settings);setToken('')}
  useEffect(()=>{let active=true;void request('GET').then(v=>{if(active)adopt(v)}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not load webhook settings.')});return()=>{active=false}},[])
  useEffect(()=>{let active=true;if(ui!==undefined&&ui.state.enabled!==false)void ui.client.call('slop.machine.list',{}).then(r=>{if(active&&r.ok)setMachines(r.value)});return()=>{active=false}},[ui?.client,ui?.state.enabled])
  const run=async(method:'GET'|'PUT'|'POST',body?:unknown)=>{
    setBusy(true);setError(undefined)
    try{adopt(await request(method,body))}catch(e){setError(e instanceof Error?e.message:'Webhook request failed')}finally{setBusy(false)}
  }
  return <Panel className="slop-settings-form">
    <SectionHeading title="Queue public callbacks" description="Optional startup, phase, and exit reports. Adaptive polling stays enabled." />
    {error===undefined?null:<Notice tone="danger">{error}</Notice>}
    {draft===undefined?<Button variant="secondary" onClick={()=>{void run('GET')}} disabled={busy}>Load webhook settings</Button>:<>
      <SelectInput label="Public connection" value={draft.provider} options={[{value:'cloudflare',label:'Cloudflare Tunnel'},{value:'external',label:'My HTTPS reverse proxy'}]} onChange={e=>setDraft({...draft,provider:e.target.value==='cloudflare'?'cloudflare':'external'})} disabled={busy} />
      {draft.provider==='cloudflare'?<>
        <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Open Cloudflare setup</a>
        <p className="slop-muted">Create a cloudflared Tunnel in your account, add a public hostname from your domain, and route it to <code>http://127.0.0.1:{draft.port}</code>. Install cloudflared on this Host. DSH starts and stops its connector.</p>
        <TextInput label="Tunnel token" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder={view?.tokenConfigured?'Saved — leave blank to keep':'Paste the Tunnel token'} disabled={busy} hint="Stored only on this Host. It is never included in job scripts or Agent instructions." />
      </>:<p className="slop-muted">Forward your HTTPS origin to <code>http://127.0.0.1:{draft.port}</code> on this Host.</p>}
      <TextInput label="Public HTTPS origin" value={draft.publicOrigin} onChange={e=>setDraft({...draft,publicOrigin:e.target.value})} placeholder="https://queue.example.com" disabled={busy} />
      <TextInput label="Callback port" type="number" min={1024} max={65535} value={String(draft.port)} onChange={e=>setDraft({...draft,port:Number(e.target.value)})} disabled={busy} />
      {machines.length===0?null:<div><p>Allow optional callback registration on these Machines:</p>{machines.map(m=><Checkbox key={m.id} label={m.name} checked={!draft.disabledMachineIds.includes(m.id)} onChange={checked=>setDraft({...draft,disabledMachineIds:checked?draft.disabledMachineIds.filter(id=>id!==m.id):[...draft.disabledMachineIds,m.id]})} disabled={busy} />)}</div>}
      <div className="slop-form-actions">
        <Button onClick={()=>{void run('PUT',{...draft,expectedRevision:draft.revision,revision:undefined,...(token?{tunnelToken:token}:{})})}} disabled={busy}>Save webhook settings</Button>
        <Button variant="secondary" onClick={()=>{void run('POST',{action:'test'})}} disabled={busy||!view?.receiving}>Test public connection</Button>
        <Button variant="ghost" onClick={()=>{void run('GET')}} disabled={busy}>Refresh connection</Button>
      </div>
      {view===undefined?null:<p className="slop-muted">Component {view.enabled?'enabled':'disabled'} · Receiver {view.receiving?'listening':'off'} · Public route verified {formatDate(view.publicVerifiedAt)} · Last event {formatDate(view.lastEventAt)}</p>}
      {view?.error===undefined?null:<Notice tone="warning">{view.error}</Notice>}
    </>}
  </Panel>
}
