import os
import uvicorn


def main():
    host = os.getenv("SYN_BACKEND_HOST", "127.0.0.1")
    port = int(os.getenv("SYN_BACKEND_PORT", "8000"))
    log_level = os.getenv("SYN_BACKEND_LOG", "warning")
    uvicorn.run("app.main:app", host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
