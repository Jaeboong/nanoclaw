"""Link a Story/Task to an Epic."""

from __future__ import annotations

import argparse

from .client import connect, resolve_epic_link_field
from .config import Config


def run(args: argparse.Namespace, cfg: Config) -> int:
    jira = connect(cfg)
    epic_field = resolve_epic_link_field(jira, cfg.epic_link_field)
    jira.issue(args.issue).update(fields={epic_field: args.epic})
    print(f"[LINKED] {args.issue} -> {args.epic} ({epic_field})")
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser("link", help="이슈를 에픽에 연결")
    p.add_argument("issue", help="연결할 이슈 키 (예: PROJ-42)")
    p.add_argument("epic", help="에픽 키 (예: PROJ-12)")
    p.set_defaults(func=run)
