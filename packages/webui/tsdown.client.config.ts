import { dshClientBuild } from '../../scripts/dsh-client-build.ts'
export default [
  dshClientBuild('@dsh-slop/runtime', 'src/client/index.tsx', '../runtime/lib'),
  dshClientBuild('@dsh-slop/machine', 'src/client/machine.tsx', '../machine/lib'),
  dshClientBuild('@dsh-slop/knowledge', 'src/client/knowledge.tsx', '../knowledge/dist'),
  dshClientBuild('@dsh-slop/queue-plugin', 'src/client/queue.tsx', '../queue-plugin/lib'),
  dshClientBuild('@dsh-slop/queue-webhook', 'src/client/webhook.tsx', '../queue-webhook/lib'),
]
