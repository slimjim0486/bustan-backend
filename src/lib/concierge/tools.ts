import type Anthropic from "@anthropic-ai/sdk";
import {
  type BustanKbTopic,
  getAllBustanTopics,
  getBustanKbEntry,
  resolveBustanTopic,
} from "@/lib/bustan-kb";
import { env } from "@/lib/env";
import type {
  ConciergeChannel,
  ConciergeToolContext,
  LoadedItem,
  LoadedRestaurant,
} from "@/lib/concierge/types";

function formatPrice(value: { toString(): string }) {
  return Number(value.toString()).toFixed(2);
}

function publicMenuUrl(restaurant: LoadedRestaurant) {
  return `${env.FRONTEND_APP_URL.replace(/\/$/, "")}/${restaurant.slug}`;
}

export function buildMenuText(restaurant: LoadedRestaurant) {
  return restaurant.menuSections
    .map((section) => {
      const items = section.items
        .map((item) =>
          [
            `- ${item.name} - AED ${formatPrice(item.price)}`,
            item.description ? `  ${item.description}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        )
        .join("\n");

      return `## ${section.name}\n${items}`;
    })
    .join("\n\n");
}

const MENU_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_menu",
    description:
      "Search and filter menu items by keyword, section name, or price range. Use when a diner asks about specific types of food, wants items in a price range, or searches for something on the menu.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search in item names and descriptions" },
        section: { type: "string", description: "Filter by section name" },
        min_price: { type: "number", description: "Minimum price in AED" },
        max_price: { type: "number", description: "Maximum price in AED" },
      },
      required: [],
    },
  },
  {
    name: "get_dietary_info",
    description:
      "Get dietary and allergen tags for a specific menu item. Use when a diner asks about allergens, ingredients, or dietary suitability of a specific dish.",
    input_schema: {
      type: "object",
      properties: {
        item_name: { type: "string", description: "The name of the menu item to look up" },
      },
      required: ["item_name"],
    },
  },
  {
    name: "filter_by_dietary_needs",
    description:
      "Find all menu items matching specific dietary requirements. Use when a diner says they are vegan, gluten-free, have nut allergies, etc. and wants to know what they can eat.",
    input_schema: {
      type: "object",
      properties: {
        dietary_preferences: {
          type: "array",
          items: { type: "string" },
          description: "Dietary tags to filter by, e.g. ['vegan', 'gluten-free']. Items must match ALL specified tags.",
        },
      },
      required: ["dietary_preferences"],
    },
  },
  {
    name: "calculate_meal",
    description:
      "Calculate the total price for a combination of menu items. Use when a diner wants to know the cost of ordering multiple dishes together, or is building a meal within a budget.",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "List of menu item names to total up" },
      },
      required: ["items"],
    },
  },
];

const BUSTAN_TOOL: Anthropic.Tool = {
  name: "get_bustan_info",
  description:
    "Look up a short, accurate fact about Bustan, the platform that hosts this restaurant's menu page. Use this ONLY when a diner asks about Bustan itself.",
  input_schema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: getAllBustanTopics(),
        description: "The closest Bustan topic.",
      },
      query: { type: "string", description: "Optional original diner question." },
    },
    required: [],
  },
};

const RESTAURANT_INFO_TOOL: Anthropic.Tool = {
  name: "get_restaurant_info",
  description:
    "Get restaurant facts such as hours, address, location, phone, website, delivery links, and the public web menu URL.",
  input_schema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: ["hours", "location", "contact", "delivery", "menu_link", "all"],
      },
    },
    required: [],
  },
};

const ORDER_STATUS_TOOL: Anthropic.Tool = {
  name: "order_status",
  description:
    "Look up recent order status for this WhatsApp diner's phone number. Read-only. Use for questions like 'where is my order?' or 'is my order ready?'.",
  input_schema: {
    type: "object",
    properties: {
      order_number: { type: "string", description: "Optional order number if the diner provided one." },
    },
    required: [],
  },
};

export function buildConciergeTools(channel: ConciergeChannel, hasCustomerPhone: boolean) {
  const tools = [...MENU_TOOLS, RESTAURANT_INFO_TOOL];
  if (channel === "web") {
    tools.push(BUSTAN_TOOL);
  }
  if (channel === "whatsapp" && hasCustomerPhone) {
    tools.push(ORDER_STATUS_TOOL);
  }
  return tools;
}

