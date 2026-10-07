#!/usr/bin/env node
/**
 * build-efforts-table.mjs —— 把「实测」和「公开库」合并成**一张按模型 ID 索引的扁平表**。
 *
 * 设计取舍（2026-09-30 用户明确要求）：
 *   **只认模型 ID，不看中转来源。** 插件运行时只做一次模型 ID 查表，provider 不参与匹配。
 *   之所以能这么干，是因为同名模型在不同线路上档位可能不同 —— 所以合并时对**同名取交集**：
 *   交集对每条线路都合法（少给几档），既满足"匹配 ID 就行"，又不会给上游塞它会拒的值。
 *   例：`glm-5.3-flash` 智谱官方只有 low/high/max、commandcode 给 5 档 → 表里记 low/high/max。
 *
 * 来源优先级：probe-overrides.json（本机实测）> rules.json（OpenRouter ∩ models.dev）。
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

// 1) 实测：同名模型跨 provider 取交集
const byId = new Map(); // id -> { probe: string[][] }
for (const prov of Object.values(probed.providers || {})) {
  for (const [mid, r] of Object.entries(prov.models || {})) {
    if (r?.status !== 'validated' || !Array.isArray(r.efforts) || !r.efforts.length) continue;
    const k = normModelId(mid);
    if (!byId.has(k)) byId.set(k, { probe: [] });
    byId.get(k).probe.push(r.efforts);
  }
}

const out = { byModelId: {} };
let fromProbe = 0, fromRules = 0, dropped = 0;
const seen = new Set([...byId.keys(), ...Object.keys(rules.byModel || {})]);

for (const k of [...seen].sort()) {
  const entry = byId.get(k);
  if (entry?.probe.length) {
    const v = sort(intersect(entry.probe));
    if (v.length) {
      out.byModelId[k] = { efforts: v, source: entry.probe.length > 1 ? `probe∩(${entry.probe.length})` : 'probe' };
      fromProbe++;
      continue;
    }
    dropped++; // 同名线路给出的档位毫无交集 → 不写，交给 pattern 兜底
  }
  const r = rules.byModel?.[k];
  if (r && Array.isArray(r.efforts) && r.efforts.length) {
    out.byModelId[k] = { efforts: sort(r.efforts), source: `rules:${r.source || '?'}` };
    fromRules++;
  }
}

out.generatedAt = new Date().toISOString();
out.policy = 'flat by model id; same id across providers → intersection; probe > public rules';
out.stats = { total: Object.keys(out.byModelId).length, fromProbe, fromRules, droppedEmptyIntersection: dropped };
fs.writeFileSync(path.join(ROOT, 'efforts.json'), JSON.stringify(out, null, 1) + '\n');

console.log(`efforts.json: ${out.stats.total} 条（实测 ${fromProbe} / 公开库 ${fromRules} / 交集为空丢弃 ${dropped}）`);
console.log('抽查（同名跨线路合并的重点）:');
for (const k of ['glm-5.3-flash', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-terra', 'grok-4.6', 'grok-4.7', 'deepseek-v4-flash', 'mimo-v2.6-pro']) {
  const v = out.byModelId[k];
  console.log('  ' + k.padEnd(22), v ? `${v.efforts.join('/')}  ← ${v.source}` : '(未命中)');
}
