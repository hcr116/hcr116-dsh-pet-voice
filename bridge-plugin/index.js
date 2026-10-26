// DSH「桌宠桥」· 宿主半边
//
// 干两件事：
//   1. **递话**：桌宠 POST /say {text} → agent.followup(user 消息) → DSH 自己开一轮；
//      本鲸的 assistant/message 落进收件箱 → 桌宠 GET /feed?after=N 取走朗读。
//   2. **转写**：桌宠 POST /stt（16kHz/单声道/PCM16 WAV 原始字节）→ 交给 DSH 自带的
//      SenseVoice（ctx.speechToText）→ 回 {text}。桌宠只负责录音，不另装模型。
//
// ⚠ 为什么不用 ctx.webServer：DSH 的网页端口在登录鉴权后面（curl 打 / 直接 401），
//   桌宠是个外部进程，进不去。所以这里自己起一个**只绑 127.0.0.1** 的原生 http 服务，
//   端口默认 43110，可被 ~/.dsh/pet-bridge.json 的 {"port": 数字} 覆盖。
//
// ⚠ 为什么必须走 agent.followup：那才是 DSH 自己的回合（人格、历史、工具、记忆全自带）。
//   自己拼一段上下文塞进去 = 假开口。

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'pet-bridge'
export const inject = ['agents', 'sessions', 'speechToText']

/** 默认端口。桌宠那边要跟这里对得上。 */
const 默认端口 = 43110
/** /say 之后多久之内的助手发言算「对这句的回答」。 */
const 收话窗口毫秒 = 180_000
/** 收件箱最多留几条（桌宠断线太久也不至于撑爆内存）。 */
const 最多留 = 30
/** JSON 请求体上限。 */
const 最大体积 = 64 * 1024
/** 音频上限：跟 provider 的 maxAudioBytes 对齐（4MB ≈ 128 秒 16k 单声道）。 */
const 最大音频 = 4 * 1024 * 1024
/** 转写兜底超时。 */
const 转写超时毫秒 = 120_000
/** 国内镜像优先（跟 provider 默认 modelOrigins 里那条一致的 origin）。 */
const 镜像 = 'https://hf-mirror.com'

const 源标记 = 'pet-bridge'

function 家目录() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function 读配置() {
  const 兜 = { port: 默认端口 }
  try {
    const o = JSON.parse(readFileSync(join(家目录(), 'pet-bridge.json'), 'utf8'))
    const 端口 = Number(o && o.port)
    return { ...兜, ...o, port: Number.isFinite(端口) && 端口 > 0 ? 端口 : 默认端口 }
  } catch {
    return 兜
  }
}

function 记日志(ctx, 文) {
  try {
    const l = ctx && ctx.logger
    if (typeof l === 'function') l('pet-bridge').info(文)
    else if (l && typeof l.info === 'function') l.info(文)
  } catch {
    /* 日志坏了也不能影响说话 */
  }
}

