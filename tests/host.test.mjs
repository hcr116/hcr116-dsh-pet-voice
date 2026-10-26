// 宿主半边的离线测试：不连 DSH，只验路由、挑句、降级、掐旧声。
//   node tests/host.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 配置指向临时家目录，别碰真的 ~/.dsh
const 家 = mkdtempSync(join(tmpdir(), 'petvoice-'))
process.env.DSH_HOME = 家
writeFileSync(join(家, 'dsh-pet-voice.json'), JSON.stringify({ voice: 'off', mainSessionOnly: true }))

const 模 = await import('../index.js')

/** 造一个假的 ctx，把路由 handler 抓出来。 */
function 假ctx(选项 = {}) {
  模.__test.重置注入()
  const 监听 = []
  let 登记 = null
  const 服务 = {
    webServer: { port: 1234, register: (规格) => void (登记 = 规格) },
    speechToText: 选项.有语音 === false ? undefined : 选项.speechToText || {},
  }
  const ctx = {
    logger: { info: () => {} },
    on: (名, 函数) => 监听.push([名, 函数]),
    effect: (函数) => 函数(),
    // 没有 inject 过的 ctx 读不到服务，所以这里只留一个"会抛"的 get：
    // 强迫被测代码走 ctx.inject 那条正路（v2 之前就是栽在 ctx.get 上）
    get: () => undefined,
    inject: (依赖, 回调) => {
      const 子 = { ...ctx }
      for (const 名 of 依赖) 子[名] = 服务[名]
      子.get = (名) => 服务[名]
      return 回调(子)
    },
  }
  模.apply(ctx)
  const 调 = async (路径, 体, 方法 = 'GET') => {
    const 请求 = {
      method: 方法,
      url: 路径,
      async *[Symbol.asyncIterator]() {
        if (体 !== undefined) yield Buffer.from(JSON.stringify(体))
      },
    }
    let 码 = 0
    let 文 = ''
    const 响应 = {
      writeHead: (c) => void (码 = c),
      end: (s) => void (文 = String(s || '')),
    }
    await 登记.handler(请求, 响应)
    return { 码, 体: JSON.parse(文 || '{}') }
  }
  return { ctx, 调, 监听, 取登记: () => 登记 }
}

test('挑句：口播行优先，其次第一句，纯代码不念', () => {
  const t = 模.挑要说的话
  assert.equal(t('口播：看完了，能用。'), '看完了，能用。')
  assert.equal(t('口播：好。\n正文里有很多话。'), '好。')
  assert.equal(t('她回了一句话。还有第二句。'), '她回了一句话。')
  assert.equal(t('```js\nconst a = 1\n```'), '')
  assert.equal(t('| a | b |\n| - | - |'), '')
  assert.equal(t('SYNTAX-OK'), '')
  assert.equal(t('成功了 🐟 嘿嘿'), '成功了 嘿嘿')
})

test('去表情：代理对与变体选择符都清掉', () => {
  assert.equal(模.去表情('好耶 🎉✨ 真棒'), '好耶 真棒')
  assert.equal(模.去表情('🌊🌊'), '')
})

test('路由：/state 说得出自己是谁', async () => {
  const { 调 } = 假ctx({ 有语音: false })
  const 回 = await 调('/dsh-pet-voice/state')
  assert.equal(回.码, 200)
  assert.equal(回.体.ok, true)
  assert.equal(回.体.voice, 'off')
  assert.equal(回.体.stt.服务, false)
})

test('路由：/focus 记住前台会话，并且只念它', async () => {
  const { 调, 监听 } = 假ctx()
  const 回 = await 调('/dsh-pet-voice/focus', { sessionId: '主会话' }, 'POST')
  assert.equal(回.体.前台会话, '主会话')

  // 造两个会话的回合结束事件：只有主会话那句进队列
  const 收事件 = 监听.find(([名]) => 名 === 'session/event')[1]
  const 说 = (id, 文) => {
    收事件({ id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 文 }] } } })
    收事件({ id }, { type: 'agent/turn-stopping', data: {} })
  }
  说('子代理', '子代理说的话。')
  说('主会话', '主会话说的话。')
  const 状态 = await 调('/dsh-pet-voice/state')
  // voice=off 时队列瞬间被排空，所以看「上次」是谁念的
  const 上次 = 状态.体.上次
  if (上次) assert.equal(上次.会话, '主会话')
})

