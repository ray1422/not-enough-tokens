// Split a byte stream into lines without decoding the parts we skip.
export class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.rest = null;
  }

  push(chunk) {
    let buf = this.rest ? Buffer.concat([this.rest, chunk]) : chunk;
    let start = 0;
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) {
      this.onLine(buf.subarray(start, i));
      start = i + 1;
    }
    this.rest = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
  }

  // Bytes of a trailing line that has no newline yet.
  get pending() {
    return this.rest ? this.rest.length : 0;
  }
}

const USAGE = Buffer.from('"usage"');
export const mayHaveUsage = (buf) => buf.indexOf(USAGE) !== -1;
