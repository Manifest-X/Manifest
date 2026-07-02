# Chat Prune Function

Scheduled Appwrite Function that deletes chat messages older than a TTL — the
auto-delete half of ephemeral conversations (anonymous comments, transient
chats) built on the chat plugin's `appwrite` adapter. The adapter's `ttlHours`
option hides expired messages instantly at read time; this function does the
physical deletion on a schedule.

## Deploy

1. Create a Function in your Appwrite console (Node runtime), or via CLI/API.
2. Deploy this folder (entrypoint `src/main.js`, build command `npm install`).
3. Give it scopes `rows.read` + `rows.write` (or an `APPWRITE_API_KEY` env var).
4. Set the schedule (e.g. hourly: `0 * * * *`) and environment variables:

| Variable | Value |
|---|---|
| `CHAT_DATABASE_ID` | The database holding the messages table. |
| `CHAT_TABLE_ID` | The messages table (default `chat_messages`). |
| `CHAT_TTL_HOURS` | Delete rows older than this (default `24`). |

A manual execution with body `{ "ttlHours": 0 }` empties the table — useful for
testing or moderation resets.
