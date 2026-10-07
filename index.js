// dsh-provider-auto（本地补丁版 v0.1.1-patch.3）
//
// 原版 v0.1.1 的行为：拿一条**出厂正则**去猜哪些模型支持思考档位，命中就补一套固定值。
//   modelPattern = /^(?:gpt-5(?:[.-]|$)|o\d(?:[.-]|$)|codex(?:[.-]|$))/i
//   efforts      = { off:null, low:'low', medium:'medium', high:'high' }
// 毛病：只认 gpt-5 一代，gpt-6.x / claude / glm / grok / deepseek 全漏 → 每次新增模型都要手写，
// 漏写就直接撞 `UNSUPPORTED_REASONING_EFFORT`（provider 级配了 reasoning 时，请求都发不出去）。
//
// 本补丁版：**只认模型 ID 的一张扁平表**（efforts.json），不看中转来源。
//   表由 tools/build-efforts-table.mjs 生成，两个来源合并：
//     · probe-overrides.json —— 打到本机各 provider 上的实测（tools/probe-efforts.mjs 生成）
//     · rules.json           —— OpenRouter ∩ models.dev 的公开库兜底
//   同名模型在不同线路上档位可能不同（实测：glm-5.3-flash 智谱官方 low/high/max、
//   commandcode 给 5 档），合并时**同名取交集** —— 交集对每条线路都合法。
//   查不到就退回 config.modelPattern + efforts，再查不到就不补（宁缺勿错）。
// 手写过的 reasoningEfforts 一律不覆盖（可选 fixInvalid:true 剔除表里没有的档位）。

import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-provider-auto';

const NS = 'llm-pi-ai';
const HERE = path.dirname(new URL(import.meta.url).pathname);

const DEFAULTS = {
  api: ['openai-completions', 'openai-responses'],
  nonTextPattern: '(?:image|dall-e|tts|whisper|audio|embedding|moderation|rerank)',
  useTable: true,
  tableFile: 'efforts.json',
  modelPattern: null,
  efforts: null,
  fixInvalid: false,
};

/** `z-ai/glm-5.3-flash` / `openai/gpt-6.1-sol:batch` → `glm-5.3-flash` / `gpt-6.1-sol` */
export const normModelId = (id) =>
  String(id).replace(/:(batch|free|extended|thinking|nitro)$/i, '').split('/').pop().toLowerCase();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(HERE, file), 'utf8'));
  } catch {
    return null;
  }
}

function asMap(efforts) {
  if (!Array.isArray(efforts) || !efforts.length) return null;
  const out = {};
  for (const v of efforts) out[String(v)] = String(v);
  return out;
}

/**
 * 只按**模型 ID** 决定档位。中转/ provider 不参与匹配。
 * @returns {{efforts: string[], source: string}|null}
 */
export function resolveEfforts({ modelId, config = {}, table }) {
  const id = String(modelId);
  if (config.useTable !== false) {
    const byId = table?.byModelId;
    const hit = byId?.[normModelId(id)] ?? byId?.[id.toLowerCase()];
    if (hit && Array.isArray(hit.efforts) && hit.efforts.length) {
      return { efforts: hit.efforts, source: 'table:' + (hit.source || '?') };
    }
  }
  if (config.modelPattern) {
    let re = null;
    try { re = new RegExp(config.modelPattern, 'i'); } catch { re = null; }
    if (re && re.test(id)) {
      const values = Object.values(config.efforts || {}).filter((v) => typeof v === 'string');
      if (values.length) return { efforts: values, source: 'fallback(pattern)' };
    }
  }
  return null;
}

/**
 * 纯函数：算出"该补什么"。不碰 ctx、不写盘，便于离线测试。
 * @returns {{section: object, resolved: Array}}
 */
export function planEfforts(section, config = {}, deps = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const table = deps.table !== undefined ? deps.table : readJson(cfg.tableFile);
  const allowedApis = new Set(cfg.api ?? DEFAULTS.api);
  const nonText = new RegExp(cfg.nonTextPattern ?? DEFAULTS.nonTextPattern, 'i');
  const next = structuredClone(section);
  const resolved = [];

  for (const [providerId, provider] of Object.entries(next.providers || {})) {
    if (!provider || !allowedApis.has(provider.api) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model || typeof model.id !== 'string') continue;
      if (nonText.test(model.id)) continue;
      const hit = resolveEfforts({ modelId: model.id, config: cfg, table });
      if (!hit) continue;
      const declared = model.reasoningEfforts;
      if (declared === undefined) {
        model.reasoningEfforts = asMap(hit.efforts);
        resolved.push({ provider: providerId, model: model.id, source: hit.source, efforts: hit.efforts, applied: true });
      } else if (cfg.fixInvalid === true) {
        const removed = Object.keys(declared).filter((k) => !hit.efforts.includes(k));
        if (removed.length) {
          const kept = {};
          for (const k of Object.keys(declared)) if (hit.efforts.includes(k)) kept[k] = declared[k];
          model.reasoningEfforts = kept;
          resolved.push({ provider: providerId, model: model.id, source: hit.source, efforts: hit.efforts, applied: true, removed });
        }
      }
    }
  }
  return { section: next, resolved };
}

/** 兼容原版签名：只返回 section。 */
export function addReasoningEfforts(section, config = {}, deps = {}) {
  return planEfforts(section, config, deps).section;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  let syncing = false;

  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const descriptor = ctx.settings.describe().find(({ ns }) => ns === NS);
      if (!descriptor?.user) return;
      const { section, resolved } = planEfforts(descriptor.user, cfg);
      if (!resolved.length) return;
      await ctx.settings.replace(NS, section, descriptor.revision);
      ctx.logger.info(
        'dsh-provider-auto: 按模型 ID 补档位 %d 个 —— %s',
        resolved.length,
        resolved.map((r) => `${r.model}←${r.source}`).join(', '),
      );
    } catch (error) {
      // 任何失败只降级为日志。cordis 4 的 host 对 entry 构造期同步抛出按致命处理，
      // 整个组合直接退出；本插件绝不允许把宿主带崩。
      ctx.logger.warn('dsh-provider-auto: 同步 reasoningEfforts 失败: %s', error instanceof Error ? error.message : String(error));
    } finally {
      syncing = false;
    }
  };

  void sync();
  // 0.2.0 的 settings 服务只发 `settings/document-updated`（ns, revision），
  // 没有 `settings/updated`。emit 未带 thisArg 时事件全局广播，本地监听即可收到。
  ctx.on('settings/document-updated', (ns) => {
    if (ns === NS) void sync();
  });
  // 兜底：entry 激活顺序不保证 llm-pi-ai 先于本 entry 就位（describe 只列已激活 entry）。
  const retry = setTimeout(() => { void sync(); }, 5000);
  ctx.effect(() => () => clearTimeout(retry));
}

// settings 是 cordis 服务，不声明 inject 的话 ctx 严格代理直接抛
// `cannot get property "settings" without inject`；声明后插件会等它就位再启动。
// 注意必须导出模块级 inject：loader 把模块命名空间整个传给 registry，
// inject/Config 读的是命名空间导出而非 apply 函数的静态属性。
export const inject = ['settings'];
apply.inject = inject;
