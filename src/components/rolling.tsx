"use client";

import { AnimatePresence, motion } from "motion/react";
import { ROLL } from "./motion";

const DIGIT = /\d/;

/**
 * Rolling shows a figure whose digits roll when it changes: the old digit
 * rises out as the new one rises in. Slots are keyed from the right, so
 * units after the number stay put and a number gaining a digit only moves
 * the digits that changed. Only digits roll; words, units and punctuation
 * simply change. What it shows on first render does not move.
 */
export function Rolling({ value }: { value: string }) {
  const chars = [...value];

  return (
    <span>
      <span className="sr-only">{value}</span>
      <span aria-hidden>
        {chars.map((char, i) => {
          const slot = chars.length - i;

          return DIGIT.test(char) ? (
            // The leaving digit is lifted out of the flow, over the one arriving in its place
            <span key={slot} className="relative inline-block">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={char}
                  className="inline-block"
                  initial={{ y: "0.5em", opacity: 0, filter: "blur(2px)" }}
                  animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                  exit={{ y: "-0.5em", opacity: 0, filter: "blur(2px)" }}
                  transition={ROLL}
                >
                  {char}
                </motion.span>
              </AnimatePresence>
            </span>
          ) : (
            <span key={slot}>{char}</span>
          );
        })}
      </span>
    </span>
  );
}
