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
}

function 家目录() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function 读配置() {
  try {
    // DSH_PET_VOICE_CONFIG 只给测试用：指到临时配置，别碰真的那份
    const 路 = process.env.DSH_PET_VOICE_CONFIG || join(家目录(), 'dsh-pet-voice.json')
    const 原 = JSON.parse(readFileSync(路, 'utf8'))
    const 合 = {
      ...默认,
      ...原,
      sovits: { ...默认.sovits, ...(原 && 原.sovits) },
      sapi: { ...默认.sapi, ...(原 && 原.sapi) },
      stt: { ...默认.stt, ...(原 && 原.stt) },
    }
    if (!Number.isFinite(Number(合.bubbleMs)) || Number(合.bubbleMs) < 500) 合.bubbleMs = 默认.bubbleMs
    if (!Number.isFinite(Number(合.maxChars)) || Number(合.maxChars) < 6) 合.maxChars = 默认.maxChars
    return 合
  } catch {
    return { ...默认, sovits: { ...默认.sovits }, sapi: { ...默认.sapi }, stt: { ...默认.stt } }
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

// ---------- 转写（懒取 speechToText，拿不到就 503） ----------
// 注意：没有 inject 过的 ctx 读不到服务（cordis 会报 "cannot get property ... without inject"
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

  async function 念(文本) {
    const cfg = 读配置()
    const 桌宠 = await 说给桌宠(ctx, cfg, 文本)
    if (!桌宠 || !桌宠.ok) {
      const 因 = (桌宠 && (桌宠.reason || 桌宠.message)) || '未知'
      记日志(ctx, `桌宠没说成：${因}`)
    } else {
      记日志(ctx, `桌宠张嘴了：${文本.slice(0, 40)}`)
    }
    if (cfg.voice === 'off') return
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
          await 念(件.文本)
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

  function 排一句(文本, 会话) {
    // 新的直接掐掉正在播的，并且把排队里旧的清掉 —— 只念最新的
    if (忙) {
      队列.length = 0
      掐掉正在播的()
    }
    队列.push({ 文本, 会话 })
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
      if (全文) 待念.set(id, 全文)
      return
    }

    // ⚠️ 一轮结束在 session/event 流里是 `turn/end`（不是 agent/turn-stopping！）
    // V1 把它当成 session/event 的类型，于是永远不触发 —— 打字聊天一句都不念，就是这个 bug。
    if (类型 === 'turn/end') 该念了(id, event && event.data && event.data.turn, cfg)
  })

  // 兜底：`agent/turn-stopping` 是 agent 级 cordis 事件（不进 session/event 流），
  // 上面那条万一漏了（比如某个版本只发它），这里再兜一次；同一个 turn 不会念两遍。
  ctx.on('agent/turn-stopping', (载荷) => {
    try {
      const cfg = 读配置()
      if (!cfg.enabled) return
      const id = 取会话id(载荷 && 载荷.agent && 载荷.agent.session)
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
                return 回(200, { ok: true, 说明: 'dsh-pet-voice', 路口: ['/state', '/events', '/say', '/stt', '/stt/status', '/focus'] })
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
    if (typeof ctx.inject === 'function') ctx.inject(['speechToText'], (范围) => { 注入过的语音服务 = () => 范围.speechToText })
  } catch {
    /* 没有语音服务就只做被动念 */
  }
}
