import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOnboardingProgress,
  completeOnboardingStep,
  validateFeeAndDeposit,
} from "@/lib/onboarding";

test("fee/deposit validation accepts an equal deposit", () => {
  assert.deepEqual(
    validateFeeAndDeposit({ feeAed: 50, depositAed: 50 }),
    { feeAed: 50, depositAed: 50 }
  );
});

test("fee/deposit validation rejects a deposit below the fee", () => {
  assert.throws(
    () => validateFeeAndDeposit({ feeAed: 75, depositAed: 50 }),
    /greater than or equal/
  );
});

test("onboarding progress resumes with normalized completed steps", () => {
  assert.deepEqual(
    buildOnboardingProgress({
      currentStep: 4,
      completedSteps: [3, 1, 3, 2, 99, "4"],
    }),
    {
      currentStep: 4,
      completedSteps: [1, 2, 3, 7],
      percentComplete: 57,
    }
  );
});

test("completing a step advances once and remains resumable", () => {
  assert.deepEqual(
    completeOnboardingStep({
      currentStep: 3,
      completedSteps: [1, 2],
      completedStep: 3,
    }),
    {
      currentStep: 4,
      completedSteps: [1, 2, 3],
      percentComplete: 43,
    }
  );
});
