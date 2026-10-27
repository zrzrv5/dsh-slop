/** Framework-independent Machine authority and host contracts for DSH-SLOP. */
export * from './primitives.ts'
export * from './canonical.ts'
export * from './schemas.ts'
export * from './application.ts'
export * from './authority.ts'
export * from './authority-feed.ts'
export * from './machine-authority-domains.ts'
export * from './access-coordinator.ts'
export * from './pending-connection-call-adapter.ts'
export * from './inventory-service.ts'
export * from './machine-info.ts'
export * from './machine-info-service.ts'
export * from './machine-application.ts'

export * from './domain/common.ts'
export {
  accessProfileDraftSchema,
  accessProfileSchema,
  declaredRootSchema,
  effectiveSshIdlePolicy,
  localOwnerPrincipalIdSchema,
  MIN_APP_MANAGED_SSH_IDLE_SECONDS,
  sshTargetSchema,
  machineSchema as redesignMachineSchema,
  type AccessProfileDraft,
  type AccessProfile,
  type EffectiveSshIdlePolicy,
  type Machine as RedesignMachine,
} from './domain/inventory.ts'
export {
  accessChallengeRequirementSchema,
  accessChallengeSchema,
  authAttachmentLeaseSchema,
  authCarrierObservationSchema,
  authFlowSchema,
  authPromptObservationSchema,
  connectionObservationSchema,
  connectionPurposeSchema,
  hostTrustDecisionSchema,
  pendingConnectionWaiterSchema,
  connectionLeaseSchema as redesignConnectionLeaseSchema,
  type AccessChallenge,
  type AuthAttachmentLease,
  type AuthCarrierObservation,
  type AuthFlow,
  type AuthPromptObservation,
  type ConnectionObservation,
  type HostTrustDecision,
  type PendingConnectionWaiter,
  type ConnectionLease as RedesignConnectionLease,
} from './domain/access.ts'
export {
  machineConnectionActionSchema,
  machineConnectionPresentationEventSchema,
  machineConnectionPresentationSchema,
  projectionEventSchema,
  type MachineConnectionPresentation,
  type MachineConnectionPresentationEvent,
  type ProjectionEvent as RedesignProjectionEvent,
} from './domain/presentation.ts'
