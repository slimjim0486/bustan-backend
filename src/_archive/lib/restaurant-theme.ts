export type RestaurantThemeKey = "saffron" | "midnight" | "rose" | "noir" | "aegean" | "neon";

export interface RestaurantTheme {
  key: RestaurantThemeKey;
  name: string;
  accent: string;
  accentText: string;
  heroFrom: string;
  heroTo: string;
  pageBackground: string;
  price: string;
  divider: string;
}

const restaurantThemes: RestaurantTheme[] = [
  {
    key: "saffron",
    name: "Saffron House",
    accent: "#E8A317",
    accentText: "#7A5211",
    heroFrom: "#201A17",
    heroTo: "#6D3B22",
    pageBackground: "#F7F1E8",
    price: "#FF6B5A",
    divider: "#E6D8C4",
  },
  {
    key: "midnight",
    name: "Midnight Slate",
    accent: "#58D3C7",
    accentText: "#0E4742",
    heroFrom: "#10181E",
    heroTo: "#204E57",
    pageBackground: "#EEF6F5",
    price: "#159987",
    divider: "#C6DBDA",
  },
  {
    key: "rose",
    name: "Rose Terrace",
    accent: "#D97D6C",
    accentText: "#6D3328",
    heroFrom: "#5D3437",
    heroTo: "#C97A6F",
    pageBackground: "#FBF2EE",
    price: "#C66155",
    divider: "#E7CCC6",
  },
  {
    key: "noir",
    name: "Noir & Gold",
    accent: "#C9A84C",
    accentText: "#5C4A1E",
    heroFrom: "#0D0B09",
    heroTo: "#3D2E1F",
    pageBackground: "#F5F2EC",
    price: "#C9A84C",
    divider: "#DDD5C2",
  },
  {
    key: "aegean",
    name: "Aegean Cove",
    accent: "#D47B4A",
    accentText: "#6B3518",
    heroFrom: "#0E2A3D",
    heroTo: "#2A7EA6",
    pageBackground: "#F2F7FA",
    price: "#D47B4A",
    divider: "#C6D8E4",
  },
  {
    key: "neon",
    name: "Neon Dusk",
    accent: "#B8E636",
    accentText: "#3A4D0F",
    heroFrom: "#110E22",
    heroTo: "#3B2768",
    pageBackground: "#F4F2F8",
    price: "#9ACC22",
    divider: "#D6D0E4",
  },
];

export function getRestaurantTheme(themeKey?: string | null): RestaurantTheme {
  return restaurantThemes.find((t) => t.key === themeKey) ?? restaurantThemes[0];
}
