"""Command-line entry point: ``python -m lagbuster``."""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import sys

from . import __version__
from .platform_utils import app_data_dir


def setup_logging(verbose: bool = False) -> None:
    handlers: list[logging.Handler] = []
    try:
        handlers.append(
            logging.handlers.RotatingFileHandler(
                app_data_dir() / "lagbuster.log", maxBytes=512_000, backupCount=1, encoding="utf-8"
            )
        )
    except OSError:
        pass
    if verbose and sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers or [logging.NullHandler()],
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="lagbuster",
        description="LagBuster - see what slows your games down and choose what to fix.",
    )
    parser.add_argument("--demo", action="store_true", help="try the app with simulated data (nothing is changed)")
    parser.add_argument(
        "--selftest", action="store_true", help="check which system features work on this PC, print a report and exit"
    )
    parser.add_argument("--report", metavar="FILE", help="with --selftest: also save the report as JSON")
    parser.add_argument("--verbose", action="store_true", help="log more details (also to the console)")
    parser.add_argument("--version", action="version", version=f"LagBuster {__version__}")
    parser.add_argument("--close-after", type=float, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--scan", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    setup_logging(args.verbose)
    if args.selftest:
        from .selftest import run_selftest

        return run_selftest(args.report)
    from .ui.app import run_app

    return run_app(demo=args.demo, auto_close_after=args.close_after, scan_on_start=args.scan)


if __name__ == "__main__":
    sys.exit(main())
