#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""只读体检一个 xlsx：结构、表头、公式错误、空表头、重复表头、样例行。

契约依据：docs/交付构建输入.md §4（体检输出 JSON）。
本脚本只读文件，不修改、不保存、不新增任何内容。

用法：
    python python/inspect_workbook.py --file <xlsx> --json <output.json>

输出 JSON 顶层键（契约 §4）：
    ok / file / sheets / formulaErrors / emptyHeaders / duplicateHeaders / sampleRows
附加键（不破坏契约，供 QA 与 JS 调用）：
    generatedAt / kind / checks / warnings / stats

退出码：
    0 体检完成且未发现结构性问题
    1 体检完成但发现结构性问题（ok=false，JSON 仍会写出）
    2 参数错误
    3 文件不存在或不是 xlsx
    4 文件损坏 / 无法读取
    7 缺少 openpyxl
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any, Sequence

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE = 2
EXIT_INPUT = 3
EXIT_READ = 4
EXIT_DEP = 7

# 契约 §4 要求检查的公式错误串
FORMULA_ERRORS = ("#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NAME?", "#NULL!", "#NUM!", "#SPILL!", "#CALC!")

# 03 专项的固定表名（契约 §3）
SEVEN_N_FIXED = (
    "1-直接投资",
    "2-合作基金-GP",
    "3-合作基金-主导LP",
    "4-合作基金-财务LP",
    "5-海外平台",
    "6-合资公司",
    "7-国内基地",
)

