"""Diagnostics: verify config loading, connection, and discover custom field IDs."""

from __future__ import annotations

import argparse

from .client import (
    connect,
    resolve_epic_link_field,
    resolve_story_points_field,
)
from .config import Config


def run(args: argparse.Namespace, cfg: Config) -> int:
    print(f"[CONFIG]   env file   = {cfg.env_path}")
    print(f"[CONFIG]   JIRA_URL   = {cfg.jira_url}")
    print(f"[CONFIG]   project    = {cfg.project_key}")
    print(f"[CONFIG]   timeout    = {cfg.timeout}s")

    jira = connect(cfg)
    me = jira.myself()
    display = me.get("displayName") or me.get("emailAddress") or "unknown"
    print(f"[CONNECT]  OK, as {display}")

    try:
        sp = resolve_story_points_field(jira, cfg.story_points_field)
        source = "override" if cfg.story_points_field else "auto"
        print(f"[FIELD]    story points = {sp} ({source})")
    except RuntimeError as exc:
        print(f"[FIELD]    story points = UNRESOLVED ({exc})")

    try:
        epic = resolve_epic_link_field(jira, cfg.epic_link_field)
        source = "override" if cfg.epic_link_field else "auto"
        print(f"[FIELD]    epic link    = {epic} ({source})")
    except RuntimeError as exc:
        print(f"[FIELD]    epic link    = UNRESOLVED ({exc})")

    return 0


def register(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser("doctor", help="설정/연결/커스텀 필드 진단")
    p.set_defaults(func=run)
