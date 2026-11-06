import json
import sys
from client import Client, ApiError

if __name__ == "__main__":
    try:
        client = Client()
        edition = client.request("editions/latest")
        print(json.dumps({"latest_edition": edition["data"]}))
        for page in client.search_pages({"states": ["TX"], "fleet": {"min": 1, "max": 10}}, max_pages=10, limit=20):
            # Write page['data'] to your authorized destination; do not log contact payloads.
            print(json.dumps({"rows": len(page["data"]), "source_updated_at": page.get("meta", {}).get("source_updated_at"), "more": bool(page.get("next_cursor") or page.get("meta", {}).get("next_cursor"))}))
    except ApiError as error:
        print(json.dumps({"code": error.code, "status": error.status, **error.details}), file=sys.stderr)
        sys.exit(1)
