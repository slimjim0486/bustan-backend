/**
 * WhatsApp Ordering v1 — template definitions.
 *
 * These are UTILITY-category templates (not MARKETING) so:
 *   - They do not require explicit marketing opt-in to send.
 *   - They are not subject to the 24h marketing frequency cap.
 *   - Meta is more lenient about URLs in the body (we still keep payment URLs
 *     in a URL button where supported, but the body fallback is allowed).
 *
 * All five templates must be created in Meta's WhatsApp Manager and approved
 * BEFORE v1 can ship. Submit on Day 1 — Meta review is 24–48h.
 *
 * Naming convention: `<intent>_v1` so we can iterate on copy with `_v2`
 * without breaking message-send code paths that hard-reference the name.
 */

import {
  type TemplateValidationResult,
  validateTemplateBody,
} from "@/lib/whatsapp-business";

export type OrderTemplateButtonQuickReply = {
  type: "quick_reply";
  text: string;
};

export type OrderTemplateButtonUrl = {
  type: "url";
  text: string;
  /** Variable position in the URL — Meta requires `{{1}}` if dynamic. */
  urlExample: string;
};

export type OrderTemplateButton =
  | OrderTemplateButtonQuickReply
  | OrderTemplateButtonUrl;

export type OrderTemplateDefinition = {
  /** Template name as registered with Meta. Hard-referenced by send-site code. */
  name: string;
  /** Human-readable label for admin UI. */
  label: string;
  /** Always UTILITY for order templates. */
  category: "UTILITY";
  /** ISO-639 language code. v1 ships English only. */
  language: "en";
  /** Body with `{{1}}, {{2}}, …` placeholders. */
  body: string;
  /** Variable names in order. Length must match the `{{N}}` count in body. */
  variables: readonly string[];
  /** Example values per variable for Meta's template review payload. */
  bodyExamples: readonly string[];
  /** Optional footer rendered as muted text below the body. */
  footer?: string;
  /** Optional buttons (quick replies or URL). */
  buttons?: readonly OrderTemplateButton[];
};

export const ORDER_TEMPLATE_DEFINITIONS = [
  /* ────────── Customer-facing ────────── */
  {
    name: "order_received_v1",
    label: "Order received (customer)",
    category: "UTILITY",
    language: "en",
    body:
      "Thanks {{1}}! We received your order {{2}} from {{3}}.\n" +
      "Total: AED {{4}}. Track your order: {{5}}\n" +
      "We will message you as soon as the restaurant confirms.",
    variables: [
      "customer_first_name",
      "order_number",
      "restaurant_name",
      "total_aed",
      "order_url",
    ],
    bodyExamples: ["Sara", "BST-7K3X9", "Zaatar w Zeit", "92.40", "https://getbustan.com/order/BST-7K3X9"],
    footer: "Powered by Bustan",
    buttons: [
      {
        type: "url",
        text: "Track Order",
        urlExample: "https://getbustan.com/order/BST-7K3X9",
      },
    ],
  },
  {
    name: "order_accepted_v1",
    label: "Order accepted (customer)",
    category: "UTILITY",
    language: "en",
    body:
      "Good news! {{1}} accepted your order {{2}}.\n" +
      "Estimated time: {{3}} minutes.\n" +
      "We will let you know as soon as it is ready.",
    variables: ["restaurant_name", "order_number", "estimated_minutes"],
    bodyExamples: ["Zaatar w Zeit", "BST-7K3X9", "25"],
    footer: "Powered by Bustan",
  },
  {
    name: "order_ready_v1",
    label: "Order ready (customer)",
    category: "UTILITY",
    language: "en",
    body:
      "Your order {{1}} from {{2}} is ready.\n" +
      "{{3}}",
    variables: ["order_number", "restaurant_name", "fulfillment_line"],
    bodyExamples: [
      "BST-7K3X9",
      "Zaatar w Zeit",
      "Pickup at the counter, ground floor.",
    ],
    footer: "Powered by Bustan",
  },
  {
    name: "order_cancelled_v1",
    label: "Order cancelled (customer)",
    category: "UTILITY",
    language: "en",
    body:
      "Your order {{1}} was cancelled.\n" +
      "Reason: {{2}}\n" +
      "{{3}}",
    variables: ["order_number", "reason", "refund_line"],
    bodyExamples: [
      "BST-7K3X9",
      "Restaurant unable to fulfil right now.",
      "Refund of AED 92.40 will appear in 3-5 business days.",
    ],
    footer: "Powered by Bustan",
  },

  /* ────────── Restaurant-facing ────────── */
  {
    name: "order_new_alert_v1",
    label: "New order alert (restaurant)",
    category: "UTILITY",
    language: "en",
    body:
      "New Order {{1}}\n" +
      "Customer: {{2}} ({{3}})\n" +
      "Items: {{4}}\n" +
      "Total: AED {{5}} ({{6}})\n" +
      "Fulfilment: {{7}}\n" +
      "Reply ACCEPT, REJECT, or a number (e.g. 30 = need 30 min).",
    variables: [
      "order_number",
      "customer_name",
      "customer_phone",
      "items_summary",
      "total_aed",
      "payment_status_label",
      "fulfillment_method_label",
    ],
    bodyExamples: [
      "BST-7K3X9",
      "Sara",
      "+971501234567",
      "1x Manakish, 2x Fattoush, 1x Lemonade",
      "92.40",
      "PAID",
      "Delivery",
    ],
    footer: "Powered by Bustan",
    buttons: [
      { type: "quick_reply", text: "Accept" },
      { type: "quick_reply", text: "Reject" },
      { type: "quick_reply", text: "Need 30 min" },
    ],
  },
] as const satisfies readonly OrderTemplateDefinition[];

