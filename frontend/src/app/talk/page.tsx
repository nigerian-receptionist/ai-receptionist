"use client";

import { useMemo } from "react";

import type { AgentState } from "@/features/talk/protocol";
import { useTalkSession } from "@/features/talk/use-talk-session";

const STATE_LABELS: Record<AgentState, string> = {
  connecting: "Connecting",
  notice: "Playing notice",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Ended",
};

export default function TalkPage() {
  const options = useMemo(
    () => ({
      wsUrl: process.env.NEXT_PUBLIC_VOICE_WS_URL ?? "ws://127.0.0.1:8000/v1/voice",
      token: process.env.NEXT_PUBLIC_DEV_ACCESS_TOKEN ?? "",
      endpointingSilenceMs: Number(process.env.NEXT_PUBLIC_ENDPOINTING_SILENCE_MS ?? "600"),
    }),
    [],
  );
  const { status, agentState, lines, latencies, error, start, stop } = useTalkSession(options);
  const live = status === "starting" || status === "live";

  return (
    <main className="min-h-screen md:grid md:grid-cols-[230px_1fr]">
      <aside className="border-b border-[#e2e6df] bg-white px-6 py-7 md:min-h-screen md:border-b-0 md:border-r">
        <a className="flex items-center gap-3 text-sm font-bold tracking-wide" href="/">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#183f35] text-white">A</span>
          RECEPTIONIST
        </a>
        <p className="mb-3 mt-10 text-[11px] font-semibold uppercase tracking-[.16em] text-[#89928a]">Workspace</p>
        <nav className="grid gap-1 text-sm">
          <a className="rounded-lg px-3 py-2.5 text-[#3c4740] hover:bg-[#f1f3f0]" href="/">Overview</a>
          <a className="rounded-lg bg-[#edf3ef] px-3 py-2.5 font-semibold text-[#183f35]" href="/talk" aria-current="page">Talk</a>
          <span className="px-3 py-2.5 text-[#7d877e]">Contacts <small className="float-right">Soon</small></span>
          <span className="px-3 py-2.5 text-[#7d877e]">Agents <small className="float-right">Soon</small></span>
          <span className="px-3 py-2.5 text-[#7d877e]">Call logs <small className="float-right">Soon</small></span>
        </nav>
      </aside>

      <section className="mx-auto w-full max-w-3xl px-6 py-8 md:px-10 md:py-12">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#708176]">Voice agent</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Talk to the agent</h1>
          </div>
          <span
            className="rounded-full border border-[#e1e5df] bg-white px-3 py-2 text-xs font-medium text-[#5d685f]"
            role="status"
            aria-label={`Agent state: ${agentState ? STATE_LABELS[agentState] : "idle"}`}
          >
            <span
              className={`mr-2 inline-block h-2 w-2 rounded-full ${
                agentState === "listening"
                  ? "bg-emerald-500"
                  : agentState === "speaking" || agentState === "thinking"
                    ? "bg-amber-400"
                    : "bg-gray-300"
              }`}
            />
            {agentState ? STATE_LABELS[agentState] : "Idle"}
          </span>
        </header>

        {error && (
          <p className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center gap-3">
          {!live ? (
            <button
              type="button"
              onClick={() => void start()}
              className="rounded-lg bg-[#183f35] px-6 py-3 text-sm font-semibold text-white hover:bg-[#0f2e27] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#183f35]"
            >
              Start
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="rounded-lg bg-rose-700 px-6 py-3 text-sm font-semibold text-white hover:bg-rose-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
            >
              End
            </button>
          )}
          <p className="text-xs leading-5 text-[#758077]">
            {live ? "Speak naturally. Interrupt the agent any time; it will stop and listen." : "Uses your microphone. The agent plays a recording notice first."}
          </p>
        </div>

        <h2 className="mt-10 text-sm font-semibold text-[#3c4740]">Conversation</h2>
        <ol className="mt-3 space-y-3" aria-live="polite">
          {lines.length === 0 && (
            <li className="rounded-lg border border-dashed border-[#dfe4de] px-4 py-6 text-sm text-[#758077]">
              Nothing yet. Press Start and say hello.
            </li>
          )}
          {lines.map((line) => (
            <li
              key={line.key}
              className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm leading-6 ${
                line.speaker === "caller"
                  ? "ml-auto bg-[#183f35] text-white"
                  : "bg-white text-[#2c352f] ring-1 ring-[#e2e6df]"
              } ${line.final ? "" : "opacity-60 italic"}`}
            >
              <span className="sr-only">{line.speaker === "caller" ? "You" : "Agent"}: </span>
              {line.text}
            </li>
          ))}
        </ol>

        {latencies.length > 0 && (
          <div className="mt-10">
            <h2 className="text-sm font-semibold text-[#3c4740]">Turn latency</h2>
            <ul className="mt-3 space-y-2">
              {latencies.map((latency) => (
                <li key={latency.turnId} className="rounded-lg bg-white px-4 py-2.5 text-xs text-[#5d685f] ring-1 ring-[#e2e6df]">
                  End of speech to first audio:{" "}
                  <strong className="text-[#183f35]">{formatMs(latency.timings.end_to_first_audio)}</strong>
                  {" · "}stt {formatMs(latency.timings.stt)}
                  {" · "}llm first token {formatMs(latency.timings.llm_first_token)}
                  {" · "}llm total {formatMs(latency.timings.llm_total)}
                  {" · "}tts first audio {formatMs(latency.timings.tts_first_audio)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}
