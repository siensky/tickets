/** Tider visas i svensk tid, oavsett enhetens zon (samma regel som webbappen). */
const timeFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

export function formatEventDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}
