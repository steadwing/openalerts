from __future__ import annotations

import datetime
from typing import Any

from openalerts.core.types import AlertEvent, Severity

_SEVERITY_EMOJI = {
    Severity.INFO: "ℹ️",
    Severity.WARN: "⚠️",
    Severity.ERROR: "🚨",
    Severity.CRITICAL: "🔥",
}

_SEVERITY_COLOR = {
    Severity.INFO: "#36a64f",
    Severity.WARN: "#ffcc00",
    Severity.ERROR: "#ff4444",
    Severity.CRITICAL: "#cc0000",
}

_SEVERITY_DISCORD_COLOR = {
    Severity.INFO: 0x36A64F,
    Severity.WARN: 0xFFCC00,
    Severity.ERROR: 0xFF4444,
    Severity.CRITICAL: 0xCC0000,
}


def format_alert(alert: AlertEvent) -> str:
    """Format alert for plain text delivery."""
    emoji = _SEVERITY_EMOJI.get(alert.severity, "")
    ts = datetime.datetime.fromtimestamp(alert.ts, tz=datetime.UTC).strftime(
        "%Y-%m-%d %H:%M:%S UTC"
    )
    return f"{emoji} [{alert.severity.upper()}] {alert.title}\n{alert.detail}\nRule: {alert.rule_id} | {ts}"


def format_alert_slack(alert: AlertEvent) -> dict[str, Any]:
    """Format as Slack Block Kit payload."""
    color = _SEVERITY_COLOR.get(alert.severity, "#808080")
    emoji = _SEVERITY_EMOJI.get(alert.severity, "")
    return {
        "attachments": [
            {
                "color": color,
                "blocks": [
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": f"{emoji} *{alert.title}*",
                        },
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": alert.detail,
                        },
                    },
                    {
                        "type": "context",
                        "elements": [
                            {
                                "type": "mrkdwn",
                                "text": f"Rule: `{alert.rule_id}` | Severity: `{alert.severity}`",
                            }
                        ],
                    },
                ],
            }
        ]
    }


def format_alert_discord(alert: AlertEvent) -> dict[str, Any]:
    """Format as Discord embed payload."""
    color = _SEVERITY_DISCORD_COLOR.get(alert.severity, 0x808080)
    emoji = _SEVERITY_EMOJI.get(alert.severity, "")
    return {
        "embeds": [
            {
                "title": f"{emoji} {alert.title}",
                "description": alert.detail,
                "color": color,
                "footer": {"text": f"Rule: {alert.rule_id} | Severity: {alert.severity}"},
                "timestamp": datetime.datetime.fromtimestamp(
                    alert.ts, tz=datetime.UTC
                ).isoformat(),
            }
        ]
    }
