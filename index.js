// dsh-provider-auto（本地补丁版 v0.2.0-patch.1）
//
// 原版 v0.1.1 的行为：拿一条**出厂正则**去猜哪些模型支持思考档位，命中就补一套固定值。
//   modelPattern = /^(?:gpt-5(?:[.-]|$)|o\d(?:[.-]|$)|codex(?:[.-]|$))/i
//   efforts      = { off:null, low:'low', medium:'medium', high:'high' }
// 毛病：只认 gpt-5 一代，gpt-6.x / claude / glm / grok / deepseek 全漏 → 每次新增模型都要手写，
// 漏写就直接撞 `UNSUPPORTED_REASONING_EFFORT`（provider 级配了 reasoning 时，请求都发不出去）。
//
// patch.3 曾改成「只认模型 ID 的扁平表」，理由是同名模型跨线路档位不同、于是对同名取交集。
// 但交集必然砍掉某条线路的真档位（实测：gpt-6-sol 在 gpt 线 7 档被砍成 5 档、
// glm-5.3-flash 在 command 线 5 档被砍成 3 档），且表里的 135 个共有模型只有 51 个两源一致。
//
// v0.2.0：**键升级为 (线路, 模型 ID)**，借 dsh-models-dev 的 provider 分维思路，但按
// baseURL 反查而不是按 route 名字（名字匹配会把 models.dev 的 `zai`=Z.AI 开放平台错配到
// pi-ai 的 `zai` 路由=Coding Plan，钉错端点会全线 429）。查找顺序：
//   ① probe 实测 byRoute[route]        —— 线路精确，最权威
//   ② models.dev 单家 byProvider[...]  —— 按 baseURL 反查 endpointIndex，或 config.sources 手工绑
//   ③ 跨线路兜底 byModelId             —— **默认不写盘**（useFallbackTable 打开才用）
//   ④ config.modelPattern              —— 表全没有时的显式兜底
//   查不到就不补（宁缺勿错）。
//
// **用户手写的 reasoningEfforts 一律不动**（既不补也不删）：少给档位常常是有意的。
// 表比声明更宽时只写日志报告。曾有 fixInvalid 开关会剔除手写档位，与这条冲突，已整体移除。
// compat 也不自动写：pi-ai 缺省走 detectCompat，把 zai / api.x.ai / moonshot 等判成
// supportsReasoningEffort=false 是**刻意的**（上游不接受标准 reasoning_effort 字段），
// 强行写 true 会引入回归，这里只在命中这些线路时给出 compatHint。

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
  // 跨线路兜底表（byModelId）：**默认开**。它取的是同名模型在各线路上的交集，
  // 对没实测、又反查不到 models.dev 的杂牌线路，这是比 ④ 的 modelPattern 盲猜更准
  // 的公开估计。关掉它不会"更安全"，只会让新模型直接落到 pattern 上被套一套
  // 统一档位（profile 里那条 pattern 覆盖 gpt-/claude/grok/deepseek/kimi/gemini…，
  // 命中即给 low/medium/high/xhigh —— 与线路无关，正是本次改造要摆脱的行为）。
  // 无论开关如何：**用户已手写的 reasoningEfforts 一律不动**。
  useFallbackTable: true,
  // 已手写的 reasoningEfforts 一律不动（用户口径优先，"少给档位"常常是有意的）。
  // 此项只控制是否额外报告「表比声明更宽」，不改写任何值。
  advisory: true,
  // route → models.dev provider id 的手工映射，优先于按 baseURL 反查。
  sources: {},
};

/** `z-ai/glm-5.3-flash` / `openai/gpt-6.1-sol:batch` → `glm-5.3-flash` / `gpt-6.1-sol` */
export const normModelId = (id) =>
  String(id).replace(/:(batch|free|extended|thinking|nitro)$/i, '').split('/').pop().toLowerCase();

