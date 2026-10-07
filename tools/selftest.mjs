#!/usr/bin/env node
/**
 * selftest.mjs —— 离线自检：不联网、不写盘，只验证「模型 ID → 档位」的匹配决策。
 * 核心口径：**只看模型 ID**。同一 ID 出现在哪个 provider 下，拿到的是同一套档位。
 * 用法: node tools/selftest.mjs
 */
import assert from 'node:assert/strict';
import { planEfforts, resolveEfforts, normModelId } from '../index.js';

const section = {
  providers: {
    // 同一个 glm-5.3-flash 故意放在三个不同 provider 下
    gpt: { api: 'openai-completions', models: [{ id: 'glm-5.3-flash' }, { id: 'gpt-6-sol' }, { id: 'gpt-image-2' }] },
    command: { api: 'openai-completions', models: [{ id: 'z-ai/glm-5.3-flash' }, { id: 'moonshotai/Kimi-K3' }] },
    'zai-coding-cn': { api: 'openai-completions', models: [{ id: 'glm-5.3-flash' }] },
    heihei: { api: 'openai-completions', models: [{ id: 'gpt-6-sol' }] },
    grok: { api: 'openai-completions', models: [{ id: 'grok-4.7' }, { id: 'grok-never-heard-of-it' }] },
    claude: { api: 'anthropic-messages', models: [{ id: 'claude-opus-5-5' }] },
    // 手写声明：任何情况下都不许被覆盖
    gpt2: { api: 'openai-completions', models: [{ id: 'gpt-6.1-sol', reasoningEfforts: { low: 'low' } }] },
  },
};

const cfg = { modelPattern: '^(?:gpt-|glm|grok)', efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } };
const { section: out, resolved } = planEfforts(section, cfg);
console.log('按模型 ID 的补档位决策：');
for (const r of resolved) console.log(`  ${r.provider.padEnd(14)} ${r.model.padEnd(26)} ${r.source.padEnd(22)} ${r.efforts.join('/')}`);

const keys = (p, m) => Object.keys(out.providers[p].models.find((x) => x.id === m).reasoningEfforts || {});

const GLM = ['low', 'high', 'max'];
const SOL6 = ['low', 'medium', 'high', 'xhigh', 'max'];

// —— 核心：同一个模型 ID，在哪个 provider 下都拿到同一套档位
assert.deepEqual(keys('gpt', 'glm-5.3-flash'), GLM, 'glm-5.3-flash');
assert.deepEqual(keys('zai-coding-cn', 'glm-5.3-flash'), GLM, '同位同名必须同档位');
assert.deepEqual(keys('command', 'z-ai/glm-5.3-flash'), GLM, '带 provider 前缀的 id 归一化后命中同一条');
assert.deepEqual(keys('gpt', 'gpt-6-sol'), SOL6);
assert.deepEqual(keys('heihei', 'gpt-6-sol'), SOL6, '同位同名必须同档位');

// —— provider 完全不参与匹配：把同一个模型换个不存在的 provider 也一样
const solo = planEfforts({ providers: { anywhere: { api: 'openai-completions', models: [{ id: 'gpt-6.1-sol' }] } } });
assert.deepEqual(Object.keys(solo.section.providers.anywhere.models[0].reasoningEfforts),
  ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '换到任意 provider 都要命中');

// —— 公开库兜底
assert.deepEqual(keys('grok', 'grok-4.7'), ['low', 'medium', 'high', 'xhigh']);
assert.ok(resolved.find((r) => r.model === 'grok-4.7').source.startsWith('table:rules:'), '走公开库兜底');

// —— 表里没有 → 退 pattern 兜底；再没有 → 不补
assert.deepEqual(keys('grok', 'grok-never-heard-of-it'), ['low', 'medium', 'high', 'xhigh']);
const noPattern = planEfforts(section, {});
assert.equal(noPattern.section.providers.grok.models.find((m) => m.id === 'grok-never-heard-of-it').reasoningEfforts, undefined, '无 pattern 时不补');

// —— 边界
assert.equal(out.providers.gpt.models.find((m) => m.id === 'gpt-image-2').reasoningEfforts, undefined, 'nonText 必须挡住 image');
assert.deepEqual(out.providers.gpt2.models[0].reasoningEfforts, { low: 'low' }, '手写声明不得被覆盖');
assert.equal(out.providers.claude.models[0].reasoningEfforts, undefined, 'anthropic-messages 不在白名单');
assert.equal(normModelId('z-ai/glm-5.3-flash:batch'), 'glm-5.3-flash');
assert.equal(normModelId('moonshotai/Kimi-K3'), 'kimi-k3');
assert.equal(resolveEfforts({ modelId: 'x', config: {}, table: { byModelId: {} } }), null);

// —— fixInvalid 打开时只剔除表里没有的档位
const bad = planEfforts(
  { providers: { p: { api: 'openai-completions', models: [{ id: 'glm-5.3-flash', reasoningEfforts: { low: 'low', medium: 'medium', xhigh: 'xhigh' } }] } } },
  { fixInvalid: true },
);
assert.deepEqual(Object.keys(bad.section.providers.p.models[0].reasoningEfforts), ['low'], 'fixInvalid 剔除 medium/xhigh');

console.log('\n✅ selftest 全部通过（16 组断言）');
