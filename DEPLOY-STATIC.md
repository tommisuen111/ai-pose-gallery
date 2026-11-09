# 静态站点部署（ai.myrichmond.ca）

线上 <https://ai.myrichmond.ca> 是纯静态 Cloudflare Workers Assets 站点，Worker 名称 `ai-pose-gallery`。配置在 [`wrangler.static.jsonc`](wrangler.static.jsonc)：资源目录 `./dist`，`not_found_handling` 为 `single-page-application`，自定义域名 `ai.myrichmond.ca`。文件里没有 `main`，因此不会上传 Worker 脚本，也不会部署 `/api/proxy`。

上游的 `wrangler.jsonc`、`worker.ts`、`functions/` 保持原样，方便以后合并 [anhao/ai-pose-gallery-zh](https://github.com/anhao/ai-pose-gallery-zh)。那套配置才会带上同源代理。

## 构建

```bash
bash scripts/build.sh
```

## 部署

先在环境里设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。不要把 token 写进仓库或命令参数。

```bash
npx wrangler deploy -c wrangler.static.jsonc
```

等价脚本：

```bash
pnpm deploy:static
```

## AI 代理

这份配置故意不部署 `/api/proxy`。阿里云百炼（Qwen）和火山方舟（Doubao）需要该同源代理才能绕过浏览器 CORS；Google Gemini 和 OpenAI 可以在浏览器里直连。需要千问或豆包时，改用上游的 `wrangler.jsonc`（含 `worker.ts`）部署。

## 同步上游

```bash
git remote add upstream https://github.com/anhao/ai-pose-gallery-zh
git fetch upstream
git merge upstream/main
```

若 `upstream` 已经加过，跳过第一行即可。
