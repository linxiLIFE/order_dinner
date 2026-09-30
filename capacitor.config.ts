import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.orderdinner.pos",
  appName: "餐厅点单台",
  webDir: process.env.ORDER_DINNER_WEB_DIR || "web/dist",
  ...(process.env.ORDER_DINNER_PLATFORM === "ios" ? {} : { server: {
    url: process.env.ORDER_DINNER_URL || "https://43.142.138.108:1316",
    cleartext: false
  } }),
  ios: {
    contentInset: "never",
    preferredContentMode: "mobile"
  }
};

export default config;
