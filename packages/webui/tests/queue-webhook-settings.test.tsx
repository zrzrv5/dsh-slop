// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueueWebhookSettings } from '../src/QueueWebhookSettings.tsx'

const value={enabled: true, settings:{revision:1,provider:'cloudflare',publicOrigin:'',port:3791,disabledMachineIds:[]},tokenConfigured:false,receiving:false,connectorRunning:false,localService:'http://127.0.0.1:3791'}
const nonce='abcdefghijklmnopqrstuvwxyz012345'
beforeEach(()=>{vi.stubGlobal('__DSH_SLOP_BOOT__',{csrfNonce:nonce,browserBootstrapPath:'/dsh-slop/browser-bootstrap',knowledgeSettingsBridgePath:'/dsh-slop/knowledge-settings',queueSettingsBridgePath:'/dsh-slop/queue-settings'})})
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()})
describe('Queue webhook settings',()=>{
  it('explains an old Host missing the endpoint and recovers when retried after restart',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce({ok:false,status:404,json:async()=>{throw new SyntaxError('The string did not match the expected pattern.')}})
      .mockResolvedValue({ok:true,status:200,json:async()=>value})
    vi.stubGlobal('fetch',fetch)
    render(<QueueWebhookSettings />)
    expect(await screen.findByText(/Restart DSH to load the updated Queue component/)).toBeDefined()
    expect(screen.queryByText(/SyntaxError/)).toBeNull()
    fireEvent.click(screen.getByRole('button',{name:'Load webhook settings'}))
    expect(await screen.findByLabelText('Public HTTPS origin')).toBeDefined()
    expect(screen.queryByText(/Restart DSH/)).toBeNull()
  })
  it('handles a non-JSON response without exposing the browser parser exception',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('The string did not match the expected pattern.')}})))
    render(<QueueWebhookSettings />)
    expect(await screen.findByText('Webhook settings returned an invalid response. Refresh this page and retry.')).toBeDefined()
  })
  it('saves an explicit token once, clears the input, and displays public-route verification separately',async()=>{
    const fetch=vi.fn(async(_url:unknown,options:RequestInit)=>({ok:true,status:200,json:async()=>options.method==='GET'?value:{...value,settings:{...value.settings,revision:2,publicOrigin:'https://queue.example.com'},tokenConfigured:true,receiving:true}}))
    vi.stubGlobal('fetch',fetch)
    render(<QueueWebhookSettings />)
    await screen.findByLabelText('Public HTTPS origin')
    fireEvent.change(screen.getByLabelText('Public HTTPS origin'),{target:{value:'https://queue.example.com'}})
    fireEvent.change(screen.getByLabelText(/Tunnel token/),{target:{value:'synthetic-test-token'}})
    fireEvent.click(screen.getByRole('button',{name:'Save webhook settings'}))
    await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/dsh-slop/queue-webhook',expect.objectContaining({method:'PUT',headers:expect.objectContaining({'x-dsh-slop-csrf':nonce}),body:expect.stringContaining('"tunnelToken":"synthetic-test-token"')})))
    await waitFor(()=>expect(screen.getByLabelText<HTMLInputElement>(/Tunnel token/).value).toBe(''))
    expect(screen.getByText(/Receiver listening · Public route verified/)).toBeDefined()
    fireEvent.click(screen.getByRole('button',{name:'Test public connection'}))
    await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/dsh-slop/queue-webhook',expect.objectContaining({method:'POST',body:'{"action":"test"}'})))
  })
  it('keeps component enablement exclusively in Plugin Manager when saving connection settings',async()=>{
    const enabled={...value,settings:{...value.settings,publicOrigin:'https://queue.example.com'},tokenConfigured:true,receiving:true}
    const fetch=vi.fn(async()=>({ok:true,status:200,json:async()=>enabled}))
    vi.stubGlobal('fetch',fetch)
    render(<QueueWebhookSettings />)
    await screen.findByLabelText('Public HTTPS origin')
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button',{name:'Save webhook settings'}))
    await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/dsh-slop/queue-webhook',expect.objectContaining({method:'PUT',body:JSON.stringify({provider:'cloudflare',publicOrigin:'https://queue.example.com',port:3791,disabledMachineIds:[],expectedRevision:1})})))
  })
})
