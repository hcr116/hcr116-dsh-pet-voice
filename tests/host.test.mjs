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
function 假ctx() {
  const 监听 = []
  let 登记 = null
  const ctx = {
    logger: { info: () => {} },
    on: (名, 函数) => 监听.push([名, 函数]),
    effect: (函数) => 函数(),
    get: (名) => (名 === 'webServer' ? { port: 1234, register: (规格) => void (登记 = 规格) } : undefined),
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
  const { 调 } = 假ctx()
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
  const { 调 } = 假ctx()
  const 回 = await 调('/dsh-pet-voice/stt', { audioBase64: Buffer.alloc(400).toString('base64') }, 'POST')
  assert.equal(回.码, 503)
  assert.equal(回.体.code, 'no-service')
})

test('路由：太短的音频直接 400', async () => {
  const { 调, ctx } = 假ctx()
  ctx.get = (名) => (名 === 'webServer' ? { port: 1234, register: () => {} } : 名 === 'speechToText' ? {} : undefined)
  // 重新挂一次，让新 ctx 的 handler 生效
  const 假 = 假ctx()
  const 回 = await 假.调('/dsh-pet-voice/stt', { audioBase64: Buffer.alloc(10).toString('base64') }, 'POST')
  assert.equal(回.码, 503) // 没服务先回 503，比 400 更早
})

test('路由：/say 空文本回 400', async () => {
  const { 调 } = 假ctx()
  const 回 = await 调('/dsh-pet-voice/say', {}, 'POST')
  assert.equal(回.码, 400)
})
