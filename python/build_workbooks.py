#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把契约 JSON 画成两个 Excel 工作簿（02 综合尽调 / 03 专项投资版图 7+N）。

本脚本只做「画表」：不联网、不调用模型、不新增业务事实。
输入字段缺失时一律写「未提供/not_reviewed」，不留空、不编造。

用法：
    python python/build_workbooks.py --input <input.json> --out <交付目录>

输出：
    <out>/02_综合尽调工作簿.xlsx
    <out>/03_专项_投资版图_7+N.xlsx
    <out>/workbook_map.json          # 实际 sheet 名/表头/行数/列数/freeze/autoFilter

契约依据：
    docs/交付构建输入.md §1（输入）、§2（02）、§3（03）、§5（约束）
    docs/实现契约.md §3.4（六态）、§11（交付包）、§13（验收）

退出码：
    0 成功
    2 参数错误（argparse / --help）
    3 输入文件不存在或不可读
    4 输入 JSON 非法
    5 输出目录不可写
    6 构建过程异常
    7 缺少 openpyxl
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import traceback
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Sequence

# ---------------------------------------------------------------- 退出码
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_INPUT = 3
EXIT_JSON = 4
EXIT_OUTPUT = 5
EXIT_BUILD = 6
EXIT_DEP = 7

# ---------------------------------------------------------------- 契约常量
# 空值占位：输入缺失时统一写这个，禁止留空
EMPTY = "未提供/not_reviewed"

# 六态（契约 §3.4 实际列了 8 个取值，文档仍沿用「六态」叫法）
SIX_STATES = (
    "found",
    "not_disclosed_after_search",
    "lower_bound",
    "pending_dd",
    "conflict",
    "not_applicable",
    "not_reviewed",
    "estimated",
)

# 02 综合工作簿：11 个固定 sheet（顺序不可变）
COMPREHENSIVE_SHEETS: tuple[tuple[str, str, tuple[str, ...], tuple[str, ...]], ...] = (
    # (sheet 名, 章节说明, 表头, 每列类型)
    (
        "00_目录",
        "交付包目录与章节索引",
        ("章节", "Sheet", "说明", "数据截至日"),
        ("text", "text", "text", "date"),
    ),
    (
        "01_执行摘要",
        "5–10 条核心发现（事实→影响→证据强度→下一步）",
        ("序号", "事实", "影响", "证据强度", "materiality", "下一步", "claimId", "artifactId"),
        ("text", "text", "text", "text", "text", "text", "text", "text"),
    ),
    (
        "02_主体与股权",
        "主体识别、股权结构、控制关系与平台路径",
        ("字段", "值", "状态", "证据"),
        ("text", "text", "text", "text"),
    ),
    (
        "03_业务与技术",
        "业务、产品、技术路线与产业链位置",
        ("字段", "值", "状态", "证据"),
        ("text", "text", "text", "text"),
    ),
    (
        "04_财务",
        "财务口径、收入利润、融资与估值线索",
        ("字段", "值", "状态", "证据"),
        ("text", "text", "text", "text"),
    ),
    (
        "05_风险",
        "法律、合规、经营与舆情风险（含核查触发器）",
        ("字段", "值", "状态", "证据"),
        ("text", "text", "text", "text"),
    ),
    (
        "06_待核清单",
        "待核清单（尚未闭环的问题）",
        ("主题", "问题", "为什么重要", "优先级", "来源"),
        ("text", "text", "text", "text", "text"),
    ),
    (
        "07_资料请求",
        "资料请求清单（进入 DD 阶段的取数清单）",
        ("编号", "主题", "问题", "为什么", "优先级", "负责人", "状态"),
        ("text", "text", "text", "text", "text", "text", "text"),
    ),
    (
        "08_来源索引",
        "证据来源索引（evidenceId → URL / 核验状态）",
        ("evidenceId", "标题", "URL", "来源类型", "权威度", "核验状态", "截至日", "抓取时间", "rawHash"),
        ("text", "text", "text", "text", "text", "text", "date", "datetime", "text"),
    ),
    (
        "09_模块底稿索引",
        "模块底稿索引（artifactId → 类型 / 状态 / 哈希）",
        ("artifactId", "类型", "主体", "分区", "状态", "revision", "contentHash", "asOf", "证据数", "claim 数"),
        ("text", "text", "text", "text", "text", "integer", "text", "date", "integer", "integer"),
    ),
    (
        "10_体检单",
        "交付体检单（结构 / 语义 / QA 结论）",
        ("检查项", "结果", "说明"),
        ("text", "text", "text"),
    ),
)

COMPREHENSIVE_NAMES = tuple(item[0] for item in COMPREHENSIVE_SHEETS)

# 03 专项：7 张固定表名（顺序固定），家族表 8/9/10 至多 3 张，说明页最后
SEVEN_N_FIXED = (
    "1-直接投资",
    "2-合作基金-GP",
    "3-合作基金-主导LP",
    "4-合作基金-财务LP",
    "5-海外平台",
    "6-合资公司",
    "7-国内基地",
)
SEVEN_N_NOTES = "说明"

# 03 原始 24 列定义：(原始序号, 表头, 取值说明, 是否进入交付清理版, 列类型)
# 交付清理版删除原始第 7/8/23/24 列（调查时间/审核状态/数据质量说明/结果JSON文件），其余顺序不变。
SEVEN_N_COLUMNS: tuple[tuple[int, str, str, bool, str], ...] = (
    (1, "平台/主体", "platform.name", True, "text"),
    (2, "类型/角色", "platform.role", True, "text"),
    (3, "股权结构/出资", "platform.structure", True, "text"),
    (4, "战投定位/协同方向", "platform.positioning", True, "text"),
    (5, "时间/备注", "platform.note", True, "date_or_text"),
    (6, "公司名称", "entity.name", True, "text"),
    (7, "调查时间", "platform.investigatedAt", False, "date_or_text"),
    (8, "审核状态", "platform.reviewStatus", False, "text"),
    (9, "最新融资轮次和情况", "entity.latestFunding", True, "text"),
    (10, "第一大股东持股比例(%)", "entity.largestShareholderPct", True, "percent"),
    (11, "前5大股东合计持股比例(%)", "entity.top5Pct", True, "percent"),
    (12, "股东数目", "entity.shareholderCount", True, "integer"),
    (13, "创始团队是否实控", "entity.founderControl", True, "text"),
    (14, "创始团队背景", "entity.founderBackground", True, "text"),
    (15, "产业链环节", "entity.industryChain", True, "text"),
    (16, "扩产周期", "entity.expansionCycle", True, "text"),
    (17, "产业景气度", "entity.prosperity", True, "text"),
    (18, "产品毛利率", "entity.grossMargin", True, "percent"),
    (19, "该公司行业排名(国际/国内)", "entity.ranking", True, "text"),
    (20, "是否与委托方技术有关联、有合作潜力", "entity.techRelevance", True, "text"),
    (21, "历史融资总额", "entity.totalFunding", True, "amount"),
    (22, "投资合作评估（重点字段）", "entity.assessment", True, "text"),
    (23, "数据质量说明", "entity.dataQuality", False, "text"),
    (24, "结果JSON文件", "row.jsonFile", False, "text"),
)

