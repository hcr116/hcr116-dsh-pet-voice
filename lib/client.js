// dsh-pet-voice · 网页半边
//
// 只干一件事：在输入框旁边加一个「按住 Ctrl+U 对它说话」的小入口。
//   按下 → 录 16k 单声道 WAV → 交给宿主半边转写 → 文字插进输入框（不自动发送）
//
// ⚠ 三条纪律（隔壁公司那台 DSH 就是死在这上面）：
//   1. **绝不导出静态 `export const inject`**：宿主没有某个服务时，fiber 会永远停在
//      pending，web 启动检查把「任何非 active 条目」当致命错误 → 整个界面起不来
//      （`web boot: N entry did not activate`）。
//   2. 一切注册都包在 try/catch 里，失败只 console.warn，不抛。
//   3. 不碰会话、不发消息：真正的转写在宿主半边，这里只负责录音和插字。

try {
  window.__ModuleLoader__.load({
  id: 'dsh-pet-voice',
  factory: (require) => {
    var module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const B = '/dsh-pet-voice'
    const 热键说明 = 'Ctrl+U'

    // ---------- 工具 ----------
    const 取 = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)

    const 发 = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then(async (r) => {
          let 数据 = null
          try {
            数据 = await r.json()
          } catch {
            数据 = null
          }
          return { status: r.status, 数据 }
        })
        .catch((错误) => ({ status: 0, 数据: { ok: false, error: String((错误 && 错误.message) || 错误) } }))

    function 转base64(字节) {
      let 串 = ''
      const 步 = 0x8000
      for (let i = 0; i < 字节.length; i += 步) {
        串 += String.fromCharCode.apply(null, 字节.subarray(i, i + 步))
      }
      return btoa(串)
    }

    /** 16 kHz / 单声道 / PCM16 —— DSH 转写服务逐字段核对，多一位采样率都算坏音频。 */
    function 编WAV(样本) {
      const 字节 = new Uint8Array(44 + 样本.length * 2)
      const 视图 = new DataView(字节.buffer)
      const 写 = (在, 文) => {
        for (let i = 0; i < 文.length; i++) 字节[在 + i] = 文.charCodeAt(i)
      }
      写(0, 'RIFF')
      视图.setUint32(4, 字节.length - 8, true)
      写(8, 'WAVE')
      写(12, 'fmt ')
      视图.setUint32(16, 16, true)
      视图.setUint16(20, 1, true) // PCM
      视图.setUint16(22, 1, true) // 单声道
      视图.setUint32(24, 16000, true)
      视图.setUint32(28, 32000, true)
      视图.setUint16(32, 2, true)
      视图.setUint16(34, 16, true)
      写(36, 'data')
      视图.setUint32(40, 样本.length * 2, true)
      for (let i = 0; i < 样本.length; i++) {
        const v = Math.max(-1, Math.min(1, 样本[i]))
        视图.setInt16(44 + i * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true)
      }
      return 字节
    }

    // ---------- 录音 ----------
    function 开录音() {
      const 状态 = {
        流: null,
        录音器: null,
        片段: [],
        上下文: null,
        取消: false,
        开始于: Date.now(),
      }

      async function 起() {
        const 设备 = navigator.mediaDevices
        if (!设备) throw new Error('这台设备没有麦克风')
        let 流
        try {
          流 = await 设备.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        } catch (错误) {
          if (错误 && 错误.name === 'NotAllowedError') throw new Error('没给麦克风权限')
          if (错误 && (错误.name === 'NotFoundError' || 错误.name === 'OverconstrainedError')) throw new Error('找不到麦克风')
          throw 错误
        }
        状态.流 = 流
        if (状态.取消) {
          流.getTracks().forEach((t) => t.stop())
          throw new Error('取消了')
        }
        状态.上下文 = new (window.AudioContext || window.webkitAudioContext)()
        状态.录音器 = new MediaRecorder(流)
        状态.录音器.ondataavailable = (e) => {
          if (!状态.取消 && e.data && e.data.size > 0) 状态.片段.push(e.data)
        }
        状态.录音器.start()
      }

      async function 停(最长秒 = 120) {
        const 录音器 = 状态.录音器
        const 上下文 = 状态.上下文
        if (!录音器 || !上下文 || 录音器.state !== 'recording') {
          释放()
          throw new Error('没听清')
        }
        try {
          await new Promise((收) => {
            录音器.onstop = () => 收()
            录音器.stop()
          })
          状态.流.getTracks().forEach((t) => t.stop())
          const 块 = new Blob(状态.片段, { type: 录音器.mimeType })
          if (块.size === 0) throw new Error('没听清')
          const 解码 = await 上下文.decodeAudioData(await 块.arrayBuffer())
          const 秒 = Math.min(解码.duration, 最长秒)
          const 离线 = new OfflineAudioContext(1, Math.max(1, Math.floor(秒 * 16000)), 16000)
          const 源 = 离线.createBufferSource()
          源.buffer = 解码
          源.connect(离线.destination)
          源.start()
          const 重采样 = await 离线.startRendering()
          return 编WAV(重采样.getChannelData(0))
        } finally {
          释放()
        }
      }

      function 释放() {
        try {
          状态.流 && 状态.流.getTracks().forEach((t) => t.stop())
        } catch {
          /* 已经停了 */
        }
        try {
          状态.上下文 && 状态.上下文.close()
        } catch {
          /* 已经关了 */
        }
        状态.流 = null
        状态.上下文 = null
        状态.录音器 = null
      }

      return { 起, 停, 释放, 状态 }
    }

    // ---------- 组件 ----------
    const 样式 = {
      条: {
        position: 'absolute',
        right: 8,
        bottom: 'calc(100% + 6px)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 12,
        lineHeight: 1.5,
        // 跟着主题走，深浅色都看得见
        background: 'var(--dsw-alias-bg-layer-2, rgba(20,24,32,.92))',
        color: 'var(--dsw-alias-label-primary, #fff)',
        boxShadow: '0 4px 16px rgba(0,0,0,.18)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        zIndex: 5,
      },
      听: { background: 'var(--dsw-alias-bg-accent, #1f6feb)', color: '#fff' },
      错: { background: 'var(--dsw-alias-bg-danger, #b42318)', color: '#fff' },
    }

    function 语音条({ sessionId, inputActions }) {
      const [阶段, 设阶段] = React.useState('闲') // 闲 | 听 | 转写 | 等 | 错
      const [提示, 设提示] = React.useState('')
      const 录音 = React.useRef(null)
      const 动作 = React.useRef(inputActions)
      const 收尾 = React.useRef(null)
      动作.current = inputActions

      // 把「你正看着哪个会话」报给宿主：它只念这个会话，别的（子代理）不念
      React.useEffect(() => {
        const 报 = () => {
          try {
            发('/focus', { sessionId: sessionId || '' })
          } catch {
            /* 后台不在了也无所谓 */
          }
        }
        报()
        const 回来 = () => {
          if (document.visibilityState === 'visible') 报()
        }
        document.addEventListener('visibilitychange', 回来)
        return () => document.removeEventListener('visibilitychange', 回来)
      }, [sessionId])

      const 静下来 = (毫秒, 文案) => {
        clearTimeout(收尾.current)
        收尾.current = setTimeout(() => {
          设阶段('闲')
          设提示('')
        }, 毫秒)
        if (文案) 设提示(文案)
      }

      const 取消 = () => {
        const r = 录音.current
        录音.current = null
        if (r) {
          r.状态.取消 = true
          r.释放()
        }
        设阶段('闲')
        设提示('')
      }

      const 开始 = async () => {
        if (录音.current || 阶段 === '转写') return
        const r = 开录音()
        录音.current = r
        设提示('在听…')
        设阶段('听')
        try {
          await r.起()
        } catch (错误) {
          录音.current = null
          设阶段('错')
          静下来(2600, String((错误 && 错误.message) || 错误))
        }
      }

      const 结束 = async () => {
        const r = 录音.current
        录音.current = null
        if (!r) return
        if (Date.now() - r.状态.开始于 < 300) {
          r.释放()
          设阶段('闲')
          设提示('')
          return
        }
        设阶段('转写')
        设提示('转写中…')
        let 字节
        try {
          字节 = await r.停(120)
        } catch (错误) {
          设阶段('错')
          静下来(2600, String((错误 && 错误.message) || 错误))
          return
        }
        const 回 = await 发('/stt', { audioBase64: 转base64(字节) })
        const 数据 = (回 && 回.数据) || {}
        if (回.status === 425) {
          设阶段('错')
          静下来(3200, '识别模型还在准备，等下再说一次')
          return
        }
        if (回.status === 503) {
          设阶段('错')
          静下来(3200, 'DSH 的语音服务没开着')
          return
        }
        if (!数据.ok) {
          设阶段('错')
          静下来(3200, String(数据.error || '转写失败').slice(0, 40))
          return
        }
        const 文 = String(数据.text || '').trim()
        if (!文) {
          设阶段('错')
          静下来(2600, '没听清')
          return
        }
        if (插进去(文)) {
          设阶段('闲')
          设提示('')
          return
        }
        设阶段('等')
        等空隙(文)
      }

      /** 插到光标处。false = 输入框这会儿锁着（她正在生成），文字得先存住。 */
      function 插进去(文) {
        try {
          const 动作表 = 动作.current
          if (动作表 && typeof 动作表.insertText === 'function') {
            const 位置 = typeof 动作表.captureInsertion === 'function' ? 动作表.captureInsertion() : undefined
            return 动作表.insertText(文, 位置) !== false
          }
        } catch {
          /* 官方动作表不可用就往下走，用 DOM 兜底 */
        }
        try {
          return 手插(文) // 没有 inputActions（或它抛了）时，直接往焦点输入框里写
        } catch {
          return false
        }
      }

      /** 兜底：找页面上真正被聚焦的那个输入框，把字塞到光标处再补一个 input 事件。 */
      function 手插(文) {
        const 框 = 当前输入框()
        if (!框) return false
        if (框.isContentEditable) {
          // 富文本框：能用的老办法，Chromium 里还行
          const 成 = document.execCommand && document.execCommand('insertText', false, 文)
          return 成 !== false
        }
        框.focus()
        const 起 = typeof 框.selectionStart === 'number' ? 框.selectionStart : 框.value.length
        const 止 = typeof 框.selectionEnd === 'number' ? 框.selectionEnd : 起
        const 原 = 框.value.slice(0, 起) + 文 + 框.value.slice(止)
        // 走原生 setter，否则 React 收不到变化
        const 型 = 框.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const 设 = Object.getOwnPropertyDescriptor(型, 'value')
        if (!设 || !设.set) return false
        设.set.call(框, 原)
        框.selectionStart = 框.selectionEnd = 起 + String(文).length
        框.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }

      /** 页面里那个能打字的输入框（排除本插件和隐藏的）。 */
      function 当前输入框() {
        const 候选 = []
        const 活 = document.activeElement
        if (活 && (活.tagName === 'TEXTAREA' || 活.tagName === 'INPUT' || 活.isContentEditable)) 候选.push(活)
        for (const 项 of document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')) {
          if (!候选.includes(项)) 候选.push(项)
        }
        for (const 项 of 候选) {
          const 型 = (项.getAttribute && 项.getAttribute('type')) || ''
          if (项.tagName === 'INPUT' && 型 && 型 !== 'text') continue
          if (项.disabled || 项.readOnly) continue
          if (项.closest && 项.closest('[data-pet-voice]')) continue
          const 样式 = window.getComputedStyle(项)
          if (样式.display === 'none' || 样式.visibility === 'hidden') continue
          return 项
        }
        return null
      }

      /** 她还在生成时输入框是锁的：每秒试一次，最多 40 秒。 */
      function 等空隙(文) {
        设提示('等她说完就写进去')
        let 次数 = 0
        const 定时 = setInterval(() => {
          次数 += 1
          if (插进去(文)) {
            clearInterval(定时)
            设阶段('闲')
            设提示('')
            return
          }
          if (次数 >= 40) {
            clearInterval(定时)
            设阶段('错')
            静下来(2600, '输入框一直锁着，文字没写进去')
          }
        }, 1000)
      }

      // 热键：Ctrl+U（浏览器会抢它做「查看源代码」，这里先抢回来）
      React.useEffect(() => {
        let 按着 = false
        const 按下 = (e) => {
          try {
            if (!e.ctrlKey || e.altKey || e.metaKey) return
            if (String(e.code || '') !== 'KeyU') return
            // Ctrl+Shift+U 也认（有些输入法/浏览器把 Ctrl+U 吃得更死）
            e.preventDefault()
            e.stopPropagation()
            if (按着) return
            按着 = true
            void 开始()
          } catch {
            /* 热键坏了别影响页面 */
          }
        }
        const 松开 = (e) => {
          try {
            if (String(e.code || '') !== 'KeyU') return
            if (!按着) return
            按着 = false
            void 结束()
          } catch {
            /* 同上 */
          }
        }
        const 按escap = (e) => {
          if (String(e.key || '') !== 'Escape') return
          if (!录音.current) return
          取消()
        }
        window.addEventListener('keydown', 按下, true)
        window.addEventListener('keyup', 松开, true)
        window.addEventListener('keydown', 按escap, true)
        return () => {
          window.removeEventListener('keydown', 按下, true)
          window.removeEventListener('keyup', 松开, true)
          window.removeEventListener('keydown', 按escap, true)
          取消()
          clearTimeout(收尾.current)
        }
        // 只在挂载时绑一次；阶段与录音都走 ref，不会读到旧值
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      if (阶段 === '闲' && !提示) return null
      const 底色 = 阶段 === '听' ? 样式.听 : 阶段 === '错' ? 样式.错 : null
      return h(
        'div',
        { 'data-pet-voice': 'pill', style: { ...样式.条, ...(底色 || {}) }, title: `按住 ${热键说明} 对它说话` },
        提示 || '在听…',
      )
    }

    // ---------- 注册 ----------
    const inject = [] // 故意留空：静态 inject 写错一个名字，整个界面就起不来

    function apply(ctx) {
      let 卸 = null
      const 装 = () => {
        try {
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
          卸 = ctx.slots.inject('conversation.input.overlay', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.overlay',
                id: 'pet-voice',
                order: 60, // 排在 / 命令菜单和反馈弹窗后面，不抢它们的位置
                label: '对鱼鱼说话',
              },
              语音条,
            ),
          )
        } catch (错误) {
          console.warn('[dsh-pet-voice] 输入框这一格没挂上（不影响启动）：', 错误)
        }
      }

      // 动态注入：宿主没给 slots 就安静地什么都不做，绝不让 fiber 卡住
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['slots'], () => {
            装()
            return () => {
              try {
                卸 && 卸.dispose && 卸.dispose()
              } catch {
                /* 卸不掉就算了 */
              }
            }
          })
        } else {
          装()
        }
      } catch (错误) {
        console.warn('[dsh-pet-voice] 注入失败（忽略）：', 错误)
      }
    }

    module.exports = { apply, inject }
    // 自测口子：浏览器控制台里 `__petVoiceDebug` 能直接验 WAV 头对不对
    try {
      window.__petVoiceDebug = { 编WAV, 转base64, 语音条, 开录音 }
    } catch {
      /* 不关键 */
    }
    return module.exports
  },
  })
} catch (错误) {
  // 连注册都失败了：安静退出，别把整个界面拖下水
  console.warn('[dsh-pet-voice] 网页半边没挂上（不影响启动）：', 错误)
}
