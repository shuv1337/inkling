/**
 * Starts async work from an event handler or effect without awaiting it.
 * A rejection is logged instead of becoming an unhandled promise rejection.
 */
export function background(work: Promise<unknown>, what: string): void {
  work.catch((error: unknown) => console.error(`gloss: ${what} failed`, error));
}
