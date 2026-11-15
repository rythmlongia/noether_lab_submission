/*
 * logview.js - virtualised log pane. Only the rows in view exist in the DOM, so
 * 20 000 lines cost the same to show as 30. Text goes in with textContent (never
 * innerHTML): solver output is untrusted text.
 */
(function () {
  'use strict';
  const ROW = 18;              // px, must match .log-row height in CSS
  const MAX_LINES = 200000;    // keep at most this many lines; older ones are dropped (and we say so)

  class LogView {
    constructor(scroller, notice) {
      this.scroller = scroller;
      this.notice = notice;
      this.spacer = document.createElement('div');
      this.spacer.className = 'log-spacer';
      this.rows = document.createElement('div');
      this.rows.className = 'log-rows';
      scroller.append(this.spacer, this.rows);
      this.lines = [];
      this.dropped = 0;
      this.follow = true;
      this.scheduled = false;
      notice.textContent = this.limitText();
      scroller.addEventListener('scroll', () => {
        this.follow = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - ROW * 2;
        this.schedule();
      });
      new ResizeObserver(() => this.schedule()).observe(scroller);
    }

    // The limit is stated up front, not only once it is reached (a full run prints ~16 000 lines, so
    // otherwise nobody would ever learn that there is a limit).
    limitText() { return `Log keeps the last ${MAX_LINES.toLocaleString()} lines (stdout = OUT, stderr = ERR in red).`; }

    clear() { this.lines = []; this.dropped = 0; this.follow = true; this.notice.textContent = this.limitText(); this.schedule(); }

    append(batch) {
      for (const l of batch) this.lines.push(l);
      if (this.lines.length > MAX_LINES) {
        const extra = this.lines.length - MAX_LINES;
        this.lines.splice(0, extra);
        this.dropped += extra;
        this.notice.textContent = `Log limit reached: showing the last ${MAX_LINES.toLocaleString()} lines; ${this.dropped.toLocaleString()} older lines were dropped.`;
      }
      this.schedule();
    }

    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      requestAnimationFrame(() => { this.scheduled = false; this.render(); });
    }

    render() {
      const sc = this.scroller;
      this.spacer.style.height = `${this.lines.length * ROW}px`;
      if (this.follow) sc.scrollTop = sc.scrollHeight;
      const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 5);
      const last = Math.min(this.lines.length, Math.ceil((sc.scrollTop + sc.clientHeight) / ROW) + 5);
      this.rows.style.transform = `translateY(${first * ROW}px)`;
      const frag = document.createDocumentFragment();
      for (let i = first; i < last; i++) {
        const l = this.lines[i];
        const row = document.createElement('div');
        row.className = l.s === 'e' ? 'log-row err' : 'log-row out';
        const tag = document.createElement('span');
        tag.className = 'log-tag';
        tag.textContent = l.s === 'e' ? 'ERR' : 'OUT';
        const txt = document.createElement('span');
        txt.textContent = l.t;
        row.append(tag, txt);
        frag.append(row);
      }
      this.rows.replaceChildren(frag);
    }
  }

  window.AYRLog = { LogView, MAX_LINES };
})();
