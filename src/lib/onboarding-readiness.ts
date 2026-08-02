import { validateFeeAndDeposit } from "@/lib/onboarding";

export type AgentReadinessInput = {
  businessType: string;
  whatsappStatus: string | null;
  serviceCount: number;
  operatingHours: unknown;
  bookingPolicies: unknown;
  feeAed: number | null;
  depositAed: number | null;
  sandboxTestCount: number;
};

export function agentReadinessFailures(input: AgentReadinessInput): string[] {
  const failures: string[] = [];
  if (!['SALON', 'HOME_SERVICES'].includes(input.businessType)) failures.push("unsupported_business_type");
  if (input.whatsappStatus !== "connected") failures.push("whatsapp_not_connected");
  if (input.serviceCount < 1) failures.push("no_active_services");
  if (!input.operatingHours || typeof input.operatingHours !== "object") failures.push("hours_not_configured");
  const policies = input.bookingPolicies && typeof input.bookingPolicies === "object" && !Array.isArray(input.bookingPolicies)
    ? input.bookingPolicies as { noShowPolicy?: unknown }
    : null;
  if (typeof policies?.noShowPolicy !== "string" || !policies.noShowPolicy.trim()) failures.push("policy_not_configured");
  try {
    validateFeeAndDeposit({ feeAed: input.feeAed ?? -1, depositAed: input.depositAed ?? -1 });
    if ((input.depositAed ?? 0) <= 0) failures.push("deposit_not_configured");
  } catch {
    failures.push("fee_or_deposit_invalid");
  }
  if (input.sandboxTestCount < 3) failures.push("sandbox_tests_incomplete");
  return failures;
}
