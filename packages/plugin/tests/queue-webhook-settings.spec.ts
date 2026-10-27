import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { serveQueueWebhookSettings } from '../src/queue-webhook-integration.ts'

describe('Queue webhook browser authority',()=>{
  it.each(['missing nonce','foreign origin','cross-site'])('refuses settings mutations with %s',async variant=>{
    const req=new Readable({read(){}}) as IncomingMessage
    req.method='PUT';req.headers={host:'localhost:3080',origin:'http://localhost:3080','x-dsh-slop-csrf':'nonce','content-type':'application/json'}
    req.socket={remoteAddress:'127.0.0.1'} as Socket
    if(variant==='missing nonce')delete req.headers['x-dsh-slop-csrf']
    if(variant==='foreign origin')req.headers.origin='https://example.net'
    if(variant==='cross-site')req.headers['sec-fetch-site']='cross-site'
    const writeHead=vi.fn()
    const res={writeHead,end:vi.fn()} as unknown as ServerResponse
    const backend={update:vi.fn(),testPublic:vi.fn(),view:vi.fn()}
    await serveQueueWebhookSettings(req,res,'nonce',backend,[])
    expect(writeHead).toHaveBeenCalledWith(403,expect.anything())
    expect(backend.update).not.toHaveBeenCalled()
  })
})
