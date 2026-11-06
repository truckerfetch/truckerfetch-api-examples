"""Verify exact raw bytes before parsing. The receiver still needs schema checks and durable deduplication."""
import base64
import hashlib
import hmac
import json
import re
import time

def verify_webhook(headers, raw_body, expected_key_id, secret, now_seconds=None):
    # Accept case-insensitive HTTP header mappings such as HTTPMessage.
    values = {key.lower(): value for key, value in headers.items()}
    event_id = values.get("truckerfetch-event-id", "")
    timestamp = values.get("truckerfetch-timestamp", "")
    signature = values.get("truckerfetch-signature", "")
    if not event_id or values.get("truckerfetch-key-id") != expected_key_id or not re.fullmatch(r"\d+", timestamp) or not re.fullmatch(r"v1=[a-f0-9]{64}", signature):
        return None
    if abs((time.time() if now_seconds is None else now_seconds) - int(timestamp)) > 300 or not re.fullmatch(r"[A-Za-z0-9_-]{43}", secret):
        return None
    key = base64.urlsafe_b64decode(secret + "=")
    if len(key) != 32:
        return None
    expected = hmac.new(key, (event_id + "." + timestamp + ".").encode() + raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature[3:]):
        return None
    try:
        event = json.loads(raw_body)
        return event if isinstance(event, dict) and event.get("id") == event_id and isinstance(event.get("type"), str) else None
    except (ValueError, UnicodeError):
        return None
