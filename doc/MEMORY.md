# 项目记忆

更新时间：2026-09-25

## 2026-09-25 线上状态

- 已迁移到 `43.142.138.108`，SSH 用户为 `ubuntu`；Order Dinner 公网地址为 `https://43.142.138.108:1316`。Caddy 将 1316 转发到 `order-dinner-app:3000`，2026-09-25 的 HTTPS `/healthz` 检查返回 200。
- SSH 私钥路径为 `/Users/linxi/Downloads/edge/tencloud.pem`；不要把私钥内容写入仓库或记忆。
- 不写入营业数据的冒烟检查通过：管理员登录、`/healthz`、12 张默认桌台和设置接口均正常；生产库当前订单数为 0。
- 首次部署曾因 Dockerfile 排除 Rollup Linux 可选依赖、递归修改 PostgreSQL 数据目录属主而失败；现已分别改为 `npm ci --include=optional`，并让部署脚本跳过 `data`、`backups` 的递归属主修改。
- 该服务器的 Caddy 单文件只读挂载在编辑宿主机后需要重启 `love-caddy` 才会刷新；部署脚本已在 Caddy 配置校验后重启它，重启会短暂影响现有入口。
- 管理员初始密码只保存在本机 `.deploy/order-dinner.env`，没有写入此记忆文档或 Git。

## 当前目标

这是单店餐厅员工点单系统。网页、Windows Electron 安装包和安卓 Capacitor 安装包共用一个 Node.js 服务与 PostgreSQL；当前线上地址为 `https://43.142.138.108:1316`，旧服务器 `20.48.27.179` 已被新服务器替代，部署目录为 `/opt/order-dinner`。

## 重要决策

- 金额全部以整数分保存；服务端是价格、权限、积分和订单状态的唯一裁决方。
- 订单菜品写入名称、售价、成本和分类快照，后续改菜品不会改变历史账单。
- 每次开菜批次单独建 `order_batches`，厨房打印任务每批生成两份；结账小票只生成一份。
- 赠送、退菜、减免、积分抵扣、收款和操作员都保留在订单/结账/操作流水中。
- 结账和积分流水在同一个 PostgreSQL 事务中完成；撤销重结会冲销旧结账、复制快照为新进行中账单，不重复通知厨房。
- 生产库默认不写演示菜品和营业订单，只创建 1—12 号桌、一个“待配置”分类和管理员账号；如果需要演示菜品，显式设置 `SEED_DEMO_DATA=true`。
- 打印采用服务端队列：固定安卓设备领取、发送、回执；`NEEDS_CHECK` 表示结果不明，不能直接当成功处理。
- 现有服务器 Caddy、love-web、deepseek、astro 和 vless-reality 不属于本项目；部署脚本只新增 `order-dinner` Compose 栈和 dinner 域名路由，并在修改 Caddy 前留备份。

## 关键路径

- 服务入口：`server/src/index.ts`
- 数据迁移和初始配置：`server/src/migrate.ts`
- 前端入口：`web/src/App.tsx`
- 容器编排：`docker-compose.yml`、`Dockerfile`
- 线上部署：`scripts/deploy.sh`
- 数据库备份：`scripts/backup.sh`
- 安卓构建：`scripts/package-android.sh`
- 桌面构建：`npm run package:win`

## 继续工作前先检查

1. `git status --short`，不要覆盖用户已有改动。
2. `npm run build` 和 `npm test`。
3. 需要线上操作时，用用户给出的 SSH 连接参数；先只读检查现有容器、Caddy 和目标目录。
4. 不要把 `.deploy/order-dinner.env`、管理员密码或私钥提交到 Git。
5. 任何真实打印、安卓实机、Windows 实机、断网恢复和正式营业数据验收都要单独记录，不能用网页构建成功代替。

## 已知边界

- XP-N160II 的经典蓝牙串口通道、中文编码、缺纸回执尚未在真实设备上确认；当前交付的是可重试的服务端队列和安卓构建入口。
- 本机没有 Docker、Android SDK、adb；Windows 安装包和安卓 APK 是否能在本机生成，取决于后续安装的构建工具。服务器有 Docker，可生成线上容器。
- 线上部署不会自动创建真实菜单、桌号之外的营业数据，也不会代替老板配置和实机验收。
