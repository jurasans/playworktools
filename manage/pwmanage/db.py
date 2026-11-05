"""Connections to the Aurora DSQL cluster: as the narrow tool role, or as admin for the one-time setup."""
import boto3
import pg8000

from .config import REGION, ROLE, Env

TOKEN_SECONDS = 60


def connect(env: Env, admin: bool = False):
    """pg8000 connection with an IAM token. The tool role is the default; admin is for setup only."""
    client = boto3.client("dsql", region_name=REGION)
    if admin:
        token = client.generate_db_connect_admin_auth_token(env.host, REGION, TOKEN_SECONDS)
    else:
        token = client.generate_db_connect_auth_token(env.host, REGION, TOKEN_SECONDS)
    return pg8000.connect(
        host=env.host, port=5432, database="postgres",
        user="admin" if admin else ROLE, password=token, ssl_context=True,
    )


def is_conflict(error: Exception) -> bool:
    """DSQL optimistic concurrency conflict (SQLSTATE 40001 / OC000): the whole transaction may be retried."""
    text = str(error)
    return "40001" in text or "OC000" in text or "OC001" in text
