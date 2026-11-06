#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Extract per-page text from a PDF as JSON.

Usage: python pdf_extract.py <file.pdf>
Output: {"ok": true, "title": "...", "pages": [{"page": 1, "text": "..."}]}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def extract_with_fitz(path: Path) -> dict:
    import fitz  # PyMuPDF

    doc = fitz.open(path)
    pages = []
    for index, page in enumerate(doc, start=1):
        pages.append({"page": index, "text": page.get_text("text") or ""})
    title = (doc.metadata or {}).get("title") or ""
    return {"title": title, "pages": pages}


def extract_with_pypdf(path: Path) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        pages.append({"page": index, "text": page.extract_text() or ""})
    title = ""
    try:
        title = (reader.metadata or {}).get("/Title") or ""
    except Exception:
        title = ""
    return {"title": title, "pages": pages}


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: pdf_extract.py <file.pdf>"}, ensure_ascii=False))
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(json.dumps({"ok": False, "error": f"file not found: {path}"}, ensure_ascii=False))
        return 2
    errors = []
    for extractor in (extract_with_fitz, extract_with_pypdf):
        try:
            data = extractor(path)
            page_count = len(data.get("pages", []))
            empty = sum(1 for page in data.get("pages", []) if not page["text"].strip())
            print(json.dumps({
                "ok": True,
                "title": data.get("title", ""),
                "pages": data.get("pages", []),
                "pageCount": page_count,
                "emptyPages": empty,
                "extractor": extractor.__name__,
            }, ensure_ascii=False))
            return 0
        except Exception as exc:  # pragma: no cover - depends on local PDF libs
            errors.append(f"{extractor.__name__}: {exc}")
    print(json.dumps({"ok": False, "error": "; ".join(errors)}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
