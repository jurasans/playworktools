"""One request in, one JSON answer out: the only entry point the spec-web tab uses (via cli.py)."""
import getpass
import socket
import uuid

from . import actions, db, search
from .audit import Audit
from .config import ENVS, MAX_ROWS, TIERS, env_for
from .search import UserError

READ_OPS = ("search_sensors", "list_licenses", "search_customers", "customer_schema")
ALL_OPS = READ_OPS + ("preview", "apply", "info")
RETRIES = 3


def _who(request):
    return {"user": str(request.get("actor") or "unknown"), "host_user": getpass.getuser(), "host": socket.gethostname()}


def _read(conn, op, request):
    if op == "search_sensors":
        return search.search_sensors(conn, request.get("query", ""), request.get("field", "any"),
                                    request.get("limit"), request.get("offset"),
                                    request.get("sort"), request.get("dir"))
    if op == "list_licenses":
        return search.list_licenses(conn)
    if op == "search_customers":
        return search.search_customers(conn, request.get("query", ""), request.get("limit"), request.get("offset"),
                                       request.get("sort"), request.get("dir"))
    if op == "customer_schema":
        return {"columns": [{"name": n, "type": t} for n, t in search.customer_schema(conn)]}
    schema = search.customer_schema(conn)
    return {"lines": actions.describe(conn, request.get("actions"), schema)}


def _write(env, connect, request, audit, request_id):
    """Audit first (a write that cannot be logged is refused), then one transaction, retried on conflicts."""
    acts = request.get("actions")
    audit.write({"request": request_id, "op": "apply", "stage": "intent", "who": _who(request), "actions": acts})
    last = None
    for _ in range(RETRIES):
        conn = connect(env)
        try:
            schema = search.customer_schema(conn)
            done = actions.apply(conn, acts, schema)
            conn.commit()
            return done
        except Exception as error:
            conn.rollback()
            last = error
            if not db.is_conflict(error):
                raise
        finally:
            conn.close()
    raise last


def handle(request, connect=db.connect, audit=None):
    """Never raises: refusals and failures come back as {ok: false, error, kind}."""
    request_id = uuid.uuid4().hex
    try:
        op = request.get("op")
        if op not in ALL_OPS:
            raise UserError(f"unknown operation {op!r}")
        try:
            env = env_for(request.get("env"))
        except ValueError as error:
            raise UserError(str(error))
        if op == "info":
            return {"ok": True, "tiers": TIERS, "max_rows": MAX_ROWS,
                    "envs": {n: {"label": e.label, "host": e.host} for n, e in ENVS.items()}}
        audit = audit or Audit(env)
        if op == "apply":
            done = _write(env, connect, request, audit, request_id)
            result = {"ok": True, "applied": len(done), "request": request_id}
            # The commit already happened: a logging failure now is reported, never turned into a failure.
            warning = _log(audit, request, request_id, {"stage": "done", "applied": len(done)})
            return {**result, "audit_warning": warning} if warning else result
        conn = connect(env)
        try:
            result = _read(conn, op, request)
        finally:
            conn.close()
        _log(audit, request, request_id, {"op": op, "query": request.get("query"), "field": request.get("field")})
        return {"ok": True, **result}
    except actions.Stale as error:
        _log_failure(audit, request, request_id, error)
        return {"ok": False, "kind": "stale", "error": str(error)}
    except UserError as error:
        return {"ok": False, "kind": "refused", "error": str(error)}
    except Exception as error:
        if "28000" in str(error):  # the DB role is not mapped to this IAM identity: setup_role was not run there
            env_name = request.get("env")
            return {"ok": False, "kind": "no_role", "error": f"The {env_name} database refused the login: the playwork_manage role is not set up there yet. Run: python -m pwmanage.setup_role {env_name} --iam-arn <arn>"}
        _log_failure(audit, request, request_id, error)
        return {"ok": False, "kind": "failed", "error": f"{type(error).__name__}: {error}"}


def _log(audit, request, request_id, extra):
    """Best-effort line after the work is done; returns a warning text instead of raising."""
    try:
        audit.write({"request": request_id, "op": request.get("op"), "who": _who(request), **extra})
    except Exception as error:
        return f"audit line not written: {type(error).__name__}"
    return None


def _log_failure(audit, request, request_id, error):
    if audit is None:
        return
    try:
        audit.write({"request": request_id, "op": request.get("op"), "stage": "failed",
                     "who": _who(request), "error": f"{type(error).__name__}: {error}"})
    except Exception:
        pass
