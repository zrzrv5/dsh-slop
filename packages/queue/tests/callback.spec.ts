import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { QueueService } from '../src/service.ts'
import { SqliteQueueStore } from '../src/sqlite-store.ts'
import { nextCheckAfterObservation } from '../src/scheduling.ts'
import type { QueueCallbackEvent } from '../src/callback.ts'
import type { QueueProbePort, QueueDeliveryRequest } from '../src/types.ts'

const cleanup: (()=>Promise<void>)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'queue-callback-'))
  let now=new Date('2026-09-18T00:00:00Z')
  let fails=false
  const delivered:QueueDeliveryRequest[]=[]
  const probe:QueueProbePort={probe:async request=>{
    if(fails)throw new Error('SSH offline')
    return {observations:request.items.map(item=>({queueItemId:item.id,state:'failed',observedAt:now.toISOString(),evidence:'TIMEOUT',source:'code'})),issues:[]}
  }}
  const service=new QueueService({store:new SqliteQueueStore(join(dir,'queue.sqlite')),clock:{now:()=>now},probe,chatDelivery:{deliver:async r=>{delivered.push(r)}}})
  await service.initialize()
  const item=await service.track({ purpose: 'monitor',label:'job',target:{kind:'local'},observer:{kind:'slurm',jobId:'17'}},{primary:{sessionId:'owner',cwd:'/work',agentPreset:'standard'},now:new Date('2026-09-16T00:00:00Z')})
  const runId=randomUUID()
  const event:QueueCallbackEvent={kind:'started',runId,jobId:'17',attempt:0,sequence:1,occurredAt:now.toISOString(),startedAt:now.toISOString()}
  cleanup.push(async()=>{await service.close();await rm(dir,{recursive:true,force:true})})
  return {service,item,event,delivered,setNow:(time:string)=>{now=new Date(time)},setFailure:(value:boolean)=>{fails=value}}
}

describe('Queue execution timeline and callbacks',()=>{
  it('accepts millisecond event timestamps and records whole elapsed seconds', async () => {
    const { service, item, event } = await fixture()
    await service.receiveCallback(item.id, { ...event, occurredAt: '2026-09-18T00:00:01.950Z', startedAt: '2026-09-18T00:00:00.125Z' })
    expect((await service.get(item.id))?.lastObservation?.elapsedSeconds).toBe(1)
  })
  it('keeps a startup window after a long queue wait and honors actual start when discovered late',async()=>{
    const {service,item,event}=await fixture()
    await service.update(item.id,{nextCheckAt:'2026-09-18T01:00:00Z'})
    await service.receiveCallback(item.id,event)
    const running=(await service.get(item.id))!
    expect(running.nextCheckAt).toBe('2026-09-18T00:01:00.000Z')
    expect(nextCheckAfterObservation(running,running.lastObservation!,new Date('2026-09-18T00:08:00Z'))).toBe('2026-09-18T00:09:00.000Z')
    expect(nextCheckAfterObservation(running,{...running.lastObservation!,elapsedSeconds:3600,startedAt:'2026-09-17T23:00:00Z'},new Date('2026-09-18T00:00:00Z'))).toBe('2026-09-18T00:15:00.000Z')
  })
  it('deduplicates and ignores out-of-order reports without postponing checks',async()=>{
    const {service,item,event}=await fixture()
    await service.receiveCallback(item.id,event)
    const revision=(await service.get(item.id))!.revision
    expect(await service.receiveCallback(item.id,event)).toBe('ignored')
    expect((await service.get(item.id))!.revision).toBe(revision)
    const phase={...event,kind:'phase' as const,sequence:3,phase:'equilibration'}
    await service.receiveCallback(item.id,phase)
    expect(await service.receiveCallback(item.id,{...event,sequence:2})).toBe('ignored')
    expect((await service.get(item.id))!.phase).toBe('equilibration')
  })
  it('verifies webhook terminal state, keeps retrying transport failures, and permits scheduler correction',async()=>{
    const f=await fixture()
    await f.service.receiveCallback(f.item.id,f.event)
    await f.service.receiveCallback(f.item.id,{...f.event,kind:'exited',exitCode:0,sequence:2})
    expect((await f.service.get(f.item.id))!.state).toBe('completed')
    expect((await f.service.get(f.item.id))!.callback?.terminalPending).toBe(true)
    f.setFailure(true);f.setNow('2026-09-18T00:02:00Z')
    await f.service.runDue(new Date('2026-09-18T00:02:00Z'))
    expect((await f.service.get(f.item.id))!.nextCheckAt).toBeDefined()
    f.setFailure(false);f.setNow('2026-09-18T00:05:00Z')
    await f.service.runDue(new Date('2026-09-18T00:05:00Z'))
    const final=(await f.service.get(f.item.id))!
    expect(final.state).toBe('failed')
    expect(final.nextCheckAt).toBeUndefined()
    expect(final.callback?.terminalPending).toBe(false)
    expect(await f.service.receiveCallback(f.item.id,{...f.event,kind:'exited',exitCode:0,sequence:4})).toBe('ignored')
    expect(f.delivered.every(r=>r.delivery==='notify')).toBe(true)
  })
  it('rejects another job and future or inverted event times',async()=>{
    const {service,item,event}=await fixture()
    await expect(service.receiveCallback(item.id,{...event,jobId:'18'})).rejects.toThrow('registered job')
    await expect(service.receiveCallback(item.id,{...event,occurredAt:'2027-01-01T00:00:00Z'})).rejects.toThrow('time')
    await expect(service.receiveCallback(item.id,{...event,startedAt:'2026-09-18T00:00:01Z'})).rejects.toThrow('time')
  })
})
