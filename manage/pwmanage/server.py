"""python -m pwmanage.server: a long-running worker so requests reuse one database connection.

One JSON request per stdin line ({"id", ...request}), one JSON answer per stdout line ({"id", ...answer}).
{"op": "keep", "envs": [...]} closes every connection outside that list; stdin closing closes them all.
"""
import json
import sys

from . import service
from .audit import Audit
from .config import ENVS
from .pool import Pool

DEAD = ("InterfaceError", "BrokenPipe", "connection is closed", "ConnectionReset", "ConnectionAbort", "server closed")


def looks_dead(answer):
    text = str(answer.get("error", ""))
    return answer.get("kind") == "failed" and "28000" not in text and any(d in text for d in DEAD)


def make_handler(pool, audit_for=None):
    audits = {}

    def warm(name):
        if name not in ENVS:
            return {"ok": False, "kind": "refused", "error": f"unknown environment {name!r}"}
        try:
            pool.connect(ENVS[name]).close()
            audit_of(name)
            return {"ok": True, "open": pool.open_envs()}
        except Exception as error:
            if "28000" in str(error):
                return {"ok": False, "kind": "no_role", "error": f"The {name} database refused the login: the playwork_manage role is not set up there yet."}
            return {"ok": False, "kind": "failed", "error": f"{type(error).__name__}: {error}"}

    def audit_of(name):
        if name in ENVS and name not in audits:
            audits[name] = (audit_for or Audit)(ENVS[name])
        return audits.get(name)

    def handle(request):
        name = request.get("env")
        if request.get("op") == "warm":  # opened at unlock so the first real request does not pay for the connection
            return warm(name)
        answer = service.handle(request, connect=pool.connect, audit=audit_of(name))
        if looks_dead(answer):
            pool.drop(name)  # the socket died (idle timeout, network): the next request connects afresh
            if request.get("op") != "apply":  # a write is never replayed on a guess: its stale guards would refuse anyway
                answer = service.handle(request, connect=pool.connect, audit=audit_of(name))
        return answer
    return handle


def serve(lines, out, pool, handle=None):
    handle = handle or make_handler(pool)
    for line in lines:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            rid = request.pop("id", None)
            if request.get("op") == "keep":
                pool.keep([e for e in request.get("envs", []) if e in ENVS])
                answer = {"ok": True, "open": pool.open_envs()}
            else:
                answer = handle(request)
        except Exception as error:
            rid, answer = locals().get("rid"), {"ok": False, "kind": "failed", "error": f"{type(error).__name__}: {error}"}
        out.write(json.dumps({"id": rid, **answer}, default=str) + "\n")
        out.flush()
    pool.close_all()


def main():
    serve(sys.stdin, sys.stdout, Pool())


if __name__ == "__main__":
    main()
