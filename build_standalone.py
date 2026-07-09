#!/usr/bin/env python3
"""index.html・style.css・各.jsファイルを1つのHTMLファイルにまとめて
genogram_standalone.html（配布用）とgenogram_事務所用.html（事務所配布用の
同内容コピー）を作る。

開発（Claude Codeでの編集）は引き続きindex.html等の個別ファイルで行い、
変更したら最後にこのスクリプトを実行して両方を作り直す。

実行方法: python3 build_standalone.py
"""
import re
from pathlib import Path

BASE_DIR = Path(__file__).parent
INDEX_HTML = BASE_DIR / "index.html"
OUTPUT_HTMLS = [BASE_DIR / "genogram_standalone.html", BASE_DIR / "genogram_事務所用.html"]

JS_FILES = [
    "models.js",
    "combobox.js",
    "relation_rules.js",
    "canvas.js",
    "forms.js",
    "document_store.js",
    "export.js",
    "app.js",
]


def main():
    html = INDEX_HTML.read_text(encoding="utf-8")

    css_content = (BASE_DIR / "style.css").read_text(encoding="utf-8")
    html = html.replace(
        '<link rel="stylesheet" href="style.css">',
        f"<style>\n{css_content}\n</style>",
    )

    for js_file in JS_FILES:
        js_content = (BASE_DIR / js_file).read_text(encoding="utf-8")
        html = html.replace(
            f'<script src="{js_file}"></script>',
            f"<script>\n{js_content}\n</script>",
        )

    # 万が一置換漏れの<script src=...>やlinkが残っていないか確認
    if re.search(r'<script src="[^"]+\.js"></script>', html):
        raise RuntimeError("一部の<script src>が置換されずに残っています。JS_FILESの一覧を確認してください。")
    if "<link rel=\"stylesheet\"" in html:
        raise RuntimeError("style.cssへのlinkタグが置換されずに残っています。")

    for output_html in OUTPUT_HTMLS:
        output_html.write_text(html, encoding="utf-8")
        print(f"作成しました: {output_html}")


if __name__ == "__main__":
    main()
