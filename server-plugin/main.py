"""桌宠投喂口：把她的发言和「提醒我 …」写进 outbox.jsonl，桌面桌宠轮询读取。

只做两件事，不碰唤醒、不改人格、不调模型：
1. 她每发出一条消息 → 追加一行 {"type":"msg", "text": …}
2. 收到「（每天）提醒我 9:30 喝水」→ 追加一行 {"type":"reminder", "at":"09:30", …}

文件：/AstrBot/data/plugin_data/astrbot_pet_outbox/outbox.jsonl
桌宠侧：D:\\ds\\dafeiyu\\Pet（ssh tail -c 400000，按 ts 去重）
"""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

PLUGIN = "astrbot_plugin_pet_outbox"
# 比 wake_router（100000）低：它先记完自己的账，人家再抄一份给他，互不干扰
PRIORITY = 100

# 「提醒我 9:30 喝水」「每天 21 点提醒我吃药」「提醒我下午 3:00 开会」
RE_REMIND = re.compile(
    r"(?P<daily>每天)?\s*"
    r"(?:"
    r"(?P<when>(?:早上|上午|中午|下午|晚上|夜里)?\s*\d{1,2}\s*[:：点]\s*\d{0,2}\s*分?)"
    r"\s*(?:提醒我|叫我|喊我)\s*(?P<what>.+?)"
    r"|"
    r"(?:提醒我|叫我|喊我)\s*"
    r"(?P<when2>(?:早上|上午|中午|下午|晚上|夜里)?\s*\d{1,2}\s*[:：点]\s*\d{0,2}\s*分?)"
    r"\s*(?P<what2>.+?)"
    r")\s*[。！!]?$"
)

MAX_BYTES = 2 * 1024 * 1024


def _data_dir(context: Context) -> Path:
    base = Path("/AstrBot/data/plugin_data") / PLUGIN
    try:
        base.mkdir(parents=True, exist_ok=True)
        probe = base / ".w"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return base
    except Exception:
        try:
            d = Path(context.get_data_dir())
            d.mkdir(parents=True, exist_ok=True)
            return d
        except Exception:
            d = Path(__file__).resolve().parent / "data"
            d.mkdir(parents=True, exist_ok=True)
            return d


def _plain(event) -> str:
    parts = []
    for seg in getattr(event.message_obj, "message", []) or []:
        t = getattr(seg, "text", None)
        if isinstance(t, str):
            parts.append(t)
    return "".join(parts).strip()


def _segments(result) -> list:
    """结果对象上的组件链。chain 是 list 字段，message 是方法（往链里加文本），别混。"""
    for attr in ("chain",):
        val = getattr(result, attr, None)
        if val is None or callable(val):
            continue
        try:
            return list(val)
        except TypeError:
            continue
    return []


def _seg_text(seg) -> str:
    t = getattr(seg, "text", None)
    if callable(t):
        try:
            t = t()
        except Exception:
            t = None
    return t if isinstance(t, str) else ""


def _reply_text(event) -> str:
    """取「她要说出去的那句」，不是收到的消息。"""
    result = None
    fn = getattr(event, "get_result", None)
    if callable(fn):
        try:
            result = fn()
        except Exception:
            result = None
    if result is None:
        return ""
    text = "".join(_seg_text(s) for s in _segments(result)).strip()
    if text:
        return text
    gp = getattr(result, "get_plain_text", None)
    if callable(gp):
        try:
            return str(gp() or "").strip()
        except Exception:
            return ""
    return ""


def parse_clock(raw: str) -> str | None:
    """把「9:30 / 9点 / 晚上9点 / 下午3:00 / 21 点」压成 HH:mm。"""
    s = (raw or "").strip()
    if not s:
        return None
    hour_shift = 0
    if s.startswith(("下午", "晚上", "夜里")):
        hour_shift = 12
    elif s.startswith("中午"):
        hour_shift = 12
    m = re.search(r"(\d{1,2})\s*[:：点]\s*(\d{1,2})?", s)
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2) or 0)
    if hour_shift and hh < 12:
        hh += hour_shift
    if hh == 24:
        hh = 0
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None
    return f"{hh:02d}:{mm:02d}"


@register(PLUGIN, "hcr116", "桌宠投喂口：她的发言 + 提醒下发到 outbox.jsonl", "0.1.0")
class PetOutbox(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.dir = _data_dir(context)
        self.path = self.dir / "outbox.jsonl"
        self._trim()
        logger.info(f"[{PLUGIN}] outbox = {self.path}")

    def _trim(self) -> None:
        try:
            if not self.path.exists() or self.path.stat().st_size <= MAX_BYTES:
                return
            lines = self.path.read_text(encoding="utf-8", errors="ignore").splitlines()[-800:]
            self.path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        except Exception:
            logger.exception(f"[{PLUGIN}] 截断 outbox 失败")

    def _append(self, obj: dict) -> None:
        try:
            self._trim()
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
        except Exception:
            logger.exception(f"[{PLUGIN}] 写 outbox 失败")

    # ---------- 她的发言 ----------
    @filter.on_decorating_result(priority=PRIORITY)
    async def on_bot_reply(self, event: AstrMessageEvent):
        try:
            if getattr(event, "get_result", None) is None:
                return
            text = _reply_text(event)
            if not text or text.startswith("⏰"):
                return
            umo = str(getattr(event, "unified_msg_origin", "") or "")
            self._append({
                "ts": round(time.time(), 3),
                "id": uuid.uuid4().hex[:12],
                "type": "msg",
                "text": text,
                "where": umo.split(":")[0] + ":" + (umo.split(":")[1] if ":" in umo else ""),
            })
        except Exception:
            logger.exception(f"[{PLUGIN}] 记录发言失败")

    # ---------- 提醒 ----------
    @filter.event_message_type(filter.EventMessageType.ALL, priority=PRIORITY)
    async def on_message(self, event: AstrMessageEvent):
        try:
            text = _plain(event)
            if not text or len(text) > 120:
                return
            m = RE_REMIND.search(text)
            if not m:
                return
            raw_when = m.group("when") or m.group("when2") or ""
            what = (m.group("what") or m.group("what2") or "").strip(" 。，,、")
            at = parse_clock(raw_when)
            if not at or not what:
                logger.info(f"[{PLUGIN}] 看出像提醒但没解析成功：{text!r}")
                return
            daily = bool(m.group("daily"))
            self._append({
                "ts": round(time.time(), 3),
                "id": uuid.uuid4().hex[:12],
                "type": "reminder",
                "text": what,
                "at": at,
                "repeat": "daily" if daily else "once",
            })
            logger.info(f"[{PLUGIN}] 提醒下发 {at} {'每天' if daily else '一次'}：{what}")
        except Exception:
            logger.exception(f"[{PLUGIN}] 解析提醒失败")
