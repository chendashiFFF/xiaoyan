"""Start the studio: studio/.venv/bin/python -m studio.server [--port 5180]"""
import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5180)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    print(f"Sprite Studio → http://{args.host}:{args.port}")
    uvicorn.run("studio.server.app:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
