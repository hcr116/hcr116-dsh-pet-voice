// 文件编码守卫：仓库里任何 json/js/yml/md 都不许带 UTF-8 BOM。
//
// 为什么专门写一个用例（2026-10-27，代价是三次重启 + 四十分钟）：
// 我用 PowerShell 改 package.json 的版本号时用了 `Set-Content -Encoding utf8`，
// Windows PowerShell 5.1 这样写会加 BOM。DSH 读 profile 清单是
//   JSON.parse(readFileSync(package.json, 'utf8'))
// 它不去 BOM，于是抛 SyntaxError —— 而 dsh-app-boot 的 loadProfileDirectory()
// 对 bundle 的异常是**静默跳过**（源码注释原话："skippedBundles ... nothing is printed"）。
// 结果：插件整个不加载，/dsh-pet-voice/ 变裸 404、日志零增长、没有任何报错，
// 看起来像"DSH 不肯热重载"，实际是一个不可见的 BOM 字节。
//
// 这个用例就是那道闸：BOM 一旦回来，`node --test` 立刻红。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const 根 = dirname(dirname(fileURLToPath(import.meta.url)))
const 要看 = new Set(['.json', '.js', '.mjs', '.cjs', '.yml', '.yaml', '.md'])
const 跳过目录 = new Set(['node_modules', '_tmp', '.git', 'coverage'])

/** 递归收集要检查的文件 */
function 收(目录, 出 = []) {
  for (const 项 of readdirSync(目录, { withFileTypes: true })) {
    if (项.isDirectory()) {
      if (!跳过目录.has(项.name)) 收(join(目录, 项.name), 出)
      continue
    }
    if (要看.has(extname(项.name))) 出.push(join(目录, 项.name))
  }
  return 出
}

test('仓库里没有带 UTF-8 BOM 的文件（BOM 会让 DSH 静默跳过整个插件）', () => {
  const 带BOM = []
  for (const 文件 of 收(根)) {
    const b = readFileSync(文件)
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) 带BOM.push(文件.slice(根.length + 1))
  }
  assert.deepEqual(带BOM, [], `这些文件带 BOM，请去掉：${带BOM.join('、')}`)
})

test('package.json 能被 JSON.parse 直接吃掉（DSH 就是这么读的，一步都不能省）', () => {
  const 原 = readFileSync(join(根, 'package.json'))
  // 先断言真没有 BOM，再断言能解析——解析失败时给出人话
  assert.notEqual(原[0], 0xef, 'package.json 开头是 BOM')

  let 清单
  assert.doesNotThrow(() => {
    清单 = JSON.parse(原.toString('utf8'))
  }, 'package.json 不是合法 JSON（带 BOM 也会走到这里）')

  // DSH 靠这些字段认出"这是一个 bundle"，缺一个就静默不加载
  assert.equal(清单.name, 'dsh-pet-voice')
  assert.equal(typeof 清单.version, 'string')
  assert.equal(清单.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(清单.type, 'module')
  assert.equal(清单.main, 'index.js')
})

test('cordis.patch.yml 里 insert 的插件名和 package.json 的 name 对得上', () => {
  const yml = readFileSync(join(根, 'cordis.patch.yml'), 'utf8')
  const 名 = JSON.parse(readFileSync(join(根, 'package.json'), 'utf8')).name
  assert.match(yml, new RegExp(`name:\\s*'?${名}'?`), `cordis.patch.yml 里应该 insert ${名}`)
})
