"""Search issues and write results to a markdown file.

에이전트 계약: stdout 으로
    TEMP_FILE_PATH:<path>
    ISSUE_COUNT:<n>
두 줄을 출력. 에이전트는 이 경로를 Read 도구로 읽는다.
"""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path
from typing import Optional

from .client import connect, resolve_story_points_field
from .config import Config


def _build_jql(args: argparse.Namespace, cfg: Config) -> str:
    if args.jql:
        return args.jql
    project = args.project or cfg.project_key
    return f"project = {project} ORDER BY key ASC"


def _open_out_file(path: Optional[str]) -> tuple[Path, bool]:
    """Return (path, is_temp)."""
    if path:
        p = Path(path).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        return p, False
    tmp = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".md", delete=False
    )
    tmp.close()
    return Path(tmp.name), True


def run(args: argparse.Namespace, cfg: Config) -> int:
    jira = connect(cfg)
    jql = _build_jql(args, cfg)

    try:
        sp_field = resolve_story_points_field(jira, cfg.story_points_field)
    except RuntimeError:
        sp_field = None

    issues = jira.search_issues(jql, maxResults=args.limit)

    keyword = args.filter
    if keyword:
        needle = keyword.upper()
        issues = [
            i
            for i in issues
            if needle in (i.fields.summary or "").upper()
            or needle in (i.fields.description or "").upper()
        ]

    out_path, is_temp = _open_out_file(args.out)
    try:
        with out_path.open("w", encoding="utf-8") as fh:
            fh.write("# JIRA 이슈 검색 결과\n\n")
            fh.write(f"**JQL**: `{jql}`\n\n")
            fh.write(f"**총 {len(issues)}개 이슈**\n\n---\n\n")
            for i, issue in enumerate(issues, 1):
                assignee = (
                    issue.fields.assignee.displayName
                    if issue.fields.assignee
                    else "미할당"
                )
                fh.write(f"## {i}. [{issue.key}] {issue.fields.summary}\n\n")
                fh.write(f"- **상태**: {issue.fields.status.name}\n")
                fh.write(f"- **담당자**: {assignee}\n")
                fh.write(f"- **유형**: {issue.fields.issuetype.name}\n")
                if sp_field:
                    points = getattr(issue.fields, sp_field, None)
                    if points is not None:
                        fh.write(f"- **Story Points**: {points}\n")
                desc = issue.fields.description or ""
                if desc:
                    preview = desc[:200] + ("..." if len(desc) > 200 else "")
                    fh.write(f"- **설명**: {preview}\n")
                fh.write("\n---\n\n")
    except Exception:
        if is_temp:
            try:
                os.unlink(out_path)
            except OSError:
                pass
        raise

    print(f"TEMP_FILE_PATH:{out_path}")
    print(f"ISSUE_COUNT:{len(issues)}")
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "search",
        help="이슈 검색 후 markdown 파일로 저장 (stdout에 경로 출력)",
    )
    p.add_argument("--jql", help="직접 JQL. 지정 시 --project/--filter 무시됨.")
    p.add_argument("--project", help="프로젝트 키 (기본: .env JIRA_PROJECT_KEY)")
    p.add_argument("--filter", help="summary/description 에 대한 대소문자 무시 키워드 필터")
    p.add_argument("--limit", type=int, default=100, help="최대 결과 개수 (기본 100)")
    p.add_argument("--out", help="저장 경로. 미지정 시 임시 파일 사용.")
    p.set_defaults(func=run)
