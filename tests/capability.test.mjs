import assert from 'node:assert/strict'
import { test } from 'node:test'

import { __test } from '../index.js'

const { 三档, 归一化配置, 探说, 探听, 探身体, 探活地址, 探提醒, 体检文案, 体检清单 } = __test

test('三档：只认 auto/on/off，大小写与脏值都收', () => {
  assert.equal(三档('on'), 'on')
  assert.equal(三档('OFF'), 'off')
  assert.equal(三档(' auto '), 'auto')
  assert.equal(三档('开着'), 'auto') // 认不出来回兜底
  assert.equal(三档(undefined), 'auto')
  assert.equal(三档(null, 'off'), 'off') // 传了兜底就用兜底
})

test('归一化：老配置 voice/sovits/hotkey 照旧能用', () => {
  const 配 = 归一化配置({ voice: 'sapi', hotkey: 'Ctrl+Alt+U', maxChars: 60 })
  assert.equal(配.speak.mode, 'auto')
  assert.equal(配.speak.provider, 'sapi')
  assert.equal(配.voice, 'sapi')
  assert.equal(配.hotkey, 'Ctrl+Alt+U')
  assert.equal(配.maxChars, 60)
})

test('归一化：voice:off 等于 speak.mode=off', () => {
  const 配 = 归一化配置({ voice: 'off' })
  assert.equal(配.speak.mode, 'off')
  assert.equal(配.voice, 'off')
})

test('归一化：新配置 speak/listen/dida 生效，且映射回老字段', () => {
  const 配 = 归一化配置({
    speak: { mode: 'off', provider: 'local' },
    listen: { mode: 'off', hotkey: 'Ctrl+Shift+U' },
    dida: { mode: 'off' },
  })
  assert.equal(配.speak.mode, 'off')
  assert.equal(配.voice, 'off')
  assert.equal(配.listen.mode, 'off')
  assert.equal(配.dida.enabled, false) // 老代码读这个
  assert.equal(配.hotkey, 'Ctrl+Shift+U')
})

test('归一化：老 dida.enabled:false 当成 mode:off', () => {
  const 配 = 归一化配置({ dida: { enabled: false } })
  assert.equal(配.dida.mode, 'off')
  assert.equal(配.dida.enabled, false)
})

test('归一化：空配置给全套默认，不炸', () => {
  const 配 = 归一化配置()
  assert.equal(配.speak.mode, 'auto')
  assert.equal(配.speak.provider, 'auto')
  assert.equal(配.listen.mode, 'auto')
  assert.equal(配.dida.mode, 'auto')
  assert.ok(配.sovits && 配.sapi && 配.stt)
  assert.equal(配.firstRunReport, true)
})

test('探说：off 就直接不可用', async () => {
  const r = await 探说({ speak: { mode: 'off' } }, async () => true)
  assert.equal(r.available, false)
  assert.match(r.reason, /关掉/)
})

test('探说：provider=local 且克隆嗓通 → local', async () => {
  const r = await 探说({ speak: { mode: 'auto', provider: 'local' }, sovits: { url: 'http://127.0.0.1:9880' } }, async () => true)
  assert.equal(r.available, true)
  assert.equal(r.provider, 'local')
})

test('探说：provider=auto 且克隆嗓不通 → 退 sapi（Windows 上可用）', async () => {
  const r = await 探说({ speak: { mode: 'auto', provider: 'auto' } }, async () => false)
  // 测试机是 Windows，所以这里应该还有 SAPI 兜底
  if (process.platform === 'win32') {
    assert.equal(r.available, true)
    assert.equal(r.provider, 'sapi')
  } else {
    assert.equal(r.available, false)
  }
})

test('探听：off / 没服务 / 有服务 三种', () => {
  assert.equal(探听({ listen: { mode: 'off' } }, true).available, false)
  const 没 = 探听({ listen: { mode: 'auto' } }, false)
  assert.equal(没.available, false)
  assert.match(没.reason, /语音/)
  const 有 = 探听({ listen: { mode: 'auto' } }, true)
  assert.equal(有.available, true)
})

