import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.orderdinner.pos",
  appName: "餐厅点单台",
  webDir: "web/dist",
  server: {
    url: process.env.ORDER_DINNER_URL || "https://43.142.138.108:1316",
    cleartext: false
  }
};

export default config;
