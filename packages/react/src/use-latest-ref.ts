"use client";
import { useEffect, useRef, type RefObject } from "react";

/**
 * Pins the latest value in a ref so long-lived closures (SDK callbacks,
 * in-flight promises, run-once effects) read current props without becoming
 * effect dependencies. Updated in an effect, never during render; callers
 * must invoke this hook BEFORE any effect that reads the ref so the update
 * effect runs first. The useRef initial value covers the very first run.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
