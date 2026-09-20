/**
 * dsh-tier-router client bundle: the "Tier Router" settings section.
 *
 * Hand-written `window.__ModuleLoader__` bundle (no build step): registers a
 * `settings.section` slot whose page reads the live model catalog and the
 * resolved configuration from the host (`/tier-router/api/*`) and writes
 * changes back through the same API. The host-side settings service is used
 * directly instead of the client settings wire, because the host only
 * exposes allow-listed namespaces to configuration clients.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tier-router',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const {
      createElement: h,
      Fragment,
      useEffect,
      useMemo,
      useState,
    } = react

    const NS = 'dsh-tier-router'
    const TIERS = [
      { key: 'hard', labelKey: 'tier.hard', hintKey: 'tier.hard.hint' },
      { key: 'normal', labelKey: 'tier.normal', hintKey: 'tier.normal.hint' },
      { key: 'easy', labelKey: 'tier.easy', hintKey: 'tier.easy.hint' },
    ]
    const VISION = { key: 'vision', labelKey: 'tier.vision', hintKey: 'tier.vision.hint' }

    // ---------- locale ----------
    const zh = {
      nav: '智能路由',
      intro:
        '把虚拟模型「Tier Router (auto)」选为会话模型后，每次请求都会自动分类：' +
        '图片/截图 → 视觉档；其余按难度 → 困难/一般/简单档。各档模型从「设置 → 模型」已配置的模型中选取。',
      sameVendor:
        '提示：建议三个难度档选择同一供应商的同一系列模型（如同一家的 pro/flash 版），' +
        '前缀缓存命中率更高、成本更低。',
      enable: '启用路由',
      'enable.hint': '关闭后请求直接走默认模型（会话当前模型）。',
      classifier: '分类方式',
      'classifier.heuristic': '启发式（零成本，默认）',
      'classifier.llm': 'LLM 分类（结合任务上下文）',
      'classifier.hint': '启发式为默认：零成本、结果确定。LLM 分类会结合任务与最近步骤上下文判断，'
        + '代价是每次分类多一次模型调用。',
      hardScore: '困难阈值',
      'hardScore.hint': '启发式得分达到此值即判「困难」。实测本机 213 条真实请求中 79% 恰好得 0 分，'
        + '2/3/4/5 效果因此相同：默认 3 几乎不判困难，改成 1 会把有正向信号的请求（约 12 条）判为困难。'
        + '仅对启发式生效。得分本身无法区分困难与一般，调到能用的档位不等于判得准。',
      'section.basic': '基本',
      'section.vision': '视觉',
      'section.status': '运行状态',
      'section.decisions': '最近路由决策',
      'stats.requests': '按请求',
      'classifier.selected': '当前：',
      'section.tiers': '各档模型',
      'section.fallback': '默认回退',
      'fallback.hint': '留空 = 使用会话当前默认模型。档位缺失时按 困难→一般→简单→默认 回退。',
      'section.llm': 'LLM 分类器（可选）',
      'llm.hint': '留空 = 复用「简单任务」档模型。',
      'tier.hard': '困难任务',
      'tier.hard.hint': '架构设计、跨文件重构、疑难 bug 根因、性能/安全专项',
      'tier.normal': '一般任务',
      'tier.normal.hint': '单文件改动、常规功能实现、写测试、普通调试',
      'tier.easy': '简单任务',
      'tier.easy.hint': '闲聊、确认、收尾、简短翻译/解释、读单文件',
      'tier.vision': '视觉任务',
      'tier.vision.hint': '图片/截图/OCR 等含图请求自动走此档',
      provider: '提供方',
      model: '模型',
      effort: '思考档位',
      'effort.hint':
        '对话框模型选择器上的思考强度（Off / High）是总开关：' +
        '选择 Off 则所有难度等级都不使用思考模式；' +
        '选择 High 则各难度等级使用上方配置的推理强度。',
      reset: '重置',
      'reset.all': '恢复默认设置',
      'vision.ok': '支持图片',
      'vision.unknown': '能力未知',
      'vision.novision': '不支持图片',
      'vision.rowHint': '视觉模型只做辅助：图片会先交给它返回结构化证据（摘要/OCR/版面），' +
        '替换回文本后再由三级难度模型作答。',
      'vision.mode': '视觉处理方式',
      'vision.mode.replace': '结构化替换（默认）',
      'vision.mode.route': '整段路由到视觉模型',
      'vision.mode.hint': '「结构化替换」：图块 → 视觉模型结构化证据 → 替换为文本 → 难度分类；' +
        '「整段路由」：带图请求整体交给视觉模型（旧行为）。',
      inactive: '未激活',
      'stats.hard': '困难',
      'stats.normal': '一般',
      'stats.easy': '简单',
      'stats.vision': '视觉档',
      'stats.visionBridge': '视觉分析',
      'stats.fallback': '回退接管',
      'stats.error': '未恢复错误',
      'stats.routeError': '路由失败(已回退)',
      'stats.turns': '按回合',
      'stats.turnsTotal': '回合合计',
      decisions: '最近路由决策（每次请求选了哪个模型）',
      'decisions.failed': '全部失败',
      'decisions.tried': '先试过',
      'decisions.overhead': '路由耗时',
      'decisions.classify': '其中分类',
      'decisions.skipped': '跳过（上下文不够）',
      'decisions.cause': '判据',
      'decisions.by': '由',
      'decisions.turn': '新回合',
      'decisions.continuation': '同回合续跑',
      'benched.title': '已停用路由（判定为当前不可用）',
      'benched.retryIn': '后重试',
      contextGuard: '上下文感知（跳过装不下的模型）',
      'contextGuard.hint': '开启后，若某档位模型的上下文窗口小于本次请求的估算长度，会跳过它并改用装得下的档位；'
        + '窗口未知的模型不会被跳过。估算按 CJK 1 字≈1 token、其它 3.5 字符≈1 token，并预留 10% 余量。',
      'decisions.empty': '还没有请求经过路由器',
      defaultModel: '当前默认模型',
      empty: '（未配置）',
      loading: '加载中…',
      loadError: '加载失败',
      saveError: '保存失败',
      saving: '保存中…',
      readOnly: 'Settings are read-only; changes cannot be saved',
    }
    const en = {
      nav: 'Tier Router',
      intro:
        'Pick the virtual model "Tier Router (auto route)" as your session model: ' +
        'every request is classified automatically — images/screenshots go to the vision tier, ' +
        'everything else is routed by difficulty (hard / normal / easy). Tier models are picked ' +
        'from the models you already configured under Settings → Models.',
      sameVendor:
        'Tip: pick hard/normal/easy models from the same vendor family (e.g. pro and flash ' +
        'editions of one series) to maximize prefix-cache hit rates and lower cost.',
      enable: 'Enable routing',
      'enable.hint': 'When off, requests go to the session default model unchanged.',
      classifier: 'Classifier',
      'classifier.heuristic': 'Heuristic (zero cost, default)',
      'classifier.llm': 'LLM classifier (task and step context)',
      'classifier.hint': 'Heuristic is the default: zero cost and deterministic. The LLM classifier also '
        + 'weighs the task and recent steps, at the price of one extra model call per classification.',
      hardScore: 'Hard threshold',
      'hardScore.hint': 'A heuristic score at or above this is classified hard. Measured on 213 real '
        + 'requests from this machine, 79% scored exactly 0, so 2/3/4/5 behave identically: 3 (default) '
        + 'almost never says hard, while 1 promotes the ~12 requests carrying any positive signal. '
        + 'Applies to the heuristic only. The score does not separate hard from normal, so picking a '
        + 'usable setting is not the same as classifying well.',
      'section.basic': 'Basics',
      'section.vision': 'Vision',
      'section.status': 'Status',
      'section.decisions': 'Recent routing decisions',
      'stats.requests': 'per request',
      'classifier.selected': 'Active:',
      'section.tiers': 'Tier models',
      'section.fallback': 'Default fallback',
      'fallback.hint': 'Empty = the session default model. Missing tiers fall back hard → normal → easy → default.',
      'section.llm': 'LLM classifier (optional)',
      'llm.hint': 'Empty = reuse the easy-tier model.',
      'tier.hard': 'Hard tasks',
      'tier.hard.hint': 'Architecture, cross-file refactoring, tricky root-cause analysis, performance/security',
      'tier.normal': 'Normal tasks',
      'tier.normal.hint': 'Single-file changes, small features, writing tests, routine debugging',
      'tier.easy': 'Easy tasks',
      'tier.easy.hint': 'Small talk, confirmations, wrap-ups, short translation/explanation, reading one file',
      'tier.vision': 'Vision tasks',
      'tier.vision.hint': 'Requests with images (screenshots, OCR, …) go here automatically',
      provider: 'Provider',
      model: 'Model',
      effort: 'Effort',
      'effort.hint':
        'The reasoning effort in the chat input model selector (Off / High) is the master switch: ' +
        'Off disables reasoning for all tiers; ' +
        'High lets each tier use the effort configured above.',
      reset: 'Reset',
      'reset.all': 'Restore defaults',
      'vision.ok': 'Vision',
      'vision.unknown': 'Capability unknown',
      'vision.novision': 'No image input',
      'vision.rowHint':
        'The vision model is only an assistant: images are analyzed into structured evidence ' +
        '(summary/OCR/layout) which replaces the image block as text, then the difficulty tiers answer.',
      'vision.mode': 'Vision handling',
      'vision.mode.replace': 'Structured replace (default)',
      'vision.mode.route': 'Route whole turn to vision model',
      'vision.mode.hint': '"Structured replace": image → structured evidence from the vision model → ' +
        'replaced by text → difficulty classification. "Route": image requests go to the vision tier whole (legacy).',
      inactive: 'inactive',
      'stats.hard': 'Hard',
      'stats.normal': 'Normal',
      'stats.easy': 'Easy',
      'stats.vision': 'Vision tier',
      'stats.visionBridge': 'Vision analyses',
      'stats.fallback': 'Fallbacks',
      'stats.error': 'Unrecovered errors',
      'stats.routeError': 'Route failures (recovered)',
      'stats.turns': 'Per turn',
      'stats.turnsTotal': 'turns',
      decisions: 'Recent routing decisions (which model handled each request)',
      'decisions.failed': 'all routes failed',
      'decisions.tried': 'tried',
      'decisions.overhead': 'routing',
      'decisions.classify': 'classify',
      'decisions.skipped': 'skipped (window too small)',
      'decisions.cause': 'why',
      'decisions.by': 'by',
      'decisions.turn': 'new turn',
      'decisions.continuation': 'same turn',
      'benched.title': 'Benched routes (judged unavailable)',
      'benched.retryIn': 'retry in',
      contextGuard: 'Context-aware routing (skip models that cannot hold the request)',
      'contextGuard.hint': 'When on, a tier whose model context window is smaller than the estimated request '
        + 'length is skipped in favour of a tier that fits. Models with an unknown window are never skipped. '
        + 'The estimate counts CJK as ~1 token/char and other text as ~3.5 chars/token, with 10% headroom.',
      'decisions.empty': 'No request has gone through the router yet',
      defaultModel: 'Current default model',
      empty: '(not set)',
      loading: 'Loading…',
      loadError: 'Load failed',
      saveError: 'Save failed',
      saving: 'Saving…',
      readOnly: 'Settings are read-only; changes cannot be saved',
    }

    // ---------- minimal dark-friendly styling (alpha-based, theme-agnostic) ----------
    const S = {
      card: {
        border: '1px solid rgba(128,128,128,.3)',
        borderRadius: 8,
        padding: '10px 12px',
        margin: '10px 0',
        background: 'rgba(128,128,128,.07)',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        margin: '8px 0',
      },
      label: {
        minWidth: 96,
        fontWeight: 600,
        fontSize: 13,
      },
      hint: {
        fontSize: 12,
        opacity: 0.65,
        margin: '4px 0',
        lineHeight: 1.5,
      },
      select: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid rgba(128,128,128,.4)',
        borderRadius: 6,
        padding: '4px 6px',
        fontSize: 13,
        maxWidth: 220,
      },
      badge: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,.4)',
        marginLeft: 6,
        whiteSpace: 'nowrap',
      },
      badgeGreen: {
        border: '1px solid rgba(64,200,120,.6)',
        color: 'rgba(64,200,120,1)',
      },
      badgeYellow: {
        border: '1px solid rgba(220,180,60,.6)',
        color: 'rgba(220,180,60,1)',
      },
      button: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid rgba(128,128,128,.4)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      title: { fontSize: 13, fontWeight: 700, margin: '14px 0 2px' },
      stat: { fontSize: 12, opacity: 0.75, marginRight: 10 },
      switchRow: { display: 'flex', alignItems: 'center', gap: 8 },
      // One cell per counter: eight counters read as a status row instead of a
      // run-on line of labels and numbers.
      statGrid: { display: 'flex', flexWrap: 'wrap', gap: 20, margin: '2px 0 8px' },
      statValue: { fontSize: 18, fontWeight: 700, lineHeight: 1.2 },
      statLabel: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      // A decision is a headline plus a muted explanation, so the list scans by
      // model and tier while the reasoning stays available underneath.
      decision: { padding: '7px 0', borderTop: '1px solid rgba(128,128,128,.16)' },
      decisionHead: { fontSize: 12.5, fontWeight: 600 },
      decisionWhy: { fontSize: 11.5, opacity: 0.6, marginTop: 3, lineHeight: 1.45 },
    }

    // ---------- helpers ----------
    const fieldPath = (tierKey, field) => `${tierKey}${field[0].toUpperCase()}${field.slice(1)}`
    const tierValue = (snapshot, tierKey) => ({
      provider: String(snapshot?.[fieldPath(tierKey, 'provider')] ?? ''),
      model: String(snapshot?.[fieldPath(tierKey, 'model')] ?? ''),
      effort: String(snapshot?.[fieldPath(tierKey, 'effort')] ?? ''),
    })
    const labelOf = (groups, provider) => {
      const group = groups.find((g) => g.id === provider)
      return group !== undefined ? group.name : provider
    }
    /** Provider groups the pickers may offer (never the router itself). */
    const pickableGroups = (groups) => (groups ?? []).filter((g) => g.id !== 'tier-router')
    /** ISO decision timestamp → local wall clock, for the decision list. */
    const clockOf = (iso) => {
      const at = new Date(iso)
      return Number.isNaN(at.getTime()) ? '--:--:--' : at.toLocaleTimeString()
    }
    /**
     * One status counter: the number over its label. A row of these reads as a
     * dashboard, where the same eight values inline read as a log line.
     */
    const statCell = (label, value) => h('div', { style: { minWidth: 46 } },
      h('div', { style: S.statValue }, String(value ?? 0)),
      h('div', { style: S.statLabel }, label),
    )
    /**
     * Clear the model field when the new provider no longer lists the current
     * model (or the provider was cleared), so the UI never shows a provider
     * "not set" next to a stale model name.
     */
    const syncModel = (groups, provider, currentModel, onClear) => {
      if (currentModel === '') return
      const group = groups.find((g) => g.id === provider)
      const stillValid = provider !== '' &&
        (group?.models ?? []).some((m) => m.id === currentModel)
      if (!stillValid) onClear()
    }

    function Option({ value, label }) {
      // Native dropdown lists do not reliably follow `color-scheme` inside
      // this page (dark theme still rendered a white list with light text).
      // Pin option colors explicitly so every option stays readable on any
      // theme: white list, dark text, dark hover highlight.
      return h('option', {
        value,
        style: { color: '#1b1b1f', background: '#ffffff' },
      }, label)
    }

    /** Provider + model + effort selects for one tier row. */
    function RouteRow({ t, tier, value, catalog, onChange, visionOnly, colorScheme, disabled }) {
      const groups = pickableGroups(catalog.groups)
      const providerOptions = useMemo(() => {
        const list = groups
          .map((g) => ({ id: g.id, name: g.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
        if (value.provider !== '' && !list.some((p) => p.id === value.provider)) {
          list.push({ id: value.provider, name: `${value.provider} (${t('inactive')})` })
        }
        return list
      }, [groups, value.provider, t])

      const chosen = groups.find((g) => g.id === value.provider)
      const modelOptions = useMemo(() => {
        const models = chosen !== undefined ? (chosen.models ?? []) : []
        // Carry the context window through so the option label can show it —
        // this is what makes "will this tier actually fit my session?" visible
        // before a request fails.
        const list = models
          .filter((m) => !visionOnly || m.vision !== false)
          .map((m) => ({
            id: m.id,
            name: m.name,
            vision: m.vision,
            contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : undefined,
          }))
        // Only keep a stored model id that is not in the catalog when the
        // provider is actually set; with no provider the model select shows
        // "not set" instead of a stale model name. A vision row must never
        // surface a model that explicitly rejects image input.
        if (value.provider !== '' && value.model !== '' && !list.some((m) => m.id === value.model)) {
          const known = models.find((m) => m.id === value.model)
          if (!visionOnly || known?.vision !== false) {
            list.push({ id: value.model, name: value.model, vision: null })
          }
        }
        return list
      }, [chosen, value.provider, value.model, visionOnly])

      const chosenModel = modelOptions.find((m) => m.id === value.model)
      const effortOptions = useMemo(() => {
        const efforts = chosen !== undefined
          ? chosen.models?.find((m) => m.id === value.model)?.reasoningEfforts
          : undefined
        return Array.isArray(efforts) ? efforts : []
      }, [chosen, value.model])

      const selectStyle = { ...S.select, colorScheme }
      const visionBadge = (m) => {
        if (m === undefined) return null
        if (m.vision === true) {
          return h('span', { style: { ...S.badge, ...S.badgeGreen } }, `✓ ${t('vision.ok')}`)
        }
        if (m.vision === null) return h('span', { style: { ...S.badge, ...S.badgeYellow } }, t('vision.unknown'))
        return h('span', { style: { ...S.badge } }, t('vision.novision'))
      }

      return h('div', { style: { margin: '8px 0' } },
        h('div', { style: S.row },
          h('div', { style: { ...S.label, minWidth: 72 } }, t(tier.labelKey)),
          h('select', {
            style: selectStyle,
            value: value.provider,
            disabled,
            onChange: (e) => {
              const next = e.target.value
              onChange('provider', next)
              // Keep model/effort only when the chosen provider still lists
              // the current model; otherwise reset them to "not set" so a
              // provider/model pair never shows a stale combination.
              const group = groups.find((g) => g.id === next)
              const stillValid = next !== '' &&
                value.model !== '' &&
                (group?.models ?? []).some((m) => m.id === value.model)
              if (!stillValid) {
                if (value.model !== '') onChange('model', '')
                if (value.effort !== '') onChange('effort', '')
              }
            },
          },
            h(Option, { value: '', label: t('empty') }),
            providerOptions.map((p) => h(Option, { key: p.id, value: p.id, label: p.name })),
          ),
          h('select', {
            style: { ...selectStyle, maxWidth: 260 },
            value: value.provider === '' ? '' : value.model,
            disabled: disabled || value.provider === '',
            onChange: (e) => onChange('model', e.target.value),
          },
            h(Option, { value: '', label: t('empty') }),
            modelOptions.map((m) => h(Option, {
              key: m.id,
              value: m.id,
              label: m.contextWindow === undefined
                ? m.name
                : `${m.name} · ${Math.round(m.contextWindow / 1000)}k ctx`,
            })),
          ),
          visionBadge(chosenModel),
          effortOptions.length > 0
            ? h('select', {
                style: { ...selectStyle, maxWidth: 120 },
                value: value.effort,
                disabled: disabled || value.model === '',
                onChange: (e) => onChange('effort', e.target.value),
              },
                h(Option, { value: '', label: `${t('effort')}: ${t('empty')}` }),
                effortOptions.map((e) => h(Option, { key: e.id, value: e.id, label: String(e.name ?? e.id) })),
              )
            : null,
          h('button', {
            style: S.button,
            disabled,
            onClick: () => {
              onChange('provider', '')
              onChange('model', '')
              onChange('effort', '')
            },
          }, t('reset')),
        ),
        tier.hintKey !== undefined
          ? h('div', { style: { ...S.hint, marginLeft: 80 } }, t(tier.hintKey))
          : null,
      )
    }

    /** The settings section body; all data flows through the host API. */
    function SmartRouterSection({ t, colorScheme }) {
      const [config, setConfig] = useState(null)
      const [writable, setWritable] = useState(true)
      const [catalog, setCatalog] = useState({ groups: [], failures: [], defaultModel: null })
      const [catalogError, setCatalogError] = useState(false)
      const [stats, setStats] = useState(null)
      const [saving, setSaving] = useState(false)
      const [saveFailed, setSaveFailed] = useState(false)
      /** Newest-last decision ring from the host; rendered newest-first. */
      const decisions = (Array.isArray(stats?.decisions) ? stats.decisions : []).map((d) => ({
        at: String(d?.at ?? ''),
        outcome: d?.outcome === 'failed' ? 'failed' : 'ok',
        provider: String(d?.provider ?? ''),
        model: String(d?.model ?? ''),
        effort: String(d?.effort ?? ''),
        level: String(d?.level ?? ''),
        reason: String(d?.reason ?? ''),
        tried: Array.isArray(d?.tried) ? d.tried : [],
        skipped: Array.isArray(d?.skipped) ? d.skipped : [],
        estimate: Number.isFinite(d?.estimate) ? d.estimate : 0,
        // Why this level was decided, and by which classifier. Absent on a
        // server older than 0.2.2 — degrade to empty strings, never throw.
        cause: String(d?.cause ?? ''),
        classifier: String(d?.classifier ?? ''),
        turn: d?.turn === true,
        // Routing overhead: everything spent before the chosen model was
        // called. The number to look at when routing "feels slow".
        overheadMs: Number.isFinite(d?.timings?.overheadMs) ? d.timings.overheadMs : 0,
        classifyMs: Number.isFinite(d?.timings?.classifyMs) ? d.timings.classifyMs : 0,
      }))

      const loadConfig = async () => {
        try {
          const res = await fetch('/tier-router/api/config')
          if (!res.ok) throw new Error(String(res.status))
          const data = await res.json()
          setConfig(data.config ?? data.defaults ?? {})
          setWritable(data.writable !== false)
        } catch { /* keep last config */ }
      }

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch('/tier-router/api/models')
            if (!res.ok) throw new Error(String(res.status))
            const data = await res.json()
            if (alive) {
              setCatalog(data)
              setCatalogError(false)
            }
          } catch {
            if (alive) setCatalogError(true)
          }
          try {
            const res = await fetch('/tier-router/api/stats')
            if (res.ok) {
              const data = await res.json()
              if (alive) setStats(data.stats ?? null)
            }
          } catch { /* stats are optional */ }
        }
        void loadConfig()
        void load()
        const timer = setInterval(() => {
          void (async () => {
            try {
              const res = await fetch('/tier-router/api/stats')
              if (res.ok) {
                const data = await res.json()
                if (alive) setStats(data.stats ?? null)
              }
            } catch { /* ignore */ }
          })()
        }, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const write = async (field, fieldValue) => {
        if (!writable) return
        setSaving(true)
        setSaveFailed(false)
        try {
          const res = await fetch('/tier-router/api/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ field, value: fieldValue === '' ? null : fieldValue }),
          })
          const data = await res.json()
          if (!res.ok || data.ok !== true) {
            setSaveFailed(true)
            return
          }
          if (data.config !== undefined && data.config !== null) setConfig(data.config)
        } catch {
          setSaveFailed(true)
        } finally {
          setSaving(false)
        }
      }
      const tierOnChange = (tierKey) => (field, fieldValue) => {
        void write(fieldPath(tierKey, field), fieldValue)
      }

      const value = config ?? {}
      const fallbackValue = {
        provider: String(value.fallbackProvider ?? ''),
        model: String(value.fallbackModel ?? ''),
      }
      const llmValue = {
        provider: String(value.llmClassifierProvider ?? ''),
        model: String(value.llmClassifierModel ?? ''),
      }
      const defaultModel = catalog.defaultModel
      const groups = pickableGroups(catalog.groups)
      // Provider select for the standalone rows (vision / fallback / llm
      // classifier). `onModelReset` runs when the provider changes so a stale
      // model name never survives a provider switch.
      const groupSelect = (current, onProviderChange, onModelReset) => h('select', {
        style: { ...S.select, colorScheme },
        value: current,
        disabled: !writable,
        onChange: (e) => {
          const next = e.target.value
          onProviderChange(next)
          onModelReset(next)
        },
      },
        h(Option, { value: '', label: t('empty') }),
        groups
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((g) => h(Option, { key: g.id, value: g.id, label: g.name })),
      )
      const modelSelect = (provider, current, onChange, visionOnly) => h('select', {
        style: { ...S.select, maxWidth: 260, colorScheme },
        value: provider === '' ? '' : current,
        disabled: !writable || provider === '',
        onChange: (e) => onChange(e.target.value),
      },
        h(Option, { value: '', label: t('empty') }),
        (() => {
          const group = groups.find((g) => g.id === provider)
          let models = (group?.models ?? []).filter((m) => !visionOnly || m.vision !== false)
          if (provider !== '' && current !== '' && !models.some((m) => m.id === current)) {
            const known = (group?.models ?? []).find((m) => m.id === current)
            if (!visionOnly || known?.vision !== false) {
              models = models.concat({ id: current, name: current, vision: null })
            }
          }
          return models.map((m) => h(Option, { key: m.id, value: m.id, label: m.name }))
        })(),
      )

      const resetAll = () => {
        const fields = []
        for (const tier of [...TIERS, VISION]) {
          fields.push(fieldPath(tier.key, 'provider'), fieldPath(tier.key, 'model'), fieldPath(tier.key, 'effort'))
        }
        fields.push('fallbackProvider', 'fallbackModel', 'llmClassifierProvider', 'llmClassifierModel', 'visionFallbacks', 'contextGuard')
        fields.push('classifier')
        for (const field of fields) void write(field, '')
      }

      return h(Fragment, {},
        h('div', { style: S.hint }, t('intro')),

        // ---- basics: the three switches that shape routing ------------------
        h('div', { style: S.title }, t('section.basic')),
        h('div', { style: S.card },
          h('div', { style: S.switchRow },
            h('input', {
              type: 'checkbox',
              checked: value.enabled !== false,
              disabled: !writable,
              onChange: (e) => void write('enabled', e.target.checked),
            }),
            h('label', { style: { fontSize: 13, fontWeight: 600 } }, t('enable')),
          ),
          h('div', { style: S.hint }, t('enable.hint')),
          h('div', { style: S.row },
            h('div', { style: { ...S.label, minWidth: 72 } }, t('classifier')),
            h('select', {
              style: { ...S.select, colorScheme },
              value: String(value.classifier ?? 'heuristic'),
              disabled: !writable,
              onChange: (e) => void write('classifier', e.target.value),
            },
              h(Option, { value: 'heuristic', label: t('classifier.heuristic') }),
              h(Option, { value: 'llm', label: t('classifier.llm') }),
            ),
          ),
          h('div', { style: S.hint }, t('classifier.hint')),
          // The heuristic's only tuning knob. Disabled under `llm`, where the
          // model decides and the score plays no part.
          h('div', { style: S.row },
            h('div', { style: { ...S.label, minWidth: 72 } }, t('hardScore')),
            h('input', {
              key: `hardScore-${value.hardScore}`,
              style: { ...S.select, maxWidth: 84 },
              type: 'number', min: 0, max: 10, step: 1,
              defaultValue: value.hardScore ?? 3,
              disabled: !writable || String(value.classifier) === 'llm',
              onBlur: (e) => {
                const next = Number(e.target.value)
                if (Number.isInteger(next) && next >= 0 && next <= 10 && next !== value.hardScore) {
                  void write('hardScore', next)
                }
              },
            }),
          ),
          h('div', { style: S.hint }, t('hardScore.hint')),
          h('div', { style: S.switchRow },
            h('input', {
              type: 'checkbox',
              checked: value.contextGuard !== false,
              disabled: !writable,
              onChange: (e) => void write('contextGuard', e.target.checked),
            }),
            h('label', { style: { fontSize: 13, fontWeight: 600 } }, t('contextGuard')),
          ),
          h('div', { style: S.hint }, t('contextGuard.hint')),
        ),

        // ---- the tier ladder ------------------------------------------------
        h('div', { style: S.title }, t('section.tiers')),
        h('div', { style: S.card },
          h('div', { style: S.hint }, t('sameVendor')),
          h('div', { style: S.hint }, t('effort.hint')),
          TIERS.map((tier) => h(RouteRow, {
            key: tier.key,
            t,
            tier,
            value: tierValue(value, tier.key),
            catalog,
            onChange: tierOnChange(tier.key),
            visionOnly: false,
            colorScheme,
            disabled: !writable,
          })),
        ),

        // ---- vision ---------------------------------------------------------
        h('div', { style: S.title }, t('section.vision')),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { ...S.label, minWidth: 72 } }, t('tier.vision')),
            groupSelect(
              String(value.visionProvider ?? ''),
              (v) => void write('visionProvider', v),
              (next) => syncModel(groups, next, String(value.visionModel ?? ''), () => void write('visionModel', '')),
            ),
            modelSelect(String(value.visionProvider ?? ''), String(value.visionModel ?? ''), (v) => void write('visionModel', v), true),
            (() => {
              const group = groups.find((g) => g.id === value.visionProvider)
              const model = (group?.models ?? []).find((m) => m.id === value.visionModel)
              if (model === undefined) return null
              if (model.vision === true) {
                return h('span', { style: { ...S.badge, ...S.badgeGreen } }, `✓ ${t('vision.ok')}`)
              }
              if (model.vision === null) return h('span', { style: { ...S.badge, ...S.badgeYellow } }, t('vision.unknown'))
              return h('span', { style: { ...S.badge } }, t('vision.novision'))
            })(),
            h('button', {
              style: S.button,
              disabled: !writable,
              onClick: () => {
                void write('visionProvider', '')
                void write('visionModel', '')
              },
            }, t('reset')),
          ),
          h('div', { style: S.row },
            h('div', { style: { ...S.label, minWidth: 72 } }, t('vision.mode')),
            h('select', {
              style: { ...S.select, colorScheme },
              value: String(value.visionMode ?? 'replace'),
              disabled: !writable,
              onChange: (e) => void write('visionMode', e.target.value),
            },
              h(Option, { value: 'replace', label: t('vision.mode.replace') }),
              h(Option, { value: 'route', label: t('vision.mode.route') }),
            ),
          ),
          h('div', { style: S.hint }, t('vision.mode.hint')),
          h('div', { style: S.hint }, t('vision.rowHint')),
        ),

        // ---- fallback -------------------------------------------------------
        h('div', { style: S.title }, t('section.fallback')),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { ...S.label, minWidth: 72 } }, '↳'),
            groupSelect(
              fallbackValue.provider,
              (v) => void write('fallbackProvider', v),
              (next) => syncModel(groups, next, fallbackValue.model, () => void write('fallbackModel', '')),
            ),
            modelSelect(fallbackValue.provider, fallbackValue.model, (v) => void write('fallbackModel', v), false),
          ),
          h('div', { style: S.hint },
            defaultModel !== null && defaultModel.provider
              ? `${t('defaultModel')}: ${labelOf(groups, defaultModel.provider)} / ${defaultModel.model}`
              : null,
            h('span', {}, ` — ${t('fallback.hint')}`),
          ),
        ),

        // ---- LLM classifier route (only relevant when it is selected) -------
        String(value.classifier) === 'llm'
          ? h(Fragment, {},
              h('div', { style: S.title }, t('section.llm')),
              h('div', { style: S.card },
                h('div', { style: S.row },
                  groupSelect(
                    llmValue.provider,
                    (v) => void write('llmClassifierProvider', v),
                    (next) => syncModel(groups, next, llmValue.model, () => void write('llmClassifierModel', '')),
                  ),
                  modelSelect(llmValue.provider, llmValue.model, (v) => void write('llmClassifierModel', v), false),
                ),
                h('div', { style: S.hint }, t('llm.hint')),
              ),
            )
          : null,

        // ---- actions --------------------------------------------------------
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 } },
          h('button', { style: S.button, disabled: !writable || saving, onClick: resetAll }, t('reset.all')),
          saving ? h('span', { style: S.stat }, t('saving')) : null,
          saveFailed ? h('span', { style: { ...S.stat, color: 'rgba(220,80,80,1)' } }, t('saveError')) : null,
          !writable ? h('span', { style: { ...S.stat, color: 'rgba(220,180,60,1)' } }, t('readOnly')) : null,
          catalogError ? h('span', { style: { ...S.stat, color: 'rgba(220,80,80,1)' } }, t('loadError')) : null,
        ),

        // ---- status ---------------------------------------------------------
        h('div', { style: S.title }, t('section.status')),
        h('div', { style: S.card },
          stats === null
            ? h('div', { style: S.hint }, t('loading'))
            : h(Fragment, {},
                h('div', { style: S.statGrid },
                  statCell(t('stats.hard'), stats.hard ?? 0),
                  statCell(t('stats.normal'), stats.normal ?? 0),
                  statCell(t('stats.easy'), stats.easy ?? 0),
                  statCell(t('stats.vision'), stats.vision ?? 0),
                  statCell(t('stats.fallback'), stats.fallback ?? 0),
                  statCell(t('stats.routeError'), stats.routeError ?? 0),
                  statCell(t('stats.error'), stats.error ?? 0),
                ),
                // The counters above are per request, and one human turn re-sends
                // the same classified message on every tool step — so they mostly
                // measure how many steps a task took. The per-turn line is the
                // denominator that answers "is the difficulty mix reasonable?".
                stats.turns
                  ? h('div', { style: S.hint },
                      `${t('stats.turns')} · `,
                      `${t('stats.hard')} ${stats.turns.hard ?? 0}   `,
                      `${t('stats.normal')} ${stats.turns.normal ?? 0}   `,
                      `${t('stats.easy')} ${stats.turns.easy ?? 0}   `,
                      `${t('stats.vision')} ${stats.turns.vision ?? 0}   `,
                      `${t('stats.turnsTotal')} ${stats.turns.total ?? 0}`,
                    )
                  : null,
              ),
          // A route that already told us it cannot serve is benched, so the next
          // request skips it instead of paying its failure again. Saying so is the
          // difference between "the router is broken" and "that model is out of
          // quota and the fallback is answering".
          Array.isArray(stats?.benched) && stats.benched.length > 0
            ? h('div', { style: { ...S.hint, color: 'rgba(220,180,60,1)', opacity: 1 } },
                `${t('benched.title')}: `,
                stats.benched.map((b) => `${b.provider}/${b.model} — ${b.code || 'failed'}${b.message !== '' ? ` (${b.message})` : ''}, ${b.secondsLeft}s ${t('benched.retryIn')}`).join('  ·  '),
              )
            : null,
        ),

        // ---- recent decisions ----------------------------------------------
        h('div', { style: S.title }, t('section.decisions')),
        h('div', { style: S.card },
          decisions.length === 0
            ? h('div', { style: S.hint }, t('decisions.empty'))
            : decisions.slice().reverse().slice(0, 8).map((d, index) => {
                const head = [
                  clockOf(d.at),
                  d.outcome === 'failed'
                    ? `✗ ${t('decisions.failed')}`
                    : `${d.provider}/${d.model}${d.effort !== '' ? ` @${d.effort}` : ''}`,
                  d.level !== '' ? d.level : '',
                  d.estimate > 0 ? `~${Math.round(d.estimate / 1000)}k tok` : '',
                  // Same turn = another tool step of the message above, not a new
                  // human request. Makes the agent loop visible at a glance.
                  stats?.turns ? t(d.turn ? 'decisions.turn' : 'decisions.continuation') : '',
                ].filter((part) => part !== '').join('  ·  ')
                const why = [
                  d.classifier !== '' ? `${t('decisions.by')} ${d.classifier}` : '',
                  d.cause !== '' ? `${t('decisions.cause')}: ${d.cause}` : '',
                  d.overheadMs > 0
                    ? `${t('decisions.overhead')} ${(d.overheadMs / 1000).toFixed(2)}s`
                      + (d.classifyMs >= 50 ? ` (${t('decisions.classify')} ${(d.classifyMs / 1000).toFixed(1)}s)` : '')
                    : '',
                  d.tried.length > 0 ? `${t('decisions.tried')} ${d.tried.join(' → ')}` : '',
                  d.skipped.length > 0 ? `${t('decisions.skipped')} ${d.skipped.join('; ')}` : '',
                ].filter((part) => part !== '').join('  ·  ')
                return h('div', { key: `${d.at}-${index}`, style: S.decision },
                  h('div', { style: S.decisionHead }, head),
                  why !== '' ? h('div', { style: S.decisionWhy }, why) : null,
                )
              }),
        ),
      )
    }

    // ---------- plugin entry ----------
    const name = 'dsh-tier-router'

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tier-router: locale')
      const t = ctx.locale.bind(NS)
      // Native select dropdowns inherit the page color scheme; force the
      // dropdown list to match the active theme so options stay readable
      // (dark theme → dark list with light text).
      let colorScheme = 'dark'
      try {
        const theme = ctx.theme?.getTheme?.()
        if (theme === 'light') colorScheme = 'light'
      } catch { /* keep default */ }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'tier-router',
        order: 42,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, () => h(SmartRouterSection, {
        t,
        colorScheme,
      })))
    }

    exports.name = name
    exports.inject = ['slots', 'locale', 'theme']
    exports.apply = apply
    return module.exports
  },
})
