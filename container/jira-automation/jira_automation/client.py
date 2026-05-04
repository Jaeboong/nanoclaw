"""Jira client factory + custom field auto-discovery."""

from __future__ import annotations

from typing import Optional

from jira import JIRA

from .config import Config

_FIELDS_CACHE: dict[int, tuple[dict, ...]] = {}


def connect(cfg: Config) -> JIRA:
    return JIRA(
        server=cfg.jira_url,
        basic_auth=(cfg.jira_email, cfg.jira_api_token),
        timeout=cfg.timeout,
    )


def _fields(jira: JIRA) -> tuple[dict, ...]:
    key = id(jira)
    cached = _FIELDS_CACHE.get(key)
    if cached is None:
        cached = tuple(jira.fields())
        _FIELDS_CACHE[key] = cached
    return cached


def resolve_epic_link_field(jira: JIRA, override: Optional[str] = None) -> str:
    """Return the custom-field ID that represents the Epic Link on this instance.

    - override 가 주어지면 그대로 반환 (사용자가 .env 에 박은 값).
    - 그렇지 않으면 name == "Epic Link" 인 필드의 id를 찾음.
    - 그래도 없으면 RuntimeError.
    """
    if override:
        return override
    for field in _fields(jira):
        if field.get("name") == "Epic Link":
            return field["id"]
    raise RuntimeError(
        "Epic Link 필드를 자동 탐색하지 못했습니다. "
        "`jira doctor` 로 후보를 확인하고 .env 에 JIRA_EPIC_LINK_FIELD 를 지정하세요."
    )


def resolve_story_points_field(jira: JIRA, override: Optional[str] = None) -> str:
    if override:
        return override
    for field in _fields(jira):
        name = (field.get("name") or "").lower()
        if name in {"story points", "story point estimate"}:
            return field["id"]
    raise RuntimeError(
        "Story Points 필드를 자동 탐색하지 못했습니다. "
        "`jira doctor` 로 후보를 확인하고 .env 에 JIRA_STORY_POINTS_FIELD 를 지정하세요."
    )
