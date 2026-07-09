import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type ConciergeChannel = "web" | "whatsapp";
export type ConciergeAction = "reply" | "escalate";

export type ConciergeLanguage = "en" | "ar" | string | null;

export type ConciergeHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LoadedTag = {
  source: string;
  confidence: number | null;
  tag: { key: string; label: string; icon: string | null; category: string };
};

export type LoadedItem = {
  name: string;
  description: string | null;
  price: { toString(): string };
  dietaryTags: LoadedTag[];
};

export type LoadedSection = {
  name: string;
  items: LoadedItem[];
};

export type LoadedOrder = {
  orderNumber: string;
  status: string;
  fulfillmentMethod: string;
  totalPrice: { toString(): string };
  currency: string;
  itemCount: number;
  createdAt: Date;
  acceptedAt: Date | null;
  readyAt: Date | null;
  completedAt: Date | null;
  rejectedAt: Date | null;
  estimatedPrepMinutes: number | null;
};

export type LoadedRestaurant = {
  id: string;
  slug: string;
  name: string;
  cuisineType: string | null;
  location: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  whatsappNumber: string | null;
  operatingHours: unknown;
  deliverooUrl: string | null;
  talabatUrl: string | null;
  uberEatsUrl: string | null;
  menuSections: LoadedSection[];
  recentOrders?: LoadedOrder[];
};

export type ConciergeTurnOptions = {
  restaurant: LoadedRestaurant;
  channel: ConciergeChannel;
  message: string;
  history?: ConciergeHistoryMessage[];
  language?: ConciergeLanguage;
  customerPhone?: string | null;
};

export type ConciergeTurnResult = {
  action: ConciergeAction;
  reply: string;
  inputTokens: number;
  outputTokens: number;
};

export type ConciergeToolContext = {
  restaurant: LoadedRestaurant;
  channel: ConciergeChannel;
  customerPhone?: string | null;
};

export type PreparedMessages = MessageParam[];