test('探提醒：能读到凭证就算可用，读不到给原因', async () => {
  const 好 = await 探提醒({ dida: { mode: 'auto' } }, async () => 'token')
  assert.equal(好.available, true)

  const 坏 = await 探提醒({ dida: { mode: 'auto' } }, async () => '')
  assert.equal(坏.available, false)
  assert.match(坏.reason, /凭证/)

  const 抛 = await 探提醒({ dida: { mode: 'on' } }, async () => {
    throw new Error('没装 sqlite')
  })
  assert.equal(抛.available, false)
  assert.match(抛.reason, /读不到/)
})

test('体检文案：说清能做和不能做的', () => {
  const 全 = 体检文案({
    body: { available: true },
    speak: { available: true, provider: 'local' },
    listen: { available: true },
    dida: { available: true },
  })
  assert.match(全, /这台能：克隆嗓、嘀嗒提醒、麦克风/)

  const 光秃秃 = 体检文案({
    body: { available: true },
    speak: { available: false, provider: 'none' },
    listen: { available: false },
    dida: { available: false },
  })
  assert.match(光秃秃, /只有气泡/)
  assert.match(光秃秃, /没有：说话|没有：嘀嗒提醒/)
})

test('体检文案：连身体都没装就直说', () => {
  const 没身体 = 体检文案({ body: { available: false, reason: '没装 dsh-pet' } })
  assert.match(没身体, /还没装宠物身体/)
  assert.match(没身体, /dsh-pet/)
})

test('探活地址：since/timeout 必须成对，探活一个都不带（只给 timeout 会被 400）', () => {
  const 址 = 探活地址('http://127.0.0.1:7340', 'main')
  assert.equal(址, 'http://127.0.0.1:7340/state?pet=main')
  assert.doesNotMatch(址, /timeout=/) // 回归：曾经拼 &timeout=0 → 400 → 身体被误判"不在"
  assert.doesNotMatch(址, /since=/)

  // 结尾斜杠、默认宠物、需要转义的 id 都要稳
  assert.equal(探活地址('http://127.0.0.1:7340/', ''), 'http://127.0.0.1:7340/state?pet=main')
  assert.equal(探活地址('http://127.0.0.1:7340//', null), 'http://127.0.0.1:7340/state?pet=main')
  assert.equal(探活地址('http://x', '大 肥鱼'), 'http://x/state?pet=%E5%A4%A7%20%E8%82%A5%E9%B1%BC')
})

test('探身体：探针说通就算在，说断就给出安装命令', async () => {
  const 在 = await 探身体(async () => true)
  assert.equal(在.available, true)

  const 不在 = await 探身体(async () => false)
  assert.equal(不在.available, false)
  assert.match(不在.reason, /dsh plugin --profile desktop add dsh-pet/)

  const 炸了 = await 探身体(async () => {
    throw new Error('ECONNREFUSED')
  })
  assert.equal(炸了.available, false)
  assert.match(炸了.reason, /连不上 dsh-pet/)
})

test('体检清单：没身体就是 ok=false，并给出安装命令', () => {
  const 报 = 体检清单({
    body: { available: false, reason: '没装 dsh-pet' },
    speak: { available: true, provider: 'sapi' },
    listen: { available: false, reason: '没语音服务' },
    dida: { available: true },
  }, {}, '')
  assert.equal(报.ok, false)
  const 身体 = 报.检查项.find((x) => x.项.includes('身体'))
  assert.equal(身体.状态, '❌')
  assert.match(身体.怎么修, /dsh plugin --profile desktop add dsh-pet/)
  assert.equal(报.检查项.length, 5)
})

test('体检清单：身体在就 ok=true，缺的能力标 ⛔ 并给出替代方案', () => {
  const 报 = 体检清单({
    body: { available: true },
    speak: { available: false, reason: '没有 SAPI' },
    listen: { available: false, reason: '没语音服务' },
    dida: { available: false, reason: '没滴答' },
  }, {}, 'C:/x/dsh-pet-voice.json')
  assert.equal(报.ok, true)
  const 听 = 报.检查项.find((x) => x.项.includes('耳朵'))
  assert.equal(听.状态, '⛔')
  assert.match(听.怎么修, /打字/)
  const 配 = 报.检查项.find((x) => x.项 === '配置文件')
  assert.match(配.说明, /dsh-pet-voice\.json/)
})
