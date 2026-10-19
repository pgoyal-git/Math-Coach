import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About | Math Coach",
  description:
    "Learn how Math Coach provides private, step-by-step Socratic support for competition math practice.",
};

const instructions = [
  {
    title: "Add a problem",
    body: "Type or paste the problem, or upload a PNG, JPEG, or WebP screenshot.",
  },
  {
    title: "Work one step at a time",
    body: "Use the starter strategy if it helps, then submit each equation, observation, or partial result for review.",
  },
  {
    title: "Choose the right check",
    body: "Use Review Step for work in progress. Use Check Answer only when you are submitting the final answer the problem asks for.",
  },
  {
    title: "Ask for help",
    body: "Leave the step input empty and choose Coach Me for a focused hint. Press Tab while entering a step to switch between text and math modes.",
  },
  {
    title: "Explore the guided example",
    body: "Demo Mode shows a complete scripted coaching exchange, including how the coach responds to an incorrect step.",
  },
  {
    title: "Compare approaches",
    body: "After solving a problem, Competition Mode will show a faster contest-style method when a genuinely useful shortcut exists.",
  },
];

const technologies = [
  ["TypeScript", "https://www.typescriptlang.org/"],
  ["React", "https://react.dev/"],
  ["Next.js", "https://nextjs.org/docs"],
  ["CSS", "https://developer.mozilla.org/en-US/docs/Web/CSS"],
  ["MathLive", "https://mathlive.io/"],
  ["KaTeX", "https://katex.org/"],
  ["Python", "https://www.python.org/"],
  ["SymPy", "https://www.sympy.org/"],
  ["OpenAI API", "https://openai.com/api/"],
] as const;

function safePresentationUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_PRESENTATION_VIDEO_URL?.trim();
  if (!configuredUrl) return null;

  try {
    const url = new URL(configuredUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export default function AboutPage() {
  const presentationVideoUrl = safePresentationUrl();

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="rounded-xl border border-blue-100 bg-linear-to-r from-emerald-100 via-white to-blue-100 px-5 py-6 shadow-sm ring-1 ring-white/70 sm:px-8">
        <nav aria-label="About page navigation">
          <Link
            href="/"
            className="inline-flex rounded-full bg-white/80 px-3 py-1.5 text-sm font-semibold text-blue-800 shadow-sm ring-1 ring-blue-100 transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            ← Back to Math Coach
          </Link>
        </nav>
        <p className="mt-6 text-sm font-bold uppercase tracking-wider text-blue-800">
          About
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
          Math Coach
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-7 text-slate-700 sm:text-lg">
          Math Coach is a free, private learning tool that helps students reason
          through challenging math problems without simply giving away the solution,
          helping them develop problem-solving skills.
        </p>
      </header>

      <section
        aria-labelledby="how-to-use-heading"
        className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8"
      >
        <h2 id="how-to-use-heading" className="text-2xl font-bold text-slate-950">
          How to use Math Coach
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
          The goal is to keep you responsible for the reasoning while giving useful
          feedback at the moment you need it.
        </p>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2">
          {instructions.map((instruction, index) => (
            <li
              key={instruction.title}
              className="rounded-lg border border-slate-200 bg-slate-50 p-4"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-700 text-sm font-bold text-white">
                  {index + 1}
                </span>
                <div>
                  <h3 className="font-bold text-slate-950">{instruction.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-700">
                    {instruction.body}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="privacy-heading"
          className="rounded-xl border border-emerald-100 bg-emerald-50 p-5 shadow-sm sm:p-6"
        >
          <h2 id="privacy-heading" className="text-xl font-bold text-emerald-950">
            Access and privacy
          </h2>
          <p className="mt-3 text-sm font-semibold leading-6 text-emerald-950">
            No account or login is required to use Math Coach.
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-700">
            <li>There are no ads or paid student accounts.</li>
            <li>Uploaded images are used only for the current math session.</li>
            <li>Progress is stored locally in this browser.</li>
            <li>Server sessions expire when the service restarts.</li>
          </ul>
        </section>

        <section
          aria-labelledby="video-heading"
          className="rounded-xl border border-indigo-100 bg-indigo-50 p-5 shadow-sm sm:p-6"
        >
          <h2 id="video-heading" className="text-xl font-bold text-indigo-950">
            Video presentation
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-700">
            Watch a short presentation introducing Math Coach and demonstrating its
            learning workflow.
          </p>
          {presentationVideoUrl ? (
            <a
              href={presentationVideoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex rounded-lg bg-indigo-700 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              Watch the video presentation
            </a>
          ) : (
            <div
              role="status"
              className="mt-4 inline-flex rounded-lg border border-indigo-200 bg-white px-4 py-2.5 text-sm font-bold text-indigo-800"
            >
              Video presentation coming soon
            </div>
          )}
        </section>
      </div>

      <section
        aria-labelledby="technologies-heading"
        className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8"
      >
        <h2 id="technologies-heading" className="text-2xl font-bold text-slate-950">
          Technologies Used
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Math Coach uses these technologies for its web interface, mathematical
          input and display, symbolic verification, adaptive coaching, and image
          understanding.
        </p>
        <ul className="mt-4 flex flex-wrap gap-3">
          {technologies.map(([name, href]) => (
            <li key={name}>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              >
                {name}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
