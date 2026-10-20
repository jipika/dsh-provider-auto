#!/usr/bin/env node
/**
 * build-efforts-table.mjs —— 把「实测」和「公开库」合并成**一张按模型 ID 索引的扁平表**。
 *
 * 表结构（2026-10-15 改造：**键从「扁平 model ID」升级为 (线路, model ID)**）
 *
 *   旧口径的问题：扁平键无法区分线路，只能对同名跨线路**取交集**，于是必然把某条
 *   线路的真档位砍掉。实测损失：`gpt-6-sol` 在 gpt 线实测 7 档、交集后只剩 5 档
 *   （丢 none/minimal）；`glm-5.3-flash` 在 command 线 5 档、表里只剩 3 档（丢
 *   medium/xhigh）。
 *   新口径三层，运行期按序查（见 index.js resolveEfforts）：
 *     ① byRoute[<本机 route>][<归一 id>]        —— 本机实测，线路精确，最权威
 *     ② byProvider[<models.dev provider>][<归一 id>] —— **那一家自己的声明**，不取交集
 *        route→provider 由 endpointIndex 按 baseURL 反查（歧义项值为 null = 未命中）
 *     ③ byModelId[<归一 id>]                    —— 跨线路兜底，默认**只报告不写盘**
 *
 * ② 是借 dsh-models-dev 的核心优势，但**按 baseURL 反查而非按 route 名字**：
 * 名字匹配会把 `zai`（models.dev = Z.AI 开放平台）错配到 pi-ai 的 `zai` 路由
 * （= Z.AI Coding Plan），钉错端点会致全线 429（该插件 README 记录过）。
 * 验证：本机 9 条 route 里只有 zai-coding-cn 反查命中 zhipuai-coding-plan，
 * 而它给的 low/high/max 与本机 probe 实测**完全一致** —— 分维的源确实更准。
 * 杂牌中转（codexx / commandcode / heilovehei / 本地 antigravity）反查不中，
 * 只能靠 ① 实测与 ③ 兜底，这是数据源的边界，不是实现的缺陷。
 *
 * 用法：node tools/build-efforts-table.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { normModelId } from '../index.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

const ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const sort = (a) => [...a].sort((x, y) => {
  const ix = ORDER.indexOf(x), iy = ORDER.indexOf(y);
  return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || String(x).localeCompare(String(y));
});
const intersect = (sets) => {
  if (!sets.length) return [];
  const [first, ...rest] = sets;
  return first.filter((v) => rest.every((s) => s.includes(v)));
};

const probed = read('probe-overrides.json');
const rules = read('rules.json');

/**
 * ① 本机实测：**按线路保留，不再压平**（压平就是丢档位的根源）。
 * 同一线路里同一模型可能因带前缀/不带前缀出现多次 → 取交集，绝不并集
 * （并集会给出该上游会拒的值）。
 */
const byRoute = {};
const probeSets = new Map(); // 归一 id -> [各线路实测集合]：只给 ③ 兜底算交集用
for (const [route, prov] of Object.entries(probed.providers || {})) {
  for (const [mid, r] of Object.entries(prov?.models || {})) {
    if (r?.status !== 'validated' || !Array.isArray(r.efforts) || !r.efforts.length) continue;
    const k = normModelId(mid);
    const prev = byRoute[route]?.[k];
    const efforts = prev ? sort(intersect([prev.efforts, r.efforts])) : sort(r.efforts);
    if (!efforts.length) continue;
    (byRoute[route] ??= {})[k] = { efforts, source: `probe:${route}` };
    if (!probeSets.has(k)) probeSets.set(k, []);
    probeSets.get(k).push(r.efforts);
  }
}

/**
 * ③ 跨线路兜底表：实测按归一 id 跨线路取交集，取不到再用公开库。
 * 运行侧默认**不写盘**（index.js 的 useFallbackTable=false），只供报告与人工参考。
 */
const out = { byModelId: {} };
let fromProbe = 0, fromRules = 0, dropped = 0;
for (const k of [...new Set([...probeSets.keys(), ...Object.keys(rules.byModel || {})])].sort()) {
  const sets = probeSets.get(k);
  if (sets?.length) {
    const v = sort(intersect(sets));
    if (v.length) {
      out.byModelId[k] = { efforts: v, source: v.length && sets.length > 1 ? `probe∩(${sets.length})` : 'probe' };
      fromProbe++;
      continue;
    }
    dropped++; // 各线路档位毫无交集 → 记空，交给 ①/② 逐线路解决
  }
  const r = rules.byModel?.[k];
  if (r && Array.isArray(r.efforts) && r.efforts.length) {
    out.byModelId[k] = { efforts: sort(r.efforts), source: `rules:${r.source || '?'}` };
    fromRules++;
  }
}

out.byRoute = byRoute;
out.byProvider = rules.byProvider || {};
out.endpointIndex = rules.endpointIndex || {};
out.ambiguousEndpoints = rules.ambiguousEndpoints || [];

out.generatedAt = new Date().toISOString();
out.policy = 'route-keyed primary: probe(byRoute) > models.dev per-provider(byProvider via baseURL) > byModelId(fallback, report-only)';
out.stats = {
  total: Object.keys(out.byModelId).length,
  fromProbe, fromRules, droppedEmptyIntersection: dropped,
  routes: Object.keys(byRoute).length,
  byRouteEntries: Object.values(byRoute).reduce((n, m) => n + Object.keys(m).length, 0),
  providers: Object.keys(out.byProvider).length,
  endpoints: Object.keys(out.endpointIndex).length,
};
fs.writeFileSync(path.join(ROOT, 'efforts.json'), JSON.stringify(out, null, 1) + '\n');

console.log(`efforts.json: ③ 兜底 ${out.stats.total} 条（实测 ${fromProbe} / 公开库 ${fromRules} / 交集为空丢弃 ${dropped}）`);
console.log(`  ① byRoute: ${out.stats.routes} 条线路 / ${out.stats.byRouteEntries} 个 (线路,模型)`);
console.log(`  ② byProvider: ${out.stats.providers} 个 models.dev provider / endpointIndex ${out.stats.endpoints} 项（歧义 ${out.ambiguousEndpoints.length}）`);
console.log('\n线路隔离抽查（同一模型在不同线路上档位不同 = 本次改造的目的）:');
for (const k of ['gpt-6-sol', 'gpt-6.1-sol', 'glm-5.3-flash', 'deepseek-v4-flash', 'grok-4.7']) {
  const per = Object.entries(byRoute).filter(([, m]) => m[k]).map(([route, m]) => `${route}=${m[k].efforts.join('/')}`);
  const md = out.byProvider['zhipuai-coding-plan']?.[k];
  console.log(`  ${k.padEnd(18)} 实测[${per.join(' | ') || '无'}]  ③兜底[${(out.byModelId[k]?.efforts || []).join('/') || '无'}]  models.dev[zhipuai-coding-plan][${(md?.efforts || []).join('/') || '无'}]`);
}
