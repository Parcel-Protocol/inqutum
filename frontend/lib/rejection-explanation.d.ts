export interface ClientRecoveryHint {
  step: number;
  action: string;
  targetField?: string;
  automatedRetryEligible: boolean;
}

export interface ClientFieldError {
  field: string;
  code: string;
  message: string;
  hint: string;
}

export interface ClientRejectionExplanation {
  schemaVersion: '1.0';
  reasonCode: string;
  category: string;
  title: string;
  summary: string;
  recoveryAction: string;
  recoveryHints: ClientRecoveryHint[];
  retryable: boolean;
  fieldErrors: ClientFieldError[];
  correlationId: string | null;
}

export function resolveRejectionExplanation(errorOrPayload: unknown): ClientRejectionExplanation;
export const CLIENT_REJECTION_CATALOG: Record<string, {
  category: string;
  title: string;
  summary: string;
  recoveryAction: string;
  retryable: boolean;
}>;
