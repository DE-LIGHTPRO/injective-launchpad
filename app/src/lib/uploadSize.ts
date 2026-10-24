/**
 * How large a logo may be, and the one sentence that says so.
 *
 * ONE SOURCE, BECAUSE THE NUMBER WAS WRITTEN THREE TIMES. Audit F-16. `MAX_BYTES`
 * lived in the route, and the words "5 MB" were typed out twice more in its error
 * messages and once again in the drop zone's label. Four copies of one decision, and
 * the only one the creator reads is the one furthest from the check.
 *
 * THE ADVERTISED LIMIT WAS NOT REACHABLE. The route accepted 5 MB and the host
 * refuses the request before the function is ever invoked, so a creator with a 4.8 MB
 * PNG was told the file was fine by the page, had their whole upload sent, and got
 * back a message that said nothing about size.
 *
 * `HOST_BODY_LIMIT_BYTES` is measured, not read off a docs page, and the measurement
 * is why this is 4 MB rather than the documented 4.5. Probed against the deployed
 * route on 24 Oct 2026, stepping the body size:
 *
 *     4,194,304 (4 MiB)  ->  415 from our own sniffer, so the function ran
 *     4,450,000          ->  415, the function ran
 *     4,550,000          ->  413 FUNCTION_PAYLOAD_TOO_LARGE, text/plain
 *     4,613,734 (4.4 MiB)->  413
 *     5,242,880 (5 MiB)  ->  413
 *
 * So the cap is 4,500,000 bytes - decimal, not 4.5 MiB, which is why 4.4 MiB fails
 * while sounding like it should pass - and it is measured on the WHOLE request body.
 * The multipart envelope counts: the boundary, the part headers and the creator's own
 * filename all ride along, and a filename has no bound we control. 4 MiB leaves
 * 305,696 bytes of room for it, which no filename will ever fill.
 *
 * The label is derived rather than written, so the number the page advertises and the
 * number the route enforces cannot drift apart. That was the whole defect.
 */

/** The largest file this product accepts. Everything else here derives from it. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * What the host refuses, measured. Not a limit this product enforces: a fact about
 * where our own limit has to sit, recorded so the next person to raise
 * `MAX_UPLOAD_BYTES` can see what they are raising it into.
 */
export const HOST_BODY_LIMIT_BYTES = 4_500_000;

/** "4 MB". Derived, so it cannot disagree with the bytes above. */
export const MAX_UPLOAD_LABEL = `${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`;

/**
 * What a file's own size reads as in a sentence about it.
 *
 * One decimal place, and never "0.0 MB": a 4 KB file is not zero, and a reader told
 * their file is 0.0 MB has been told it is empty, which is a different defect with a
 * different remedy. Under a tenth of a megabyte reports in KB.
 */
export function describeFileSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

/**
 * The sentence a creator gets when their file is too big, from either side.
 *
 * Shared so the browser's refusal and the server's read the same, because they are
 * the same refusal: the client check exists only to make this sentence reachable for
 * a file the server will never see.
 *
 * IT MUST NOT READ AS A CONTRADICTION AT THE BOUNDARY, which the first version did.
 * Measured in the browser by dropping a file of exactly `MAX_UPLOAD_BYTES + 1`: it
 * said "That image is 4.0 MB. The limit is 4 MB.", which to a reader is a refusal of
 * a file that is not over the limit. The figure was honest to one decimal and the
 * sentence was still wrong, because one decimal cannot express the difference.
 *
 * Adding a decimal place would only move the problem to `+1` of the smaller unit, and
 * rounding the figure up would overstate the file. So the band where the rounded size
 * is not visibly over says so in words instead of in a number nobody can act on.
 */
export function oversizeMessage(bytes: number): string {
  const shown = describeFileSize(bytes);
  if (shown === describeFileSize(MAX_UPLOAD_BYTES)) {
    return `That image is just over the ${MAX_UPLOAD_LABEL} limit.`;
  }
  return `That image is ${shown}. The limit is ${MAX_UPLOAD_LABEL}.`;
}
