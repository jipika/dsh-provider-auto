#!/usr/bin/env node
/**
 * build-rules.mjs —— 拉取公开模型库，生成「按模型名索引的档位兜底表」rules.json。
 *
 * 数据源（两个都是可机读的）：
 *   OpenRouter  https://openrouter.ai/api/v1/models   → data[].reasoning.supported_efforts
 *   models.dev  https://models.dev/api.json           → <provider>.models.<m>.reasoning_options[type=effort].values
 *
 * ⚠️ 为什么这张表只能当**兜底**：两个源本身就互相打架（135 个共有模型里只有 51 个一致），
 * 因为它们记录的是各自上游的能力，而不是你这条线路的能力。真正权威的是
 * probe-efforts.mjs 打到具体 provider 上的实测结果（probe-overrides.json），
 * 插件运行时优先用实测表，只有实测没覆盖的模型才回落到这张表。
 *
 * 策略：两个源都有时取**交集**（保守 —— 宁可少给几档，也不给上游会拒的值）；
 * 只有一个源时用该源；交集为空则记为空数组（= 不补）。
 *
 * 用法：
 *   node tools/build-rules.mjs                 # 联网拉取并写 rules.json
 *   node tools/build-rules.mjs --offline       # 复用 ./cache 下的缓存
 */

import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const CACHE = path.join(ROOT, '.cache');
const offline = process.argv.includes('--offline');

const SOURCES = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  modelsdev: 'https://models.dev/api.json',
};