export type OrderTemplateName =
  (typeof ORDER_TEMPLATE_DEFINITIONS)[number]["name"];

const TEMPLATE_BY_NAME = new Map<OrderTemplateName, OrderTemplateDefinition>(
  ORDER_TEMPLATE_DEFINITIONS.map((t) => [t.name, t])
);

export function getOrderTemplate(name: OrderTemplateName): OrderTemplateDefinition {
  const template = TEMPLATE_BY_NAME.get(name);
  if (!template) {
    throw new Error(`Unknown order template: ${name}`);
  }
  return template;
}

/**
 * Self-check at module load: every order template must pass Meta's policy
 * linter. If any template would be rejected by Meta we want to find out at
 * boot, not at send time when the cron is mid-fanout.
 */
for (const template of ORDER_TEMPLATE_DEFINITIONS) {
  const result: TemplateValidationResult = validateTemplateBody({
    body: template.body,
    category: template.category,
    variables: template.variables,
  });
  if (!result.ok) {
    throw new Error(
      `ORDER_TEMPLATE_DEFINITIONS entry "${template.name}" fails policy linter: ${result.reason}`
    );
  }
  if (template.bodyExamples.length !== template.variables.length) {
    throw new Error(
      `ORDER_TEMPLATE_DEFINITIONS entry "${template.name}" has ${template.bodyExamples.length} examples for ${template.variables.length} variables.`
    );
  }
}

/**
 * Build the Meta Cloud API `components` payload for creating each template.
 * Used by `scripts/submit-order-templates.ts` (to be added) and by anywhere
 * we want to inspect/diff what Meta sees vs what we have locally.
 */
export function buildMetaTemplateComponents(template: OrderTemplateDefinition) {
  const components: Array<Record<string, unknown>> = [
    {
      type: "BODY",
      text: template.body,
      example: { body_text: [template.bodyExamples] },
    },
  ];

  if (template.footer) {
    components.push({ type: "FOOTER", text: template.footer });
  }

  if (template.buttons && template.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: template.buttons.map((button) => {
        if (button.type === "quick_reply") {
          return { type: "QUICK_REPLY", text: button.text };
        }
        return {
          type: "URL",
          text: button.text,
          url: "{{1}}",
          example: [button.urlExample],
        };
      }),
    });
  }

  return components;
}
