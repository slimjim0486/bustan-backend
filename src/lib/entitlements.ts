export type SubscriptionPlan = "starter" | "pro" | "fulltime" | "portfolio";
export type AnalyticsTier = "basic" | "advanced";
export type MenuAnalysisLevel = "basic" | "full";
export type SeoAnalysisDepth = "lite" | "full";
export type SubscriptionStatus = "trial" | "active" | "paused" | "cancelled";
export type PortfolioActivationState = "inactive" | "pending_setup" | "active";

export interface PlanEntitlements {
  plan: SubscriptionPlan | null;
  hasSelectedPlan: boolean;
  menuItemLimit: number | null;
  sourcePhotoImportEnabled: boolean;
  sourcePhotoReviewEnabled: boolean;
  widgetEnabled: boolean;
  menuAssistantEnabled: boolean;
  customDomainEnabled: boolean;
  shortLinksEnabled: boolean;
  hideBranding: boolean;
  analyticsTier: AnalyticsTier;
  imageGenerationPriority: number;
  priorityImageGeneration: boolean;
  dishImageGenerationLimit: number | null;
  imageEnhancementLimit: number | null;
  photoEnhancementMonthlyLimit: number | null;
  batchImageEnhancementEnabled: boolean;
  advancedPhotoStylingEnabled: boolean;
  aiDescriptionLimit: number | null;
  bulkDescriptionEnabled: boolean;
  aiTagAnalysisLimit: number | null;
  menuAnalysisLevel: MenuAnalysisLevel;
  analysisLimit: number | null;
  analysisMonthlyLimit: number | null;
  seoAnalysisLimit: number | null;
  seoAnalysisDepth: SeoAnalysisDepth;
  sousChefMonthlyLimit: number | null;
  ownerChatMonthlyTurnLimit: number | null;
  multiBrandEnable: boolean;
  menuCloningEnabled: boolean;
  crossBrandAnalyticsEnabled: boolean;
  qrCodeGeneratorEnabled: boolean;
  timeLimitedSpecialsEnabled: boolean;
  soldOutToggleEnabled: boolean;
  // Ad Creative Studio (Phase 1)
  adStudioEnabled: boolean;
  adProjectsPerMonth: number | null;
  adProjectMonthlyLimit: number | null;
  openaiImageMonthlyLimit: number | null;
  adGenerationsPerProject: number;
  // Phase 3.1 — Google Search Console dashboard. Read-only view of GSC data
  // sliced per restaurant from Bustan's shared GSC property.
  gscDashboardEnabled: boolean;
  // Arabic bilingual menus + public /ar page + AI translate. Pro/Portfolio only.
  arabicMenuEnabled: boolean;
  // Sabt Pack — weekly auto-generated 7-post bundle delivered Sun 07:00 GST.
  // Pro/Portfolio only. Cap bounds variable image-gen spend per restaurant
  // per week — orchestrator force-reuses menu photos beyond this ceiling.
  sabtPackEnabled: boolean;
  sabtPackMaxCostUsdPerWeek: number;
  // Market Pulse / Competitor Intelligence — weekly Exa-powered pull of
  // nearby competitor menu/promo/press/review activity, surfaced via Sous
  // Chef. Pro/Portfolio only. Cap bounds how many competitors we fetch per
  // restaurant per week (each competitor ~$0.035 of Exa spend) — combined
  // with the per-restaurant monthly USD cap this is the budget guardrail.
  competitorIntelligenceEnabled: boolean;
  competitorIntelMaxCompetitors: number;
  competitorIntelManualRefreshesPerWeek: number;
  // Agent autonomy (B1a: defined & returned; enforced in B1b). "draft_only" =
  // every Tier-2 tool routes through DraftAction approval (today's behavior).
  // "guarded_auto" = Bustan may auto-execute Tier-2 within guardrails.
  agentAutonomy: "draft_only" | "guarded_auto";
  // Whether the account can store standing instructions. B1a defines; B1b builds.
  standingInstructionsEnabled: boolean;
}

