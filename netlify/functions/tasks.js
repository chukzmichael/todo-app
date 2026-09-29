// Netlify Function: the only place the GitHub token is used.
// GET  /api/tasks  -> returns the task list
// POST /api/tasks  -> { action: "add" | "toggle" | "delete" | "clear_done", ... }
//
// Environment variables (set in Netlify, never in the frontend):
//   GITHUB_TOKEN   fine-grained token with Contents: read & write on the data repo
//   GITHUB_OWNER   your GitHub username
//   GITHUB_REPO    the data repo name (kept separate from the site repo)
//   GITHUB_FILE    optional, defaults to tasks.json
//   GITHUB_BRANCH  optional, defaults to main
//   APP_PASSWORD   optional; if set, changes require this password (viewing stays public)

const crypto = require("crypto");

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const FILE = process.env.GITHUB_FILE || "tasks.json";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

const CONTENTS_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
const GH_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "netlify-todo-app",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

function passwordOk(supplied) {
  if (!APP_PASSWORD) return true;
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Read tasks.json. A missing file is treated as an empty list.
async function readTasks() {
  const res = await fetch(`${CONTENTS_URL}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: GH_HEADERS,
  });
  if (res.status === 404) return { tasks: [], sha: undefined };
  if (!res.ok) throw new HttpError(502, `GitHub read failed (${res.status}).`);
  const data = await res.json();
  let tasks = [];
  try {
    tasks = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  } catch (_) {
    tasks = [];
  }
  return { tasks: Array.isArray(tasks) ? tasks : [], sha: data.sha };
}

// Write tasks.json as a commit. Returns "ok" or "conflict" (stale sha).
async function writeTasks(tasks, sha, message) {
  const res = await fetch(CONTENTS_URL, {
    method: "PUT",
    headers: { ...GH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(tasks, null, 2) + "\n").toString("base64"),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.ok) return "ok";
  if (res.status === 409 || res.status === 422) return "conflict";
  throw new HttpError(502, `GitHub write failed (${res.status}).`);
}

// Apply one change to the list. Returns the new list and a commit message.
function applyAction(tasks, body) {
  switch (body.action) {
    case "add": {
      const text = String(body.text || "").trim().slice(0, 200);
      if (!text) throw new HttpError(400, "Task text is required.");
      const task = {
        id: crypto.randomUUID(),
        text,
        done: false,
        createdAt: new Date().toISOString(),
      };
      return { tasks: [...tasks, task], message: `Add task: ${text.slice(0, 60)}` };
    }
    case "toggle": {
      const found = tasks.find((t) => t.id === body.id);
      if (!found) throw new HttpError(404, "That task no longer exists.");
      return {
        tasks: tasks.map((t) => (t.id === body.id ? { ...t, done: !t.done } : t)),
        message: `${found.done ? "Reopen" : "Complete"} task: ${found.text.slice(0, 60)}`,
      };
    }
    case "delete": {
      const found = tasks.find((t) => t.id === body.id);
      if (!found) throw new HttpError(404, "That task no longer exists.");
      return {
        tasks: tasks.filter((t) => t.id !== body.id),
        message: `Delete task: ${found.text.slice(0, 60)}`,
      };
    }
    case "clear_done":
      return { tasks: tasks.filter((t) => !t.done), message: "Clear completed tasks" };
    default:
      throw new HttpError(400, "Unknown action.");
  }
}

exports.handler = async (event) => {
  if (!TOKEN || !OWNER || !REPO) {
    return json(500, {
      error: "The server is missing its GitHub settings. Set GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO in Netlify.",
    });
  }

  try {
    if (event.httpMethod === "GET") {
      const { tasks } = await readTasks();
      return json(200, { tasks, writeProtected: Boolean(APP_PASSWORD) });
    }

    if (event.httpMethod === "POST") {
      if (!passwordOk(event.headers["x-app-password"])) {
        return json(401, { error: "Wrong or missing password." });
      }

      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch (_) {
        throw new HttpError(400, "Request body must be valid JSON.");
      }

      // Read, change, write. If another change landed in between, GitHub rejects
      // the stale sha, so we re-read and try again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { tasks, sha } = await readTasks();
        const next = applyAction(tasks, body);
        const result = await writeTasks(next.tasks, sha, next.message);
        if (result === "ok") {
          return json(200, { tasks: next.tasks, writeProtected: Boolean(APP_PASSWORD) });
        }
      }
      throw new HttpError(409, "Someone else changed the list at the same time. Try again.");
    }

    return json(405, { error: "Method not allowed." });
  } catch (err) {
    return json(err.status || 500, { error: err.message || "Something went wrong." });
  }
};
