#!/usr/bin/env node
// Brave Web Search：零依赖 wrapper，紧凑输出（title / url / snippet / age）。
// 用途：精确关键词、时效性、找准确 URL。语义/代码搜索用 exa。
import { credential } from "./credential.mjs";

const API = "https://api.search.brave.com/res/v1/web/search";
const KEY = credential("BRAVE_SEARCH_API_KEY");

function usage(code = 0) {
	console.log(`用法: brave-search "query" [options]
  -n <num>            结果数 1-20（默认 8）
  --freshness <p>     pd|pw|pm|py 或 YYYY-MM-DDtoYYYY-MM-DD
  --country <code>    两字母国家码（默认不限）
  --offset <n>        翻页偏移 0-9
  --json              输出原始 JSON`);
	process.exit(code);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage(args.length ? 0 : 1);
if (!KEY) {
	console.error("Brave 未配置：请运行 setup configure-search");
	process.exit(1);
}

const opts = { query: "", count: 8, raw: false };
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "-n") opts.count = Math.min(20, Math.max(1, Number(args[++i]) || 8));
	else if (arg === "--freshness") opts.freshness = args[++i];
	else if (arg === "--country") opts.country = args[++i];
	else if (arg === "--offset") opts.offset = args[++i];
	else if (arg === "--json") opts.raw = true;
	else if (arg.startsWith("-")) usage(1);
	else opts.query = opts.query ? `${opts.query} ${arg}` : arg;
}
if (!opts.query) usage(1);

const params = new URLSearchParams({ q: opts.query, count: String(opts.count) });
for (const key of ["freshness", "country", "offset"]) {
	if (opts[key]) params.set(key, opts[key]);
}

const response = await fetch(`${API}?${params}`, {
	headers: { Accept: "application/json", "X-Subscription-Token": KEY },
});
if (!response.ok) {
	const body = await response.text();
	console.error(`Brave API ${response.status}: ${body.slice(0, 300)}`);
	process.exit(1);
}
const data = await response.json();
if (opts.raw) {
	console.log(JSON.stringify(data, null, 2));
	process.exit(0);
}

const results = data.web?.results ?? [];
if (results.length === 0) {
	console.log(`无结果: ${opts.query}`);
	process.exit(0);
}
const ENTITIES = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#x27;": "'", "&#39;": "'" };
const stripTags = (text) =>
	(text ?? "").replace(/<[^>]+>/g, "").replace(/&[#\w]+;/g, (entity) => ENTITIES[entity] ?? entity);
console.log(`# Brave: ${opts.query}${opts.freshness ? ` (freshness=${opts.freshness})` : ""}\n`);
results.forEach((item, index) => {
	const age = item.age ? ` · ${item.age}` : "";
	console.log(`${index + 1}. ${stripTags(item.title)}${age}\n   ${item.url}\n   ${stripTags(item.description)}\n`);
});
