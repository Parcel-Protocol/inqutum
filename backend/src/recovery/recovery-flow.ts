export type RecoveryStepState = 'PENDING' | 'DONE' | 'FAILED';

export interface RecoveryStep {
  name: string;
  externalSideEffect?: boolean;
}

export interface RecoveryCheckpoint {
  operationId: string;
  currentStep: number;
  completedEffects: string[];
  state: RecoveryStepState;
  message: string;
}

export function startRecovery(operationId: string): RecoveryCheckpoint {
  return {
    operationId,
    currentStep: 0,
    completedEffects: [],
    state: 'PENDING',
    message: 'Operation can resume from the first incomplete step.',
  };
}

export function markStepComplete(
  checkpoint: RecoveryCheckpoint,
  step: RecoveryStep
): RecoveryCheckpoint {
  const completedEffects = step.externalSideEffect
    ? Array.from(new Set([...checkpoint.completedEffects, step.name]))
    : checkpoint.completedEffects;
  return {
    ...checkpoint,
    currentStep: checkpoint.currentStep + 1,
    completedEffects,
    state: 'PENDING',
    message: 'Operation checkpoint advanced.',
  };
}

export function recoverOperation(
  steps: RecoveryStep[],
  checkpoint: RecoveryCheckpoint
): { action: 'RESUME' | 'COMPLETE' | 'FAIL_SAFE'; nextStep?: RecoveryStep; message: string } {
  if (checkpoint.state === 'FAILED') {
    return { action: 'FAIL_SAFE', message: checkpoint.message };
  }
  if (checkpoint.currentStep >= steps.length) {
    return { action: 'COMPLETE', message: 'Operation already completed.' };
  }
  const nextStep = steps[checkpoint.currentStep];
  if (nextStep.externalSideEffect && checkpoint.completedEffects.includes(nextStep.name)) {
    return {
      action: 'FAIL_SAFE',
      nextStep,
      message: 'External side effect is already recorded; manual verification is required before retry.',
    };
  }
  return { action: 'RESUME', nextStep, message: `Resume at ${nextStep.name}.` };
}
