export enum ErrorCategory {
  VALIDATION = 'VALIDATION',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  DEPENDENCY_UNAVAILABLE = 'DEPENDENCY_UNAVAILABLE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface CategorizedError {
  category: ErrorCategory;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recoverable: boolean;
  statusCode: number;
}

const errorMap = new Map<string, { category: ErrorCategory; recoverable: boolean; statusCode: number }>([
  ['VALIDATION_FAILED', { category: ErrorCategory.VALIDATION, recoverable: false, statusCode: 400 }],
  ['INVALID_INPUT', { category: ErrorCategory.VALIDATION, recoverable: false, statusCode: 400 }],
  ['NOT_FOUND', { category: ErrorCategory.NOT_FOUND, recoverable: false, statusCode: 404 }],
  ['RESOURCE_CONFLICT', { category: ErrorCategory.CONFLICT, recoverable: false, statusCode: 409 }],
  ['RATE_LIMIT_EXCEEDED', { category: ErrorCategory.RATE_LIMITED, recoverable: true, statusCode: 429 }],
  ['SERVICE_UNAVAILABLE', { category: ErrorCategory.DEPENDENCY_UNAVAILABLE, recoverable: true, statusCode: 503 }],
  ['TIMEOUT', { category: ErrorCategory.DEPENDENCY_UNAVAILABLE, recoverable: true, statusCode: 503 }],
  ['INTERNAL_ERROR', { category: ErrorCategory.INTERNAL_ERROR, recoverable: false, statusCode: 500 }],
]);

export function categorizeError(code: string, message: string, details?: Record<string, unknown>): CategorizedError {
  const errorInfo = errorMap.get(code);

  if (!errorInfo) {
    return {
      category: ErrorCategory.INTERNAL_ERROR,
      code,
      message,
      details,
      recoverable: false,
      statusCode: 500,
    };
  }

  return {
    category: errorInfo.category,
    code,
    message,
    details,
    recoverable: errorInfo.recoverable,
    statusCode: errorInfo.statusCode,
  };
}

export function isRecoverableError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as unknown as { code?: string }).code ?? 'INTERNAL_ERROR';
    const errorInfo = errorMap.get(code);
    return errorInfo?.recoverable ?? false;
  }
  return false;
}

export function getErrorStatusCode(code: string): number {
  const errorInfo = errorMap.get(code);
  return errorInfo?.statusCode ?? 500;
}
