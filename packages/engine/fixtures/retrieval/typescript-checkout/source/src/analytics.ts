export function trackAnalyticsEvent(name: string): string {
  return `analytics:${name}`;
}

export function summarizeAnalyticsWindow(events: string[]): number {
  return events.length;
}