const PLAN_ENTITLEMENTS: Record<
  SubscriptionPlan,
  Omit<PlanEntitlements, "plan" | "hasSelectedPlan">
> = {
  starter: {
    menuItemLimit: 30,
    sourcePhotoImportEnabled: true,
    sourcePhotoReviewEnabled: true,
    widgetEnabled: false,
    menuAssistantEnabled: false,
    customDomainEnabled: false,
    shortLinksEnabled: false,
    hideBranding: false,
    analyticsTier: "basic",
    imageGenerationPriority: 0,
    priorityImageGeneration: false,
    dishImageGenerationLimit: 10,
    imageEnhancementLimit: 5,
    photoEnhancementMonthlyLimit: 5,
    batchImageEnhancementEnabled: false,
    advancedPhotoStylingEnabled: false,
    aiDescriptionLimit: 5,
    bulkDescriptionEnabled: false,
    aiTagAnalysisLimit: 1,
    menuAnalysisLevel: "basic",
    analysisLimit: 1,
    analysisMonthlyLimit: 1,
    seoAnalysisLimit: 0,
    seoAnalysisDepth: "lite",
    sousChefMonthlyLimit: 0,
    ownerChatMonthlyTurnLimit: 0,
    multiBrandEnable: false,
    menuCloningEnabled: false,
    crossBrandAnalyticsEnabled: false,
    qrCodeGeneratorEnabled: false,
    timeLimitedSpecialsEnabled: false,
    soldOutToggleEnabled: false,
    adStudioEnabled: false,
    adProjectsPerMonth: 0,
    adProjectMonthlyLimit: 0,
    openaiImageMonthlyLimit: 0,
    adGenerationsPerProject: 0,
    gscDashboardEnabled: false,
    arabicMenuEnabled: false,
    sabtPackEnabled: false,
    sabtPackMaxCostUsdPerWeek: 0,
    competitorIntelligenceEnabled: false,
    competitorIntelMaxCompetitors: 0,
    competitorIntelManualRefreshesPerWeek: 0,
    agentAutonomy: "draft_only",
    standingInstructionsEnabled: false,
  },
  pro: {
    menuItemLimit: null,
    sourcePhotoImportEnabled: true,
    sourcePhotoReviewEnabled: true,
    widgetEnabled: true,
    menuAssistantEnabled: true,
    customDomainEnabled: false,
    shortLinksEnabled: true,
    hideBranding: true,
    analyticsTier: "advanced",
    imageGenerationPriority: 10,
    priorityImageGeneration: true,
    dishImageGenerationLimit: 300,
    imageEnhancementLimit: 50,
    photoEnhancementMonthlyLimit: 50,
    batchImageEnhancementEnabled: true,
    advancedPhotoStylingEnabled: true,
    aiDescriptionLimit: null,
    bulkDescriptionEnabled: true,
    aiTagAnalysisLimit: null,
    menuAnalysisLevel: "full",
    analysisLimit: 4,
    analysisMonthlyLimit: 4,
    seoAnalysisLimit: 2,
    seoAnalysisDepth: "full",
    sousChefMonthlyLimit: 2000,
    ownerChatMonthlyTurnLimit: 200,
    multiBrandEnable: false,
    menuCloningEnabled: false,
    crossBrandAnalyticsEnabled: false,
    qrCodeGeneratorEnabled: false,
    timeLimitedSpecialsEnabled: false,
    soldOutToggleEnabled: false,
    adStudioEnabled: true,
    adProjectsPerMonth: 20,
    adProjectMonthlyLimit: 20,
    openaiImageMonthlyLimit: 50,
    adGenerationsPerProject: 6,
    gscDashboardEnabled: true,
    arabicMenuEnabled: true,
    sabtPackEnabled: true,
    sabtPackMaxCostUsdPerWeek: 1.0,
    competitorIntelligenceEnabled: true,
    competitorIntelMaxCompetitors: 5,
    competitorIntelManualRefreshesPerWeek: 1,
    agentAutonomy: "draft_only",
    standingInstructionsEnabled: false,
  },
  fulltime: {
    menuItemLimit: null,
    sourcePhotoImportEnabled: true,
    sourcePhotoReviewEnabled: true,
    widgetEnabled: true,
    menuAssistantEnabled: true,
    customDomainEnabled: false,
    shortLinksEnabled: true,
    hideBranding: true,
    analyticsTier: "advanced",
    imageGenerationPriority: 20, // above Pro's 10
    priorityImageGeneration: true,
    dishImageGenerationLimit: null, // uncapped
    imageEnhancementLimit: null,
    photoEnhancementMonthlyLimit: null,
    batchImageEnhancementEnabled: true,
    advancedPhotoStylingEnabled: true,
    aiDescriptionLimit: null,
    bulkDescriptionEnabled: true,
    aiTagAnalysisLimit: null,
    menuAnalysisLevel: "full",
    analysisLimit: null,
    analysisMonthlyLimit: null,
    seoAnalysisLimit: 4, // top-tier SEO depth (Full-time ≥ Part-time; portfolio inherits this next task)
    seoAnalysisDepth: "full",
    sousChefMonthlyLimit: 2000,
    ownerChatMonthlyTurnLimit: 200,
    multiBrandEnable: false,
    menuCloningEnabled: false,
    crossBrandAnalyticsEnabled: false,
    qrCodeGeneratorEnabled: false,
    timeLimitedSpecialsEnabled: false,
    soldOutToggleEnabled: false,
    adStudioEnabled: true,
    adProjectsPerMonth: null, // uncapped
    adProjectMonthlyLimit: null,
    openaiImageMonthlyLimit: null,
    adGenerationsPerProject: 6,
    gscDashboardEnabled: true,
    arabicMenuEnabled: true,
    sabtPackEnabled: true,
    sabtPackMaxCostUsdPerWeek: 1.0, // per-WEEK cap retained (cost guardrail)
    competitorIntelligenceEnabled: true,
    competitorIntelMaxCompetitors: 5,
    competitorIntelManualRefreshesPerWeek: 1,
    agentAutonomy: "guarded_auto",
    standingInstructionsEnabled: true,
  },
  portfolio: {
    menuItemLimit: null,
    sourcePhotoImportEnabled: true,
    sourcePhotoReviewEnabled: true,
    widgetEnabled: true,
    menuAssistantEnabled: true,
    customDomainEnabled: false,
    shortLinksEnabled: true,
    hideBranding: true,
    analyticsTier: "advanced",
    imageGenerationPriority: 20,
    priorityImageGeneration: true,
    dishImageGenerationLimit: null, // uncapped
    imageEnhancementLimit: null,
    photoEnhancementMonthlyLimit: null,
    batchImageEnhancementEnabled: true,
    advancedPhotoStylingEnabled: true,
    aiDescriptionLimit: null,
    bulkDescriptionEnabled: true,
    aiTagAnalysisLimit: null,
    menuAnalysisLevel: "full",
    analysisLimit: null,
    analysisMonthlyLimit: null,
    seoAnalysisLimit: 4,
    seoAnalysisDepth: "full",
    sousChefMonthlyLimit: 2000,
    ownerChatMonthlyTurnLimit: 200,
    multiBrandEnable: true,
    menuCloningEnabled: true,
    crossBrandAnalyticsEnabled: true,
    qrCodeGeneratorEnabled: true,
    timeLimitedSpecialsEnabled: true,
    soldOutToggleEnabled: true,
    adStudioEnabled: true,
    adProjectsPerMonth: null, // uncapped
    adProjectMonthlyLimit: null,
    openaiImageMonthlyLimit: null,
    adGenerationsPerProject: 6,
    gscDashboardEnabled: true,
    arabicMenuEnabled: true,
    sabtPackEnabled: true,
    sabtPackMaxCostUsdPerWeek: 1.0, // cost guardrail retained as-is
    competitorIntelligenceEnabled: true,
    competitorIntelMaxCompetitors: 10,
    competitorIntelManualRefreshesPerWeek: 4,
    agentAutonomy: "guarded_auto",
    standingInstructionsEnabled: true,
  },
};

