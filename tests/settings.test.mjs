import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { __test } from '../index.js'
import { 渲染设置页 } from '../lib/settings-page.js'

const { 合并配置, 读原始配置, 存配置补丁, 归一化配置 } = __test
/** 临时配置目录：所有用例都别碰真的 ~/.dsh/dsh-pet-voice.json */
function 临时配置(初值) {
  const 目录 = mkdtempSync(join(tmpdir(), 'dsh-pet-voice-cfg-'))
  const 路 = join(目录, 'dsh-pet-voice.json')
  const 旧 = process.env.DSH_PET_VOICE_CONFIG
  process.env.DSH_PET_VOICE_CONFIG = 路
  if (初值 !== undefined) writeFileSync(路, JSON.stringify(初值, null, 2), 'utf8')
  return {
    路,
    收: () => {
      if (旧 === undefined) delete process.env.DSH_PET_VOICE_CONFIG
      else process.env.DSH_PET_VOICE_CONFIG = 旧
    },
  }
}

test('合并配置：只改补丁里出现的键，别的原样留着', () => {
  const 原 = { speak: { mode: 'auto', provider: 'sapi' }, maxChars: 60, 我的备注: '别删我' }
  const 新 = 合并配置(原, { speak: { mode: 'off' } })
  assert.equal(新.speak.mode, 'off')
  assert.equal(新.speak.provider, 'sapi') // 同块里没提到的保住
  assert.equal(新.maxChars, 60)
  assert.equal(新.我的备注, '别删我')
  // 不能改到原对象（设置页可能连点两次保存）
  assert.equal(原.speak.mode, 'auto')
})

test('合并配置：null 是删键，数组是整体替换，脏补丁不炸', () => {
  assert.deepEqual(合并配置({ a: 1, b: 2 }, { a: null }), { b: 2 })
  assert.deepEqual(合并配置({ list: [1, 2, 3] }, { list: [9] }), { list: [9] })
  assert.deepEqual(合并配置({ a: 1 }, null), { a: 1 })
  assert.deepEqual(合并配置({ a: 1 }, [1, 2]), { a: 1 })
  assert.deepEqual(合并配置(null, { a: 1 }), { a: 1 })
})

test('存配置补丁：落盘的是"原始 + 补丁"，不是一整份默认值', () => {
  const t = 临时配置({ speak: { mode: 'auto' } })
  try {
    const 归一 = 存配置补丁({ speak: { provider: 'local' }, sovits: { refAudio: 'D:/声音/ref.wav' } })
    assert.equal(归一.speak.provider, 'local')
    assert.equal(归一.sovits.refAudio, 'D:/声音/ref.wav')

    const 盘上 = JSON.parse(readFileSync(t.路, 'utf8'))
    // 默认值不许被写进去：maxChars / dida / listen 一个都不该凭空出现
    assert.equal(盘上.maxChars, undefined)
    assert.equal(盘上.dida, undefined)
    assert.equal(盘上.listen, undefined)
    assert.equal(盘上.speak.mode, 'auto')
    assert.equal(盘上.speak.provider, 'local')
    // 归一化后默认值照旧补上（读的时候才补）
    assert.equal(归一.maxChars, 40)
    assert.equal(读原始配置().speak.provider, 'local')
  } finally {
    t.收()
  }
})

test('存配置补丁：文件不存在时能自己建（第一次点保存）', () => {
  const t = 临时配置() // 不建文件
  try {
    assert.deepEqual(读原始配置(), {})
    存配置补丁({ speak: { mode: 'off' } })
    assert.equal(JSON.parse(readFileSync(t.路, 'utf8')).speak.mode, 'off')
  } finally {
    t.收()
  }
})

test('存配置补丁：文件是坏 JSON 时当空的处理，不抛', () => {
  const t = 临时配置()
  try {
    writeFileSync(t.路, '{ 这不是 json', 'utf8')
    assert.deepEqual(读原始配置(), {})
    存配置补丁({ speak: { mode: 'off' } })
    assert.equal(JSON.parse(readFileSync(t.路, 'utf8')).speak.mode, 'off')
  } finally {
    t.收()
  }
})

