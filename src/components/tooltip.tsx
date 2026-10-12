"use client";

import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Space kept between a tooltip and its element, and the window's edges. */
const GAP = 6;
const EDGE = 8;

interface Handlers {
  onPointerEnter?: (event: PointerEvent<Element>) => void;
  onPointerLeave?: (event: PointerEvent<Element>) => void;
  onFocus?: (event: FocusEvent<Element>) => void;
  onBlur?: (event: FocusEvent<Element>) => void;
}

/**
 * Tooltip shows `content` beside its child, in the page's style, while a
 * mouse hovers it or it has keyboard focus: a browser title in a box that
 * matches the rest of the page. It goes on the body, so a table's sideways
 * scroll never clips it, keeps inside the window, and drops below its
 * element near the top. Touch shows nothing, as a title does not either.
 * No content leaves the child as it is.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement<Handlers> }) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const tip = useRef<HTMLSpanElement>(null);

  // Placed once its size is known: centred on the element, then kept inside the window
  useLayoutEffect(() => {
    const el = tip.current;

    if (!anchor || !el) return;

    const { width, height } = el.getBoundingClientRect();
    const below = anchor.top - GAP - height < EDGE;
    const left = Math.min(Math.max(EDGE, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - EDGE);

    el.style.left = `${left}px`;
    el.style.top = `${below ? anchor.bottom + GAP : anchor.top - GAP - height}px`;
    el.style.visibility = "visible";
  }, [anchor]);

  // A fixed tooltip would drift from its element as the page scrolls
  useEffect(() => {
    if (!anchor) return;

    const hide = () => setAnchor(null);

    window.addEventListener("scroll", hide, { capture: true, passive: true });

    return () => window.removeEventListener("scroll", hide, { capture: true });
  }, [anchor]);

  if (content === null || content === undefined || content === "" || content === false) return children;

  const own = children.props;

  return (
    <>
      {cloneElement(children, {
        "aria-describedby": anchor ? id : undefined,
        onPointerEnter: (e: PointerEvent<Element>) => {
          own.onPointerEnter?.(e);
          if (e.pointerType === "mouse") setAnchor(e.currentTarget.getBoundingClientRect());
        },
        onPointerLeave: (e: PointerEvent<Element>) => {
          own.onPointerLeave?.(e);
          setAnchor(null);
        },
        onFocus: (e: FocusEvent<Element>) => {
          own.onFocus?.(e);
          if (e.currentTarget.matches(":focus-visible")) setAnchor(e.currentTarget.getBoundingClientRect());
        },
        onBlur: (e: FocusEvent<Element>) => {
          own.onBlur?.(e);
          setAnchor(null);
        },
      } as Handlers)}
      {anchor &&
        createPortal(
          <span
            ref={tip}
            id={id}
            role="tooltip"
            // Hidden until placed, so it never flashes at the corner
            style={{ visibility: "hidden", left: 0, top: 0 }}
            className="tooltip-in pointer-events-none fixed z-50 max-w-72 border border-border bg-surface-elevated px-2.5 py-1.5 text-xs leading-snug text-foreground shadow-lg"
          >
            {content}
          </span>,
          document.body,
        )}
    </>
  );
}
