// describe.js: turns raw event fields into plain English.
// Shared by ai.js (incident reports) and voice.js (spoken alerts), so both say things the same way.

const TIME_ZONE = 'America/New_York'; // Princeton Airport local time (the server itself may run in UTC)

// When the event happened. The camera sends `time` (ISO text); Pranav's server adds `receivedAt` (ms).
function eventDate(event) {
  const raw = event.time ?? event.receivedAt;
  const date = raw === undefined || raw === null ? new Date() : new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

// "3:42 PM" in airport local time.
function localTime(event) {
  return eventDate(event).toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
}

// "Sat, Oct 10, 2 PM" in airport local time (with minutes if asked). Empty string for a bad date.
function localHourLabel(value, withMinutes = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric',
    ...(withMinutes ? { minute: '2-digit' } : {})
  });
}

// The camera sends `camera_id`; Pranav's server also adds `cameraId`.
function cameraName(event) {
  return event.camera_id || event.cameraId || 'unknown camera';
}

// The tracker reports direction relative to the runway, not as a compass heading.
function directionPhrase(direction) {
  const text = String(direction || '');
  if (text.includes('toward corridor') && !text.includes('not toward')) return 'heading toward the runway';
  if (text.includes('not toward')) return 'near the runway';
  switch (direction) {
    case 'toward runway': return 'heading toward the runway';
    case 'away from runway': return 'moving away from the runway';
    case 'crossing': return 'crossing near the runway';
    case 'stationary': return 'holding position near the runway';
    default: return 'near the runway';
  }
}

// 8 -> "eight", 23 -> "twenty three". Spoken alerts use words, never digits.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numberWords(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  return 'more than one hundred';
}

// 0.82 -> "82 percent"; anything else -> "unknown".
function percent(confidence) {
  return typeof confidence === 'number' ? `${Math.round(confidence * 100)} percent` : 'unknown';
}

module.exports = { TIME_ZONE, eventDate, localTime, localHourLabel, cameraName, directionPhrase, percent, numberWords };