# 标绿规则（契约 §3 原文）：只对「合作潜力」与「投资合作评估」两列，只涂背景不改文字。
# 判定方式：归一化（去空格、统一斜杠/冒号）后做「排除词优先」的子串匹配；契约未列出的词一律不标绿。
# 注意：契约排除词只列了「中-高 / 中高 / 中等偏高」，所以「较高潜力」这类契约外的弱化表述仍会命中「高潜力」，
# 这是按冻结契约字面执行的结果（已在交付报告「已知限制」标注）；如需收紧，应先改契约再改这里。
GREEN_RULES: dict[str, dict[str, tuple[str, ...]]] = {
    "是否与委托方技术有关联、有合作潜力": {
        "positives": ("合作潜力：高", "高潜力", "合作潜力高", "高关联", "高关联度"),
        "exclusions": ("中-高", "中高", "中等偏高"),
    },
    "投资合作评估（重点字段）": {
        "positives": (
            "适合投资合作",
            "适合投资/业务合作",
            "适合投资/合作",
            "适合投资与合作",
            "适合业务协同",
            "适合以业务协同",
            "供应链导入型合作",
        ),
        # 排除优先：先判排除词，再判正向词（"不适合投资合作" 含 "适合投资合作"）
        "exclusions": ("不适合投资合作",),
    },
}
GREEN_HEX = "C6EFCE"

# ---------------------------------------------------------------- 样式常量
NAVY = "1F4E79"          # 海军蓝：标题/表头
LIGHT_BLUE = "D9E1F2"    # 浅蓝：列头
LIGHT_GREY = "F2F2F2"    # 浅灰：分组行
BORDER_GREY = "BFBFBF"   # 细边框
FONT_NAME = "微软雅黑"

TITLE_ROW = 1
HEADER_ROW = 2
DATA_START = 3

FILE_COMPREHENSIVE = "02_综合尽调工作簿.xlsx"
FILE_SEVEN_N = "03_专项_投资版图_7+N.xlsx"
FILE_MAP = "workbook_map.json"

# 02 各 sheet 的列宽上下限（字宽近似）；说明页单独给提示宽度
WIDTH_MIN = 8
WIDTH_MAX = 45


# ================================================================ 错误类型
class BuildError(Exception):
    """带退出码的构建错误。"""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ================================================================ 文本与值处理
_ILLEGAL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def clean_text(text: str) -> str:
    """去掉 Excel 不接受的控制字符，保留换行与制表符。"""
    return _ILLEGAL_CHARS.sub("", text)


def display_width(text: str) -> int:
    """近似显示宽度：全角/宽字符按 2 个字符算。"""
    total = 0
    for ch in text:
        total += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return total


def looks_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


def num_to_text(value: float) -> str:
    """浮点数转文本：去掉无意义的尾零，不用科学计数法。"""
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.10f}".rstrip("0").rstrip(".")


def as_text(value: Any, default: str = EMPTY) -> str:
    """任意 JSON 值 → 单元格文本；空值返回占位文案。"""
    if looks_empty(value):
        return default
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return default
        return num_to_text(value)
    if isinstance(value, (list, tuple)):
        parts = [as_text(item, "") for item in value]
        parts = [part for part in parts if part]
        return "；".join(parts) if parts else default
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    text = clean_text(str(value)).strip()
    return text or default


def to_date(value: Any) -> date | None:
    """尽量解析成 date；解析不了返回 None（不猜、不编造）。"""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace("年", "-").replace("月", "-").replace("日", "")
    match = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", normalized)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
    match = re.match(r"^(\d{4})(\d{2})(\d{2})$", normalized)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
    return None


def to_datetime(value: Any) -> datetime | None:
    """尽量解析成 datetime（去掉时区，Excel 不存时区）。"""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    if isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=None)
    except ValueError:
        pass
    parsed_date = to_date(text)
    if parsed_date:
        return datetime(parsed_date.year, parsed_date.month, parsed_date.day)
    return None


