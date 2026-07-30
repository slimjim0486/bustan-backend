export interface MenuExtractionDraft {
  sections: Array<{
    name: string;
    items: Array<{
      name: string;
      description: string | null;
      price: number;
    }>;
  }>;
}

export interface ServiceExtractionDraft {
  services: Array<{
    category: string;
    name: string;
    nameAr: string | null;
    priceAed: number;
    durationMinutes: number | null;
    description: string | null;
  }>;
}
