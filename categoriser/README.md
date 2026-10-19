# AVI Categoriser service

Run the local deterministic service from the repository root in a second terminal:

```powershell
cd categoriser
pnpm serve -- --mock
```

The AVI Next.js app proxies approved categoriser API paths to `http://127.0.0.1:8788` by default. Start the app separately with `pnpm dev`. Mock mode uses the local SQLite database at `~/.local/share/avi-categoriser/mock.db` and needs no provider credentials.

For provider-backed mode, configure the categoriser provider's credentials and set `CATEGORISER_HTTP_TOKEN` to a value of at least 16 characters in both the categoriser process environment and the Next.js app environment. Set `CATEGORISER_URL` in the app if the service listens on a different local URL. The token is read only by the server-side proxy and is never sent to the browser.

For Amazon Bedrock, start the service with `--provider bedrock` and configure `AWS_REGION`, `BEDROCK_MODEL_ID`, and the AWS SDK credentials in the categoriser process environment. If using a Bedrock API key, set `AWS_BEARER_TOKEN_BEDROCK` there; do not put the key in frontend code or commit it. The existing suggestion prompt asks for tags, tag proposals, summary, saved-reason draft, project, and confidence in one schema-validated response.

For a Vercel-hosted frontend, set `CATEGORISER_URL` to the public URL of the separately hosted categoriser and set `CATEGORISER_HTTP_TOKEN` in both services. Put `AWS_BEARER_TOKEN_BEDROCK` in the categoriser host's secret environment, because the categoriser runs separately from the Next.js frontend. The current app database is `data/avi.db` on the local filesystem; it is suitable for local use, but Vercel serverless storage is ephemeral. Move the app database to persistent storage before using a Vercel deployment as the live archive.

The app's archive database and the categoriser's metadata database are separate: the app stores the full Room/Library state, positions, settings, and uploads; the categoriser stores raw capture records, processing results, and review history. Mock categorizer records are local-only development data.
