/**
 * 设置页（网页版）。宿主在 GET /dsh-pet-voice/settings 时把它吐出去，
 * 右键桌宠 →「更多」→「设置…」就是在浏览器里打开这一页。
 *
 * 为什么是网页而不是桌宠窗口里的面板：桌宠窗口属于 dsh-pet（别人写的），
 * 我们能确定能用的只有两件事——注册一个右键菜单项、自己开一页。
 * 而且网页版改完配置点保存就生效，不用重启 DSH。
 *
 * 这个文件是**纯函数**，不碰 fs、不碰端口，方便测试：
 *   渲染设置页({ 配置, 能力, 配置路径, 版本 }) → HTML 字符串
 *
 * 一个刻意的设计：表单不是写死在 HTML 里的，而是页面加载后由 `模块表` 生成。
 * 这样用户填的路径（可能带引号、尖括号）永远走 JSON + textContent，
 * 不会拼进 HTML 里造成转义问题。
 */

/** 三档档位的说法（和 index.js 的 三档() 一致：auto / on / off） */
const 档位 = [
  ['auto', '自动', '能用就用，用不了就安静关掉'],
  ['on', '强制开', '探不到会提醒你一次，好让人知道哪儿没配好'],
  ['off', '关', '连探测都不做'],
]

/**
 * 设置页的模块表。**改这里就等于改设置界面**，不用动下面的渲染代码。
 *
 * 每项：
 *   键      能力键（对应 /capabilities 里的 body/speak/listen/dida）
 *   开关    三档字段的配置路径（不给就是不可开关，比如身体）
 *   字段    [{ 路, 名, 型: '文'|'数'|'开关'|'选', 提示, 选 }]
 */
const 模块表 = [
  {
    键: 'body',
    名: '身体（dsh-pet）',
    说明: '形象、动画、气泡、右键菜单都是它画的。本插件只是它的嘴和耳朵，装不上它。',
    不可配: true,
    修法: 'dsh plugin --profile desktop add dsh-pet',
    字段: [],
  },
  {
    键: 'speak',
    名: '说话',
    说明: '把 DSH 的回答念出来。没配克隆嗓时走 Windows 自带的 SAPI（机械音，但开箱能用）。',
    开关: 'speak.mode',
    字段: [
      {
        路: 'speak.provider',
        名: '嗓子来源',
        型: '选',
        选: [
          ['auto', '自动：克隆嗓优先，没起就退 SAPI'],
          ['local', '只用克隆嗓（GPT-SoVITS）'],
          ['sapi', '只用系统 SAPI'],
        ],
      },
      {
        路: 'speak.sovits.url',
        名: 'GPT-SoVITS 服务地址',
        型: '文',
        提示:
          '它不是一个"模型文件"，而是一个<b>跑起来的</b>服务（默认 127.0.0.1:9880）。模型由那个服务自己加载，本插件只管发 HTTP 请求。',
      },
      {
        路: 'speak.sovits.refAudio',
        名: '参考音文件路径',
        型: '文',
        提示: '5~10 秒干净人声的音频文件（wav 最好），例如 D:/你的声音/ref.wav。用自己的声音，别用别人的。',
      },
      {
        路: 'speak.sovits.promptText',
        名: '参考音里说的原话',
        型: '文',
        提示: '必须和参考音一字不差，多一个字都会让克隆嗓跑调。',
      },
      { 路: 'speak.sovits.speed', 名: '语速倍率', 型: '数', 提示: '1 是原速；1.1 稍快。' },
      {
        路: 'speak.sovits.timeoutMs',
        名: '等克隆嗓的超时（毫秒）',
        型: '数',
        提示: '超过这个时间没出声就退回 SAPI，别让整句话卡住。',
      },
      { 路: 'speak.sapi.rate', 名: 'SAPI 语速', 型: '数', 提示: '-10~10，0 是默认。' },
      { 路: 'speak.sapi.volume', 名: 'SAPI 音量', 型: '数', 提示: '0~100。' },
      { 路: 'speak.sapi.voice', 名: 'SAPI 声音名', 型: '文', 提示: '留空 = 用系统默认中文声音。' },
    ],
  },
  {
    键: 'listen',
    名: '耳朵（麦克风）',
    说明: '输入框旁边那个「按住说话」。需要 DSH 装了语音识别包，否则只置灰、不报错。',
    开关: 'listen.mode',
    字段: [
      { 路: 'listen.hotkey', 名: '按住说话的键', 型: '文', 提示: '例如 Ctrl+U。' },
      { 路: 'listen.fallbackHotkey', 名: '备用键', 型: '文', 提示: '主键被别的软件占了就用这个。' },
      { 路: 'stt.providerId', 名: '语音识别服务', 型: '文', 提示: '留空 = 自动挑 DSH 里可用的那个。' },
      { 路: 'stt.downloadSource', 名: '模型下载源', 型: '文', 提示: '国内建议 https://hf-mirror.com。' },
      { 路: 'stt.timeoutMs', 名: '转写超时（毫秒）', 型: '数' },
    ],
  },
  {
    键: 'dida',
    名: '嘀嗒提醒',
    说明:
      '任务到点了冒个泡、念一句。凭证不用填——从本机滴答客户端的数据库里读，你在客户端重新登录它也自己更新。',
    开关: 'dida.mode',
    字段: [
      { 路: 'dida.pollSeconds', 名: '多久重拉一次清单（秒）', 型: '数', 提示: '到点触发靠本地定时器，不受这个影响。' },
      { 路: 'dida.quietFrom', 名: '安静时段从', 型: '文', 提示: 'HH:MM，这段时间只冒泡不出声。' },
      { 路: 'dida.quietTo', 名: '安静时段到', 型: '文', 提示: 'HH:MM，可以跨零点（23:00→08:00）。' },
      { 路: 'dida.mergeWindowMs', 名: '同时到点合并窗口（毫秒）', 型: '数', 提示: '同一分钟好几条一起到点时合成一句话。' },
      { 路: 'dida.dbPath', 名: '滴答数据库路径', 型: '文', 提示: '留空 = %APPDATA%\\Tick_Tick\\TickTick.db。' },
      { 路: 'dida.cookie', 名: '手动 Cookie（可选）', 型: '文', 提示: '只有在读不到本地数据库时才需要，一般留空。' },
    ],
  },
  {
    键: 'common',
    名: '通用',
    说明: '跟具体模块无关的几项。',
    不可配: true,
    字段: [
      { 路: 'maxChars', 名: '一次最多念多少字', 型: '数', 提示: '太长的回答只念开头，剩下的看屏幕。' },
      { 路: 'petId', 名: '对着哪只宠物说话', 型: '文', 提示: '留空 = main。' },
      { 路: 'firstRunReport', 名: '下次启动再说一遍体检结果', 型: '开关' },
    ],
  },
]

