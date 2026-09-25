type RuntimeEnvironment = Record<string, string | undefined>;

interface FlagDefinition {
  /** Environment variable that controls the flag. */
  env: string;
  /** Used when the variable is unset or unparseable. Always the lower-risk behaviour. */
  safeDefault: boolean;
  description: string;
}

/**
 * Every feature flag the server knows about. Flags are read from the
 * environment on each check, so flipping one needs a restart, not a rebuild.
 * Remove a flag (and its old code path) once its rollout is complete.
 */
export const FEATURE_FLAGS = {
  paymentAmountTolerance: {
    env: 'FEATURE_PAYMENT_AMOUNT_TOLERANCE',
    safeDefault: false,
    description:
      'Accept on-chain payments within ±1 stroop of the invoice amount. Off = exact stroop match.',
  },
} as const satisfies Record<string, FlagDefinition>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

const ON = new Set(['true', '1', 'on']);
const OFF = new Set(['false', '0', 'off']);

export function isFeatureEnabled(flag: FeatureFlag, env: RuntimeEnvironment = process.env): boolean {
  const definition: FlagDefinition = FEATURE_FLAGS[flag];
  const raw = env[definition.env]?.trim().toLowerCase();
  if (raw && ON.has(raw)) return true;
  if (raw && OFF.has(raw)) return false;
  return definition.safeDefault;
}

/** Effective state of every flag, reported by /api/health for rollout checks. */
export function featureFlagSnapshot(env: RuntimeEnvironment = process.env): Record<FeatureFlag, boolean> {
  return Object.fromEntries(
    (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).map(flag => [flag, isFeatureEnabled(flag, env)])
  ) as Record<FeatureFlag, boolean>;
}