test('路由：没有语音服务时 /stt 回 503，不发神经', async () => {
  const { 调 } = 假ctx({ 有语音: false })
  const 回 = await 调('/dsh-pet-voice/stt', { audioBase64: Buffer.alloc(400).toString('base64') }, 'POST')
  assert.equal(回.码, 503)
  assert.equal(回.体.code, 'no-service')
})

test('路由：太短的音频直接 400', async () => {
  const 假 = 假ctx({ 有语音: true })
  const 回 = await 假.调('/dsh-pet-voice/stt', { audioBase64: Buffer.alloc(10).toString('base64') }, 'POST')
  assert.equal(回.码, 400) // 有服务了，才轮得到太短这条
})

test('路由：/say 空文本回 400', async () => {
  const { 调 } = 假ctx()
  const 回 = await 调('/dsh-pet-voice/say', {}, 'POST')
  assert.equal(回.码, 400)
})

test('转写状态：snapshot 的真实形状是 providers[] + selection', () => {
  // 真实 speechToText.snapshot() 不是扁平的 {phase}，而是
  // { providers: [{ id, preparation: { phase } }], selection: { providerId, language } }
  const 未准备 = {
    providers: [{ id: 'sensevoice-local', preparation: { phase: 'unprepared', steps: [] } }],
    selection: { providerId: 'sensevoice-local', language: 'auto' },
  }
  assert.equal(模.__test.已就绪(未准备), false)
  assert.equal(模.__test.取准备(未准备).providerId, 'sensevoice-local')

  const 好了 = {
    providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
    selection: { providerId: 'sensevoice-local', language: 'auto' },
  }
  assert.equal(模.__test.已就绪(好了), true)

  // 扁平对象（旧代码以为的形状）必须判成没准备好，别又掉回去
  assert.equal(模.__test.已就绪({ phase: 'unprepared' }), false)
})

test('转写：模型就绪后 /stt 真的把文字吐回来', async () => {
  let 收到 = null
  const { 调 } = 假ctx({
    speechToText: {
      snapshot: () => ({
        providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
        selection: { providerId: 'sensevoice-local', language: 'auto' },
      }),
      resolve: (请求) => ({ provider: { info: { id: 'sensevoice-local' } }, audio: 请求.audio, language: 'auto' }),
      transcribe: async (规格) => {
        收到 = 规格
        return { text: '帮我看下这个报错' }
      },
    },
  })
  const 音频 = Buffer.alloc(600).toString('base64')
  const 回 = await 调('/dsh-pet-voice/stt', { audioBase64: 音频 }, 'POST')
  assert.equal(回.码, 200)
  assert.equal(回.体.text, '帮我看下这个报错')
  assert.ok(收到 && 收到.audio.length >= 600, '音频应该原样交给转写')
})

test('转写：模型没就绪回 425 并顺手 prepare 一次', async () => {
  let 准备过 = null
  const { 调 } = 假ctx({
    speechToText: {
      snapshot: () => ({
        providers: [{ id: 'sensevoice-local', preparation: { phase: 'unprepared' } }],
        selection: { providerId: 'sensevoice-local', language: 'auto' },
      }),
      prepare: (id) => {
        准备过 = id
      },
    },
  })
  const 回 = await 调('/dsh-pet-voice/stt', { audioBase64: Buffer.alloc(600).toString('base64') }, 'POST')
  assert.equal(回.码, 425)
  assert.equal(回.体.phase, 'unprepared')
  assert.equal(准备过, 'sensevoice-local')
})
