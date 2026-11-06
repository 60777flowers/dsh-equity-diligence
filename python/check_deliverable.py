#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""交付包一致性体检：结构 / 列语义 / 状态字段（8 个取值） / 空值 / 公式 / 多路径 / 标绿。

读取：
    <dir>/02_综合尽调工作簿.xlsx
    <dir>/03_专项_投资版图_7+N.xlsx
    <dir>/workbook_map.json
    <input.json>                       # 可选；给了才做血缘与多路径核对

输出 JSON：
    { "ok": bool, "passed": bool, "blocking": [...], "warnings": [...], "stats": {...} }

每条检查项形如：
    { "code": "...", "message": "...", "where": "sheet!cell 或文件", "count": N, "samples": [...] }

只读：不修改任何交付文件。契约依据：docs/交付构建输入.md §2/§3/§4、docs/实现契约.md §3.4/§11/§13。

用法：
    python python/check_deliverable.py --dir <交付目录> [--input <input.json>] [--json <out.json>]

退出码：
    0 无阻断项（passed=true）
    1 存在阻断项（passed=false，JSON 仍会写出）
    2 参数错误 / 无法写出 JSON
    3 交付文件缺失或无法读取
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
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

EXIT_OK = 0
EXIT_BLOCKING = 1
EXIT_USAGE = 2
EXIT_INPUT = 3
EXIT_DEP = 7

EMPTY = "未提供/not_reviewed"

FILE_COMPREHENSIVE = "02_综合尽调工作簿.xlsx"
FILE_SEVEN_N = "03_专项_投资版图_7+N.xlsx"
FILE_MAP = "workbook_map.json"

# ---------------- 契约常量（独立复制，作为对照「预言机」，不 import 构建器）
SIX_STATES = {
    "found",
    "not_disclosed_after_search",
    "lower_bound",
    "pending_dd",
    "conflict",
    "not_applicable",
    "not_reviewed",
    "estimated",
}

SEVEN_N_FIXED = [
    "1-直接投资",
    "2-合作基金-GP",
    "3-合作基金-主导LP",
    "4-合作基金-财务LP",
    "5-海外平台",
    "6-合资公司",
    "7-国内基地",
]
NOTES_SHEET = "说明"

SEVEN_N_HEADERS = [
    "平台/主体",
    "类型/角色",
    "股权结构/出资",
    "战投定位/协同方向",
    "时间/备注",
    "公司名称",
    "最新融资轮次和情况",
    "第一大股东持股比例(%)",
    "前5大股东合计持股比例(%)",
    "股东数目",
    "创始团队是否实控",
    "创始团队背景",
    "产业链环节",
    "扩产周期",
    "产业景气度",
    "产品毛利率",
    "该公司行业排名(国际/国内)",
    "是否与委托方技术有关联、有合作潜力",
    "历史融资总额",
    "投资合作评估（重点字段）",
]

COMPREHENSIVE_HEADERS: dict[str, list[str]] = {
    "00_目录": ["章节", "Sheet", "说明", "数据截至日"],
    "01_执行摘要": ["序号", "事实", "影响", "证据强度", "materiality", "下一步", "claimId", "artifactId"],
    "02_主体与股权": ["字段", "值", "状态", "证据"],
    "03_业务与技术": ["字段", "值", "状态", "证据"],
    "04_财务": ["字段", "值", "状态", "证据"],
    "05_风险": ["字段", "值", "状态", "证据"],
    "06_待核清单": ["主题", "问题", "为什么重要", "优先级", "来源"],
    "07_资料请求": ["编号", "主题", "问题", "为什么", "优先级", "负责人", "状态"],
    "08_来源索引": [
        "evidenceId", "标题", "URL", "来源类型", "权威度", "核验状态", "截至日", "抓取时间", "rawHash",
    ],
    "09_模块底稿索引": [
        "artifactId", "类型", "主体", "分区", "状态", "revision", "contentHash", "asOf", "证据数", "claim 数",
    ],
    "10_体检单": ["检查项", "结果", "说明"],
}
COMPREHENSIVE_NAMES = list(COMPREHENSIVE_HEADERS.keys())

# 标绿规则（契约 §3），与构建器保持一致但独立书写
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
        "exclusions": ("不适合投资合作",),
    },
}
GREEN_HEX = "C6EFCE"

# 投资合作评估三选一词汇表
ASSESSMENT_NEGATIVE = ("不适合投资合作", "不适合", "不建议")
ASSESSMENT_POSITIVE = GREEN_RULES["投资合作评估（重点字段）"]["positives"]
ASSESSMENT_PENDING = ("待定", "待核", "待进一步", "待确认", "信息不足", "需现场", "需尽调", "观察", "暂缓", "不适用")

FORMULA_ERRORS = ("#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NAME?", "#NULL!", "#NUM!")

# 03 列语义（1-based）
COL_PLATFORM = 1
COL_PLATFORM_ROLE = 2
COL_TIME_NOTE = 5
COL_ENTITY = 6
COL_PCT_LARGEST = 8
COL_PCT_TOP5 = 9
COL_SHAREHOLDER_COUNT = 10
COL_GROSS_MARGIN = 16
COL_RANKING = 17
COL_POTENTIAL = 18
COL_TOTAL_FUNDING = 19
COL_ASSESSMENT = 20

RATIO_COLUMNS = {
    COL_PCT_LARGEST: "第一大股东持股比例(%)",
    COL_PCT_TOP5: "前5大股东合计持股比例(%)",
    COL_GROSS_MARGIN: "产品毛利率",
}

CURRENCY_MARKERS = (
    "元", "CNY", "RMB", "¥", "￥", "$", "USD", "HKD", "港元", "港币",
    "EUR", "€", "GBP", "£", "JPY", "日元", "万美元", "亿元", "万元",
)

