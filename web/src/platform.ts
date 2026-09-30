import { Capacitor, registerPlugin } from "@capacitor/core";

declare const __ORDER_DINNER_API_ORIGIN__: string;
export const isIos = Capacitor.getPlatform() === "ios";
// iOS bundles the same web UI; web and Android keep their existing same-origin requests.
export function apiUrl(path: string): string {
  return `${__ORDER_DINNER_API_ORIGIN__}${path}`;
}
export const usesWebOrderingLayout = Capacitor.getPlatform() !== "android";
export const IosFiles = registerPlugin<{
  shareFile(options: { filename: string; base64: string }): Promise<void>;
}>("IosFiles");
