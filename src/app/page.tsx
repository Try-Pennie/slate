import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Slate</h1>
      <p className="max-w-md text-sm text-neutral-500">
        Availability aware booking for Pennie. Round robin scheduling, Google
        Calendar sync, an embeddable widget, and webhooks for Regal.
      </p>
      <div className="flex gap-3">
        <Link
          href="/admin"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          Admin
        </Link>
        <a
          href="/embed-example.html"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-neutral-500"
        >
          Embed demo
        </a>
      </div>
    </main>
  );
}
