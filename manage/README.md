# Manage (S-19)

A thin admin tool for the license database: browse balls (sensors) and customers, and change a closed list of values. It runs as Python scripts on this PC, reached from spec-web at `/manage` (admin login plus a second password). No Lambda, no API Gateway, no stack changes.

## Pieces

- `pwmanage/` Python: `search.py` (reads), `actions.py` (the whitelisted writes), `service.py` (one request in, one answer out, audit), `audit.py` (CloudWatch Logs), `setup_role.py` (one-time DB role), `cli.py` (JSON on stdin, JSON on stdout).
- `web/routes.mjs` + `web/page.html`: the page and its API inside spec-web. `web/run-python.mjs` starts the scripts.
- `tests/`: `pytest` (fake connection) and `web/routes.test.mjs` (`node --test`). `tests/stage_integration.py` is a manual run against **stage only**.

## Setup

```bash
python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m pwmanage.setup_role stage --iam-arn <your IAM user or role ARN>   # needs dsql:DbConnectAdmin
```

`setup_role` creates the DB role `playwork_manage` (SELECT on licenses, sensors, customers; UPDATE only on `licenses.license_type` and `sensors.license_id/device_id/customer_id`; INSERT, UPDATE on customers; nothing else, no DELETE, no users/devices). Use `prod` only when you mean it. Cluster ids can be overridden with `MANAGE_STAGE_CLUSTER` / `MANAGE_PROD_CLUSTER`.

spec-web needs `MANAGE_PASSWORD`. When spec-web runs in Docker it also needs `HOST_RUNNER_TOKEN` (24+ characters, the same value the host-runner is started with), because the scripts need Python and your AWS credentials, which only the host has:

```bash
HOST_RUNNER_TOKEN=<long random value> npm run spec:host-runner
```

Without Docker (`node tools/spec-web/server.mjs`) spec-web starts the scripts itself.

## Behaviour

- Passwords: unlock per browser session and per environment, 15 minutes idle, 5 wrong tries lock out for 15 minutes. Switching environment locks again.
- Search: partial MAC from anywhere (case, `:` and `-` ignored), sorted, at most 200 rows, 2+ characters (empty lists all). Customers by id and `invoice_no`.
- Connection: one worker process keeps one DB connection per unlocked environment and closes it when the page locks, switches environment or goes idle.
- Create new balls: the page's dialog adds balls (MAC id, license, optional customer; a comma list fills rows) in one transaction, 200 at most. Needs `INSERT (id, license_id, customer_id)` on sensors, which `setup_role` grants.
- Writes: move a ball to another license, clear a ball's device, set a ball's customer, create/edit customers (not `id`). A preview is required before an apply, every change carries the value the person saw (stale rows are refused), and a batch is all-or-nothing.
- Audit: CloudWatch Logs `/playwork/manage/<env>`, one stream per day, 365 days. A write is logged before it runs and refused if it cannot be logged.
- Prod shows a flashing red page with warnings; stage is green. Prod's Yes button waits 2 seconds.
