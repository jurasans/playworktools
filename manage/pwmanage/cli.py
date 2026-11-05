"""python -m pwmanage.cli: a JSON request on stdin, a JSON answer on stdout. No arguments, no shell."""
import json
import sys

from .service import handle


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
    except ValueError as error:
        print(json.dumps({"ok": False, "kind": "refused", "error": f"bad request: {error}"}))
        return 0
    print(json.dumps(handle(request), default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
