"use client";

// The "?" button beside the theme switch: what this dashboard is, and how
// far its figures reach. Chain figures cover the whole network; node
// figures cover only the nodes that report here.

import { useId, useRef, type ReactNode } from "react";

const ATLAS = "https://parallaxprotocol.org/resources/network-atlas";
const SOURCE = "https://github.com/ParallaxProtocol/parallax-stats";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-[11px] tracking-[0.15em] text-muted-foreground uppercase">{title}</h3>
      <div className="flex flex-col gap-2 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

const link = "text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground";

export function About() {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="inline-flex size-9 items-center justify-center rounded-md border border-border hover:bg-accent/50"
        aria-label="About this dashboard"
        aria-haspopup="dialog"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.4a2.5 2.5 0 0 1 4.85.85c0 1.65-2.45 2.2-2.45 3.75" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 17.2v.1" strokeLinecap="round" strokeWidth="2" />
        </svg>
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
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
                About this dashboard
              </h2>
              <p className="text-sm text-muted-foreground">
                A live view of the Parallax network, built from what nodes report to it.
              </p>
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

          <p role="note" className="flex gap-3 border border-info/40 bg-info/10 px-4 py-3 text-sm leading-relaxed">
            <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-info-ink" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <circle cx="8" cy="8" r="6.25" />
              <path d="M8 7.2v4M8 4.9v.1" strokeLinecap="round" />
            </svg>
            <span>
              <span className="font-medium">The node list is not the whole network.</span>{" "}
              <span className="text-muted-foreground">
                Only nodes whose operators turned on stats reporting appear here, and most nodes don&apos;t. Node
                counts, the map, peer latency, client versions and uptime describe those nodes only. For a wider view,
                see the{" "}
                <a href={ATLAS} target="_blank" rel="noopener noreferrer" className={link}>
                  Network Atlas
                </a>
                .
              </span>
            </span>
          </p>

          <Section title="What it shows">
            <p>
              <span className="font-medium">Chain figures</span>{" "}
              <span className="text-muted-foreground">
                cover the whole network: the best block, block times, difficulty, hashrate, transactions, fees, supply
                and decentralization. They come from the blocks themselves, which are the same on every node. Hashrate
                is an estimate, worked out from difficulty and block times.
              </span>
            </p>
            <p>
              <span className="font-medium">Node figures</span>{" "}
              <span className="text-muted-foreground">
                cover the reporting nodes only: whether each is in sync, its peers, latency, version and how fast blocks
                reach it.
              </span>
            </p>
          </Section>

          <Section title="Verified and unverified nodes">
            <p className="text-muted-foreground">
              Verified nodes are run by the Parallax team and known operators such as bootnodes, pools and exchanges, and
              the best block follows them. Anyone else can report too: those nodes appear under a pseudonym, and what
              they report about themselves is not checked.
            </p>
          </Section>

          <Section title="Privacy">
            <p className="text-muted-foreground">
              Node IP addresses are never shown. Locations on the map are approximate, to the city at most.
            </p>
          </Section>

          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            Run a node? Use &ldquo;Add your node&rdquo; above the node list to report it here. The dashboard is{" "}
            <a href={SOURCE} target="_blank" rel="noopener noreferrer" className={link}>
              open source
            </a>
            .
          </p>
        </div>
      </dialog>
    </>
  );
}
