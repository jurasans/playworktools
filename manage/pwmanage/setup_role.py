"""One-time setup of the tool's database role (needs the ADMIN connection, so run it by hand, per cluster).

    python -m pwmanage.setup_role stage --iam-arn arn:aws:iam::<acct>:role/<your role> [--dry-run] [--table-level]

Creates the role, maps your IAM identity to it, and grants the least the tool needs. Column-level UPDATE is
tried first; if the cluster refuses it the table-level grant is used and the tool's whitelist is the only
column guard (the role still cannot delete rows, change schema or touch users and devices).
"""
import argparse
import sys

from . import db
from .config import ROLE, env_for

# (what it is for, column-level form, table-level fallback or None)
GRANTS = (
    ("see the tables", None, f"GRANT SELECT ON licenses, sensors, customers, sensor_devices TO {ROLE}"),
    ("set a license tier", f"GRANT UPDATE (license_type) ON licenses TO {ROLE}", f"GRANT UPDATE ON licenses TO {ROLE}"),
    ("move a ball, clear its device, assign its customer",
     f"GRANT UPDATE (license_id, device_id, customer_id) ON sensors TO {ROLE}", f"GRANT UPDATE ON sensors TO {ROLE}"),
    ("create new balls (id, license, customer only)", f"GRANT INSERT (id, license_id, customer_id) ON sensors TO {ROLE}", f"GRANT INSERT ON sensors TO {ROLE}"),
    ("create and edit customers", None, f"GRANT INSERT, UPDATE ON customers TO {ROLE}"),
)


def statements(iam_arn: str, table_level: bool):
    if "'" in iam_arn or not iam_arn.startswith("arn:aws:iam::"):
        raise SystemExit("--iam-arn must be an IAM role or user ARN (arn:aws:iam::<account>:role/...)")
    yield "create the role", f"CREATE ROLE {ROLE} WITH LOGIN", None
    yield "map your IAM identity to it", f"AWS IAM GRANT {ROLE} TO '{iam_arn}'", None
    yield "let it use the schema", f"GRANT USAGE ON SCHEMA public TO {ROLE}", None
    for purpose, column_level, table in GRANTS:
        primary = table if (table_level or column_level is None) else column_level
        yield purpose, primary, None if primary == table else table


def run(conn, iam_arn: str, table_level: bool, dry_run: bool) -> int:
    """DSQL allows one DDL statement per transaction, so each is committed on its own."""
    for purpose, sql, fallback in statements(iam_arn, table_level):
        print(f"-- {purpose}\n{sql};")
        if dry_run:
            continue
        for attempt in (sql, fallback):
            if attempt is None:
                print(f"   FAILED: {purpose}", file=sys.stderr)
                return 1
            try:
                conn.cursor().execute(attempt)
                conn.commit()
                print("   ok" if attempt == sql else f"   ok (fallback: {attempt})")
                break
            except Exception as error:
                conn.rollback()
                if "already exists" in str(error):
                    print("   already there")
                    break
                if "system entity" in str(error):  # DSQL refuses schema grants on public and allows it anyway
                    print("   skipped: DSQL does not grant on the public schema")
                    break
                print(f"   refused: {error}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("env", choices=["stage", "prod"])
    parser.add_argument("--iam-arn", required=True)
    parser.add_argument("--dry-run", action="store_true", help="print the statements, run nothing")
    parser.add_argument("--table-level", action="store_true", help="skip the column-level attempt")
    args = parser.parse_args(argv)
    conn = None if args.dry_run else db.connect(env_for(args.env), admin=True)
    try:
        return run(conn, args.iam_arn, args.table_level, args.dry_run)
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
