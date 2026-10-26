// 自测台：把真插件用假 ctx 跑起来（默认 43110，跟桌宠配置一致），
// 收到 /say 就模拟本鲸回一句；/stt 那半边给一个假的转写服务。只在联调时手动跑，DSH 里不用它。
import { apply } from 'file:///C:/Users/Administrator/.dsh/plugins/dsh-pet-bridge/index.js'

const 监听 = new Map()

const agent = {
  id: 'session-mock',
  session: { id: 'session-mock' },
  async followup(消息) {
    const 文案 = (消息.content || []).map((x) => x.text).join(' ')
    console.log('[mock] 收到：' + 文案)
    setTimeout(() => {
      const 发 = 监听.get('session/event')
      if (!发) return
      发(agent.session, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '看到的：' + 文案 + '。本鲸在。' }] } },
      })
    }, 400)
  },
}

// 假的 SenseVoice：先说 preparing，prepare 之后 1.5 秒变 ready，转写回固定字。
const 假语音 = {
  phase: 'preparing',
  progress: null,
  snapshot() {
    return {
      selection: { providerId: 'sensevoice-local', language: 'auto' },
      providers: [
        {
          id: 'sensevoice-local',
          label: 'SenseVoice（本地）',
          preparation: { phase: this.phase, step: 'model', progress: this.progress },
        },
      ],
    }
  },
  prepare(id, 选项) {
    console.log('[mock] prepare ' + id + ' ' + JSON.stringify(选项))
    this.phase = 'downloading'
    setTimeout(() => {
      this.phase = 'ready'
      console.log('[mock] 假模型就绪')
    }, 1500)
  },
  resolve({ audio }) {
    return { provider: 'sensevoice-local', audio, language: 'auto' }
  },
  async transcribe(spec) {
    await new Promise((r) => setTimeout(r, 300))
    return { text: '（假识别的字）', audioSeconds: spec.audio.length / 32000, inferenceSeconds: 0.3 }
  },
}

const ctx = {
  agents: { list: () => [agent], get: (id) => (id === 'session-mock' ? agent : undefined) },
  sessions: { flush: async () => {} },
  sessionTitle: { get: () => '联调会话' },
  speechToText: 假语音,
  logger: () => ({ info: (m) => console.log('[bridge] ' + m) }),
  on(类型, 函数) {
    监听.set(类型, 函数)
    return () => 监听.delete(类型)
  },
  effect(函数) {
    return 函数()
  },
}

apply(ctx)
console.log('[mock] 桥起来在 http://127.0.0.1:43110')
