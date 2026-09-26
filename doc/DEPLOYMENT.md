# 部署与回退

## 地址与连接

线上后台：`https://43.142.138.108:1316`

SSH 连接使用：

```bash
ssh -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o IdentitiesOnly=yes \
  -i /Users/linxi/Downloads/edge/tencloud.pem \
  ubuntu@43.142.138.108
```

## 首次部署

```bash
npm install
npm run build
./scripts/deploy.sh
```

脚本会生成本机忽略的 `.deploy/order-dinner.env`，首次部署时上传为服务器 `/opt/order-dinner/.env`；如果远端已有 `.env`，脚本保留它。服务器使用 `order-dinner-db` 和 `order-dinner-app` 两个独立容器，数据库只在 Compose 网络内可见。Caddy 配置会先备份，再校验并热加载 dinner 路由。

## 验证

```bash
curl -fsS https://43.142.138.108:1316/healthz
ssh -o IdentitiesOnly=yes -i /Users/linxi/Downloads/edge/tencloud.pem ubuntu@43.142.138.108 \
  'cd /opt/order-dinner && sudo docker compose ps && sudo docker compose logs --tail=100 app'
```

首次管理员账号是 `admin`，密码只在生成 `.deploy/order-dinner.env` 时输出一次；不要把密码写入仓库文档。登录后立即在设置中创建收银员并妥善保存管理员密码。

## 备份与恢复

每日 03:00 的 cron 会调用 `scripts/backup.sh`，备份写入 `/opt/order-dinner/backups/`，数据库容器不映射公网端口。人工备份：

```bash
cd /opt/order-dinner
./scripts/backup.sh
```

恢复前必须停止应用、确认要恢复的具体备份并另行保存当前数据库；恢复操作会改变生产数据，不在自动部署脚本中执行。恢复后先访问 `/healthz`，再用测试账号核对桌台、菜品、积分和打印队列。

## 回退边界

应用回退使用上一份源码/镜像并重新 `docker compose up -d`；数据库迁移采用幂等 `CREATE ... IF NOT EXISTS`，不提供自动删表或降级。Caddy 修改失败时部署脚本恢复本次备份；不要直接删除容器、数据库目录或配置文件。
