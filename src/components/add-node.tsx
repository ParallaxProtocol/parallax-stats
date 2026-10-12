"use client";

import { useEffect, useId, useRef, useState } from "react";
import { NAME_CHECK_PATH, type NameStatus } from "@/lib/protocol";
import { CopyButton } from "./copy-button";

const TELEGRAM = "https://t.me/parallaxchain";

/** The names the server accepts; see cleanId in server/sanitize. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._\-()[\]#+]{0,63}$/;

type Tab = "public" | "verified";

const STATUS: Record<Exclude<NameStatus, "invalid">, { text: string; className: string }> = {
  available: { text: "Available", className: "text-good-ink" },
  yours: { text: "In use from your address. Fine if it's your own node.", className: "text-muted-foreground" },
  taken: { text: "Taken by another node. Pick a different name.", className: "text-critical-ink" },
  reserved: { text: "Reserved for a verified node. Pick a different name.", className: "text-critical-ink" },
};

/** useNameStatus checks, once typing pauses, whether the asker can use a name; null while unknown. */
function useNameStatus(name: string, enabled: boolean): NameStatus | null {
  const [checked, setChecked] = useState<{ name: string; status: NameStatus } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`${NAME_CHECK_PATH}?name=${encodeURIComponent(name)}`, { signal: controller.signal });

        if (res.ok) setChecked({ name, status: ((await res.json()) as { status: NameStatus }).status });
      } catch {
        // A failed or rate limited check leaves the format hint in place
      }
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [name, enabled]);

  return enabled && checked?.name === name ? checked.status : null;
}

function Code({ children, label }: { children: string; label: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border border-border bg-background py-2.5 pr-2 pl-3">
      <pre className="min-w-0 py-0.5 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</pre>
      <CopyButton value={children} label={label} />
    </div>
  );
}

/**
 * AddNode opens instructions for listing a node on the dashboard: any
 * operator can report without a secret, and operators of fixed
 * infrastructure can ask for a private secret to be verified.
 */
export function AddNode({ publicNodes }: { publicNodes: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [host, setHost] = useState("");
  const [name, setName] = useState("my-node");
  const [tab, setTab] = useState<Tab>(publicNodes ? "public" : "verified");
  const [isOpen, setIsOpen] = useState(false);
  const valid = NAME.test(name);
  const status = useNameStatus(name, isOpen && tab === "public" && valid);
  const statusLine = status && status !== "invalid" ? STATUS[status] : null;
  const shown = valid ? name : "my-node";
  const url = `${shown}@${host}`;
  const tabs: { key: Tab; label: string }[] = publicNodes
    ? [
        { key: "public", label: "Public node" },
        { key: "verified", label: "Verified node" },
      ]
    : [{ key: "verified", label: "Verified node" }];

  function open() {
    // Nodes dial this page's host; read it on opening so server and browser renders agree
    setHost(window.location.host);
    setIsOpen(true);
    dialog.current?.showModal();
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="brand-gradient inline-flex h-8 items-center rounded px-3 font-mono text-[11px] font-semibold tracking-[0.15em] whitespace-nowrap text-brand-foreground uppercase transition-transform active:translate-y-px"
      >
        Add your node
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        onClose={() => setIsOpen(false)}
        className="modal-dialog m-auto max-h-[90dvh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto border border-border bg-surface-elevated p-0 text-foreground shadow-[0_4px_10px_oklch(0_0_0/0.45),0_20px_48px_oklch(0_0_0/0.45)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="flex flex-col gap-6 p-6 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <h2 id={`${id}-title`} className="text-2xl">
                Add your node
              </h2>
              <p className="text-sm text-muted-foreground">Start parallaxd with stats reporting. No open ports needed.</p>
            </div>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              aria-label="Close"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {tabs.length > 1 && (
            <div role="tablist" aria-label="Kind of node" className="flex gap-6 border-b border-border">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  id={`${id}-tab-${t.key}`}
                  aria-selected={tab === t.key}
                  aria-controls={`${id}-panel`}
                  onClick={() => setTab(t.key)}
                  className={`-mb-px border-b-2 pb-2.5 font-mono text-[11px] tracking-[0.15em] uppercase transition-colors ${tab === t.key ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="flex flex-col gap-5">
            {tab === "public" ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-name`} className="text-sm font-medium">
                    Node name
                  </label>
                  <input
                    id={`${id}-name`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={64}
                    aria-invalid={!valid || status === "taken" || status === "reserved"}
                    aria-describedby={`${id}-hint`}
                    className="h-9 rounded border border-border bg-background px-3 font-mono text-sm text-foreground outline-none focus-visible:border-brand aria-invalid:border-critical"
                  />
                  <p
                    id={`${id}-hint`}
                    aria-live="polite"
                    className={`text-xs ${!valid ? "text-critical-ink" : (statusLine?.className ?? "text-muted-foreground")}`}
                  >
                    {!valid
                      ? "Start with a letter or number, and use only letters, numbers, spaces and . _ - ( ) [ ] # +"
                      : (statusLine?.text ?? "Letters, numbers, spaces and . _ - ( ) [ ] # +")}
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Start parallaxd with</p>
                  <Code label="command">{`parallaxd \\
  --prlstats "${url}"`}</Code>
                  <p className="text-xs text-muted-foreground">
                    Already running parallaxd with other flags? Add <code className="font-mono whitespace-nowrap text-foreground">--prlstats</code>{" "}
                    to them and restart.
                  </p>
                </div>

                <details className="group text-sm">
                  <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <span className="inline-flex items-center gap-1.5">
                      <svg
                        viewBox="0 0 16 16"
                        className="size-3 transition-transform group-open:rotate-90"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        aria-hidden
                      >
                        <path d="m6 3.5 4.5 4.5L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Using a config file?
                    </span>
                  </summary>
                  <div className="mt-3 flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">Add this section to it:</p>
                    <Code label="config section">{`[ParallaxStats]\nURL = "${url}"`}</Code>
                    <p className="text-xs text-muted-foreground">and start parallaxd with it:</p>
                    <Code label="command">{"parallaxd --config config.toml"}</Code>
                  </div>
                </details>

                <p className="border-t border-border pt-4 text-xs text-muted-foreground">
                  Your node appears within a minute, under a pseudonym such as{" "}
                  <span className="font-mono">node-3f9a2c1b</span>. Only verified nodes are listed by name.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  For bootnodes, exchanges, mining pools and public RPC endpoints. Verified nodes are listed by name, and
                  the network&apos;s best block follows them.
                </p>
                <a
                  href={TELEGRAM}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 w-fit items-center gap-2 rounded border border-foreground px-4 font-mono text-[11px] font-semibold tracking-[0.15em] uppercase hover:bg-accent/50"
                >
                  <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
                    <path d="M21.9 4.6 18.7 19.7c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13.4l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.5 3.1c.9-.3 1.6.2 1.4 1.5Z" />
                  </svg>
                  Request a secret on Telegram
                </a>
                <div className="flex flex-col gap-2 border-t border-border pt-4">
                  <p className="text-sm font-medium">Once you have it, start parallaxd with</p>
                  <Code label="command">{`parallaxd \\
  --prlstats "your-node:<private secret>@wss://${host}"`}</Code>
                  <p className="text-xs text-muted-foreground">
                    Keep the secret private. The <code className="font-mono text-foreground">wss://</code> keeps it
                    encrypted on the way.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Verified nodes must run parallaxd v2.1.2 or newer; older releases are refused.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