/** 端点归一：去 query、去尾斜杠、小写 —— 用于按 baseURL 反查 models.dev provider。 */
export const normEndpoint = (u) =>
  String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();

/**
 * pi-ai 的 detectCompat 里 `supportsReasoningEffort` 的**排除项**（逐字对齐
 * dist/api/openai-completions.js 的 detectCompat）：命中任一条，缺省就被判 false，
 * 即上游不接受标准 `reasoning_effort` 字段。这里只做提示，不据此改写配置。
 */
const EFFORT_REFUSING_PROVIDERS = new Set([
  'zai', 'zai-coding-cn', 'xai', 'moonshotai', 'moonshotai-cn', 'together',
  'nvidia', 'cloudflare-ai-gateway', 'ant-ling',
]);
const EFFORT_REFUSING_HOSTS = [
  'api.z.ai', 'open.bigmodel.cn', 'api.x.ai', 'api.moonshot.', 'api.together.ai',
  'api.together.xyz', 'integrate.api.nvidia.com', 'gateway.ai.cloudflare.com', 'api.ant-ling.com',
];
const compatWouldBeRefused = (route, baseURL) =>
  EFFORT_REFUSING_PROVIDERS.has(String(route)) ||
  EFFORT_REFUSING_HOSTS.some((h) => String(baseURL || '').includes(h));

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
 * 按 **(线路, 模型 ID)** 决定档位。三层，先命中先用：
 *
 *   ① byRoute[route]          本机实测 —— 线路精确，最权威
 *   ② byProvider[<models.dev 那一家>]  按 baseURL 反查 endpointIndex 得到；
 *      `sources[route]` 可手工覆盖。**取该家自己的声明，不取交集。**
 *   ③ byModelId               跨线路兜底 —— 默认只报告不写盘（useFallbackTable）
 *
 * 为什么 ② 不认 route 名字：`zai` 在 models.dev 是 Z.AI 开放平台、在 pi-ai 是
 * Coding Plan，按名字匹配会钉错端点致全线 429。一个端点反查出多个 provider 时
 * （endpointIndex 里值为 null）按未命中处理 —— 映射不确定就不猜。
 *
 * @returns {{efforts: string[], source: string}|null}
 */
