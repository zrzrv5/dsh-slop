import { mkdtemp, rm, stat, writeFile, readFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueueService, SqliteQueueStore, type QueueCallbackEvent } from '@dsh-slop/queue'
import { QueueWebhook } from '../src/queue-webhook.ts'
import { QueueWebhookStore } from '../src/queue-webhook-store.ts'
import { callbackScript } from '../src/queue-webhook-script.ts'
import { registerQueueWebhookIntegration } from '../src/queue-webhook-integration.ts'

const execute=promisify(execFile)
const cleanup:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
async function freePort():Promise<number>{
  const server=createServer()
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const address=server.address()
  if(address===null||typeof address==='string')throw new Error('Missing TCP address')
  await new Promise<void>(resolve=>server.close(()=>resolve()))
  return address.port
}
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'queue-webhook-'))
  const service=new QueueService({store:new SqliteQueueStore(join(dir,'queue.sqlite')),chatDelivery:{deliver:async()=>{}},probe:{probe:async()=>({observations:[],issues:[]})}})
  await service.initialize()
  const store=new QueueWebhookStore(join(dir,'webhook.sqlite'))
  const refresh=vi.fn(async()=>{})
  let webhook=new QueueWebhook(store,service,{refresh})
  await webhook.start()
  const port=await freePort()
  await webhook.update({expectedRevision:1,provider:'external',publicOrigin:'https://queue.example.com',port,disabledMachineIds:[]})
  const owner={sessionId:'chat-a',cwd:'/work',agentPreset:'standard'}
  const target={kind:'local' as const}
  const prepared=webhook.prepare(target,owner,'slurm')
  const token=/^_dsh_queue_token='([^']+)'$/mu.exec(prepared.script)?.[1]
  if(token===undefined)throw new Error('Missing callback capability')
  const now=new Date().toISOString()
  const event:QueueCallbackEvent={runId:prepared.queueItemId,jobId:'17',attempt:0,sequence:1,kind:'started',occurredAt:now,startedAt:now}
  cleanup.push(async()=>{await webhook.close();await service.close();await rm(dir,{recursive:true,force:true})})
  const post=(body:unknown=event,credential=token)=>fetch(`http://127.0.0.1:${port}/queue/events`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${credential}`},body:JSON.stringify(body)})
  const bind=async()=>{
    webhook.assertRegistration(prepared.queueItemId,target,owner,'slurm')
    const item=await service.track({ purpose: 'monitor',id:prepared.queueItemId,label:'test',target,observer:{kind:'slurm',jobId:'17'}},{primary:owner})
    await webhook.bind(item)
    return item
  }
  return {dir,service,store,prepared,owner,target,event,post,bind,port,token,refresh,get webhook(){return webhook},restart:async()=>{await webhook.close();webhook=new QueueWebhook(new QueueWebhookStore(join(dir,'webhook.sqlite')),service,{refresh});await webhook.start()}}
}

describe('optional Queue webhook ingress',()=>{
  it('adds and removes the optional tool and prompt through the released upstream registries',async()=>{
    const f=await fixture()
    const ctx=new Context()
    await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false})
    await ctx.plugin(ToolRuntime)
    const dispose=registerQueueWebhookIntegration(ctx,f.webhook)
    cleanup.push(async()=>{dispose();await ctx.fiber.dispose()})
    expect(ctx.tools.schemas().map(tool=>tool.name)).toContain('slop_queue_prepare')
    expect((await ctx.systemPrompt.assemble()).sections.some(section=>section.name==='slop:queue-webhook')).toBe(true)
    dispose()
    await f.webhook.close()
    expect(ctx.tools.get('slop_queue_prepare')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.some(section=>section.name==='slop:queue-webhook')).toBe(false)
    await f.restart()
    registerQueueWebhookIntegration(ctx,f.webhook)
    expect(ctx.tools.schemas().filter(tool=>tool.name==='slop_queue_prepare')).toHaveLength(1)
  })
  it('authenticates only task events and preserves an early callback across Host restart and registration',async()=>{
    const f=await fixture()
    if (process.platform !== 'win32') expect((await stat(f.store.path)).mode&0o777).toBe(0o600)
    expect((await f.post(f.event,'x'.repeat(43))).status).toBe(401)
    expect((await f.post({...f.event,command:'touch /tmp/no'})).status).toBe(400)
    expect((await f.post()).status).toBe(204)
    expect(await f.service.get(f.prepared.queueItemId)).toBeUndefined()
    await f.restart()
    const item=await f.bind()
    expect((await f.service.get(item.id))?.state).toBe('running')
    expect((await f.post({...f.event,jobId:'18',sequence:2})).status).toBe(409)
    const before=(await f.service.get(item.id))!.revision
    expect((await f.post()).status).toBe(204)
    expect((await f.service.get(item.id))!.revision).toBe(before)
    expect((await fetch(`http://127.0.0.1:${f.port}/dsh-slop/queue-settings`)).status).toBe(404)
  })
  it('refuses cross-Chat binding and stops receiving without stopping Base polling',async()=>{
    const f=await fixture()
    expect(()=>f.webhook.assertRegistration(f.prepared.queueItemId,f.target,{...f.owner,sessionId:'other'},'slurm')).toThrow('different Chat')
    const item=await f.bind()
    await f.webhook.close()
    expect((await f.service.get(item.id))!.nextCheckAt).toBeDefined()
    await expect(f.post()).rejects.toThrow()
  })
  it('excludes selected Machines and never returns Cloudflare credentials in the settings view',async()=>{
    const f=await fixture()
    const {settings}=f.webhook.view()
    const {revision,...patch}=settings
    await f.webhook.update({...patch,expectedRevision:revision,tunnelToken:'synthetic-tunnel-fixture',disabledMachineIds:['excluded']})
    expect(f.webhook.view().tokenConfigured).toBe(true)
    expect(JSON.stringify(f.webhook.view())).not.toContain('synthetic-tunnel-fixture')
    expect(()=>f.webhook.prepare({kind:'machine',machineId:'excluded'},f.owner,'slurm')).toThrow('not enabled')
  })
  it.skipIf(process.platform === 'win32')('generated Bash reports startup, phase and failure while preserving workload exit status',async()=>{
    const f=await fixture()
    const item=await f.bind()
    const script=callbackScript(`http://127.0.0.1:${f.port}`,f.prepared.queueItemId,f.token)
    const result=await execute('bash',['-e','-c',`${script}\ndsh_queue_event phase "equilibration"\nexit 37`],{env:{...process.env,SLURM_JOB_ID:'17'}}).then(()=>({code:0}),e=>e)
    expect(result.code).toBe(37)
    const final=(await f.service.get(item.id))!
    expect(final.state).toBe('failed')
    expect(final.phase).toBe('equilibration')
    expect(final.callback?.terminalPending).toBe(true)
    expect((await f.service.observations(item.id)).map(o=>o.source)).toEqual(['webhook','webhook','webhook'])
  })
  it.skipIf(process.platform === 'win32')('owns only its managed connector and releases it with the receiver',async()=>{
    const f=await fixture()
    const executable=join(f.dir,'cloudflared')
    const receipt=join(f.dir,'connector.pid')
    await writeFile(executable, '#!/bin/sh\necho $$ > "'+receipt+'"\nexec sleep 600\n')
    await chmod(executable,0o700)
    const originalPath=process.env.PATH
    process.env.PATH=f.dir+':'+originalPath
    cleanup.push(async()=>{process.env.PATH=originalPath})
    const {revision,...settings}=f.webhook.view().settings
    await f.webhook.update({...settings,expectedRevision:revision,provider:'cloudflare',tunnelToken:'synthetic-fixture'})
    let pid=0
    await vi.waitFor(async()=>{pid=Number(await readFile(receipt,'utf8'));expect(pid).toBeGreaterThan(0)})
    expect(f.webhook.view().connectorRunning).toBe(true)
    process.kill(pid,0)
    await f.webhook.close()
    expect(()=>process.kill(pid,0)).toThrow()
    await expect(f.post()).rejects.toThrow()
  })
  it.skipIf(process.platform === 'win32')('callback failure cannot change the workload exit code',async()=>{
    const script=callbackScript('http://127.0.0.1:1','12345678-1234-4234-9234-123456789abc','x'.repeat(43))
    const result=await execute('bash',['-eu','-c',`${script}\nexit 23`]).then(()=>({code:0}),e=>e)
    expect(result.code).toBe(23)
  })
})