# 03 交付清理版 20 列表头（逐字，顺序固定）
SEVEN_N_HEADERS_20 = [
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

# 02 综合工作簿 11 个固定 sheet
COMPREHENSIVE_NAMES = [
    "00_目录",
    "01_执行摘要",
    "02_主体与股权",
    "03_业务与技术",
    "04_财务",
    "05_风险",
    "06_待核清单",
    "07_资料请求",
    "08_来源索引",
    "09_模块底稿索引",
    "10_体检单",
]

NOTES_SHEET = "说明"


class InspectError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def looks_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    return False


def json_safe(value: Any) -> Any:
    """把单元格值转成可 JSON 序列化的类型（日期转 ISO 字符串）。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return value
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float, str)):
        return value
    return str(value)


def detect_header_row(worksheet: Any, max_scan: int = 8) -> int:
    """找表头行：跳过只有 1 个非空格子的标题行（合并单元格只在左上角存值）。"""
    last_row = worksheet.max_row or 1
    last_col = worksheet.max_column or 1
    single_row_fallback = 0
    for row_index in range(1, min(max_scan, last_row) + 1):
        filled = sum(
            1
            for column in range(1, last_col + 1)
            if not looks_empty(worksheet.cell(row=row_index, column=column).value)
        )
        if filled >= 2:
            return row_index
        if filled == 1 and not single_row_fallback:
            single_row_fallback = row_index
    return single_row_fallback or 1


def column_letter(index: int) -> str:
    from openpyxl.utils import get_column_letter

    return get_column_letter(index)


def inspect_file(path: Path, sample_rows: int = 3) -> dict:
    """体检主流程：返回契约 §4 JSON。"""
    import openpyxl

    try:
        workbook = openpyxl.load_workbook(path, data_only=False, read_only=False)
    except Exception as exc:  # openpyxl 抛的异常类型较多，统一兜底
        raise InspectError(EXIT_READ, f"无法打开 xlsx（可能已损坏）：{path}（{exc}）") from exc

    checks: list[dict] = []
    warnings: list[str] = []

    def add_check(check_id: str, status: str, detail: str) -> None:
        checks.append({"id": check_id, "status": status, "detail": detail})
        if status == "warn":
            warnings.append(detail)

    sheets: list[dict] = []
    formula_errors: list[dict] = []
    empty_headers: list[str] = []
    duplicate_headers: list[str] = []
    samples: list[dict] = []

    for worksheet in workbook.worksheets:
        name = worksheet.title
        header_row = detect_header_row(worksheet)
        max_row = worksheet.max_row or 0
        max_col = worksheet.max_column or 0

        raw_headers = [
            worksheet.cell(row=header_row, column=column).value for column in range(1, max_col + 1)
        ]
        # 去掉尾部空表头，只保留真正的表格宽度
        last_filled = 0
        for index, value in enumerate(raw_headers, start=1):
            if not looks_empty(value):
                last_filled = index
        headers = [
            "" if value is None else str(value).strip() for value in raw_headers[:last_filled]
        ]

        for index, header in enumerate(headers, start=1):
            if not header:
                empty_headers.append(f"{name}!{column_letter(index)}{header_row}")
        counter = Counter(header for header in headers if header)
        for header, count in counter.items():
            if count > 1:
                duplicate_headers.append(f"{name}：{header}（出现 {count} 次）")

        formula_count = 0
        blank_cells = 0
        placeholder_cells = 0
        for row_index in range(header_row + 1, max_row + 1):
            for column in range(1, last_filled + 1):
                cell = worksheet.cell(row=row_index, column=column)
                value = cell.value
                if cell.data_type == "f" or (isinstance(value, str) and value.startswith("=")):
                    formula_count += 1
                if value is None:
                    blank_cells += 1
                elif isinstance(value, str):
                    text = value.strip()
                    if text == "未提供/not_reviewed":
                        placeholder_cells += 1
                    for code in FORMULA_ERRORS:
                        if code in text:
                            formula_errors.append(
                                {
                                    "sheet": name,
                                    "cell": f"{column_letter(column)}{row_index}",
                                    "value": text,
                                    "code": code,
                                }
                            )
                            break

        # 样例行：表头下前 N 行
        for offset in range(sample_rows):
            row_index = header_row + 1 + offset
            if row_index > max_row:
                break
            values = [
                json_safe(worksheet.cell(row=row_index, column=column).value)
                for column in range(1, last_filled + 1)
            ]
            if not any(value != "" for value in values):
                continue
            samples.append({"sheet": name, "row": row_index, "values": values})

        info = {
            "name": name,
            "rows": max_row,
            "cols": max_col,
            "headers": headers,
            "freeze": worksheet.freeze_panes,
            "autoFilter": worksheet.auto_filter.ref,
            # 附加信息
            "headerRow": header_row,
            "dataRows": max(max_row - header_row, 0),
            "tableCols": last_filled,
            "title": str(worksheet.cell(row=1, column=1).value or ""),
            "mergedRanges": [str(item) for item in worksheet.merged_cells.ranges],
            "formulaCount": formula_count,
            "blankCells": blank_cells,
            "placeholderCells": placeholder_cells,
        }
        sheets.append(info)

        if not worksheet.freeze_panes:
            add_check(f"freeze/{name}", "error", f"{name} 未设置冻结窗格")
        if not worksheet.auto_filter.ref:
            add_check(f"autofilter/{name}", "error", f"{name} 未设置自动筛选")
        if blank_cells:
            add_check(f"blank/{name}", "error", f"{name} 数据区存在 {blank_cells} 个空白单元格")
        if formula_count:
            add_check(f"formula/{name}", "warn", f"{name} 含 {formula_count} 个公式单元格（交付版应为纯值）")

    # ---------------- 结构判定（02 / 03）
    names = [sheet["name"] for sheet in sheets]
    kind = "unknown"
    if names == COMPREHENSIVE_NAMES:
        kind = "comprehensive"
        add_check("sheet_order", "pass", "02 综合工作簿 11 个 sheet 顺序与契约一致")
    elif names[: len(COMPREHENSIVE_NAMES)] == COMPREHENSIVE_NAMES:
        kind = "comprehensive"
        add_check("sheet_order", "error", f"02 sheet 数量或顺序不符：{[n for n in names if n not in COMPREHENSIVE_NAMES]}")
    elif all(fixed in names for fixed in SEVEN_N_FIXED):
        kind = "seven_n"
    else:
        add_check("sheet_order", "warn", "未识别为 02/03 标准结构，仅做通用体检")

    if kind == "seven_n":
        family = [
            name
            for name in names
            if name not in SEVEN_N_FIXED and name != NOTES_SHEET
        ]
        if len(family) > 3:
            add_check("family_count", "error", f"家族表超过 3 张：{len(family)} 张（{'、'.join(family)}）")
        else:
            add_check(
                "family_count",
                "pass",
                f"7 张固定表 + {len(family)} 张家族表" + (f"（{'、'.join(family)}）" if family else ""),
            )
        if NOTES_SHEET not in names:
            add_check("notes_sheet", "error", "缺少「说明」sheet")
        elif names[-1] != NOTES_SHEET:
            add_check("notes_sheet", "error", "「说明」sheet 不在最后")
        else:
            add_check("notes_sheet", "pass", "「说明」sheet 存在且位于最后")

        for sheet in sheets:
            if sheet["name"] == NOTES_SHEET:
                continue
            if sheet["headers"] == SEVEN_N_HEADERS_20:
                add_check(f"header20/{sheet['name']}", "pass", f"{sheet['name']} 20 列表头与契约逐字一致")
            elif len(sheet["headers"]) == 24:
                add_check(
                    f"header20/{sheet['name']}",
                    "warn",
                    f"{sheet['name']} 为 24 列未清理版（契约要求交付清理版 20 列）",
                )
            else:
                add_check(
                    f"header20/{sheet['name']}",
                    "error",
                    f"{sheet['name']} 表头既不是 20 列也不是 24 列（实际 {len(sheet['headers'])} 列）",
                )
            if sheet["cols"] != len(sheet["headers"]):
                add_check(
                    f"cols/{sheet['name']}",
                    "warn",
                    f"{sheet['name']} 实际列数 {sheet['cols']} 与表头列数 {len(sheet['headers'])} 不一致",
                )

    if formula_errors:
        add_check("formula_errors", "error", f"发现 {len(formula_errors)} 处公式错误串")
    else:
        add_check("formula_errors", "pass", "未发现 #REF!/#N/A/#VALUE!/#DIV/0! 等公式错误")
    if empty_headers:
        add_check("empty_headers", "error", f"发现 {len(empty_headers)} 个空表头")
    else:
        add_check("empty_headers", "pass", "无空表头")
    if duplicate_headers:
        add_check("duplicate_headers", "error", f"发现 {len(duplicate_headers)} 组重复表头")
    else:
        add_check("duplicate_headers", "pass", "无重复表头")

    failed = [check for check in checks if check["status"] == "error"]
    result = {
        "ok": not failed,
        "file": str(path),
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "kind": kind,
        "sheets": sheets,
        "formulaErrors": formula_errors,
        "emptyHeaders": empty_headers,
        "duplicateHeaders": duplicate_headers,
        "sampleRows": samples,
        "checks": checks,
        "warnings": warnings,
        "stats": {
            "sheetCount": len(sheets),
            "rowTotal": sum(sheet["rows"] for sheet in sheets),
            "formulaCells": sum(sheet["formulaCount"] for sheet in sheets),
            "blankCells": sum(sheet["blankCells"] for sheet in sheets),
            "placeholderCells": sum(sheet["placeholderCells"] for sheet in sheets),
            "errorCount": len(failed),
        },
    }
    workbook.close()
    return result


def atomic_write_json(path: Path, payload: dict) -> None:
    """先写临时文件再替换，避免下游读到半截 JSON。"""
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="inspect_workbook.py",
        description=(
            "只读体检一个 xlsx：输出契约 §4 的 JSON（sheets / headers / rows / cols / freeze / "
            "autoFilter / formulaErrors / emptyHeaders / duplicateHeaders / sampleRows）。\n"
            "不修改文件；缺失字段不补、不猜。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python python/inspect_workbook.py --file 05_交付/02_综合尽调工作簿.xlsx --json qa/02.json\n"
            "\n退出码：0 无结构性问题；1 发现结构性问题（JSON 仍写出）；2 参数错误；3 文件不存在；"
            "4 文件损坏；7 缺少 openpyxl。"
        ),
    )
    parser.add_argument("--file", required=True, metavar="<xlsx>", help="待体检的 xlsx 路径")
    parser.add_argument("--json", required=True, metavar="<output.json>", help="体检结果 JSON 输出路径；- 表示只打印到 stdout")
    parser.add_argument("--sample-rows", type=int, default=3, metavar="N", help="每个 sheet 抽样行数（默认 3）")
    parser.add_argument("--quiet", action="store_true", help="不向 stdout 打印结果 JSON")
    parser.add_argument("--version", action="version", version="inspect_workbook.py 1.0.0")
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

    path = Path(args.file).expanduser()
    if not path.exists():
        print(json.dumps({"ok": False, "error": {"code": EXIT_INPUT, "message": f"文件不存在：{path}"}},
                         ensure_ascii=False))
        return EXIT_INPUT
    if not path.is_file():
        print(json.dumps({"ok": False, "error": {"code": EXIT_INPUT, "message": f"不是文件：{path}"}},
                         ensure_ascii=False))
        return EXIT_INPUT

    try:
        result = inspect_file(path, sample_rows=max(args.sample_rows, 0))
    except InspectError as exc:
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": exc.message}},
                         ensure_ascii=False))
        return exc.code

    if args.json != "-":
        try:
            atomic_write_json(Path(args.json).expanduser(), result)
        except OSError as exc:
            print(json.dumps({"ok": False, "error": {"code": EXIT_USAGE,
                                                     "message": f"无法写出 JSON：{args.json}（{exc}）"}},
                             ensure_ascii=False))
            return EXIT_USAGE

    if not args.quiet:
        print(json.dumps(result, ensure_ascii=False))
    return EXIT_OK if result["ok"] else EXIT_FINDINGS


if __name__ == "__main__":
    raise SystemExit(main())