function 新id() {
  return 'pb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** 把 message.content 抽成纯文本（reasoning / tool_call / tool_result 都不是话）。 */
function 抽文本(内容) {
  if (typeof 内容 === 'string') return 内容.trim()
  if (!Array.isArray(内容)) return ''
  const 段 = []
  for (const 一块 of 内容) {
    if (一块 && 一块.type === 'text' && typeof 一块.text === 'string') 段.push(一块.text)
  }
  return 段.join('\n').trim()
}

// ---------- 念出来的是「短句」，不是全文 ----------
// 约定：DSH 那边回复里带一行「口播：……」，这里就只念那一行。
// 没带（老格式 / 别的 agent / 摘要掉了）就退到规则抽取：去掉代码、路径、表格，只取第一句。
const 口播上限 = 40
const 兜底上限 = 60

/** 去掉不该念的东西：代码块、行内代码、链接、markdown 符号、多余空白。 */
function 清干净(文) {
  return String(文 || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 在句号/问号/叹号处切一刀；够长又没标点就硬切。 */
function 切一句(文, 上限) {
  const 标点 = /[。！？!?…；;]/
  let 收 = ''
  for (const 字 of 文) {
    if (收.length >= 上限) break
    收 += 字
    if (标点.test(字) && 收.length >= 6) break
  }
  // 硬切在字中间很难听：往后看一眼，有没有更近的标点可以收尾
  if (!标点.test(收.slice(-1)) && 收.length > 20) {
    const 位置 = Math.max(
      收.lastIndexOf('，'),
      收.lastIndexOf('、'),
      收.lastIndexOf(' '),
      收.lastIndexOf('：'),
    )
    if (位置 >= 12) 收 = 收.slice(0, 位置)
  }
  return 收.trim()
}

/**
 * 从一段回复里挑出「要对人念的那句」。
 * @param {string} 全文
 * @returns {string}
 */
export function 挑要说的话(全文) {
  const 原 = String(全文 || '')
  const 口播 = /^[ \t>*_-]*(?:口播|口播词|播报)[ \t]*[：:][ \t]*(.+)$/m.exec(原)
  if (口播) {
    const 句 = 清干净(口播[1])
    if (句) return 句.length > 口播上限 ? 切一句(句, 口播上限) : 句
  }

  const 净 = 清干净(原)
  if (!净) return ''
  // 兜底：先按标点取第一句，再保证不超过上限
  const 首句 = /^[\s\S]*?[。！？!?…]/.exec(净)
  const 句 = 首句 ? 首句[0] : 净
  return 句.length > 兜底上限 ? 切一句(句, 兜底上限) : 句
}

function 读体(req) {
  return new Promise((resolve, reject) => {
    let 长度 = 0
    const 块们 = []
    const 闹钟 = setTimeout(() => reject(new Error('读请求体超时')), 10_000)
    req.on('data', (块) => {
      长度 += 块.length
      if (长度 > 最大体积) {
        clearTimeout(闹钟)
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      块们.push(块)
    })
    req.on('end', () => {
      clearTimeout(闹钟)
      try {
        const 文 = Buffer.concat(块们).toString('utf8').trim()
        resolve(文 ? JSON.parse(文) : {})
      } catch (error) {
        reject(new Error('请求体不是 JSON：' + String((error && error.message) || error)))
      }
    })
    req.on('error', (error) => {
      clearTimeout(闹钟)
      reject(error)
    })
  })
}

/** 读原始字节体（音频用，不解析 JSON）。 */
function 读原体(req, 上限) {
  return new Promise((resolve, reject) => {
    let 长度 = 0
    const 块们 = []
    const 闹钟 = setTimeout(() => reject(new Error('读音频超时')), 30_000)
    req.on('data', (块) => {
      长度 += 块.length
      if (长度 > 上限) {
        clearTimeout(闹钟)
        reject(new Error('音频太大（上限 ' + Math.round(上限 / 1024 / 1024) + ' MB）'))
        req.destroy()
        return
      }
      块们.push(块)
    })
    req.on('end', () => {
      clearTimeout(闹钟)
      resolve(Buffer.concat(块们))
    })
    req.on('error', (错误) => {
      clearTimeout(闹钟)
      reject(错误)
    })
  })
}

/** 拿 DSH 自带的语音服务（voice bundle 没装/没开时是 undefined）。 */
function 语音服务(ctx) {
  try {
    if (ctx.speechToText) return ctx.speechToText
    if (typeof ctx.get === 'function') return ctx.get('speechToText')
  } catch {
    /* 服务没挂 */
  }
  return undefined
}

/** 读转写器的准备状态：{ providerId, phase, step, progress }。 */
function 语音状态(ctx) {
  const stt = 语音服务(ctx)
  if (!stt || typeof stt.snapshot !== 'function') return null
  try {
    const 快照 = stt.snapshot()
    const 选中 = (快照 && 快照.selection && 快照.selection.providerId) || ''
    const 们 = (快照 && 快照.providers) || []
    const p = 们.find((x) => x && x.id === 选中) || 们[0]
    if (!p) return { providerId: 选中 || null, phase: 'missing', step: null }
    const 准备 = p.preparation || {}
    return {
      providerId: p.id || 选中 || null,
      phase: 准备.phase || 'unknown',
      step: 准备.step || null,
      progress: 准备.progress == null ? null : 准备.progress,
      message: 准备.message == null ? null : String(准备.message),
    }
  } catch (错误) {
    return { providerId: null, phase: 'unknown', message: String((错误 && 错误.message) || 错误) }
  }
}

/** 就绪的判断：ready 或 standby（模型在盘上、worker 睡着了，一问就醒）。 */
function 已就绪(状态) {
  return !!状态 && (状态.phase === 'ready' || 状态.phase === 'standby')
}

/** 拿官方工厂；profile 的 node_modules 里通常没有 @deepseek-ai/dsh-llm，失败是正常的。 */
let 工厂缓存
async function 拿造消息工厂() {
  if (工厂缓存 !== undefined) return 工厂缓存
  try {
    const 模块 = await import('@deepseek-ai/dsh-llm')
    if (模块 && typeof 模块.createUserMessage === 'function') {
      工厂缓存 = 模块
      return 工厂缓存
    }
  } catch {
    /* 预期内的失败 */
  }
  工厂缓存 = null
  return null
}

export function apply(ctx) {
  const 配置 = 读配置()

  /** 本鲸说过的话，等桌宠来取：{seq, text, ts} */
  const 收件箱 = []
  let 序号 = 0
  /** 只收这个时刻之前的回答（每次 /say 刷新）。 */
  let 收话截止 = 0
  /** 最近一次有动静的会话 id。 */
  let 最后活跃 = ''
  /** 正在说话（防连点导致两个 followup 打架）。 */
  let 说话中 = false

  function 列会话() {
    const 出 = []
    try {
      const 全部 = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      for (const a of 全部 || []) {
        const id = (a && (a.id || (a.session && a.session.id))) || ''
        if (!id) continue
        let 标题 = null
        try {
          if (ctx.sessionTitle && typeof ctx.sessionTitle.get === 'function') 标题 = ctx.sessionTitle.get(a.session || id)
        } catch {
          /* 标题拿不到就算了 */
        }
        出.push({ id: String(id), title: 标题 == null ? null : String(标题), active: String(id) === String(最后活跃) })
      }
    } catch {
      /* 拿不到就返回空的，桌宠会看到 0 条 */
    }
    return 出
  }

  function 找执行体(指定) {
    const 试 = (id) => {
      if (!id) return null
      try {
        return (ctx.agents && typeof ctx.agents.get === 'function' && ctx.agents.get(id)) || null
      } catch {
        return null
      }
    }
    const 有序 = []
    if (指定) 有序.push(指定)
    if (最后活跃) 有序.push(最后活跃)
    for (const id of 有序) {
      const a = 试(id)
      if (a) return a
    }
    // 兜底：随便挑一个活着的 agent（刚重启、还没人说话时）
    try {
      const 全部 = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      for (const a of 全部 || []) if (a) return a
    } catch {
      /* 忽略 */
    }
    return null
  }

  async function 说话(文案, 指定会话) {
    const 文本 = String(文案 == null ? '' : 文案).trim()
    if (!文本) throw new Error('没收到要转达的话')
    if (说话中) throw new Error('上一句还在送，等它送完')
    const agent = 找执行体(指定会话)
    if (!agent) throw new Error('没有活着的会话，先在网页里开一个')

    const 会话id = String((agent.id || (agent.session && agent.session.id)) || 最后活跃 || '')
    说话中 = true
    try {
      const 工厂 = await 拿造消息工厂()
      const 消息 = 工厂
        ? 工厂.createUserMessage({ content: [{ type: 'text', text: 文本 }], source: { kind: 源标记 } })
        : {
            id: 新id(),
            role: 'user',
            content: [{ type: 'text', text: 文本 }],
            source: { kind: 源标记 },
          }
      // ⚠ 必须 await + catch：followup 的 rejection 是未处理异常，Node 22+ 会杀掉整个宿主进程
      收话截止 = Date.now() + 收话窗口毫秒
      await agent.followup(消息)
      if (ctx.sessions && typeof ctx.sessions.flush === 'function') {
        try {
          await ctx.sessions.flush(agent.session || 会话id)
        } catch {
          /* 落盘没确认不影响说话 */
        }
      }
      记日志(ctx, `收到桌宠一句（${会话id}）：${文本.slice(0, 60)}`)
      return 会话id
    } finally {
      说话中 = false
    }
  }

  // ---------- 监听会话：记最近活跃 + 收本鲸的回答 ----------
  const 解绑 = ctx.on('session/event', (session, event) => {
    const id = String((session && session.id) || '')
    const 类型 = event && event.type
    if (id && (类型 === 'user/message' || 类型 === 'assistant/message' || 类型 === 'agent/turn-stopping')) {
      最后活跃 = id
    }
    if (类型 !== 'assistant/message') return
    if (Date.now() > 收话截止) return
    const 全文 = 抽文本(event && event.data && event.data.message && event.data.message.content)
    if (!全文) return
    const 文本 = 挑要说的话(全文)
    if (!文本) return
    收件箱.push({ seq: ++序号, text: 文本, ts: Date.now() })
    while (收件箱.length > 最多留) 收件箱.shift()
  })

  // ---------- 只绑本机的小 http 服务 ----------
  const 服务 = createServer(async (req, res) => {
    const 头 = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    }
    const 回 = (码, 体) => {
      try {
        res.writeHead(码, 头)
        res.end(JSON.stringify(体))
      } catch {
        /* 对端已经断了 */
      }
    }

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, 头)
        res.end()
        return
      }
      const 地址 = new URL(req.url || '/', 'http://127.0.0.1')

      if (req.method === 'GET' && 地址.pathname === '/ping') {
        const 语音 = 语音状态(ctx)
        return 回(200, {
          ok: true,
          name,
          会话: 最后活跃 || null,
          待答: Date.now() <= 收话截止,
          未取: 收件箱.length,
          序号,
          语音: 语音 ? 语音.phase : 'off',
          就绪: 已就绪(语音),
        })
      }

      if (req.method === 'GET' && 地址.pathname === '/sessions') {
        return 回(200, { ok: true, sessions: 列会话(), active: 最后活跃 || null })
      }

      if (req.method === 'GET' && 地址.pathname === '/feed') {
        const after = Number(地址.searchParams.get('after') || 0) || 0
        return 回(200, { ok: true, last: 序号, items: 收件箱.filter((x) => x.seq > after) })
      }

      if (req.method === 'GET' && 地址.pathname === '/stt/status') {
        const 状态 = 语音状态(ctx)
        return 回(200, {
          ok: !!状态,
          服务: 语音服务(ctx) ? 'on' : 'off',
          provider: 状态 && 状态.providerId,
          phase: 状态 && 状态.phase,
          step: 状态 && 状态.step,
          progress: 状态 && 状态.progress,
          就绪: 已就绪(状态),
          message: 状态 && 状态.message,
        })
      }

      if (req.method === 'POST' && 地址.pathname === '/stt/prepare') {
        const stt = 语音服务(ctx)
        if (!stt) return 回(503, { ok: false, error: 'DSH 的语音服务没开着（voice bundle）' })
        const 前 = 语音状态(ctx)
        if (已就绪(前)) return 回(200, { ok: true, phase: 前.phase, 就绪: true })
        const id = (前 && 前.providerId) || 'sensevoice-local'
        try {
          stt.prepare(id, { downloadSource: 镜像 })
        } catch (错误) {
          // 已经在准备中（换源会抛），不算失败
          const 后 = 语音状态(ctx)
          if (!已就绪(后) && (!后 || 后.phase === 'failed')) throw 错误
        }
        记日志(ctx, `开始准备语音模型（${id}，源 ${镜像}）`)
        return 回(202, { ok: true, phase: 'preparing', provider: id })
      }

      if (req.method === 'POST' && 地址.pathname === '/stt') {
        const stt = 语音服务(ctx)
        if (!stt) return 回(503, { ok: false, error: 'DSH 的语音服务没开着', code: 'no-service' })

        const 音频 = await 读原体(req, 最大音频)
        if (!音频 || 音频.length < 200) return 回(400, { ok: false, error: '音频太短', code: 'too-short' })

        const 状态 = 语音状态(ctx)
        if (!已就绪(状态)) {
          // 第一次用：顺手把模型拉起来，让桌宠说「等本鲸准备一下」
          if (状态 && 状态.phase !== 'preparing' && 状态.phase !== 'downloading' && 状态.phase !== 'loading') {
            try {
              stt.prepare((状态 && 状态.providerId) || 'sensevoice-local', { downloadSource: 镜像 })
            } catch {
              /* 已在准备中 */
            }
          }
          return 回(425, {
            ok: false,
            code: 'preparing',
            phase: (状态 && 状态.phase) || 'unprepared',
            progress: (状态 && 状态.progress) ?? null,
            error: '本鲸还在准备识别的模型',
          })
        }

        let spec
        try {
          spec = stt.resolve({ audio: 音频 })
        } catch (错误) {
          return 回(400, { ok: false, code: 'resolve', error: String((错误 && 错误.message) || 错误) })
        }
        try {
          const 结果 = await stt.transcribe(spec, AbortSignal.timeout(转写超时毫秒))
          const 文本 = String((结果 && 结果.text) || '').trim()
          if (!文本) return 回(200, { ok: true, text: '', empty: true, audioSeconds: (结果 && 结果.audioSeconds) || null })
          return 回(200, {
            ok: true,
            text: 文本,
            audioSeconds: (结果 && 结果.audioSeconds) ?? null,
            inferenceSeconds: (结果 && 结果.inferenceSeconds) ?? null,
          })
        } catch (错误) {
          const 文 = String((错误 && 错误.message) || 错误)
          const 坏 = (错误 && 错误.name === 'SpeechInputError') || /canonical 16 kHz/i.test(文)
          return 回(坏 ? 400 : 500, { ok: false, code: 坏 ? 'bad-audio' : 'transcribe', error: 文 })
        }
      }

      if (req.method === 'POST' && 地址.pathname === '/say') {
        const 体 = await 读体(req)
        const 会话id = await 说话(体 && 体.text, 体 && 体.session)
        return 回(200, { ok: true, session: 会话id })
      }

      return 回(404, { ok: false, error: '没有这个路口：' + 地址.pathname })
    } catch (error) {
      return 回(400, { ok: false, error: String((error && error.message) || error) })
    }
  })

  服务.on('error', (error) => {
    记日志(ctx, `监听 ${配置.port} 失败：${String((error && error.message) || error)}`)
  })

  ctx.effect(() => {
    try {
      服务.listen(配置.port, '127.0.0.1', () => {
        记日志(ctx, `桌宠桥通了：http://127.0.0.1:${配置.port}`)
      })
    } catch (error) {
      记日志(ctx, `起不来：${String((error && error.message) || error)}`)
    }
    return () => {
      try {
        解绑()
      } catch {
        /* 已解绑 */
      }
      try {
        服务.close()
      } catch {
        /* 已经关了 */
      }
    }
  })
}
