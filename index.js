/**
 * dsh-pet-voice —— 拿 dsh-pet 当身体：按住 Ctrl+U 对它说话，把 DSH 的回答念出来
 * ============================================================================
 *
 * 两条链路：
 *
 *   ① 说给它听（网页半边录音 → 这里转写）
 *     按住 Ctrl+U → 网页录 16k/单声道 WAV → POST /dsh-pet-voice/stt
 *       └─ ctx.speechToText 转写 → 回文字 → 网页插进输入框（用户自己按回车）
 *
 *   ② 它念给你听（一轮结束）
 *     一轮结束（agent/turn-stopping）→ 取最后一条 assistant 文本
 *       └─ 挑「口播句」（有 `口播：` 只念那行；没有就规则兜底，最多 40 字）
 *            ├─ dsh-pet：lock → broadcast → 解锁   （气泡 + 说话动画）
 *            └─ 克隆嗓念：GPT-SoVITS 3 秒不答就退 Windows SAPI
 *
 * ⚠⚠ 三条硬纪律（踩过的坑，别改）：
 *   1. **不注册任何 systemPrompt / persona 段**。人格由 dsh-agent-md 注入一次就够了；
 *      再注册一遍 = 同一段 prompt 进系统提示两次，公司那台 DSH 就是这么起不来的。
 *   2. **静态 inject 只写核心服务**：agents / sessions。webServer / speechToText 都惰性
 *      `ctx.get()`，拿不到就降级，绝不让 fiber 卡在 pending。
 *   3. **peerDependencies 里不写 `@deepseek-ai/dsh-*`**：DSH ≥0.2.0 会对不上的 peer 静默丢包。
 *
 * dsh-pet 的网络契约（读它 0.3.8 的 lib/index.js 核过，别照 README 猜）：
 *   POST /dsh-pet-7340/lock?pet=main&surface=web        body {ttl?}      → {ok, lockId, expiresAt}
 *   POST /dsh-pet-7340/broadcast?pet=main&surface=web&lock=<id>
 *                                                       body {text, duration?, anim?}
 *   POST /dsh-pet-7340/lock/release?pet=main            body {lockId}    → {ok}
 *   注意：`?surface=` 是**必填**，`?lock=` 也必须带，否则它自己的碎碎念/工作状态会来抢这只宠物。
 */

import { spawn } from 'node:child_process'
import net from 'node:net'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-pet-voice'

/** 核心服务，永远在；其余一律惰性取。 */
export const inject = ['agents', 'sessions']

const 默认 = {
  enabled: true,
  petId: 'main',
  surface: 'web',
  bubbleMs: 9000,
  /** local = GPT-SoVITS 克隆嗓 + SAPI 兜底；off = 只出气泡不出声 */
  voice: 'local',
  maxChars: 40,
  /** 只念你眼前那个会话（网页半边会把当前会话 id 报上来） */
  mainSessionOnly: true,
  /** 宠物自己冒出来的气泡（右键对话框聊天、戳它、碎碎念）也念出来 */
  speakPetBubbles: true,
  /** 按住说话的键，只是给网页半边看的（它才是真正按键的那个） */
  hotkey: 'Ctrl+U',
  sovits: {
    url: 'http://127.0.0.1:9880',
    refAudio: 'D:\\DafeiyuVoice\\ref\\dwg_0002.wav',
    promptText: '什么嘛，这么简单的事情，你居然专门跑来问我。',
    lang: 'zh',
    speed: 1,
    /** 超过这个时间没答就判失败，退 SAPI */
    timeoutMs: 3000,
  },
  sapi: {
    rate: 0,
    volume: 90,
    voice: '',
  },
  stt: {
    providerId: '',
    downloadSource: 'https://hf-mirror.com',
    timeoutMs: 120000,
  },
  /**
   * 嘀嗒清单的「到点提醒」：到点了冒个泡 + 念一句。
   *
   * 数据来自滴答自己的 web 接口（/api/v2/batch/check/0），凭证**不用手填**：
   * 从本机客户端的 SQLite（%APPDATA%\Tick_Tick\TickTick.db 的 CommonSettings.LoginUserAuth）
   * 里读出来当 Cookie 用。客户端重新登录，凭证自己就更新了。
   */
  dida: {
    enabled: true,
    /** 能力开关：auto 自己认 | on 强制（探不到会提示一次）| off 彻底不启动 */
    mode: 'auto',
    /** 手动塞 cookie 可以绕过读库（调试或没装客户端时用） */
    cookie: '',
    /** 空 = %APPDATA%\Tick_Tick\TickTick.db */
    dbPath: '',
    apiBase: 'https://api.dida365.com',
    /** 多久重新拉一次清单（秒）。到点触发靠本地定时器，不靠这个精度 */
    pollSeconds: 120,
    /** 同一分钟里好几条一起到点，合成一句，别连着响三声 */
    mergeWindowMs: 2000,
    /** 安静时段：只冒泡不出声。空字符串 = 不设 */
    quietFrom: '23:00',
    quietTo: '08:00',
  },
  /**
   * 能力开关（给"打包给别人用"准备的）。
   *
   * 三个能力各有 auto/on/off 三档：
   *   auto = 自己探测这台机器能不能用（探不到就静默关掉，只在日志里留一行）
   *   on   = 强制启用；探不到会**提示一次**，好让人知道哪里没配好
   *   off  = 连探测都不做
   *
   * 旧键（voice / sovits / sapi / hotkey / dida.enabled）照旧能用，
   * 读配置的时候会映射进这套结构，老配置不用改。
   */
  speak: {
    mode: 'auto', // auto | on | off —— 念不念
    provider: 'auto', // auto | local | sapi
  },
  listen: {
    mode: 'auto', // auto | on | off —— 麦克风入口要不要出
    /** 按住说话的键（给网页半边看的） */
    hotkey: 'Ctrl+U',
    fallbackHotkey: 'Ctrl+Shift+U',
  },
  /** 装好后第一次启动说一句「这台能做什么」，之后不再提 */
  firstRunReport: true,
}

function 家目录() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** auto / on / off 三档，认不出来就回兜底 */
export function 三档(值, 兜底 = 'auto') {
  const v = String(值 === undefined || 值 === null ? 兜底 : 值).trim().toLowerCase()
  return v === 'on' || v === 'off' || v === 'auto' ? v : 兜底
}

/**
 * 把用户写的那份配置归一成内部形状。
 *
 * 新结构是 speak/listen/dida 三块（各有 mode），但内部老代码还在用
 * voice / sovits / sapi / hotkey / dida.enabled，所以这里做一次映射：
 * 老配置照旧能用，新配置也能用。
 */
export function 归一化配置(原 = {}) {
  const 合 = {
    ...默认,
    ...原,
    sovits: { ...默认.sovits, ...(原.sovits || {}) },
    sapi: { ...默认.sapi, ...(原.sapi || {}) },
    stt: { ...默认.stt, ...(原.stt || {}) },
    speak: { ...默认.speak, ...(原.speak || {}) },
    listen: { ...默认.listen, ...(原.listen || {}) },
    dida: { ...默认.dida, ...(原.dida || {}) },
  }

  // speak 块里也能写 sovits/sapi（新写法），优先级高于顶层
  if (原.speak && 原.speak.sovits) 合.sovits = { ...合.sovits, ...原.speak.sovits }
  if (原.speak && 原.speak.sapi) 合.sapi = { ...合.sapi, ...原.speak.sapi }

  合.speak.mode = 三档(合.speak.mode)
  合.listen.mode = 三档(合.listen.mode)
  // 老的 dida.enabled:false 等价于现在的 mode:'off'
  合.dida.mode = 原.dida && 原.dida.enabled === false ? 'off' : 三档(合.dida.mode)

  // 老键 → 新结构
  if (原.voice === 'off') 合.speak.mode = 'off'
  else if (原.voice === 'sapi') 合.speak.provider = 'sapi'
  else if (原.voice === 'local' && !(原.speak && 原.speak.provider)) 合.speak.provider = 'local'
  合.speak.provider = String(合.speak.provider || 'auto').toLowerCase()
  if (!['auto', 'local', 'sapi'].includes(合.speak.provider)) 合.speak.provider = 'auto'

  // 内部老字段（别处还在读）
  合.voice = 合.speak.mode === 'off' ? 'off' : 合.speak.provider === 'sapi' ? 'sapi' : 'local'
  合.dida.enabled = 合.dida.mode !== 'off'
  // 热键写在 listen 块里也算数（顶层 hotkey 是老写法，优先级更高）
  if (!原.hotkey && 原.listen && 原.listen.hotkey) 合.hotkey = 合.listen.hotkey
  if (!合.hotkey) 合.hotkey = 合.listen.hotkey

  if (!Number.isFinite(Number(合.bubbleMs)) || Number(合.bubbleMs) < 500) 合.bubbleMs = 默认.bubbleMs
  if (!Number.isFinite(Number(合.maxChars)) || Number(合.maxChars) < 6) 合.maxChars = 默认.maxChars
  return 合
}