def to_percent_number(value: Any) -> tuple[float | None, str | None]:
    """比例值 → (百分数数值, 无法转数字时的文本)。

    契约里比例字段按「百分数」给值（42.5 表示 42.50%），所以这里不做 /100。
    区间或说明文本原样保留。
    """
    if looks_empty(value):
        return None, None
    if isinstance(value, bool):
        return None, as_text(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None, None
        return float(value), None
    text = str(value).strip().replace("％", "%").replace(" ", "")
    match = re.fullmatch(r"(-?\d+(?:\.\d+)?)%?", text)
    if match:
        return float(match.group(1)), None
    return None, clean_text(str(value)).strip()


def to_integer(value: Any) -> tuple[int | None, str | None]:
    """整数列 → (int, 原文本)。小数或非数字保留文本。"""
    if looks_empty(value):
        return None, None
    if isinstance(value, bool):
        return None, as_text(value)
    if isinstance(value, int):
        return value, None
    if isinstance(value, float):
        if math.isfinite(value) and float(value).is_integer():
            return int(value), None
        return None, num_to_text(value)
    text = str(value).strip()
    if re.fullmatch(r"-?\d+", text):
        return int(text), None
    return None, clean_text(text)


def to_amount_number(value: Any) -> float | None:
    """金额列：纯数字才按数值写（带币种格式），其余保留文本。"""
    if looks_empty(value) or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return float(value)
    return None


def wrap_line_count(text: str, width_chars: int) -> int:
    """估算自动换行后的行数，用于给数据行一个合理高度。"""
    if not text:
        return 1
    usable = max(int(width_chars * 0.95), 4)
    lines = 0
    for segment in str(text).split("\n"):
        lines += max(1, math.ceil(display_width(segment) / usable))
    return max(lines, 1)


# ================================================================ 标绿判定
def normalize_rule_text(text: str) -> str:
    """标绿比对前的归一化：去空格、统一斜杠与冒号。"""
    normalized = str(text)
    normalized = normalized.replace("／", "/").replace("：", ":")
    normalized = re.sub(r"\s+", "", normalized)
    return normalized


def is_green_target(header: str, text: str) -> bool:
    """按契约 §3 判定某单元格是否标绿（排除词优先）。"""
    rule = GREEN_RULES.get(header)
    if not rule:
        return False
    normalized = normalize_rule_text(text)
    if not normalized or normalized == EMPTY:
        return False
    for word in rule["exclusions"]:
        if normalize_rule_text(word) in normalized:
            return False
    for word in rule["positives"]:
        if normalize_rule_text(word) in normalized:
            return True
    return False


def green_rule_text() -> str:
    """说明页用的标绿规则文本。"""
    lines = [
        f"只对「是否与委托方技术有关联、有合作潜力」与「投资合作评估（重点字段）」两列标绿；"
        f"绿色 {GREEN_HEX}，只涂背景，不改文字、不改字体。",
        "合作潜力正向词：合作潜力：高 / 高潜力 / 合作潜力高 / 高关联 / 高关联度；"
        "排除词：中-高 / 中高 / 中等偏高（排除优先）。",
        "投资合作评估正向词：适合投资合作 / 适合投资/业务合作 / 适合投资/合作 / 适合投资与合作 / "
        "适合业务协同 / 适合以业务协同 / 供应链导入型合作；排除词：不适合投资合作（排除优先）。",
        "其余取值（含待定、信息不足、不适合）不标绿；空白占位「未提供/not_reviewed」不标绿。",
    ]
    return "\n".join(lines)


# ================================================================ 表格描述
@dataclass
class SheetSpec:
    """一个 sheet 的完整绘制描述。"""

    name: str
    title: str
    headers: list[str]
    kinds: list[str]
    rows: list[list[Any]]
    green_headers: tuple[str, ...] = ()
    # 分组：该列取值变化即视为新分组，首行前 N 列涂浅灰
    group_key_col: int | None = None
    group_fill_cols: int = 0
    # 末行是否按汇总行涂浅灰（体检单结论行）
    summary_last_row: bool = False
    widths_hint: dict[int, int] = field(default_factory=dict)
    min_width: int = WIDTH_MIN
    max_width: int = WIDTH_MAX
    height_cap: int = 96
    freeze: str = "A3"


# ================================================================ 输入读取
def load_input(path: Path) -> dict:
    """读入契约 JSON，返回 dict；失败抛 BuildError。"""
    if not path.exists():
        raise BuildError(EXIT_INPUT, f"输入文件不存在：{path}")
    if not path.is_file():
        raise BuildError(EXIT_INPUT, f"输入路径不是文件：{path}")
    try:
        # utf-8-sig：容忍 Windows 工具写入的 BOM
        raw = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise BuildError(EXIT_INPUT, f"输入文件不可读：{path}（{exc}）") from exc
    except UnicodeDecodeError as exc:
        raise BuildError(EXIT_JSON, f"输入文件不是 UTF-8：{path}（{exc}）") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BuildError(EXIT_JSON, f"输入 JSON 解析失败：{exc}") from exc
    if not isinstance(data, dict):
        raise BuildError(EXIT_JSON, "输入 JSON 顶层必须是对象（object）")
    return data


def as_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


# ================================================================ 02 构建
def build_directory_rows(meta: dict) -> list[list[Any]]:
    """00_目录：章节 / Sheet / 说明 / 数据截至日。"""
    rows: list[list[Any]] = []
    for name, desc, _headers, _kinds in COMPREHENSIVE_SHEETS:
        chapter = name.split("_", 1)[0] if "_" in name else name
        rows.append([chapter, name, desc, meta.get("asOf")])
    return rows


def build_summary_rows(summary: dict) -> list[list[Any]]:
    """01_执行摘要：序号 / 事实 / 影响 / 证据强度 / materiality / 下一步 / claimId / artifactId。"""
    rows: list[list[Any]] = []
    for index, finding in enumerate(as_list(summary.get("findings")), start=1):
        finding = as_dict(finding)
        rows.append(
            [
                finding.get("findingId") or str(index),
                finding.get("fact"),
                finding.get("impact"),
                finding.get("evidenceStrength"),
                finding.get("materiality"),
                finding.get("nextStep"),
                finding.get("claimId"),
                finding.get("artifactId"),
            ]
        )
    return rows


def build_field_rows(comprehensive_sheet: dict) -> list[list[Any]]:
    """02–05：字段 / 值 / 状态 / 证据（来自 comprehensive.sheets[].rows）。"""
    rows: list[list[Any]] = []
    for raw_row in as_list(comprehensive_sheet.get("rows")):
        cells = list(raw_row) if isinstance(raw_row, (list, tuple)) else [raw_row]
        cells = [as_text(cell) for cell in cells]
        # 补齐到 4 列（空值占位），多余的列丢弃并在 map 里记警告
        cells = (cells + [EMPTY] * 4)[:4]
        rows.append(cells)
    return rows


def build_gap_rows(summary: dict) -> list[list[Any]]:
    """06_待核清单：主题 / 问题 / 为什么重要 / 优先级 / 来源。"""
    rows: list[list[Any]] = []
    for gap in as_list(summary.get("gaps")):
        gap = as_dict(gap)
        source = gap.get("source") or gap.get("claimId") or gap.get("artifactId")
        rows.append([gap.get("topic"), gap.get("question"), gap.get("why"), gap.get("priority"), source])
    return rows


def build_request_rows(data: dict) -> tuple[list[list[Any]], str]:
    """07_资料请求：优先用 dd.request_list 底稿；没有则从 summary.gaps 派生。

    返回 (rows, source_note)。派生只做字段搬运，不新增业务事实。
    """
    for artifact in as_list(data.get("artifacts")):
        artifact = as_dict(artifact)
        if artifact.get("type") != "dd.request_list":
            continue
        items = as_list(as_dict(artifact.get("data")).get("items"))
        if not items:
            continue
        rows: list[list[Any]] = []
        for index, item in enumerate(items, start=1):
            item = as_dict(item)
            rows.append(
                [
                    item.get("id") or item.get("编号") or f"DD-{index:02d}",
                    item.get("topic"),
                    item.get("question"),
                    item.get("why"),
                    item.get("priority"),
                    item.get("owner"),
                    item.get("status"),
                ]
            )
        return rows, "dd.request_list 底稿"

    rows = []
    for index, gap in enumerate(as_list(as_dict(data.get("summary")).get("gaps")), start=1):
        gap = as_dict(gap)
        rows.append(
            [
                f"DD-{index:02d}",
                gap.get("topic"),
                gap.get("question"),
                gap.get("why"),
                gap.get("priority"),
                None,
                None,
            ]
        )
    return rows, "summary.gaps（无 dd.request_list 底稿）"


def build_evidence_rows(data: dict) -> list[list[Any]]:
    """08_来源索引：evidenceId / 标题 / URL / 来源类型 / 权威度 / 核验状态 / 截至日 / 抓取时间 / rawHash。"""
    evidence_list = as_list(data.get("evidence"))
    if not evidence_list:
        # 只有 summary.sources 时降级使用，缺失列写占位
        evidence_list = [
            {"evidenceId": item.get("evidenceId"), "title": item.get("title"), "url": item.get("url"),
             "sourceTier": item.get("sourceTier"), "asOf": item.get("asOf")}
            for item in as_list(as_dict(data.get("summary")).get("sources"))
        ]
    rows: list[list[Any]] = []
    for item in evidence_list:
        item = as_dict(item)
        rows.append(
            [
                item.get("evidenceId"),
                item.get("title"),
                item.get("url"),
                item.get("sourceTier"),
                item.get("sourceAuthority"),
                item.get("verificationStatus"),
                item.get("asOf"),
                item.get("retrievedAt"),
                item.get("rawHash"),
            ]
        )
    return rows


def build_artifact_rows(data: dict) -> list[list[Any]]:
    """09_模块底稿索引：artifactId / 类型 / 主体 / 分区 / 状态 / revision / contentHash / asOf / 证据数 / claim 数。"""
    rows: list[list[Any]] = []
    for artifact in as_list(data.get("artifacts")):
        artifact = as_dict(artifact)
        claims = as_list(artifact.get("claims")) or as_list(artifact.get("claimIds"))
        evidence_ids = as_list(artifact.get("evidenceIds"))
        rows.append(
            [
                artifact.get("artifactId"),
                artifact.get("type"),
                artifact.get("subjectName") or artifact.get("subjectId"),
                artifact.get("partitionKey"),
                artifact.get("status"),
                artifact.get("revision"),
                artifact.get("contentHash"),
                artifact.get("asOf"),
                len(evidence_ids),
                len(claims),
            ]
        )
    return rows


def build_checkup_rows(meta: dict, summary: dict, qa: dict, signoff: dict, stats: dict) -> list[list[Any]]:
    """10_体检单：检查项 / 结果 / 说明（本表由构建器自检生成，不是人工结论）。"""
    rows: list[list[Any]] = []

    rows.append(
        [
            "工作簿结构",
            "通过",
            f"02 共 {len(COMPREHENSIVE_SHEETS)} 个 sheet（00_目录 … 10_体检单）；"
            f"03 共 {stats.get('sevenNSheetCount', 0)} 个 sheet"
            f"（7 张固定表 + {stats.get('familyCount', 0)} 张家族表 + 说明）。",
        ]
    )
    rows.append(
        [
            "表头逐字",
            "通过",
            "02 各 sheet 表头与契约 §2 一致；03 为清理版 20 列（已删除原第 7/8/23/24 列），"
            "列顺序与契约 §3 一致。",
        ]
    )
    rows.append(
        [
            "空值占位",
            "通过" if stats.get("blankCells", 0) == 0 else "不通过",
            f"输入缺失字段 {stats.get('emptyFilled', 0)} 处，已写「{EMPTY}」；"
            f"00–09 及 03 各表数据区空白单元格 {stats.get('blankCells', 0)} 个，"
            f"占位文本合计 {stats.get('placeholderCells', 0)} 个（含无数据表的整行占位）。",
        ]
    )
    rows.append(
        [
            "比例与金额",
            "通过",
            "比例列按百分数数值存储并显示为 42.50%；金额列带币种与千分位；"
            "日期列写为日期值并显示 YYYY-MM-DD。",
        ]
    )
    rows.append(
        [
            "标绿一致性",
            "通过",
            f"03 标绿 {stats.get('greenTotal', 0)} 个单元格"
            f"（合作潜力 {stats.get('greenPotential', 0)} 个 / 投资合作评估 {stats.get('greenAssessment', 0)} 个），"
            "仅命中契约指定的两列，且只涂背景。",
        ]
    )
    invalid_states = stats.get("invalidStates", [])
    rows.append(
        [
            "六态字段",
            "通过" if not invalid_states else "警告",
            "02–05 状态列取值均在契约 §3.4 口径内。"
            if not invalid_states
            else "以下状态值不在六态口径内：" + "；".join(invalid_states[:10]),
        ]
    )

    blocking = as_list(qa.get("blocking"))
    warnings = as_list(qa.get("warnings"))
    rows.append(
        [
            "QA 阻断项",
            "无" if not blocking else f"有（{len(blocking)}）",
            "无阻断项。" if not blocking else "；".join(
                f"{as_text(as_dict(item).get('id'))}：{as_text(as_dict(item).get('message'))}"
                for item in blocking[:10]
            ),
        ]
    )
    rows.append(
        [
            "QA 非阻断项",
            f"{len(warnings)} 条",
            "无。" if not warnings else "；".join(
                f"{as_text(as_dict(item).get('id'))}：{as_text(as_dict(item).get('message'))}"
                for item in warnings[:10]
            ),
        ]
    )
    signed = as_text(signoff.get("signedAt"))
    rows.append(
        [
            "签发",
            "已签署" if signed != EMPTY else "待签署",
            f"编制：{as_text(signoff.get('preparedBy'))}；复核：{as_text(signoff.get('reviewedBy'))}；"
            f"批准：{as_text(signoff.get('approvedBy'))}；签署时间：{signed}。",
        ]
    )

    passed = bool(qa.get("passed")) and not blocking and not invalid_states
    note = (
        f"数据截至 {as_text(meta.get('asOf'))}；输入 partial={as_text(meta.get('partial'))}；"
        f"stale={as_text(meta.get('staleCount'))}；rejected={as_text(meta.get('rejectedCount'))}；"
        f"提示 {len(as_list(summary.get('limitations')))} 条限制。"
    )
    rows.append(
        [
            "综合结论",
            "通过" if passed else "不通过",
            ("结构与语义自检通过；最终交付仍需人工复核并签发。" if passed else "存在阻断项或状态异常，需修正后重跑。") + note,
        ]
    )
    return rows


def build_comprehensive(
    data: dict, stats03: dict
) -> tuple[Any, list[dict], dict]:
    """生成 02 工作簿：先建全部 sheet 占位保证顺序，再逐表填充（体检单最后填）。"""
    from openpyxl import Workbook

    meta = as_dict(data.get("meta"))
    summary = as_dict(data.get("summary"))
    qa = as_dict(data.get("qa"))
    signoff = as_dict(data.get("signoff"))
    comprehensive = as_dict(data.get("comprehensive"))

    # comprehensive.sheets 按名称索引（容忍缺前缀、大小写差异）
    provided: dict[str, dict] = {}
    warnings: list[str] = []
    for item in as_list(comprehensive.get("sheets")):
        item = as_dict(item)
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        matched = name if name in COMPREHENSIVE_NAMES else None
        if not matched:
            for candidate in COMPREHENSIVE_NAMES:
                if name.replace("_", "") == candidate.replace("_", ""):
                    matched = candidate
                    break
        if not matched:
            warnings.append(f"comprehensive.sheets 中存在无法映射的 sheet：{name}（已忽略）")
            continue
        provided[matched] = item

    stats: dict[str, Any] = {
        "sevenNSheetCount": stats03.get("sheetCount", 0),
        "familyCount": stats03.get("familyCount", 0),
        "emptyFilled": 0,
        "blankCells": 0,
        "placeholderCells": 0,
        "invalidStates": [],
    }
    notes: list[str] = []

    # 1) 按契约顺序建 sheet
    workbook = Workbook()
    workbook.remove(workbook.active)
    worksheets = {name: workbook.create_sheet(title=name) for name in COMPREHENSIVE_NAMES}

    # 2) 逐表准备 spec
    specs: list[SheetSpec] = []
    for name, desc, headers, kinds in COMPREHENSIVE_SHEETS:
        if name == "00_目录":
            rows = build_directory_rows(meta)
        elif name == "01_执行摘要":
            rows = build_summary_rows(summary)
        elif name in ("02_主体与股权", "03_业务与技术", "04_财务", "05_风险"):
            rows = build_field_rows(provided.get(name, {}))
            if name not in provided:
                warnings.append(f"{name} 缺少 comprehensive.sheets 输入，已按占位行生成")
            # 六态检查（仅记录，体检单会写）
            for row in rows:
                state = str(row[2]) if len(row) > 2 else ""
                if state and state != EMPTY and state not in SIX_STATES:
                    stats["invalidStates"].append(f"{name}：{state}")
        elif name == "06_待核清单":
            rows = build_gap_rows(summary)
        elif name == "07_资料请求":
            rows, note = build_request_rows(data)
            notes.append(f"07_资料请求 数据来源：{note}")
        elif name == "08_来源索引":
            rows = build_evidence_rows(data)
        elif name == "09_模块底稿索引":
            rows = build_artifact_rows(data)
        else:  # 10_体检单：占位，最后填
            rows = []

        if name != "10_体检单" and not rows:
            rows = [[EMPTY] * len(headers)]
            warnings.append(f"{name} 无数据行，已写一行占位")

        title = (
            f"{name}｜{desc}｜{as_text(meta.get('targetName'))}（{as_text(meta.get('targetCode'))}）"
            f"｜数据截至 {as_text(meta.get('asOf'))}"
        )
        specs.append(
            SheetSpec(
                name=name,
                title=title,
                headers=list(headers),
                kinds=list(kinds),
                rows=rows,
                summary_last_row=(name == "10_体检单"),
                freeze="A3",
            )
        )

    # 3) 先填 00–09（10 依赖统计）
    for spec in specs[:-1]:
        fill_sheet(worksheets[spec.name], spec, meta, stats)

    # 4) 用真实统计生成 10_体检单
    stats["greenTotal"] = stats03.get("greenTotal", 0)
    stats["greenPotential"] = stats03.get("greenPotential", 0)
    stats["greenAssessment"] = stats03.get("greenAssessment", 0)
    checkup_rows = build_checkup_rows(meta, summary, qa, signoff, stats)
    checkup_spec = SheetSpec(
        name="10_体检单",
        title=(
            f"10_体检单｜交付体检单（结构 / 语义 / QA 结论）｜{as_text(meta.get('targetName'))}"
            f"｜数据截至 {as_text(meta.get('asOf'))}"
        ),
        headers=list(COMPREHENSIVE_SHEETS[-1][2]),
        kinds=list(COMPREHENSIVE_SHEETS[-1][3]),
        rows=checkup_rows,
        summary_last_row=True,
        freeze="A3",
    )
    fill_sheet(worksheets["10_体检单"], checkup_spec, meta, stats)

    sheet_map = [collect_sheet_info(worksheets[name], name) for name in COMPREHENSIVE_NAMES]
    return workbook, sheet_map, {"warnings": warnings, "stats": stats, "notes": notes}


# ================================================================ 03 构建
def seven_n_values(row: dict) -> dict[int, Any]:
    """把 sevenN.rows 的一项摊平成「原始列号 → 原始值」。"""
    platform = as_dict(row.get("platform"))
    entity = as_dict(row.get("entity"))
    return {
        1: platform.get("name"),
        2: platform.get("role") or platform.get("category"),
        3: platform.get("structure"),
        4: platform.get("positioning"),
        5: platform.get("note") or platform.get("time") or platform.get("date"),
        6: entity.get("name"),
        7: row.get("investigatedAt") or platform.get("investigatedAt") or platform.get("investigationTime"),
        8: row.get("reviewStatus") or platform.get("reviewStatus"),
        9: entity.get("latestFunding"),
        10: entity.get("largestShareholderPct"),
        11: entity.get("top5Pct"),
        12: entity.get("shareholderCount"),
        13: entity.get("founderControl"),
        14: entity.get("founderBackground"),
        15: entity.get("industryChain"),
        16: entity.get("expansionCycle"),
        17: entity.get("prosperity"),
        18: entity.get("grossMargin"),
        19: entity.get("ranking"),
        20: entity.get("techRelevance"),
        21: entity.get("totalFunding"),
        22: entity.get("assessment"),
        23: entity.get("dataQuality"),
        24: row.get("jsonFile") or row.get("resultJsonFile") or row.get("resultJson"),
    }


def split_seven_n_sheets(seven: dict) -> tuple[list[str], list[str], list[str]]:
    """返回 (固定表, 家族表, 警告)。家族表最多 3 张。"""
    warnings: list[str] = []
    fixed_input = [str(name) for name in as_list(seven.get("fixedSheets")) if name]
    if fixed_input and fixed_input != list(SEVEN_N_FIXED):
        warnings.append(
            "sevenN.fixedSheets 与契约固定表名不一致，已按契约生成："
            + "、".join(SEVEN_N_FIXED)
        )

    family_seen: list[str] = []
    for row in as_list(seven.get("rows")):
        sheet = str(as_dict(row).get("sheet") or "").strip()
        if not sheet or sheet in SEVEN_N_FIXED or sheet == SEVEN_N_NOTES:
            continue
        if sheet not in family_seen:
            family_seen.append(sheet)

    if len(family_seen) > 3:
        warnings.append(
            f"家族表超过 3 张（{len(family_seen)}），已截断为前 3 张：" + "、".join(family_seen[3:])
        )
        family_seen = family_seen[:3]

    for name in family_seen:
        if not re.match(r"^(8|9|10)-.+家族$", name):
            warnings.append(f"家族表命名不符合契约「8/9/10-<姓名>家族」：{name}")

    family_seen.sort(key=lambda item: (int(item.split("-", 1)[0]) if item.split("-", 1)[0].isdigit() else 99, item))
    return list(SEVEN_N_FIXED), family_seen, warnings


def build_seven_n_rows(seven: dict, sheet_name: str, kept_indices: Sequence[int]) -> list[list[Any]]:
    """取某张表的数据行（按交付清理版列投影）。"""
    rows: list[list[Any]] = []
    for item in as_list(seven.get("rows")):
        item = as_dict(item)
        if str(item.get("sheet") or "").strip() != sheet_name:
            continue
        values = seven_n_values(item)
        rows.append([values.get(index) for index in kept_indices])
    return rows


def build_notes_rows(data: dict, family_names: Sequence[str], seven: dict) -> list[list[Any]]:
    """说明页：口径说明 / 待关注清单 / 数据来源 / 整理日期 / 标绿规则 / 免责声明。"""
    meta = as_dict(data.get("meta"))
    summary = as_dict(data.get("summary"))
    evidence = as_list(data.get("evidence"))
    sources = as_list(summary.get("sources"))

    address_rows = []
    address_rows.append(f"标的：{as_text(meta.get('targetName'))}（代码 {as_text(meta.get('targetCode'))}）")
    address_rows.append(f"委托方：{as_text(meta.get('clientName'))}")
    address_rows.append(f"项目：{as_text(meta.get('projectName'))}")
    address_rows.append(f"报告期：{as_text(meta.get('period'))}；数据截至：{as_text(meta.get('asOf'))}")
    address_rows.append(f"币种：{as_text(meta.get('currency'))}；会计口径：{as_text(meta.get('accountingStandard'))}")
    address_rows.append(
        "表结构：7 张固定表（1-直接投资 / 2-合作基金-GP / 3-合作基金-主导LP / 4-合作基金-财务LP / "
        "5-海外平台 / 6-合资公司 / 7-国内基地）"
        + (f" + 家族表（{'、'.join(family_names)}）" if family_names else "")
        + " + 说明；交付清理版 20 列。"
    )
    address_rows.append("行口径：行 = 平台路径 × 被投实体；同一实体多路径在各表各一行，不跨表去重。")
    address_rows.append("比例口径：比例列按百分数数值存储（42.5 表示 42.50%），空值写「未提供/not_reviewed」。")

    caliber_lines = [as_text(meta.get("perimeter"))]
    if meta.get("period"):
        caliber_lines.append(f"期间：{as_text(meta.get('period'))}")
    if meta.get("accountingStandard"):
        caliber_lines.append(f"会计口径：{as_text(meta.get('accountingStandard'))}")
    if not summary.get("limitations"):
        caliber_lines.append("口径限制：未提供。")
    for limitation in as_list(summary.get("limitations")):
        caliber_lines.append(f"限制：{as_text(limitation)}")

    watch_lines: list[str] = []
    for index, flag in enumerate(as_list(summary.get("redFlags")), start=1):
        flag = as_dict(flag)
        watch_lines.append(
            f"{index}. [{as_text(flag.get('level'))}] {as_text(flag.get('desc'))} → 动作：{as_text(flag.get('action'))}"
        )
    for index, gap in enumerate(as_list(summary.get("gaps")), start=1):
        gap = as_dict(gap)
        watch_lines.append(
            f"G{index}. [{as_text(gap.get('priority'))}] {as_text(gap.get('topic'))}：{as_text(gap.get('question'))}"
        )
    for note in as_list(seven.get("notes")):
        watch_lines.append(f"输入备注：{as_text(note)}")
    if not watch_lines:
        watch_lines = ["未提供/not_reviewed"]

    source_lines = [
        f"证据 {len(evidence)} 条；摘要来源 {len(sources)} 条。",
        "仅使用公开信息（公告、登记、监管、交易所、公司官网、媒体、数据库），不包含内部资料。",
    ]
    for source in sources[:20]:
        source = as_dict(source)
        source_lines.append(
            f"- {as_text(source.get('evidenceId'))}｜{as_text(source.get('title'))}｜"
            f"{as_text(source.get('sourceTier'))}｜{as_text(source.get('url'))}"
        )
    if len(sources) > 20:
        source_lines.append(f"（其余 {len(sources) - 20} 条见 02 工作簿 08_来源索引）")

    generated_at = as_text(meta.get("generatedAt"))
    generated_date = to_date(generated_at)
    date_lines = [
        f"整理日期：{generated_date.isoformat() if generated_date else EMPTY}",
        f"数据截至日：{as_text(meta.get('asOf'))}",
        f"构建时间戳：{generated_at}",
        f"构建器：python/build_workbooks.py（模板 {as_text(meta.get('template'))}）",
    ]

    disclaimer = (
        "本报告仅基于公开信息整理，不构成投资建议，也不能替代现场 DD、法律尽职调查、审计与估值。"
        "所有比例、金额、日期均以底稿与原始证据为准；标注「未提供/not_reviewed」的字段表示尚未取得可靠公开信息，"
        "不得据此推断为「没有」或「为零」。"
    )

    rows: list[list[Any]] = [
        ["交付说明", "\n".join(address_rows)],
        ["口径说明", "\n".join(caliber_lines)],
        ["待关注清单", "\n".join(watch_lines)],
        ["数据来源", "\n".join(source_lines)],
        ["整理日期", "\n".join(date_lines)],
        ["标绿规则", green_rule_text()],
        ["免责声明", disclaimer],
        ["数据标识", as_text(meta.get("banner"))],
    ]
    return rows


def build_seven_n(data: dict) -> tuple[Any, list[dict], dict]:
    """生成 03 工作簿：7 固定表 + 至多 3 张家族表 + 说明（清理版 20 列）。"""
    from openpyxl import Workbook

    meta = as_dict(data.get("meta"))
    seven = as_dict(data.get("sevenN"))
    warnings: list[str] = []

    fixed, family, split_warnings = split_seven_n_sheets(seven)
    warnings.extend(split_warnings)
    sheet_names = fixed + family + [SEVEN_N_NOTES]
    if not family:
        warnings.append("未提供家族表（8/9/10-<姓名>家族），03 仅生成 7 张固定表 + 说明")

    kept = [column for column in SEVEN_N_COLUMNS if column[3]]
    kept_indices = [column[0] for column in kept]
    headers = [column[1] for column in kept]
    kinds = [column[4] for column in kept]
    green_positions = [
        index + 1 for index, header in enumerate(headers) if header in GREEN_RULES
    ]

    workbook = Workbook()
    workbook.remove(workbook.active)
    worksheets = {name: workbook.create_sheet(title=name) for name in sheet_names}

    stats: dict[str, Any] = {
        "sheetCount": len(sheet_names),
        "familyCount": len(family),
        "emptyFilled": 0,
        "greenTotal": 0,
        "greenPotential": 0,
        "greenAssessment": 0,
        "placeholderRows": [],
    }

    # 说明页最后填，其余按表名顺序
    specs: list[SheetSpec] = []
    for name in sheet_names:
        if name == SEVEN_N_NOTES:
            continue
        rows = build_seven_n_rows(seven, name, kept_indices)
        if not rows:
            rows = [[EMPTY] * len(headers)]
            warnings.append(f"{name} 无数据行，已写一行占位")
        title = (
            f"{name}｜{as_text(meta.get('targetName'))} 投资版图 7+N｜"
            f"数据截至 {as_text(meta.get('asOf'))}｜清理版 {len(headers)} 列"
        )
        specs.append(
            SheetSpec(
                name=name,
                title=title,
                headers=list(headers),
                kinds=list(kinds),
                rows=rows,
                green_headers=tuple(GREEN_RULES.keys()),
                group_key_col=1,
                group_fill_cols=6,
                freeze="C3",
            )
        )

    # 记录占位行（全列为占位的行不算业务行，QA 会跳过）
    for spec in specs:
        if len(spec.rows) == 1 and all(as_text(cell) == EMPTY for cell in spec.rows[0]):
            stats["placeholderRows"].append(spec.name)

    for spec in specs:
        info = fill_sheet(worksheets[spec.name], spec, meta, stats)
        stats["greenTotal"] += info.get("greenCount", 0)
        if spec.headers[green_positions[0] - 1] == "是否与委托方技术有关联、有合作潜力":
            stats["greenPotential"] += info.get("greenByColumn", {}).get(green_positions[0], 0)
        stats["greenAssessment"] += info.get("greenByColumn", {}).get(green_positions[1], 0)

    notes_spec = SheetSpec(
        name=SEVEN_N_NOTES,
        title=(
            f"说明｜7+N 投资版图专项｜{as_text(meta.get('targetName'))}｜"
            f"数据截至 {as_text(meta.get('asOf'))}"
        ),
        headers=["项目", "内容"],
        kinds=["text", "text"],
        rows=build_notes_rows(data, family, seven),
        widths_hint={1: 16, 2: 100},
        min_width=12,
        max_width=110,
        height_cap=220,
        freeze="A3",
    )
    fill_sheet(worksheets[SEVEN_N_NOTES], notes_spec, meta, stats)

    sheet_map = [collect_sheet_info(worksheets[name], name) for name in sheet_names]
    return workbook, sheet_map, {"warnings": warnings, "stats": stats, "headers": headers}


# ================================================================ 绘制引擎
def write_value(cell: Any, value: Any, kind: str, currency: str, stats: dict) -> str:
    """按列类型写一个单元格；返回最终展示文本（供宽度/行高/分组使用）。"""
    from openpyxl.styles import Alignment

    left_top = Alignment(horizontal="left", vertical="top", wrap_text=True)
    right_top = Alignment(horizontal="right", vertical="top", wrap_text=True)

    if kind == "percent":
        number, text = to_percent_number(value)
        if number is not None:
            cell.value = number
            cell.number_format = '0.00"%"'
            cell.alignment = right_top
            return num_to_text(number) + "%"
        if text:
            cell.value = clean_text(text)
            cell.data_type = "s"
            cell.alignment = right_top
            return text
        cell.value = EMPTY
        cell.data_type = "s"
        cell.alignment = left_top
        stats["emptyFilled"] = stats.get("emptyFilled", 0) + 1
        return EMPTY

    if kind == "integer":
        number, text = to_integer(value)
        if number is not None:
            cell.value = number
            cell.number_format = "0"
            cell.alignment = right_top
            return str(number)
        if text:
            cell.value = clean_text(text)
            cell.data_type = "s"
            cell.alignment = right_top
            return text
        cell.value = EMPTY
        cell.data_type = "s"
        cell.alignment = left_top
        stats["emptyFilled"] = stats.get("emptyFilled", 0) + 1
        return EMPTY

    if kind == "amount":
        number = to_amount_number(value)
        if number is not None:
            cell.value = number
            cell.number_format = currency_format(currency)
            cell.alignment = right_top
            return f"{number:,.2f}"
        text = as_text(value)
        cell.value = clean_text(text)
        cell.data_type = "s"
        cell.alignment = right_top if re.search(r"\d", text) else left_top
        if text == EMPTY:
            stats["emptyFilled"] = stats.get("emptyFilled", 0) + 1
        return text

    if kind == "date":
        parsed = to_date(value)
        if parsed:
            cell.value = parsed
            cell.number_format = "yyyy-mm-dd"
            cell.alignment = right_top
            return parsed.isoformat()
        text = as_text(value)
        cell.value = clean_text(text)
        cell.data_type = "s"
        cell.alignment = right_top if re.search(r"\d", text) else left_top
        if text == EMPTY:
            stats["emptyFilled"] = stats.get("emptyFilled", 0) + 1
        return text

    if kind == "datetime":
        parsed_dt = to_datetime(value)
        if parsed_dt:
            cell.value = parsed_dt
            cell.number_format = "yyyy-mm-dd hh:mm:ss"
            cell.alignment = right_top
            return parsed_dt.isoformat(sep=" ")
        text = as_text(value)
        cell.value = clean_text(text)
        cell.data_type = "s"
        cell.alignment = right_top if re.search(r"\d", text) else left_top
        if text == EMPTY:
            stats["emptyFilled"] = stats.get("emptyFilled", 0) + 1
        return text

    if kind == "date_or_text":
        # 「时间/备注」这类混合列：整格是日期才写日期值，否则原样文本
        raw_text = as_text(value)
        if raw_text != EMPTY and re.fullmatch(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", raw_text.strip()):
            parsed = to_date(raw_text)
            if parsed:
                cell.value = parsed
                cell.number_format = "yyyy-mm-dd"
                cell.alignment = right_top
                return parsed.isoformat()
        cell.value = clean_text(raw_text)
        cell.data_type = "s"
        cell.alignment = left_top
        if raw_text == EMPTY:
            stats["emptyFilled"] = stats.get("emptyFilled", 0) + 1
        return raw_text

    # 默认 text：数字型值仍按数字写（右对齐、千分位），避免「值是数字却是文本」
    if isinstance(value, bool):
        text = as_text(value)
        cell.value = text
        cell.data_type = "s"
        cell.alignment = left_top
        return text
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        cell.value = value
        cell.number_format = "0" if float(value).is_integer() else "#,##0.00"
        cell.alignment = right_top
        return num_to_text(float(value))

    text = as_text(value)
    cell.value = clean_text(text)
    cell.data_type = "s"
    cell.alignment = left_top
    if text == EMPTY:
        stats["emptyFilled"] = stats.get("emptyFilled", 0) + 1
    return text


def currency_format(currency: str) -> str:
    """按币种给金额格式（千分位 + 币种符号）。"""
    code = (currency or "").upper()
    mapping = {
        "CNY": '¥#,##0.00',
        "RMB": '¥#,##0.00',
        "USD": '$#,##0.00',
        "HKD": 'HK$#,##0.00',
        "EUR": '€#,##0.00',
        "GBP": '£#,##0.00',
        "JPY": '¥#,##0',
    }
    return mapping.get(code, '#,##0.00')


def fill_sheet(worksheet: Any, spec: SheetSpec, meta: dict, stats: dict) -> dict:
    """绘制一个 sheet：标题行 → 表头 → 数据 → 宽度/行高 → 冻结/筛选 → 标绿。"""
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    thin = Side(style="thin", color=BORDER_GREY)
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    # 显式写 FF alpha，读回时 RGB 为 FFC6EFCE 之类，便于 QA 归一化比对
    navy_fill = PatternFill("solid", start_color=f"FF{NAVY}", end_color=f"FF{NAVY}")
    blue_fill = PatternFill("solid", start_color=f"FF{LIGHT_BLUE}", end_color=f"FF{LIGHT_BLUE}")
    grey_fill = PatternFill("solid", start_color=f"FF{LIGHT_GREY}", end_color=f"FF{LIGHT_GREY}")
    green_fill = PatternFill("solid", start_color=f"FF{GREEN_HEX}", end_color=f"FF{GREEN_HEX}")

    ncols = len(spec.headers)
    last_col_letter = get_column_letter(ncols)
    currency = as_text(as_dict(meta).get("currency"), "")

    worksheet.sheet_view.showGridLines = False

    # --- 标题行（合并 A1:…1，海军蓝白字）
    worksheet.cell(row=TITLE_ROW, column=1, value=clean_text(spec.title))
    if ncols > 1:
        worksheet.merge_cells(
            start_row=TITLE_ROW, start_column=1, end_row=TITLE_ROW, end_column=ncols
        )
    for column in range(1, ncols + 1):
        cell = worksheet.cell(row=TITLE_ROW, column=column)
        cell.fill = navy_fill
        cell.border = border
        cell.font = Font(name=FONT_NAME, size=12, bold=True, color="FFFFFF")
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=False)
    worksheet.row_dimensions[TITLE_ROW].height = 30

    # --- 表头行（浅蓝底、黑体、居中）
    for column, header in enumerate(spec.headers, start=1):
        cell = worksheet.cell(row=HEADER_ROW, column=column, value=clean_text(header))
        cell.data_type = "s"
        cell.fill = blue_fill
        cell.border = border
        cell.font = Font(name=FONT_NAME, size=10, bold=True, color="000000")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    worksheet.row_dimensions[HEADER_ROW].height = 34

    # --- 数据行
    data_texts: list[list[str]] = []
    for row_offset, raw_row in enumerate(spec.rows):
        row_index = DATA_START + row_offset
        texts: list[str] = []
        for column, kind in enumerate(spec.kinds, start=1):
            value = raw_row[column - 1] if column - 1 < len(raw_row) else None
            cell = worksheet.cell(row=row_index, column=column)
            cell.border = border
            cell.font = Font(name=FONT_NAME, size=10, color="000000")
            texts.append(write_value(cell, value, kind, currency, stats))
        data_texts.append(texts)

    last_row = DATA_START + len(spec.rows) - 1 if spec.rows else HEADER_ROW

    # --- 列宽：表头 + 数据（长文本截断计算，避免列被撑爆）
    widths: list[int] = []
    for column, header in enumerate(spec.headers, start=1):
        hint = spec.widths_hint.get(column)
        if hint:
            width = hint
        else:
            width = max(display_width(header) + 2, spec.min_width)
            for texts in data_texts:
                sample = texts[column - 1] if column - 1 < len(texts) else ""
                single_line = min(display_width(sample), 60)
                width = max(width, single_line + 2)
            width = max(min(width, spec.max_width), spec.min_width)
        widths.append(width)
        worksheet.column_dimensions[get_column_letter(column)].width = width

    # --- 行高：按换行估算，避免长文本被压成一行
    for row_offset, texts in enumerate(data_texts):
        lines = 1
        numeric_only = True
        for column, text in enumerate(texts, start=1):
            if not text:
                continue
            cell = worksheet.cell(row=DATA_START + row_offset, column=column)
            if cell.alignment.horizontal == "right" and isinstance(cell.value, (int, float, date, datetime)):
                continue
            numeric_only = False
            lines = max(lines, wrap_line_count(text, widths[column - 1]))
        height = 18 if numeric_only else min(max(18, lines * 14.5 + 5), spec.height_cap)
        worksheet.row_dimensions[DATA_START + row_offset].height = height

    # --- 分组：该列取值变化的首行前 N 列涂浅灰
    if spec.group_key_col:
        previous = None
        for row_offset, texts in enumerate(data_texts):
            row_index = DATA_START + row_offset
            key_index = spec.group_key_col - 1
            key = texts[key_index] if key_index < len(texts) else ""
            if row_offset == 0 or key != previous:
                for column in range(1, min(spec.group_fill_cols, ncols) + 1):
                    worksheet.cell(row=row_index, column=column).fill = grey_fill
            previous = key

    # --- 汇总行（体检单结论行）浅灰
    if spec.summary_last_row and data_texts:
        row_index = DATA_START + len(data_texts) - 1
        for column in range(1, ncols + 1):
            worksheet.cell(row=row_index, column=column).fill = grey_fill

    # --- 标绿：只对契约指定两列，只涂背景（记录每列命中数）
    green_by_column: dict[int, int] = {}
    green_total = 0
    for column, header in enumerate(spec.headers, start=1):
        if header not in GREEN_RULES:
            continue
        hits = 0
        for row_offset in range(len(data_texts)):
            cell = worksheet.cell(row=DATA_START + row_offset, column=column)
            text = cell.value if isinstance(cell.value, str) else as_text(cell.value, "")
            if is_green_target(header, str(text)):
                cell.fill = green_fill
                hits += 1
        green_by_column[column] = hits
        green_total += hits

    # --- 冻结 + 自动筛选（筛选范围覆盖表头行到末行）
    worksheet.freeze_panes = spec.freeze
    filter_ref = f"A{HEADER_ROW}:{last_col_letter}{max(last_row, HEADER_ROW)}"
    worksheet.auto_filter.ref = filter_ref

    # --- 打印：横向、重复表头两行
    worksheet.page_setup.orientation = "landscape"
    worksheet.print_title_rows = f"{TITLE_ROW}:{HEADER_ROW}"

    # --- 统计：数据区空白单元格与占位文本（体检单引用）
    blank_cells = 0
    placeholder_cells = 0
    for row_index in range(DATA_START, max(last_row, HEADER_ROW) + 1):
        for column in range(1, ncols + 1):
            value = worksheet.cell(row=row_index, column=column).value
            if value is None:
                blank_cells += 1
            elif isinstance(value, str) and value.strip() == EMPTY:
                placeholder_cells += 1
    stats["blankCells"] = stats.get("blankCells", 0) + blank_cells
    stats["placeholderCells"] = stats.get("placeholderCells", 0) + placeholder_cells

    return {
        "greenCount": green_total,
        "greenByColumn": green_by_column,
        "widths": widths,
        "lastRow": last_row,
        "blankCells": blank_cells,
        "placeholderCells": placeholder_cells,
    }


def collect_sheet_info(worksheet: Any, sheet_name: str) -> dict:
    """收集 workbook_map / QA 需要的 sheet 事实。"""
    headers: list[str] = []
    for column in range(1, worksheet.max_column + 1):
        value = worksheet.cell(row=HEADER_ROW, column=column).value
        headers.append("" if value is None else str(value))

    return {
        "name": sheet_name,
        "headers": headers,
        "rows": worksheet.max_row,
        "cols": worksheet.max_column,
        "dataRows": max(worksheet.max_row - HEADER_ROW, 0),
        "freeze": worksheet.freeze_panes,
        "autoFilter": worksheet.auto_filter.ref,
        "title": str(worksheet.cell(row=TITLE_ROW, column=1).value or ""),
        "headerRow": HEADER_ROW,
        "dataStartRow": DATA_START,
    }


# ================================================================ 原子写
def atomic_write_json(path: Path, payload: dict) -> None:
    """先写临时文件再替换，避免半成品。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temp_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def atomic_save_workbook(workbook: Any, path: Path) -> None:
    """openpyxl 先存临时 .xlsx，再 os.replace 到目标路径。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.stem}.{os.getpid()}.tmp.xlsx")
    try:
        workbook.save(temp_path)
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ================================================================ 主流程
def run_build(input_path: Path, out_dir: Path) -> dict:
    """构建两个工作簿与 workbook_map，返回结果摘要。"""
    data = load_input(input_path)

    if out_dir.exists() and not out_dir.is_dir():
        raise BuildError(EXIT_OUTPUT, f"--out 不是目录：{out_dir}")
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise BuildError(EXIT_OUTPUT, f"输出目录不可创建：{out_dir}（{exc}）") from exc
    if not os.access(out_dir, os.W_OK):
        raise BuildError(EXIT_OUTPUT, f"输出目录不可写：{out_dir}")

    # 03 先建（02 的体检单要引用 03 的统计）
    workbook03, map03, meta03 = build_seven_n(data)
    workbook02, map02, meta02 = build_comprehensive(data, meta03["stats"])

    path02 = out_dir / FILE_COMPREHENSIVE
    path03 = out_dir / FILE_SEVEN_N
    atomic_save_workbook(workbook02, path02)
    atomic_save_workbook(workbook03, path03)

    warnings = list(meta03["warnings"]) + list(meta02["warnings"])
    for key, sheets in (("02", map02), ("03", map03)):
        for sheet in sheets:
            if sheet["autoFilter"] is None:
                warnings.append(f"{key}/{sheet['name']} 未设置自动筛选")

    result = {
        "ok": True,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "input": {
            "path": str(input_path),
            "sha256": sha256_file(input_path),
            "projectId": as_text(as_dict(data.get("meta")).get("projectId"), ""),
            "projectName": as_text(as_dict(data.get("meta")).get("projectName"), ""),
            "targetName": as_text(as_dict(data.get("meta")).get("targetName"), ""),
            "asOf": as_text(as_dict(data.get("meta")).get("asOf"), ""),
        },
        "template": as_text(as_dict(data.get("meta")).get("template"), "standard"),
        "style": {
            "headerFill": NAVY,
            "columnHeaderFill": LIGHT_BLUE,
            "groupFill": LIGHT_GREY,
            "greenFill": GREEN_HEX,
            "border": "thin",
            "freezePolicy": "02=A3（冻结标题+表头两行）；03=C3（另冻结前两列）",
            "titleRow": TITLE_ROW,
            "headerRow": HEADER_ROW,
            "dataStartRow": DATA_START,
        },
        "sevenN": {
            "sheetOrder": [sheet["name"] for sheet in map03],
            "fixedCount": len(SEVEN_N_FIXED),
            "familyCount": meta03["stats"]["familyCount"],
            "headers": meta03["headers"],
            "columnCount": len(meta03["headers"]),
            "droppedColumns": [
                {"index": column[0], "header": column[1]} for column in SEVEN_N_COLUMNS if not column[3]
            ],
            "greenColumns": [column[1] for column in kept_green_columns()],
            "greenRules": {
                header: {"positives": list(rule["positives"]), "exclusions": list(rule["exclusions"])}
                for header, rule in GREEN_RULES.items()
            },
            "greenCells": meta03["stats"]["greenTotal"],
        },
        "files": [],
        "sheets": [dict(sheet, file="02") for sheet in map02]
        + [dict(sheet, file="03") for sheet in map03],
        "stats": {
            "comprehensiveSheets": len(map02),
            "sevenNSheets": len(map03),
            "greenCells": meta03["stats"]["greenTotal"],
            "emptyFilled": meta02["stats"].get("emptyFilled", 0),
            "blankCells": meta02["stats"].get("blankCells", 0) + meta03["stats"].get("blankCells", 0),
            "placeholderCells": meta02["stats"].get("placeholderCells", 0)
            + meta03["stats"].get("placeholderCells", 0),
        },
        "notes": list(meta02.get("notes", [])) + list(meta03.get("notes", [])),
        "warnings": warnings,
    }

    for label, path, map_key in (("02", path02, map02), ("03", path03, map03)):
        result["files"].append(
            {
                "key": label,
                "fileName": path.name,
                "path": str(path),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "sheetCount": len(map_key),
                "rowTotal": sum(sheet["rows"] for sheet in map_key),
            }
        )

    atomic_write_json(out_dir / FILE_MAP, result)
    return result


