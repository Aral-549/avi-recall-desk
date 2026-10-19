"""python -m extractor [--mock] [--port 8787]  (always binds 127.0.0.1)."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import uvicorn

from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="categoriser-extractor")
    parser.add_argument("--mock", action="store_true", help="serve fixtures/*.json, no network")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--fixtures", type=Path, default=Path(__file__).resolve().parent.parent / "fixtures")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    app = create_app(mock=args.mock, fixtures_dir=args.fixtures)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
