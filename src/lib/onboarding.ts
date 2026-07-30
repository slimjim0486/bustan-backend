import { ApiError } from "@/lib/errors";

export const ONBOARDING_STEP_COUNT = 7;

export type OnboardingProgress = {
  currentStep: number;
  completedSteps: number[];
  percentComplete: number;
};

function clampStep(step: number) {
  return Math.min(ONBOARDING_STEP_COUNT, Math.max(1, Math.trunc(step)));
}

export function normalizeCompletedSteps(value: unknown): number[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .filter((step): step is number => Number.isInteger(step))
        .map(clampStep)
    )
  ).sort((a, b) => a - b);
}

export function buildOnboardingProgress(input: {
  currentStep: number;
  completedSteps: unknown;
}): OnboardingProgress {
  const completedSteps = normalizeCompletedSteps(input.completedSteps);
  return {
    currentStep: clampStep(input.currentStep),
    completedSteps,
    percentComplete: Math.round(
      (completedSteps.length / ONBOARDING_STEP_COUNT) * 100
    ),
  };
}

export function completeOnboardingStep(input: {
  currentStep: number;
  completedSteps: unknown;
  completedStep: number;
}): OnboardingProgress {
  const completedStep = clampStep(input.completedStep);
  const completedSteps = normalizeCompletedSteps([
    ...normalizeCompletedSteps(input.completedSteps),
    completedStep,
  ]);

  return buildOnboardingProgress({
    currentStep:
      completedStep >= input.currentStep
        ? Math.min(completedStep + 1, ONBOARDING_STEP_COUNT)
        : input.currentStep,
    completedSteps,
  });
}

export function validateFeeAndDeposit(input: {
  feeAed: number;
  depositAed: number;
}) {
  const feeAed = Math.trunc(input.feeAed);
  const depositAed = Math.trunc(input.depositAed);

  if (feeAed < 0 || depositAed < 0) {
    throw new ApiError("Fee and deposit must be zero or greater", 400);
  }

  if (depositAed < feeAed) {
    throw new ApiError(
      "Customer deposit must be greater than or equal to Bustan's fee",
      400
    );
  }

  return { feeAed, depositAed };
}
