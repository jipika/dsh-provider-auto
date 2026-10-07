#!/usr/bin/env node
/**
 * probe-efforts.mjs —— 逐 provider、逐模型**实测**上游真正接受的 reasoning effort 集合。
 *
 * 为什么要实测：档位集合取决于「接入方」而不是「模型家族」。
 * 同一个 glm-5.3-flash：智谱官方只给 low/high/max，commandcode 中转给 5 档，
 * OpenRouter 记录的是 max/high/low —— 三份公开数据互相冲突，只有打到这个
 * provider 上的这次探测才是权威。
 *
 * 探测原理：故意发一个**不存在的档位值**，上游会 400 并把合法值清单原文吐回来：
 *   OpenAI 系      → Invalid value: 'x'. Supported values are: 'none', 'minimal', ...
 *   commandcode    → Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"
 *   智谱            → reasoning_effort 参数值非法，可选值为：none、minimal、...
 *                     / 该模型始终思考…；请使用 low、high 或 max。
 *   部分网关        → 压根不校验（返回 200）→ 记为 unvalidated，规则表不覆盖它
 *
 * 用法：
 *   node tools/probe-efforts.mjs                       # 探 desktop，写同目录上一级 probe-overrides.json
 *   node tools/probe-efforts.mjs --profile desktop
 *   node tools/probe-efforts.mjs --only gpt,command     # 只探指定 provider
 *   node tools/probe-efforts.mjs --dry                  # 只打印计划，不发请求
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const arg = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const HERE = path.dirname(new URL(import.meta.url).pathname);
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profile = arg('profile', process.env.DSH_PROFILE || 'desktop');
const profileDir = path.join(dshHome, 'profiles', profile);
const outPath = path.resolve(arg('out', path.join(HERE, '..', 'probe-overrides.json')));
const only = (arg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const PROBE = arg('probe', '__dsh_probe__');
const TIMEOUT = Number(arg('timeout', '60000'));

const req = createRequire(path.join(profileDir, 'noop.js'));
const YAML = req('yaml');

function loadProviders() {
  const patch = path.join(profileDir, 'cordis.patch.yml');
  const doc = YAML.parse(fs.readFileSync(patch, 'utf8'));
  const entry = doc.find((e) => e && e.id === 'llm-pi-ai');
  if (!entry?.config?.providers) throw new Error(`no llm-pi-ai providers in ${patch}`);
  return entry.config.providers;
}

function loadKeys() {
  const file = path.join(dshHome, '.credentials.yaml');
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  return doc.refs || {};
}

/** 从上游错误文案里抠出合法档位清单；吃不下就返回 null。 */
export function parseEfforts(text) {
  if (!text) return null;
  const quoted1 = [...text.matchAll(/'([a-z]{3,7})'/g)].map((m) => m[1]);
  if (quoted1.length) return uniq(quoted1);
  const quoted2 = [...text.matchAll(/"([a-z]{3,7})"/g)].map((m) => m[1]);
  if (quoted2.length) return uniq(quoted2);
  const cn = text.match(/可选值为[：:]\s*([^\n。]+)/);
  if (cn) return uniq(cn[1].split(/[、,，/]/).map((s) => s.trim()).filter(Boolean));
  const cn2 = text.match(/请使用\s*([^。\n]+)/);
  if (cn2) {
    const v = cn2[1].split(/[、,，]|或/).map((s) => s.trim()).filter((s) => /^[a-z]{3,7}$/.test(s));
    if (v.length) return uniq(v);
  }
  const en = text.match(/valid levels?[：:]\s*([^\n.]+)/i);
  if (en) return uniq(en[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
  return null;
}

const uniq = (a) => [...new Set(a)];
const trimBase = (u) => String(u || '').replace(/\/+$/, '');

async function probeOne({ api, baseURL, key, model }) {
  const isAnthropic = api === 'anthropic-messages';
  const url = isAnthropic ? `${trimBase(baseURL)}/v1/messages` : `${trimBase(baseURL)}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  let body;
  if (isAnthropic) {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    body = { model, max_tokens: 16, output_config: { effort: PROBE }, messages: [{ role: 'user', content: 'ok' }] };
  } else {
    headers.authorization = `Bearer ${key}`;
    body = { model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 8, reasoning_effort: PROBE };
  }
  const res = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 非 JSON，正文留在 text */ }
  const msg = payload?.error?.message || payload?.message || text;
  const efforts = parseEfforts(msg);
  if (res.ok) return { status: 'unvalidated', http: res.status, note: '上游不校验档位值（传非法值也 200）' };
  if (efforts) return { status: 'validated', http: res.status, efforts };
  return { status: 'unknown', http: res.status, note: String(msg).slice(0, 200) };
}

async function main() {
  const providers = loadProviders();
  const keys = loadKeys();
  const plan = [];
  for (const [pid, p] of Object.entries(providers)) {
    if (only.length && !only.includes(pid)) continue;
    const key = keys[p.apiKeyEnv];
    for (const m of p.models || []) {
      plan.push({ pid, api: p.api, baseURL: p.baseURL, key, model: m.id });
    }
  }
  console.log(`profile=${profile}  provider(s)=${[...new Set(plan.map((x) => x.pid))].join(', ')}  models=${plan.length}`);
  if (has('dry')) { plan.forEach((x) => console.log('  →', x.pid, '/', x.model)); return; }

  const out = { generatedAt: new Date().toISOString(), profile, probe: PROBE, providers: {} };
  for (const item of plan) {
    const { pid, api, baseURL, key, model } = item;
    out.providers[pid] ||= { api, baseURL, models: {} };
    if (!key) {
      out.providers[pid].models[model] = { status: 'skipped', note: `凭据 ${'apiKeyEnv'} 缺失` };
      console.log(`  ${pid}/${model}  SKIP(no key)`);
      continue;
    }
    try {
      const r = await probeOne(item);
      out.providers[pid].models[model] = r;
      const shown = r.efforts ? r.efforts.join('/') : (r.note || r.status);
      console.log(`  ${pid.padEnd(14)} ${String(model).padEnd(28)} ${r.status.padEnd(12)} ${shown}`);
    } catch (e) {
      out.providers[pid].models[model] = { status: 'error', note: e.message };
      console.log(`  ${pid.padEnd(14)} ${String(model).padEnd(28)} ERROR        ${e.message}`);
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
  console.log(`\n写出 ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('probe-efforts.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
