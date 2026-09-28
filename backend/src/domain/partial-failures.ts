export type PartialFailureCode =
  | 'ALL_SUCCESS'
  | 'PARTIAL_FAILURE'
  | 'TOTAL_FAILURE'
  | 'INVALID_BATCH';

export interface OperationResult {
  id: string;
  ok: boolean;
  code: string;
  error?: string;
}

export interface PartialFailureResult {
  code: PartialFailureCode;
  successful: number;
  failed: number;
  total: number;
  results: OperationResult[];
  recoverable: boolean;
}

export interface BatchOperation {
  id: string;
  operation: string;
  payload?: unknown;
}

export async function processBatch(
  operations: BatchOperation[],
  executor: (op: BatchOperation) => Promise<OperationResult>
): Promise<PartialFailureResult> {
  if (!Array.isArray(operations) || operations.length === 0) {
    return {
      code: 'INVALID_BATCH',
      successful: 0,
      failed: 0,
      total: 0,
      results: [],
      recoverable: false,
    };
  }

  const results: OperationResult[] = [];
  let successful = 0;
  let failed = 0;

  for (const op of operations) {
    if (!op.id || !op.operation) {
      results.push({
        id: op.id ?? `unknown-${failed}`,
        ok: false,
        code: 'INVALID_BATCH',
        error: 'Operation must have id and operation name.',
      });
      failed++;
      continue;
    }

    try {
      const result = await executor(op);
      results.push(result);
      if (result.ok) {
        successful++;
      } else {
        failed++;
      }
    } catch (error) {
      results.push({
        id: op.id,
        ok: false,
        code: 'EXECUTION_ERROR',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      failed++;
    }
  }

  const total = operations.length;
  const allSuccess = failed === 0;
  const allFailed = successful === 0;

  return {
    code: allSuccess ? 'ALL_SUCCESS' : allFailed ? 'TOTAL_FAILURE' : 'PARTIAL_FAILURE',
    successful,
    failed,
    total,
    results,
    recoverable: !allFailed,
  };
}

export function summarizePartialFailures(result: PartialFailureResult): string {
  if (result.code === 'ALL_SUCCESS') {
    return `All ${result.total} operations succeeded.`;
  }
  if (result.code === 'TOTAL_FAILURE') {
    return `All ${result.total} operations failed.`;
  }
  return `${result.successful}/${result.total} operations succeeded, ${result.failed} failed.`;
}
