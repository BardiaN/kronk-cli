/**
 * The line reader: opened only when something is waiting on a line, and never
 * dropping one that arrives before then.
 *
 * `readline` starts consuming stdin the moment it is created and emits every
 * line it parses, listener or no listener. Startup is not instant — the model
 * list, a cold load that can run to tens of seconds, the project scan, the MCP
 * connections — so creating the interface up front meant every line typed in
 * that window was emitted into nothing: no echo left, no error, and a prompt
 * that arrived as though you had typed nothing at all.
 *
 * Two things fix that, and both are needed. Creation is deferred to the first
 * question, which leaves those keystrokes in the terminal's own input buffer
 * until there is something to read them. And once the interface exists, lines
 * are queued rather than answered directly by `rl.question`, because a paste
 * or a fast typist can hand readline several lines in one read and only the
 * first would have had a listener waiting for it.
 *
 * One interface is created and kept, so history, line editing and Ctrl-C are
 * readline's own, exactly as before.
 */
import readline from 'node:readline';

/** What a pending question rejects with when the reader closes under it. */
export class PromptClosed extends Error {
  constructor() { super('the prompt was closed'); this.name = 'PromptClosed'; }
}

export function deferredPrompt({ input, output, historySize = 500, onSigint } = {}) {
  let rl = null;
  let closed = false;
  let waiting = null;              // the question currently unanswered, if any
  const queued = [];               // lines that arrived with nobody asking

  const open = () => {
    if (rl) return rl;
    rl = readline.createInterface({ input, output, historySize });
    rl.on('line', (line) => {
      if (waiting) { const w = waiting; waiting = null; w.resolve(line); }
      else queued.push(line);
    });
    rl.on('close', () => {
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w.reject(new PromptClosed()); }
    });
    // Registered with the interface rather than by the caller, so there is no
    // moment in which the interface exists and Ctrl-C is unhandled.
    if (onSigint) rl.on('SIGINT', () => onSigint());
    return rl;
  };

  return {
    /**
     * Ask, opening the interface if this is the first time. A line that was
     * typed ahead answers immediately — echoed after the prompt, so the
     * transcript reads the way it would have if the timing had been kinder.
     */
    question(query) {
      if (closed) return Promise.reject(new PromptClosed());
      const reader = open();
      if (queued.length) {
        const line = queued.shift();
        output.write(`${query}${line}\n`);
        return Promise.resolve(line);
      }
      // setPrompt rather than a bare write: readline needs to know the prompt
      // to redraw the line correctly when it is edited.
      reader.setPrompt(query);
      reader.prompt();
      return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
    },
    /** Closing one that was never opened is not an error, it is a no-op. */
    close() { closed = true; rl?.close(); },
    /** For tests, and for anything that wants to know without opening one. */
    get open() { return rl !== null; },
    /** Lines typed ahead that no question has taken yet. */
    get pending() { return queued.length; },
  };
}
