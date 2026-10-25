This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Install the optional symbolic math verifier dependency if you want the backend to use SymPy for algebra/arithmetic checks:

```bash
python -m pip install -r requirements.txt
```

If your Python executable is not named `python`, set `SYMPY_PYTHON_PATH` in `.env.local` to the Python executable that has SymPy installed.

For durable coaching sessions and distributed abuse-prevention rate limits in
production, configure an Upstash Redis database:

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
RATE_LIMIT_HASH_SALT=use-a-long-random-secret
# Optional; defaults to 24 hours.
SESSION_TTL_SECONDS=86400
```

The public About page links to the Math Coach presentation on YouTube by default:

```text
https://www.youtube.com/watch?v=__9jI2zJtTo
```

To override that link for a deployment, configure:

```bash
NEXT_PUBLIC_PRESENTATION_VIDEO_URL=https://example.com/your-video
```

Google Analytics is enabled site-wide with measurement ID `G-PG1NQWP058`.
Only standard page and session measurement is configured; Google Signals and
ad-personalization signals are disabled.

On Vercel, the app reads the platform forwarding headers automatically. On
another trusted reverse proxy, set `RATE_LIMIT_IP_HEADER` to the proxy-provided
client-IP header name. Without Redis, local development uses an in-memory
fallback. Vercel deployments must configure Redis because requests can run on
different function instances.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

1. Import the repository into [Vercel](https://vercel.com/new).
2. Create or connect an Upstash Redis database.
3. Add the variables from `.env.example` to the Vercel project. All four
   non-optional secrets should be available to Production and Preview.
4. Deploy with the default Next.js framework settings.
5. Smoke-test one typed problem, one image problem, a hint, a final-answer
   check, and Competition Mode from the public deployment URL.

The checker metadata is generated after the initial response through Next.js
`after()` and stored in Redis. The browser polls until that metadata is ready,
so it remains reliable when later requests use another Vercel function
instance. Uploaded images are compressed in the browser when needed and the
server enforces a 3 MB decoded-image limit to stay below Vercel's 4.5 MB
Function payload limit.

The Python/SymPy verifier remains optional on Vercel. When a Python executable
is unavailable, the existing deterministic and model-backed verification paths
continue to operate.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
