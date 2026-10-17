# HueHaven 后端（Cloudflare）

这个目录是 HueHaven 前端对应的无服务器后端：

- **Cloudflare Workers**：API 与鉴权
- **Cloudflare D1**：用户、会话、情绪记录
- **Cloudflare R2**：照片对象存储

前端对应客户端封装位于原项目的 `source/src/services/cloud.ts`，通过 `EXPO_PUBLIC_API_URL` 指向本项目部署后的 Worker 域名。

## 本地启动

```bash
npm install
npx wrangler login
npm run db:migrate:local
npm run dev
```

## 创建 Cloudflare 资源并部署

```bash
npx wrangler d1 create huehaven-db
npx wrangler r2 bucket create huehaven-media
```

把 D1 命令返回的 `database_id` 写入 `wrangler.toml`，然后执行：

```bash
npm run db:migrate:remote
npm run deploy
```

部署后把前端环境变量设置为：

```bash
EXPO_PUBLIC_API_URL=https://你的-worker域名
```

## API

- `GET /health`
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `GET /v1/me`
- `GET /v1/records`
- `POST /v1/records`
- `PUT /v1/records/:id`
- `DELETE /v1/records/:id`
- `PUT /v1/media/:key`
- `GET /v1/media/:key`

生产部署前请将 `wrangler.toml` 中的 `APP_ORIGIN` 改成实际前端来源，并检查 R2、D1 的生产资源绑定。

## 情绪报告

已增加 `GET /v1/reports/summary`，需要 Bearer Token。参数为 Unix 毫秒时间戳：

```text
/v1/reports/summary?start=开始时间&end=结束时间
```

返回 `daily`（每日情绪与颜色）、`colors`（颜色趋势）、`activities`（活动次数及情绪分布）和 `total`。未传参数时默认统计最近 30 天。

## 生产环境配置

开发环境可以使用 `APP_ORIGIN = "http://localhost:8081"`。部署到生产环境前，请在 `wrangler.toml` 或 Cloudflare 环境变量中改成实际前端域名，例如：

```toml
[vars]
APP_ORIGIN = "https://app.example.com"
```

每个环境应分别执行 D1 迁移。不要把密码、API 密钥或其他敏感信息写入 `wrangler.toml`；敏感配置使用：

```bash
npx wrangler secret put SECRET_NAME
```

## 分页与报告限制

`GET /v1/records` 支持：

```text
?limit=50&since=时间戳&cursor=时间戳
```

每页最多 100 条，返回 `nextCursor` 时继续请求下一页。报告接口最多查询 365 天，避免单次读取过多数据。每次鉴权也会清理已过期会话。

## 会话管理

- `GET /v1/auth/sessions`：查看当前账号的会话时间
- `POST /v1/auth/logout-all`：退出所有设备

## 错误响应

接口错误统一返回：

```json
{ "error": { "code": "AUTH_REQUIRED", "message": "需要登录" } }
```

前端应根据 `code` 判断处理逻辑，不要依赖中文 `message`。

## 账号注销

```text
DELETE /v1/me
```

该接口会删除当前用户的 R2 图片、D1 用户数据、会话、情绪记录和删除同步标记。调用前应在产品层要求用户明确确认。

## 用户设置同步

- `GET /v1/settings`
- `PUT /v1/settings`

更新请求示例：

```json
{ "settings": { "dailyReminder": "true", "showLocation": "false" } }
```

## 云端备份

- `POST /v1/backups`：上传 JSON 备份，最大 10MB
- `GET /v1/backups`：列出当前用户的备份
- `GET /v1/backups/:id`：下载备份
- `DELETE /v1/backups/:id`：删除备份及 R2 对象

## 支付权益

- `GET /v1/entitlements`：查询当前用户的 premium 权益
- `GET /v1/entitlements/history`：查询购买、续费、退款和过期事件
- `POST /v1/webhooks/revenuecat`：接收 RevenueCat 购买、续费、退款和过期事件
- `GET /v1/products`：返回可购买商品目录

生产环境设置 Webhook 密钥：

```bash
npx wrangler secret put REVENUECAT_WEBHOOK_SECRET
```

主动刷新权益还需要 RevenueCat API 密钥：

```bash
npx wrangler secret put REVENUECAT_API_KEY
```

设备在登录后可通过 `PUT /v1/push-tokens` 注册 Expo Push Token，定时任务会在订阅到期前 7 天和 1 天发送提醒。
