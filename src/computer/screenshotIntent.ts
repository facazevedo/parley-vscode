/**
 * Detects when a chat message is clearly asking Parley to capture the user's
 * screen ("paste a screenshot of my main monitor", "take a screenshot", "capture
 * my screen"), so the host can grab and attach it deterministically instead of
 * relying on the model to call the capture_screen tool (which some models refuse
 * to do). Biased toward PRECISION — a false positive would attach an unwanted
 * screenshot — so it ignores how-to questions and coding tasks. Pure/tested.
 */
export function looksLikeScreenshotRequest(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t || t.length > 160) {
    return false; // long messages are tasks, not quick "grab my screen" asks
  }
  if (/\bhow\s+(do|to|can|would|should|might)\b/.test(t)) {
    return false; // "how do I take a screenshot…" is a question, not a request
  }
  if (/\b(implement|add|build|create|writ(e|ing)|code|button|function|feature|component|api|endpoint)\b/.test(t)) {
    return false; // a coding task that merely mentions screenshots
  }
  const screenNoun = '(screen|monitor|display|desktop)';
  const hasScreenshotWord = /\bscreen[ -]?shots?\b/.test(t);
  const captureVerb = /\b(take|grab|capture|paste|snap|get|show(?:\s+me)?)\b/.test(t);
  // "capture/grab/snap/screenshot … my/the/this … screen/monitor/display/desktop"
  const captureMyScreen = new RegExp(
    `\\b(capture|grab|snap|screenshot)\\b[^.?!]{0,20}\\b(my|the|this)\\b[^.?!]{0,15}${screenNoun}\\b`
  ).test(t);
  return (hasScreenshotWord && captureVerb) || captureMyScreen;
}

/**
 * True when the message is asking WHERE something is / for pixel coordinates on
 * screen ("which pixel is the X button", "coordinates of…", "where is…"). Used to
 * decide whether to overlay a coordinate grid on the captured screenshot.
 */
export function wantsPixelCoordinates(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(pixel|coordinate|coordinates|x[,\s/]*y)\b/.test(t) ||
    /\bwhere\s+(is|are|'s|exactly)\b/.test(t) ||
    /\b(location|position)\s+of\b/.test(t) ||
    /\bwhich\s+pixel\b/.test(t) ||
    /\bexact(ly)?\s+(where|position|location|spot)\b/.test(t)
  );
}
