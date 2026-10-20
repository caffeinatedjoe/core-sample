# GitHub device-flow relay

This Worker forwards two GitHub URLs and nothing else:

- `https://github.com/login/device/code`
- `https://github.com/login/oauth/access_token`

It has no client secret and it does not log requests. Browsers on `https://joecoffey.me` are the only allowed origin. A local page is rejected.

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, like `https://core-sample-github-relay.<account>.workers.dev`. Paste that origin into Core Sample. Do not add a path.

The OAuth app's client secret is not used. Do not put it in `wrangler.toml` or in the app.

## GitHub OAuth app

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.

- Application name: `Core Sample`
- Homepage URL: `https://joecoffey.me/core-sample/`
- Authorization callback URL: `https://joecoffey.me/core-sample/`

The device flow does not open the callback. GitHub still requires one. After creating the app, enable **Enable Device Flow**. Copy the client id into Core Sample. Leave the client secret where GitHub shows it.

In the installed app: Notes → GitHub. Paste the client id and the Worker origin. Save, then Connect.