RATIO_TOKEN = re.compile(
    r"^[≥≤><约~]?\s*\d+(?:\.\d+)?\s*%?(?:\s*(?:[-~–—]|至)\s*\d+(?:\.\d+)?\s*%?)?$"
)


# ================================================================ 报告
class Report:
    """收集阻断项与提示项。"""

    def __init__(self) -> None:
        self.blocking: list[dict] = []
        self.warnings: list[dict] = []
        self.notes: list[str] = []
        self.stats: dict[str, Any] = {}

    def block(self, code: str, message: str, where: str = "", count: int | None = None,
              samples: Sequence[Any] | None = None) -> None:
        self.blocking.append(self._item(code, message, where, count, samples))

    def warn(self, code: str, message: str, where: str = "", count: int | None = None,
             samples: Sequence[Any] | None = None) -> None:
        self.warnings.append(self._item(code, message, where, count, samples))

    @staticmethod
    def _item(code: str, message: str, where: str, count: int | None,
              samples: Sequence[Any] | None) -> dict:
        item: dict[str, Any] = {"code": code, "message": message, "where": where}
        if count is not None:
            item["count"] = count
        if samples:
            item["samples"] = [str(sample) for sample in list(samples)[:8]]
        return item


# ================================================================ 读取与工具
def cell_text(cell: Any) -> str:
    value = cell.value
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float):
        if not math.isfinite(value):
            return ""
        return str(int(value)) if value.is_integer() else f"{value:.10f}".rstrip("0").rstrip(".")
    return str(value).strip()


def fill_rgb(cell: Any) -> str | None:
    """返回填充色 6 位 HEX（大写）；非实心底或取不到 RGB 时返回 None。"""
    fill = cell.fill
    if fill is None or fill.fill_type != "solid":
        return None
    for color in (fill.fgColor, fill.start_color):
        rgb = getattr(color, "rgb", None)
        if isinstance(rgb, str) and len(rgb) >= 6:
            return rgb[-6:].upper()
    return None


def normalize_rule_text(text: str) -> str:
    normalized = str(text).replace("／", "/").replace("：", ":")
    return re.sub(r"\s+", "", normalized)


def is_green_expected(header: str, text: str) -> bool:
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


def classify_assessment(text: str) -> str:
    """把「投资合作评估」归类为 suitable / not_suitable / pending / missing / unknown。"""
    normalized = normalize_rule_text(text)
    if not normalized or normalized == EMPTY:
        return "missing"
    for word in ASSESSMENT_NEGATIVE:
        if normalize_rule_text(word) in normalized:
            return "not_suitable"
    for word in ASSESSMENT_POSITIVE:
        if normalize_rule_text(word) in normalized:
            return "suitable"
    for word in ASSESSMENT_PENDING:
        if normalize_rule_text(word) in normalized:
            return "pending"
    return "unknown"


def parse_ratio(value: Any) -> tuple[bool, list[float]]:
    """判断比例列取值是否合法（百分比 / 区间 / 下限；允许多口径并列）。

    括号里的口径注释（如「（口径冲突）」「（2025A）」）不参与校验，只校验数值部分。
    """
    if isinstance(value, bool):
        return False, []
    if isinstance(value, (int, float)):
        return True, [float(value)]
    text = cell_text_from_value(value)
    if not text:
        return True, []  # 空值由空值检查负责
    # 去掉括号注释后再判断
    cleaned = re.sub(r"（[^（）]*）|\([^()]*\)|【[^【】]*】|\[[^\[\]]*\]", "", text).strip()
    if not cleaned:
        return False, []
    tokens = [token.strip() for token in re.split(r"[/、;；\n]", cleaned) if token.strip()]
    if not tokens:
        return False, []
    numbers: list[float] = []
    for token in tokens:
        if not RATIO_TOKEN.match(token):
            return False, []
        found = re.findall(r"\d+(?:\.\d+)?", token)
        numbers.extend(float(item) for item in found)
    return True, numbers


def cell_text_from_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else str(value)
    return str(value).strip()


def parse_date_text(text: str) -> date | None:
    match = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text.strip())
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def header_cells(worksheet: Any, header_row: int = 2) -> list[str]:
    return [cell_text(worksheet.cell(row=header_row, column=column)) for column in range(1, (worksheet.max_column or 0) + 1)]


def data_rows(worksheet: Any, header_row: int = 2) -> Iterable[int]:
    for row_index in range(header_row + 1, (worksheet.max_row or 0) + 1):
        yield row_index


def is_placeholder_row(worksheet: Any, row_index: int, ncols: int) -> bool:
    """整行都是「未提供/not_reviewed」→ 占位行（空表）。"""
    for column in range(1, ncols + 1):
        if cell_text(worksheet.cell(row=row_index, column=column)) != EMPTY:
            return False
    return True


