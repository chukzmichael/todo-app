# To-do list: GitHub data, Netlify hosting

The page runs on Netlify. Tasks are stored in a `tasks.json` file in a separate GitHub repo. A Netlify Function is the only code that touches GitHub, so your token never reaches the browser.

```
Browser  ->  /api/tasks (Netlify Function)  ->  GitHub Contents API  ->  tasks.json in data repo
```

## Project layout

```
netlify.toml                  build settings and /api redirect
public/index.html             the whole frontend
netlify/functions/tasks.js    reads and writes tasks.json on GitHub
```

## Setup

### 1. Create the data repo
1. On GitHub, create a new repo, for example `todo-data`. Tick "Add a README" so the `main` branch exists.
2. Keep it private if you want the tasks to stay private.
3. You don't need to create `tasks.json`. The function creates it on the first save.

### 2. Create a GitHub token
1. GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.
2. Under "Repository access", choose "Only select repositories" and pick `todo-data`.
3. Under "Repository permissions", set **Contents** to **Read and write**.
4. Copy the token. You will paste it into Netlify in step 4.

### 3. Create the site repo
1. Create another repo, for example `todo-app`, and push this project folder to it.
2. Keep the data and the site in **different repos**. Every commit to the site repo triggers a Netlify deploy (15 credits each), and you don't want each task change to cause one.

### 4. Deploy on Netlify
1. Netlify > Add new project > Import an existing project > GitHub > choose `todo-app`.
2. Leave the build command empty. `netlify.toml` already sets the publish folder (`public`) and functions folder.
3. Before deploying, open Environment variables and add:

| Variable | Value |
| --- | --- |
| `GITHUB_TOKEN` | the token from step 2 |
| `GITHUB_OWNER` | your GitHub username |
| `GITHUB_REPO` | `todo-data` |
| `APP_PASSWORD` | a password of your choice (optional) |
| `GITHUB_FILE` | optional, defaults to `tasks.json` |
| `GITHUB_BRANCH` | optional, defaults to `main` |

4. Deploy, then open your `*.netlify.app` link.

If you add or change variables after the first deploy, trigger a new deploy so the function picks them up.

### 5. Test, then send the link
1. Add a task, tick it, delete it. The status line should say "Saved to GitHub".
2. Open the `todo-data` repo and check the commits. Each change appears as a commit.
3. Send your tutor the site link. If you set `APP_PASSWORD`, tell them the password so they can try adding tasks. Without it they can only view the list. If you leave `APP_PASSWORD` unset, anyone with the link can edit.

## How it handles common problems

- **Two edits at once:** GitHub needs the file's current `sha` to accept an update. If it's stale, the function re-reads the file and retries up to 3 times.
- **Token safety:** the token exists only in Netlify's environment variables and in `tasks.js`'s runtime.
- **Missing file:** an absent `tasks.json` is treated as an empty list.

## Troubleshooting

- **"The server is missing its GitHub settings":** an environment variable is missing, or you haven't redeployed since adding it.
- **"GitHub read failed (404)" or "(403)":** the token can't reach the data repo. Recheck the repo selection and the Contents permission.
- **"GitHub write failed (404)":** the branch name doesn't match. Set `GITHUB_BRANCH` if the repo's default branch isn't `main`.
- **"Wrong or missing password":** the password doesn't match `APP_PASSWORD`. Enter it again in the unlock box.
- **Page loads but list never appears:** open the browser dev tools Network tab and look at the `/api/tasks` response.

## Test locally (optional)

```
npm install -g netlify-cli
netlify dev
```

Put the same variables in a `.env` file in the project root and add `.env` to `.gitignore`.
