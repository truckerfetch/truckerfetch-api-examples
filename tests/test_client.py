import io
import json
import pathlib
import sys
import unittest
import urllib.error
import urllib.response
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))
from client import Client, ApiError
from webhook import verify_webhook
KEY = "tf_" + "a" * 43

class Response(io.BytesIO):
    def __init__(self, value, status=200, headers=None):
        super().__init__(value if isinstance(value, bytes) else json.dumps(value).encode())
        self.code, self.headers = status, headers or {}

class Opener:
    def __init__(self, responses): self.responses, self.requests = iter(responses), []
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return next(self.responses)

class ClientTests(unittest.TestCase):
    def test_cursor_and_filter_stability(self):
        opener = Opener([Response({"data": [], "next_cursor": "opaque", "meta": {}}), Response({"data": [], "meta": {}})])
        client = Client(KEY, opener=opener)
        self.assertEqual(len(list(client.search_pages({"states": ["TX"]}, max_pages=2, limit=10))), 2)
        self.assertEqual(json.loads(opener.requests[1][0].data), {"filters": {"states": ["TX"]}, "limit": 10, "cursor": "opaque"})
        self.assertEqual(opener.requests[0][1], 30)

    def test_targets_and_credentials(self):
        for origin in ["https://attacker.test", "https://u:p@truckerfetch.com", "http://truckerfetch.com", "https://truckerfetch.com/path", "http://127.0.0.1:1"]:
            with self.assertRaises(ApiError): Client(KEY, base_url=origin)
        with self.assertRaisesRegex(ApiError, "unsupported_operation"): Client(KEY).request("../keys")
        with self.assertRaisesRegex(ApiError, "configure_rest_api_key"): Client("tfm_" + "a" * 43).request("editions/latest")

    def test_no_mutation_retries_or_message_echo(self):
        opener = Opener([Response({"error": {"code": "rate_limited", "message": KEY}}, 429, {"Retry-After": "60"})])
        with self.assertRaises(ApiError) as caught:
            Client(KEY, opener=opener).request("exports", method="POST", data={"scope": "catalog"}, idempotency_key="saved-key-1")
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(caught.exception.details["retry_after"], 60)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(opener.requests[0][0].get_header("Idempotency-key"), "saved-key-1")

    def test_redirect_and_size_limits(self):
        with self.assertRaisesRegex(ApiError, "redirect_rejected"): Client(KEY, opener=Opener([Response(b"", 302)])).request("editions/latest")
        with self.assertRaisesRegex(ApiError, "response_too_large"): Client(KEY, opener=Opener([Response(b"x" * 262145)])).request("editions/latest")
        with self.assertRaisesRegex(ApiError, "saved_idempotency_key_required"): Client(KEY).request("exports", method="POST", data={"scope": "catalog"})

    def test_confirmation_url_is_same_origin_and_exact_path(self):
        identifier = "73cb9f39-5454-4dcb-bc4e-095efc9d0694"
        for url, allowed in [("https://truckerfetch.com/developer/confirm/" + identifier, True), ("https://attacker.test/" + identifier, False)]:
            response = Response({"error": {"code": "confirmation_required"}, "confirmation_url": url}, 409)
            with self.assertRaises(ApiError) as caught:
                Client(KEY, opener=Opener([response])).request("editions/" + identifier + "/access", method="POST", data={"confirm_edition_date_et": "2026-11-01"}, idempotency_key="saved-key-2")
            self.assertEqual("confirmation_url" in caught.exception.details, allowed)

    def test_webhook_vector_and_tamper_rejection(self):
        vector = json.loads((pathlib.Path(__file__).parent / "webhook-vector.json").read_text())
        headers = {"TruckerFetch-Event-Id": vector["event_id"], "TruckerFetch-Key-Id": vector["key_id"], "TruckerFetch-Timestamp": vector["timestamp"], "TruckerFetch-Signature": vector["signature"]}
        raw = vector["raw_body"].encode()
        self.assertEqual(verify_webhook(headers, raw, vector["key_id"], vector["secret"], int(vector["timestamp"]))["type"], "edition.published")
        self.assertIsNone(verify_webhook(headers, raw + b" ", vector["key_id"], vector["secret"], int(vector["timestamp"])))
        self.assertIsNone(verify_webhook(headers, raw, vector["key_id"], vector["secret"], int(vector["timestamp"]) + 301))

if __name__ == "__main__": unittest.main()
