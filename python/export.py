import argparse
import json
import sys
from client import Client, ApiError

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Request one explicitly reviewed CSV selection; never automatically retry.")
    parser.add_argument("--selection", required=True, help="Path to the reviewed JSON selection")
    parser.add_argument("--idempotency-key", required=True, help="Saved logical request key; reuse with the SAME selection only")
    parser.add_argument("--confirm", action="store_true", required=True, help="Confirm requesting this exact selection")
    args = parser.parse_args()
    try:
        with open(args.selection, encoding="utf-8") as file:
            selection = json.load(file)
        if selection.get("scope") not in ("catalog", "edition", "list", "renewals"):
            raise ApiError("invalid_export_scope")
        queued = Client().request("exports", method="POST", data=selection, idempotency_key=args.idempotency_key)
        print(json.dumps({"export_id": queued["data"]["id"], "state": queued["data"]["state"]}))
        # Save this ID. Poll GET exports/{id}; use javascript/download.mjs after state is ready.
    except ApiError as error:
        print(json.dumps({"code": error.code, "status": error.status, **error.details}), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({"code": "invalid_selection_or_response"}), file=sys.stderr)
        sys.exit(1)