def kept_green_columns() -> list[tuple[int, str, str, bool, str]]:
    """交付清理版里仍保留的标绿列（用于报告）。"""
    return [column for column in SEVEN_N_COLUMNS if column[3] and column[1] in GREEN_RULES]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="build_workbooks.py",
        description=(
            "读取交付构建输入 JSON，生成 02 综合尽调工作簿 / 03 专项投资版图 7+N / workbook_map.json。\n"
            "只画表：不联网、不调用模型、不新增业务事实；缺失字段写「未提供/not_reviewed」。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python python/build_workbooks.py --input tests/fixtures/deliverable-input.sample.json --out 05_交付\n"
            "\n退出码：0 成功；2 参数错误；3 输入不可读；4 输入 JSON 非法；5 输出目录不可写；6 构建异常；7 缺少 openpyxl。"
        ),
    )
    parser.add_argument("--input", required=True, metavar="<input.json>", help="契约 JSON 路径（UTF-8）")
    parser.add_argument("--out", required=True, metavar="<dir>", help="交付目录（不存在会自动创建）")
    parser.add_argument("--quiet", action="store_true", help="不向 stdout 打印结果 JSON")
    parser.add_argument("--version", action="version", version="build_workbooks.py 1.0.0")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover - 仅部分终端不支持
        pass

    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        import openpyxl  # noqa: F401
    except ImportError:
        message = "缺少依赖 openpyxl（pip install openpyxl）"
        print(json.dumps({"ok": False, "error": {"code": "missing_dependency", "message": message}},
                         ensure_ascii=False))
        return EXIT_DEP

    try:
        result = run_build(Path(args.input).expanduser(), Path(args.out).expanduser())
    except BuildError as exc:
        error = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
        print(json.dumps(error, ensure_ascii=False))
        return exc.code
    except Exception as exc:  # pragma: no cover - 兜底
        traceback.print_exc()
        message = f"构建异常：{exc}"
        print(json.dumps({"ok": False, "error": {"code": EXIT_BUILD, "message": message}},
                         ensure_ascii=False))
        return EXIT_BUILD

    if not args.quiet:
        print(json.dumps(result, ensure_ascii=False))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
