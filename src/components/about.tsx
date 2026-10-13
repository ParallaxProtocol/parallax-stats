"use client";

// The "?" button beside the sound switch: what this dashboard is, and how
// far its figures reach. Chain figures cover the whole network; node
// figures cover only the nodes that report here.

import { useId, useRef, type ReactNode } from "react";

const ATLAS = "https://parallaxprotocol.org/resources/network-atlas";
const SOURCE = "https://github.com/ParallaxProtocol/parallax-stats";
const METHOD = `${SOURCE}#how-the-figures-are-worked-out`;
const API = `${SOURCE}#json-api`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-3 font-mono text-[11px] tracking-[0.15em] text-muted-foreground uppercase">
        {title}
        <span aria-hidden className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

/** Scope is the chip on a figure card naming what the figures cover. */
function Scope({ wide, children }: { wide: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
      <span aria-hidden className={`size-1.5 rounded-full ${wide ? "bg-brand-mark" : "border border-muted-foreground"}`} />
      {children}
    </span>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const link = "text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground";
const footerLink =
  "inline-flex h-8 items-center gap-1.5 rounded border border-border px-3 font-mono text-[11px] tracking-[0.12em] uppercase hover:bg-accent/50";

export function About({ compact = false }: { compact?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className={`inline-flex items-center justify-center rounded-md border border-border hover:bg-accent/50 ${compact ? "size-7" : "size-8 sm:size-9"}`}
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
        className="modal-dialog m-auto max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain border border-border bg-surface-elevated p-0 text-foreground shadow-[0_4px_10px_oklch(0_0_0/0.45),0_20px_48px_oklch(0_0_0/0.45)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        {/* The header stays in view while the rest scrolls, under a hairline of the logo gradient */}
        <header className="sticky top-0 z-10 border-b border-border bg-surface-elevated/90 backdrop-blur-md">
          <div aria-hidden className="brand-gradient h-0.5" />
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 sm:px-7">
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-[0.15em] text-brand uppercase">Parallax Network Status</span>
              <h2 id={`${id}-title`} className="text-2xl">
                About this dashboard
              </h2>
              <p className="text-sm text-muted-foreground">
                A live view of the Parallax chain, and of the nodes that report to this page.
              </p>
            </div>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="-mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              aria-label="Close"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex flex-col gap-7 px-6 pt-5 pb-6 sm:px-7">
          <p role="note" className="flex gap-3 border border-info/40 bg-info/10 px-4 py-3 text-sm leading-relaxed">
            <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-info-ink" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <circle cx="8" cy="8" r="6.25" />
              <path d="M8 7.2v4M8 4.9v.1" strokeLinecap="round" />
            </svg>
            <span>
              <span className="font-medium">The node list is not the whole network.</span>{" "}
              <span className="text-muted-foreground">
                Nodes appear here only when their operators turn on stats reporting, and most don&apos;t. For a wider
                view, see the{" "}
                <a href={ATLAS} target="_blank" rel="noopener noreferrer" className={link}>
                  Network Atlas
                </a>
                .
              </span>
            </span>
          </p>

          <Section title="Two kinds of figures">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2 border border-border bg-card p-4">
                <Scope wide>Whole network</Scope>
                <h4 className="font-medium">Chain figures</h4>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Block times, difficulty, hashrate, transactions, fees, supply and decentralization. They come from the
                  blocks themselves, which are the same on every node. Hashrate is estimated from difficulty and block
                  times.
                </p>
              </div>
              <div className="flex flex-col gap-2 border border-border bg-card p-4">
                <Scope wide={false}>Reporting nodes only</Scope>
                <h4 className="font-medium">Node figures</h4>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Node counts, the map, sync state, peers, latency, client versions, uptime, and how quickly new blocks
                  reach each node.
                </p>
              </div>
            </div>
          </Section>

          <Section title="Alerts">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Alerts appear in the Network status card when verified nodes disagree on the chain, no block has been
              found for 2 hours, a reorganization reaches 3 or more blocks, one miner finds most of the week&apos;s
              blocks, blocks are slow to reach the network, or a new client release is out.
            </p>
          </Section>

          <Section title="Verified and unverified nodes">
            <ul className="flex flex-col gap-3 text-sm leading-relaxed">
              <li className="flex gap-3">
                <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0" aria-hidden>
                  <path
                    d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
                    className="fill-brand-mark"
                  />
                  <path d="m8.5 12 2.5 2.5 4.5-5" fill="none" className="stroke-background" strokeWidth="2" />
                </svg>
                <p>
                  <span className="font-medium">Verified</span>{" "}
                  <span className="text-muted-foreground">
                    nodes are run by the Parallax team or a known operator, such as a bootnode, pool or exchange, on
                    parallaxd v2.1.2 or newer. The best block shown follows them.
                  </span>
                </p>
              </li>
              <li className="flex gap-3">
                <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                  <circle cx="12" cy="12" r="8.5" strokeDasharray="3 2.4" />
                </svg>
                <p>
                  <span className="font-medium">Unverified</span>{" "}
                  <span className="text-muted-foreground">
                    nodes can be added by anyone. They are listed under a pseudonym, and what they report about
                    themselves is not checked.
                  </span>
                </p>
              </li>
            </ul>
          </Section>

          <Section title="Sources and privacy">
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-sm leading-relaxed">
              <dt className="font-medium">Prices</dt>
              <dd className="text-muted-foreground">
                Dollar figures use the LAX price from CoinGecko, refreshed every 5 minutes.
              </dd>
              <dt className="font-medium">Releases</dt>
              <dd className="text-muted-foreground">Client versions are compared with the latest parallaxd release on GitHub.</dd>
              <dt className="font-medium">Privacy</dt>
              <dd className="text-muted-foreground">
                Node IP addresses are never shown. Locations go no finer than the country: the map shades countries by how many nodes run there.
              </dd>
            </dl>
          </Section>
        </div>

        <footer className="flex flex-col gap-3 border-t border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <p className="text-sm text-muted-foreground">
            Run a node? Add it from the{" "}
            <a href="#nodes" onClick={() => dialog.current?.close()} className={link}>
              Nodes
            </a>{" "}
            section.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={METHOD} target="_blank" rel="noopener noreferrer" className={footerLink}>
              Methods <ExternalIcon />
            </a>
            <a href={API} target="_blank" rel="noopener noreferrer" className={footerLink}>
              API <ExternalIcon />
            </a>
            <a href={SOURCE} target="_blank" rel="noopener noreferrer" className={footerLink}>
              Source <ExternalIcon />
            </a>
          </div>
        </footer>
      </dialog>
    </>
  );
}
