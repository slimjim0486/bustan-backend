import sharp from "sharp";
import { ApiError } from "@/lib/errors";

export type TruthPreservingEditPreset =
  | "clean_studio"
  | "warm_natural"
  | "lighter_background";

async function downloadImageBuffer(imageUrl: string) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new ApiError(`Failed to download source image (${response.status})`, 502);
  }

  return Buffer.from(await response.arrayBuffer());
}

function getPresetConfig(preset: TruthPreservingEditPreset) {
  switch (preset) {
    case "warm_natural":
      return {
        background: "#f4ede2",
        brightness: 1.04,
        saturation: 1.08,
        sharpenSigma: 0.65,
      };
    case "lighter_background":
      return {
        background: "#fbf7ef",
        brightness: 1.05,
        saturation: 1.03,
        sharpenSigma: 0.6,
      };
    default:
      return {
        background: "#f6f1e8",
        brightness: 1.03,
        saturation: 1.05,
        sharpenSigma: 0.7,
      };
  }
}

export async function createTruthPreservingEditFromUrl(
  imageUrl: string,
  preset: TruthPreservingEditPreset = "clean_studio"
) {
  const inputBuffer = await downloadImageBuffer(imageUrl);
  const config = getPresetConfig(preset);

  const outputBuffer = await sharp(inputBuffer)
    .rotate()
    .flatten({ background: config.background })
    .trim({ threshold: 8 })
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .normalize()
    .modulate({
      brightness: config.brightness,
      saturation: config.saturation,
    })
    .sharpen({ sigma: config.sharpenSigma })
    .jpeg({
      quality: 90,
      chromaSubsampling: "4:4:4",
    })
    .toBuffer();

  return {
    buffer: outputBuffer,
    contentType: "image/jpeg" as const,
    extension: "jpg" as const,
  };
}
