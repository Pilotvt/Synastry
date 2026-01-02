import os
import uvicorn


def main():
    host = os.getenv("SYN_BACKEND_HOST", "127.0.0.1")
    port = int(os.getenv("SYN_BACKEND_PORT", "8000"))
    log_level = os.getenv("SYN_BACKEND_LOG", "warning")
    # Use pure-Python protocol implementations by default for stability on diverse Windows machines.
    # Can override via env (e.g. SYN_BACKEND_HTTP=httptools).
    http_impl = os.getenv("SYN_BACKEND_HTTP", "h11")
    ws_impl = os.getenv("SYN_BACKEND_WS", "websockets")
    loop_impl = os.getenv("SYN_BACKEND_LOOP", "asyncio")
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        log_level=log_level,
        http=http_impl,
        ws=ws_impl,
        loop=loop_impl,
    )


if __name__ == "__main__":
    main()
