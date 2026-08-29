//
//  shot-devices.ts - THE DEVICE AND STORE-ASSET TABLE (platform/10 W7).
//
//  A shot's device is a LOGICAL viewport in points plus a scale, exactly as the Studio's
//  preview presets already express it (EditorPreview.dsx). The store asset is that viewport
//  times the scale, and the arithmetic has to be exact: App Store Connect rejects an asset
//  whose pixel size is not one of the sizes it names, so an off-by-one here is a submission
//  failure a customer discovers, not a rendering nicety.
//
//  THE HAPPY ACCIDENT, and it is why this table is short: the iPhone 17 Pro Max preset the
//  Studio already ships is 440x956 points, and 440x956 at scale 3 is 1320x2868 - EXACTLY the
//  6.9" App Store asset. The store size falls out of a preset that existed before any of this
//  was planned.
//
//  Both stores also refuse an alpha channel (Apple) or an off-ratio image (Play), so those are
//  properties of this table rather than of whatever code happens to write the file.
//

export type ShotDevice = {
  key: string;
  label: string;
  /** logical viewport, the numbers the running app actually sees */
  width: number;
  height: number;
  scale: number;
  /** coarse pointer + touch emulation */
  touch: boolean;
  /** the store display class this device's raster satisfies, when it satisfies one */
  storeClass?: string;
  store?: "apple" | "google";
};

/** The devices a shot can be taken at. Portrait is the authored orientation; `rotate` swaps. */
export const SHOT_DEVICES: ReadonlyArray<ShotDevice> = [
  // Apple - the two classes App Store Connect actually requires; it scales the rest down.
  { key: "iphone-6.9", label: "iPhone 17 Pro Max", width: 440, height: 956, scale: 3, touch: true, storeClass: "APP_IPHONE_69", store: "apple" },
  { key: "iphone-6.5", label: "iPhone 11 Pro Max", width: 414, height: 736, scale: 3, touch: true, storeClass: "APP_IPHONE_65", store: "apple" },
  { key: "ipad-13", label: 'iPad Pro 13"', width: 1032, height: 1376, scale: 2, touch: true, storeClass: "APP_IPAD_PRO_3GEN_129", store: "apple" },
  // Google - Play takes a range rather than a class, so one phone raster serves.
  { key: "android-phone", label: "Android phone", width: 412, height: 892, scale: 3, touch: true, store: "google" },
  { key: "android-tablet", label: "Android tablet", width: 800, height: 1280, scale: 2, touch: true, store: "google" },
  // Play's FEATURE GRAPHIC: a landscape banner, not a device raster, so it is exempt from the
  // phone ratio rule below and carries its own exact size.
  { key: "play-feature", label: "Play feature graphic", width: 1024, height: 500, scale: 1, touch: false, storeClass: "FEATURE_GRAPHIC", store: "google" },
  // Non-store devices, for docs and press images.
  { key: "iphone-6.1", label: "iPhone 17 Pro", width: 402, height: 874, scale: 3, touch: true },
  { key: "desktop", label: "Desktop", width: 1366, height: 1024, scale: 2, touch: false },
];

export function shotDevice(key: string): ShotDevice | null {
  return SHOT_DEVICES.find((d) => d.key === key) ?? null;
}

/** The raster size a device produces, in real pixels. */
export function shotPixelSize(device: ShotDevice, rotate = false): { width: number; height: number } {
  const w = Math.round((rotate ? device.height : device.width) * device.scale);
  const h = Math.round((rotate ? device.width : device.height) * device.scale);
  return { width: w, height: h };
}

export type StoreConstraintFailure = { rule: string; detail: string };

/**
 * Does a raster satisfy the store's asset rules? Checked before an upload is attempted,
 * because a rejection at submission time costs a customer a review cycle and this costs
 * nothing.
 */
export function checkStoreConstraints(
  raster: { width: number; height: number; hasAlpha: boolean },
  store: "apple" | "google",
): StoreConstraintFailure[] {
  const out: StoreConstraintFailure[] = [];
  if (raster.hasAlpha) {
    out.push({
      rule: "no-alpha",
      detail: `${store === "apple" ? "App Store Connect" : "Google Play"} refuses an alpha channel; flatten onto an opaque background`,
    });
  }
  const { width, height } = raster;
  if (width < 1 || height < 1) {
    out.push({ rule: "non-empty", detail: "the raster has no pixels" });
    return out;
  }
  if (store === "apple") {
    const known = SHOT_DEVICES.filter((d) => d.store === "apple").flatMap((d) => {
      const p = shotPixelSize(d);
      return [`${p.width}x${p.height}`, `${p.height}x${p.width}`];
    });
    if (!known.includes(`${width}x${height}`)) {
      out.push({
        rule: "display-class",
        detail: `${width}x${height} is not an App Store display-class size (${[...new Set(known)].join(", ")})`,
      });
    }
  } else {
    // The feature graphic is a fixed-size banner; Play checks it against 1024x500 exactly and
    // the phone bounds/ratio rules do not apply to it.
    if (width === 1024 && height === 500) return out;
    const min = Math.min(width, height);
    const max = Math.max(width, height);
    if (min < 320 || max > 3840) {
      out.push({ rule: "play-bounds", detail: `each side must be 320..3840; got ${width}x${height}` });
    }
    const ratio = max / min;
    if (ratio > 2.4) {
      out.push({ rule: "play-ratio", detail: `aspect ratio ${ratio.toFixed(2)}:1 exceeds Play's 2.4:1 limit` });
    }
  }
  return out;
}
