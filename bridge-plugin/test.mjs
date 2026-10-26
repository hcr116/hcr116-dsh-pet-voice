// 自测：不重启 DSH，用假 ctx 把桥跑起来，验证 /say → followup、/feed 取回答。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const 家 = 'C:\\Users\\Administrator\\.dsh\\plugins\\dsh-pet-bridge\\.test-home'
mkdirSync(家, { recursive: true })
writeFileSync(join(家, 'pet-bridge.json'), JSON.stringify({ port: 43111 }))
process.env.DSH_HOME = 家

const { apply } = await import('file:///C:/Users/Administrator/.dsh/plugins/dsh-pet-bridge/index.js')

const 收到 = []
const 监听 = new Map()
const agent = {
  id: 'session-abc',
  session: { id: 'session-abc' },
  async followup(消息) {
    收到.push(消息)
  },
}
const ctx = {
  agents: { list: () => [agent], get: (id) => (id === 'session-abc' ? agent : undefined) },
  sessions: { flush: async () => {} },
  sessionTitle: { get: () => '测试会话' },
  logger: () => ({ info: () => {} }),
  on(类型, 函数) {
    监听.set(类型, 函数)
    return () => 监听.delete(类型)
  },
  effect(函数) {
    return 函数()
  },
}

apply(ctx)
await new Promise((r) => setTimeout(r, 300))

const 基 = 'http://127.0.0.1:43111'
const 打 = async (路, 体) => {
  const r = await fetch(基 + 路, 体 ? { method: 'POST', body: JSON.stringify(体) } : undefined)
  return { 码: r.status, 体: await r.json() }
}

console.log('ping  ', JSON.stringify(await 打('/ping')))
console.log('会话  ', JSON.stringify(await 打('/sessions')))
console.log('say   ', JSON.stringify(await 打('/say', { text: '你现在能看到我吗' })))
console.log('送进去的消息：', JSON.stringify(收到[0] && 收到[0].content), 'role=', 收到[0] && 收到[0].role, 'source=', JSON.stringify(收到[0] && 收到[0].source))

// 模拟本鲸回答
监听.get('session/event')(agent.session, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '看到了，鱼片。' }, { type: 'reasoning', text: '不该念出来' }] } },
})
console.log('feed  ', JSON.stringify(await 打('/feed?after=0')))
console.log('feed2 ', JSON.stringify(await 打('/feed?after=1')))
console.log('空话  ', JSON.stringify(await 打('/say', { text: '   ' })))
process.exit(0)
