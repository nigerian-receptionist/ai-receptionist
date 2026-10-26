"""Small, deterministic text normalization rules for Nigerian speech output."""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal, InvalidOperation

_ONES = (
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
)
_TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
_SCALES = ((1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand"))
_MONTHS = {
    "jan": "January",
    "january": "January",
    "feb": "February",
    "february": "February",
    "mar": "March",
    "march": "March",
    "apr": "April",
    "april": "April",
    "may": "May",
    "jun": "June",
    "june": "June",
    "jul": "July",
    "july": "July",
    "aug": "August",
    "august": "August",
    "sep": "September",
    "sept": "September",
    "september": "September",
    "oct": "October",
    "october": "October",
    "nov": "November",
    "november": "November",
    "dec": "December",
    "december": "December",
}
_ORDINALS = {
    1: "first",
    2: "second",
    3: "third",
    5: "fifth",
    8: "eighth",
    9: "ninth",
    12: "twelfth",
    15: "fifteenth",
    18: "eighteenth",
}
_ACRONYMS = {"BVN": "B V N", "NIN": "N I N", "POS": "P O S", "NUBAN": "N U B A N"}
_DIGITS = "zero one two three four five six seven eight nine".split()


def _under_thousand(value: int) -> str:
    words: list[str] = []
    if value >= 100:
        words.extend((_ONES[value // 100], "hundred"))
        value %= 100
    if value >= 20:
        tens = _TENS[value // 10]
        words.append(tens if value % 10 == 0 else f"{tens}-{_ONES[value % 10]}")
    elif value:
        words.append(_ONES[value])
    return " ".join(words)


def number_to_words(value: int) -> str:
    """Spell a non-negative integer through the billions scale."""
    if value < 0 or value > 999_999_999_999:
        raise ValueError("value must be between 0 and 999,999,999,999")
    if value == 0:
        return "zero"
    parts: list[str] = []
    remainder = value
    for scale, name in _SCALES:
        count, remainder = divmod(remainder, scale)
        if count:
            parts.extend((_under_thousand(count), name))
    if remainder:
        parts.append(_under_thousand(remainder))
    return " ".join(parts)


def _ordinal(value: int) -> str:
    if value in _ORDINALS:
        return _ORDINALS[value]
    if value > 20 and value % 10:
        return f"{number_to_words(value - value % 10)}-{_ordinal(value % 10)}"
    cardinal = number_to_words(value)
    if cardinal.endswith("y"):
        return f"{cardinal[:-1]}ieth"
    if cardinal.endswith("e"):
        return f"{cardinal[:-1]}th"
    return f"{cardinal}th"


def _money(match: re.Match[str]) -> str:
    amount = match.group("amount").replace(",", "").replace(" ", "")
    suffix = "bn" if amount.lower().endswith("bn") else amount[-1:].lower()
    multiplier = {"m": 1_000_000, "b": 1_000_000_000, "bn": 1_000_000_000}.get(suffix, 1)
    if suffix in {"m", "b", "bn"}:
        amount = amount[: -len(suffix)]
    try:
        numeric = Decimal(amount) * multiplier
    except InvalidOperation:
        return match.group(0)
    if numeric != numeric.to_integral_value() or numeric > 999_999_999_999:
        return match.group(0)
    amount_words = number_to_words(int(numeric))
    if suffix in {"m", "b", "bn"} and "." in amount:
        major = amount.split(".", maxsplit=1)[0]
        fractional = amount.split(".", maxsplit=1)[1].rstrip("0")
        scale = "million" if suffix == "m" else "billion"
        if fractional:
            digits = " ".join(_DIGITS[int(digit)] for digit in fractional)
            amount_words = f"{number_to_words(int(major))} point {digits} {scale}"
    return f"{amount_words} naira"


def _phone(match: re.Match[str]) -> str:
    digits = re.sub(r"\D", "", match.group(0))
    if digits.startswith("234") and len(digits) == 13:
        digits = "0" + digits[3:]
    elif len(digits) == 11 and digits.startswith("0"):
        pass
    else:
        return match.group(0)
    # Preserve the conventional 4-3-4 grouping, with the Nigerian prefix as four.
    return ", ".join(
        " ".join(_DIGITS[int(digit)] for digit in group)
        for group in (digits[:4], digits[4:7], digits[7:])
    )


def _date(match: re.Match[str]) -> str:
    day = int(match.group("day"))
    month = _MONTHS.get(match.group("month").lower()[:3])
    if month is None or not 1 <= day <= 31:
        return match.group(0)
    return f"the {_ordinal(day)} of {month}"


def _numeric_date(match: re.Match[str]) -> str:
    month_number = int(match.group("month_number"))
    month_names = tuple(dict.fromkeys(_MONTHS.values()))
    day = int(match.group("day"))
    if not 1 <= month_number <= 12 or not 1 <= day <= 31:
        return match.group(0)
    return f"the {_ordinal(day)} of {month_names[month_number - 1]}"


def _time(match: re.Match[str]) -> str:
    raw = match.group("time")
    meridiem = match.groupdict().get("meridiem")
    hour_text, minute_text = (
        raw.lower().replace(".", ":").split(":") if ":" in raw or "." in raw else (raw[:2], raw[2:])
    )
    hour, minute = int(hour_text), int(minute_text or "0")
    if hour > 23 or minute > 59:
        return match.group(0)
    if meridiem:
        period = "morning" if meridiem.lower().startswith("a") else "afternoon"
        hour = hour % 12 or 12
        if minute == 0:
            phrase = "o'clock"
        elif minute == 30:
            phrase = "half past"
        else:
            phrase = number_to_words(minute)
        return f"{phrase} {number_to_words(hour)} in the {period}"
    if hour == 0:
        hour_words = "midnight"
    elif hour == 12:
        hour_words = "noon"
    else:
        period = "a m" if hour < 12 else "p m"
        display_hour = hour % 12 or 12
        hour_words = f"{number_to_words(display_hour)} {period}"
    if minute == 0:
        return hour_words
    if hour in {0, 12}:
        return f"{hour_words} {number_to_words(minute)}"
    return f"{number_to_words(display_hour)} {number_to_words(minute)} {period}"


def normalize_for_speech(text: str) -> str:
    """Normalize common Nigerian text while preserving non-English diacritics."""
    value = unicodedata.normalize("NFC", text)
    # Remove links and email addresses rather than speaking identifiers aloud.
    value = re.sub(r"\b(?:https?://|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", " ", value)
    value = re.sub(r"(?:\*\*|__|~~|`|\*|_|#+|>+|[-+•])", " ", value)
    value = re.sub(r"[\U00010000-\U0010ffff]", " ", value)

    value = re.sub(
        r"(?i)(?:₦|NGN\s*|(?<![A-Za-z])N\s*)(?P<amount>\d[\d,]*(?:\.\d+)?\s*(?:bn|m|b)?)",
        _money,
        value,
    )
    value = re.sub(
        r"(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<month>Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b",
        _date,
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"(?P<month>Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?\b",
        _date,
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"\b(?P<day>\d{1,2})/(?P<month_number>\d{1,2})\b", _numeric_date, value)
    value = re.sub(
        r"\b(?P<time>(?:[01]?\d|2[0-3])[:.][0-5]\d|(?:0?[1-9]|1[0-2])(?:[.:][0-5]\d)?)(?P<meridiem>\s*[ap]\.?m\.?)\b",
        _time,
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"\b(?P<time>(?:[01]?\d|2[0-3]):[0-5]\d)\b", _time, value)
    value = re.sub(
        r"(?<!\w)(?:\+?234[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{4}|0\d{3}[\s().-]*\d{3}[\s().-]*\d{4})(?!\w)",
        _phone,
        value,
    )

    for acronym, spoken in _ACRONYMS.items():
        value = re.sub(rf"\b{acronym}\b", spoken, value, flags=re.IGNORECASE)
    value = re.sub(
        r"\bending in\s+(\d{4})\b",
        lambda match: "ending in " + ", ".join(_DIGITS[int(digit)] for digit in match.group(1)),
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"\s+([,.;!?])", r"\1", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()
