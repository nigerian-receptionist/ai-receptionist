"""Minimal redaction for benchmark outputs and live-demo logs."""

from __future__ import annotations

import re

_EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_PHONE = re.compile(r"(?<!\w)(?:\+?234[\s().-]*)?\d(?:[\s().-]*\d){9,12}(?!\w)")
_IDENTIFIER = re.compile(
    r"\b(BVN|NIN|NUBAN|OTP|PIN|account(?: number)?)\b\s*(?:is|:|#)?\s*\d{4,19}\b",
    flags=re.IGNORECASE,
)
_LONG_NUMBER = re.compile(r"(?<!\d)\d{10,19}(?!\d)")


def redact_for_storage(text: str) -> str:
    value = _EMAIL.sub("[EMAIL REDACTED]", text)
    value = _IDENTIFIER.sub(lambda match: f"{match.group(1)} [REDACTED]", value)
    value = _PHONE.sub("[PHONE REDACTED]", value)
    return _LONG_NUMBER.sub("[NUMBER REDACTED]", value)
