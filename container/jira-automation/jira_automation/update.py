"""Update an existing Jira issue (status, assignee, comment, fields)."""

from __future__ import annotations

import argparse

from .client import connect, resolve_story_points_field
from .config import Config


def _transition(jira, issue_key: str, target: str) -> None:
    issue = jira.issue(issue_key)
    transitions = jira.transitions(issue)
    needle = target.lower()
    for t in transitions:
        if t["name"].lower() == needle or t["to"]["name"].lower() == needle:
            jira.transition_issue(issue, t["id"])
            print(f"[STATUS]  {issue_key} -> {t['to']['name']}")
            return
    options = ", ".join(t["to"]["name"] for t in transitions)
    raise RuntimeError(
        f"상태 '{target}' 로의 전환을 찾을 수 없습니다. 가능: {options}"
    )


def _assign(jira, issue_key: str, assignee: str) -> None:
    if assignee.lower() == "me":
        me = jira.myself()
        jira.assign_issue(issue_key, me["accountId"])
        print(f"[ASSIGN]  {issue_key} -> me ({me.get('displayName', me['accountId'])})")
        return
    jira.assign_issue(issue_key, assignee)
    print(f"[ASSIGN]  {issue_key} -> {assignee}")


def run(args: argparse.Namespace, cfg: Config) -> int:
    jira = connect(cfg)

    if args.status:
        _transition(jira, args.key, args.status)
    if args.assign:
        _assign(jira, args.key, args.assign)
    if args.comment:
        jira.add_comment(args.key, args.comment)
        print(f"[COMMENT] {args.key}")
    if args.summary:
        jira.issue(args.key).update(fields={"summary": args.summary})
        print(f"[SUMMARY] {args.key} -> {args.summary}")
    if args.priority:
        jira.issue(args.key).update(fields={"priority": {"name": args.priority}})
        print(f"[PRIORITY] {args.key} -> {args.priority}")
    if args.points is not None:
        sp_field = resolve_story_points_field(jira, cfg.story_points_field)
        jira.issue(args.key).update(fields={sp_field: args.points})
        print(f"[POINTS]  {args.key} = {args.points}")
    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser("update", help="이슈 필드 수정")
    p.add_argument("key", help="이슈 키 (예: PROJ-123)")
    p.add_argument("--status", help="상태 전환 (예: 'In Progress', 'Done')")
    p.add_argument("--assign", help="담당자 accountId 또는 'me'")
    p.add_argument("--comment", help="코멘트 추가")
    p.add_argument("--summary", help="제목 수정")
    p.add_argument("--priority", help="우선순위 (High/Medium/Low)")
    p.add_argument("--points", type=int, help="Story Points")
    p.set_defaults(func=run)