# ================================================================ 各项检查
def check_comprehensive(report: Report, workbook: Any) -> None:
    names = list(workbook.sheetnames)
    if names != COMPREHENSIVE_NAMES:
        missing = [name for name in COMPREHENSIVE_NAMES if name not in names]
        extra = [name for name in names if name not in COMPREHENSIVE_NAMES]
        report.block(
            "sheet_02_order",
            f"02 的 sheet 数量/顺序不符合契约：期望 {len(COMPREHENSIVE_NAMES)} 个，实际 {len(names)} 个",
            FILE_COMPREHENSIVE,
            samples=[f"缺失={missing}", f"多余={extra}", f"实际顺序={names}"],
        )
    else:
        report.stats["sheets02"] = len(names)

    for name in COMPREHENSIVE_NAMES:
        if name not in workbook.sheetnames:
            continue
        worksheet = workbook[name]
        expected = COMPREHENSIVE_HEADERS[name]
        actual = header_cells(worksheet, 2)
        if actual != expected:
            report.block(
                "header_02",
                f"{name} 表头与契约 §2 不一致",
                f"{FILE_COMPREHENSIVE}!{name}!A2",
                samples=[f"期望={expected}", f"实际={actual}"],
            )
        title = cell_text(worksheet.cell(row=1, column=1))
        if not title:
            report.block("title_02", f"{name} 缺少第 1 行标题", f"{FILE_COMPREHENSIVE}!{name}!A1")
        freeze = worksheet.freeze_panes
        if not freeze:
            report.block("freeze_02", f"{name} 未冻结首行", f"{FILE_COMPREHENSIVE}!{name}")
        else:
            match = re.match(r"^[A-Z]+(\d+)$", str(freeze))
            if not match or int(match.group(1)) < 3:
                report.block(
                    "freeze_02",
                    f"{name} 冻结位置 {freeze} 未同时冻结标题行与表头行（期望 ≥ A3）",
                    f"{FILE_COMPREHENSIVE}!{name}",
                )
        filter_ref = worksheet.auto_filter.ref
        if not filter_ref:
            report.block("filter_02", f"{name} 未设置自动筛选", f"{FILE_COMPREHENSIVE}!{name}")
        elif not re.match(r"^A2:", filter_ref):
            report.block(
                "filter_02",
                f"{name} 自动筛选范围 {filter_ref} 未从表头行（第 2 行）开始",
                f"{FILE_COMPREHENSIVE}!{name}",
            )

    # 00_目录 应列出全部 11 个 sheet
    if "00_目录" in workbook.sheetnames:
        worksheet = workbook["00_目录"]
        listed = {
            cell_text(worksheet.cell(row=row, column=2)) for row in data_rows(worksheet)
        }
        missing = [name for name in COMPREHENSIVE_NAMES if name not in listed]
        if missing:
            report.warn("catalog_incomplete", f"00_目录 未列全 sheet：{missing}", FILE_COMPREHENSIVE)


def check_seven_n(report: Report, workbook: Any) -> tuple[list[str], dict[str, Any]]:
    names = list(workbook.sheetnames)
    missing_fixed = [name for name in SEVEN_N_FIXED if name not in names]
    if missing_fixed:
        report.block(
            "sheet_03_fixed",
            f"03 缺少固定表：{missing_fixed}",
            FILE_SEVEN_N,
        )
    fixed_present = [name for name in names if name in SEVEN_N_FIXED]
    if fixed_present and fixed_present != [name for name in SEVEN_N_FIXED if name in fixed_present]:
        report.warn("sheet_03_order", "03 固定表顺序与契约不一致", FILE_SEVEN_N, samples=[names])

    family = [name for name in names if name not in SEVEN_N_FIXED and name != NOTES_SHEET]
    if len(family) > 3:
        report.block("family_count", f"03 家族表超过 3 张：{len(family)}", FILE_SEVEN_N, samples=family)
    for name in family:
        if not re.match(r"^(8|9|10)-.+家族$", name):
            report.warn("family_name", f"家族表命名不符合契约「8/9/10-<姓名>家族」：{name}", FILE_SEVEN_N)
    expected_count = len(SEVEN_N_FIXED) + len(family) + 1
    if len(names) != expected_count:
        report.warn(
            "sheet_03_count",
            f"03 sheet 数为 {len(names)}，按 7+{len(family)}+说明 应为 {expected_count}",
            FILE_SEVEN_N,
        )
    if NOTES_SHEET not in names:
        report.block("notes_missing", "03 缺少「说明」sheet", FILE_SEVEN_N)
    elif names[-1] != NOTES_SHEET:
        report.block("notes_position", "「说明」sheet 不在最后", FILE_SEVEN_N)
    else:
        report.stats["sheets03"] = len(names)

    green_total = 0
    green_by_col: Counter = Counter()
    for name in names:
        if name == NOTES_SHEET:
            continue
        worksheet = workbook[name]
        actual = header_cells(worksheet, 2)
        if actual != SEVEN_N_HEADERS:
            diff = [
                f"第{i + 1}列 期望「{expected}」实际「{got}」"
                for i, (expected, got) in enumerate(zip(SEVEN_N_HEADERS, actual))
                if expected != got
            ]
            if len(actual) != len(SEVEN_N_HEADERS):
                diff.append(f"列数 期望 {len(SEVEN_N_HEADERS)} 实际 {len(actual)}")
            report.block(
                "header_03",
                f"{name} 表头不是契约 §3 的 20 列清理版（逐字比对失败）",
                f"{FILE_SEVEN_N}!{name}!A2",
                samples=diff or [f"实际={actual}"],
            )
        if (worksheet.max_column or 0) != len(SEVEN_N_HEADERS):
            report.block(
                "cols_03",
                f"{name} 列数为 {worksheet.max_column}，期望 {len(SEVEN_N_HEADERS)}",
                FILE_SEVEN_N,
            )
        if not worksheet.freeze_panes:
            report.block("freeze_03", f"{name} 未冻结首行", f"{FILE_SEVEN_N}!{name}")
        if not worksheet.auto_filter.ref:
            report.block("filter_03", f"{name} 未设置自动筛选", f"{FILE_SEVEN_N}!{name}")

        # 标绿一致性
        for row in data_rows(worksheet):
            for column in range(1, len(SEVEN_N_HEADERS) + 1):
                header = SEVEN_N_HEADERS[column - 1]
                cell = worksheet.cell(row=row, column=column)
                actual_green = fill_rgb(cell) == GREEN_HEX
                expected_green = is_green_expected(header, cell_text(cell))
                if expected_green:
                    green_by_col[header] += 1
                    green_total += 1
                if actual_green != expected_green:
                    report.block(
                        "green_mismatch",
                        f"{name} 标绿与契约规则不一致（{'多涂' if actual_green else '漏涂'}）",
                        f"{FILE_SEVEN_N}!{name}!{cell.coordinate}",
                        samples=[f"列={header}", f"值={cell_text(cell)}"],
                    )
    report.stats["greenCells"] = green_total
    report.stats["greenByColumn"] = dict(green_by_col)
    return names


