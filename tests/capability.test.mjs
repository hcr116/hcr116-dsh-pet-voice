import assert from 'node:assert/strict'
import { test } from 'node:test'

import { __test } from '../index.js'

const { 三档, 归一化配置, 探说, 探听, 探提醒, 体检文案 } = __test

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
    speak: { available: true, provider: 'local' },
    listen: { available: true },
    dida: { available: true },
  })
  assert.match(全, /这台能：克隆嗓、嘀嗒提醒、麦克风/)

  const 光秃秃 = 体检文案({
    speak: { available: false, provider: 'none' },
    listen: { available: false },
    dida: { available: false },
  })
  assert.match(光秃秃, /只有气泡/)
  assert.match(光秃秃, /没有：说话|没有：嘀嗒提醒/)
})