async function grab(name) {
  const cacheFile = path.join(CACHE, `${name}.json`);
  if (offline) {
    if (!fs.existsSync(cacheFile)) throw new Error(`--offline 但没有缓存 ${cacheFile}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  const res = await fetch(SOURCES[name], { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cacheFile, text);
  return JSON.parse(text);
}

/** 把 `openai/gpt-6.1-sol:batch` 之类归一成 `gpt-6.1-sol` */
export const normModelId = (id) =>
  String(id).replace(/:(batch|free|extended|thinking|nitro)$/i, '').split('/').pop().toLowerCase();

const uniq = (a) => [...new Set(a)];

function fromOpenRouter(data) {
  const map = {};
  for (const m of data?.data || []) {
    const eff = m?.reasoning?.supported_efforts;
    if (!Array.isArray(eff) || !eff.length) continue;
    const k = normModelId(m.id);
    map[k] = map[k] ? uniq([...map[k], ...eff]) : eff.map(String);
  }
  return map;
}

/** 摊平版本：跨 provider 取**并集**，只当最后兜底（可能给某条线路多档或错档）。 */
function fromModelsDev(data) {
  const map = {};
  for (const prov of Object.values(data || {})) {
    for (const m of Object.values(prov?.models || {})) {
      const opt = (m?.reasoning_options || []).find((o) => o.type === 'effort' && Array.isArray(o.values));
      if (!opt || !opt.values.length) continue;
      const k = normModelId(m.id);
      map[k] = map[k] ? uniq([...map[k], ...opt.values]) : opt.values.map(String);
    }
  }
  return map;
}

/**
 * models.dev 按 **provider 分维**（本次改造借来的核心优势）。
 *
 *   byProvider[<models.dev provider id>][<normModelId>] = { efforts, source }
 *   endpointIndex[<该 provider 公布的 api，去尾斜杠小写>] = [<provider id>]
 *
 * 为什么这是主键：同一模型在不同 provider 下档位集合不同（实测 176/511 个
 * canonical 模型跨 provider 不一致）。摊平成 by-model 只能取交集/并集，前者必然
 * 砍掉某条线路的真档位（gpt-6-sol 实测 7 档被砍成 5），后者会给出上游会拒的值。
 * 分维后运行期按 route 取**那一家自己的声明**，不需要任何交集。
 *
 * endpointIndex 是 route→provider 的**自动**映射依据：按各家公布的端点反查，
 * **不按 route 名字**。名字匹配会把 `zai`（models.dev = Z.AI 开放平台）错配到
 * pi-ai 的 `zai` 路由（= Z.AI Coding Plan）—— dsh-models-dev README 记录过那条
 * 钉错 baseURL 致全线 `429 Insufficient balance` 的事故。反查不中就返回空，
 * 交给上层决定；一个端点命中多个 provider 时**按未命中处理**（映射不确定）。
 */
function fromModelsDevByProvider(data) {
  const byProvider = {};
  const endpointIndex = {};
  for (const [pid, prov] of Object.entries(data || {})) {
    if (!prov || typeof prov !== 'object') continue;
    const api = typeof prov.api === 'string' ? prov.api.replace(/\/+$/, '').toLowerCase() : undefined;
    if (api) (endpointIndex[api] ??= []).push(pid);
    for (const m of Object.values(prov?.models || {})) {
      const opt = (m?.reasoning_options || []).find((o) => o?.type === 'effort' && Array.isArray(o.values));
      if (!opt || !opt.values.length) continue;
      const k = normModelId(m.id);
      const bucket = (byProvider[pid] ??= {});
      const merged = uniq([...(bucket[k]?.efforts || []), ...opt.values.map(String)]);
      bucket[k] = { efforts: merged, source: `models.dev:${pid}` };
    }
  }
  return { byProvider, endpointIndex };
}

/** 归一化一个端点用于比较：去尾斜杠、去 query、小写。 */
export const normEndpoint = (u) =>
  String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();

const ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const sortEfforts = (a) => [...a].sort((x, y) => {
  const ix = ORDER.indexOf(x), iy = ORDER.indexOf(y);
  return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || String(x).localeCompare(String(y));
});

async function main() {
  const [or, md] = await Promise.all([grab('openrouter'), grab('modelsdev')]);
  const A = fromOpenRouter(or), B = fromModelsDev(md);
  const { byProvider, endpointIndex } = fromModelsDevByProvider(md);
  for (const bucket of Object.values(byProvider)) {
    for (const row of Object.values(bucket)) row.efforts = sortEfforts(row.efforts);
  }
  // 一个端点对应多个 provider ⇒ 映射不确定，运行期按未命中处理。留原数组供排查。
  const ambiguous = Object.fromEntries(Object.entries(endpointIndex).filter(([, v]) => v.length > 1));
  const keys = uniq([...Object.keys(A), ...Object.keys(B)]).sort();
  const byModel = {}, stats = { both: 0, orOnly: 0, mdOnly: 0, intersect: 0, emptyIntersect: 0, agree: 0 };
  for (const k of keys) {
    let v, src;
    if (A[k] && B[k]) {
      const sa = new Set(A[k]), sb = new Set(B[k]);
      v = A[k].filter((x) => sb.has(x));
      src = 'intersection';
      stats.both++;
      if (JSON.stringify(sortEfforts(A[k])) === JSON.stringify(sortEfforts(B[k]))) stats.agree++;
      if (v.length) stats.intersect++; else { stats.emptyIntersect++; v = []; }
    } else if (A[k]) { v = A[k]; src = 'openrouter'; stats.orOnly++; }
    else { v = B[k]; src = 'models.dev'; stats.mdOnly++; }
    byModel[k] = { efforts: sortEfforts(v), source: src };
  }
  const out = {
    generatedAt: new Date().toISOString(),
    sources: SOURCES,
    policy: 'byProvider keyed by (models.dev provider id, model) = primary; byModel = OpenRouter ∩ models.dev(union) last-resort fallback',
    stats,
    // 主键：route → 该家自己的声明。endpointIndex 让运行期按 baseURL 反查，
    // 歧义（一端点多 provider）已置 null = 按未命中处理。
    byProvider,
    endpointIndex: Object.fromEntries(
      Object.entries(endpointIndex).map(([api, pids]) => [api, pids.length === 1 ? pids[0] : null]),
    ),
    ambiguousEndpoints: Object.keys(ambiguous),
    byModel,
  };
  fs.writeFileSync(path.join(ROOT, 'rules.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`规则条目 ${keys.length} 条 → rules.json；models.dev 分维 provider ${Object.keys(byProvider).length} 个，端点索引 ${Object.keys(out.endpointIndex).length} 项（歧义 ${out.ambiguousEndpoints.length}）`);
  console.log('来源分布:', stats);
  console.log('抽查:');
  for (const k of ['gpt-6.1-sol', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'claude-opus-5-5', 'mimo-v2.6-pro', 'grok-4.7']) {
    console.log('  ' + k.padEnd(22), byModel[k] ? JSON.stringify(byModel[k]) : '(未命中)');
  }
}

if (process.argv[1]?.endsWith('build-rules.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
