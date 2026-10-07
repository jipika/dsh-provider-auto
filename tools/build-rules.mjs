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

const ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const sortEfforts = (a) => [...a].sort((x, y) => {
  const ix = ORDER.indexOf(x), iy = ORDER.indexOf(y);
  return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy) || String(x).localeCompare(String(y));
});

async function main() {
  const [or, md] = await Promise.all([grab('openrouter'), grab('modelsdev')]);
  const A = fromOpenRouter(or), B = fromModelsDev(md);
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
    policy: 'intersection (conservative)',
    stats,
    byModel,
  };
  fs.writeFileSync(path.join(ROOT, 'rules.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`规则条目 ${keys.length} 条 → rules.json`);
  console.log('来源分布:', stats);
  console.log('抽查:');
  for (const k of ['gpt-6.1-sol', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'claude-opus-5-5', 'mimo-v2.6-pro', 'grok-4.7']) {
    console.log('  ' + k.padEnd(22), byModel[k] ? JSON.stringify(byModel[k]) : '(未命中)');
  }
}

if (process.argv[1]?.endsWith('build-rules.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
