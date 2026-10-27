export * from './types.ts'
export * from './remote-client.ts'
export * from './store.ts'
export * from './context.tsx'
export * from './MachineSettings.tsx'
export * from './chat-presentation-definitions.ts'
export * from './KnowledgeSettings.tsx'
export * from './QueueSettings.tsx'
export * from './MachineInfoCard.tsx'
export * from './SetupConversationCard.tsx'
export type * from './machine-setup-types.ts'
export {
  EMPTY_SETUP_MACHINE_CARD_DRAFT,
  SETUP_MACHINE_CHAT_ENVELOPE_CLOSE,
  SETUP_MACHINE_CHAT_ENVELOPE_OPEN,
  buildSetupMachineCardValues,
  formatSetupMachineChatSubmission,
  isSetupMachineCardReady,
  parseSetupMachineCardInput,
} from './machine-setup-draft.ts'
export * from './ui.tsx'

export { createRemoteFacade } from './remote-client.ts'

/** Shared UI library. Runtime, Machine, Knowledge and Queue own their client entries. */
export function apply(): void {}
export const inject = [] as const
