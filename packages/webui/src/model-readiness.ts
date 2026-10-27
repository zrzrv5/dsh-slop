import { useEffect, useState } from 'react'

export type ModelReadiness = Readonly<{
  status: 'ready' | 'checking' | 'unavailable'
  name: string
}>

export interface ModelReadinessSource {
  check(): Promise<ModelReadiness>
}

export function configuredReasoningReadinessFromCatalog(groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]): ModelReadiness {
  const provider = groups.find(group => group.models.length > 0)
  const model = provider?.models[0]
  return provider === undefined || model === undefined
    ? { status: 'unavailable', name: 'Configured reasoning route' }
    : { status: 'ready', name: provider.name.includes(model.name) ? provider.name : `${provider.name} · ${model.name}` }
}

export function useModelReadiness(source?: ModelReadinessSource): ModelReadiness {
  const [readiness, setReadiness] = useState<ModelReadiness>({ status: source === undefined ? 'ready' : 'checking', name: 'Configured reasoning route' })
  useEffect(() => {
    if (source === undefined) return
    let live = true
    setReadiness(current => ({ ...current, status: 'checking' }))
    void source.check().then(result => { if (live) setReadiness(result) }).catch(() => { if (live) setReadiness({ status: 'unavailable', name: 'Configured reasoning route' }) })
    return () => { live = false }
  }, [source])
  return readiness
}