test('归一化：顶层 sovits 与 speak.sovits 读到的是同一份有效值', () => {
  // 只在顶层写（老配置）——设置页按 speak.sovits.* 填表，必须也能读到
  const 老 = 归一化配置({ sovits: { refAudio: 'D:/a.wav' } })
  assert.equal(老.sovits.refAudio, 'D:/a.wav')
  assert.equal(老.speak.sovits.refAudio, 'D:/a.wav')

  // 只在 speak 里写（我们文档推荐的写法）——老代码读 cfg.sovits 也得读到
  const 新 = 归一化配置({ speak: { sovits: { refAudio: 'D:/b.wav' } } })
  assert.equal(新.sovits.refAudio, 'D:/b.wav')
  assert.equal(新.speak.sovits.refAudio, 'D:/b.wav')

  // 两处都写：speak 里的优先，两条路径给同一个答案
  const 都 = 归一化配置({ sovits: { refAudio: 'D:/老.wav' }, speak: { sovits: { refAudio: 'D:/新.wav' } } })
  assert.equal(都.sovits.refAudio, 'D:/新.wav')
  assert.equal(都.speak.sovits.refAudio, 'D:/新.wav')

  // sapi 同理
  assert.equal(归一化配置({ sapi: { volume: 33 } }).speak.sapi.volume, 33)
})

// ---------- 设置页 ----------
/** 从页面里把内嵌的初始 JSON 挖出来 */
function 挖初始(html) {
  const m = html.match(/<script id="boot" type="application\/json">([\s\S]*?)<\/script>/)
  assert.ok(m, '设置页里应该有 id=boot 的 JSON')
  return JSON.parse(m[1])
}

const 假能力 = {
  body: { available: true, reason: '' },
  speak: { available: true, provider: 'sapi', reason: '克隆嗓没起来，退 SAPI' },
  listen: { available: false, reason: '这台没有语音识别服务' },
  dida: { available: true, reason: '' },
}

test('设置页：四个模块都在，能配的字段都有', () => {
  const html = 渲染设置页({ 配置: { speak: { mode: 'auto' } }, 能力: 假能力, 配置路径: 'C:/x/dsh-pet-voice.json', 版本: '9.9.9' })
  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /大肥鱼小秘书 · 设置/)
  assert.match(html, /9\.9\.9/)
  assert.match(html, /C:\/x\/dsh-pet-voice\.json/)

  const 初 = 挖初始(html)
  const 键 = 初.模块表.map((m) => m.键)
  assert.deepEqual(键, ['body', 'speak', 'listen', 'dida', 'common'])

  // 「语音训练」那块要能点到路径类配置——这是用户明确要的
  const 说 = 初.模块表.find((m) => m.键 === 'speak')
  assert.equal(说.开关, 'speak.mode')
  const 路 = 说.字段.map((f) => f.路)
  // 必须落在 speak.sovits 下：归一化时 speak.sovits 优先于顶层 sovits，
  // 写到顶层会被旧值压住，用户改完看起来"没生效"（真的踩过这个坑）
  assert.ok(路.includes('speak.sovits.url'))
  assert.ok(路.includes('speak.sovits.refAudio'))
  assert.ok(路.includes('speak.sovits.promptText'))
  assert.equal(
    路.some((p) => /^sovits\./.test(p)),
    false,
    '不许写到顶层 sovits.*',
  )
})

test('设置页：三档语义在页面里说清楚（自动/强制开/关）', () => {
  const 初 = 挖初始(渲染设置页({ 配置: {}, 能力: 假能力 }))
  assert.deepEqual(
    初.档位.map((d) => d[0]),
    ['auto', 'on', 'off'],
  )
  assert.match(初.档位[1][2], /提醒/)
})

test('设置页：能力灯和原因都带出去了（不可用要说明为什么）', () => {
  const 初 = 挖初始(渲染设置页({ 配置: {}, 能力: 假能力 }))
  assert.equal(初.能力.speak.available, true)
  assert.equal(初.能力.listen.available, false)
  assert.match(初.能力.listen.reason, /语音识别服务/)
})

test('设置页：用户值里有 </script> 也出不来（内嵌 JSON 必须转义）', () => {
  const 坏 = { sovits: { refAudio: '</script><img src=x onerror=alert(1)>' } }
  const html = 渲染设置页({ 配置: 坏, 能力: 假能力 })
  assert.equal(html.includes('</script><img'), false) // 不能被提前闭包
  const 初 = 挖初始(html)
  assert.equal(初.配置.sovits.refAudio, '</script><img src=x onerror=alert(1)>')
})

test('设置页：拿不到能力也能渲染（全是"还没探过"）', () => {
  const html = 渲染设置页({})
  assert.match(html, /大肥鱼小秘书/)
  assert.deepEqual(挖初始(html).能力, {})
})
