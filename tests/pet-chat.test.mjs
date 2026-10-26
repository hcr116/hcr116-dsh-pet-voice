// 宠物自己的对话框（右键桌宠那个）→ 念出来：离线验证
// 假 dsh-pet 只在第 1 次 /state 时吐一句 say，之后一直挂着；
// 插件应该：盯到这句 → 挑它 → 用自己的 lock/broadcast 把同一句播出去。
// voice 用 off，避免真的去合成、真的出声。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 配置目录 = mkdtempSync(join(tmpdir(), 'petvoice-'))
const 配置路径 = join(配置目录, 'cfg.json')

test('宠物别人的气泡会被念出来（右键对话框那条路）', async () => {
  const 广播 = []
  let 第几次 = 0
  const 见过 = []
  const 完整地址 = []
  const 假宠物 = createServer((req, res) => {
    const 路 = new URL(req.url, 'http://x').pathname
    见过.push(路)
    完整地址.push(req.url)
    if (路 === '/dsh-pet-7340/state') {
      第几次 += 1
      const 体 =
        第几次 === 1
          ? { counter: 5, pets: { main: { say: { counter: 5, data: { text: '人家声音可温柔啦，主人想听啥～' } } } } }
          : { counter: 5, pets: { main: { say: { counter: 5, data: { text: '人家声音可温柔啦，主人想听啥～' } } } } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(体))
      return
    }
    if (路 === '/dsh-pet-7340/lock') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, lockId: 'lk-1', expiresAt: Date.now() + 60000 }))
      return
    }
    if (路 === '/dsh-pet-7340/broadcast') {
      let 文 = ''
      req.on('data', (b) => (文 += b))
      req.on('end', () => {
        广播.push(JSON.parse(文 || '{}').text)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    if (路 === '/dsh-pet-7340/lock/release') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => 假宠物.listen(0, '127.0.0.1', r))
  const 端口 = 假宠物.address().port

  writeFileSync(
    配置路径,
    JSON.stringify({
      enabled: true,
      voice: 'off', // 只出气泡，不合成、不出声
      speakPetBubbles: true,
      petId: 'main',
      surface: 'web',
      stt: { providerId: 'sensevoice-local' },
    }),
  )
  process.env.DSH_PET_VOICE_CONFIG = 配置路径

  const 模 = await import('../index.js')
  const 服务 = { webServer: { port: 端口, register: () => ({ dispose: () => {} }) }, speechToText: {} }
  const ctx = {
    logger: { info: () => {} },
    on: () => {},
    effect: (f) => f(),
    get: () => undefined,
    inject: (依赖, 回调) => {
      const 子 = { ...ctx }
      for (const 名 of 依赖) 子[名] = 服务[名]
      return 回调(子)
    },
  }
  模.apply(ctx)

  // 等轮询跑一轮
  for (let i = 0; i < 40 && 广播.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
  模.__test.停盯气泡()
  await new Promise((r) => setTimeout(r, 120))
  假宠物.closeAllConnections?.()
  假宠物.close()
  assert.ok(广播.length >= 1, '应该把她自己说的那句广播回来（= 念出来）；见过：' + 见过.join(' '))
  assert.match(广播[0], /温柔/)
  // dsh-pet 的 timeout 只收 0..10000，给 15000 会被 400 拒掉、整条链静默死掉（踩过）
  const 轮询 = 完整地址.find((u) => u.includes('/state'))
  assert.ok(轮询, '要长轮询 /state')
  const 超 = Number(/[?&]timeout=(\d+)/.exec(轮询)?.[1] || 0)
  assert.ok(超 > 0 && 超 <= 10000, `timeout 必须落在 1..10000，实际 ${超}`)
})

test('清理气泡文本：去掉配图标记与表情', async () => {
  const 模2 = await import('../index.js')
  assert.equal(模2.__test.清理气泡文本('好呀[图:撒娇] 🌊'), '好呀')
})
