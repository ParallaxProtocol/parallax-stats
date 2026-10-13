import type { Transition } from "motion/react";

/** What opens, closes, arrives and leaves moves on a spring without bounce: quick, and interruptible midway. */
export const SPRING: Transition = { type: "spring", bounce: 0, visualDuration: 0.38 };
/** What goes fades out quickly; what comes fades in a beat later, once there is room for it. */
export const FADE_OUT: Transition = { duration: 0.15, ease: "easeOut" };
export const FADE_IN: Transition = { duration: 0.3, ease: "easeOut", delay: 0.07 };
