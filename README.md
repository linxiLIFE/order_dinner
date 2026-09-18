# 餐厅员工点单系统

这是按 `PLAN.md` 落地的餐厅点单、结账、会员积分、营业统计和打印队列系统。网页由 React + TypeScript 构建，业务接口由 Node.js + Express 提供，数据存储使用 PostgreSQL；桌面端使用 Electron，安卓端使用 Capacitor。

## 本地运行

```bash
npm install
cp .env.example .env
# 将 DATABASE_URL 改成可访问的 PostgreSQL，并设置 JWT_SECRET 与管理员密码
npm run dev
```

生产容器启动：

```bash
cp .env.example .env
# 另填 POSTGRES_PASSWORD、JWT_SECRET、BOOTSTRAP_ADMIN_PASSWORD
docker compose up -d --build
```

初次启动会自动执行数据库迁移，创建默认 1—12 号桌台及管理员账号；不会写入营业订单或演示菜品。首次登录后请在“设置”中修改店名、积分规则、桌台与打印设备。

## 安装包

- Windows：`npm run package:win`，输出在 `release/desktop`。安装后默认打开线上后台地址，也可通过环境变量 `ORDER_DINNER_URL` 覆盖。
- 安卓：先安装 Android SDK 与 JDK 17，运行 `npm run package:android`；脚本会生成 Capacitor 工程并构建 `release/android/app-release.apk`。安卓蓝牙打印模块需要在真实 XP-N160II 上继续做协议验收。

完整部署、备份和验收边界见 [`doc/DEPLOYMENT.md`](doc/DEPLOYMENT.md)、[`doc/ACCEPTANCE.md`](doc/ACCEPTANCE.md) 和 [`doc/MEMORY.md`](doc/MEMORY.md)。
