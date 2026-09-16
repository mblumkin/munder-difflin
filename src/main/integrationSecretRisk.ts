/**
 * The current macOS secret boundary is encryption-at-rest, not process identity.
 * Keep the decision pure so the startup policy is independently testable.
 */
export const LOCAL_PROCESS_SECRET_WARNING =
  'Integration credentials are encrypted at rest, but this build does not bind their macOS Keychain access to Munder Difflin\'s code identity. Other processes running as your macOS user may be able to decrypt them. Remove stored credentials that must be isolated from local agents.';

export function integrationSecretRiskWarning(
  platform: NodeJS.Platform,
  storedSecretCount: number
): string | undefined {
  if (platform !== 'darwin' || storedSecretCount <= 0) return undefined;
  return LOCAL_PROCESS_SECRET_WARNING;
}
