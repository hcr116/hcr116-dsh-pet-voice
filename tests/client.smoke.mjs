// 网页半边的离线测试：用假的 window + 假 React 把 factory 跑起来。
// 验的是：注册的形状对不对、WAV 头是不是 16 kHz / 单声道 / PCM16、base64 能还原。
//   node tests/client.smoke.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const 此处 = dirname(fileURLToPath(import.meta.url))
const 源码 = readFileSync(join(此处, '..', 'lib', 'client.js'), 'utf8')

/** 极简 React 替身：只够 factory 与组件跑一遍初值。 */
const 假React = {
  createElement: (类型, 属性, ...子) => ({ 类型, 属性, 子 }),
  useState: (初) => [初, () => {}],
  useRef: (初) => ({ current: 初 }),
  useEffect: () => {},
}

function 跑一遍() {
  let 登记 = null
  let 载入 = null
  const window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: {
      load: (规格) => {
        载入 = 规格
      },
    },
  }
  const 全局 = { window, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }, document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} } }
  // 把源码当普通脚本跑：给它 window / navigator / document / btoa / MediaRecorder 等
  const 沙盘 = { ...全局, btoa, atob, console, fetch: async () => ({ status: 200, json: async () => ({}) }) }
  const 键 = Object.keys(沙盘)
  const 函数 = new Function(...键, 源码)
  函数(...键.map((k) => 沙盘[k]))

  assert.ok(载入, 'ModuleLoader.load 没被调用')
  assert.equal(载入.id, 'dsh-pet-voice')

  const 模块 = 载入.factory((名) => {
    if (名 === 'react') return 假React
    throw new Error('不该 require ' + 名)
  })
  assert.equal(typeof 模块.apply, 'function')
  assert.deepEqual(模块.inject, [], '静态 inject 必须是空的，否则宿主缺服务就起不来')

  const ctx = {
    slots: {
      inject: (名, 回调) => {
        回调()
        return { dispose: () => {} }
      },
      register: (选项, 组件) => {
        登记 = { 选项, 组件 }
        return { dispose: () => {} }
      },
    },
    inject: (名单, 回调) => 回调(),
  }
  const 卸 = 模块.apply(ctx)
  assert.ok(登记, '没有注册进输入框')
  assert.equal(登记.选项.name, 'conversation.input.overlay')
  assert.equal(登记.选项.id, 'pet-voice')

  return { 登记, window }
}

test('factory 能跑，注册形状正确，静态 inject 为空', () => {
  const { 登记 } = 跑一遍()
  assert.equal(typeof 登记.组件, 'function')
  // 空闲时什么都不渲染（不占输入框地方）
  const 出 = 登记.组件({ sessionId: 's1', inputActions: { insertText: () => true, captureInsertion: () => ({}) } })
  assert.equal(出, null)
})

test('WAV 头：16 kHz、单声道、PCM16、data 长度对得上', () => {
  const { window } = 跑一遍()
  const 调试 = window.__petVoiceDebug
  assert.ok(调试, '没留自测口子')
  const 样本 = new Float32Array([0, 0.5, -0.5, 1, -1])
  const 字节 = 调试.编WAV(样本)
  const 视图 = new DataView(字节.buffer)
  const 读串 = (在, 长) => String.fromCharCode(...字节.subarray(在, 在 + 长))
  assert.equal(读串(0, 4), 'RIFF')
  assert.equal(读串(8, 4), 'WAVE')
  assert.equal(读串(36, 4), 'data')
  assert.equal(视图.getUint16(20, true), 1, '不是 PCM')
  assert.equal(视图.getUint16(22, true), 1, '不是单声道')
  assert.equal(视图.getUint32(24, true), 16000, '不是 16 kHz')
  assert.equal(视图.getUint16(34, true), 16, '不是 16 bit')
  assert.equal(视图.getUint32(40, true), 样本.length * 2)
  assert.equal(字节.length, 44 + 样本.length * 2)
  assert.equal(视图.getInt16(44 + 2 * 4, true), -32768, '-1 应该编码成 -32768')
})

test('base64 往返：解码回来的字节一模一样', () => {
  const { window } = 跑一遍()
  const 样本 = new Float32Array(2000).fill(0.25)
  const 字节 = window.__petVoiceDebug.编WAV(样本)
  const 串 = window.__petVoiceDebug.转base64(字节)
  const 回 = Uint8Array.from(atob(串), (c) => c.charCodeAt(0))
  assert.equal(回.length, 字节.length)
  assert.deepEqual([...回.subarray(0, 8)], [...字节.subarray(0, 8)])
})