const DRAFT_ENTITLEMENTS: PlanEntitlements = {
  plan: null,
  hasSelectedPlan: false,
  menuItemLimit: null,
  sourcePhotoImportEnabled: true,
  sourcePhotoReviewEnabled: true,
  widgetEnabled: false,
  menuAssistantEnabled: false,
  customDomainEnabled: false,
  shortLinksEnabled: false,
  hideBranding: false,
  analyticsTier: "basic",
  imageGenerationPriority: 0,
  priorityImageGeneration: false,
  dishImageGenerationLimit: 10,
  imageEnhancementLimit: 3,
  photoEnhancementMonthlyLimit: 3,
  batchImageEnhancementEnabled: false,
  advancedPhotoStylingEnabled: false,
  aiDescriptionLimit: 3,
  bulkDescriptionEnabled: false,
  aiTagAnalysisLimit: 1,
  menuAnalysisLevel: "basic",
  analysisLimit: 1,
  analysisMonthlyLimit: 1,
  seoAnalysisLimit: 0,
  seoAnalysisDepth: "lite",
  sousChefMonthlyLimit: 0,
  ownerChatMonthlyTurnLimit: 0,
  multiBrandEnable: false,
  menuCloningEnabled: false,
  crossBrandAnalyticsEnabled: false,
  qrCodeGeneratorEnabled: false,
  timeLimitedSpecialsEnabled: false,
  soldOutToggleEnabled: false,
  adStudioEnabled: false,
  adProjectsPerMonth: 0,
  adProjectMonthlyLimit: 0,
  openaiImageMonthlyLimit: 0,
  adGenerationsPerProject: 0,
  gscDashboardEnabled: false,
  arabicMenuEnabled: false,
  sabtPackEnabled: false,
  sabtPackMaxCostUsdPerWeek: 0,
  competitorIntelligenceEnabled: false,
  competitorIntelMaxCompetitors: 0,
  competitorIntelManualRefreshesPerWeek: 0,
  agentAutonomy: "draft_only",
  standingInstructionsEnabled: false,
};