function 读配置() {
  try {
    // DSH_PET_VOICE_CONFIG 只给测试用：指到临时配置，别碰真的那份
    const 路 = process.env.DSH_PET_VOICE_CONFIG || join(家目录(), 'dsh-pet-voice.json')
    return 归一化配置(JSON.parse(readFileSync(路, 'utf8')))
  } catch {
    return 归一化配置({})
  }
}

function 记日志(ctx, 文) {
  try {
    const l = ctx && ctx.logger
    if (typeof l === 'function') l('pet-voice').info(文)
    else if (l && typeof l.info === 'function') l.info(文)
  } catch {
    /* 日志坏了也不能影响说话 */
  }
  // 顺手落一份到 ~/.dsh/dsh-pet-voice.log：桌面壳不写应用日志，出问题时只能从这里翻
  try {
    const 文件 = join(家目录(), 'dsh-pet-voice.log')
    appendFileSync(文件, `[${new Date().toISOString()}] ${文}\n`)
    if (statSync(文件).size > 256 * 1024) {
      writeFileSync(文件, readFileSync(文件, 'utf8').slice(-128 * 1024))
    }
  } catch {
    /* 落盘失败也算了 */
  }
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

// ---------- 口播：念一句，不念全文 ----------
const 口播上限 = 40

/** 去表情：emoji / 代理对 / 变体选择符都不进嗓子（老桌宠 Voice.cs:236-249 的做法）。 */
export function 去表情(文) {
  return String(文 || '')
    // 代理对（U+1F300 以上：🐟🌊🎉 这些）
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
    // 零宽与变体选择符
    .replace(/[\u200B-\u200F\uFEFF\uFE0E\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 去掉不该念的东西：代码块、行内代码、链接、markdown 符号、多余空白。 */
function 清干净(文) {
  return 去表情(
    String(文 || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*_~#>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

/** 在句号/问号/叹号处切一刀；够长又没标点就在逗号处收。 */
function 切一句(文, 上限) {
  const 标点 = /[。！？!?…；;]/
  let 收 = ''
  for (const 字 of 文) {
    if (收.length >= 上限) break
    收 += 字
    if (标点.test(字) && 收.length >= 6) break
  }
  if (!标点.test(收.slice(-1)) && 收.length > 20) {
    const 位置 = Math.max(收.lastIndexOf('，'), 收.lastIndexOf('、'), 收.lastIndexOf(' '), 收.lastIndexOf('：'))
    if (位置 >= 12) 收 = 收.slice(0, 位置)
  }
  return 收.trim()
}

/**
 * 从一整段回复里挑出「要念的那一句」。三级优先，不随机：
 *   1. `口播：` / `口播词：` / `播报：` 那一行（DSH 准备好的口播）
 *   2. 第一句能念的话
 *   3. 都不行 → 空串（只留气泡，不念）
 */
export function 挑要说的话(全文, 上限 = 口播上限) {
  const 原 = String(全文 || '')
  const 口播 = /^[ \t>*_-]*(?:口播|口播词|播报)[ \t]*[：:][ \t]*(.+)$/m.exec(原)
  if (口播) {
    const 句 = 清干净(口播[1])
    if (句) return 切一句(句, 上限) // 一句就够了：多句连念等于念整段
  }
  // 先把整块代码摘掉：逐行清的话，代码块里那一行会被当成句子念出来
  const 去块 = 原.replace(/```[\s\S]*?```/g, '\n')
  for (const 行 of 去块.split(/\r?\n/)) {
    // 表格 / 标题 / 引用整行跳过（清干净会把 | 和 # 抹掉，只能看原始行）
    if (/^\s*[|#>]/.test(行)) continue
    // 没闭合代码围栏的那行也跳过
    if (/^\s*```/.test(行)) continue
    const 净 = 清干净(行)
    if (净.length < 2) continue
    // 纯路径 / 命令 / 英文串一律不念（"SYNTAX-OK"、"node_modules"、"true" 这种）
    // 判断标准：整行只有 ASCII 可见字符、没有空格、没有汉字 —— 那就不是在说话
    if (/^[\w./\\:$-]+$/.test(净)) continue
    if (!/[\u4e00-\u9fa5]/.test(净) && !/\s/.test(净)) continue
    return 切一句(净, 上限)
  }
  return ''
}

// ---------- 能力探测：这台机器能做什么 ----------
//
// 给"打包给别人用"准备的：三个能力各自 auto/on/off。
// auto 探不到就静默关掉（只留一行日志）；on 探不到会提示一次。

/** TCP 连一下（1.2 秒超时）。用来探 GPT-SoVITS 在不在。 */
export function 探端口(地址, 超时 = 1200) {
  return new Promise((收) => {
    let u
    try {
      u = new URL(String(地址 || ''))
    } catch {
      return 收(false)
    }
    const 主机 = u.hostname
    const 端口 = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    if (!主机 || !端口) return 收(false)
    const s = net.connect({ host: 主机, port: 端口 })
    let 收过了 = false
    const 了结 = (v) => {
      if (收过了) return
      收过了 = true
      try {
        s.destroy()
      } catch {
        /* 已经断了 */
      }
      收(v)
    }
    s.setTimeout(超时, () => 了结(false))
    s.on('connect', () => 了结(true))
    s.on('error', () => 了结(false))
  })
}

/** 探"说"这个能力：返回 { available, provider, reason } */
export async function 探说(配, 探端口函数 = 探端口) {
  const 模 = 三档(配.speak && 配.speak.mode)
  if (模 === 'off') return { available: false, provider: 'off', reason: '关掉了（speak.mode=off）' }

  const 想用 = String((配.speak && 配.speak.provider) || 'auto').toLowerCase()
  const 是Windows = process.platform === 'win32'
  const 能SAPI = 是Windows
  const 能用克隆 = !!配.sovits && !!(await 探端口函数((配.sovits && 配.sovits.url) || ''))

  if (想用 === 'sapi') {
    return 能SAPI
      ? { available: true, provider: 'sapi', reason: '' }
      : { available: false, provider: 'sapi', reason: '这台不是 Windows，没有 SAPI' }
  }
  if (想用 === 'local') {
    return 能用克隆
      ? { available: true, provider: 'local', reason: '' }
      : 能SAPI
        ? { available: true, provider: 'sapi', reason: '克隆嗓没起来，退 SAPI' }
        : { available: false, provider: 'local', reason: '克隆嗓没起来，这台也没有 SAPI' }
  }
  // auto
  if (能用克隆) return { available: true, provider: 'local', reason: '' }
  if (能SAPI) return { available: true, provider: 'sapi', reason: '' }
  return { available: false, provider: 'none', reason: '既没有克隆嗓也没有 SAPI' }
}

/** 探"听"这个能力：语音识别服务在不在（麦克风由网页半边自己判） */
export function 探听(配, 有语音服务) {
  const 模 = 三档(配.listen && 配.listen.mode)
  if (模 === 'off') return { available: false, mode: 模, reason: '关掉了（listen.mode=off）' }
  if (!有语音服务) {
    return { available: false, mode: 模, reason: '这台没有语音识别服务（DSH 的语音包没装）' }
  }
  return { available: true, mode: 模, reason: '' }
}

/** 探"提醒"这个能力：本机有没有滴答客户端的数据 */
export async function 探提醒(配, 读凭证函数 = 读嘀嗒凭证) {
  const 模 = 三档(配.dida && 配.dida.mode)
  if (模 === 'off') return { available: false, mode: 模, reason: '关掉了（dida.mode=off）' }
  try {
    const 凭证 = await 读凭证函数(配.dida || {})
    if (凭证) return { available: true, mode: 模, reason: '' }
    return { available: false, mode: 模, reason: '没找到滴答的登录凭证（没装客户端或没登录）' }
  } catch (错误) {
    return { available: false, mode: 模, reason: `读不到滴答数据：${String((错误 && 错误.message) || 错误).slice(0, 40)}` }
  }
}

/**
 * 探活 dsh-pet 用的地址。
 * dsh-pet 的 /state 里 since 和 timeout **必须成对**给，只给 timeout 直接 400
 * （"since and timeout must be used together"）；探活只要当前状态，干脆两个都不给。
 * 踩过：曾经拼 &timeout=0 想"即时返回"，结果身体在跑也被记成"不在"，体检一直 ok:false。
 */
export function 探活地址(基, 宠物) {
  const id = encodeURIComponent(宠物 || 'main')
  return `${String(基).replace(/\/+$/, '')}/state?pet=${id}`
}

/** 探"身体"在不在：dsh-pet 的 /state 通不通。它是**另一个包**（别人写的），没装就什么都没有。 */
export async function 探身体(取状态) {
  if (typeof 取状态 !== 'function') return { available: false, reason: '内部错误：没给探测函数' }
  try {
    const 通 = await 取状态()
    return 通
      ? { available: true, reason: '' }
      : {
          available: false,
          reason: '没装 dsh-pet（宠物身体）：dsh plugin --profile desktop add dsh-pet',
        }
  } catch (错误) {
    return { available: false, reason: `连不上 dsh-pet：${String((错误 && 错误.message) || 错误).slice(0, 40)}` }
  }
}

/** 全部一起探。「有没有语音服务」「身体探针」都由调用方给（要 ctx） */
export async function 探全部能力(配, 有语音服务, 取身体状态) {
  const [说, 提, 身] = await Promise.all([探说(配), 探提醒(配), 探身体(取身体状态)])
  const 听 = 探听(配, 有语音服务)
  return { body: 身, speak: 说, listen: 听, dida: 提 }
}

/** 首启体检说的一句人话 */
export function 体检文案(能力) {
  // 身体是前提：连宠物都没有，说别的没意义
  if (!能力 || !能力.body || 能力.body.available === false) {
    return '鱼鱼在。但这台还没装宠物身体（dsh-pet），我只能在后台念，你看不到我。'
  }
  const 能 = []
  const 不能 = []
  const 记 = (项, 名) => (项 && 项.available ? 能 : 不能).push(名)
  记(能力.speak, 能力.speak && 能力.speak.provider === 'local' ? '克隆嗓' : '说话')
  记(能力.dida, '嘀嗒提醒')
  记(能力.listen, '麦克风')
  const 前半 = 能.length ? `这台能：${能.join('、')}` : '这台只有气泡'
  const 后半 = 不能.length ? `。没有：${不能.join('、')}` : ''
  return `鱼鱼在。${前半}${后半}。`
}

/**
 * 体检清单（给 GET /dsh-pet-voice/doctor 用）。
 *
 * 和 体检文案 的区别：那是"说给主人听的一句话"，这是"逐条能拿来修的清单"。
 * 判 ok 的标准只有一个：**身体装没装** —— 没身体的话这插件本来就没意义。
 */
export function 体检清单(能力, 配, 配置路径 = '') {
  const 好 = (x) => !!(x && x.available)
  const 项 = []

  项.push(
    好(能力 && 能力.body)
       ? { 项: '身体（dsh-pet）', 状态: '✅', 说明: '在' }
       : {
           项: '身体（dsh-pet）',
           状态: '❌',
           说明: (能力 && 能力.body && 能力.body.reason) || '没装',
           怎么修: 'dsh plugin --profile desktop add dsh-pet',
         },
  )

  项.push(
    好(能力 && 能力.speak)
       ? { 项: '说话', 状态: '✅', 说明: (能力.speak && 能力.speak.provider) || 'auto' }
       : {
           项: '说话',
           状态: '⛔',
           说明: (能力 && 能力.speak && 能力.speak.reason) || '这台念不了',
           怎么修: '起一个 GPT-SoVITS 到 127.0.0.1:9880，或换一台 Windows',
         },
  )

  项.push(
    好(能力 && 能力.listen)
       ? { 项: '耳朵（麦克风）', 状态: '✅', 说明: '可以用' }
       : {
           项: '耳朵（麦克风）',
           状态: '⛔',
           说明: (能力 && 能力.listen && 能力.listen.reason) || '这台听不了',
           怎么修: '装 DSH 的语音包；没有也行，直接打字',
         },
  )

  项.push(
    好(能力 && 能力.dida)
       ? { 项: '嘀嗒提醒', 状态: '✅', 说明: '已读到凭证' }
       : {
           项: '嘀嗒提醒',
           状态: '⛔',
           说明: (能力 && 能力.dida && 能力.dida.reason) || '这台没有嘀嗒',
           怎么修: '装滴答清单桌面客户端并登录；不想要就忽略这条',
         },
  )

  项.push({
    项: '配置文件',
    状态: '✅',
    说明: 配置路径 || '默认（没写过就用内置默认值）',
  })

  return {
    ok: 好(能力 && 能力.body),
    说明: 'ok=false 就是有硬伤（一般是身体没装）；⛔ 表示这台机器本来就没有，不影响别的',
    检查项: 项,
  }
}

// ---------- 能力快照：整份插件共用一份，定期刷新 ----------
const 能力快照 = {
  body: { available: true, reason: '' },
  speak: { available: true, provider: 'auto', reason: '' },
  listen: { available: true, mode: 'auto', reason: '' },
  dida: { available: true, mode: 'auto', reason: '' },
  探测于: 0,
  探过了: false,
}

// ---------- 嘀嗒清单：把「提醒」算成时刻 ----------
//
// 滴答任务里的提醒长这样：{ id, trigger: 'TRIGGER:-PT0S' }，
// trigger 是 ISO 8601 时长，相对 dueDate 的偏移（负 = 提前）。目前用户库里全是 -PT0S（到点）。
// dueDate 是 UTC 串（形如 2025-01-25T12:00:00.000+0000），任务自带 timeZone 但不影响
// 绝对时刻，所以这里统一按时间戳算，展示/安静时段才用本地时间。

/** 'TRIGGER:-PT10M' → -600（秒）；认 PnDTnHnMnS / PT0S。认不出来返回 null。 */
export function 解析偏移秒(触发) {
  const 原 = String(触发 || '').trim().replace(/^TRIGGER:/i, '')
  const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(原)
  if (!m) return null
  const [, 负号, 天, 时, 分, 秒] = m
  const 总 = Number(天 || 0) * 86400 + Number(时 || 0) * 3600 + Number(分 || 0) * 60 + Number(秒 || 0)
  if (!Number.isFinite(总)) return null
  // 0 秒别返回 -0（比较起来还是 0，但看着别扭，测试也会挑刺）
  return 负号 && 总 !== 0 ? -总 : 总
}

/** 一个任务的所有提醒时刻（毫秒时间戳）。没到期日/没提醒返回 [] */
export function 算提醒时刻(任务) {
  const 出 = []
  const 到期 = Date.parse((任务 && 任务.dueDate) || '')
  if (!Number.isFinite(到期)) return 出
  const 提醒们 = Array.isArray(任务 && 任务.reminders) ? 任务.reminders : []
  for (const r of 提醒们) {
    const 偏移 = 解析偏移秒(r && r.trigger)
    if (偏移 === null) continue
    const 时刻 = 到期 + 偏移 * 1000
    if (!Number.isFinite(时刻)) continue
    出.push({ 键: `${任务.id}:${(r && r.id) || 偏移}`, 时刻, 标题: String(任务.title || '').trim() })
  }
  return 出
}

/** 这个任务该不该置理：已完成/已删除/清单静音都跳过 */
export function 该理这个任务(任务, 清单映射) {
  if (!任务) return false
  if (Number(任务.status) === 2) return false
  if (任务.deleted === true) return false
  const 清单 = 清单映射 && 清单映射.get ? 清单映射.get(任务.projectId) : null
  if (清单 && (清单.muted === true || 清单.closed === true)) return false
  return true
}

/** 同一批到点的合成一句：一条就「到点：X」，多条就「到点 3 件：X、Y、Z…」 */
export function 合并提醒(到点们, 上限 = 40) {
  const 题 = (到点们 || []).map((x) => String((x && x.标题) || '').trim()).filter(Boolean)
  if (!题.length) return ''
  if (题.length === 1) return `到点：${题[0]}`
  const 头 = `到点 ${题.length} 件：`
  let 文 = 头
  for (const t of 题) {
    const 下一段 = (文 === 头 ? '' : '、') + t
    if (文.length + 下一段.length > 上限) {
      文 += '…'
      break
    }
    文 += 下一段
  }
  return 文
}

/** "23:00" → 1380（分钟）。认不出来返回 null */
export function 解析时分(文) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(文 || '').trim())
  if (!m) return null
  const 时 = Number(m[1])
  const 分 = Number(m[2])
  if (时 > 23 || 分 > 59) return null
  return 时 * 60 + 分
}

/** 现在在不在安静时段（支持跨零点，比如 23:00→08:00） */
export function 在安静时段(时, 分, 从, 到) {
  const 现 = 时 * 60 + 分
  const a = 解析时分(从)
  const b = 解析时分(到)
  if (a === null || b === null || a === b) return false
  return a < b ? 现 >= a && 现 < b : 现 >= a || 现 < b
}

/**
 * 从本机滴答客户端的 SQLite 里读登录凭证，直接当 Cookie 的 t= 用。
 * 客户端重新登录后这里读到的新值会跟着变 —— 不用手工维护 cookie。
 */
export async function 读嘀嗒凭证(dida) {
  const 配 = dida || {}
  if (配.cookie) return String(配.cookie)
  const 库 = 配.dbPath || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Tick_Tick', 'TickTick.db')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(库, { readOnly: true })
  try {
    const 行 = db.prepare('select LoginUserAuth a from CommonSettings limit 1').get()
    return 行 && 行.a ? String(行.a) : ''
  } finally {
    try {
      db.close()
    } catch {
      /* 关不掉就算了 */
    }
  }
}

// ---------- dsh-pet：HTTP 说话 ----------
function 宠物基址(ctx, cfg) {
  let 端口 = 0
  try {
    // 优先用注入进来的 webServer（没 inject 的 ctx 读不到服务）
    if (注入过的端口) {
      const p = 注入过的端口()
      if (typeof p === 'number' && p > 0) 端口 = p
    }
    if (!端口) {
      let ws = null
      if (typeof ctx.get === 'function') ws = ctx.get('webServer')
      if (!ws) ws = ctx.webServer
      if (ws && typeof ws.port === 'number' && ws.port > 0) 端口 = ws.port
    }
  } catch {
    /* 拿不到就走配置兜底 */
  }
  if (!端口) 端口 = Number(cfg.petPort) || 0
  if (!端口) return null
  return `http://127.0.0.1:${端口}/dsh-pet-7340`
}

// 我们广播出去的句子：轮询宠物气泡时要跳过它们，否则自己说的话会被自己再念一遍
const 我们发的 = []
function 记我们发的(t) {
  我们发的.push(t)
  if (我们发的.length > 30) 我们发的.shift()
}

/** 记住桌宠真实的显示模式（web / desktop / both）。它自己会告诉我们，抄一次就不会再错。 */
let 记着的surface = ''

async function 说给桌宠(ctx, cfg, 文本) {
  const 基 = 宠物基址(ctx, cfg)
  if (!基) return { ok: false, reason: 'no-port', message: '拿不到 DSH 的 web 端口（dsh-pet 没跑？）' }
  const 宠物 = encodeURIComponent(cfg.petId || 'main')
  const 送 = async (地址, 体) => {
    const 回 = await fetch(地址, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(体 || {}),
      signal: AbortSignal.timeout(5000),
    })
    return 回.json()
  }

  const 发一遍 = async (面) => {
    const 面码 = encodeURIComponent(面)
    let 锁
    try {
      锁 = await 送(`${基}/lock?pet=${宠物}&surface=${面码}`, { ttl: 120000 })
    } catch (错误) {
      return { ok: false, reason: 'unreachable', message: String((错误 && 错误.message) || 错误) }
    }
    if (!锁 || !锁.ok) return 锁 || { ok: false, reason: 'lock-failed' }

    const 锁号 = 锁.lockId
    try {
      const 结果 = await 送(`${基}/broadcast?pet=${宠物}&surface=${面码}&lock=${encodeURIComponent(锁号)}`, {
        text: 文本,
        duration: cfg.bubbleMs,
        anim: true,
      })
      if (结果 && 结果.ok) 记我们发的(文本)
      return 结果
    } catch (错误) {
      return { ok: false, reason: 'broadcast-error', message: String((错误 && 错误.message) || 错误) }
    } finally {
      try {
        await 送(`${基}/lock/release?pet=${宠物}`, { lockId: 锁号 })
      } catch {
        /* 释放失败就等它自己过期（默认 2 分钟） */
      }
    }
  }

  let 面 = 记着的surface || cfg.surface || 'web'
  let 结果 = await 发一遍(面)
  // 桌宠在哪块屏幕上显示是它说了算（设置页一改就变），它会把真实模式回给我们，照着再发一遍。
  if (结果 && 结果.reason === 'pet-not-displayed' && 结果.display && 结果.display !== 面) {
    面 = 结果.display
    记着的surface = 面
    记日志(ctx, `桌宠的显示模式是 ${面}，按这个重发`)
    结果 = await 发一遍(面)
  }
  return 结果
}

// ---------- 嗓子 ----------
/** 正在播的那个 powershell；新的来了先掐掉它（老桌宠 Voice.cs 的 mySeq 同一件事）。 */
let 当前播放 = null

function 掐掉正在播的() {
  const 旧 = 当前播放
  当前播放 = null
  if (!旧) return
  try {
    旧.kill()
  } catch {
    /* 已经退出了 */
  }
}

function 播文件(文件) {
  const 脚本 =
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `$p = New-Object System.Media.SoundPlayer('${文件.replace(/'/g, "''")}'); ` +
    `$p.PlaySync(); $p.Dispose(); Remove-Item -LiteralPath '${文件.replace(/'/g, "''")}' -Force`
  掐掉正在播的()
  return new Promise((收) => {
    let 收过 = false
    const 收口 = () => {
      if (收过) return
      收过 = true
      if (当前播放 === 子) 当前播放 = null
      收()
    }
    const 子 = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', 脚本], {
      windowsHide: true,
      stdio: 'ignore',
    })
    当前播放 = 子
    子.on('error', 收口)
    子.on('exit', 收口)
    setTimeout(收口, 120000)
  })
}

/** 老桌宠的写法：按 SAPI 念一段字（不落 wav，直接让系统嗓子说）。 */
function 念SAPI(文, 配置) {
  const 转义 = (s) => String(s || '').replace(/'/g, "''")
  const 选嗓 = 配置.voice
    ? `try { $s.SelectVoice('${转义(配置.voice)}') } catch {}; `
    : // 没指定就挑一台中文女声，免得拿英文嗓子念中文
      `try { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female, [System.Speech.Synthesis.VoiceAge]::Adult, 0, [System.Globalization.CultureInfo]::new('zh-CN')) } catch {}; `
  // 自测用：PETVOICE_SILENT_WAV=<路径> 时不外放，改成写文件，方便在跑测里验证嗓子通不通
  const 静音到 = process.env.PETVOICE_SILENT_WAV
  const 出声 = 静音到
    ? `$s.SetOutputToWaveFile('${转义(静音到)}'); $s.Speak('${转义(文)}'); $s.Dispose()`
    : `$s.Speak('${转义(文)}'); $s.Dispose()`
  const 脚本 =
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `Add-Type -AssemblyName System.Speech; ` +
    `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.Rate = ${Math.max(-10, Math.min(10, Number(配置.rate) || 0))}; ` +
    `$s.Volume = ${Math.max(0, Math.min(100, Number(配置.volume) || 90))}; ` +
    选嗓 +
    出声
  掐掉正在播的()
  return new Promise((收) => {
    let 收过 = false
    const 收口 = () => {
      if (收过) return
      收过 = true
      if (当前播放 === 子) 当前播放 = null
      收()
    }
    const 子 = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', 脚本], {
      windowsHide: true,
      stdio: 'ignore',
    })
    当前播放 = 子
    子.on('error', 收口)
    子.on('exit', 收口)
    setTimeout(收口, 120000)
  })
}

/** 克隆嗓：GPT-SoVITS 合成 wav 字节。超时/报错都往上抛，由调用方降级。 */
async function 合成(ctx, cfg, 文本) {
  const s = cfg.sovits || 默认.sovits
  if (!s.url) throw new Error('没配 sovits.url')
  const 超时 = Math.max(500, Number(s.timeoutMs) || 3000)
  const 体 = {
    text: 文本,
    text_lang: s.lang || 'zh',
    ref_audio_path: s.refAudio,
    prompt_text: s.promptText || '',
    prompt_lang: s.lang || 'zh',
    speed_factor: Math.min(2, Math.max(0.5, Number(s.speed) || 1)),
    media_type: 'wav',
    streaming_mode: false,
  }
  const 回 = await fetch(String(s.url).replace(/\/+$/, '') + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(体),
    // 3 秒不答就别等了：宁可换嗓，也别让她干张嘴
    signal: AbortSignal.timeout(超时),
  })
  if (!回.ok) {
    const 因 = (await 回.text().catch(() => '')).slice(0, 160)
    throw new Error(`GPT-SoVITS HTTP ${回.status}：${因}`)
  }
  const 字节 = Buffer.from(await 回.arrayBuffer())
  if (字节.length < 200) throw new Error('GPT-SoVITS 回了空音频')
  return 字节
}

function 落盘(字节) {
  const 目录 = join(家目录(), 'dsh-pet-voice')
  mkdirSync(目录, { recursive: true })
  try {
    for (const f of readdirSync(目录)) {
      const 时间 = Number(/say-(\d+)\.wav/.exec(f)?.[1] || 0)
      if (f.endsWith('.wav') && Date.now() - 时间 > 120000) {
        try {
          unlinkSync(join(目录, f))
        } catch {
          /* 还在播 */
        }
      }
    }
  } catch {
    /* 目录刚开始是空的 */
  }
  const 文件 = join(目录, `say-${Date.now()}.wav`)
  writeFileSync(文件, 字节)
  return 文件
}

// ---------- 嘀嗒：运行快照（给 /dida 诊断口用）----------
const 嘀嗒状态 = {
  凭证: false,
  已排: 0,
  下一条: null,
  上次拉取: 0,
  任务数: 0,
  错误: '',
}

// ---------- 嘀嗒：已念记录（重启不重念） ----------
function 已念文件() {
  return join(家目录(), 'dsh-pet-voice', 'dida-fired.json')
}

function 读已念表() {
  try {
    const 原 = JSON.parse(readFileSync(已念文件(), 'utf8'))
    return 原 && typeof 原 === 'object' ? 原 : {}
  } catch {
    return {}
  }
}

function 存已念表(表) {
  try {
    const 目录 = join(家目录(), 'dsh-pet-voice')
    mkdirSync(目录, { recursive: true })
    // 只留最近 500 条，免得文件越滚越大
    const 条目 = Object.entries(表).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 500)
    writeFileSync(已念文件(), JSON.stringify(Object.fromEntries(条目), null, 1))
  } catch {
    /* 记不住就退化成"可能重念一次"，不影响用 */
  }
}

// ---------- 转写（懒取 speechToText，拿不到就 503） ----------// 注意：没有 inject 过的 ctx 读不到服务（cordis 会报 "cannot get property ... without inject"
// 或直接返回 undefined），所以真正的服务句柄要在 apply 里 ctx.inject(['speechToText'], …) 拿到。
let 注入过的语音服务 = null
let 注入过的端口 = null

function 语音服务(ctx) {
  try {
    if (注入过的语音服务) {
      const s = 注入过的语音服务()
      if (s) return s
    }
    if (typeof ctx.get === 'function') {
      const s = ctx.get('speechToText')
      if (s) return s
    }
    return ctx.speechToText || null
  } catch {
    return null
  }
}

function 语音状态(ctx) {
  const stt = 语音服务(ctx)
  if (!stt) return null
  try {
    if (typeof stt.snapshot === 'function') return stt.snapshot()
  } catch {
    /* 状态坏了就当没状态 */
  }
  return null
}

/**
 * DSH 的 speechToText.snapshot() 不是扁平对象，真实形状是：
 *   { providers: [{ id, name, languages, preparation: { phase, steps, ... } }],
 *     selection: { providerId, language } }
 * 早先按 状态.phase / 状态.providerId 读，永远读不到 → 永远回 425「识别模型还在准备」。
 */
function 取准备(状态) {
  if (!状态 || typeof 状态 !== 'object') return { providerId: '', 准备: null }
  const 选 = (状态.selection && 状态.selection.providerId) || ''
  const 列 = Array.isArray(状态.providers) ? 状态.providers : []
  const 中 = 列.find((p) => p && p.id === 选) || 列[0] || null
  return { providerId: 选 || (中 && 中.id) || '', 准备: (中 && 中.preparation) || null }
}

function 已就绪(状态) {
  const 准 = 取准备(状态).准备
  if (!准) return false
  return 准.phase === 'ready'
}

async function 读体(req, 上限 = 8 * 1024 * 1024) {
  const 块 = []
  let 共 = 0
  for await (const 片 of req) {
    共 += 片.length
    if (共 > 上限) throw new Error('请求体太大')
    块.push(片)
  }
  return Buffer.concat(块)
}

// ---------- 给测试用的出口（不参与运行时逻辑） ----------
  // ---------- 宠物自己的气泡 → 念出来 ----------
// 宠物右键那个对话框（dsh-pet 的 /chat）是它自己调的模型（sessionId=PET_CALL_IDENTITY），
// 不走 DSH 会话，所以 session/event 里根本看不到。它把回复写进 pets.<id>.say，
// 这里长轮询 /state 盯住 say 变化，再念出来。
function 清理气泡文本(文) {
  // 去掉 dsh-pet 的配图标记 [图:名字] 和表情，只留能念的字
  return 去表情(String(文 || '').replace(/\[图[:：][^\]]*\]/g, '')).trim()
}

let 盯气泡停 = false
// 测试环境（node --test）里只跑几轮就收工，别把测试进程挂住
const 盯气泡最多轮 = process.env.NODE_TEST_CONTEXT ? 3 : Infinity

function 睡(毫秒) {
  return new Promise((r) => {
    const 句柄 = setTimeout(r, 毫秒)
    // 不要为了这个定时器把进程挂着（否则 node --test 永远退不出去）
    if (句柄 && typeof 句柄.unref === 'function') 句柄.unref()
  })
}


export const __test = {
  清理气泡文本,
  停盯气泡: () => { 盯气泡停 = true },
  清干净,
  切一句,
  合成,
  说给桌宠,
  宠物基址,
  念SAPI,
  取准备,
  已就绪,
  // 嘀嗒提醒
  解析偏移秒,
  算提醒时刻,
  该理这个任务,
  合并提醒,
  解析时分,
  在安静时段,
  读嘀嗒凭证,
  读已念表,
  存已念表,
  // 能力开关
  三档,
  归一化配置,
  探说,
  探听,
  探活地址,
  探身体,
  探提醒,
  探全部能力,
  体检文案,
  体检清单,
  重置注入: () => {
    注入过的语音服务 = null
    注入过的端口 = null
    记着的surface = ''
  },
}

// ---------- 主逻辑 ----------
export function apply(ctx) {
  /** 每个会话这一轮最后的 assistant 文本 */
  const 待念 = new Map()
  /** 队列里排着的话（只留最新几条） */
  const 队列 = []
  let 忙 = false
  let 上次 = null
  /** 网页报上来的「你正看着的会话」 */
  let 前台会话 = ''

  async function 念(文本, 选项 = {}) {
    // 选项.speak === false：只冒泡，不出声（安静时段、静音时用）
    const 要出声 = 选项.speak !== false
    const cfg = 读配置()
    const 桌宠 = await 说给桌宠(ctx, cfg, 文本)
    if (!桌宠 || !桌宠.ok) {
      const 因 = (桌宠 && (桌宠.reason || 桌宠.message)) || '未知'
      记日志(ctx, `桌宠没说成：${因}`)
    } else {
      记日志(ctx, `桌宠张嘴了：${文本.slice(0, 40)}`)
    }
    if (!要出声) {
      记日志(ctx, `（安静模式，只冒泡没出声）：${文本.slice(0, 24)}`)
      return
    }
    if (cfg.voice === 'off') return
    // 探测结论说"这台念不了"就别硬试了（也别每句都报错）
    if (能力快照.探过了 && 能力快照.speak && 能力快照.speak.available === false) {
      记日志(ctx, `（这台念不了：${能力快照.speak.reason}）只冒泡`)
      return
    }
    if (cfg.voice === 'local') {
      try {
        const 字节 = await 合成(ctx, cfg, 文本)
        await 播文件(落盘(字节))
        记日志(ctx, `念完了（克隆嗓 ${字节.length} 字节）：${文本.slice(0, 24)}`)
        return
      } catch (错误) {
        记日志(ctx, `克隆嗓没出声，退 SAPI：${String((错误 && 错误.message) || 错误)}`)
      }
    }
    // 下面这行是兜底：voice=sapi 直接走，voice=local 失败也走
    try {
      await 念SAPI(文本, cfg.sapi || 默认.sapi)
      记日志(ctx, `念完了（SAPI 兜底）：${文本.slice(0, 24)}`)
    } catch (错误) {
      记日志(ctx, `SAPI 也没出声：${String((错误 && 错误.message) || 错误)}`)
    }
  }

async function 排空() {
    if (忙) return
    忙 = true
    try {
      while (队列.length) {
        const 件 = 队列.shift()
        try {
          await 念(件.文本, { speak: 件.静音 !== true })
          上次 = { 文本: 件.文本, 于: Date.now(), 会话: 件.会话 }
        } catch (错误) {
          记日志(ctx, `这一句没念成：${String((错误 && 错误.message) || 错误)}`)
        }
      }
    } finally {
      忙 = false
    }
  }

async function 盯气泡(ctx) {
  let since = 0
  let 上次文本 = ''
  let 连续失败 = 0
  for (let 轮 = 0; 轮 < 盯气泡最多轮; 轮++) {
    if (盯气泡停) return
    const cfg = 读配置()
    if (!cfg.enabled || cfg.speakPetBubbles === false) {
      await 睡(5000)
      continue
    }
    const 基 = 宠物基址(ctx, cfg)
    if (!基) {
      await 睡(5000)
      continue
    }
    try {
      const 宠物 = encodeURIComponent(cfg.petId || 'main')
      // dsh-pet 的 timeout 只收 0..10000，给大了直接 400 invalid timeout（踩过）
      const 回 = await fetch(`${基}/state?pet=${宠物}&since=${since}&timeout=8000`, {
        signal: AbortSignal.timeout(15000),
      })
      if (!回.ok) {
        const 因 = await 回.text().catch(() => '')
        throw new Error(`state HTTP ${回.status}：${String(因).slice(0, 120)}`)
      }
      const j = await 回.json()
      if (j && typeof j.counter === 'number') since = j.counter
      连续失败 = 0
      const 气泡 = j && j.pets && j.pets[cfg.petId || 'main'] && j.pets[cfg.petId || 'main'].say
      const 文 = 气泡 && 气泡.data && 气泡.data.text ? 清理气泡文本(气泡.data.text) : ''
      if (!文 || 文 === 上次文本) {
        await 睡(250)
        continue
      }
      上次文本 = 文
      if (我们发的.includes(文)) continue // 自己刚广播的，跳过
      if (文.length < 1) continue
      记日志(ctx, `宠物自己说了一句，念它：${文.slice(0, 24)}`)
      排一句(文.slice(0, 60), 'pet-chat')
    } catch (错误) {
      连续失败 += 1
      // 别再把错误吞掉了：之前 timeout=15000 被 400 拒了，日志里一点痕迹都没有
      if (连续失败 <= 3 || 连续失败 % 30 === 0) 记日志(ctx, `盯气泡失败第 ${连续失败} 次：${String((错误 && 错误.message) || 错误)}`)
      await 睡(Math.min(30000, 2000 * 连续失败))
    }
  }
}

  function 排一句(文本, 会话, 静音 = false) {
    // 新的直接掐掉正在播的，并且把排队里旧的清掉 —— 只念最新的
    if (忙) {
      队列.length = 0
      掐掉正在播的()
    }
    队列.push({ 文本, 会话, 静音: 静音 === true })
    if (队列.length > 3) 队列.shift()
    void 排空()
  }

  // 最近 20 条 session/event 的类型与 id：出问题看 /dsh-pet-voice/events 就知道事件到底来没来
const 最近事件 = []
function 记事件(类型, id) {
  if (!类型) return
  最近事件.push({ 于: Date.now(), 类型, 会话: id })
  if (最近事件.length > 20) 最近事件.shift()
}

function 取会话id(会话对象) {
  const 头 = 会话对象 && 会话对象.header
  return String((头 && 头.id) || (会话对象 && 会话对象.id) || '')
}

// 一个 turn 只能念一次：turn/end 与 agent/turn-stopping 可能双双到来
  const 已念过 = new Map()

  function 该念了(id, turn, cfg) {
    // 只念你眼前那个会话：不然子代理（刷 B 站那种）也会被念出来。
    // id 为空说明这个版本没给到 id，宁可念也不要不念
    // 前台会话对不上也照念（先保证出声），只在日志里留一笔；要收紧再说
    if (cfg.mainSessionOnly && 前台会话 && id && id !== 前台会话) {
      记日志(ctx, `前台是 ${前台会话}，这句来自 ${id}，照念`)
    }
    if (turn !== undefined && 已念过.get(id) === turn) return
    if (turn !== undefined) 已念过.set(id, turn)
    const 全文 = 待念.get(id)
    待念.delete(id)
    if (!全文) return
    const 句 = 挑要说的话(全文, cfg.maxChars)
    if (!句 || 句.length < 2) {
      记日志(ctx, `没有能念的句子（原文 ${全文.slice(0, 30)}）`)
      return
    }
    记日志(ctx, `要念：${句}`)
    排一句(句, id)
  }

  // ⚠️ 2026-10-27 实测：这个版本的 DSH **根本不在 session/event 流里发 turn/end** ——
  //    /dsh-pet-voice/events 里从头到尾只有 tool/call、tool/result、step/start、
  //    step/end、assistant/message 五种，所以「等回合结束再念」永远等不到，一句都不出声。
  //    改成「最后一条 assistant 之后静默 1.2 秒就念」：不依赖任何回合结束事件名，
  //    真正的结束事件来了就立刻念（先到先念，另一个到时空跑一次，不会念两遍）。
  const 沉默计时 = new Map()

  function 安排沉默念(id, cfg) {
    const 旧计时 = 沉默计时.get(id)
    if (旧计时) clearTimeout(旧计时)
    const 句柄 = setTimeout(() => {
      沉默计时.delete(id)
      该念了(id, undefined, 读配置())
    }, 1200)
    if (句柄 && typeof 句柄.unref === 'function') 句柄.unref()
    沉默计时.set(id, 句柄)
  }

  function 取消沉默念(id) {
    const 旧计时 = 沉默计时.get(id)
    if (旧计时) { clearTimeout(旧计时); 沉默计时.delete(id) }
  }

  ctx.on('session/event', (session, event) => {
    const cfg = 读配置()
    if (!cfg.enabled) return
    // ⚠️ dsh 0.2.x 的会话 id 在 session.header.id 上，session.id 是 undefined；
    //    之前只读 session.id，于是 id 恒为空，一句都不念（第 4 个真因）。
    const id = 取会话id(session)
    记事件(event && event.type, id)
    const 类型 = event && event.type

    if (类型 === 'assistant/message') {
      const 全文 = 抽文本(event && event.data && event.data.message && event.data.message.content)
      if (全文) {
        待念.set(id, 全文)
        安排沉默念(id, cfg)
      }
      return
    }

    // 有回合结束事件就立刻念（名字各版本可能不同，能认出几个算几个）
    if (类型 === 'turn/end' || 类型 === 'turn/ended' || 类型 === 'turn/stop' || 类型 === 'turn/finish') {
      取消沉默念(id)
      该念了(id, event && event.data && event.data.turn, cfg)
    }
  })

  // 兜底：`agent/turn-stopping` 是 agent 级 cordis 事件（不进 session/event 流），
  // 上面那条万一漏了（比如某个版本只发它），这里再兜一次；同一个 turn 不会念两遍。
  ctx.on('agent/turn-stopping', (载荷) => {
    try {
      const cfg = 读配置()
      if (!cfg.enabled) return
      let id = 取会话id(载荷 && 载荷.agent && 载荷.agent.session)
      // 拿不到会话 id 时退回"你眼前那个会话"：否则 待念 里的内容永远对不上，一句都不念
      if (!id) id = 前台会话 || ''
      取消沉默念(id)
      该念了(id, 载荷 && 载荷.turn, cfg)
    } catch (错误) {
      记日志(ctx, `turn-stopping 兜底出错：${String((错误 && 错误.message) || 错误)}`)
    }
  })

  // 网页半边与外部测试口（只挂 127.0.0.1，和 dsh-pet 一个口径：无鉴权）
  // webServer 在 apply 这一刻还没就绪，必须等它注入进来（V1 就是栽在这里：ctx.get 拿不到，静默 404）
  const 挂路由 = (范围) => {
    const ws = 范围.webServer
    if (!ws || typeof ws.register !== 'function') return
    注入过的端口 = () => ws.port
    范围.effect(
        () =>
          ws.register({
            kind: 'prefix',
            path: '/dsh-pet-voice',
            handler: async (req, res) => {
              const 头 = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
              const 回 = (码, 体) => {
                try {
                  res.writeHead(码, 头)
                  res.end(JSON.stringify(体))
                } catch {
                  /* 对端断了 */
                }
              }
              const 地址 = new URL(req.url || '/', 'http://127.0.0.1')
              const 路 = 地址.pathname.replace(/^\/dsh-pet-voice/, '') || '/'
              const cfg = 读配置()

              if (路 === '/' || 路 === '') {
                return 回(200, { ok: true, 说明: 'dsh-pet-voice', 路口: ['/doctor', '/capabilities', '/state', '/events', '/say', '/dida', '/stt', '/stt/status', '/focus'] })
              }

              if (路 === '/doctor') {
                // 逐条体检：装没装身体、说/听/嘀嗒各是什么状态、缺了怎么补
                const 配置路 = process.env.DSH_PET_VOICE_CONFIG || join(家目录(), 'dsh-pet-voice.json')
                let 有配置 = false
                try {
                  readFileSync(配置路)
                  有配置 = true
                } catch {
                  /* 没写过就是全默认 */
                }
                return 回(200, 体检清单(能力快照, cfg, 有配置 ? 配置路 : ''))
              }

              if (路 === '/capabilities') {
                // 网页半边拿这个决定「按住说话」入口是正常还是置灰
                return 回(200, {
                  ok: true,
                  探测于: 能力快照.探测于 || null,
                  body: 能力快照.body,
                  speak: 能力快照.speak,
                  listen: 能力快照.listen,
                  dida: 能力快照.dida,
                  文案: 体检文案(能力快照),
                })
              }

              if (路 === '/dida') {
                // 诊断口：凭证有没有、排了几条、下一条是什么时候
                return 回(200, {
                  ok: true,
                  enabled: cfg.dida && cfg.dida.enabled !== false,
                  安静时段: `${(cfg.dida && cfg.dida.quietFrom) || ''}-${(cfg.dida && cfg.dida.quietTo) || ''}`,
                  ...嘀嗒状态,
                  下一条: 嘀嗒状态.下一条
                    ? { 时刻: new Date(嘀嗒状态.下一条.时刻).toLocaleString('zh-CN'), 标题: 嘀嗒状态.下一条.标题 }
                    : null,
                })
              }

              if (路 === '/dida/fire' && req.method === 'POST') {
                // 验证用：不等真提醒到点，直接按提醒的样式念一句（走同一条队列）
                // 注意 读体() 返回的是 Buffer，不是对象（跟 /say 一个套路）
                const 体 = await 读体(req, 64 * 1024)
                let 文 = ''
                let 静音 = false
                try {
                  const j = JSON.parse(体.toString('utf8') || '{}')
                  文 = String(j.text || '').trim()
                  静音 = j['静音'] === true || j.mute === true
                } catch {
                  /* 空体或坏 JSON 就用下面那句默认 */
                }
                if (!文) 文 = String(地址.searchParams.get('text') || '').trim()
                if (!文) 文 = '到点：测一下提醒'
                排一句(文.slice(0, 60), 'dida', 静音)
                return 回(200, { ok: true, 念了: 文.slice(0, 60), 静音 })
              }

              if (路 === '/events') {
                return 回(200, { ok: true, 最近: 最近事件, 前台会话 })
              }

              if (路 === '/state') {
                const 状态 = 语音状态(ctx)
                return 回(200, {
                  ok: true,
                  enabled: cfg.enabled,
                  petId: cfg.petId,
                  voice: cfg.voice,
                  mainSessionOnly: cfg.mainSessionOnly,
                  前台会话,
                  队列: 队列.length,
                  上次,
                  stt: { 服务: !!语音服务(ctx), phase: 状态 && 状态.phase, 就绪: 已就绪(状态) },
                })
              }

              if (路 === '/focus' && req.method === 'POST') {
                const 体 = await 读体(req, 64 * 1024)
                let 会话 = ''
                try {
                  会话 = String(JSON.parse(体.toString('utf8') || '{}').sessionId || '')
                } catch {
                  /* 空体就是清空 */
                }
                前台会话 = 会话
                return 回(200, { ok: true, 前台会话 })
              }

              if (路 === '/say' && req.method === 'POST') {
                const 体 = await 读体(req, 64 * 1024)
                let 文 = ''
                try {
                  文 = String(JSON.parse(体.toString('utf8') || '{}').text || '').trim()
                } catch {
                  /* 空体当成没给 */
                }
                if (!文) 文 = String(地址.searchParams.get('text') || '').trim()
                if (!文) return 回(400, { ok: false, error: '没给 text' })
                排一句(文.slice(0, 200), 'manual')
                return 回(200, { ok: true })
              }

              if (路 === '/stt/status') {
                const 状态 = 语音状态(ctx)
                if (!语音服务(ctx)) return 回(503, { ok: false, code: 'no-service', error: 'DSH 的语音服务没开着' })
                const { providerId, 准备 } = 取准备(状态)
                return 回(200, {
                  ok: true,
                  phase: 准备 && 准备.phase,
                  step: 准备 && 准备.step,
                  steps: (准备 && 准备.steps) || [],
                  progress: 准备 && 准备.totalBytes ? Math.round((准备.completedBytes / 准备.totalBytes) * 100) : undefined,
                  就绪: 已就绪(状态),
                  provider: providerId || null,
                  providers: ((状态 && 状态.providers) || []).map((p) => ({ id: p.id, name: p.name })),
                })
              }

              if (路 === '/stt' && req.method === 'POST') {
                // 能力开关说"这台听不了"就早点回，别让网页那边干等
                if (能力快照.探过了 && 能力快照.listen && 能力快照.listen.available === false) {
                  return 回(503, {
                    ok: false,
                    code: 'listen-off',
                    error: 能力快照.listen.reason || '这台没开语音输入',
                  })
                }
                const stt = 语音服务(ctx)
                if (!stt) return 回(503, { ok: false, code: 'no-service', error: 'DSH 的语音服务没开着' })
                const 体 = await 读体(req, 8 * 1024 * 1024)
                let 音频 = null
                try {
                  音频 = Buffer.from(String(JSON.parse(体.toString('utf8') || '{}').audioBase64 || ''), 'base64')
                } catch {
                  return 回(400, { ok: false, code: 'bad-body', error: 'body 不是 JSON' })
                }
                if (!音频 || 音频.length < 200) return 回(400, { ok: false, code: 'too-short', error: '音频太短' })

                const 状态 = 语音状态(ctx)
                if (!已就绪(状态)) {
                  const { providerId, 准备 } = 取准备(状态)
                  const 相 = 准备 && 准备.phase
                  if (相 !== 'downloading' && 相 !== 'checking' && 相 !== 'loading') {
                    try {
                      stt.prepare(providerId || cfg.stt.providerId || 'sensevoice-local', {
                        downloadSource: cfg.stt.downloadSource,
                      })
                    } catch {
                      /* 已经在准备中 */
                    }
                  }
                  return 回(425, {
                    ok: false,
                    code: 'preparing',
                    phase: 相 || 'unprepared',
                    就绪: false,
                    error: '识别模型还没准备好',
                  })
                }

                let 规格
                try {
                  规格 = stt.resolve({ audio: 音频 })
                } catch (错误) {
                  return 回(400, { ok: false, code: 'resolve', error: String((错误 && 错误.message) || 错误) })
                }
                try {
                  const 结果 = await stt.transcribe(规格, AbortSignal.timeout(Number(cfg.stt.timeoutMs) || 120000))
                  const 文 = String((结果 && 结果.text) || '').trim()
                  return 回(200, {
                    ok: true,
                    text: 文,
                    空白: !文,
                    audioSeconds: (结果 && 结果.audioSeconds) ?? null,
                    inferenceSeconds: (结果 && 结果.inferenceSeconds) ?? null,
                  })
                } catch (错误) {
                  const 文 = String((错误 && 错误.message) || 错误)
                  const 坏 = (错误 && 错误.name === 'SpeechInputError') || /canonical 16 kHz/i.test(文)
                  return 回(坏 ? 400 : 500, { ok: false, code: 坏 ? 'bad-audio' : 'transcribe', error: 文 })
                }
              }

              return 回(404, { ok: false, error: '没有这个路口：' + 路 })
            },
          }),
      'dsh-pet-voice: 路由',
    )
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], 挂路由)
    else 挂路由(ctx)
  } catch {
    /* 没有 webServer 就只做被动念，不影响启动 */
  }

  // 宠物自己的对话框（右键桌宠那个）：它不走 DSH 会话，只能盯气泡
  try {
    void 盯气泡(ctx)
  } catch {
    /* 盯不住也不影响别的 */
  }

  // 语音服务同理：apply 这一刻读不到，必须等注入（读到之前 /stt 会老实回 503）
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['speechToText'], (范围) => {
        注入过的语音服务 = () => 范围.speechToText
        // 语音服务到位了，"听"这个能力可能就从不行变成行 —— 重新探一次
        void 刷新能力并记账()
      })
    }
  } catch {
    /* 没有语音服务就只做被动念 */
  }

  // ---------- 嘀嗒清单：到点了说一句 ----------
  function 启动嘀嗒提醒() {
    const 首配 = 读配置()
    if (!首配.dida || 首配.dida.enabled === false) return
    // 能力探测说这机器用不了滴答（没装客户端/没登录），就别启动了
    if (能力快照.探过了 && 能力快照.dida && 能力快照.dida.available === false) {
      记日志(ctx, `嘀嗒：这台用不了（${能力快照.dida.reason}），不启动提醒`)
      return
    }

    const 已念 = 读已念表()
    const 定时器 = new Map()
    /** 还没响的提醒（键 → 项），响了就摘掉，/dida 的「已排/下一条」靠它算 */
    const 排队中 = new Map()
    let 待合并 = []
    let 合并句柄 = null
    let 停 = false
    let 凭证缓存 = ''
    let 上次提示 = 0

    const 提示一次 = (文) => {
      // 三档纪律：auto 探不到就静默（只记日志），只有 on 才冒泡告诉人
      const 现 = Date.now()
      if (现 - 上次提示 < 3600_000) return
      上次提示 = 现
      记日志(ctx, `嘀嗒：${文}`)
      const 现在的配 = 读配置()
      if (三档(现在的配.dida && 现在的配.dida.mode) !== 'on') return
      排一句(`嘀嗒这边有点问题：${文}`.slice(0, 60), 'dida')
    }

    const 清定时 = () => {
      for (const 句柄 of 定时器.values()) clearTimeout(句柄)
      定时器.clear()
      排队中.clear()
    }

    /** 到点了：先攒 2 秒，同一分钟的几条合成一句 */
    function 到点(项, 配) {
      // 响了就从"排队中"摘掉，否则 /dida 一直显示它
      定时器.delete(项.键)
      排队中.delete(项.键)
      刷新快照()
      if (已念[项.键]) return
      已念[项.键] = Date.now()
      存已念表(已念)
      待合并.push(项)
      if (合并句柄) return
      合并句柄 = setTimeout(() => {
        合并句柄 = null
        const 这一批 = 待合并
        待合并 = []
        if (!这一批.length) return
        const 最新配 = 读配置()
        const 现 = new Date()
        const 静音 = 在安静时段(现.getHours(), 现.getMinutes(), 最新配.dida.quietFrom, 最新配.dida.quietTo)
        const 文 = 合并提醒(这一批, 最新配.maxChars)
        if (!文) return
        记日志(ctx, `嘀嗒到点${静音 ? '（安静时段，只冒泡）' : ''}：${文}`)
        排一句(文, 'dida', 静音)
      }, Math.max(500, Number(配.dida.mergeWindowMs) || 默认.dida.mergeWindowMs))
      if (合并句柄 && typeof 合并句柄.unref === 'function') 合并句柄.unref()
    }

    /** 拉一次清单，给未来一周内的提醒各排一个定时器 */
    async function 拉一次() {
      if (停) return
      const 配 = 读配置()
      if (!配.dida || 配.dida.enabled === false) return
      try {
        if (!凭证缓存) 凭证缓存 = await 读嘀嗒凭证(配.dida)
        if (!凭证缓存) {
          提示一次('找不到登录凭证，客户端登录一下就好')
          return
        }
        const 基 = String(配.dida.apiBase || 默认.dida.apiBase).replace(/\/$/, '')
        const 回 = await fetch(`${基}/api/v2/batch/check/0`, {
          headers: {
            Cookie: `t=${凭证缓存}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            Accept: 'application/json',
            // 少了这个头会被判 403 access_forbidden（2026-10-27 实测）
            'x-device': JSON.stringify({ platform: 'web', os: 'web', device: 'chrome', name: '' }),
          },
          signal: AbortSignal.timeout(15000),
        })
        if (回.status === 401 || 回.status === 403) {
          凭证缓存 = ''
          提示一次('凭证失效了，在客户端里重新登录一下')
          return
        }
        if (!回.ok) {
          提示一次(`接口 ${回.status}`)
          return
        }
        const j = await 回.json()
        const 任务们 = (j && j.syncTaskBean && j.syncTaskBean.update) || []
        const 清单们 = new Map(((j && j.projectProfiles) || []).map((p) => [p.id, p]))
        排期(任务们, 清单们, 配)
      } catch (错误) {
        提示一次(`拉清单失败：${String((错误 && 错误.message) || 错误).slice(0, 40)}`)
      }
    }

    function 排期(任务们, 清单们, 配) {
      清定时()
      排队中.clear()
      const 现 = Date.now()
      let 排了 = 0
      for (const 任务 of 任务们) {
        if (!该理这个任务(任务, 清单们)) continue
        for (const 项 of 算提醒时刻(任务)) {
          if (已念[项.键]) continue
          const 差 = 项.时刻 - 现
          // 过期超过 3 分钟的不管（刚启动时别把昨天的一堆补念一遍）
          if (差 < -3 * 60_000) continue
          // 一周以外的先不排（setTimeout 上限也不建议太长）
          if (差 > 7 * 24 * 3600_000) continue
          const 句柄 = setTimeout(() => 到点(项, 读配置()), Math.max(0, 差))
          if (typeof 句柄.unref === 'function') 句柄.unref()
          定时器.set(项.键, 句柄)
          排队中.set(项.键, 项)
          排了 += 1
        }
      }
      嘀嗒状态.凭证 = true
      嘀嗒状态.任务数 = 任务们.length
      嘀嗒状态.上次拉取 = 现
      嘀嗒状态.错误 = ''
      刷新快照()
      记日志(ctx, `嘀嗒：拉了 ${任务们.length} 个任务，排上 ${排了} 个提醒`)
    }

    /** 已排 / 下一条：从还挂着的那批里算，响了就自动少一条 */
    function 刷新快照() {
      嘀嗒状态.已排 = 排队中.size
      let 最近 = null
      for (const 项 of 排队中.values()) {
        if (!最近 || 项.时刻 < 最近.时刻) 最近 = { 时刻: 项.时刻, 标题: 项.标题 }
      }
      嘀嗒状态.下一条 = 最近
    }

    void 拉一次()
    const 刷新 = setInterval(() => void 拉一次(), Math.max(30, Number(首配.dida.pollSeconds) || 120) * 1000)
    if (typeof 刷新.unref === 'function') 刷新.unref()

    // 插件卸载/重载时收摊，别留一堆定时器
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          停 = true
          clearInterval(刷新)
          清定时()
          if (合并句柄) clearTimeout(合并句柄)
        }, 'dsh-pet-voice: 嘀嗒提醒')
      }
    } catch {
      /* 没有 effect 就算了，进程退出时定时器一起没 */
    }
  }

  // ---------- 能力探测 + 首启体检 ----------
  const 首启文件 = () => join(家目录(), 'dsh-pet-voice', 'first-run.json')

  /** 探一下 dsh-pet 在不在：它自己的 /state 能通就算在 */
  async function 身体在吗() {
    const 配 = 读配置()
    const 基 = 宠物基址(ctx, 配)
    if (!基) return false
    try {
      // 只探活，不要长轮询（since/timeout 必须成对，见 探活地址 的注释）
      const 回 = await fetch(探活地址(基, 配.petId), { signal: AbortSignal.timeout(2500) })
      return 回.ok
    } catch {
      return false
    }
  }

  async function 刷新能力并记账() {
    try {
      const 配 = 读配置()
      const 结果 = await 探全部能力(配, !!语音服务(ctx), 身体在吗)
      Object.assign(能力快照, 结果, { 探测于: Date.now(), 探过了: true })
      const 身 = 结果.body.available ? '在' : `不在(${结果.body.reason})`
      const 说 = 结果.speak.available ? 结果.speak.provider : `不能(${结果.speak.reason})`
      const 听 = 结果.listen.available ? '可以' : `不行(${结果.listen.reason})`
      const 提 = 结果.dida.available ? '可以' : `不行(${结果.dida.reason})`
      记日志(ctx, `能力探测：身体=${身} 说=${说} 听=${听} 嘀嗒=${提}`)
    } catch (错误) {
      记日志(ctx, `能力探测出错：${String((错误 && 错误.message) || 错误)}`)
    }
  }

  function 首启体检() {
    const 配 = 读配置()
    if (配.firstRunReport === false) return
    try {
      readFileSync(首启文件())
      return // 体检过了
    } catch {
      /* 还没体检过，继续 */
    }
    const 文 = 体检文案(能力快照)
    记日志(ctx, `首启体检：${文}`)
    try {
      排一句(文, 'first-run')
    } catch {
      /* 宠物没起也至少记了日志 */
    }
    try {
      mkdirSync(join(家目录(), 'dsh-pet-voice'), { recursive: true })
      writeFileSync(首启文件(), JSON.stringify({ at: Date.now(), 能力: 能力快照, 文 }, null, 1))
    } catch {
      /* 记不住就下次再说一遍 */
    }
  }

  // 测试环境里不做这三件事：探测会真连端口、体检会往假宠物里塞一句话，
  // 都会干扰别的用例（2026-10-27 实测：pet-chat 用例被体检那句抢了广播）
  if (process.env.NODE_TEST_CONTEXT) {
    return
  }

  void (async () => {
    await 刷新能力并记账()
    首启体检()
    try {
      启动嘀嗒提醒()
    } catch (错误) {
      记日志(ctx, `嘀嗒提醒没起来：${String((错误 && 错误.message) || 错误)}`)
    }
  })()

  // 能力会变（比如 5 分钟后把 SoVITS 起来了、客户端登录了），定期重新探一次
  try {
    const 能力定时 = setInterval(() => void 刷新能力并记账(), 5 * 60 * 1000)
    if (typeof 能力定时.unref === 'function') 能力定时.unref()
  } catch {
    /* 定时器建不起来就算了 */
  }
}