/** 把值塞进 <script> 里要防 `</script>`（JSON 本身不会带，但用户能写进配置里） */
function 安全内嵌(对象) {
  return JSON.stringify(对象)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 渲染设置页。
 *
 * @param {object} 参
 * @param {object} 参.配置     归一化后的配置（用来填表单初值）
 * @param {object} 参.能力     能力快照（body/speak/listen/dida → {available,reason}）
 * @param {string} [参.配置路径] 页面上显示给人看的配置文件位置
 * @param {string} [参.版本]    插件版本，页脚显示
 * @param {string} [参.发现]    这一台机器上自动探到的补充信息（可省）
 */
export function 渲染设置页(参 = {}) {
  const 配置 = 参.配置 || {}
  const 能力 = 参.能力 || {}
  const 配置路径 = 参.配置路径 || ''
  const 版本 = 参.版本 || ''

  // 状态灯的初值也内嵌一份：页面首帧就有东西看，不用等 fetch 回来
  const 初始 = {
    配置,
    能力,
    模块表,
    档位,
    配置路径,
    版本,
    发现: 参.发现 || {},
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼小秘书 · 设置</title>
<style>
  :root {
    --bg: #16181d; --card: #1e2128; --card2: #242832; --line: #313743;
    --fg: #e6e9ef; --dim: #98a1b3; --accent: #5ac8fa; --ok: #4ec9a5; --warn: #e5c07b; --bad: #e06c75;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 64px; background: var(--bg); color: var(--fg);
    font: 14px/1.65 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;
  }
  header, main, footer { max-width: 880px; margin: 0 auto; }
  header { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 22px; flex-wrap: wrap; }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 650; letter-spacing: .3px; }
  .sub { color: var(--dim); font-size: 12.5px; word-break: break-all; }
  .grow { flex: 1 1 auto; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px 18px 14px; margin-bottom: 16px; }
  .card > .hd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
  .card h2 { font-size: 15px; margin: 0; font-weight: 620; }
  .desc { color: var(--dim); font-size: 12.5px; margin: 2px 0 12px; }
  .lamp { font-size: 12px; padding: 1px 9px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .lamp.ok { color: var(--ok); border-color: #2e5749; background: #16241f; }
  .lamp.bad { color: var(--bad); border-color: #5a2f33; background: #241a1c; }
  .lamp.warn { color: var(--warn); border-color: #5a4c2f; background: #241f18; }
  .why { color: var(--dim); font-size: 12px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button {
    background: transparent; color: var(--dim); border: 0; padding: 5px 13px; cursor: pointer;
    font-size: 12.5px; font-family: inherit;
  }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-pressed="true"] { background: var(--accent); color: #0d1014; font-weight: 600; }
  .fields { display: grid; grid-template-columns: minmax(170px, 240px) 1fr; gap: 2px 16px; margin-top: 12px; }
  .fields label { color: var(--dim); font-size: 12.5px; padding-top: 8px; }
  .cell { padding: 5px 0; }
  input[type=text], input[type=number], select {
    width: 100%; background: var(--card2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 7px; padding: 7px 10px; font: inherit; font-size: 13px;
  }
  input:focus, select:focus { outline: 0; border-color: var(--accent); }
  .hint { color: #7d8798; font-size: 11.5px; margin-top: 4px; }
  .hint code { background: #2a2f3a; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button.act {
    background: var(--accent); color: #0d1014; border: 0; border-radius: 8px; padding: 8px 18px;
    font: inherit; font-size: 13px; font-weight: 620; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  button.act:disabled { opacity: .5; cursor: default; }
  #msg { font-size: 12.5px; min-height: 20px; }
  #msg.ok { color: var(--ok); } #msg.bad { color: var(--bad); }
  footer { color: #6f7889; font-size: 12px; margin-top: 26px; display: flex; gap: 18px; flex-wrap: wrap; }
  a { color: var(--accent); }
  .bodyfix { background: var(--card2); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; font-size: 12.5px; }
  .bodyfix code { color: var(--warn); font-size: 12px; word-break: break-all; }
</style>
</head>
<body>
<header>
  <div class="grow">
    <h1>大肥鱼小秘书 · 设置</h1>
    <div class="sub" id="cfgp"></div>
  </div>
  <div class="row">
    <button class="act" id="save">保存</button>
  </div>
</header>

<div id="msg"></div>
<main id="mods"></main>

<footer>
  <span>改完点「保存」立即生效，不用重启 DSH。</span>
  <span><a href="/dsh-pet-voice/doctor" target="_blank">体检报告 /doctor</a></span>
  <span id="ver"></span>
</footer>

<script id="boot" type="application/json">${安全内嵌(初始)}</script>
<script>
(function () {
  var 初 = JSON.parse(document.getElementById('boot').textContent);
  var 配置 = 初.配置 || {}, 能力 = 初.能力 || {}, 表 = 初.模块表 || [], 档 = 初.档位 || [];
  var 补丁 = {}; // 只记用户真改动过的字段

  document.getElementById('cfgp').textContent = 初.配置路径 ? ('配置文件：' + 初.配置路径) : '配置文件：还没生成（保存一次就有了）';
  if (初.版本) document.getElementById('ver').textContent = 'dsh-pet-voice ' + 初.版本;

  function 取值(路) {
    return 路.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, 配置);
  }
  function 记(路, 值) {
    // 补丁是**嵌套**对象：{ speak: { mode: 'off' } }，宿主那边深合并后落盘
    var 段 = 路.split('.'), o = 补丁;
    for (var i = 0; i < 段.length - 1; i++) { o = o[段[i]] = o[段[i]] || {}; }
    o[段[段.length - 1]] = 值;
  }

  var 灯 = function (键) {
    var 能 = 能力[键];
    if (!能) return { cls: 'warn', txt: '未知', why: '还没探过' };
    if (能.available) return { cls: 'ok', txt: '可用', why: 能.provider ? ('用 ' + 能.provider) : '' };
    return { cls: 'bad', txt: '不可用', why: 能.reason || '' };
  };

  var main = document.getElementById('mods');

  表.forEach(function (模) {
    var card = document.createElement('section');
    card.className = 'card';

    var hd = document.createElement('div');
    hd.className = 'hd';
    var h2 = document.createElement('h2');
    h2.textContent = 模.名;
    hd.appendChild(h2);

    if (模.键 !== 'common') {
      var l = 灯(模.键);
      var lamp = document.createElement('span');
      lamp.className = 'lamp ' + l.cls;
      lamp.textContent = l.txt;
      hd.appendChild(lamp);
      if (l.why) {
        var why = document.createElement('span');
        why.className = 'why';
        why.textContent = l.why;
        hd.appendChild(why);
      }
    }

    // 三档开关（不可配的模块没有）
    if (模.开关) {
      var seg = document.createElement('span');
      seg.className = 'seg';
      var 当前 = String(取值(模.开关) || 'auto');
      档.forEach(function (d) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = d[1];
        b.title = d[2];
        b.setAttribute('aria-pressed', String(d[0] === 当前));
        b.onclick = (function (值) {
          return function () {
            [].forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', 'false'); });
            b.setAttribute('aria-pressed', 'true');
            记(模.开关, 值);
          };
        })(d[0]);
        seg.appendChild(b);
      });
      hd.appendChild(seg);
    }

    card.appendChild(hd);

    var desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = 模.说明 || '';
    card.appendChild(desc);

    // 装身体的提示只在"真的没有身体"时出现，别在装好的人面前也念一遍安装命令
    if (模.修法 && !(能力[模.键] && 能力[模.键].available)) {
      var fix = document.createElement('div');
      fix.className = 'bodyfix';
      fix.innerHTML = '这台没装身体，装上它才有鱼：<br><code>' + 模.修法 + '</code>';
      card.appendChild(fix);
    }

    if (模.字段 && 模.字段.length) {
      var g = document.createElement('div');
      g.className = 'fields';
      模.字段.forEach(function (f) {
        var lab = document.createElement('label');
        lab.textContent = f.名;
        g.appendChild(lab);

        var cell = document.createElement('div');
        cell.className = 'cell';
        var 旧 = 取值(f.路);
        var el;

        if (f.型 === '选') {
          el = document.createElement('select');
          (f.选 || []).forEach(function (o) {
            var op = document.createElement('option');
            op.value = o[0];
            op.textContent = o[1];
            el.appendChild(op);
          });
          el.value = 旧 == null ? '' : String(旧);
          el.onchange = function () { 记(f.路, el.value); };
        } else if (f.型 === '开关') {
          el = document.createElement('select');
          [['true', '要'], ['false', '不要']].forEach(function (o) {
            var op = document.createElement('option');
            op.value = o[0];
            op.textContent = o[1];
            el.appendChild(op);
          });
          el.value = 旧 === false ? 'false' : 'true';
          el.onchange = function () { 记(f.路, el.value === 'true'); };
        } else {
          el = document.createElement('input');
          el.type = f.型 === '数' ? 'number' : 'text';
          el.value = 旧 == null ? '' : String(旧);
          if (f.型 === '数') el.step = 'any';
          el.oninput = function () {
            if (f.型 === '数') {
              var n = Number(el.value);
              记(f.路, el.value === '' || !isFinite(n) ? 0 : n);
            } else {
              记(f.路, el.value);
            }
          };
        }
        cell.appendChild(el);
        if (f.提示) {
          var hint = document.createElement('div');
          hint.className = 'hint';
          hint.innerHTML = f.提示;
          cell.appendChild(hint);
        }
        g.appendChild(cell);
      });
      card.appendChild(g);
    }

    main.appendChild(card);
  });

  var msg = document.getElementById('msg');
  function 说话(文, 好) {
    msg.textContent = 文;
    msg.className = 好 ? 'ok' : 'bad';
    if (好) setTimeout(function () { if (msg.textContent === 文) { msg.textContent = ''; msg.className = ''; } }, 4000);
  }

  var 保存 = document.getElementById('save');
  保存.onclick = async function () {
    if (!Object.keys(补丁).length) return 说话('还没改任何东西。', true);
    保存.disabled = true;
    保存.textContent = '保存中…';
    try {
      var r = await fetch('/dsh-pet-voice/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(补丁),
      });
      var j = await r.json();
      if (j && j.ok) {
        补丁 = {};
        var 变了 = j.能力 || {};
        说话('已保存，立即生效。' + (变了.speak ? '（说话：' + (变了.speak.available ? '可用' : '不可用 — ' + (变了.speak.reason || '')) + '）' : ''), true);
        setTimeout(function () { location.reload(); }, 900);
      } else {
        说话('没存上：' + ((j && (j.message || j.error)) || ('HTTP ' + r.status)), false);
      }
    } catch (e) {
      说话('没存上：' + e.message, false);
    } finally {
      保存.disabled = false;
      保存.textContent = '保存';
    }
  };

  // 页面打开时再刷一次能力灯（右键点开的这一刻状态可能已经变了）
  fetch('/dsh-pet-voice/capabilities').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j) return;
    能力 = j; // 供下次渲染；已经渲染好的灯就不动了，避免眼睛跳
  }).catch(function () {});
})();
</script>
</body>
</html>`
}

/** 给测试和宿主用：模块表的浅拷贝（别让外部改到编译期常量） */
export const __设置页 = { 模块表, 档位 }
