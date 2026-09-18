import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.orderdinner.pos",
  appName: "餐厅点单台",
  webDir: "web/dist",
  server: {
    url: process.env.ORDER_DINNER_URL || "https://dinner.20-48-27-179.sslip.io:1314",
    cleartext: false
  }
};

export default config;
