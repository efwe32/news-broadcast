# Deploy 新闻播报 to Cloudflare Workers

## Blockers observed (2026-10-16)
- Account has **no workers.dev subdomain yet** (API 10007). Open once:
  https://dash.cloudflare.com/?to=/:account/workers-and-pages
- Connected Cloudflare MCP token can **read** Workers / run **Workers AI**, but **cannot**
  `PUT /workers/scripts` or create Pages (API 10000 / "No access").
  Re-auth MCP with Workers Scripts Edit, or create an API token with:
  Account → Workers Scripts:Edit, Workers AI:Edit, Account Settings:Read

## Deploy with Wrangler
```bash
cd /workspace/news-broadcast/cf-worker
npx wrangler@3.112.0 login   # or export CLOUDFLARE_API_TOKEN=...
npx wrangler@3.112.0 deploy
```
URL will be: `https://news-broadcast.<your-subdomain>.workers.dev`

## Verify
```bash
curl -sL "$URL/" | grep -o 新闻播报
curl -sL "$URL/api/news?top_n=5" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("item_count"), d.get("provider"))'
curl -sL -X POST "$URL/api/tts" -H 'content-type: application/json' \
  -d '{"text":"来自微博。测试。","style":"狐媚"}' -o /tmp/t.bin -w "%{http_code} %{content_type} %{size_download}\n"
```
