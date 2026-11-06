"""Dependency-free, bounded TruckerFetch REST examples. No automatic retries."""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

UUID = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"
ROUTES = {
    "GET": [r"(?:account|usage|editions(?:/latest)?|changes)", r"editions/" + UUID,
            r"carriers/[0-9]{1,16}(?:/(?:authorities|insurance-filings))?",
            r"exports/" + UUID + r"(?:/download|/parts/(?:0|[1-9][0-9]{0,5}))?"],
    "POST": [r"(?:carriers/search|renewals/search|exports)", r"editions/" + UUID + r"/(?:search|access)"],
}

class ApiError(Exception):
    def __init__(self, code, status=None, details=None):
        super().__init__(code)
        self.code, self.status, self.details = code, status, details or {}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class Client:
    def __init__(self, api_key=None, base_url=None, allow_localhost=False, opener=None):
        self.key = api_key or os.environ.get("TRUCKERFETCH_API_KEY", "")
        self.origin = base_url or os.environ.get("TRUCKERFETCH_BASE_URL", "https://truckerfetch.com")
        try:
            url = urllib.parse.urlsplit(self.origin)
            local = allow_localhost and url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
            official = url.scheme == "https" and url.hostname in ("truckerfetch.com", "www.truckerfetch.com") and url.port in (None, 443)
            if url.username or url.password or url.query or url.fragment or url.path not in ("", "/") or not (local or official):
                raise ValueError()
        except ValueError:
            raise ApiError("untrusted_origin") from None
        self.origin = self.origin.rstrip("/")
        self.opener = opener or urllib.request.build_opener(NoRedirect)

    def request(self, path, method="GET", data=None, query=None, idempotency_key=None, raw=False):
        if not any(re.fullmatch(pattern, path, flags=re.I) for pattern in ROUTES.get(method, [])):
            raise ApiError("unsupported_operation")
        if not re.fullmatch(r"tf_[A-Za-z0-9_-]{40,60}", self.key):
            raise ApiError("configure_rest_api_key")
        if method == "POST" and (path == "exports" or path.endswith("/access")) and not re.fullmatch(r"[-._:a-zA-Z0-9]{8,128}", idempotency_key or ""):
            raise ApiError("saved_idempotency_key_required")
        url = self.origin + "/api/v1/" + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        headers = {"Authorization": "Bearer " + self.key, "Accept": "application/octet-stream" if raw else "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        try:
            response = self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, OSError, ValueError):
            raise ApiError("network_error") from None
        with response:
            status = response.code
            if 300 <= status < 400:
                raise ApiError("redirect_rejected", status)
            maximum = 2 * 1024 * 1024 if raw and 200 <= status < 300 else 262144
            try:
                content = response.read(maximum + 1)
            except (OSError, ValueError):
                raise ApiError("network_error") from None
            if len(content) > maximum:
                raise ApiError("response_too_large", status)
            if raw and 200 <= status < 300:
                return content
            try:
                value = json.loads(content)
            except (ValueError, UnicodeError):
                raise ApiError("invalid_json", status) from None
            if not 200 <= status < 300:
                error = value.get("error") if isinstance(value, dict) else None
                code = error.get("code", "request_failed") if isinstance(error, dict) else "request_failed"
                if not isinstance(code, str) or self.key in code or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code):
                    code = "request_failed"
                details = {}
                retry = response.headers.get("Retry-After", "")
                if re.fullmatch(r"\d{1,6}", retry):
                    details["retry_after"] = int(retry)
                request_id = response.headers.get("X-Request-Id", "")
                if re.fullmatch(r"[a-zA-Z0-9-]{1,80}", request_id):
                    details["request_id"] = request_id
                review = value.get("confirmation_url", "") if isinstance(value, dict) else ""
                if isinstance(review, str) and review.startswith(self.origin + "/developer/confirm/") and re.fullmatch(UUID, review[len(self.origin + "/developer/confirm/"):], flags=re.I):
                    details["confirmation_url"] = review
                raise ApiError(code, status, details)
            return value

    def search_pages(self, filters, max_pages=10, limit=50):
        if type(max_pages) is not int or not 1 <= max_pages <= 100 or type(limit) is not int or not 1 <= limit <= 100:
            raise ApiError("invalid_page_bound")
        cursor, seen = None, set()
        for _ in range(max_pages):
            data = {"filters": filters, "limit": limit}
            if cursor:
                data["cursor"] = cursor
            page = self.request("carriers/search", method="POST", data=data)
            if not isinstance(page, dict) or not isinstance(page.get("data"), list):
                raise ApiError("invalid_search_response")
            yield page
            cursor = page.get("next_cursor") or page.get("meta", {}).get("next_cursor")
            if not cursor:
                return
            if cursor in seen:
                raise ApiError("repeated_cursor")
            seen.add(cursor)
        raise ApiError("page_bound_reached")