def check_map(report: Report, map_data: dict | None, workbook02: Any, workbook03: Any,
              path02: Path, path03: Path) -> None:
    if map_data is None:
        report.warn("map_missing", f"未找到或不解析 {FILE_MAP}", FILE_MAP)
        return
    files = map_data.get("files")
    if not isinstance(files, list) or len(files) != 2:
        report.block("map_files", "workbook_map.json 的 files 应为 02/03 两项", FILE_MAP)
        return
    by_name = {item.get("fileName"): item for item in files if isinstance(item, dict)}
    for expected_name, path, workbook in (
        (FILE_COMPREHENSIVE, path02, workbook02),
        (FILE_SEVEN_N, path03, workbook03),
    ):
        entry = by_name.get(expected_name)
        if entry is None:
            report.block("map_files", f"workbook_map.json 缺少 {expected_name} 条目", FILE_MAP)
            continue
        if entry.get("bytes") != path.stat().st_size:
            report.warn(
                "map_stale",
                f"{expected_name} 文件大小与 workbook_map 记录不一致（可能被重新保存）",
                FILE_MAP,
                samples=[f"map={entry.get('bytes')}", f"actual={path.stat().st_size}"],
            )
        if entry.get("sha256") and entry.get("sha256") != sha256_file(path):
            report.warn(
                "map_stale_hash",
                f"{expected_name} 的 sha256 与 workbook_map 记录不一致",
                FILE_MAP,
            )

    map_sheets = map_data.get("sheets")
    if not isinstance(map_sheets, list):
        report.block("map_sheets", "workbook_map.json 缺少 sheets 数组", FILE_MAP)
        return

    for file_key, workbook in (("02", workbook02), ("03", workbook03)):
        recorded = {
            item.get("name"): item for item in map_sheets
            if isinstance(item, dict) and item.get("file") == file_key
        }
        actual_names = list(workbook.sheetnames)
        if set(recorded) != set(actual_names):
            report.block(
                "map_sheets",
                f"{file_key} 的 workbook_map sheet 名与实际文件不一致",
                FILE_MAP,
                samples=[f"map={sorted(recorded)}", f"xlsx={actual_names}"],
            )
            continue
        for name in actual_names:
            worksheet = workbook[name]
            item = recorded[name]
            actual_headers = header_cells(worksheet, 2)
            if item.get("headers") != actual_headers:
                report.block("map_headers", f"{name} 的 workbook_map 表头与实际不一致", FILE_MAP,
                             samples=[f"map={item.get('headers')}", f"xlsx={actual_headers}"])
            if item.get("rows") != worksheet.max_row:
                report.block("map_rows", f"{name} 的 workbook_map 行数 {item.get('rows')} ≠ 实际 {worksheet.max_row}", FILE_MAP)
            if item.get("cols") != worksheet.max_column:
                report.block("map_cols", f"{name} 的 workbook_map 列数 {item.get('cols')} ≠ 实际 {worksheet.max_column}", FILE_MAP)
            if item.get("freeze") != worksheet.freeze_panes:
                report.block("map_freeze", f"{name} 的 workbook_map 冻结 {item.get('freeze')} ≠ 实际 {worksheet.freeze_panes}", FILE_MAP)
            if item.get("autoFilter") != worksheet.auto_filter.ref:
                report.block("map_filter", f"{name} 的 workbook_map 筛选 {item.get('autoFilter')} ≠ 实际 {worksheet.auto_filter.ref}", FILE_MAP)


def check_blanks_and_formulas(report: Report, workbook: Any, label: str) -> None:
    blanks: list[str] = []
    formulas: list[str] = []
    errors: list[str] = []
    placeholder_total = 0
    data_cells = 0
    for worksheet in workbook.worksheets:
        header_row = 2
        ncols = worksheet.max_column or 0
        for row in data_rows(worksheet, header_row):
            for column in range(1, ncols + 1):
                cell = worksheet.cell(row=row, column=column)
                data_cells += 1
                value = cell.value
                if value is None:
                    blanks.append(f"{worksheet.title}!{cell.coordinate}")
                elif isinstance(value, str):
                    text = value.strip()
                    if text == EMPTY:
                        placeholder_total += 1
                    if text.startswith("=") or cell.data_type == "f":
                        formulas.append(f"{worksheet.title}!{cell.coordinate}")
                    if any(code in text for code in FORMULA_ERRORS):
                        errors.append(f"{worksheet.title}!{cell.coordinate}")
    if blanks:
        report.block("blank_cells", f"{label} 数据区存在 {len(blanks)} 个空白单元格", label, len(blanks), blanks)
    if errors:
        report.block("formula_errors", f"{label} 存在 {len(errors)} 处公式错误串", label, len(errors), errors)
    if formulas:
        report.warn("formula_cells", f"{label} 含 {len(formulas)} 个公式单元格（交付版应为纯值）", label,
                    len(formulas), formulas)
    report.stats[f"blank_{label}"] = len(blanks)
    report.stats[f"placeholder_{label}"] = placeholder_total
    report.stats[f"dataCells_{label}"] = data_cells
    if data_cells and placeholder_total / data_cells > 0.5:
        report.warn(
            "placeholder_ratio",
            f"{label} 占位文本占比 {placeholder_total / data_cells:.1%}，超过一半，数据完整度偏低",
            label,
        )


