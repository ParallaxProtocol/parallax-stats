"use client";

import { useEffect, useState, type ReactNode } from "react";

export interface SectionLink {
  id: string;
  title: string;
}

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

  useEffect(() => {
    const target = asideAfter ? document.getElementById(asideAfter) : null;

    if (!target) return;

    // Out of view above the window: scrolled past, not yet reached
    const observer = new IntersectionObserver(([entry]) => setShowAside(!entry.isIntersecting && entry.boundingClientRect.top < 0));

    observer.observe(target);

    return () => observer.disconnect();
  }, [asideAfter]);

  useEffect(() => {
    const elements = sections.flatMap((section) => document.getElementById(section.id) ?? []);
    const passed = new Set<string>();

    // A section counts once its top is above 30% of the window height
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.boundingClientRect.top < (entry.rootBounds?.height ?? window.innerHeight) * 0.3) passed.add(entry.target.id);
          else passed.delete(entry.target.id);
        }

        setCurrent(sections.findLast((section) => passed.has(section.id))?.id ?? null);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: [0, 1] },
    );

    for (const element of elements) observer.observe(element);

    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav
      aria-label="Sections"
      className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/80 px-4 backdrop-blur-md sm:-mx-6 sm:px-6"
    >
      <div className="flex items-center justify-between gap-6">
        <ol className="flex min-w-0 gap-6 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
          {sections.map((section, i) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={current === section.id ? "location" : undefined}
                className={`-mb-px flex items-baseline gap-2 border-b-2 py-3 font-mono text-[11px] tracking-wider uppercase transition-colors ${
                  current === section.id ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className={current === section.id ? "text-brand" : "text-muted-foreground/60"}>{sectionNumber(i)}</span>
                {section.title}
              </a>
            </li>
          ))}
        </ol>
        {aside && (
          // Inert while hidden, so its controls take neither clicks nor focus
          <div
            inert={!showAside}
            className={`flex shrink-0 items-center gap-2 transition-[opacity,translate] duration-300 ease-out motion-reduce:transition-none ${
              showAside ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0"
            }`}
          >
            {aside}
          </div>
        )}
      </div>
    </nav>
  );
}
