import { describe, expect, it } from 'vitest'
import { TransferProgressHub } from '../src/transfer-progress.ts'

describe('TransferProgressHub', () => {
  it('relays a bounded native scp stream without inventing progress fields', () => {
    const hub = new TransferProgressHub()
    hub.start('call-1')
    hub.append('call-1', 'result.tar  42%  4.2GB  80.1MB/s  00:52 ETA\r')
    expect(hub.get('call-1')).toEqual({
      callId: 'call-1',
      status: 'running',
      output: 'result.tar  42%  4.2GB  80.1MB/s  00:52 ETA\r',
    })
    hub.finish('call-1', false)
    expect(hub.get('call-1')?.status).toBe('completed')
  })
})
