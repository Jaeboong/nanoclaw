"""Configuration loading with explicit discovery order.

탐색 순서:
  1. $JIRA_CONFIG_DIR/.env        (명시적 오버라이드)
  2. ./.env                       (현재 CWD)
  3. ~/.config/jira-automation/.env  (XDG user config)

모든 경로에서 찾지 못하면 ConfigError. JIRA_URL / JIRA_EMAIL /
JIRA_API_TOKEN / JIRA_PROJECT_KEY 는 필수. 기본값 없음 —
미설정 시 조용히 엉뚱한 프로젝트로 요청이 나가는 것을 차단하기 위함.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


class ConfigError(RuntimeError):
    """Raised when required config is missing or no .env found."""


_REQUIRED = ("JIRA_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY")


@dataclass(frozen=True)
class Config:
    jira_url: str
    jira_email: str
    jira_api_token: str
    project_key: str
    story_points_field: Optional[str]
    epic_link_field: Optional[str]
    timeout: int
    env_path: Path


def _candidate_paths() -> list[Path]:
    paths: list[Path] = []
    override = os.environ.get("JIRA_CONFIG_DIR")
    if override:
        paths.append(Path(override).expanduser() / ".env")
    paths.append(Path.cwd() / ".env")
    paths.append(Path.home() / ".config" / "jira-automation" / ".env")
    return paths


def _find_env_file() -> Path:
    tried = _candidate_paths()
    for candidate in tried:
        if candidate.is_file():
            return candidate
    rendered = "\n  ".join(str(p) for p in tried)
    raise ConfigError(
        "Jira .env 파일을 찾을 수 없습니다. 다음 경로를 순서대로 확인했습니다:\n  "
        f"{rendered}\n\n"
        "설정 방법:\n"
        "  1) .env.example 을 복사해 위 경로 중 하나에 .env 로 저장\n"
        "  2) 또는 $JIRA_CONFIG_DIR 로 .env 가 있는 디렉토리를 지정"
    )


def load_config() -> Config:
    env_path = _find_env_file()
    load_dotenv(dotenv_path=env_path, override=False)

    missing = [k for k in _REQUIRED if not os.environ.get(k)]
    if missing:
        raise ConfigError(
            f"{env_path} 에서 필수 값이 누락되었습니다: {', '.join(missing)}\n"
            ".env.example 을 참고해 채워 주세요."
        )

    try:
        timeout = int(os.environ.get("JIRA_TIMEOUT", "10"))
    except ValueError as exc:
        raise ConfigError(f"JIRA_TIMEOUT 은 정수여야 합니다: {exc}") from exc

    return Config(
        jira_url=os.environ["JIRA_URL"].rstrip("/"),
        jira_email=os.environ["JIRA_EMAIL"],
        jira_api_token=os.environ["JIRA_API_TOKEN"],
        project_key=os.environ["JIRA_PROJECT_KEY"],
        story_points_field=os.environ.get("JIRA_STORY_POINTS_FIELD") or None,
        epic_link_field=os.environ.get("JIRA_EPIC_LINK_FIELD") or None,
        timeout=timeout,
        env_path=env_path,
    )