function findItemByName(
  restaurant: LoadedRestaurant,
  name: string
): { item: LoadedItem; section: string } | null {
  const lower = name.toLowerCase();

  for (const sec of restaurant.menuSections) {
    for (const item of sec.items) {
      if (item.name.toLowerCase() === lower) {
        return { item, section: sec.name };
      }
    }
  }

  for (const sec of restaurant.menuSections) {
    for (const item of sec.items) {
      if (item.name.toLowerCase().includes(lower) || lower.includes(item.name.toLowerCase())) {
        return { item, section: sec.name };
      }
    }
  }

  return null;
}

function executeSearchMenu(
  restaurant: LoadedRestaurant,
  input: { query?: string; section?: string; min_price?: number; max_price?: number }
) {
  const results: Array<{ section: string; name: string; price: string; description: string | null }> = [];

  for (const sec of restaurant.menuSections) {
    if (input.section && !sec.name.toLowerCase().includes(input.section.toLowerCase())) {
      continue;
    }

    for (const item of sec.items) {
      const price = Number(item.price.toString());
      if (input.min_price !== undefined && price < input.min_price) continue;
      if (input.max_price !== undefined && price > input.max_price) continue;

      if (input.query) {
        const q = input.query.toLowerCase();
        const nameMatch = item.name.toLowerCase().includes(q);
        const descMatch = item.description?.toLowerCase().includes(q) ?? false;
        if (!nameMatch && !descMatch) continue;
      }

      results.push({
        section: sec.name,
        name: item.name,
        price: `AED ${formatPrice(item.price)}`,
        description: item.description,
      });
    }
  }

  if (results.length === 0) {
    return JSON.stringify({ message: "No items found matching those criteria.", results: [] });
  }

  return JSON.stringify({ count: results.length, results });
}

function executeGetDietaryInfo(restaurant: LoadedRestaurant, input: { item_name: string }) {
  const found = findItemByName(restaurant, input.item_name);

  if (!found) {
    return JSON.stringify({ error: `Item "${input.item_name}" not found on the menu.` });
  }

  const tags = found.item.dietaryTags.map((dt) => ({
    label: dt.tag.label,
    key: dt.tag.key,
    category: dt.tag.category,
  }));

  return JSON.stringify({
    item: found.item.name,
    section: found.section,
    dietary_tags: tags,
    has_dietary_info: tags.length > 0,
    note:
      tags.length === 0
        ? "No dietary tags have been confirmed for this item. Recommend the diner confirm allergen details with the restaurant."
        : undefined,
  });
}

function executeFilterByDietaryNeeds(
  restaurant: LoadedRestaurant,
  input: { dietary_preferences: string[] }
) {
  const prefs = (input.dietary_preferences ?? []).map((p) =>
    p.toLowerCase().replace(/[_\s]/g, "-")
  );
  const results: Array<{ section: string; name: string; price: string; matching_tags: string[] }> = [];

  for (const sec of restaurant.menuSections) {
    for (const item of sec.items) {
      const itemTagKeys = item.dietaryTags.map((dt) => dt.tag.key.toLowerCase());
      const allMatch = prefs.every((pref) =>
        itemTagKeys.some((key) => key.includes(pref) || pref.includes(key))
      );

      if (allMatch) {
        results.push({
          section: sec.name,
          name: item.name,
          price: `AED ${formatPrice(item.price)}`,
          matching_tags: item.dietaryTags.map((dt) => dt.tag.label),
        });
      }
    }
  }

  if (results.length === 0) {
    return JSON.stringify({
      message: `No items found matching all of: ${prefs.join(", ")}. The diner should ask staff about possible modifications.`,
      results: [],
    });
  }

  return JSON.stringify({ count: results.length, results });
}

function executeCalculateMeal(restaurant: LoadedRestaurant, input: { items: string[] }) {
  const lineItems: Array<{ name: string; price: string; found: boolean }> = [];
  let total = 0;
  const notFound: string[] = [];

  for (const itemName of input.items ?? []) {
    const found = findItemByName(restaurant, itemName);
    if (found) {
      const price = Number(found.item.price.toString());
      lineItems.push({ name: found.item.name, price: `AED ${price.toFixed(2)}`, found: true });
      total += price;
    } else {
      notFound.push(itemName);
      lineItems.push({ name: itemName, price: "not found", found: false });
    }
  }

  return JSON.stringify({
    items: lineItems,
    total: `AED ${total.toFixed(2)}`,
    items_found: lineItems.filter((li) => li.found).length,
    items_not_found: notFound.length > 0 ? notFound : undefined,
  });
}

