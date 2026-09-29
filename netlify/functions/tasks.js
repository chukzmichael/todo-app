// Netlify Function: the only place the GitHub token is used.
// GET  /api/tasks  -> { tasks, writeProtected }
// POST /api/tasks  -> { action: "add" | "toggle" | "delete" | "clear_done", ... }
//
// Task shape: { id, title, description, date, time, done, createdAt }
//   date is "YYYY-MM-DD" or "", time is "HH:MM" (24h) or "".
//
// Environment variables (set in Netlify, never in the frontend):
//   GITHUB_TOKEN   fine-grained token with Contents: read & write on the data repo
//   GITHUB_OWNER   your GitHub username
//   GITHUB_REPO    the data repo name (kept separate from the site repo)
//   GITHUB_FILE    optional, defaults to tasks.json
//   GITHUB_BRANCH  optional, defaults to main
//
// There is no password: anyone who can open the site can change the list.
// Requires Node 18+ (global fetch), which is Netlify's default.

const crypto = require("crypto");

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const FILE = process.env.GITHUB_FILE || "tasks.json";
const BRANCH = process.env.GITHUB_BRANCH || "main";

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LEGACY_SEP = "\u241F"; // used by an earlier frontend that packed fields into "text"

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

// Bring any stored task (including old { id, text, done, createdAt } ones) to the full shape.
function normalizeTask(t) {
  if (!t || typeof t !== "object") return null;
  let title = typeof t.title === "string" ? t.title : "";
  let description = typeof t.description === "string" ? t.description : "";
  let date = typeof t.date === "string" ? t.date : "";
  let time = typeof t.time === "string" ? t.time : "";

  if (!title && typeof t.text === "string") {
    const parts = t.text.split(LEGACY_SEP);
    title = parts[0] || "";
    if (parts.length > 1) {
      description = parts[1] || "";
      date = parts[2] || "";
      time = parts[3] || "";
    }
  }
  return {
    id: String(t.id || crypto.randomUUID()),
    title,
    description,
    date: DATE_RE.test(date) ? date : "",
    time: TIME_RE.test(time) ? time : "",
    done: Boolean(t.done),
    createdAt: typeof t.createdAt === "string" ? t.createdAt : new Date().toISOString(),
  };
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
  if (!Array.isArray(tasks)) tasks = [];
  return { tasks: tasks.map(normalizeTask).filter(Boolean), sha: data.sha };
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

// Validate the "add" request once, before touching GitHub, and build the new task.
function buildTask(body) {
  // "text" is accepted as an alias for "title" so older pages keep working.
  const title = String(body.title ?? body.text ?? "").trim().slice(0, MAX_TITLE);
  if (!title) throw new HttpError(400, "Task title is required.");

  const description = String(body.description ?? "").trim().slice(0, MAX_DESCRIPTION);

  const date = String(body.date ?? "").trim();
  if (date && !DATE_RE.test(date)) throw new HttpError(400, "Date must look like YYYY-MM-DD.");

  const time = String(body.time ?? "").trim();
  if (time && !TIME_RE.test(time)) throw new HttpError(400, "Time must look like HH:MM (24-hour).");

  return {
    id: crypto.randomUUID(),
    title,
    description,
    date,
    time,
    done: false,
    createdAt: new Date().toISOString(),
  };
}

// Apply one change to the list. Returns the new list and a commit message.
function applyAction(tasks, body, newTask) {
  switch (body.action) {
    case "add":
      return { tasks: [...tasks, newTask], message: `Add task: ${newTask.title.slice(0, 60)}` };
    case "toggle": {
      const found = tasks.find((t) => t.id === body.id);
      if (!found) throw new HttpError(404, "That task no longer exists.");
      return {
        tasks: tasks.map((t) => (t.id === body.id ? { ...t, done: !t.done } : t)),
        message: `${found.done ? "Reopen" : "Complete"} task: ${found.title.slice(0, 60)}`,
      };
    }
    case "delete": {
      const found = tasks.find((t) => t.id === body.id);
      if (!found) throw new HttpError(404, "That task no longer exists.");
      return {
        tasks: tasks.filter((t) => t.id !== body.id),
        message: `Delete task: ${found.title.slice(0, 60)}`,
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
      return json(200, { tasks, writeProtected: false });
    }

    if (event.httpMethod === "POST") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch (_) {
        throw new HttpError(400, "Request body must be valid JSON.");
      }
      if (!body || typeof body !== "object") throw new HttpError(400, "Request body must be a JSON object.");

      const newTask = body.action === "add" ? buildTask(body) : null;

      // Read, change, write. If another change landed in between, GitHub rejects
      // the stale sha, so we re-read and try again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const { tasks, sha } = await readTasks();
        const next = applyAction(tasks, body, newTask);
        const result = await writeTasks(next.tasks, sha, next.message);
        if (result === "ok") return json(200, { tasks: next.tasks, writeProtected: false });
      }
      throw new HttpError(409, "Someone else changed the list at the same time. Try again.");
    }

    return json(405, { error: "Method not allowed." });
  } catch (err) {
    return json(err.status || 500, { error: err.message || "Something went wrong." });
  }
};
