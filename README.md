# 新闻播报 (Cloudflare Worker)

实时热点 + 语音口播。数据源：锋讯 Pulse。默认音色选择保留「狐媚」等六种；线上 TTS 使用 Workers AI MeloTTS（中文）。

## 一键部署前提
1. 打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) 一次（创建 workers.dev 子域）
2. 创建 API Token（Workers Scripts Edit + Workers AI）
3. 本地：`npx wrangler@3.112.0 deploy`
   或在本仓库 Settings → Secrets 添加 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 后跑 Actions

详见 [DEPLOY.md](./DEPLOY.md)。

预期 URL：`https://news-broadcast.<subdomain>.workers.dev`