type RestaurantPlanSource =
  | (Record<string, unknown> & {
      subscriptionStatus?: SubscriptionStatus;
      operatorAccount?: {
        status?: SubscriptionStatus;
        brands?: unknown[];
        _count?: {
          brands?: number;
        } | null;
      } | null;
      subscription?: {
        plan?: SubscriptionPlan;
        status?: SubscriptionStatus;
        stripeSubscriptionId?: string | null;
      } | null;
    })
  | null
  | undefined;

function getSubscriptionStatus(source: RestaurantPlanSource): SubscriptionStatus | null {
  return source?.operatorAccount?.status ?? source?.subscription?.status ?? source?.subscriptionStatus ?? null;
}

function getOperatorStatus(source: RestaurantPlanSource): SubscriptionStatus | null {
  return source?.operatorAccount?.status ?? null;
}

function getOperatorBrandCount(source: RestaurantPlanSource) {
  if (!source?.operatorAccount) {
    return 0;
  }

  if (Array.isArray(source.operatorAccount.brands)) {
    return source.operatorAccount.brands.length;
  }

  return source.operatorAccount._count?.brands ?? 0;
}

export function getPortfolioActivationState(
  source: RestaurantPlanSource
): PortfolioActivationState {
  const status = getOperatorStatus(source);

  if (!source?.operatorAccount || (status !== "active" && status !== "trial")) {
    return "inactive";
  }

  return getOperatorBrandCount(source) >= 3 ? "active" : "pending_setup";
}

