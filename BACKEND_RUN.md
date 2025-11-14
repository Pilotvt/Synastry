# How to run the backend server

To start the FastAPI backend, always run from the project root directory (`Synastry`) using the following command:

```pwsh
python -m app.main
```

This ensures all imports work correctly and modules like `iau_constellations` are found.

If you run `python app/main.py` directly, you may get import errors.

# Development (recommended)
Run this command from the project root (`Synastry`):

```pwsh
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

- This starts the FastAPI server on port 8000, which the frontend expects.
- The `--reload` flag auto-restarts the server on code changes.
- Make sure you have Uvicorn installed:

```pwsh
pip install uvicorn
```

# Troubleshooting
- If you see `ModuleNotFoundError: No module named 'app'` or `'iau_constellations'`, check your working directory and use the command above.
- Make sure all dependencies are installed (see `requirements.txt`).
- If you see "Failed to fetch" in the frontend, make sure the backend is running on port 8000.
- CORS is already set to allow all origins for development.
- If you see import errors, always run from the project root.

# API endpoint
- The main endpoint is `/api/chart` (POST)
- Example request: see frontend or API docs

# Development tips
- For code changes, restart the backend server to apply updates.
- Use the validation script (`scripts/validate_nodes.py`) to check node calculation accuracy.
