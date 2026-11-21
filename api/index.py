"""Vercel serverless entry point: serves the FastAPI backend under /api."""
import sys
from pathlib import Path

# Backend modules import each other by name, as when run from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend'))

from main import app as backend  # noqa: E402


async def app(scope, receive, send):
    # The frontend calls /api/<route>; the backend defines /<route>, as behind the Vite proxy.
    if scope['type'] in ('http', 'websocket'):
        path = scope['path']
        if path == '/api' or path.startswith('/api/'):
            scope = {**scope, 'path': path[4:] or '/', 'raw_path': (path[4:] or '/').encode()}
    await backend(scope, receive, send)
