# Run Wajhah locally on macOS

## What you need

- Python 3.12 and Node.js 24 with npm.
- Internet access to install dependencies and use Gemini.
- Your own Gemini API key for complaint analysis.
- Local ports 8000 and 5173 available.

## 1. Open the extracted folder

Double-click `Wajhah-Local-Run.zip` in Finder. Open Terminal, type `cd` followed by a space, drag the extracted `Wajhah-Local-Run` folder into the Terminal window, then press Return. This folder contains `backend` and `frontend`.

## 2. Set up and start the backend

From the project folder, run:

```sh
cd backend && \
  python3.12 -m venv .venv && \
  .venv/bin/python -m pip install -r requirements.lock && \
  { test -f .env || cp .env.example .env; } && \
  open -e .env
```

In the file that opens, paste your key after `GEMINI_API_KEY=`. Save with **Command-S**. Keep `backend/.env` private.

Back in the same Terminal window, run:

```sh
.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

When Terminal shows `Uvicorn running`, leave that window open.

## 3. Start the frontend in a second Terminal

Open a new Terminal window with **Command-N**. Type `cd` followed by a space, drag the same extracted `Wajhah-Local-Run` folder into this window, then press Return. Run:

```sh
cd frontend && npm ci --include=dev --include=optional && npm run dev
```

When Vite shows the local URL, open [Wajhah](http://127.0.0.1:5173/) in your browser. Keep both Terminal windows open.

## 4. Stop or restart

Press **Control-C** in each Terminal window to stop its server. On later runs, start Uvicorn from `backend` and run `npm run dev` from `frontend`. Restart Uvicorn after changing your API key.

Windows uses a different Python launcher and virtual environment path. These commands are for macOS.
