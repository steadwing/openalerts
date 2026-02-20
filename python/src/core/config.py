from __future__ import annotations

import os

from pydantic import BaseModel, Field


class RuleOverride(BaseModel):
    enabled: bool | None = None
    threshold: int | None = None
    cooldown_seconds: int | None = None


class ChannelConfig(BaseModel):
    type: str
    webhook_url: str | None = None
    name: str | None = None
    headers: dict[str, str] | None = None


class OpenAlertsConfig(BaseModel):
    channels: list[ChannelConfig] = Field(default_factory=list)
    framework: str = "openmanus"
    rules: dict[str, RuleOverride] = Field(default_factory=dict)
    cooldown_seconds: int = 900
    max_alerts_per_hour: int = 5
    quiet: bool = False
    state_dir: str | None = None
    log_level: str = "INFO"
    max_log_size_kb: int = 512
    max_log_age_days: int = 7
    dashboard: bool = True
    dashboard_port: int = 9464
    persist: bool = True

    @classmethod
    def from_dict(cls, data: dict) -> OpenAlertsConfig:
        config = cls.model_validate(data)
        config = _apply_env_vars(config)
        return config


_ENV_CHANNEL_MAP: dict[str, str] = {
    "OPENALERTS_SLACK_WEBHOOK_URL": "slack",
    "OPENALERTS_DISCORD_WEBHOOK_URL": "discord",
    "OPENALERTS_WEBHOOK_URL": "webhook",
}


def _apply_env_vars(config: OpenAlertsConfig) -> OpenAlertsConfig:
    # Add channels from env vars if not already configured
    existing_types = {c.type for c in config.channels}
    for env_var, channel_type in _ENV_CHANNEL_MAP.items():
        url = os.environ.get(env_var)
        if url and channel_type not in existing_types:
            config.channels.append(
                ChannelConfig(type=channel_type, webhook_url=url)
            )

    if os.environ.get("OPENALERTS_QUIET", "").lower() in ("1", "true", "yes"):
        config.quiet = True

    env_state_dir = os.environ.get("OPENALERTS_STATE_DIR")
    if env_state_dir and config.state_dir is None:
        config.state_dir = env_state_dir

    return config
