"""Top-level CLI entry: `jira <subcommand> ...` and `python -m jira_automation`."""

from __future__ import annotations

import argparse
import sys

from . import create, doctor, link, search, update
from .config import ConfigError, load_config


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jira",
        description="Agent-friendly Jira CLI.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    search.register(subparsers)
    create.register(subparsers)
    update.register(subparsers)
    link.register(subparsers)
    doctor.register(subparsers)
    return parser


def main(argv: list[str] | None = None) -> int:
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        cfg = load_config()
    except ConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    try:
        return int(args.func(args, cfg) or 0)
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
