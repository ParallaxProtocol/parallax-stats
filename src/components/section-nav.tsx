"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import type { Level } from "@/lib/alert-levels";
import { FADE_IN, FADE_OUT, SPRING } from "./motion";
import { Tooltip } from "./tooltip";

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
        {/* Scrolls sideways when narrow: Motion allows for that when moving the current tab's mark */}
        <motion.ol
          ref={list}
          layoutScroll
          className="relative flex min-w-0 gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]"
          style={{
            maskImage: `linear-gradient(to right, ${more.left ? "transparent, black 24px" : "black"}, ${more.right ? "black calc(100% - 32px), transparent" : "black"})`,
          }}
        >
          {sections.map((section, i) => {
            const here = current === section.id;

            return (
              <li key={section.id} className="relative">
                {/* The current tab's mark, a wash behind it and an underline in the logo's gradient, springs from tab to tab */}
                {here && (
                  <motion.span aria-hidden layoutId="section-nav-current" transition={SPRING} className="pointer-events-none absolute inset-0">
                    <span className="absolute inset-x-0 inset-y-1.5 rounded-sm bg-foreground/[0.06]" />
                    <span className="brand-gradient-mark absolute inset-x-0 bottom-0 h-0.5 rounded-full" />
                  </motion.span>
                )}
                <a
                  href={`#${section.id}`}
                  aria-current={here ? "location" : undefined}
                  className={`group/tab relative my-1.5 flex items-center gap-2 rounded-sm px-2.5 py-1.5 font-mono text-[11px] tracking-wider uppercase transition-colors ${
                    here ? "text-foreground" : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                  }`}
                >
                  <span
                    className={`tabular-nums transition-colors ${here ? "text-brand" : "text-muted-foreground/60 group-hover/tab:text-muted-foreground"}`}
                  >
                    {sectionNumber(i)}
                  </span>
                  {section.title}
                  {section.status && (
                    <Tooltip content={section.status.label}>
                      <span role="img" aria-label={section.status.label} className={`size-1.5 rounded-full ${STATUS_DOT[section.status.level]}`} />
                    </Tooltip>
                  )}
                </a>
              </li>
            );
          })}
        </motion.ol>
        {aside && (
          // Inert while hidden, so its controls take neither clicks nor focus, and out of the
          // flow, so the links have the bar's full width until the block clock scrolls away.
          // Kept mounted, so a panel opened from it survives; it fades out quickly, as it may
          // briefly lie over the links
          <motion.div
            inert={!showAside}
            className={`flex shrink-0 items-center gap-2 ${showAside ? "" : "pointer-events-none absolute right-0"}`}
            initial={false}
            animate={showAside ? { opacity: 1, y: 0 } : { opacity: 0, y: -8 }}
            transition={showAside ? FADE_IN : FADE_OUT}
          >
            {aside}
          </motion.div>
        )}
      </div>
      <span aria-hidden className="absolute inset-x-0 -bottom-px h-px origin-left bg-brand-mark/70" style={{ scale: `${progress} 1` }} />
    </nav>
  );
}
