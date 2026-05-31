"""Create a single Jira issue."""

from __future__ import annotations

import argparse
from typing import Optional

from .client import connect, resolve_epic_link_field, resolve_story_points_field
from .config import Config


def _is_subtask(issuetype: str) -> bool:
    return issuetype.strip().lower().replace(" ", "").replace("-", "") == "subtask"


def _create(
    jira,
    project_key: str,
    summary: str,
    description: str,
    issuetype: str,
    priority: Optional[str],
    points: Optional[int],
    epic_key: Optional[str],
    parent_key: Optional[str],
    sp_override: Optional[str],
    epic_override: Optional[str],
):
    if _is_subtask(issuetype) and not parent_key:
        raise ValueError(
            f"이슈 유형이 '{issuetype}' 인데 부모가 지정되지 않았습니다. "
            "--parent <PARENT_ISSUE_KEY> 를 추가하세요 (예: --parent PROJ-123)."
        )

    fields: dict = {
        "project": {"key": project_key},
        "summary": summary,
        "description": description or "",
        "issuetype": {"name": issuetype},
    }
    if priority:
        fields["priority"] = {"name": priority}
    if parent_key:
        fields["parent"] = {"key": parent_key}

    issue = jira.create_issue(fields=fields)
    parent_note = f" (parent={parent_key})" if parent_key else ""
    print(f"[CREATED] {issue.key} - {summary}{parent_note}")

    if points is not None:
        sp_field = resolve_story_points_field(jira, sp_override)
        issue.update(fields={sp_field: points})
        print(f"[POINTS]  {issue.key} = {points}")

    if epic_key:
        epic_field = resolve_epic_link_field(jira, epic_override)
        issue.update(fields={epic_field: epic_key})
        print(f"[LINKED]  {issue.key} -> {epic_key}")

    return issue


def run(args: argparse.Namespace, cfg: Config) -> int:
    jira = connect(cfg)
    project_key = args.project or cfg.project_key
    _create(
        jira,
        project_key=project_key,
        summary=args.summary,
        description=args.description or "",
        issuetype=args.type,
        priority=args.priority,
        points=args.points,
        epic_key=args.epic,
        parent_key=args.parent,
        sp_override=cfg.story_points_field,
        epic_override=cfg.epic_link_field,
    )
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser("create", help="이슈 생성")
    p.add_argument("--project", help="프로젝트 키 (기본: .env JIRA_PROJECT_KEY)")
    p.add_argument("--summary", required=True, help="이슈 제목")
    p.add_argument("--description", help="이슈 설명")
    p.add_argument("--type", default="Task", help="이슈 유형 (Task/Story/Bug/Epic/Sub-task 등)")
    p.add_argument("--priority", help="우선순위 (High/Medium/Low)")
    p.add_argument("--points", type=int, help="Story Points")
    p.add_argument("--epic", help="연결할 에픽 키 (예: PROJ-12)")
    p.add_argument(
        "--parent",
        help="부모 이슈 키 (Sub-task 생성 시 필수, 예: PROJ-123)",
    )
    p.set_defaults(func=run)
