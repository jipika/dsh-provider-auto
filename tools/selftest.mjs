#!/usr/bin/env node
/**
 * selftest.mjs —— 离线自检：不联网、不写盘，只验证 (线路, 模型) → 档位 的查找决策。
 *
 * 口径（2026-10-15 改造后，与旧版相反）：**线路参与匹配**。
 *   ① probe(byRoute) > ② models.dev 单家(byProvider，按 baseURL 反查或 sources 手工绑)
 *   > ③ 跨线路兜底(byModelId，默认不写盘) > ④ config.modelPattern > 不补
 *   用户手写的 reasoningEfforts **一律不动**（既不补也不删 —— 少给档位常常是有意的）。
 *
 * 用法: node tools/selftest.mjs   （表缺失时用注入的 fake table，不依赖网络产物）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planEfforts, resolveEfforts, normModelId, normEndpoint } from '../index.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REAL = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'efforts.json'), 'utf8')); } catch { return null; } })();

const ZAI = 'https://open.bigmodel.cn/api/coding/paas/v4';

// —— 合成表：把三层各放一条，验证优先级与隔离，不依赖联网产物
const fake = {
  byRoute: {
    gpt: { 'gpt-6-sol': { efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], source: 'probe:gpt' } },
    heihei: { 'gpt-6-sol': { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'probe:heihei' } },
  },
  byProvider: { 'zhipuai-coding-plan': {
    'glm-5.3-highspeed': { efforts: ['low', 'high', 'max'], source: 'models.dev:zhipuai-coding-plan' },
    // 手写只给了 low/high：用来验证「表更宽时只报告、不改写」
    'glm-5.3-flash': { efforts: ['low', 'high', 'max'], source: 'models.dev:zhipuai-coding-plan' },
  } },
  endpointIndex: { [ZAI]: 'zhipuai-coding-plan', 'https://ambiguous.example/v1': null },
  byModelId: {
    'grok-4.7': { efforts: ['low', 'medium', 'high', 'xhigh'], source: 'rules:intersection' },
    // 故意放一条比 ② 窄的：验证 ② 命中时**不会**落到交集
    'glm-5.3-flash': { efforts: ['low', 'high'], source: 'rules:probe∩(2)' },
  },
};

let n = 0;
const ok = (label, cond) => { assert.ok(cond, label); n++; };
const eq = (label, a, b) => { assert.deepEqual(a, b, label); n++; };

// —— ① 线路隔离：同一模型 ID，两条线路拿到**不同**档位（这是本次改造的目的）
const g1 = resolveEfforts({ modelId: 'gpt-6-sol', route: 'gpt', baseURL: 'x', table: fake, config: {} });
const g2 = resolveEfforts({ modelId: 'gpt-6-sol', route: 'heihei', baseURL: 'x', table: fake, config: {} });
eq('gpt 线 7 档', g1?.efforts.length, 7);
eq('heihei 线 5 档', g2?.efforts.length, 5);
ok('两条线路的集合不同（旧压平表会砍成 5/5）', JSON.stringify(g1.efforts) !== JSON.stringify(g2.efforts));
eq('来源标出线路', `${g1.source}|${g2.source}`, 'probe:gpt|probe:heihei');

// —— ② 反查靠 baseURL，不靠 route 名字
eq('带 baseURL 命中该家声明', resolveEfforts({ modelId: 'glm-5.3-highspeed', route: 'zai-coding-cn', baseURL: ZAI, table: fake, config: {} })?.source, 'models.dev:zhipuai-coding-plan');
eq('不给 baseURL → 不补', resolveEfforts({ modelId: 'glm-5.3-highspeed', route: 'zai-coding-cn', table: fake, config: {} }), null);
eq('域名写错 → 不补（不是名字匹配）', resolveEfforts({ modelId: 'glm-5.3-highspeed', route: 'zai-coding-cn', baseURL: 'https://example.com/v4', table: fake, config: {} }), null);
eq('尾斜杠+query 归一后仍命中', resolveEfforts({ modelId: 'glm-5.3-highspeed', route: 'zai-coding-cn', baseURL: `${ZAI}/?x=1`, table: fake, config: {} })?.source, 'models.dev:zhipuai-coding-plan');
eq('sources 手工映射优先于反查', resolveEfforts({ modelId: 'glm-5.3-highspeed', route: 'gpt', baseURL: 'https://codexx.v6.army/v1', table: fake, config: { sources: { gpt: 'zhipuai-coding-plan' } } })?.source, 'models.dev:zhipuai-coding-plan');
eq('端点歧义（null）→ 不猜', resolveEfforts({ modelId: 'glm-5.3-highspeed', route: 'r', baseURL: 'https://ambiguous.example/v1', table: fake, config: {} }), null);
eq('① 优先级压过 ②', resolveEfforts({ modelId: 'gpt-6-sol', route: 'gpt', baseURL: ZAI, table: { ...fake, byProvider: { 'zhipuai-coding-plan': { 'gpt-6-sol': { efforts: ['low'], source: 'models.dev:x' } } } }, config: {} })?.source, 'probe:gpt');

// —— ③ 兜底表：**默认开**（关掉只会让未实测的新模型落到 ④ 的 pattern 上被盲套档位）
eq('兜底默认开 → 命中交集估计', resolveEfforts({ modelId: 'grok-4.7', route: 'grok', baseURL: 'x', table: fake, config: {} })?.source, 'fallback:rules:intersection');
eq('显式关闭才不补', resolveEfforts({ modelId: 'grok-4.7', route: 'grok', baseURL: 'x', table: fake, config: { useFallbackTable: false } }), null);
eq('② 优先级压过 ③（有该家声明就不该用交集）', resolveEfforts({ modelId: 'glm-5.3-flash', route: 'company', baseURL: ZAI, table: fake, config: {} })?.source, 'models.dev:zhipuai-coding-plan');

// —— ④ pattern 兜底 + 前缀归一
const pat = resolveEfforts({ modelId: 'brand-new-model', route: 'nowhere', baseURL: 'x', table: fake, config: { modelPattern: '^brand-', efforts: { low: 'low', high: 'high' } } });
eq('pattern 兜底命中', pat?.efforts, ['low', 'high']);
eq('带前缀 id 归一', normModelId('z-ai/glm-5.3-flash:batch'), 'glm-5.3-flash');
eq('端点归一', normEndpoint(`${ZAI}/?a=b`), ZAI);

// —— 用户手写：既不补也不删
const sec = { providers: { company: { api: 'openai-completions', baseURL: ZAI, models: [
  { id: 'glm-5.3-flash', reasoningEfforts: { low: 'low', high: 'high' } },
  { id: 'glm-5.3-highspeed' },
  { id: 'gpt-image-2' },
] } } };
const { section, resolved, notes } = planEfforts(sec, {}, { table: fake });
eq('手写的模型不出现在写入里', resolved.map((r) => r.model), ['glm-5.3-highspeed']);
eq('手写档位一字未改', section.providers.company.models[0].reasoningEfforts, { low: 'low', high: 'high' });
ok('比声明更宽的档位只报告', notes.some((x) => x.model === 'glm-5.3-flash' && x.widerThanDeclared?.includes('max')));
eq('nonText 挡住 image', section.providers.company.models[2].reasoningEfforts, undefined);
ok('zai 线路给 compat 提示而不写 compat', notes.some((x) => x.compatHint) && section.providers.company.models[1].compat === undefined);

// —— 协议白名单：anthropic-messages 不在范围内
eq('anthropic-messages 不处理', planEfforts({ providers: { c: { api: 'anthropic-messages', models: [{ id: 'glm-5.3-highspeed' }] } } }, {}, { table: fake }).resolved, []);

// —— fixInvalid 已被移除：不得再有删档位的能力
const old = planEfforts(sec, { fixInvalid: true }, { table: fake });
eq('fixInvalid 已失效（不再剔除手写档位）', old.section.providers.company.models[0].reasoningEfforts, { low: 'low', high: 'high' });

console.log(`✅ selftest 全部通过（${n} 组断言，合成表）`);

// —— 真表对照：本机实测的线路隔离必须在产物里成立
if (REAL?.byRoute) {
  const sol = ['gpt', 'heihei'].map((r) => REAL.byRoute[r]?.['gpt-6-sol']?.efforts).filter(Boolean);
  assert.ok(sol.length === 2 && JSON.stringify(sol[0]) !== JSON.stringify(sol[1]), 'efforts.json 里 gpt-6-sol 应两条线路不同档');
  console.log(`   真表核对：gpt-6-sol → ${sol.map((s) => s.length + '档').join(' vs ')} ✓`);
} else {
  console.log('   （efforts.json 不存在或无 byRoute，跳过真表核对）');
}