function executeGetBustanInfo(input: { topic?: string; query?: string }) {
  const allTopics = getAllBustanTopics();
  let topic: BustanKbTopic | null = null;

  if (input.topic && (allTopics as string[]).includes(input.topic)) {
    topic = input.topic as BustanKbTopic;
  }
  if (!topic && input.query) {
    topic = resolveBustanTopic(input.query);
  }
  if (!topic) {
    topic = "overview";
  }

  const entry = getBustanKbEntry(topic);
  return JSON.stringify({
    topic: entry.topic,
    summary: entry.summary,
    links: entry.links ?? [],
    note: "Paraphrase naturally in 1-2 sentences, share a relevant link if helpful, then steer back to the menu unless they keep asking about Bustan.",
  });
}

function executeRestaurantInfo(restaurant: LoadedRestaurant) {
  return JSON.stringify({
    name: restaurant.name,
    location: restaurant.location,
    address: restaurant.address,
    phone: restaurant.phone,
    website: restaurant.website,
    whatsappNumber: restaurant.whatsappNumber,
    operatingHours: restaurant.operatingHours,
    deliveryLinks: {
      deliveroo: restaurant.deliverooUrl,
      talabat: restaurant.talabatUrl,
      uberEats: restaurant.uberEatsUrl,
    },
    publicMenuUrl: publicMenuUrl(restaurant),
    note: "Only answer with facts present here. If hours or delivery details are null, say the team should confirm.",
  });
}

function executeOrderStatus(
  restaurant: LoadedRestaurant,
  input: { order_number?: string },
  customerPhone?: string | null
) {
  if (!customerPhone) {
    return JSON.stringify({
      message: "No verified WhatsApp phone number is available for this channel. Escalate to the restaurant team.",
      orders: [],
    });
  }

  const orders = restaurant.recentOrders ?? [];
  const normalizedOrderNumber = input.order_number?.trim().toLowerCase();
  const matches = normalizedOrderNumber
    ? orders.filter((order) => order.orderNumber.toLowerCase() === normalizedOrderNumber)
    : orders.slice(0, 3);

  if (matches.length === 0) {
    return JSON.stringify({
      message: "No recent order matched this WhatsApp number. Escalate to the restaurant team.",
      orders: [],
    });
  }

  return JSON.stringify({
    orders: matches.map((order) => ({
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentMethod: order.fulfillmentMethod,
      total: `${order.currency} ${Number(order.totalPrice.toString()).toFixed(2)}`,
      itemCount: order.itemCount,
      createdAt: order.createdAt,
      acceptedAt: order.acceptedAt,
      readyAt: order.readyAt,
      completedAt: order.completedAt,
      rejectedAt: order.rejectedAt,
      estimatedPrepMinutes: order.estimatedPrepMinutes,
    })),
    note: "Report status only. Do not change or promise changes to the order.",
  });
}

export function executeConciergeTool(context: ConciergeToolContext, name: string, input: unknown) {
  try {
    switch (name) {
      case "search_menu":
        return executeSearchMenu(context.restaurant, input as Parameters<typeof executeSearchMenu>[1]);
      case "get_dietary_info":
        return executeGetDietaryInfo(context.restaurant, input as Parameters<typeof executeGetDietaryInfo>[1]);
      case "filter_by_dietary_needs":
        return executeFilterByDietaryNeeds(
          context.restaurant,
          input as Parameters<typeof executeFilterByDietaryNeeds>[1]
        );
      case "calculate_meal":
        return executeCalculateMeal(context.restaurant, input as Parameters<typeof executeCalculateMeal>[1]);
      case "get_bustan_info":
        return executeGetBustanInfo(input as Parameters<typeof executeGetBustanInfo>[0]);
      case "get_restaurant_info":
        return executeRestaurantInfo(context.restaurant);
      case "order_status":
        return executeOrderStatus(
          context.restaurant,
          input as Parameters<typeof executeOrderStatus>[1],
          context.customerPhone
        );
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch {
    return JSON.stringify({ error: `Tool execution failed for ${name}` });
  }
}
