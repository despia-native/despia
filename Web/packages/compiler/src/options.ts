// Shared, DOM-free option normalization for choice primitives. Client rendering and
// SSR must resolve CSV/object option rows identically so first paint and live mount agree.

import { string } from "@despia-native/kernel";

export type SegmentOption = { value: unknown; label: string };

export function segmentOptions(
  input: unknown,
  valueField = "id",
  labelField = "label",
): SegmentOption[] {
  if (!Array.isArray(input)) return [];
  return input.map((raw) => {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as { [key: string]: unknown };
      const value = record[valueField] ?? record[labelField] ?? "";
      return { value, label: string(record[labelField] ?? value) };
    }
    return { value: raw, label: string(raw) };
  });
}