def check_six_states(report: Report, workbook02: Any) -> None:
    invalid: list[str] = []
    total = 0
    for name in ("02_主体与股权", "03_业务与技术", "04_财务", "05_风险"):
        if name not in workbook02.sheetnames:
            continue
        worksheet = workbook02[name]
        for row in data_rows(worksheet):
            state = cell_text(worksheet.cell(row=row, column=3))
            total += 1
            if state == EMPTY:
                continue
            if state not in SIX_STATES:
                invalid.append(f"{name}!C{row}={state}")
    if invalid:
        report.block(
            "six_states",
            f"02 状态列有 {len(invalid)} 个取值不在状态字段口径内（应为 8 个取值之一）",
            FILE_COMPREHENSIVE,
            len(invalid),
            invalid,
        )
    report.stats["sixStateRows"] = total


def check_three_sheet_semantics(report: Report, workbook03: Any) -> None:
    ratio_bad: list[str] = []
    ratio_range: list[str] = []
    count_bad: list[str] = []
    count_float: list[str] = []
    money_bad: list[str] = []
    date_text: list[str] = []
    assessment_unknown: list[str] = []
    assessment_missing: list[str] = []
    assessment_counts: Counter = Counter()

    for name in workbook03.sheetnames:
        if name == NOTES_SHEET:
            continue
        worksheet = workbook03[name]
        for row in data_rows(worksheet):
            if is_placeholder_row(worksheet, row, len(SEVEN_N_HEADERS)):
                continue
            for column, header in RATIO_COLUMNS.items():
                cell = worksheet.cell(row=row, column=column)
                value = cell.value
                if value is None or (isinstance(value, str) and value.strip() == EMPTY):
                    continue
                ok, numbers = parse_ratio(value)
                if not ok:
                    ratio_bad.append(f"{name}!{cell.coordinate}「{cell_text(cell)}」")
                elif any(number < 0 or number > 100 for number in numbers):
                    ratio_range.append(f"{name}!{cell.coordinate}「{cell_text(cell)}」")

            cell = worksheet.cell(row=row, column=COL_SHAREHOLDER_COUNT)
            value = cell.value
            if value is not None and not (isinstance(value, str) and value.strip() == EMPTY):
                if isinstance(value, bool):
                    count_bad.append(f"{name}!{cell.coordinate}")
                elif isinstance(value, int):
                    pass
                elif isinstance(value, float):
                    count_float.append(f"{name}!{cell.coordinate}「{cell_text(cell)}」")
                else:
                    count_bad.append(f"{name}!{cell.coordinate}「{cell_text(cell)}」")

            cell = worksheet.cell(row=row, column=COL_TOTAL_FUNDING)
            value = cell.value
            if value is not None and not (isinstance(value, str) and value.strip() == EMPTY):
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    number_format = str(cell.number_format or "")
                    if not any(marker in number_format for marker in ("¥", "$", "€", "£", "元")):
                        money_bad.append(f"{name}!{cell.coordinate}（数值无币种格式）")
                else:
                    text = cell_text(cell)
                    if re.search(r"\d", text) and not any(marker in text for marker in CURRENCY_MARKERS):
                        money_bad.append(f"{name}!{cell.coordinate}「{text}」")

            cell = worksheet.cell(row=row, column=COL_TIME_NOTE)
            value = cell.value
            text = cell_text(cell)
            if text and text != EMPTY and not isinstance(value, (date, datetime)):
                if re.fullmatch(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", text):
                    date_text.append(f"{name}!{cell.coordinate}「{text}」")

            cell = worksheet.cell(row=row, column=COL_ASSESSMENT)
            text = cell_text(cell)
            category = classify_assessment(text)
            assessment_counts[category] += 1
            if category == "unknown":
                assessment_unknown.append(f"{name}!{cell.coordinate}「{text}」")
            elif category == "missing":
                assessment_missing.append(f"{name}!{cell.coordinate}")

    if ratio_bad:
        report.block("ratio_semantics", f"比例列有 {len(ratio_bad)} 个取值不是百分比/区间",
                     FILE_SEVEN_N, len(ratio_bad), ratio_bad)
    if ratio_range:
        report.warn("ratio_range", f"比例列有 {len(ratio_range)} 个取值超出 0–100",
                    FILE_SEVEN_N, len(ratio_range), ratio_range)
    if count_bad:
        report.block("count_semantics", f"股东数目列有 {len(count_bad)} 个取值不是整数",
                     FILE_SEVEN_N, len(count_bad), count_bad)
    if count_float:
        report.warn("count_float", f"股东数目列有 {len(count_float)} 个取值是小数",
                    FILE_SEVEN_N, len(count_float), count_float)
    if money_bad:
        report.warn("money_currency", f"历史融资总额列有 {len(money_bad)} 个取值未带币种",
                    FILE_SEVEN_N, len(money_bad), money_bad)
    if date_text:
        report.warn("date_text", f"时间列有 {len(date_text)} 个纯日期存为文本（应为日期值）",
                    FILE_SEVEN_N, len(date_text), date_text)
    if assessment_unknown:
        report.block(
            "assessment_tristate",
            f"投资合作评估有 {len(assessment_unknown)} 个取值不是三选一结论"
            "（适合投资合作 / 不适合投资合作 / 待定待核）",
            FILE_SEVEN_N,
            len(assessment_unknown),
            assessment_unknown,
        )
    if assessment_missing:
        report.warn(
            "assessment_missing",
            f"投资合作评估有 {len(assessment_missing)} 行为占位（未取得结论）",
            FILE_SEVEN_N,
            len(assessment_missing),
            assessment_missing,
        )
    report.stats["assessment"] = dict(assessment_counts)


def check_caliber_dates(report: Report, workbook02: Any) -> None:
    """08_来源索引 的日期列必须是日期值。"""
    if "08_来源索引" not in workbook02.sheetnames:
        return
    worksheet = workbook02["08_来源索引"]
    text_dates: list[str] = []
    bad_dates: list[str] = []
    for row in data_rows(worksheet):
        for column, label in ((7, "截至日"), (8, "抓取时间")):
            cell = worksheet.cell(row=row, column=column)
            value = cell.value
            text = cell_text(cell)
            if not text or text == EMPTY:
                continue
            if isinstance(value, (date, datetime)):
                continue
            if parse_date_text(text):
                text_dates.append(f"08_来源索引!{cell.coordinate}（{label}）")
            else:
                bad_dates.append(f"08_来源索引!{cell.coordinate}（{label}）「{text}」")
    if bad_dates:
        report.block("date_invalid", f"08_来源索引 有 {len(bad_dates)} 个日期无法解析",
                     FILE_COMPREHENSIVE, len(bad_dates), bad_dates)
    if text_dates:
        report.warn("date_text_02", f"08_来源索引 有 {len(text_dates)} 个日期存为文本",
                    FILE_COMPREHENSIVE, len(text_dates), text_dates)


def check_notes_sheet(report: Report, workbook03: Any) -> None:
    if NOTES_SHEET not in workbook03.sheetnames:
        return
    worksheet = workbook03[NOTES_SHEET]
    labels: list[str] = []
    texts: list[str] = []
    for row in range(1, (worksheet.max_row or 0) + 1):
        labels.append(cell_text(worksheet.cell(row=row, column=1)))
        texts.append(cell_text(worksheet.cell(row=row, column=2)))
    joined = "\n".join(texts)
    required_labels = ["口径说明", "待关注清单", "数据来源", "整理日期", "免责声明"]
    missing = [label for label in required_labels if label not in labels]
    if missing:
        report.block("notes_sections", f"「说明」页缺少章节：{missing}", f"{FILE_SEVEN_N}!{NOTES_SHEET}")
    required_words = ["公开信息", "不构成投资建议", "现场 DD", "法律", "审计", "估值"]
    missing_words = [word for word in required_words if word not in joined]
    if missing_words:
        report.block("notes_disclaimer", f"「说明」页免责声明缺少关键词：{missing_words}",
                     f"{FILE_SEVEN_N}!{NOTES_SHEET}")
    if GREEN_HEX not in joined:
        report.warn("notes_green_rule", f"「说明」页未写明标绿颜色 {GREEN_HEX}", f"{FILE_SEVEN_N}!{NOTES_SHEET}")
    if "标绿" not in labels and "标绿" not in joined:
        report.warn("notes_green_rule", "「说明」页未写明标绿规则", f"{FILE_SEVEN_N}!{NOTES_SHEET}")


def check_multipath(report: Report, data: dict, workbook03: Any) -> None:
    """按 input.sevenN.rows 核对「平台路径 × 实体」是否逐行落到 03 各表。"""
    seven = data.get("sevenN") if isinstance(data.get("sevenN"), dict) else {}
    rows = seven.get("rows") if isinstance(seven.get("rows"), list) else []
    if not rows:
        report.warn("multipath_input", "input 未提供 sevenN.rows，跳过 7+N 多路径核对", "input.json")
        return

    expected: Counter = Counter()
    for item in rows:
        if not isinstance(item, dict):
            continue
        sheet = str(item.get("sheet") or "").strip()
        platform = (item.get("platform") or {}).get("name") if isinstance(item.get("platform"), dict) else None
        entity = (item.get("entity") or {}).get("name") if isinstance(item.get("entity"), dict) else None
        expected[(sheet, str(platform or ""), str(entity or ""))] += 1

    actual: Counter = Counter()
    actual_by_sheet: Counter = Counter()
    for name in workbook03.sheetnames:
        if name == NOTES_SHEET:
            continue
        worksheet = workbook03[name]
        for row in data_rows(worksheet):
            if is_placeholder_row(worksheet, row, len(SEVEN_N_HEADERS)):
                continue
            platform = cell_text(worksheet.cell(row=row, column=COL_PLATFORM))
            entity = cell_text(worksheet.cell(row=row, column=COL_ENTITY))
            actual[(name, platform, entity)] += 1
            actual_by_sheet[name] += 1

    missing_sheets = sorted({key[0] for key in expected if key[0] not in workbook03.sheetnames})
    if missing_sheets:
        report.warn("multipath_sheet", f"input 中的表在 03 中不存在（可能被 3 张家族表上限截断）：{missing_sheets}",
                    "input.json")

    missing = expected - actual
    extra = actual - expected
    if missing:
        report.block(
            "multipath_missing",
            f"03 缺少 {sum(missing.values())} 行 input 中的「平台路径 × 实体」组合",
            FILE_SEVEN_N,
            sum(missing.values()),
            [f"{key[0]}｜{key[1]}｜{key[2]} ×{count}" for key, count in missing.most_common()],
        )
    if extra:
        report.block(
            "multipath_extra",
            f"03 多出 {sum(extra.values())} 行 input 中没有的「平台路径 × 实体」组合",
            FILE_SEVEN_N,
            sum(extra.values()),
            [f"{key[0]}｜{key[1]}｜{key[2]} ×{count}" for key, count in extra.most_common()],
        )

    # 同一实体多路径：应出现在 ≥2 个不同平台
    by_entity: dict[str, set[str]] = {}
    for (sheet, platform, entity), count in actual.items():
        by_entity.setdefault(entity, set()).add(platform)
    multi = {entity: platforms for entity, platforms in by_entity.items() if entity and len(platforms) > 1}
    report.stats["entityPaths"] = {entity: len(platforms) for entity, platforms in by_entity.items() if entity}
    report.stats["multiPathEntities"] = sorted(multi)
    if multi:
        report.notes.append(
            "多路径实体（同一实体经 ≥2 个平台出现，各表各一行、未跨表去重）："
            + "；".join(f"{entity}×{len(platforms)}" for entity, platforms in sorted(multi.items()))
        )
    report.stats["sevenNRows"] = sum(actual.values())


def check_lineage(report: Report, data: dict, workbook02: Any) -> None:
    artifacts = [item for item in data.get("artifacts", []) if isinstance(item, dict)]
    claims = [item for item in data.get("claims", []) if isinstance(item, dict)]
    cell_map = [item for item in data.get("cellMap", []) if isinstance(item, dict)]
    artifact_ids = {str(item.get("artifactId")) for item in artifacts}
    claim_ids = {str(item.get("claimId")) for item in claims}

    rejected = [item for item in artifacts if item.get("status") == "rejected"]
    stale = [item for item in artifacts if item.get("status") == "stale"]
    if rejected:
        report.block(
            "artifact_rejected",
            f"存在 {len(rejected)} 个 rejected 底稿（未处理，阻断交付）",
            "input.json",
            len(rejected),
            [str(item.get("artifactId")) for item in rejected],
        )
    if stale:
        report.warn(
            "artifact_stale",
            f"存在 {len(stale)} 个 stale 底稿（需重跑或人工确认）",
            "input.json",
            len(stale),
            [str(item.get("artifactId")) for item in stale],
        )

    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    if int(meta.get("rejectedCount") or 0) != len(rejected):
        report.warn("meta_count", f"meta.rejectedCount={meta.get('rejectedCount')} 与实际 rejected 底稿数 {len(rejected)} 不一致",
                    "input.json")
    if int(meta.get("staleCount") or 0) != len(stale):
        report.warn("meta_count", f"meta.staleCount={meta.get('staleCount')} 与实际 stale 底稿数 {len(stale)} 不一致",
                    "input.json")

    dangling: list[str] = []
    for item in cell_map:
        claim_id = str(item.get("claimId") or "")
        artifact_id = str(item.get("artifactId") or "")
        if claim_id and claim_id not in claim_ids:
            dangling.append(f"{item.get('location')}→claim {claim_id}")
        if artifact_id and artifact_id not in artifact_ids:
            dangling.append(f"{item.get('location')}→artifact {artifact_id}")
    if dangling:
        report.warn("cellmap_dangling", f"cellMap 有 {len(dangling)} 个悬空引用", "input.json", len(dangling), dangling)

    # 09_模块底稿索引 行数应等于 artifacts 数
    if "09_模块底稿索引" in workbook02.sheetnames:
        worksheet = workbook02["09_模块底稿索引"]
        rows = [row for row in data_rows(worksheet)]
        if len(rows) != len(artifacts):
            report.warn(
                "artifact_index",
                f"09_模块底稿索引 行数 {len(rows)} ≠ input artifacts 数 {len(artifacts)}",
                FILE_COMPREHENSIVE,
            )
    # 08_来源索引 行数应等于 evidence 数
    evidence = [item for item in data.get("evidence", []) if isinstance(item, dict)]
    if "08_来源索引" in workbook02.sheetnames and evidence:
        worksheet = workbook02["08_来源索引"]
        rows = [row for row in data_rows(worksheet)]
        if len(rows) != len(evidence):
            report.warn(
                "evidence_index",
                f"08_来源索引 行数 {len(rows)} ≠ input evidence 数 {len(evidence)}",
                FILE_COMPREHENSIVE,
            )


def check_input_qa(report: Report, data: dict, workbook02: Any) -> None:
    qa = data.get("qa") if isinstance(data.get("qa"), dict) else {}
    blocking = qa.get("blocking") if isinstance(qa.get("blocking"), list) else []
    warnings = qa.get("warnings") if isinstance(qa.get("warnings"), list) else []
    if blocking:
        report.block(
            "input_qa_blocking",
            f"input.qa 仍有 {len(blocking)} 个阻断项未闭环",
            "input.json",
            len(blocking),
            [f"{item.get('id')}：{item.get('message')}" if isinstance(item, dict) else str(item) for item in blocking],
        )
    if qa.get("passed") is False:
        report.block("input_qa_failed", "input.qa.passed=false", "input.json")
    for item in warnings:
        message = f"{item.get('id')}：{item.get('message')}" if isinstance(item, dict) else str(item)
        report.warn("input_qa_warning", message, "input.json")

    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    if meta.get("partial") is True:
        report.warn("meta_partial", "meta.partial=true：交付为部分完成版本", "input.json")
    if not meta.get("banner"):
        report.warn("meta_banner", "meta.banner 为空：缺少示例数据/免责提示", "input.json")

    findings = (data.get("summary") or {}).get("findings") if isinstance(data.get("summary"), dict) else None
    if isinstance(findings, list) and "01_执行摘要" in workbook02.sheetnames:
        count = len(findings)
        if count < 5 or count > 10:
            report.warn("summary_count", f"01_执行摘要 {count} 条，契约 §11 要求 5–10 条", FILE_COMPREHENSIVE)


def check_workbook_health(report: Report, workbook02: Any) -> None:
    if "10_体检单" not in workbook02.sheetnames:
        return
    worksheet = workbook02["10_体检单"]
    items = {cell_text(worksheet.cell(row=row, column=1)) for row in data_rows(worksheet)}
    if "综合结论" not in items:
        report.warn("checkup_row", "10_体检单 缺少「综合结论」行", FILE_COMPREHENSIVE)
    for row in data_rows(worksheet):
        if cell_text(worksheet.cell(row=row, column=1)) == "综合结论":
            result = cell_text(worksheet.cell(row=row, column=2))
            report.stats["checkupConclusion"] = result
            if result not in ("通过", "不通过"):
                report.warn("checkup_row", f"10_体检单 综合结论取值异常：{result}", FILE_COMPREHENSIVE)


# ================================================================ 主流程
def run_check(delivery_dir: Path, input_path: Path | None, map_path: Path | None) -> dict:
    import openpyxl

    report = Report()
    path02 = delivery_dir / FILE_COMPREHENSIVE
    path03 = delivery_dir / FILE_SEVEN_N
    path_map = map_path or (delivery_dir / FILE_MAP)

    missing_files = [str(path) for path in (path02, path03) if not path.is_file()]
    if missing_files:
        report.block("file_missing", f"缺少交付文件：{missing_files}", str(delivery_dir))
        return report_payload(report, delivery_dir, path02, path03, None)

    try:
        workbook02 = openpyxl.load_workbook(path02)
        workbook03 = openpyxl.load_workbook(path03)
    except Exception as exc:
        report.block("file_unreadable", f"xlsx 无法打开：{exc}", str(delivery_dir))
        return report_payload(report, delivery_dir, path02, path03, None)

    map_data = None
    if path_map.is_file():
        try:
            map_data = load_json(path_map)
        except Exception as exc:
            report.block("map_unreadable", f"{FILE_MAP} 无法解析：{exc}", str(path_map))
    else:
        report.warn("map_missing", f"缺少 {FILE_MAP}", str(path_map))

    check_comprehensive(report, workbook02)
    check_seven_n(report, workbook03)
    if map_data is not None:
        check_map(report, map_data, workbook02, workbook03, path02, path03)
    check_blanks_and_formulas(report, workbook02, "02")
    check_blanks_and_formulas(report, workbook03, "03")
    check_six_states(report, workbook02)
    check_three_sheet_semantics(report, workbook03)
    check_caliber_dates(report, workbook02)
    check_notes_sheet(report, workbook03)
    check_workbook_health(report, workbook02)

    data = None
    if input_path is not None:
        try:
            data = load_json(input_path)
        except Exception as exc:
            report.block("input_unreadable", f"input.json 无法解析：{exc}", str(input_path))
    else:
        report.notes.append("未提供 --input，已跳过血缘（cellMap/artifacts）与 7+N 多路径核对")

    if isinstance(data, dict):
        check_multipath(report, data, workbook03)
        check_lineage(report, data, workbook02)
        check_input_qa(report, data, workbook02)

    workbook02.close()
    workbook03.close()
    return report_payload(report, delivery_dir, path02, path03, map_data)


def report_payload(report: Report, delivery_dir: Path, path02: Path, path03: Path,
                   map_data: dict | None) -> dict:
    passed = not report.blocking
    files = []
    for path in (path02, path03):
        if path.is_file():
            files.append(
                {
                    "fileName": path.name,
                    "path": str(path),
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    payload = {
        "ok": passed,
        "passed": passed,
        "dir": str(delivery_dir),
        "mapProvided": map_data is not None,
        "files": files,
        "blocking": report.blocking,
        "warnings": report.warnings,
        "notes": report.notes,
        "stats": report.stats,
        "checkedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    return payload


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="check_deliverable.py",
        description=(
            "交付包体检：结构（11 sheet / 7+N / 20 列）、列语义（比例/股东数/金额/日期/三选一评估）、"
            "状态字段（8 个取值）、空值、公式、多路径、标绿一致性、workbook_map 一致性。\n"
            "只读交付文件；输出 JSON {blocking, warnings, passed}。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python python/check_deliverable.py --dir 05_交付 --input tests/fixtures/deliverable-input.sample.json\n"
            "\n退出码：0 通过；1 有阻断项；2 参数错误；3 交付文件缺失/不可读；7 缺少 openpyxl。"
        ),
    )
    parser.add_argument("--dir", required=True, metavar="<交付目录>", help="包含 02/03 xlsx 与 workbook_map.json 的目录")
    parser.add_argument("--input", metavar="<input.json>", help="构建该交付时使用的契约 JSON（用于血缘与多路径核对）")
    parser.add_argument("--map", metavar="<workbook_map.json>", help="workbook_map.json 路径（默认 <dir>/workbook_map.json）")
    parser.add_argument("--json", metavar="<output.json>", help="把体检结果另存为 JSON（同时打印到 stdout）")
    parser.add_argument("--quiet", action="store_true", help="不向 stdout 打印结果 JSON")
    parser.add_argument("--version", action="version", version="check_deliverable.py 1.0.0")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover
        pass

    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        import openpyxl  # noqa: F401
    except ImportError:
        print(json.dumps({"ok": False, "error": {"code": "missing_dependency",
                                                 "message": "缺少依赖 openpyxl（pip install openpyxl）"}},
                         ensure_ascii=False))
        return EXIT_DEP

    delivery_dir = Path(args.dir).expanduser()
    if not delivery_dir.exists():
        print(json.dumps({"ok": False, "passed": False,
                          "error": {"code": EXIT_INPUT, "message": f"交付目录不存在：{delivery_dir}"}},
                         ensure_ascii=False))
        return EXIT_INPUT
    if not delivery_dir.is_dir():
        print(json.dumps({"ok": False, "passed": False,
                          "error": {"code": EXIT_INPUT, "message": f"--dir 不是目录：{delivery_dir}"}},
                         ensure_ascii=False))
        return EXIT_INPUT

    input_path = Path(args.input).expanduser() if args.input else None
    map_path = Path(args.map).expanduser() if args.map else None
    if input_path is not None and not input_path.is_file():
        print(json.dumps({"ok": False, "passed": False,
                          "error": {"code": EXIT_INPUT, "message": f"input.json 不存在：{input_path}"}},
                         ensure_ascii=False))
        return EXIT_INPUT

    payload = run_check(delivery_dir, input_path, map_path)

    if args.json:
        try:
            atomic_write_json(Path(args.json).expanduser(), payload)
        except OSError as exc:
            print(json.dumps({"ok": False, "error": {"code": EXIT_USAGE, "message": f"无法写出 JSON：{exc}"}},
                             ensure_ascii=False))
            return EXIT_USAGE

    if not args.quiet:
        print(json.dumps(payload, ensure_ascii=False))

    if payload["blocking"] and any(item["code"] == "file_missing" for item in payload["blocking"]):
        return EXIT_INPUT
    return EXIT_OK if payload["passed"] else EXIT_BLOCKING


if __name__ == "__main__":
    raise SystemExit(main())
