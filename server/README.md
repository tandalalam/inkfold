# Inkfold bridge

Private backend for the **Ask** feature. The app sends a question plus images of
the lassoed regions. The bridge saves the images and posts one message to a fixed
T3 Code thread with `t3 thread send`, so the conversation continues in that
thread. It then returns the agent's reply to the app.

- Listens on a Unix socket in a `0700` directory, so other accounts on the
  machine can't reach it.
- Exposed only on the tailnet, through Tailscale Serve, which sets
  `Tailscale-User-Login` from the caller's real identity. Requests from logins
  outside `allowedLogins` get `403`.
- Browsers may call it only from `allowedOrigins`.
- The public web app never contacts it unless Ask is turned on in Settings. It
  is on automatically only on the tailnet copy.

## Setup

`~/.config/inkfold-bridge/config.json` (mode 600):

```json
{
  "threadId": "<T3 thread id>",
  "allowedLogins": ["you@example.com"],
  "allowedOrigins": ["https://<user>.github.io", "https://<host>.ts.net:8460"]
}
```

```sh
systemctl --user enable --now inkfold-bridge.service   # unit in ~/.config/systemd/user
sudo tailscale serve --bg --https=8460 --set-path=/api unix:$HOME/.local/state/inkfold-bridge/bridge.sock
```

- State (`asks.json`) lives in `~/.local/state/inkfold-bridge/`.
- Clip images live in `~/.local/share/inkfold-bridge/clips/`.
- The newest `t3` in `~/.t3/runtime/versions` is used unless `t3Bin` is set.

## Endpoints

- `GET /api/status`: thread title, link and busy flag
- `POST /api/ask`: `{askId, question, detail: 'short'|'long', context: {notebook}, clips: [{image (PNG data URL), page, document, text}]}`.
  Idempotent per `askId`.
- `GET /api/asks?ids=a,b`: `{asks: [{askId, status, progress, answer, error}]}`

`tests/ask.mjs` runs the bridge in test mode with `tests/fake-t3.mjs`, so tests
never message a real thread.
