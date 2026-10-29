"use client";

import { useEffect, useState } from "react";

type ApiState = "checking" | "online" | "offline";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export default function Home() {
  const [apiState, setApiState] = useState<ApiState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/v1/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("API is unavailable");
        return response.json();
      })
      .then(() => setApiState("online"))
      .catch(() => {
        if (!controller.signal.aborted) setApiState("offline");
      });
    return () => controller.abort();
  }, []);

  const statusLabel = {
    checking: "Checking API…",
    online: "API connected",
    offline: "API offline",
  }[apiState];

  return (
    <main className="min-h-screen md:grid md:grid-cols-[230px_1fr]">
      <aside className="border-b border-[#e2e6df] bg-white px-6 py-7 md:min-h-screen md:border-b-0 md:border-r">
        <a className="flex items-center gap-3 text-sm font-bold tracking-wide" href="/">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#183f35] text-white">A</span>
          RECEPTIONIST
        </a>
        <p className="mb-3 mt-10 text-[11px] font-semibold uppercase tracking-[.16em] text-[#89928a]">Workspace</p>
        <nav className="grid gap-1 text-sm">
          <a className="rounded-lg bg-[#edf3ef] px-3 py-2.5 font-semibold text-[#183f35]" href="/">Overview</a>
          <span className="px-3 py-2.5 text-[#7d877e]">Contacts <small className="float-right">Soon</small></span>
          <span className="px-3 py-2.5 text-[#7d877e]">Agents <small className="float-right">Soon</small></span>
          <span className="px-3 py-2.5 text-[#7d877e]">Call logs <small className="float-right">Soon</small></span>
        </nav>
        <div className="mt-10 rounded-xl bg-[#f5f6f3] p-4 text-xs leading-5 text-[#687269]">
          Local development workspace
        </div>
      </aside>

      <section className="mx-auto w-full max-w-6xl px-6 py-8 md:px-10 md:py-12">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#708176]">Your workspace</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Overview</h1>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-[#e1e5df] bg-white px-3 py-2 text-xs text-[#5d685f]">
            <span className={`h-2 w-2 rounded-full ${apiState === "online" ? "bg-emerald-500" : apiState === "offline" ? "bg-rose-500" : "bg-amber-400"}`} />
            {statusLabel}
          </div>
        </header>

        <div className="mt-9 rounded-2xl bg-[#183f35] p-7 text-white md:p-10">
          <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#b6cfc0]">Getting started</p>
          <h2 className="mt-3 max-w-2xl text-2xl font-semibold leading-tight md:text-3xl">Your workspace is ready to grow.</h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-[#d5e0d8]">The dashboard is connected to the local API. Contacts, agent management, and call history will appear here as those backend features are added.</p>
          <a className="mt-6 inline-flex rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-[#183f35]" href="http://127.0.0.1:8765/">Open Voice Lab</a>
        </div>

        <div className="mt-7 grid gap-4 md:grid-cols-3">
          {[
            ["Contacts", "Contact records will show here once storage is connected."],
            ["Agents", "Configure and review your assistants here."],
            ["Call logs", "Conversation history will appear here when logging is available."],
          ].map(([title, description]) => (
            <article key={title} className="rounded-xl border border-[#e2e6df] bg-white p-5">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-5 text-[#758077]">{description}</p>
              <span className="mt-5 inline-block rounded-full bg-[#f1f3f0] px-2.5 py-1 text-[11px] font-medium text-[#687269]">Coming next</span>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
