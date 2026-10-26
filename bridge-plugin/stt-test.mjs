// /stt 三连测：状态 → 未就绪时 425 → prepare 之后 200。
// 用法：node stt-test.mjs   （先在另一个窗口 node mock-server.mjs —— 但要换端口/入口，
// 这里直接用 43112 起自己的假 ctx，不跟桌宠抢 43110。）
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 家 = mkdtempSync(join(tmpdir(), 'petbridge-stt-'))
process.env.DSH_HOME = 家
writeFileSync(join(家, 'pet-bridge.json'), JSON.stringify({ port: 43111 }))

const { apply } = await import('file:///C:/Users/Administrator/.dsh/plugins/dsh-pet-bridge/index.js')

const 监听 = new Map()
const agent = {
  id: 'session-mock',
  session: { id: 'session-mock' },
  async followup() {},
}

const 假语音 = {
  phase: 'unprepared',
  progress: null,
  snapshot() {
    return {
      selection: { providerId: 'sensevoice-local', language: 'auto' },
      providers: [
        { id: 'sensevoice-local', preparation: { phase: this.phase, step: 'model', progress: this.progress } },
      ],
    }
  },
  prepare() {
    this.phase = 'downloading'
    setTimeout(() => { this.phase = 'ready' }, 300)
  },
  resolve({ audio }) { return { provider: 'sensevoice-local', audio } },
  async transcribe() { return { text: '真·听到的字', audioSeconds: 1, inferenceSeconds: 0.2 } },
}

apply({
  agents: { list: () => [agent], get: () => agent },
  sessions: { flush: async () => {} },
  sessionTitle: { get: () => '测' },
  speechToText: 假语音,
  logger: () => ({ info: () => {} }),
  on(类型, 函数) { 监听.set(类型, 函数); return () => {} },
  effect(函数) { return 函数() },
})

const 基 = 'http://127.0.0.1:43111'
const wav = readFileSync('D:/DafeiyuPet/.selftest/silence.wav')
let 失败 = 0
const 检查 = (名, ok, 附加 = '') => {
  console.log((ok ? '✓ ' : '✗ ') + 名 + (附加 ? '  ' + 附加 : ''))
  if (!ok) 失败++
}
const 等 = (ms) => new Promise((r) => setTimeout(r, ms))

// 等服务起来（listen 是异步的）
for (let i = 0; i < 40; i++) { try { await fetch(基 + '/ping'); break } catch { await 等(100) } }
const 状 = await (await fetch(基 + '/stt/status')).json()
检查('状态：unprepared 且未就绪', 状.phase === 'unprepared' && 状.就绪 === false, JSON.stringify(状))

let 回 = await fetch(基 + '/stt', { method: 'POST', body: wav })
let 体 = await 回.json()
检查('未就绪时回 425 + code=preparing 并顺手开始准备', 回.status === 425 && 体.code === 'preparing', 回.status + ' ' + JSON.stringify(体))

await 等(600)
const 状2 = await (await fetch(基 + '/stt/status')).json()
检查('prepare 之后变 ready', 状2.phase === 'ready' && 状2.就绪 === true, JSON.stringify(状2))

回 = await fetch(基 + '/stt', { method: 'POST', body: wav })
体 = await 回.json()
检查('就绪后 200 + 有字', 回.status === 200 && 体.text === '真·听到的字', 回.status + ' ' + JSON.stringify(体))

回 = await fetch(基 + '/stt', { method: 'POST', body: Buffer.alloc(50) })
体 = await 回.json()
检查('太短的音频回 400', 回.status === 400 && 体.code === 'too-short', 回.status + ' ' + JSON.stringify(体))

const ping = await (await fetch(基 + '/ping')).json()
检查('ping 带语音状态', ping.语音 === 'ready' && ping.就绪 === true, JSON.stringify(ping))

console.log(失败 === 0 ? '全部通过' : 失败 + ' 项失败')
process.exit(失败 === 0 ? 0 : 1)
