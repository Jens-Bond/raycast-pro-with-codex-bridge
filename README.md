# Raycast Codex Bridge

A local bridge that connects Raycast AI to the Codex CLI runtime with real-time streaming.

## Setup

```bash
npm run patch
```

Restart Raycast (`Cmd + Q`, then reopen).

```bash
npm run install-agent
```

Or run manually in your terminal:

```bash
npm start
```

---

## Commands

| Command | Description |
| :--- | :--- |
| `npm run patch` | Sets up the Raycast integration. |
| `npm run unpatch` | Restores default files from backups. |
| `npm start` | Starts the bridge server on `http://127.0.0.1:5001`. |
| `npm run install-agent` | Installs background service to start/stop with Raycast. |
| `npm run uninstall-agent` | Removes the background service. |

---

## Requirements

- macOS
- Node.js >= 20
- Codex CLI (`codex`)
- Raycast for Mac

---

## License

MIT
