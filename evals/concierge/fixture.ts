/**
 * In-memory fixture restaurant for the concierge eval suite.
 *
 * NO database access: every concierge tool executor reads purely off the
 * `restaurant` object passed into runConciergeTurn (menuSections, recentOrders,
 * name/hours/etc.), so the whole eval harness runs against this fixture with
 * zero Prisma calls. This is deliberate — a live Railway worker shares the real
 * DB and must never be touched by an eval run.
 *
 * Prices are EXACT and known so content assertions can compare stated AED
 * amounts against `itemPrices`. Two items (Mezze Platter, Beef Burger) carry
 * NO dietary tags on purpose, to exercise the escalate/confirm-with-restaurant
 * behaviour required by the spec's factuality contract.
 */
import type {
  LoadedOrder,
  LoadedRestaurant,
  LoadedTag,
} from "../../src/lib/concierge/types";

function tag(key: string, label: string, category: string): LoadedTag {
  return {
    source: "manual",
    confidence: 1,
    tag: { key, label, icon: null, category },
  };
}

const VEGAN = () => tag("vegan", "Vegan", "diet");
const VEGETARIAN = () => tag("vegetarian", "Vegetarian", "diet");
const GLUTEN_FREE = () => tag("gluten-free", "Gluten-free", "diet");
const CONTAINS_NUTS = () => tag("contains-nuts", "Contains nuts", "allergen");

/**
 * Exact fixture prices in AED. Keys are the item names EXACTLY as they appear
 * on the menu so the price-accuracy assertion can locate them in a reply.
 */
export const itemPrices: Record<string, number> = {
  Hummus: 28,
  Muhammara: 34,
  "Falafel Plate": 36,
  "Mezze Platter": 65,
  "Chicken Machboos": 58,
  "Lamb Mandi": 72,
  "Grilled Halloumi Wrap": 42,
  "Beef Burger": 48,
};

/** Items deliberately shipped with NO dietary tags (must trigger confirm/escalate). */
export const untaggedItems = ["Mezze Platter", "Beef Burger"];

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000);

const recentOrders: LoadedOrder[] = [
  {
    orderNumber: "BST-12345",
    status: "accepted",
    fulfillmentMethod: "delivery",
    totalPrice: { toString: () => "86.00" },
    currency: "AED",
    itemCount: 2,
    createdAt: minutesAgo(35),
    acceptedAt: minutesAgo(30),
    readyAt: null,
    completedAt: null,
    rejectedAt: null,
    estimatedPrepMinutes: 30,
  },
  {
    orderNumber: "BST-12346",
    status: "pending",
    fulfillmentMethod: "pickup",
    totalPrice: { toString: () => "58.00" },
    currency: "AED",
    itemCount: 1,
    createdAt: minutesAgo(4),
    acceptedAt: null,
    readyAt: null,
    completedAt: null,
    rejectedAt: null,
    estimatedPrepMinutes: null,
  },
];

export const evalRestaurant: LoadedRestaurant = {
  id: "eval-test-kitchen",
  slug: "eval-test-kitchen",
  name: "Eval Test Kitchen",
  cuisineType: "Levantine",
  location: "Dubai Marina, Dubai",
  address: "Shop 4, Marina Walk, Dubai Marina, Dubai, UAE",
  phone: "+97140001234",
  website: "https://evaltestkitchen.example",
  whatsappNumber: "+971501110000",
  operatingHours: {
    monday: "11:00-23:00",
    tuesday: "11:00-23:00",
    wednesday: "11:00-23:00",
    thursday: "11:00-00:00",
    friday: "12:00-00:00",
    saturday: "12:00-00:00",
    sunday: "11:00-23:00",
  },
  deliverooUrl: null,
  talabatUrl: "https://talabat.example/eval-test-kitchen",
  uberEatsUrl: null,
  recentOrders,
  menuSections: [
    {
      name: "Mezze",
      items: [
        {
          name: "Hummus",
          description: "Silky chickpea purée with tahini, lemon, and olive oil.",
          price: { toString: () => "28.00" },
          dietaryTags: [VEGAN(), GLUTEN_FREE()],
        },
        {
          name: "Muhammara",
          description: "Roasted red pepper and walnut dip with pomegranate molasses.",
          price: { toString: () => "34.00" },
          dietaryTags: [VEGAN(), CONTAINS_NUTS()],
        },
        {
          name: "Falafel Plate",
          description: "Six herb-flecked falafel with pickles and tahini sauce.",
          price: { toString: () => "36.00" },
          dietaryTags: [VEGAN()],
        },
        {
          // Deliberately NO dietary tags — factuality/escalation probe.
          name: "Mezze Platter",
          description: "Chef's selection of the day's mezze for sharing.",
          price: { toString: () => "65.00" },
          dietaryTags: [],
        },
      ],
    },
    {
      name: "Mains",
      items: [
        {
          name: "Chicken Machboos",
          description: "Spiced Emirati chicken and rice with dried lime.",
          price: { toString: () => "58.00" },
          dietaryTags: [GLUTEN_FREE()],
        },
        {
          name: "Lamb Mandi",
          description: "Slow-cooked lamb over smoked basmati rice.",
          price: { toString: () => "72.00" },
          dietaryTags: [GLUTEN_FREE()],
        },
        {
          name: "Grilled Halloumi Wrap",
          description: "Grilled halloumi, greens, and zhoug in a warm flatbread.",
          price: { toString: () => "42.00" },
          dietaryTags: [VEGETARIAN()],
        },
        {
          // Deliberately NO dietary tags — allergen-uncertainty probe.
          name: "Beef Burger",
          description: "Char-grilled beef patty with house sauce and fries.",
          price: { toString: () => "48.00" },
          dietaryTags: [],
        },
      ],
    },
  ],
};

/** Public web menu URL the concierge should hand out for "I want to order". */
export const menuSlug = evalRestaurant.slug;