export function resolveEfforts({ modelId, route, baseURL, config = {}, table }) {
  const id = String(modelId);
  const key = normModelId(id);
  if (config.useTable !== false) {
    // ① 本机实测：只认同一条线路
    const probed = route ? table?.byRoute?.[route]?.[key] : undefined;
    if (probed && Array.isArray(probed.efforts) && probed.efforts.length) {
      return { efforts: probed.efforts, source: 'probe:' + route };
    }
    // ② models.dev 分维：sources 手工映射优先，其次按 baseURL 反查
    const pid = config.sources?.[route] ?? (baseURL ? table?.endpointIndex?.[normEndpoint(baseURL)] : undefined);
    const perProvider = pid ? table?.byProvider?.[pid]?.[key] : undefined;
    if (perProvider && Array.isArray(perProvider.efforts) && perProvider.efforts.length) {
      return { efforts: perProvider.efforts, source: perProvider.source || `models.dev:${pid}` };
    }
    // ③ 兜底：跨线路表。**默认开**（与 useTable 同口径：只有显式 false 才关）。
    // 默认值写在 DEFAULTS 里不够 —— resolveEfforts 也会被单独调用（自检、脚本），
    // 那时 config 是空对象，用 `=== true` 判会得到与运行期相反的行为。
    if (config.useFallbackTable !== false) {
      const byId = table?.byModelId;
      const hit = byId?.[key] ?? byId?.[id.toLowerCase()];
      if (hit && Array.isArray(hit.efforts) && hit.efforts.length) {
        return { efforts: hit.efforts, source: 'fallback:' + (hit.source || '?') };
      }
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
  const notes = [];

  for (const [providerId, provider] of Object.entries(next.providers || {})) {
    if (!provider || !allowedApis.has(provider.api) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model || typeof model.id !== 'string') continue;
      if (nonText.test(model.id)) continue;
      // route 与 baseURL 必须传进来：① 实测层按线路查、② 分维层按 baseURL 反查
      // models.dev provider。少传一个，这两层就永远命不中（静默退化成只有兜底）。
      const hit = resolveEfforts({ modelId: model.id, route: providerId, baseURL: provider.baseURL, config: cfg, table });
      if (!hit) {
        if (model.reasoningEfforts === undefined && cfg.reportMisses !== false) {
          notes.push({ provider: providerId, model: model.id, missed: true });
        }
        continue;
      }
      const declared = model.reasoningEfforts;
      if (declared === undefined) {
        model.reasoningEfforts = asMap(hit.efforts);
        // 不自动写 compat —— 曾经写过，那是错的。
        // pi-ai 的门是 `options.reasoningEffort && compat.supportsReasoningEffort`，但缺省
        // 值走 detectCompat（`?? detected`）：按线路名/域名把 zai / zai-coding-cn /
        // api.x.ai / moonshot / together / nvidia / cloudflare-ai-gateway / ant-ling
        // 判成 **false 是刻意的** —— 上游不接受标准 `reasoning_effort` 字段。在这里
        // 强行写 true = 让请求带上会被拒的参数，是引入回归而不是修 bug。
        // 反过来，heihei / company / codexx 这类杂牌线路 detected 已经是 true，不写也能发。
        // ⇒ 自动补 compat 只在"该线路明确应发却被判否"时才成立，而插件没有可靠依据
        // 判定这件事，所以只做报告（见 notes 的 compatHint），由人决定。
        resolved.push({ provider: providerId, model: model.id, source: hit.source, efforts: hit.efforts, applied: true });
        if (cfg.advisory !== false && provider.api === 'openai-completions' && compatWouldBeRefused(providerId, provider.baseURL)) {
          notes.push({ provider: providerId, model: model.id, compatHint: 'pi-ai 的 detectCompat 会按线路名/域名把 supportsReasoningEffort 判为 false（上游不接受标准 reasoning_effort 字段）；本插件不自动写 compat，请核对该线路是否真需要 compat.supportsReasoningEffort: true 与对应 thinkingFormat' });
        }
      } else if (cfg.advisory !== false) {
        // 已声明 = **用户口径优先，一律不动**。少给档位常常是有意的（该线路不需要那几档、
        // 更贵、或上游静默忽略）。这里只报告「表比声明宽」供人工判断，不改任何值。
        // 曾有 fixInvalid 开关会剔除手写档位，与这条规则冲突，已整体移除。
        const extra = hit.efforts.filter((v) => !(v in declared));
        if (extra.length) {
          notes.push({ provider: providerId, model: model.id, source: hit.source, widerThanDeclared: extra, declared: Object.keys(declared) });
        }
      }
    }
  }
  return { section: next, resolved, notes };
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
      const { section, resolved, notes } = planEfforts(descriptor.user, cfg);
      // 只报告、不改写：已手写的档位永远是用户口径，比本机线路更宽的那些档位
      // 只在日志里出现，由人决定要不要补。missed 是「表里也没有」——提示去跑 probe。
      if (notes.length) {
        ctx.logger.info(
          'dsh-provider-auto: 仅供参考 %d 项 —— %s',
          notes.length,
          notes.map((n) => (n.missed ? `${n.provider}/${n.model}←表无数据` : `${n.provider}/${n.model} 可比声明多 ${n.widerThanDeclared.join('/')}`)).join('; '),
        );
      }
      if (!resolved.length) return;
      await ctx.settings.replace(NS, section, descriptor.revision);
      ctx.logger.info(
        'dsh-provider-auto: 补档位 %d 个 —— %s',
        resolved.length,
        resolved.map((r) => `${r.provider}/${r.model}←${r.source}`).join(', '),
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
