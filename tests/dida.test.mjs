import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { __test } from '../index.js'

const {
  解析偏移秒,
  算提醒时刻,
  该理这个任务,
  合并提醒,
  解析时分,
  在安静时段,
  读嘀嗒凭证,
} = __test

test('偏移：TRIGGER:-PT0S / PT0S 都是 0（到点）', () => {
  assert.equal(解析偏移秒('TRIGGER:-PT0S'), 0)
  assert.equal(解析偏移秒('TRIGGER:PT0S'), 0)
})

test('偏移：认 分/时/天，认负号，认不出来回 null', () => {
  assert.equal(解析偏移秒('TRIGGER:-PT10M'), -600)
  assert.equal(解析偏移秒('TRIGGER:-PT30M'), -1800)
  assert.equal(解析偏移秒('TRIGGER:PT1H30M'), 5400)
  assert.equal(解析偏移秒('TRIGGER:-P1D'), -86400)
  assert.equal(解析偏移秒('TRIGGER:-P1DT2H'), -93600)
  assert.equal(解析偏移秒('随便写点什么'), null)
  assert.equal(解析偏移秒(''), null)
})

test('提醒时刻：dueDate + 偏移，键是 任务id:提醒id', () => {
  const 任务 = {
    id: 't1',
    dueDate: '2025-01-25T12:00:00.000+0000',
    reminders: [{ id: 'r1', trigger: 'TRIGGER:-PT10M' }],
  }
  const 出 = 算提醒时刻(任务)
  assert.equal(出.length, 1)
  assert.equal(出[0].键, 't1:r1')
  assert.equal(出[0].时刻, Date.parse('2025-01-25T12:00:00.000+0000') - 600 * 1000)
})

test('提醒时刻：没到期日 / 没提醒 → 空', () => {
  assert.deepEqual(算提醒时刻({ id: 't', reminders: [{ id: 'r', trigger: 'TRIGGER:PT0S' }] }), [])
  assert.deepEqual(算提醒时刻({ id: 't', dueDate: '2025-01-25T12:00:00.000+0000' }), [])
  assert.deepEqual(算提醒时刻(null), [])
})

test('过滤：完成的、删掉的不理；清单 muted/closed 不理', () => {
  const 清单们 = new Map([
    ['p1', { id: 'p1', name: '正常' }],
    ['p2', { id: 'p2', name: '静音', muted: true }],
    ['p3', { id: 'p3', name: '关了', closed: true }],
  ])
  assert.equal(该理这个任务({ id: 'a', projectId: 'p1', status: 0 }, 清单们), true)
  assert.equal(该理这个任务({ id: 'b', projectId: 'p1', status: 2 }, 清单们), false)
  assert.equal(该理这个任务({ id: 'c', projectId: 'p1', status: 0, deleted: true }, 清单们), false)
  assert.equal(该理这个任务({ id: 'd', projectId: 'p2', status: 0 }, 清单们), false)
  assert.equal(该理这个任务({ id: 'e', projectId: 'p3', status: 0 }, 清单们), false)
  // 清单没在映射里：照样理（宁可多念，不要漏念）
  assert.equal(该理这个任务({ id: 'f', projectId: '不存在', status: 0 }, 清单们), true)
})

test('合并：一条是「到点：X」，多条是「到点 N 件：X、Y」', () => {
  assert.equal(合并提醒([{ 标题: '交周报' }]), '到点：交周报')
  assert.equal(合并提醒([{ 标题: '交周报' }, { 标题: '开会' }]), '到点 2 件：交周报、开会')
  assert.equal(合并提醒([{ 标题: 'A' }, { 标题: 'B' }, { 标题: 'C' }]), '到点 3 件：A、B、C')
  assert.equal(合并提醒([]), '')
  assert.equal(合并提醒([{ 标题: '  ' }]), '')
})

test('合并：超长会在上限处收住，并带省略号', () => {
  const 长 = '这是一个特别特别特别长的任务标题需要被截断'
  const 文 = 合并提醒([{ 标题: 长 }, { 标题: 长 }, { 标题: 长 }], 20)
  assert.ok(文.length <= 21, `实际 ${文.length}：${文}`)
  assert.ok(文.endsWith('…'), 文)
})

test('安静时段：23:00-08:00 跨零点', () => {
  assert.equal(在安静时段(23, 30, '23:00', '08:00'), true)
  assert.equal(在安静时段(0, 0, '23:00', '08:00'), true)
  assert.equal(在安静时段(7, 59, '23:00', '08:00'), true)
  assert.equal(在安静时段(8, 0, '23:00', '08:00'), false)
  assert.equal(在安静时段(12, 0, '23:00', '08:00'), false)
  // 不跨零点也认
  assert.equal(在安静时段(13, 0, '12:00', '14:00'), true)
  // 起止一样 = 不设
  assert.equal(在安静时段(13, 0, '12:00', '12:00'), false)
  // 空值 = 不设
  assert.equal(在安静时段(3, 0, '', ''), false)
})

test('解析时分：认 HH:MM，其余回 null', () => {
  assert.equal(解析时分('23:00'), 1380)
  assert.equal(解析时分('8:05'), 485)
  assert.equal(解析时分('24:00'), null)
  assert.equal(解析时分('乱七八糟'), null)
})

test('读凭证：能从本地 sqlite 的 CommonSettings.LoginUserAuth 里读出来', async () => {
  const 目录 = join(tmpdir(), `dida-test-${Date.now()}`)
  mkdirSync(目录, { recursive: true })
  const 库 = join(目录, 'TickTick.db')
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(库)
    db.exec('create table CommonSettings (LoginUserAuth text)')
    db.prepare('insert into CommonSettings (LoginUserAuth) values (?)').run('假token123')
    db.close()

    assert.equal(await 读嘀嗒凭证({ dbPath: 库 }), '假token123')
    // 配置里手写了 cookie 就优先用它
    assert.equal(await 读嘀嗒凭证({ dbPath: 库, cookie: '手填的' }), '手填的')
  } finally {
    rmSync(目录, { recursive: true, force: true })
  }
})
