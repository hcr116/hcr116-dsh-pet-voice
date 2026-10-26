// 真网络替身测试：起一个假的 dsh-pet、一个假的 GPT-SoVITS，验请求契约与降级。
//   node --test tests/integration.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 家 = mkdtempSync(join(tmpdir(), 'petvoice-int-'))
process.env.DSH_HOME = 家
writeFileSync(join(家, 'dsh-pet-voice.json'), JSON.stringify({ voice: 'off', petId: 'main', surface: 'web' }))

const 模 = await import('../index.js')
const { 合成, 说给桌宠 } = 模.__test

function 起服务(处理) {
  return new Promise((收) => {
    const s = createServer((req, res) => {
      const 块 = []
      req.on('data', (c) => 块.push(c))
      req.on('end', () => {
        处理(req, res, Buffer.concat(块).toString('utf8'))
      })
    })
    s.listen(0, '127.0.0.1', () => 收({ s, 端口: s.address().port }))
  })
}

test('说给桌宠：带 surface、带 lock，最后一定解锁', async () => {
  const 见 = []
  const { s, 端口 } = await 起服务((req, res, 体) => {
    见.push({ 方法: req.method, 地址: req.url, 体 })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.startsWith('/dsh-pet-7340/lock/release')) return res.end(JSON.stringify({ ok: true }))
    if (req.url.startsWith('/dsh-pet-7340/lock')) return res.end(JSON.stringify({ ok: true, lockId: 'L-1', expiresAt: Date.now() + 60000 }))
    res.end(JSON.stringify({ ok: true, shown: true }))
  })
  try {
    const cfg = { petId: 'main', surface: 'web', bubbleMs: 9000, petPort: 端口 }
    const 回 = await 说给桌宠({}, cfg, '测试一句')
    assert.equal(回.ok, true)
    const 锁 = 见.find((x) => x.地址.startsWith('/dsh-pet-7340/lock?'))
    const 播 = 见.find((x) => x.地址.startsWith('/dsh-pet-7340/broadcast'))
    const 解 = 见.find((x) => x.地址.startsWith('/dsh-pet-7340/lock/release'))
    assert.ok(锁 && 播 && 解, '锁 / 播 / 解 三次都要打出去')
    assert.match(锁.地址, /surface=web/)
    assert.match(播.地址, /lock=L-1/)
    assert.equal(JSON.parse(播.体).text, '测试一句')
    assert.equal(JSON.parse(解.体).lockId, 'L-1')
  } finally {
    s.close()
  }
})

test('说给桌宠：宠物没起时返回 unreachable，不抛', async () => {
  const cfg = { petId: 'main', surface: 'web', petPort: 9 }
  const 回 = await 说给桌宠({}, cfg, '测试')
  assert.equal(回.ok, false)
  assert.equal(回.reason, 'unreachable')
})

test('说给桌宠：显示模式对不上时照它回的 display 重发一次', async () => {
  const 见 = []
  const { s, 端口 } = await 起服务((req, res, 体) => {
    见.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.startsWith('/dsh-pet-7340/lock/release')) return res.end(JSON.stringify({ ok: true }))
    if (req.url.includes('surface=web')) {
      return res.end(JSON.stringify({ ok: false, reason: 'pet-not-displayed', message: 'main 的显示模式是 desktop', display: 'desktop' }))
    }
    if (req.url.startsWith('/dsh-pet-7340/lock')) return res.end(JSON.stringify({ ok: true, lockId: 'L-2' }))
    res.end(JSON.stringify({ ok: true, shown: true }))
  })
  try {
    const cfg = { petId: 'main', surface: 'web', bubbleMs: 9000, petPort: 端口 }
    const 回 = await 说给桌宠({}, cfg, '换模式重发')
    assert.equal(回.ok, true)
    assert.ok(见.some((u) => u.includes('surface=desktop') && u.startsWith('/dsh-pet-7340/broadcast')), '要改用 desktop 再发一遍')
  } finally {
    s.close()
  }
})

test('合成：payload 字段和老桌宠 GptSovits.cs 一模一样', async () => {
  let 收体 = null
  const { s, 端口 } = await 起服务((req, res, 体) => {
    收体 = JSON.parse(体)
    // 回一段够长的「wav」
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(Buffer.alloc(1000, 7))
  })
  try {
    const cfg = {
      sovits: {
        url: `http://127.0.0.1:${端口}`,
        refAudio: 'D:\\ref.wav',
        promptText: '提示词',
        lang: 'zh',
        speed: 1,
        timeoutMs: 3000,
      },
    }
    const 字节 = await 合成({}, cfg, '念这一句')
    assert.equal(字节.length, 1000)
    assert.equal(收体.text, '念这一句')
    assert.equal(收体.text_lang, 'zh')
    assert.equal(收体.prompt_lang, 'zh')
    assert.equal(收体.ref_audio_path, 'D:\\ref.wav')
    assert.equal(收体.prompt_text, '提示词')
    assert.equal(收体.media_type, 'wav')
    assert.equal(收体.streaming_mode, false)
    assert.equal(typeof 收体.speed_factor, 'number')
  } finally {
    s.close()
  }
})

test('合成：服务不答就在 3 秒左右放弃（好让调用方退 SAPI）', async () => {
  const { s, 端口 } = await 起服务(() => {
    /* 故意不回 */
  })
  try {
    const cfg = { sovits: { url: `http://127.0.0.1:${端口}`, timeoutMs: 800 } }
    const 起 = Date.now()
    await assert.rejects(() => 合成({}, cfg, '念'))
    const 用 = Date.now() - 起
    assert.ok(用 < 4000, `超时用了 ${用}ms，太久了`)
  } finally {
    s.close()
  }
})
