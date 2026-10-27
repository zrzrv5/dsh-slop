import { describe, expect, it } from 'vitest'
import { configuredReasoningReadinessFromCatalog } from '../src/model-readiness.ts'

describe('configured reasoning route readiness', () => {
  it('accepts the first deployment-configured model without naming a provider in product policy', () => {
    expect(configuredReasoningReadinessFromCatalog([])).toEqual({ status: 'unavailable', name: 'Configured reasoning route' })
    expect(configuredReasoningReadinessFromCatalog([{ id: 'provider-a', name: 'Provider A', models: [] }])).toMatchObject({ status: 'unavailable' })
    expect(configuredReasoningReadinessFromCatalog([{ id: 'provider-a', name: 'Provider A', models: [{ id: 'reasoner', name: 'Reasoner' }] }])).toEqual({ status: 'ready', name: 'Provider A · Reasoner' })
  })
})
