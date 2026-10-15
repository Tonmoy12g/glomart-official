"""Pathao Courier integration — PREPARED ONLY.

Status: NOT active, NOT tested, and NOT wired into the order flow.
Orders are currently cash-on-delivery with manual courier booking.

When you are ready to integrate Pathao for real:
  1. Get API credentials from the Pathao merchant panel.
  2. Set PATHAO_CLIENT_ID, PATHAO_CLIENT_SECRET and PATHAO_BASE_URL
     as environment variables on your server (never in frontend code).
  3. Implement the functions below against the Pathao API, test them with
     POST /api/admin/pathao/test, and only then wire them into the order flow.

Until then every function returns {"active": False, ...}.
"""

import os


def _config():
    """Read Pathao credentials from environment variables only."""
    return {
        "client_id": os.environ.get("PATHAO_CLIENT_ID"),
        "client_secret": os.environ.get("PATHAO_CLIENT_SECRET"),
        "base_url": os.environ.get("PATHAO_BASE_URL", "https://api-hermes.pathao.com"),
    }


NOT_ACTIVE = {
    "active": False,
    "message": "Pathao integration is prepared but NOT active/tested.",
}


def create_consignment(order):
    """Create a Pathao consignment for an order. Not implemented yet."""
    _ = _config()  # credentials stay server-side; never sent to the frontend
    return dict(NOT_ACTIVE)


def track(consignment_id):
    """Track a Pathao consignment. Not implemented yet."""
    _ = _config()
    _ = consignment_id
    return dict(NOT_ACTIVE)


def get_price(*args, **kwargs):
    """Get a Pathao delivery price quote. Not implemented yet."""
    _ = _config()
    return dict(NOT_ACTIVE)
