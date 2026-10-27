/** Narrow re-export seam used to keep MachineApplication imports acyclic. */
export {
  AuthorityConflictError,
  LOCAL_OWNER_PRINCIPAL_ID,
  type RelationalAuthority,
} from './authority.ts'
export { AuthorityProjectionBridge } from './authority-feed.ts'
export {
  AccessConflictError,
  AccessNotFoundError,
  AccessOrderingError,
  AuthAttachmentConflictError,
} from './access-coordinator-contracts.ts'
