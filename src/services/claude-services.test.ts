import assert from "node:assert/strict";
import test from "node:test";
import { validateServiceExtraction } from "@/services/claude";

test("service extraction schema normalizes numeric fields", () => {
  assert.deepEqual(
    validateServiceExtraction({
      services: [
        {
          category: "Hair",
          name: "Blow dry",
          nameAr: "",
          priceAed: "AED 120",
          durationMinutes: "45",
          description: null,
        },
      ],
    }),
    {
      services: [
        {
          category: "Hair",
          name: "Blow dry",
          nameAr: null,
          priceAed: 120,
          durationMinutes: 45,
          description: null,
        },
      ],
    }
  );
});

test("service extraction schema rejects invalid services", () => {
  assert.throws(() =>
    validateServiceExtraction({
      services: [
        {
          category: "",
          name: "",
          priceAed: -1,
          durationMinutes: -30,
        },
      ],
    })
  );
});
