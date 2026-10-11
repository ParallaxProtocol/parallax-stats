"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Level } from "@/lib/alert-levels";

export interface SectionLink {
  id: string;
  title: string;
  /** What the section covers, under its title. */
  description: string;
  /** A warning about something in the section, marked on its tab and beside its title. */
  status?: { level: Level; label: string } | null;
}

/** Status dots, the warning's mark colour. */
export const STATUS_DOT: Record<Level, string> = { warn: "bg-warn", critical: "bg-critical" };

/** sectionNumber numbers sections from 01, for the bar and the section titles alike. */
export function sectionNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/**
 * SectionNav is a bar of links to the page's sections that stays at the
 * top while scrolling, marking the section being read: the last one whose
 * top has passed the upper part of the window. `aside` slides in at the
 * bar's end once the element `asideAfter` names has scrolled out of view,
 * standing in for it.
 */
export function SectionNav({ sections, aside, asideAfter }: { sections: SectionLink[]; aside?: ReactNode; asideAfter?: string }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [showAside, setShowAside] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  // Which ends of the list have links scrolled out of sight, to fade them
  const [more, setMore] = useState({ left: false, right: false });

  useEffect(() => {
    const el = list.current;

    if (!el) return;

    const update = () => setMore({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    const observer = new ResizeObserver(update);

    update();
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });

    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  // The indicator slides under the current tab: its offset and width, measured from the link
  const [mark, setMark] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = list.current;
    const link = current ? el?.querySelector<HTMLElement>(`a[href="#${current}"]`) : null;

    if (!el || !link) return setMark(null);

    const place = () => setMark({ left: link.offsetLeft, width: link.offsetWidth });
    const observer = new ResizeObserver(place);

    observer.observe(el);

    return () => observer.disconnect();
  }, [current]);

  // How far down the page the reader is, as a hairline along the bar's bottom edge
  const [progress, setProgress] = useState(0);
  // Only the ids matter here: a section's status changing must not restart the tracking
  const ids = sections.map((section) => section.id).join(" ");

  // Measured on every scroll frame rather than by an IntersectionObserver, which misses a
  // section that crosses the line between two frames on a fast scroll and leaves the wrong one marked
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const range = document.documentElement.scrollHeight - window.innerHeight;
        const line = window.innerHeight * 0.3;
        const elements = ids.split(" ").flatMap((id) => document.getElementById(id) ?? []);
        // At the very bottom the last sections may never reach the line: mark the last one in view
        const bottom = range > 0 && window.scrollY >= range - 2;
        const passed = elements.filter((el) => el.getBoundingClientRect().top < (bottom ? window.innerHeight : line));

        setProgress(range > 0 ? Math.min(1, window.scrollY / range) : 0);
        setCurrent(passed.at(-1)?.id ?? null);
      });
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);

  // Keep the current section's link in sight when the bar is narrower than its links
  useEffect(() => {
    const el = list.current;
    const link = current ? el?.querySelector<HTMLElement>(`a[href="#${current}"]`) : null;

    if (!el || !link) return;

    const left = link.offsetLeft;

    if (left < el.scrollLeft || left + link.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: left - 16, behavior: "smooth" });
    }
  }, [current]);

  useEffect(() => {
    const target = asideAfter ? document.getElementById(asideAfter) : null;

    if (!target) return;

    // Out of view above the window: scrolled past, not yet reached
    const observer = new IntersectionObserver(([entry]) => setShowAside(!entry.isIntersecting && entry.boundingClientRect.top < 0));

    observer.observe(target);

    return () => observer.disconnect();
  }, [asideAfter]);

  return (
    <nav
      aria-label="Sections"
      className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/80 px-4 backdrop-blur-md sm:-mx-6 sm:px-6"
    >
      <div className="relative flex items-center justify-between gap-6">
        <ol
          ref={list}
          className="relative flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]"
          style={{
            maskImage: `linear-gradient(to right, ${more.left ? "transparent, black 24px" : "black"}, ${more.right ? "black calc(100% - 32px), transparent" : "black"})`,
          }}
        >
          {sections.map((section, i) => {
            const here = current === section.id;

            return (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  aria-current={here ? "location" : undefined}
                  className={`group/tab my-1.5 flex items-center gap-2 rounded-sm px-2.5 py-1.5 font-mono text-[11px] tracking-wider uppercase transition-colors ${
                    here ? "bg-foreground/[0.06] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                  }`}
                >
                  <span
                    className={`tabular-nums transition-colors ${here ? "text-brand" : "text-muted-foreground/60 group-hover/tab:text-muted-foreground"}`}
                  >
                    {sectionNumber(i)}
                  </span>
                  {section.title}
                  {section.status && (
                    <span
                      role="img"
                      aria-label={section.status.label}
                      title={section.status.label}
                      className={`size-1.5 rounded-full ${STATUS_DOT[section.status.level]}`}
                    />
                  )}
                </a>
              </li>
            );
          })}
          {/* The current tab's underline, in the logo's gradient, sliding from tab to tab */}
          <li
            aria-hidden
            className="brand-gradient-mark pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full transition-[translate,width,opacity] duration-300 ease-out"
            style={{ width: mark?.width ?? 0, translate: `${mark?.left ?? 0}px 0`, opacity: mark ? 1 : 0 }}
          />
        </ol>
        {aside && (
          // Inert while hidden, so its controls take neither clicks nor focus, and out of the
          // flow, so the links have the bar's full width until the block clock scrolls away
          <div
            inert={!showAside}
            className={`flex shrink-0 items-center gap-2 ${
              // Fades in, but leaves at once: out of the flow it would sit over the links while fading
              showAside
                ? "translate-y-0 opacity-100 transition-[opacity,translate] duration-300 ease-out motion-reduce:transition-none"
                : "pointer-events-none absolute right-0 -translate-y-2 opacity-0"
            }`}
          >
            {aside}
          </div>
        )}
      </div>
      <span aria-hidden className="absolute inset-x-0 -bottom-px h-px origin-left bg-brand-mark/70" style={{ scale: `${progress} 1` }} />
    </nav>
  );
}
