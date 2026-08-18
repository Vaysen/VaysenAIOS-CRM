/**
 * Customer-delivery feature switches.
 *
 * Keep unfinished modules in source control while ensuring they are neither
 * visible nor reachable in the client-facing release.
 */
export const RELEASE_FEATURES = {
  aiVoiceCustomerService: false,
  customerFactsReview: true,
  salesSequencesManagement: true,
  salesAutomation: true,
} as const;