function getPendingPortfolioEntitlements(): PlanEntitlements {
  return {
    ...getPlanEntitlements("fulltime"),
    plan: "portfolio",
    multiBrandEnable: false,
    menuCloningEnabled: false,
    crossBrandAnalyticsEnabled: false,
    qrCodeGeneratorEnabled: false,
    timeLimitedSpecialsEnabled: false,
    soldOutToggleEnabled: false,
  };
}

export function getAdStudioUpgradeMessage() {
  return "The Ad Creative Studio is available on Pro. Upgrade to generate ads from your menu in minutes.";
}

export function getSabtPackUpgradeMessage() {
  return "Sabt Pack delivers 7 ready-to-publish posts every Sunday morning. Available on Pro and Portfolio.";
}

export function getCompetitorIntelUpgradeMessage() {
  return "Market Pulse tracks competitors near you every week — menus, promos, press mentions, and review activity. Available on Pro and Portfolio.";
}

export function getPlanEntitlements(plan: SubscriptionPlan): PlanEntitlements {
  return {
    plan,
    hasSelectedPlan: true,
    ...PLAN_ENTITLEMENTS[plan],
  };
}

export function hasSelectedPlan(source: RestaurantPlanSource) {
  if (source?.operatorAccount) {
    return getOperatorStatus(source) !== "cancelled";
  }

  return Boolean(source?.subscription?.plan && getSubscriptionStatus(source) !== "cancelled");
}

export function getRestaurantPlan(source: RestaurantPlanSource): SubscriptionPlan | null {
  if (source?.operatorAccount && getOperatorStatus(source) !== "cancelled") {
    return "portfolio";
  }

  if (!hasSelectedPlan(source)) {
    return null;
  }

  return source?.subscription?.plan ?? null;
}

export function getRestaurantEntitlements(source: RestaurantPlanSource): PlanEntitlements {
  const portfolioState = getPortfolioActivationState(source);

  if (portfolioState === "active") {
    return getPlanEntitlements("portfolio");
  }

  if (portfolioState === "pending_setup") {
    return getPendingPortfolioEntitlements();
  }

  const plan = getRestaurantPlan(source);
  const base = plan ? getPlanEntitlements(plan) : DRAFT_ENTITLEMENTS;

  // "First two weeks are on us — full-time": during trial, grant Full-time-level
  // output (uncapped) regardless of the chosen tier, but keep the stored plan
  // identity so billing/UI still show what they hired. (Autonomy stays field-
  // only until B1b — no auto-execution happens yet.)
  const status = getSubscriptionStatus(source);
  if (status === "trial") {
    const ft = getPlanEntitlements("fulltime");
    return {
      ...base,
      dishImageGenerationLimit: ft.dishImageGenerationLimit,
      imageEnhancementLimit: ft.imageEnhancementLimit,
      photoEnhancementMonthlyLimit: ft.photoEnhancementMonthlyLimit,
      adProjectsPerMonth: ft.adProjectsPerMonth,
      adProjectMonthlyLimit: ft.adProjectMonthlyLimit,
      openaiImageMonthlyLimit: ft.openaiImageMonthlyLimit,
      analysisLimit: ft.analysisLimit,
      analysisMonthlyLimit: ft.analysisMonthlyLimit,
    };
  }

  return base;
}

export function withRestaurantEntitlements<T extends RestaurantPlanSource>(
  restaurant: T
): T & { entitlements: PlanEntitlements } {
  return {
    ...restaurant,
    entitlements: getRestaurantEntitlements(restaurant),
  };
}

export function getEffectiveRestaurantBillingState(source: RestaurantPlanSource) {
  const status = getSubscriptionStatus(source) ?? "trial";
  const hasPlan = hasSelectedPlan(source);

  return {
    subscriptionStatus: status,
    isPublished: hasPlan && (status === "trial" || status === "active"),
  };
}

export function getMenuItemLimitMessage(limit: number) {
  return `This plan includes up to ${limit} menu items. Upgrade to Pro for unlimited dishes.`;
}

export function getMenuAssistantUpgradeMessage() {
  return "AI menu assistant is available on Pro. Upgrade to save private AI notes and offer diner chat.";
}
