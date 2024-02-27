// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/LICENSE

// This is CodeMirror (https://codemirror.net), a code editor
// implemented in JavaScript on top of the browser's DOM.
//
// You can find some technical background for some of the code below
// at http://marijnhaverbeke.nl/blog/#cm-internals .

(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global.CodeMirror = factory());
  }(this, (function () { 'use strict';
  
    // Kludges for bugs and behavior differences that can't be feature
    // detected are enabled based on userAgent etc sniffing.
    var userAgent = navigator.userAgent;
    var platform = navigator.platform;
  
    var gecko = /gecko\/\d/i.test(userAgent);
    var ie_upto10 = /MSIE \d/.test(userAgent);
    var ie_11up = /Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(userAgent);
    var edge = /Edge\/(\d+)/.exec(userAgent);
    var ie = ie_upto10 || ie_11up || edge;
    var ie_version = ie && (ie_upto10 ? document.documentMode || 6 : +(edge || ie_11up)[1]);
    var webkit = !edge && /WebKit\//.test(userAgent);
    var qtwebkit = webkit && /Qt\/\d+\.\d+/.test(userAgent);
    var chrome = !edge && /Chrome\//.test(userAgent);
    var presto = /Opera\//.test(userAgent);
    var safari = /Apple Computer/.test(navigator.vendor);
    var mac_geMountainLion = /Mac OS X 1\d\D([8-9]|\d\d)\D/.test(userAgent);
    var phantom = /PhantomJS/.test(userAgent);
  
    var ios = !edge && /AppleWebKit/.test(userAgent) && /Mobile\/\w+/.test(userAgent);
    var android = /Android/.test(userAgent);
    // This is woefully incomplete. Suggestions for alternative methods welcome.
    var mobile = ios || android || /webOS|BlackBerry|Opera Mini|Opera Mobi|IEMobile/i.test(userAgent);
    var mac = ios || /Mac/.test(platform);
    var chromeOS = /\bCrOS\b/.test(userAgent);
    var windows = /win/i.test(platform);
  
    var presto_version = presto && userAgent.match(/Version\/(\d*\.\d*)/);
    if (presto_version) { presto_version = Number(presto_version[1]); }
    if (presto_version && presto_version >= 15) { presto = false; webkit = true; }
    // Some browsers use the wrong event properties to signal cmd/ctrl on OS X
    var flipCtrlCmd = mac && (qtwebkit || presto && (presto_version == null || presto_version < 12.11));
    var captureRightClick = gecko || (ie && ie_version >= 9);
  
    function classTest(cls) { return new RegExp("(^|\\s)" + cls + "(?:$|\\s)\\s*") }
  
    var rmClass = function(node, cls) {
      var current = node.className;
      var match = classTest(cls).exec(current);
      if (match) {
        var after = current.slice(match.index + match[0].length);
        node.className = current.slice(0, match.index) + (after ? match[1] + after : "");
      }
    };
  
    function removeChildren(e) {
      for (var count = e.childNodes.length; count > 0; --count)
        { e.removeChild(e.firstChild); }
      return e
    }
  
    function removeChildrenAndAdd(parent, e) {
      return removeChildren(parent).appendChild(e)
    }
  
    function elt(tag, content, className, style) {
      var e = document.createElement(tag);
      if (className) { e.className = className; }
      if (style) { e.style.cssText = style; }
      if (typeof content == "string") { e.appendChild(document.createTextNode(content)); }
      else if (content) { for (var i = 0; i < content.length; ++i) { e.appendChild(content[i]); } }
      return e
    }
    // wrapper for elt, which removes the elt from the accessibility tree
    function eltP(tag, content, className, style) {
      var e = elt(tag, content, className, style);
      e.setAttribute("role", "presentation");
      return e
    }
  
    var range;
    if (document.createRange) { range = function(node, start, end, endNode) {
      var r = document.createRange();
      r.setEnd(endNode || node, end);
      r.setStart(node, start);
      return r
    }; }
    else { range = function(node, start, end) {
      var r = document.body.createTextRange();
      try { r.moveToElementText(node.parentNode); }
      catch(e) { return r }
      r.collapse(true);
      r.moveEnd("character", end);
      r.moveStart("character", start);
      return r
    }; }
  
    function contains(parent, child) {
      if (child.nodeType == 3) // Android browser always returns false when child is a textnode
        { child = child.parentNode; }
      if (parent.contains)
        { return parent.contains(child) }
      do {
        if (child.nodeType == 11) { child = child.host; }
        if (child == parent) { return true }
      } while (child = child.parentNode)
    }
  
    function activeElt() {
      // IE and Edge may throw an "Unspecified Error" when accessing document.activeElement.
      // IE < 10 will throw when accessed while the page is loading or in an iframe.
      // IE > 9 and Edge will throw when accessed in an iframe if document.body is unavailable.
      var activeElement;
      try {
        activeElement = document.activeElement;
      } catch(e) {
        activeElement = document.body || null;
      }
      while (activeElement && activeElement.shadowRoot && activeElement.shadowRoot.activeElement)
        { activeElement = activeElement.shadowRoot.activeElement; }
      return activeElement
    }
  
    function addClass(node, cls) {
      var current = node.className;
      if (!classTest(cls).test(current)) { node.className += (current ? " " : "") + cls; }
    }
    function joinClasses(a, b) {
      var as = a.split(" ");
      for (var i = 0; i < as.length; i++)
        { if (as[i] && !classTest(as[i]).test(b)) { b += " " + as[i]; } }
      return b
    }
  
    var selectInput = function(node) { node.select(); };
    if (ios) // Mobile Safari apparently has a bug where select() is broken.
      { selectInput = function(node) { node.selectionStart = 0; node.selectionEnd = node.value.length; }; }
    else if (ie) // Suppress mysterious IE10 errors
      { selectInput = function(node) { try { node.select(); } catch(_e) {} }; }
  
    function bind(f) {
      var args = Array.prototype.slice.call(arguments, 1);
      return function(){return f.apply(null, args)}
    }
  
    function copyObj(obj, target, overwrite) {
      if (!target) { target = {}; }
      for (var prop in obj)
        { if (obj.hasOwnProperty(prop) && (overwrite !== false || !target.hasOwnProperty(prop)))
          { target[prop] = obj[prop]; } }
      return target
    }
  
    // Counts the column offset in a string, taking tabs into account.
    // Used mostly to find indentation.
    function countColumn(string, end, tabSize, startIndex, startValue) {
      if (end == null) {
        end = string.search(/[^\s\u00a0]/);
        if (end == -1) { end = string.length; }
      }
      for (var i = startIndex || 0, n = startValue || 0;;) {
        var nextTab = string.indexOf("\t", i);
        if (nextTab < 0 || nextTab >= end)
          { return n + (end - i) }
        n += nextTab - i;
        n += tabSize - (n % tabSize);
        i = nextTab + 1;
      }
    }
  
    var Delayed = function() {
      this.id = null;
      this.f = null;
      this.time = 0;
      this.handler = bind(this.onTimeout, this);
    };
    Delayed.prototype.onTimeout = function (self) {
      self.id = 0;
      if (self.time <= +new Date) {
        self.f();
      } else {
        setTimeout(self.handler, self.time - +new Date);
      }
    };
    Delayed.prototype.set = function (ms, f) {
      this.f = f;
      var time = +new Date + ms;
      if (!this.id || time < this.time) {
        clearTimeout(this.id);
        this.id = setTimeout(this.handler, ms);
        this.time = time;
      }
    };
  
    function indexOf(array, elt) {
      for (var i = 0; i < array.length; ++i)
        { if (array[i] == elt) { return i } }
      return -1
    }
  
    // Number of pixels added to scroller and sizer to hide scrollbar
    var scrollerGap = 30;
  
    // Returned or thrown by various protocols to signal 'I'm not
    // handling this'.
    var Pass = {toString: function(){return "CodeMirror.Pass"}};
  
    // Reused option objects for setSelection & friends
    var sel_dontScroll = {scroll: false}, sel_mouse = {origin: "*mouse"}, sel_move = {origin: "+move"};
  
    // The inverse of countColumn -- find the offset that corresponds to
    // a particular column.
    function findColumn(string, goal, tabSize) {
      for (var pos = 0, col = 0;;) {
        var nextTab = string.indexOf("\t", pos);
        if (nextTab == -1) { nextTab = string.length; }
        var skipped = nextTab - pos;
        if (nextTab == string.length || col + skipped >= goal)
          { return pos + Math.min(skipped, goal - col) }
        col += nextTab - pos;
        col += tabSize - (col % tabSize);
        pos = nextTab + 1;
        if (col >= goal) { return pos }
      }
    }
  
    var spaceStrs = [""];
    function spaceStr(n) {
      while (spaceStrs.length <= n)
        { spaceStrs.push(lst(spaceStrs) + " "); }
      return spaceStrs[n]
    }
  
    function lst(arr) { return arr[arr.length-1] }
  
    function map(array, f) {
      var out = [];
      for (var i = 0; i < array.length; i++) { out[i] = f(array[i], i); }
      return out
    }
  
    function insertSorted(array, value, score) {
      var pos = 0, priority = score(value);
      while (pos < array.length && score(array[pos]) <= priority) { pos++; }
      array.splice(pos, 0, value);
    }
  
    function nothing() {}
  
    function createObj(base, props) {
      var inst;
      if (Object.create) {
        inst = Object.create(base);
      } else {
        nothing.prototype = base;
        inst = new nothing();
      }
      if (props) { copyObj(props, inst); }
      return inst
    }
  
    var nonASCIISingleCaseWordChar = /[\u00df\u0587\u0590-\u05f4\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;
    function isWordCharBasic(ch) {
      return /\w/.test(ch) || ch > "\x80" &&
        (ch.toUpperCase() != ch.toLowerCase() || nonASCIISingleCaseWordChar.test(ch))
    }
    function isWordChar(ch, helper) {
      if (!helper) { return isWordCharBasic(ch) }
      if (helper.source.indexOf("\\w") > -1 && isWordCharBasic(ch)) { return true }
      return helper.test(ch)
    }
  
    function isEmpty(obj) {
      for (var n in obj) { if (obj.hasOwnProperty(n) && obj[n]) { return false } }
      return true
    }
  
    // Extending unicode characters. A series of a non-extending char +
    // any number of extending chars is treated as a single unit as far
    // as editing and measuring is concerned. This is not fully correct,
    // since some scripts/fonts/browsers also treat other configurations
    // of code points as a group.
    var extendingChars = /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065e\u0670\u06d6-\u06dc\u06de-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0900-\u0902\u093c\u0941-\u0948\u094d\u0951-\u0955\u0962\u0963\u0981\u09bc\u09be\u09c1-\u09c4\u09cd\u09d7\u09e2\u09e3\u0a01\u0a02\u0a3c\u0a41\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a70\u0a71\u0a75\u0a81\u0a82\u0abc\u0ac1-\u0ac5\u0ac7\u0ac8\u0acd\u0ae2\u0ae3\u0b01\u0b3c\u0b3e\u0b3f\u0b41-\u0b44\u0b4d\u0b56\u0b57\u0b62\u0b63\u0b82\u0bbe\u0bc0\u0bcd\u0bd7\u0c3e-\u0c40\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0cbc\u0cbf\u0cc2\u0cc6\u0ccc\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0d3e\u0d41-\u0d44\u0d4d\u0d57\u0d62\u0d63\u0dca\u0dcf\u0dd2-\u0dd4\u0dd6\u0ddf\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb\u0ebc\u0ec8-\u0ecd\u0f18\u0f19\u0f35\u0f37\u0f39\u0f71-\u0f7e\u0f80-\u0f84\u0f86\u0f87\u0f90-\u0f97\u0f99-\u0fbc\u0fc6\u102d-\u1030\u1032-\u1037\u1039\u103a\u103d\u103e\u1058\u1059\u105e-\u1060\u1071-\u1074\u1082\u1085\u1086\u108d\u109d\u135f\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17b7-\u17bd\u17c6\u17c9-\u17d3\u17dd\u180b-\u180d\u18a9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193b\u1a17\u1a18\u1a56\u1a58-\u1a5e\u1a60\u1a62\u1a65-\u1a6c\u1a73-\u1a7c\u1a7f\u1b00-\u1b03\u1b34\u1b36-\u1b3a\u1b3c\u1b42\u1b6b-\u1b73\u1b80\u1b81\u1ba2-\u1ba5\u1ba8\u1ba9\u1c2c-\u1c33\u1c36\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1dc0-\u1de6\u1dfd-\u1dff\u200c\u200d\u20d0-\u20f0\u2cef-\u2cf1\u2de0-\u2dff\u302a-\u302f\u3099\u309a\ua66f-\ua672\ua67c\ua67d\ua6f0\ua6f1\ua802\ua806\ua80b\ua825\ua826\ua8c4\ua8e0-\ua8f1\ua926-\ua92d\ua947-\ua951\ua980-\ua982\ua9b3\ua9b6-\ua9b9\ua9bc\uaa29-\uaa2e\uaa31\uaa32\uaa35\uaa36\uaa43\uaa4c\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uabe5\uabe8\uabed\udc00-\udfff\ufb1e\ufe00-\ufe0f\ufe20-\ufe26\uff9e\uff9f]/;
    function isExtendingChar(ch) { return ch.charCodeAt(0) >= 768 && extendingChars.test(ch) }
  
    // Returns a number from the range [`0`; `str.length`] unless `pos` is outside that range.
    function skipExtendingChars(str, pos, dir) {
      while ((dir < 0 ? pos > 0 : pos < str.length) && isExtendingChar(str.charAt(pos))) { pos += dir; }
      return pos
    }
  
    // Returns the value from the range [`from`; `to`] that satisfies
    // `pred` and is closest to `from`. Assumes that at least `to`
    // satisfies `pred`. Supports `from` being greater than `to`.
    function findFirst(pred, from, to) {
      // At any point we are certain `to` satisfies `pred`, don't know
      // whether `from` does.
      var dir = from > to ? -1 : 1;
      for (;;) {
        if (from == to) { return from }
        var midF = (from + to) / 2, mid = dir < 0 ? Math.ceil(midF) : Math.floor(midF);
        if (mid == from) { return pred(mid) ? from : to }
        if (pred(mid)) { to = mid; }
        else { from = mid + dir; }
      }
    }
  
    // BIDI HELPERS
  
    function iterateBidiSections(order, from, to, f) {
      if (!order) { return f(from, to, "ltr", 0) }
      var found = false;
      for (var i = 0; i < order.length; ++i) {
        var part = order[i];
        if (part.from < to && part.to > from || from == to && part.to == from) {
          f(Math.max(part.from, from), Math.min(part.to, to), part.level == 1 ? "rtl" : "ltr", i);
          found = true;
        }
      }
      if (!found) { f(from, to, "ltr"); }
    }
  
    var bidiOther = null;
    function getBidiPartAt(order, ch, sticky) {
      var found;
      bidiOther = null;
      for (var i = 0; i < order.length; ++i) {
        var cur = order[i];
        if (cur.from < ch && cur.to > ch) { return i }
        if (cur.to == ch) {
          if (cur.from != cur.to && sticky == "before") { found = i; }
          else { bidiOther = i; }
        }
        if (cur.from == ch) {
          if (cur.from != cur.to && sticky != "before") { found = i; }
          else { bidiOther = i; }
        }
      }
      return found != null ? found : bidiOther
    }
  
    // Bidirectional ordering algorithm
    // See http://unicode.org/reports/tr9/tr9-13.html for the algorithm
    // that this (partially) implements.
  
    // One-char codes used for character types:
    // L (L):   Left-to-Right
    // R (R):   Right-to-Left
    // r (AL):  Right-to-Left Arabic
    // 1 (EN):  European Number
    // + (ES):  European Number Separator
    // % (ET):  European Number Terminator
    // n (AN):  Arabic Number
    // , (CS):  Common Number Separator
    // m (NSM): Non-Spacing Mark
    // b (BN):  Boundary Neutral
    // s (B):   Paragraph Separator
    // t (S):   Segment Separator
    // w (WS):  Whitespace
    // N (ON):  Other Neutrals
  
    // Returns null if characters are ordered as they appear
    // (left-to-right), or an array of sections ({from, to, level}
    // objects) in the order in which they occur visually.
    var bidiOrdering = (function() {
      // Character types for codepoints 0 to 0xff
      var lowTypes = "bbbbbbbbbtstwsbbbbbbbbbbbbbbssstwNN%%%NNNNNN,N,N1111111111NNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNNNLLLLLLLLLLLLLLLLLLLLLLLLLLNNNNbbbbbbsbbbbbbbbbbbbbbbbbbbbbbbbbb,N%%%%NNNNLNNNNN%%11NLNNN1LNNNNNLLLLLLLLLLLLLLLLLLLLLLLNLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLN";
      // Character types for codepoints 0x600 to 0x6f9
      var arabicTypes = "nnnnnnNNr%%r,rNNmmmmmmmmmmmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmmmmmmmmmmmmmmmnnnnnnnnnn%nnrrrmrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrmmmmmmmnNmmmmmmrrmmNmmmmrr1111111111";
      function charType(code) {
        if (code <= 0xf7) { return lowTypes.charAt(code) }
        else if (0x590 <= code && code <= 0x5f4) { return "R" }
        else if (0x600 <= code && code <= 0x6f9) { return arabicTypes.charAt(code - 0x600) }
        else if (0x6ee <= code && code <= 0x8ac) { return "r" }
        else if (0x2000 <= code && code <= 0x200b) { return "w" }
        else if (code == 0x200c) { return "b" }
        else { return "L" }
      }
  
      var bidiRE = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/;
      var isNeutral = /[stwN]/, isStrong = /[LRr]/, countsAsLeft = /[Lb1n]/, countsAsNum = /[1n]/;
  
      function BidiSpan(level, from, to) {
        this.level = level;
        this.from = from; this.to = to;
      }
  
      return function(str, direction) {
        var outerType = direction == "ltr" ? "L" : "R";
  
        if (str.length == 0 || direction == "ltr" && !bidiRE.test(str)) { return false }
        var len = str.length, types = [];
        for (var i = 0; i < len; ++i)
          { types.push(charType(str.charCodeAt(i))); }
  
        // W1. Examine each non-spacing mark (NSM) in the level run, and
        // change the type of the NSM to the type of the previous
        // character. If the NSM is at the start of the level run, it will
        // get the type of sor.
        for (var i$1 = 0, prev = outerType; i$1 < len; ++i$1) {
          var type = types[i$1];
          if (type == "m") { types[i$1] = prev; }
          else { prev = type; }
        }
  
        // W2. Search backwards from each instance of a European number
        // until the first strong type (R, L, AL, or sor) is found. If an
        // AL is found, change the type of the European number to Arabic
        // number.
        // W3. Change all ALs to R.
        for (var i$2 = 0, cur = outerType; i$2 < len; ++i$2) {
          var type$1 = types[i$2];
          if (type$1 == "1" && cur == "r") { types[i$2] = "n"; }
          else if (isStrong.test(type$1)) { cur = type$1; if (type$1 == "r") { types[i$2] = "R"; } }
        }
  
        // W4. A single European separator between two European numbers
        // changes to a European number. A single common separator between
        // two numbers of the same type changes to that type.
        for (var i$3 = 1, prev$1 = types[0]; i$3 < len - 1; ++i$3) {
          var type$2 = types[i$3];
          if (type$2 == "+" && prev$1 == "1" && types[i$3+1] == "1") { types[i$3] = "1"; }
          else if (type$2 == "," && prev$1 == types[i$3+1] &&
                   (prev$1 == "1" || prev$1 == "n")) { types[i$3] = prev$1; }
          prev$1 = type$2;
        }
  
        // W5. A sequence of European terminators adjacent to European
        // numbers changes to all European numbers.
        // W6. Otherwise, separators and terminators change to Other
        // Neutral.
        for (var i$4 = 0; i$4 < len; ++i$4) {
          var type$3 = types[i$4];
          if (type$3 == ",") { types[i$4] = "N"; }
          else if (type$3 == "%") {
            var end = (void 0);
            for (end = i$4 + 1; end < len && types[end] == "%"; ++end) {}
            var replace = (i$4 && types[i$4-1] == "!") || (end < len && types[end] == "1") ? "1" : "N";
            for (var j = i$4; j < end; ++j) { types[j] = replace; }
            i$4 = end - 1;
          }
        }
  
        // W7. Search backwards from each instance of a European number
        // until the first strong type (R, L, or sor) is found. If an L is
        // found, then change the type of the European number to L.
        for (var i$5 = 0, cur$1 = outerType; i$5 < len; ++i$5) {
          var type$4 = types[i$5];
          if (cur$1 == "L" && type$4 == "1") { types[i$5] = "L"; }
          else if (isStrong.test(type$4)) { cur$1 = type$4; }
        }
  
        // N1. A sequence of neutrals takes the direction of the
        // surrounding strong text if the text on both sides has the same
        // direction. European and Arabic numbers act as if they were R in
        // terms of their influence on neutrals. Start-of-level-run (sor)
        // and end-of-level-run (eor) are used at level run boundaries.
        // N2. Any remaining neutrals take the embedding direction.
        for (var i$6 = 0; i$6 < len; ++i$6) {
          if (isNeutral.test(types[i$6])) {
            var end$1 = (void 0);
            for (end$1 = i$6 + 1; end$1 < len && isNeutral.test(types[end$1]); ++end$1) {}
            var before = (i$6 ? types[i$6-1] : outerType) == "L";
            var after = (end$1 < len ? types[end$1] : outerType) == "L";
            var replace$1 = before == after ? (before ? "L" : "R") : outerType;
            for (var j$1 = i$6; j$1 < end$1; ++j$1) { types[j$1] = replace$1; }
            i$6 = end$1 - 1;
          }
        }
  
        // Here we depart from the documented algorithm, in order to avoid
        // building up an actual levels array. Since there are only three
        // levels (0, 1, 2) in an implementation that doesn't take
        // explicit embedding into account, we can build up the order on
        // the fly, without following the level-based algorithm.
        var order = [], m;
        for (var i$7 = 0; i$7 < len;) {
          if (countsAsLeft.test(types[i$7])) {
            var start = i$7;
            for (++i$7; i$7 < len && countsAsLeft.test(types[i$7]); ++i$7) {}
            order.push(new BidiSpan(0, start, i$7));
          } else {
            var pos = i$7, at = order.length, isRTL = direction == "rtl" ? 1 : 0;
            for (++i$7; i$7 < len && types[i$7] != "L"; ++i$7) {}
            for (var j$2 = pos; j$2 < i$7;) {
              if (countsAsNum.test(types[j$2])) {
                if (pos < j$2) { order.splice(at, 0, new BidiSpan(1, pos, j$2)); at += isRTL; }
                var nstart = j$2;
                for (++j$2; j$2 < i$7 && countsAsNum.test(types[j$2]); ++j$2) {}
                order.splice(at, 0, new BidiSpan(2, nstart, j$2));
                at += isRTL;
                pos = j$2;
              } else { ++j$2; }
            }
            if (pos < i$7) { order.splice(at, 0, new BidiSpan(1, pos, i$7)); }
          }
        }
        if (direction == "ltr") {
          if (order[0].level == 1 && (m = str.match(/^\s+/))) {
            order[0].from = m[0].length;
            order.unshift(new BidiSpan(0, 0, m[0].length));
          }
          if (lst(order).level == 1 && (m = str.match(/\s+$/))) {
            lst(order).to -= m[0].length;
            order.push(new BidiSpan(0, len - m[0].length, len));
          }
        }
  
        return direction == "rtl" ? order.reverse() : order
      }
    })();
  
    // Get the bidi ordering for the given line (and cache it). Returns
    // false for lines that are fully left-to-right, and an array of
    // BidiSpan objects otherwise.
    function getOrder(line, direction) {
      var order = line.order;
      if (order == null) { order = line.order = bidiOrdering(line.text, direction); }
      return order
    }
  
    // EVENT HANDLING
  
    // Lightweight event framework. on/off also work on DOM nodes,
    // registering native DOM handlers.
  
    var noHandlers = [];
  
    var on = function(emitter, type, f) {
      if (emitter.addEventListener) {
        emitter.addEventListener(type, f, false);
      } else if (emitter.attachEvent) {
        emitter.attachEvent("on" + type, f);
      } else {
        var map$$1 = emitter._handlers || (emitter._handlers = {});
        map$$1[type] = (map$$1[type] || noHandlers).concat(f);
      }
    };
  
    function getHandlers(emitter, type) {
      return emitter._handlers && emitter._handlers[type] || noHandlers
    }
  
    function off(emitter, type, f) {
      if (emitter.removeEventListener) {
        emitter.removeEventListener(type, f, false);
      } else if (emitter.detachEvent) {
        emitter.detachEvent("on" + type, f);
      } else {
        var map$$1 = emitter._handlers, arr = map$$1 && map$$1[type];
        if (arr) {
          var index = indexOf(arr, f);
          if (index > -1)
            { map$$1[type] = arr.slice(0, index).concat(arr.slice(index + 1)); }
        }
      }
    }
  
    function signal(emitter, type /*, values...*/) {
      var handlers = getHandlers(emitter, type);
      if (!handlers.length) { return }
      var args = Array.prototype.slice.call(arguments, 2);
      for (var i = 0; i < handlers.length; ++i) { handlers[i].apply(null, args); }
    }
  
    // The DOM events that CodeMirror handles can be overridden by
    // registering a (non-DOM) handler on the editor for the event name,
    // and preventDefault-ing the event in that handler.
    function signalDOMEvent(cm, e, override) {
      if (typeof e == "string")
        { e = {type: e, preventDefault: function() { this.defaultPrevented = true; }}; }
      signal(cm, override || e.type, cm, e);
      return e_defaultPrevented(e) || e.codemirrorIgnore
    }
  
    function signalCursorActivity(cm) {
      var arr = cm._handlers && cm._handlers.cursorActivity;
      if (!arr) { return }
      var set = cm.curOp.cursorActivityHandlers || (cm.curOp.cursorActivityHandlers = []);
      for (var i = 0; i < arr.length; ++i) { if (indexOf(set, arr[i]) == -1)
        { set.push(arr[i]); } }
    }
  
    function hasHandler(emitter, type) {
      return getHandlers(emitter, type).length > 0
    }
  
    // Add on and off methods to a constructor's prototype, to make
    // registering events on such objects more convenient.
    function eventMixin(ctor) {
      ctor.prototype.on = function(type, f) {on(this, type, f);};
      ctor.prototype.off = function(type, f) {off(this, type, f);};
    }
  
    // Due to the fact that we still support jurassic IE versions, some
    // compatibility wrappers are needed.
  
    function e_preventDefault(e) {
      if (e.preventDefault) { e.preventDefault(); }
      else { e.returnValue = false; }
    }
    function e_stopPropagation(e) {
      if (e.stopPropagation) { e.stopPropagation(); }
      else { e.cancelBubble = true; }
    }
    function e_defaultPrevented(e) {
      return e.defaultPrevented != null ? e.defaultPrevented : e.returnValue == false
    }
    function e_stop(e) {e_preventDefault(e); e_stopPropagation(e);}
  
    function e_target(e) {return e.target || e.srcElement}
    function e_button(e) {
      var b = e.which;
      if (b == null) {
        if (e.button & 1) { b = 1; }
        else if (e.button & 2) { b = 3; }
        else if (e.button & 4) { b = 2; }
      }
      if (mac && e.ctrlKey && b == 1) { b = 3; }
      return b
    }
  
    // Detect drag-and-drop
    var dragAndDrop = function() {
      // There is *some* kind of drag-and-drop support in IE6-8, but I
      // couldn't get it to work yet.
      if (ie && ie_version < 9) { return false }
      var div = elt('div');
      return "draggable" in div || "dragDrop" in div
    }();
  
    var zwspSupported;
    function zeroWidthElement(measure) {
      if (zwspSupported == null) {
        var test = elt("span", "\u200b");
        removeChildrenAndAdd(measure, elt("span", [test, document.createTextNode("x")]));
        if (measure.firstChild.offsetHeight != 0)
          { zwspSupported = test.offsetWidth <= 1 && test.offsetHeight > 2 && !(ie && ie_version < 8); }
      }
      var node = zwspSupported ? elt("span", "\u200b") :
        elt("span", "\u00a0", null, "display: inline-block; width: 1px; margin-right: -1px");
      node.setAttribute("cm-text", "");
      return node
    }
  
    // Feature-detect IE's crummy client rect reporting for bidi text
    var badBidiRects;
    function hasBadBidiRects(measure) {
      if (badBidiRects != null) { return badBidiRects }
      var txt = removeChildrenAndAdd(measure, document.createTextNode("A\u062eA"));
      var r0 = range(txt, 0, 1).getBoundingClientRect();
      var r1 = range(txt, 1, 2).getBoundingClientRect();
      removeChildren(measure);
      if (!r0 || r0.left == r0.right) { return false } // Safari returns null in some cases (#2780)
      return badBidiRects = (r1.right - r0.right < 3)
    }
  
    // See if "".split is the broken IE version, if so, provide an
    // alternative way to split lines.
    var splitLinesAuto = "\n\nb".split(/\n/).length != 3 ? function (string) {
      var pos = 0, result = [], l = string.length;
      while (pos <= l) {
        var nl = string.indexOf("\n", pos);
        if (nl == -1) { nl = string.length; }
        var line = string.slice(pos, string.charAt(nl - 1) == "\r" ? nl - 1 : nl);
        var rt = line.indexOf("\r");
        if (rt != -1) {
          result.push(line.slice(0, rt));
          pos += rt + 1;
        } else {
          result.push(line);
          pos = nl + 1;
        }
      }
      return result
    } : function (string) { return string.split(/\r\n?|\n/); };
  
    var hasSelection = window.getSelection ? function (te) {
      try { return te.selectionStart != te.selectionEnd }
      catch(e) { return false }
    } : function (te) {
      var range$$1;
      try {range$$1 = te.ownerDocument.selection.createRange();}
      catch(e) {}
      if (!range$$1 || range$$1.parentElement() != te) { return false }
      return range$$1.compareEndPoints("StartToEnd", range$$1) != 0
    };
  
    var hasCopyEvent = (function () {
      var e = elt("div");
      if ("oncopy" in e) { return true }
      e.setAttribute("oncopy", "return;");
      return typeof e.oncopy == "function"
    })();
  
    var badZoomedRects = null;
    function hasBadZoomedRects(measure) {
      if (badZoomedRects != null) { return badZoomedRects }
      var node = removeChildrenAndAdd(measure, elt("span", "x"));
      var normal = node.getBoundingClientRect();
      var fromRange = range(node, 0, 1).getBoundingClientRect();
      return badZoomedRects = Math.abs(normal.left - fromRange.left) > 1
    }
  
    // Known modes, by name and by MIME
    var modes = {}, mimeModes = {};
  
    // Extra arguments are stored as the mode's dependencies, which is
    // used by (legacy) mechanisms like loadmode.js to automatically
    // load a mode. (Preferred mechanism is the require/define calls.)
    function defineMode(name, mode) {
      if (arguments.length > 2)
        { mode.dependencies = Array.prototype.slice.call(arguments, 2); }
      modes[name] = mode;
    }
  
    function defineMIME(mime, spec) {
      mimeModes[mime] = spec;
    }
  
    // Given a MIME type, a {name, ...options} config object, or a name
    // string, return a mode config object.
    function resolveMode(spec) {
      if (typeof spec == "string" && mimeModes.hasOwnProperty(spec)) {
        spec = mimeModes[spec];
      } else if (spec && typeof spec.name == "string" && mimeModes.hasOwnProperty(spec.name)) {
        var found = mimeModes[spec.name];
        if (typeof found == "string") { found = {name: found}; }
        spec = createObj(found, spec);
        spec.name = found.name;
      } else if (typeof spec == "string" && /^[\w\-]+\/[\w\-]+\+xml$/.test(spec)) {
        return resolveMode("application/xml")
      } else if (typeof spec == "string" && /^[\w\-]+\/[\w\-]+\+json$/.test(spec)) {
        return resolveMode("application/json")
      }
      if (typeof spec == "string") { return {name: spec} }
      else { return spec || {name: "null"} }
    }
  
    // Given a mode spec (anything that resolveMode accepts), find and
    // initialize an actual mode object.
    function getMode(options, spec) {
      spec = resolveMode(spec);
      var mfactory = modes[spec.name];
      if (!mfactory) { return getMode(options, "text/plain") }
      var modeObj = mfactory(options, spec);
      if (modeExtensions.hasOwnProperty(spec.name)) {
        var exts = modeExtensions[spec.name];
        for (var prop in exts) {
          if (!exts.hasOwnProperty(prop)) { continue }
          if (modeObj.hasOwnProperty(prop)) { modeObj["_" + prop] = modeObj[prop]; }
          modeObj[prop] = exts[prop];
        }
      }
      modeObj.name = spec.name;
      if (spec.helperType) { modeObj.helperType = spec.helperType; }
      if (spec.modeProps) { for (var prop$1 in spec.modeProps)
        { modeObj[prop$1] = spec.modeProps[prop$1]; } }
  
      return modeObj
    }
  
    // This can be used to attach properties to mode objects from
    // outside the actual mode definition.
    var modeExtensions = {};
    function extendMode(mode, properties) {
      var exts = modeExtensions.hasOwnProperty(mode) ? modeExtensions[mode] : (modeExtensions[mode] = {});
      copyObj(properties, exts);
    }
  
    function copyState(mode, state) {
      if (state === true) { return state }
      if (mode.copyState) { return mode.copyState(state) }
      var nstate = {};
      for (var n in state) {
        var val = state[n];
        if (val instanceof Array) { val = val.concat([]); }
        nstate[n] = val;
      }
      return nstate
    }
  
    // Given a mode and a state (for that mode), find the inner mode and
    // state at the position that the state refers to.
    function innerMode(mode, state) {
      var info;
      while (mode.innerMode) {
        info = mode.innerMode(state);
        if (!info || info.mode == mode) { break }
        state = info.state;
        mode = info.mode;
      }
      return info || {mode: mode, state: state}
    }
  
    function startState(mode, a1, a2) {
      return mode.startState ? mode.startState(a1, a2) : true
    }
  
    // STRING STREAM
  
    // Fed to the mode parsers, provides helper functions to make
    // parsers more succinct.
  
    var StringStream = function(string, tabSize, lineOracle) {
      this.pos = this.start = 0;
      this.string = string;
      this.tabSize = tabSize || 8;
      this.lastColumnPos = this.lastColumnValue = 0;
      this.lineStart = 0;
      this.lineOracle = lineOracle;
    };
  
    StringStream.prototype.eol = function () {return this.pos >= this.string.length};
    StringStream.prototype.sol = function () {return this.pos == this.lineStart};
    StringStream.prototype.peek = function () {return this.string.charAt(this.pos) || undefined};
    StringStream.prototype.next = function () {
      if (this.pos < this.string.length)
        { return this.string.charAt(this.pos++) }
    };
    StringStream.prototype.eat = function (match) {
      var ch = this.string.charAt(this.pos);
      var ok;
      if (typeof match == "string") { ok = ch == match; }
      else { ok = ch && (match.test ? match.test(ch) : match(ch)); }
      if (ok) {++this.pos; return ch}
    };
    StringStream.prototype.eatWhile = function (match) {
      var start = this.pos;
      while (this.eat(match)){}
      return this.pos > start
    };
    StringStream.prototype.eatSpace = function () {
        var this$1 = this;
  
      var start = this.pos;
      while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) { ++this$1.pos; }
      return this.pos > start
    };
    StringStream.prototype.skipToEnd = function () {this.pos = this.string.length;};
    StringStream.prototype.skipTo = function (ch) {
      var found = this.string.indexOf(ch, this.pos);
      if (found > -1) {this.pos = found; return true}
    };
    StringStream.prototype.backUp = function (n) {this.pos -= n;};
    StringStream.prototype.column = function () {
      if (this.lastColumnPos < this.start) {
        this.lastColumnValue = countColumn(this.string, this.start, this.tabSize, this.lastColumnPos, this.lastColumnValue);
        this.lastColumnPos = this.start;
      }
      return this.lastColumnValue - (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0)
    };
    StringStream.prototype.indentation = function () {
      return countColumn(this.string, null, this.tabSize) -
        (this.lineStart ? countColumn(this.string, this.lineStart, this.tabSize) : 0)
    };
    StringStream.prototype.match = function (pattern, consume, caseInsensitive) {
      if (typeof pattern == "string") {
        var cased = function (str) { return caseInsensitive ? str.toLowerCase() : str; };
        var substr = this.string.substr(this.pos, pattern.length);
        if (cased(substr) == cased(pattern)) {
          if (consume !== false) { this.pos += pattern.length; }
          return true
        }
      } else {
        var match = this.string.slice(this.pos).match(pattern);
        if (match && match.index > 0) { return null }
        if (match && consume !== false) { this.pos += match[0].length; }
        return match
      }
    };
    StringStream.prototype.current = function (){return this.string.slice(this.start, this.pos)};
    StringStream.prototype.hideFirstChars = function (n, inner) {
      this.lineStart += n;
      try { return inner() }
      finally { this.lineStart -= n; }
    };
    StringStream.prototype.lookAhead = function (n) {
      var oracle = this.lineOracle;
      return oracle && oracle.lookAhead(n)
    };
    StringStream.prototype.baseToken = function () {
      var oracle = this.lineOracle;
      return oracle && oracle.baseToken(this.pos)
    };
  
    // Find the line object corresponding to the given line number.
    function getLine(doc, n) {
      n -= doc.first;
      if (n < 0 || n >= doc.size) { throw new Error("There is no line " + (n + doc.first) + " in the document.") }
      var chunk = doc;
      while (!chunk.lines) {
        for (var i = 0;; ++i) {
          var child = chunk.children[i], sz = child.chunkSize();
          if (n < sz) { chunk = child; break }
          n -= sz;
        }
      }
      return chunk.lines[n]
    }
  
    // Get the part of a document between two positions, as an array of
    // strings.
    function getBetween(doc, start, end) {
      var out = [], n = start.line;
      doc.iter(start.line, end.line + 1, function (line) {
        var text = line.text;
        if (n == end.line) { text = text.slice(0, end.ch); }
        if (n == start.line) { text = text.slice(start.ch); }
        out.push(text);
        ++n;
      });
      return out
    }
    // Get the lines between from and to, as array of strings.
    function getLines(doc, from, to) {
      var out = [];
      doc.iter(from, to, function (line) { out.push(line.text); }); // iter aborts when callback returns truthy value
      return out
    }
  
    // Update the height of a line, propagating the height change
    // upwards to parent nodes.
    function updateLineHeight(line, height) {
      var diff = height - line.height;
      if (diff) { for (var n = line; n; n = n.parent) { n.height += diff; } }
    }
  
    // Given a line object, find its line number by walking up through
    // its parent links.
    function lineNo(line) {
      if (line.parent == null) { return null }
      var cur = line.parent, no = indexOf(cur.lines, line);
      for (var chunk = cur.parent; chunk; cur = chunk, chunk = chunk.parent) {
        for (var i = 0;; ++i) {
          if (chunk.children[i] == cur) { break }
          no += chunk.children[i].chunkSize();
        }
      }
      return no + cur.first
    }
  
    // Find the line at the given vertical position, using the height
    // information in the document tree.
    function lineAtHeight(chunk, h) {
      var n = chunk.first;
      outer: do {
        for (var i$1 = 0; i$1 < chunk.children.length; ++i$1) {
          var child = chunk.children[i$1], ch = child.height;
          if (h < ch) { chunk = child; continue outer }
          h -= ch;
          n += child.chunkSize();
        }
        return n
      } while (!chunk.lines)
      var i = 0;
      for (; i < chunk.lines.length; ++i) {
        var line = chunk.lines[i], lh = line.height;
        if (h < lh) { break }
        h -= lh;
      }
      return n + i
    }
  
    function isLine(doc, l) {return l >= doc.first && l < doc.first + doc.size}
  
    function lineNumberFor(options, i) {
      return String(options.lineNumberFormatter(i + options.firstLineNumber))
    }
  
    // A Pos instance represents a position within the text.
    function Pos(line, ch, sticky) {
      if ( sticky === void 0 ) sticky = null;
  
      if (!(this instanceof Pos)) { return new Pos(line, ch, sticky) }
      this.line = line;
      this.ch = ch;
      this.sticky = sticky;
    }
  
    // Compare two positions, return 0 if they are the same, a negative
    // number when a is less, and a positive number otherwise.
    function cmp(a, b) { return a.line - b.line || a.ch - b.ch }
  
    function equalCursorPos(a, b) { return a.sticky == b.sticky && cmp(a, b) == 0 }
  
    function copyPos(x) {return Pos(x.line, x.ch)}
    function maxPos(a, b) { return cmp(a, b) < 0 ? b : a }
    function minPos(a, b) { return cmp(a, b) < 0 ? a : b }
  
    // Most of the external API clips given positions to make sure they
    // actually exist within the document.
    function clipLine(doc, n) {return Math.max(doc.first, Math.min(n, doc.first + doc.size - 1))}
    function clipPos(doc, pos) {
      if (pos.line < doc.first) { return Pos(doc.first, 0) }
      var last = doc.first + doc.size - 1;
      if (pos.line > last) { return Pos(last, getLine(doc, last).text.length) }
      return clipToLen(pos, getLine(doc, pos.line).text.length)
    }
    function clipToLen(pos, linelen) {
      var ch = pos.ch;
      if (ch == null || ch > linelen) { return Pos(pos.line, linelen) }
      else if (ch < 0) { return Pos(pos.line, 0) }
      else { return pos }
    }
    function clipPosArray(doc, array) {
      var out = [];
      for (var i = 0; i < array.length; i++) { out[i] = clipPos(doc, array[i]); }
      return out
    }
  
    var SavedContext = function(state, lookAhead) {
      this.state = state;
      this.lookAhead = lookAhead;
    };
  
    var Context = function(doc, state, line, lookAhead) {
      this.state = state;
      this.doc = doc;
      this.line = line;
      this.maxLookAhead = lookAhead || 0;
      this.baseTokens = null;
      this.baseTokenPos = 1;
    };
  
    Context.prototype.lookAhead = function (n) {
      var line = this.doc.getLine(this.line + n);
      if (line != null && n > this.maxLookAhead) { this.maxLookAhead = n; }
      return line
    };
  
    Context.prototype.baseToken = function (n) {
        var this$1 = this;
  
      if (!this.baseTokens) { return null }
      while (this.baseTokens[this.baseTokenPos] <= n)
        { this$1.baseTokenPos += 2; }
      var type = this.baseTokens[this.baseTokenPos + 1];
      return {type: type && type.replace(/( |^)overlay .*/, ""),
              size: this.baseTokens[this.baseTokenPos] - n}
    };
  
    Context.prototype.nextLine = function () {
      this.line++;
      if (this.maxLookAhead > 0) { this.maxLookAhead--; }
    };
  
    Context.fromSaved = function (doc, saved, line) {
      if (saved instanceof SavedContext)
        { return new Context(doc, copyState(doc.mode, saved.state), line, saved.lookAhead) }
      else
        { return new Context(doc, copyState(doc.mode, saved), line) }
    };
  
    Context.prototype.save = function (copy) {
      var state = copy !== false ? copyState(this.doc.mode, this.state) : this.state;
      return this.maxLookAhead > 0 ? new SavedContext(state, this.maxLookAhead) : state
    };
  
  
    // Compute a style array (an array starting with a mode generation
    // -- for invalidation -- followed by pairs of end positions and
    // style strings), which is used to highlight the tokens on the
    // line.
    function highlightLine(cm, line, context, forceToEnd) {
      // A styles array always starts with a number identifying the
      // mode/overlays that it is based on (for easy invalidation).
      var st = [cm.state.modeGen], lineClasses = {};
      // Compute the base array of styles
      runMode(cm, line.text, cm.doc.mode, context, function (end, style) { return st.push(end, style); },
              lineClasses, forceToEnd);
      var state = context.state;
  
      // Run overlays, adjust style array.
      var loop = function ( o ) {
        context.baseTokens = st;
        var overlay = cm.state.overlays[o], i = 1, at = 0;
        context.state = true;
        runMode(cm, line.text, overlay.mode, context, function (end, style) {
          var start = i;
          // Ensure there's a token end at the current position, and that i points at it
          while (at < end) {
            var i_end = st[i];
            if (i_end > end)
              { st.splice(i, 1, end, st[i+1], i_end); }
            i += 2;
            at = Math.min(end, i_end);
          }
          if (!style) { return }
          if (overlay.opaque) {
            st.splice(start, i - start, end, "overlay " + style);
            i = start + 2;
          } else {
            for (; start < i; start += 2) {
              var cur = st[start+1];
              st[start+1] = (cur ? cur + " " : "") + "overlay " + style;
            }
          }
        }, lineClasses);
        context.state = state;
        context.baseTokens = null;
        context.baseTokenPos = 1;
      };
  
      for (var o = 0; o < cm.state.overlays.length; ++o) loop( o );
  
      return {styles: st, classes: lineClasses.bgClass || lineClasses.textClass ? lineClasses : null}
    }
  
    function getLineStyles(cm, line, updateFrontier) {
      if (!line.styles || line.styles[0] != cm.state.modeGen) {
        var context = getContextBefore(cm, lineNo(line));
        var resetState = line.text.length > cm.options.maxHighlightLength && copyState(cm.doc.mode, context.state);
        var result = highlightLine(cm, line, context);
        if (resetState) { context.state = resetState; }
        line.stateAfter = context.save(!resetState);
        line.styles = result.styles;
        if (result.classes) { line.styleClasses = result.classes; }
        else if (line.styleClasses) { line.styleClasses = null; }
        if (updateFrontier === cm.doc.highlightFrontier)
          { cm.doc.modeFrontier = Math.max(cm.doc.modeFrontier, ++cm.doc.highlightFrontier); }
      }
      return line.styles
    }
  
    function getContextBefore(cm, n, precise) {
      var doc = cm.doc, display = cm.display;
      if (!doc.mode.startState) { return new Context(doc, true, n) }
      var start = findStartLine(cm, n, precise);
      var saved = start > doc.first && getLine(doc, start - 1).stateAfter;
      var context = saved ? Context.fromSaved(doc, saved, start) : new Context(doc, startState(doc.mode), start);
  
      doc.iter(start, n, function (line) {
        processLine(cm, line.text, context);
        var pos = context.line;
        line.stateAfter = pos == n - 1 || pos % 5 == 0 || pos >= display.viewFrom && pos < display.viewTo ? context.save() : null;
        context.nextLine();
      });
      if (precise) { doc.modeFrontier = context.line; }
      return context
    }
  
    // Lightweight form of highlight -- proceed over this line and
    // update state, but don't save a style array. Used for lines that
    // aren't currently visible.
    function processLine(cm, text, context, startAt) {
      var mode = cm.doc.mode;
      var stream = new StringStream(text, cm.options.tabSize, context);
      stream.start = stream.pos = startAt || 0;
      if (text == "") { callBlankLine(mode, context.state); }
      while (!stream.eol()) {
        readToken(mode, stream, context.state);
        stream.start = stream.pos;
      }
    }
  
    function callBlankLine(mode, state) {
      if (mode.blankLine) { return mode.blankLine(state) }
      if (!mode.innerMode) { return }
      var inner = innerMode(mode, state);
      if (inner.mode.blankLine) { return inner.mode.blankLine(inner.state) }
    }
  
    function readToken(mode, stream, state, inner) {
      for (var i = 0; i < 10; i++) {
        if (inner) { inner[0] = innerMode(mode, state).mode; }
        var style = mode.token(stream, state);
        if (stream.pos > stream.start) { return style }
      }
      throw new Error("Mode " + mode.name + " failed to advance stream.")
    }
  
    var Token = function(stream, type, state) {
      this.start = stream.start; this.end = stream.pos;
      this.string = stream.current();
      this.type = type || null;
      this.state = state;
    };
  
    // Utility for getTokenAt and getLineTokens
    function takeToken(cm, pos, precise, asArray) {
      var doc = cm.doc, mode = doc.mode, style;
      pos = clipPos(doc, pos);
      var line = getLine(doc, pos.line), context = getContextBefore(cm, pos.line, precise);
      var stream = new StringStream(line.text, cm.options.tabSize, context), tokens;
      if (asArray) { tokens = []; }
      while ((asArray || stream.pos < pos.ch) && !stream.eol()) {
        stream.start = stream.pos;
        style = readToken(mode, stream, context.state);
        if (asArray) { tokens.push(new Token(stream, style, copyState(doc.mode, context.state))); }
      }
      return asArray ? tokens : new Token(stream, style, context.state)
    }
  
    function extractLineClasses(type, output) {
      if (type) { for (;;) {
        var lineClass = type.match(/(?:^|\s+)line-(background-)?(\S+)/);
        if (!lineClass) { break }
        type = type.slice(0, lineClass.index) + type.slice(lineClass.index + lineClass[0].length);
        var prop = lineClass[1] ? "bgClass" : "textClass";
        if (output[prop] == null)
          { output[prop] = lineClass[2]; }
        else if (!(new RegExp("(?:^|\s)" + lineClass[2] + "(?:$|\s)")).test(output[prop]))
          { output[prop] += " " + lineClass[2]; }
      } }
      return type
    }
  
    // Run the given mode's parser over a line, calling f for each token.
    function runMode(cm, text, mode, context, f, lineClasses, forceToEnd) {
      var flattenSpans = mode.flattenSpans;
      if (flattenSpans == null) { flattenSpans = cm.options.flattenSpans; }
      var curStart = 0, curStyle = null;
      var stream = new StringStream(text, cm.options.tabSize, context), style;
      var inner = cm.options.addModeClass && [null];
      if (text == "") { extractLineClasses(callBlankLine(mode, context.state), lineClasses); }
      while (!stream.eol()) {
        if (stream.pos > cm.options.maxHighlightLength) {
          flattenSpans = false;
          if (forceToEnd) { processLine(cm, text, context, stream.pos); }
          stream.pos = text.length;
          style = null;
        } else {
          style = extractLineClasses(readToken(mode, stream, context.state, inner), lineClasses);
        }
        if (inner) {
          var mName = inner[0].name;
          if (mName) { style = "m-" + (style ? mName + " " + style : mName); }
        }
        if (!flattenSpans || curStyle != style) {
          while (curStart < stream.start) {
            curStart = Math.min(stream.start, curStart + 5000);
            f(curStart, curStyle);
          }
          curStyle = style;
        }
        stream.start = stream.pos;
      }
      while (curStart < stream.pos) {
        // Webkit seems to refuse to render text nodes longer than 57444
        // characters, and returns inaccurate measurements in nodes
        // starting around 5000 chars.
        var pos = Math.min(stream.pos, curStart + 5000);
        f(pos, curStyle);
        curStart = pos;
      }
    }
  
    // Finds the line to start with when starting a parse. Tries to
    // find a line with a stateAfter, so that it can start with a
    // valid state. If that fails, it returns the line with the
    // smallest indentation, which tends to need the least context to
    // parse correctly.
    function findStartLine(cm, n, precise) {
      var minindent, minline, doc = cm.doc;
      var lim = precise ? -1 : n - (cm.doc.mode.innerMode ? 1000 : 100);
      for (var search = n; search > lim; --search) {
        if (search <= doc.first) { return doc.first }
        var line = getLine(doc, search - 1), after = line.stateAfter;
        if (after && (!precise || search + (after instanceof SavedContext ? after.lookAhead : 0) <= doc.modeFrontier))
          { return search }
        var indented = countColumn(line.text, null, cm.options.tabSize);
        if (minline == null || minindent > indented) {
          minline = search - 1;
          minindent = indented;
        }
      }
      return minline
    }
  
    function retreatFrontier(doc, n) {
      doc.modeFrontier = Math.min(doc.modeFrontier, n);
      if (doc.highlightFrontier < n - 10) { return }
      var start = doc.first;
      for (var line = n - 1; line > start; line--) {
        var saved = getLine(doc, line).stateAfter;
        // change is on 3
        // state on line 1 looked ahead 2 -- so saw 3
        // test 1 + 2 < 3 should cover this
        if (saved && (!(saved instanceof SavedContext) || line + saved.lookAhead < n)) {
          start = line + 1;
          break
        }
      }
      doc.highlightFrontier = Math.min(doc.highlightFrontier, start);
    }
  
    // Optimize some code when these features are not used.
    var sawReadOnlySpans = false, sawCollapsedSpans = false;
  
    function seeReadOnlySpans() {
      sawReadOnlySpans = true;
    }
  
    function seeCollapsedSpans() {
      sawCollapsedSpans = true;
    }
  
    // TEXTMARKER SPANS
  
    function MarkedSpan(marker, from, to) {
      this.marker = marker;
      this.from = from; this.to = to;
    }
  
    // Search an array of spans for a span matching the given marker.
    function getMarkedSpanFor(spans, marker) {
      if (spans) { for (var i = 0; i < spans.length; ++i) {
        var span = spans[i];
        if (span.marker == marker) { return span }
      } }
    }
    // Remove a span from an array, returning undefined if no spans are
    // left (we don't store arrays for lines without spans).
    function removeMarkedSpan(spans, span) {
      var r;
      for (var i = 0; i < spans.length; ++i)
        { if (spans[i] != span) { (r || (r = [])).push(spans[i]); } }
      return r
    }
    // Add a span to a line.
    function addMarkedSpan(line, span) {
      line.markedSpans = line.markedSpans ? line.markedSpans.concat([span]) : [span];
      span.marker.attachLine(line);
    }
  
    // Used for the algorithm that adjusts markers for a change in the
    // document. These functions cut an array of spans at a given
    // character position, returning an array of remaining chunks (or
    // undefined if nothing remains).
    function markedSpansBefore(old, startCh, isInsert) {
      var nw;
      if (old) { for (var i = 0; i < old.length; ++i) {
        var span = old[i], marker = span.marker;
        var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= startCh : span.from < startCh);
        if (startsBefore || span.from == startCh && marker.type == "bookmark" && (!isInsert || !span.marker.insertLeft)) {
          var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= startCh : span.to > startCh)
          ;(nw || (nw = [])).push(new MarkedSpan(marker, span.from, endsAfter ? null : span.to));
        }
      } }
      return nw
    }
    function markedSpansAfter(old, endCh, isInsert) {
      var nw;
      if (old) { for (var i = 0; i < old.length; ++i) {
        var span = old[i], marker = span.marker;
        var endsAfter = span.to == null || (marker.inclusiveRight ? span.to >= endCh : span.to > endCh);
        if (endsAfter || span.from == endCh && marker.type == "bookmark" && (!isInsert || span.marker.insertLeft)) {
          var startsBefore = span.from == null || (marker.inclusiveLeft ? span.from <= endCh : span.from < endCh)
          ;(nw || (nw = [])).push(new MarkedSpan(marker, startsBefore ? null : span.from - endCh,
                                                span.to == null ? null : span.to - endCh));
        }
      } }
      return nw
    }
  
    // Given a change object, compute the new set of marker spans that
    // cover the line in which the change took place. Removes spans
    // entirely within the change, reconnects spans belonging to the
    // same marker that appear on both sides of the change, and cuts off
    // spans partially within the change. Returns an array of span
    // arrays with one element for each line in (after) the change.
    function stretchSpansOverChange(doc, change) {
      if (change.full) { return null }
      var oldFirst = isLine(doc, change.from.line) && getLine(doc, change.from.line).markedSpans;
      var oldLast = isLine(doc, change.to.line) && getLine(doc, change.to.line).markedSpans;
      if (!oldFirst && !oldLast) { return null }
  
      var startCh = change.from.ch, endCh = change.to.ch, isInsert = cmp(change.from, change.to) == 0;
      // Get the spans that 'stick out' on both sides
      var first = markedSpansBefore(oldFirst, startCh, isInsert);
      var last = markedSpansAfter(oldLast, endCh, isInsert);
  
      // Next, merge those two ends
      var sameLine = change.text.length == 1, offset = lst(change.text).length + (sameLine ? startCh : 0);
      if (first) {
        // Fix up .to properties of first
        for (var i = 0; i < first.length; ++i) {
          var span = first[i];
          if (span.to == null) {
            var found = getMarkedSpanFor(last, span.marker);
            if (!found) { span.to = startCh; }
            else if (sameLine) { span.to = found.to == null ? null : found.to + offset; }
          }
        }
      }
      if (last) {
        // Fix up .from in last (or move them into first in case of sameLine)
        for (var i$1 = 0; i$1 < last.length; ++i$1) {
          var span$1 = last[i$1];
          if (span$1.to != null) { span$1.to += offset; }
          if (span$1.from == null) {
            var found$1 = getMarkedSpanFor(first, span$1.marker);
            if (!found$1) {
              span$1.from = offset;
              if (sameLine) { (first || (first = [])).push(span$1); }
            }
          } else {
            span$1.from += offset;
            if (sameLine) { (first || (first = [])).push(span$1); }
          }
        }
      }
      // Make sure we didn't create any zero-length spans
      if (first) { first = clearEmptySpans(first); }
      if (last && last != first) { last = clearEmptySpans(last); }
  
      var newMarkers = [first];
      if (!sameLine) {
        // Fill gap with whole-line-spans
        var gap = change.text.length - 2, gapMarkers;
        if (gap > 0 && first)
          { for (var i$2 = 0; i$2 < first.length; ++i$2)
            { if (first[i$2].to == null)
              { (gapMarkers || (gapMarkers = [])).push(new MarkedSpan(first[i$2].marker, null, null)); } } }
        for (var i$3 = 0; i$3 < gap; ++i$3)
          { newMarkers.push(gapMarkers); }
        newMarkers.push(last);
      }
      return newMarkers
    }
  
    // Remove spans that are empty and don't have a clearWhenEmpty
    // option of false.
    function clearEmptySpans(spans) {
      for (var i = 0; i < spans.length; ++i) {
        var span = spans[i];
        if (span.from != null && span.from == span.to && span.marker.clearWhenEmpty !== false)
          { spans.splice(i--, 1); }
      }
      if (!spans.length) { return null }
      return spans
    }
  
    // Used to 'clip' out readOnly ranges when making a change.
    function removeReadOnlyRanges(doc, from, to) {
      var markers = null;
      doc.iter(from.line, to.line + 1, function (line) {
        if (line.markedSpans) { for (var i = 0; i < line.markedSpans.length; ++i) {
          var mark = line.markedSpans[i].marker;
          if (mark.readOnly && (!markers || indexOf(markers, mark) == -1))
            { (markers || (markers = [])).push(mark); }
        } }
      });
      if (!markers) { return null }
      var parts = [{from: from, to: to}];
      for (var i = 0; i < markers.length; ++i) {
        var mk = markers[i], m = mk.find(0);
        for (var j = 0; j < parts.length; ++j) {
          var p = parts[j];
          if (cmp(p.to, m.from) < 0 || cmp(p.from, m.to) > 0) { continue }
          var newParts = [j, 1], dfrom = cmp(p.from, m.from), dto = cmp(p.to, m.to);
          if (dfrom < 0 || !mk.inclusiveLeft && !dfrom)
            { newParts.push({from: p.from, to: m.from}); }
          if (dto > 0 || !mk.inclusiveRight && !dto)
            { newParts.push({from: m.to, to: p.to}); }
          parts.splice.apply(parts, newParts);
          j += newParts.length - 3;
        }
      }
      return parts
    }
  
    // Connect or disconnect spans from a line.
    function detachMarkedSpans(line) {
      var spans = line.markedSpans;
      if (!spans) { return }
      for (var i = 0; i < spans.length; ++i)
        { spans[i].marker.detachLine(line); }
      line.markedSpans = null;
    }
    function attachMarkedSpans(line, spans) {
      if (!spans) { return }
      for (var i = 0; i < spans.length; ++i)
        { spans[i].marker.attachLine(line); }
      line.markedSpans = spans;
    }
  
    // Helpers used when computing which overlapping collapsed span
    // counts as the larger one.
    function extraLeft(marker) { return marker.inclusiveLeft ? -1 : 0 }
    function extraRight(marker) { return marker.inclusiveRight ? 1 : 0 }
  
    // Returns a number indicating which of two overlapping collapsed
    // spans is larger (and thus includes the other). Falls back to
    // comparing ids when the spans cover exactly the same range.
    function compareCollapsedMarkers(a, b) {
      var lenDiff = a.lines.length - b.lines.length;
      if (lenDiff != 0) { return lenDiff }
      var aPos = a.find(), bPos = b.find();
      var fromCmp = cmp(aPos.from, bPos.from) || extraLeft(a) - extraLeft(b);
      if (fromCmp) { return -fromCmp }
      var toCmp = cmp(aPos.to, bPos.to) || extraRight(a) - extraRight(b);
      if (toCmp) { return toCmp }
      return b.id - a.id
    }
  
    // Find out whether a line ends or starts in a collapsed span. If
    // so, return the marker for that span.
    function collapsedSpanAtSide(line, start) {
      var sps = sawCollapsedSpans && line.markedSpans, found;
      if (sps) { for (var sp = (void 0), i = 0; i < sps.length; ++i) {
        sp = sps[i];
        if (sp.marker.collapsed && (start ? sp.from : sp.to) == null &&
            (!found || compareCollapsedMarkers(found, sp.marker) < 0))
          { found = sp.marker; }
      } }
      return found
    }
    function collapsedSpanAtStart(line) { return collapsedSpanAtSide(line, true) }
    function collapsedSpanAtEnd(line) { return collapsedSpanAtSide(line, false) }
  
    function collapsedSpanAround(line, ch) {
      var sps = sawCollapsedSpans && line.markedSpans, found;
      if (sps) { for (var i = 0; i < sps.length; ++i) {
        var sp = sps[i];
        if (sp.marker.collapsed && (sp.from == null || sp.from < ch) && (sp.to == null || sp.to > ch) &&
            (!found || compareCollapsedMarkers(found, sp.marker) < 0)) { found = sp.marker; }
      } }
      return found
    }
  
    // Test whether there exists a collapsed span that partially
    // overlaps (covers the start or end, but not both) of a new span.
    // Such overlap is not allowed.
    function conflictingCollapsedRange(doc, lineNo$$1, from, to, marker) {
      var line = getLine(doc, lineNo$$1);
      var sps = sawCollapsedSpans && line.markedSpans;
      if (sps) { for (var i = 0; i < sps.length; ++i) {
        var sp = sps[i];
        if (!sp.marker.collapsed) { continue }
        var found = sp.marker.find(0);
        var fromCmp = cmp(found.from, from) || extraLeft(sp.marker) - extraLeft(marker);
        var toCmp = cmp(found.to, to) || extraRight(sp.marker) - extraRight(marker);
        if (fromCmp >= 0 && toCmp <= 0 || fromCmp <= 0 && toCmp >= 0) { continue }
        if (fromCmp <= 0 && (sp.marker.inclusiveRight && marker.inclusiveLeft ? cmp(found.to, from) >= 0 : cmp(found.to, from) > 0) ||
            fromCmp >= 0 && (sp.marker.inclusiveRight && marker.inclusiveLeft ? cmp(found.from, to) <= 0 : cmp(found.from, to) < 0))
          { return true }
      } }
    }
  
    // A visual line is a line as drawn on the screen. Folding, for
    // example, can cause multiple logical lines to appear on the same
    // visual line. This finds the start of the visual line that the
    // given line is part of (usually that is the line itself).
    function visualLine(line) {
      var merged;
      while (merged = collapsedSpanAtStart(line))
        { line = merged.find(-1, true).line; }
      return line
    }
  
    function visualLineEnd(line) {
      var merged;
      while (merged = collapsedSpanAtEnd(line))
        { line = merged.find(1, true).line; }
      return line
    }
  
    // Returns an array of logical lines that continue the visual line
    // started by the argument, or undefined if there are no such lines.
    function visualLineContinued(line) {
      var merged, lines;
      while (merged = collapsedSpanAtEnd(line)) {
        line = merged.find(1, true).line
        ;(lines || (lines = [])).push(line);
      }
      return lines
    }
  
    // Get the line number of the start of the visual line that the
    // given line number is part of.
    function visualLineNo(doc, lineN) {
      var line = getLine(doc, lineN), vis = visualLine(line);
      if (line == vis) { return lineN }
      return lineNo(vis)
    }
  
    // Get the line number of the start of the next visual line after
    // the given line.
    function visualLineEndNo(doc, lineN) {
      if (lineN > doc.lastLine()) { return lineN }
      var line = getLine(doc, lineN), merged;
      if (!lineIsHidden(doc, line)) { return lineN }
      while (merged = collapsedSpanAtEnd(line))
        { line = merged.find(1, true).line; }
      return lineNo(line) + 1
    }
  
    // Compute whether a line is hidden. Lines count as hidden when they
    // are part of a visual line that starts with another line, or when
    // they are entirely covered by collapsed, non-widget span.
    function lineIsHidden(doc, line) {
      var sps = sawCollapsedSpans && line.markedSpans;
      if (sps) { for (var sp = (void 0), i = 0; i < sps.length; ++i) {
        sp = sps[i];
        if (!sp.marker.collapsed) { continue }
        if (sp.from == null) { return true }
        if (sp.marker.widgetNode) { continue }
        if (sp.from == 0 && sp.marker.inclusiveLeft && lineIsHiddenInner(doc, line, sp))
          { return true }
      } }
    }
    function lineIsHiddenInner(doc, line, span) {
      if (span.to == null) {
        var end = span.marker.find(1, true);
        return lineIsHiddenInner(doc, end.line, getMarkedSpanFor(end.line.markedSpans, span.marker))
      }
      if (span.marker.inclusiveRight && span.to == line.text.length)
        { return true }
      for (var sp = (void 0), i = 0; i < line.markedSpans.length; ++i) {
        sp = line.markedSpans[i];
        if (sp.marker.collapsed && !sp.marker.widgetNode && sp.from == span.to &&
            (sp.to == null || sp.to != span.from) &&
            (sp.marker.inclusiveLeft || span.marker.inclusiveRight) &&
            lineIsHiddenInner(doc, line, sp)) { return true }
      }
    }
  
    // Find the height above the given line.
    function heightAtLine(lineObj) {
      lineObj = visualLine(lineObj);
  
      var h = 0, chunk = lineObj.parent;
      for (var i = 0; i < chunk.lines.length; ++i) {
        var line = chunk.lines[i];
        if (line == lineObj) { break }
        else { h += line.height; }
      }
      for (var p = chunk.parent; p; chunk = p, p = chunk.parent) {
        for (var i$1 = 0; i$1 < p.children.length; ++i$1) {
          var cur = p.children[i$1];
          if (cur == chunk) { break }
          else { h += cur.height; }
        }
      }
      return h
    }
  
    // Compute the character length of a line, taking into account
    // collapsed ranges (see markText) that might hide parts, and join
    // other lines onto it.
    function lineLength(line) {
      if (line.height == 0) { return 0 }
      var len = line.text.length, merged, cur = line;
      while (merged = collapsedSpanAtStart(cur)) {
        var found = merged.find(0, true);
        cur = found.from.line;
        len += found.from.ch - found.to.ch;
      }
      cur = line;
      while (merged = collapsedSpanAtEnd(cur)) {
        var found$1 = merged.find(0, true);
        len -= cur.text.length - found$1.from.ch;
        cur = found$1.to.line;
        len += cur.text.length - found$1.to.ch;
      }
      return len
    }
  
    // Find the longest line in the document.
    function findMaxLine(cm) {
      var d = cm.display, doc = cm.doc;
      d.maxLine = getLine(doc, doc.first);
      d.maxLineLength = lineLength(d.maxLine);
      d.maxLineChanged = true;
      doc.iter(function (line) {
        var len = lineLength(line);
        if (len > d.maxLineLength) {
          d.maxLineLength = len;
          d.maxLine = line;
        }
      });
    }
  
    // LINE DATA STRUCTURE
  
    // Line objects. These hold state related to a line, including
    // highlighting info (the styles array).
    var Line = function(text, markedSpans, estimateHeight) {
      this.text = text;
      attachMarkedSpans(this, markedSpans);
      this.height = estimateHeight ? estimateHeight(this) : 1;
    };
  
    Line.prototype.lineNo = function () { return lineNo(this) };
    eventMixin(Line);
  
    // Change the content (text, markers) of a line. Automatically
    // invalidates cached information and tries to re-estimate the
    // line's height.
    function updateLine(line, text, markedSpans, estimateHeight) {
      line.text = text;
      if (line.stateAfter) { line.stateAfter = null; }
      if (line.styles) { line.styles = null; }
      if (line.order != null) { line.order = null; }
      detachMarkedSpans(line);
      attachMarkedSpans(line, markedSpans);
      var estHeight = estimateHeight ? estimateHeight(line) : 1;
      if (estHeight != line.height) { updateLineHeight(line, estHeight); }
    }
  
    // Detach a line from the document tree and its markers.
    function cleanUpLine(line) {
      line.parent = null;
      detachMarkedSpans(line);
    }
  
    // Convert a style as returned by a mode (either null, or a string
    // containing one or more styles) to a CSS style. This is cached,
    // and also looks for line-wide styles.
    var styleToClassCache = {}, styleToClassCacheWithMode = {};
    function interpretTokenStyle(style, options) {
      if (!style || /^\s*$/.test(style)) { return null }
      var cache = options.addModeClass ? styleToClassCacheWithMode : styleToClassCache;
      return cache[style] ||
        (cache[style] = style.replace(/\S+/g, "cm-$&"))
    }
  
    // Render the DOM representation of the text of a line. Also builds
    // up a 'line map', which points at the DOM nodes that represent
    // specific stretches of text, and is used by the measuring code.
    // The returned object contains the DOM node, this map, and
    // information about line-wide styles that were set by the mode.
    function buildLineContent(cm, lineView) {
      // The padding-right forces the element to have a 'border', which
      // is needed on Webkit to be able to get line-level bounding
      // rectangles for it (in measureChar).
      var content = eltP("span", null, null, webkit ? "padding-right: .1px" : null);
      var builder = {pre: eltP("pre", [content], "CodeMirror-line"), content: content,
                     col: 0, pos: 0, cm: cm,
                     trailingSpace: false,
                     splitSpaces: cm.getOption("lineWrapping")};
      lineView.measure = {};
  
      // Iterate over the logical lines that make up this visual line.
      for (var i = 0; i <= (lineView.rest ? lineView.rest.length : 0); i++) {
        var line = i ? lineView.rest[i - 1] : lineView.line, order = (void 0);
        builder.pos = 0;
        builder.addToken = buildToken;
        // Optionally wire in some hacks into the token-rendering
        // algorithm, to deal with browser quirks.
        if (hasBadBidiRects(cm.display.measure) && (order = getOrder(line, cm.doc.direction)))
          { builder.addToken = buildTokenBadBidi(builder.addToken, order); }
        builder.map = [];
        var allowFrontierUpdate = lineView != cm.display.externalMeasured && lineNo(line);
        insertLineContent(line, builder, getLineStyles(cm, line, allowFrontierUpdate));
        if (line.styleClasses) {
          if (line.styleClasses.bgClass)
            { builder.bgClass = joinClasses(line.styleClasses.bgClass, builder.bgClass || ""); }
          if (line.styleClasses.textClass)
            { builder.textClass = joinClasses(line.styleClasses.textClass, builder.textClass || ""); }
        }
  
        // Ensure at least a single node is present, for measuring.
        if (builder.map.length == 0)
          { builder.map.push(0, 0, builder.content.appendChild(zeroWidthElement(cm.display.measure))); }
  
        // Store the map and a cache object for the current logical line
        if (i == 0) {
          lineView.measure.map = builder.map;
          lineView.measure.cache = {};
        } else {
    (lineView.measure.maps || (lineView.measure.maps = [])).push(builder.map)
          ;(lineView.measure.caches || (lineView.measure.caches = [])).push({});
        }
      }
  
      // See issue #2901
      if (webkit) {
        var last = builder.content.lastChild;
        if (/\bcm-tab\b/.test(last.className) || (last.querySelector && last.querySelector(".cm-tab")))
          { builder.content.className = "cm-tab-wrap-hack"; }
      }
  
      signal(cm, "renderLine", cm, lineView.line, builder.pre);
      if (builder.pre.className)
        { builder.textClass = joinClasses(builder.pre.className, builder.textClass || ""); }
  
      return builder
    }
  
    function defaultSpecialCharPlaceholder(ch) {
      var token = elt("span", "\u2022", "cm-invalidchar");
      token.title = "\\u" + ch.charCodeAt(0).toString(16);
      token.setAttribute("aria-label", token.title);
      return token
    }
  
    // Build up the DOM representation for a single token, and add it to
    // the line map. Takes care to render special characters separately.
    function buildToken(builder, text, style, startStyle, endStyle, css, attributes) {
      if (!text) { return }
      var displayText = builder.splitSpaces ? splitSpaces(text, builder.trailingSpace) : text;
      var special = builder.cm.state.specialChars, mustWrap = false;
      var content;
      if (!special.test(text)) {
        builder.col += text.length;
        content = document.createTextNode(displayText);
        builder.map.push(builder.pos, builder.pos + text.length, content);
        if (ie && ie_version < 9) { mustWrap = true; }
        builder.pos += text.length;
      } else {
        content = document.createDocumentFragment();
        var pos = 0;
        while (true) {
          special.lastIndex = pos;
          var m = special.exec(text);
          var skipped = m ? m.index - pos : text.length - pos;
          if (skipped) {
            var txt = document.createTextNode(displayText.slice(pos, pos + skipped));
            if (ie && ie_version < 9) { content.appendChild(elt("span", [txt])); }
            else { content.appendChild(txt); }
            builder.map.push(builder.pos, builder.pos + skipped, txt);
            builder.col += skipped;
            builder.pos += skipped;
          }
          if (!m) { break }
          pos += skipped + 1;
          var txt$1 = (void 0);
          if (m[0] == "\t") {
            var tabSize = builder.cm.options.tabSize, tabWidth = tabSize - builder.col % tabSize;
            txt$1 = content.appendChild(elt("span", spaceStr(tabWidth), "cm-tab"));
            txt$1.setAttribute("role", "presentation");
            txt$1.setAttribute("cm-text", "\t");
            builder.col += tabWidth;
          } else if (m[0] == "\r" || m[0] == "\n") {
            txt$1 = content.appendChild(elt("span", m[0] == "\r" ? "\u240d" : "\u2424", "cm-invalidchar"));
            txt$1.setAttribute("cm-text", m[0]);
            builder.col += 1;
          } else {
            txt$1 = builder.cm.options.specialCharPlaceholder(m[0]);
            txt$1.setAttribute("cm-text", m[0]);
            if (ie && ie_version < 9) { content.appendChild(elt("span", [txt$1])); }
            else { content.appendChild(txt$1); }
            builder.col += 1;
          }
          builder.map.push(builder.pos, builder.pos + 1, txt$1);
          builder.pos++;
        }
      }
      builder.trailingSpace = displayText.charCodeAt(text.length - 1) == 32;
      if (style || startStyle || endStyle || mustWrap || css) {
        var fullStyle = style || "";
        if (startStyle) { fullStyle += startStyle; }
        if (endStyle) { fullStyle += endStyle; }
        var token = elt("span", [content], fullStyle, css);
        if (attributes) {
          for (var attr in attributes) { if (attributes.hasOwnProperty(attr) && attr != "style" && attr != "class")
            { token.setAttribute(attr, attributes[attr]); } }
        }
        return builder.content.appendChild(token)
      }
      builder.content.appendChild(content);
    }
  
    // Change some spaces to NBSP to prevent the browser from collapsing
    // trailing spaces at the end of a line when rendering text (issue #1362).
    function splitSpaces(text, trailingBefore) {
      if (text.length > 1 && !/  /.test(text)) { return text }
      var spaceBefore = trailingBefore, result = "";
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        if (ch == " " && spaceBefore && (i == text.length - 1 || text.charCodeAt(i + 1) == 32))
          { ch = "\u00a0"; }
        result += ch;
        spaceBefore = ch == " ";
      }
      return result
    }
  
    // Work around nonsense dimensions being reported for stretches of
    // right-to-left text.
    function buildTokenBadBidi(inner, order) {
      return function (builder, text, style, startStyle, endStyle, css, attributes) {
        style = style ? style + " cm-force-border" : "cm-force-border";
        var start = builder.pos, end = start + text.length;
        for (;;) {
          // Find the part that overlaps with the start of this text
          var part = (void 0);
          for (var i = 0; i < order.length; i++) {
            part = order[i];
            if (part.to > start && part.from <= start) { break }
          }
          if (part.to >= end) { return inner(builder, text, style, startStyle, endStyle, css, attributes) }
          inner(builder, text.slice(0, part.to - start), style, startStyle, null, css, attributes);
          startStyle = null;
          text = text.slice(part.to - start);
          start = part.to;
        }
      }
    }
  
    function buildCollapsedSpan(builder, size, marker, ignoreWidget) {
      var widget = !ignoreWidget && marker.widgetNode;
      if (widget) { builder.map.push(builder.pos, builder.pos + size, widget); }
      if (!ignoreWidget && builder.cm.display.input.needsContentAttribute) {
        if (!widget)
          { widget = builder.content.appendChild(document.createElement("span")); }
        widget.setAttribute("cm-marker", marker.id);
      }
      if (widget) {
        builder.cm.display.input.setUneditable(widget);
        builder.content.appendChild(widget);
      }
      builder.pos += size;
      builder.trailingSpace = false;
    }
  
    // Outputs a number of spans to make up a line, taking highlighting
    // and marked text into account.
    function insertLineContent(line, builder, styles) {
      var spans = line.markedSpans, allText = line.text, at = 0;
      if (!spans) {
        for (var i$1 = 1; i$1 < styles.length; i$1+=2)
          { builder.addToken(builder, allText.slice(at, at = styles[i$1]), interpretTokenStyle(styles[i$1+1], builder.cm.options)); }
        return
      }
  
      var len = allText.length, pos = 0, i = 1, text = "", style, css;
      var nextChange = 0, spanStyle, spanEndStyle, spanStartStyle, collapsed, attributes;
      for (;;) {
        if (nextChange == pos) { // Update current marker set
          spanStyle = spanEndStyle = spanStartStyle = css = "";
          attributes = null;
          collapsed = null; nextChange = Infinity;
          var foundBookmarks = [], endStyles = (void 0);
          for (var j = 0; j < spans.length; ++j) {
            var sp = spans[j], m = sp.marker;
            if (m.type == "bookmark" && sp.from == pos && m.widgetNode) {
              foundBookmarks.push(m);
            } else if (sp.from <= pos && (sp.to == null || sp.to > pos || m.collapsed && sp.to == pos && sp.from == pos)) {
              if (sp.to != null && sp.to != pos && nextChange > sp.to) {
                nextChange = sp.to;
                spanEndStyle = "";
              }
              if (m.className) { spanStyle += " " + m.className; }
              if (m.css) { css = (css ? css + ";" : "") + m.css; }
              if (m.startStyle && sp.from == pos) { spanStartStyle += " " + m.startStyle; }
              if (m.endStyle && sp.to == nextChange) { (endStyles || (endStyles = [])).push(m.endStyle, sp.to); }
              // support for the old title property
              // https://github.com/codemirror/CodeMirror/pull/5673
              if (m.title) { (attributes || (attributes = {})).title = m.title; }
              if (m.attributes) {
                for (var attr in m.attributes)
                  { (attributes || (attributes = {}))[attr] = m.attributes[attr]; }
              }
              if (m.collapsed && (!collapsed || compareCollapsedMarkers(collapsed.marker, m) < 0))
                { collapsed = sp; }
            } else if (sp.from > pos && nextChange > sp.from) {
              nextChange = sp.from;
            }
          }
          if (endStyles) { for (var j$1 = 0; j$1 < endStyles.length; j$1 += 2)
            { if (endStyles[j$1 + 1] == nextChange) { spanEndStyle += " " + endStyles[j$1]; } } }
  
          if (!collapsed || collapsed.from == pos) { for (var j$2 = 0; j$2 < foundBookmarks.length; ++j$2)
            { buildCollapsedSpan(builder, 0, foundBookmarks[j$2]); } }
          if (collapsed && (collapsed.from || 0) == pos) {
            buildCollapsedSpan(builder, (collapsed.to == null ? len + 1 : collapsed.to) - pos,
                               collapsed.marker, collapsed.from == null);
            if (collapsed.to == null) { return }
            if (collapsed.to == pos) { collapsed = false; }
          }
        }
        if (pos >= len) { break }
  
        var upto = Math.min(len, nextChange);
        while (true) {
          if (text) {
            var end = pos + text.length;
            if (!collapsed) {
              var tokenText = end > upto ? text.slice(0, upto - pos) : text;
              builder.addToken(builder, tokenText, style ? style + spanStyle : spanStyle,
                               spanStartStyle, pos + tokenText.length == nextChange ? spanEndStyle : "", css, attributes);
            }
            if (end >= upto) {text = text.slice(upto - pos); pos = upto; break}
            pos = end;
            spanStartStyle = "";
          }
          text = allText.slice(at, at = styles[i++]);
          style = interpretTokenStyle(styles[i++], builder.cm.options);
        }
      }
    }
  
  
    // These objects are used to represent the visible (currently drawn)
    // part of the document. A LineView may correspond to multiple
    // logical lines, if those are connected by collapsed ranges.
    function LineView(doc, line, lineN) {
      // The starting line
      this.line = line;
      // Continuing lines, if any
      this.rest = visualLineContinued(line);
      // Number of logical lines in this visual line
      this.size = this.rest ? lineNo(lst(this.rest)) - lineN + 1 : 1;
      this.node = this.text = null;
      this.hidden = lineIsHidden(doc, line);
    }
  
    // Create a range of LineView objects for the given lines.
    function buildViewArray(cm, from, to) {
      var array = [], nextPos;
      for (var pos = from; pos < to; pos = nextPos) {
        var view = new LineView(cm.doc, getLine(cm.doc, pos), pos);
        nextPos = pos + view.size;
        array.push(view);
      }
      return array
    }
  
    var operationGroup = null;
  
    function pushOperation(op) {
      if (operationGroup) {
        operationGroup.ops.push(op);
      } else {
        op.ownsGroup = operationGroup = {
          ops: [op],
          delayedCallbacks: []
        };
      }
    }
  
    function fireCallbacksForOps(group) {
      // Calls delayed callbacks and cursorActivity handlers until no
      // new ones appear
      var callbacks = group.delayedCallbacks, i = 0;
      do {
        for (; i < callbacks.length; i++)
          { callbacks[i].call(null); }
        for (var j = 0; j < group.ops.length; j++) {
          var op = group.ops[j];
          if (op.cursorActivityHandlers)
            { while (op.cursorActivityCalled < op.cursorActivityHandlers.length)
              { op.cursorActivityHandlers[op.cursorActivityCalled++].call(null, op.cm); } }
        }
      } while (i < callbacks.length)
    }
  
    function finishOperation(op, endCb) {
      var group = op.ownsGroup;
      if (!group) { return }
  
      try { fireCallbacksForOps(group); }
      finally {
        operationGroup = null;
        endCb(group);
      }
    }
  
    var orphanDelayedCallbacks = null;
  
    // Often, we want to signal events at a point where we are in the
    // middle of some work, but don't want the handler to start calling
    // other methods on the editor, which might be in an inconsistent
    // state or simply not expect any other events to happen.
    // signalLater looks whether there are any handlers, and schedules
    // them to be executed when the last operation ends, or, if no
    // operation is active, when a timeout fires.
    function signalLater(emitter, type /*, values...*/) {
      var arr = getHandlers(emitter, type);
      if (!arr.length) { return }
      var args = Array.prototype.slice.call(arguments, 2), list;
      if (operationGroup) {
        list = operationGroup.delayedCallbacks;
      } else if (orphanDelayedCallbacks) {
        list = orphanDelayedCallbacks;
      } else {
        list = orphanDelayedCallbacks = [];
        setTimeout(fireOrphanDelayed, 0);
      }
      var loop = function ( i ) {
        list.push(function () { return arr[i].apply(null, args); });
      };
  
      for (var i = 0; i < arr.length; ++i)
        loop( i );
    }
  
    function fireOrphanDelayed() {
      var delayed = orphanDelayedCallbacks;
      orphanDelayedCallbacks = null;
      for (var i = 0; i < delayed.length; ++i) { delayed[i](); }
    }
  
    // When an aspect of a line changes, a string is added to
    // lineView.changes. This updates the relevant part of the line's
    // DOM structure.
    function updateLineForChanges(cm, lineView, lineN, dims) {
      for (var j = 0; j < lineView.changes.length; j++) {
        var type = lineView.changes[j];
        if (type == "text") { updateLineText(cm, lineView); }
        else if (type == "gutter") { updateLineGutter(cm, lineView, lineN, dims); }
        else if (type == "class") { updateLineClasses(cm, lineView); }
        else if (type == "widget") { updateLineWidgets(cm, lineView, dims); }
      }
      lineView.changes = null;
    }
  
    // Lines with gutter elements, widgets or a background class need to
    // be wrapped, and have the extra elements added to the wrapper div
    function ensureLineWrapped(lineView) {
      if (lineView.node == lineView.text) {
        lineView.node = elt("div", null, null, "position: relative");
        if (lineView.text.parentNode)
          { lineView.text.parentNode.replaceChild(lineView.node, lineView.text); }
        lineView.node.appendChild(lineView.text);
        if (ie && ie_version < 8) { lineView.node.style.zIndex = 2; }
      }
      return lineView.node
    }
  
    function updateLineBackground(cm, lineView) {
      var cls = lineView.bgClass ? lineView.bgClass + " " + (lineView.line.bgClass || "") : lineView.line.bgClass;
      if (cls) { cls += " CodeMirror-linebackground"; }
      if (lineView.background) {
        if (cls) { lineView.background.className = cls; }
        else { lineView.background.parentNode.removeChild(lineView.background); lineView.background = null; }
      } else if (cls) {
        var wrap = ensureLineWrapped(lineView);
        lineView.background = wrap.insertBefore(elt("div", null, cls), wrap.firstChild);
        cm.display.input.setUneditable(lineView.background);
      }
    }
  
    // Wrapper around buildLineContent which will reuse the structure
    // in display.externalMeasured when possible.
    function getLineContent(cm, lineView) {
      var ext = cm.display.externalMeasured;
      if (ext && ext.line == lineView.line) {
        cm.display.externalMeasured = null;
        lineView.measure = ext.measure;
        return ext.built
      }
      return buildLineContent(cm, lineView)
    }
  
    // Redraw the line's text. Interacts with the background and text
    // classes because the mode may output tokens that influence these
    // classes.
    function updateLineText(cm, lineView) {
      var cls = lineView.text.className;
      var built = getLineContent(cm, lineView);
      if (lineView.text == lineView.node) { lineView.node = built.pre; }
      lineView.text.parentNode.replaceChild(built.pre, lineView.text);
      lineView.text = built.pre;
      if (built.bgClass != lineView.bgClass || built.textClass != lineView.textClass) {
        lineView.bgClass = built.bgClass;
        lineView.textClass = built.textClass;
        updateLineClasses(cm, lineView);
      } else if (cls) {
        lineView.text.className = cls;
      }
    }
  
    function updateLineClasses(cm, lineView) {
      updateLineBackground(cm, lineView);
      if (lineView.line.wrapClass)
        { ensureLineWrapped(lineView).className = lineView.line.wrapClass; }
      else if (lineView.node != lineView.text)
        { lineView.node.className = ""; }
      var textClass = lineView.textClass ? lineView.textClass + " " + (lineView.line.textClass || "") : lineView.line.textClass;
      lineView.text.className = textClass || "";
    }
  
    function updateLineGutter(cm, lineView, lineN, dims) {
      if (lineView.gutter) {
        lineView.node.removeChild(lineView.gutter);
        lineView.gutter = null;
      }
      if (lineView.gutterBackground) {
        lineView.node.removeChild(lineView.gutterBackground);
        lineView.gutterBackground = null;
      }
      if (lineView.line.gutterClass) {
        var wrap = ensureLineWrapped(lineView);
        lineView.gutterBackground = elt("div", null, "CodeMirror-gutter-background " + lineView.line.gutterClass,
                                        ("left: " + (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) + "px; width: " + (dims.gutterTotalWidth) + "px"));
        cm.display.input.setUneditable(lineView.gutterBackground);
        wrap.insertBefore(lineView.gutterBackground, lineView.text);
      }
      var markers = lineView.line.gutterMarkers;
      if (cm.options.lineNumbers || markers) {
        var wrap$1 = ensureLineWrapped(lineView);
        var gutterWrap = lineView.gutter = elt("div", null, "CodeMirror-gutter-wrapper", ("left: " + (cm.options.fixedGutter ? dims.fixedPos : -dims.gutterTotalWidth) + "px"));
        cm.display.input.setUneditable(gutterWrap);
        wrap$1.insertBefore(gutterWrap, lineView.text);
        if (lineView.line.gutterClass)
          { gutterWrap.className += " " + lineView.line.gutterClass; }
        if (cm.options.lineNumbers && (!markers || !markers["CodeMirror-linenumbers"]))
          { lineView.lineNumber = gutterWrap.appendChild(
            elt("div", lineNumberFor(cm.options, lineN),
                "CodeMirror-linenumber CodeMirror-gutter-elt",
                ("left: " + (dims.gutterLeft["CodeMirror-linenumbers"]) + "px; width: " + (cm.display.lineNumInnerWidth) + "px"))); }
        if (markers) { for (var k = 0; k < cm.display.gutterSpecs.length; ++k) {
          var id = cm.display.gutterSpecs[k].className, found = markers.hasOwnProperty(id) && markers[id];
          if (found)
            { gutterWrap.appendChild(elt("div", [found], "CodeMirror-gutter-elt",
                                       ("left: " + (dims.gutterLeft[id]) + "px; width: " + (dims.gutterWidth[id]) + "px"))); }
        } }
      }
    }
  
    function updateLineWidgets(cm, lineView, dims) {
      if (lineView.alignable) { lineView.alignable = null; }
      var isWidget = classTest("CodeMirror-linewidget");
      for (var node = lineView.node.firstChild, next = (void 0); node; node = next) {
        next = node.nextSibling;
        if (isWidget.test(node.className)) { lineView.node.removeChild(node); }
      }
      insertLineWidgets(cm, lineView, dims);
    }
  
    // Build a line's DOM representation from scratch
    function buildLineElement(cm, lineView, lineN, dims) {
      var built = getLineContent(cm, lineView);
      lineView.text = lineView.node = built.pre;
      if (built.bgClass) { lineView.bgClass = built.bgClass; }
      if (built.textClass) { lineView.textClass = built.textClass; }
  
      updateLineClasses(cm, lineView);
      updateLineGutter(cm, lineView, lineN, dims);
      insertLineWidgets(cm, lineView, dims);
      return lineView.node
    }
  
    // A lineView may contain multiple logical lines (when merged by
    // collapsed spans). The widgets for all of them need to be drawn.
    function insertLineWidgets(cm, lineView, dims) {
      insertLineWidgetsFor(cm, lineView.line, lineView, dims, true);
      if (lineView.rest) { for (var i = 0; i < lineView.rest.length; i++)
        { insertLineWidgetsFor(cm, lineView.rest[i], lineView, dims, false); } }
    }
  
    function insertLineWidgetsFor(cm, line, lineView, dims, allowAbove) {
      if (!line.widgets) { return }
      var wrap = ensureLineWrapped(lineView);
      for (var i = 0, ws = line.widgets; i < ws.length; ++i) {
        var widget = ws[i], node = elt("div", [widget.node], "CodeMirror-linewidget" + (widget.className ? " " + widget.className : ""));
        if (!widget.handleMouseEvents) { node.setAttribute("cm-ignore-events", "true"); }
        positionLineWidget(widget, node, lineView, dims);
        cm.display.input.setUneditable(node);
        if (allowAbove && widget.above)
          { wrap.insertBefore(node, lineView.gutter || lineView.text); }
        else
          { wrap.appendChild(node); }
        signalLater(widget, "redraw");
      }
    }
  
    function positionLineWidget(widget, node, lineView, dims) {
      if (widget.noHScroll) {
    (lineView.alignable || (lineView.alignable = [])).push(node);
        var width = dims.wrapperWidth;
        node.style.left = dims.fixedPos + "px";
        if (!widget.coverGutter) {
          width -= dims.gutterTotalWidth;
          node.style.paddingLeft = dims.gutterTotalWidth + "px";
        }
        node.style.width = width + "px";
      }
      if (widget.coverGutter) {
        node.style.zIndex = 5;
        node.style.position = "relative";
        if (!widget.noHScroll) { node.style.marginLeft = -dims.gutterTotalWidth + "px"; }
      }
    }
  
    function widgetHeight(widget) {
      if (widget.height != null) { return widget.height }
      var cm = widget.doc.cm;
      if (!cm) { return 0 }
      if (!contains(document.body, widget.node)) {
        var parentStyle = "position: relative;";
        if (widget.coverGutter)
          { parentStyle += "margin-left: -" + cm.display.gutters.offsetWidth + "px;"; }
        if (widget.noHScroll)
          { parentStyle += "width: " + cm.display.wrapper.clientWidth + "px;"; }
        removeChildrenAndAdd(cm.display.measure, elt("div", [widget.node], null, parentStyle));
      }
      return widget.height = widget.node.parentNode.offsetHeight
    }
  
    // Return true when the given mouse event happened in a widget
    function eventInWidget(display, e) {
      for (var n = e_target(e); n != display.wrapper; n = n.parentNode) {
        if (!n || (n.nodeType == 1 && n.getAttribute("cm-ignore-events") == "true") ||
            (n.parentNode == display.sizer && n != display.mover))
          { return true }
      }
    }
  
    // POSITION MEASUREMENT
  
    function paddingTop(display) {return display.lineSpace.offsetTop}
    function paddingVert(display) {return display.mover.offsetHeight - display.lineSpace.offsetHeight}
    function paddingH(display) {
      if (display.cachedPaddingH) { return display.cachedPaddingH }
      var e = removeChildrenAndAdd(display.measure, elt("pre", "x", "CodeMirror-line-like"));
      var style = window.getComputedStyle ? window.getComputedStyle(e) : e.currentStyle;
      var data = {left: parseInt(style.paddingLeft), right: parseInt(style.paddingRight)};
      if (!isNaN(data.left) && !isNaN(data.right)) { display.cachedPaddingH = data; }
      return data
    }
  
    function scrollGap(cm) { return scrollerGap - cm.display.nativeBarWidth }
    function displayWidth(cm) {
      return cm.display.scroller.clientWidth - scrollGap(cm) - cm.display.barWidth
    }
    function displayHeight(cm) {
      return cm.display.scroller.clientHeight - scrollGap(cm) - cm.display.barHeight
    }
  
    // Ensure the lineView.wrapping.heights array is populated. This is
    // an array of bottom offsets for the lines that make up a drawn
    // line. When lineWrapping is on, there might be more than one
    // height.
    function ensureLineHeights(cm, lineView, rect) {
      var wrapping = cm.options.lineWrapping;
      var curWidth = wrapping && displayWidth(cm);
      if (!lineView.measure.heights || wrapping && lineView.measure.width != curWidth) {
        var heights = lineView.measure.heights = [];
        if (wrapping) {
          lineView.measure.width = curWidth;
          var rects = lineView.text.firstChild.getClientRects();
          for (var i = 0; i < rects.length - 1; i++) {
            var cur = rects[i], next = rects[i + 1];
            if (Math.abs(cur.bottom - next.bottom) > 2)
              { heights.push((cur.bottom + next.top) / 2 - rect.top); }
          }
        }
        heights.push(rect.bottom - rect.top);
      }
    }
  
    // Find a line map (mapping character offsets to text nodes) and a
    // measurement cache for the given line number. (A line view might
    // contain multiple lines when collapsed ranges are present.)
    function mapFromLineView(lineView, line, lineN) {
      if (lineView.line == line)
        { return {map: lineView.measure.map, cache: lineView.measure.cache} }
      for (var i = 0; i < lineView.rest.length; i++)
        { if (lineView.rest[i] == line)
          { return {map: lineView.measure.maps[i], cache: lineView.measure.caches[i]} } }
      for (var i$1 = 0; i$1 < lineView.rest.length; i$1++)
        { if (lineNo(lineView.rest[i$1]) > lineN)
          { return {map: lineView.measure.maps[i$1], cache: lineView.measure.caches[i$1], before: true} } }
    }
  
    // Render a line into the hidden node display.externalMeasured. Used
    // when measurement is needed for a line that's not in the viewport.
    function updateExternalMeasurement(cm, line) {
      line = visualLine(line);
      var lineN = lineNo(line);
      var view = cm.display.externalMeasured = new LineView(cm.doc, line, lineN);
      view.lineN = lineN;
      var built = view.built = buildLineContent(cm, view);
      view.text = built.pre;
      removeChildrenAndAdd(cm.display.lineMeasure, built.pre);
      return view
    }
  
    // Get a {top, bottom, left, right} box (in line-local coordinates)
    // for a given character.
    function measureChar(cm, line, ch, bias) {
      return measureCharPrepared(cm, prepareMeasureForLine(cm, line), ch, bias)
    }
  
    // Find a line view that corresponds to the given line number.
    function findViewForLine(cm, lineN) {
      if (lineN >= cm.display.viewFrom && lineN < cm.display.viewTo)
        { return cm.display.view[findViewIndex(cm, lineN)] }
      var ext = cm.display.externalMeasured;
      if (ext && lineN >= ext.lineN && lineN < ext.lineN + ext.size)
        { return ext }
    }
  
    // Measurement can be split in two steps, the set-up work that
    // applies to the whole line, and the measurement of the actual
    // character. Functions like coordsChar, that need to do a lot of
    // measurements in a row, can thus ensure that the set-up work is
    // only done once.
    function prepareMeasureForLine(cm, line) {
      var lineN = lineNo(line);
      var view = findViewForLine(cm, lineN);
      if (view && !view.text) {
        view = null;
      } else if (view && view.changes) {
        updateLineForChanges(cm, view, lineN, getDimensions(cm));
        cm.curOp.forceUpdate = true;
      }
      if (!view)
        { view = updateExternalMeasurement(cm, line); }
  
      var info = mapFromLineView(view, line, lineN);
      return {
        line: line, view: view, rect: null,
        map: info.map, cache: info.cache, before: info.before,
        hasHeights: false
      }
    }
  
    // Given a prepared measurement object, measures the position of an
    // actual character (or fetches it from the cache).
    function measureCharPrepared(cm, prepared, ch, bias, varHeight) {
      if (prepared.before) { ch = -1; }
      var key = ch + (bias || ""), found;
      if (prepared.cache.hasOwnProperty(key)) {
        found = prepared.cache[key];
      } else {
        if (!prepared.rect)
          { prepared.rect = prepared.view.text.getBoundingClientRect(); }
        if (!prepared.hasHeights) {
          ensureLineHeights(cm, prepared.view, prepared.rect);
          prepared.hasHeights = true;
        }
        found = measureCharInner(cm, prepared, ch, bias);
        if (!found.bogus) { prepared.cache[key] = found; }
      }
      return {left: found.left, right: found.right,
              top: varHeight ? found.rtop : found.top,
              bottom: varHeight ? found.rbottom : found.bottom}
    }
  
    var nullRect = {left: 0, right: 0, top: 0, bottom: 0};
  
    function nodeAndOffsetInLineMap(map$$1, ch, bias) {
      var node, start, end, collapse, mStart, mEnd;
      // First, search the line map for the text node corresponding to,
      // or closest to, the target character.
      for (var i = 0; i < map$$1.length; i += 3) {
        mStart = map$$1[i];
        mEnd = map$$1[i + 1];
        if (ch < mStart) {
          start = 0; end = 1;
          collapse = "left";
        } else if (ch < mEnd) {
          start = ch - mStart;
          end = start + 1;
        } else if (i == map$$1.length - 3 || ch == mEnd && map$$1[i + 3] > ch) {
          end = mEnd - mStart;
          start = end - 1;
          if (ch >= mEnd) { collapse = "right"; }
        }
        if (start != null) {
          node = map$$1[i + 2];
          if (mStart == mEnd && bias == (node.insertLeft ? "left" : "right"))
            { collapse = bias; }
          if (bias == "left" && start == 0)
            { while (i && map$$1[i - 2] == map$$1[i - 3] && map$$1[i - 1].insertLeft) {
              node = map$$1[(i -= 3) + 2];
              collapse = "left";
            } }
          if (bias == "right" && start == mEnd - mStart)
            { while (i < map$$1.length - 3 && map$$1[i + 3] == map$$1[i + 4] && !map$$1[i + 5].insertLeft) {
              node = map$$1[(i += 3) + 2];
              collapse = "right";
            } }
          break
        }
      }
      return {node: node, start: start, end: end, collapse: collapse, coverStart: mStart, coverEnd: mEnd}
    }
  
    function getUsefulRect(rects, bias) {
      var rect = nullRect;
      if (bias == "left") { for (var i = 0; i < rects.length; i++) {
        if ((rect = rects[i]).left != rect.right) { break }
      } } else { for (var i$1 = rects.length - 1; i$1 >= 0; i$1--) {
        if ((rect = rects[i$1]).left != rect.right) { break }
      } }
      return rect
    }
  
    function measureCharInner(cm, prepared, ch, bias) {
      var place = nodeAndOffsetInLineMap(prepared.map, ch, bias);
      var node = place.node, start = place.start, end = place.end, collapse = place.collapse;
  
      var rect;
      if (node.nodeType == 3) { // If it is a text node, use a range to retrieve the coordinates.
        for (var i$1 = 0; i$1 < 4; i$1++) { // Retry a maximum of 4 times when nonsense rectangles are returned
          while (start && isExtendingChar(prepared.line.text.charAt(place.coverStart + start))) { --start; }
          while (place.coverStart + end < place.coverEnd && isExtendingChar(prepared.line.text.charAt(place.coverStart + end))) { ++end; }
          if (ie && ie_version < 9 && start == 0 && end == place.coverEnd - place.coverStart)
            { rect = node.parentNode.getBoundingClientRect(); }
          else
            { rect = getUsefulRect(range(node, start, end).getClientRects(), bias); }
          if (rect.left || rect.right || start == 0) { break }
          end = start;
          start = start - 1;
          collapse = "right";
        }
        if (ie && ie_version < 11) { rect = maybeUpdateRectForZooming(cm.display.measure, rect); }
      } else { // If it is a widget, simply get the box for the whole widget.
        if (start > 0) { collapse = bias = "right"; }
        var rects;
        if (cm.options.lineWrapping && (rects = node.getClientRects()).length > 1)
          { rect = rects[bias == "right" ? rects.length - 1 : 0]; }
        else
          { rect = node.getBoundingClientRect(); }
      }
      if (ie && ie_version < 9 && !start && (!rect || !rect.left && !rect.right)) {
        var rSpan = node.parentNode.getClientRects()[0];
        if (rSpan)
          { rect = {left: rSpan.left, right: rSpan.left + charWidth(cm.display), top: rSpan.top, bottom: rSpan.bottom}; }
        else
          { rect = nullRect; }
      }
  
      var rtop = rect.top - prepared.rect.top, rbot = rect.bottom - prepared.rect.top;
      var mid = (rtop + rbot) / 2;
      var heights = prepared.view.measure.heights;
      var i = 0;
      for (; i < heights.length - 1; i++)
        { if (mid < heights[i]) { break } }
      var top = i ? heights[i - 1] : 0, bot = heights[i];
      var result = {left: (collapse == "right" ? rect.right : rect.left) - prepared.rect.left,
                    right: (collapse == "left" ? rect.left : rect.right) - prepared.rect.left,
                    top: top, bottom: bot};
      if (!rect.left && !rect.right) { result.bogus = true; }
      if (!cm.options.singleCursorHeightPerLine) { result.rtop = rtop; result.rbottom = rbot; }
  
      return result
    }
  
    // Work around problem with bounding client rects on ranges being
    // returned incorrectly when zoomed on IE10 and below.
    function maybeUpdateRectForZooming(measure, rect) {
      if (!window.screen || screen.logicalXDPI == null ||
          screen.logicalXDPI == screen.deviceXDPI || !hasBadZoomedRects(measure))
        { return rect }
      var scaleX = screen.logicalXDPI / screen.deviceXDPI;
      var scaleY = screen.logicalYDPI / screen.deviceYDPI;
      return {left: rect.left * scaleX, right: rect.right * scaleX,
              top: rect.top * scaleY, bottom: rect.bottom * scaleY}
    }
  
    function clearLineMeasurementCacheFor(lineView) {
      if (lineView.measure) {
        lineView.measure.cache = {};
        lineView.measure.heights = null;
        if (lineView.rest) { for (var i = 0; i < lineView.rest.length; i++)
          { lineView.measure.caches[i] = {}; } }
      }
    }
  
    function clearLineMeasurementCache(cm) {
      cm.display.externalMeasure = null;
      removeChildren(cm.display.lineMeasure);
      for (var i = 0; i < cm.display.view.length; i++)
        { clearLineMeasurementCacheFor(cm.display.view[i]); }
    }
  
    function clearCaches(cm) {
      clearLineMeasurementCache(cm);
      cm.display.cachedCharWidth = cm.display.cachedTextHeight = cm.display.cachedPaddingH = null;
      if (!cm.options.lineWrapping) { cm.display.maxLineChanged = true; }
      cm.display.lineNumChars = null;
    }
  
    function pageScrollX() {
      // Work around https://bugs.chromium.org/p/chromium/issues/detail?id=489206
      // which causes page_Offset and bounding client rects to use
      // different reference viewports and invalidate our calculations.
      if (chrome && android) { return -(document.body.getBoundingClientRect().left - parseInt(getComputedStyle(document.body).marginLeft)) }
      return window.pageXOffset || (document.documentElement || document.body).scrollLeft
    }
    function pageScrollY() {
      if (chrome && android) { return -(document.body.getBoundingClientRect().top - parseInt(getComputedStyle(document.body).marginTop)) }
      return window.pageYOffset || (document.documentElement || document.body).scrollTop
    }
  
    function widgetTopHeight(lineObj) {
      var height = 0;
      if (lineObj.widgets) { for (var i = 0; i < lineObj.widgets.length; ++i) { if (lineObj.widgets[i].above)
        { height += widgetHeight(lineObj.widgets[i]); } } }
      return height
    }
  
    // Converts a {top, bottom, left, right} box from line-local
    // coordinates into another coordinate system. Context may be one of
    // "line", "div" (display.lineDiv), "local"./null (editor), "window",
    // or "page".
    function intoCoordSystem(cm, lineObj, rect, context, includeWidgets) {
      if (!includeWidgets) {
        var height = widgetTopHeight(lineObj);
        rect.top += height; rect.bottom += height;
      }
      if (context == "line") { return rect }
      if (!context) { context = "local"; }
      var yOff = heightAtLine(lineObj);
      if (context == "local") { yOff += paddingTop(cm.display); }
      else { yOff -= cm.display.viewOffset; }
      if (context == "page" || context == "window") {
        var lOff = cm.display.lineSpace.getBoundingClientRect();
        yOff += lOff.top + (context == "window" ? 0 : pageScrollY());
        var xOff = lOff.left + (context == "window" ? 0 : pageScrollX());
        rect.left += xOff; rect.right += xOff;
      }
      rect.top += yOff; rect.bottom += yOff;
      return rect
    }
  
    // Coverts a box from "div" coords to another coordinate system.
    // Context may be "window", "page", "div", or "local"./null.
    function fromCoordSystem(cm, coords, context) {
      if (context == "div") { return coords }
      var left = coords.left, top = coords.top;
      // First move into "page" coordinate system
      if (context == "page") {
        left -= pageScrollX();
        top -= pageScrollY();
      } else if (context == "local" || !context) {
        var localBox = cm.display.sizer.getBoundingClientRect();
        left += localBox.left;
        top += localBox.top;
      }
  
      var lineSpaceBox = cm.display.lineSpace.getBoundingClientRect();
      return {left: left - lineSpaceBox.left, top: top - lineSpaceBox.top}
    }
  
    function charCoords(cm, pos, context, lineObj, bias) {
      if (!lineObj) { lineObj = getLine(cm.doc, pos.line); }
      return intoCoordSystem(cm, lineObj, measureChar(cm, lineObj, pos.ch, bias), context)
    }
  
    // Returns a box for a given cursor position, which may have an
    // 'other' property containing the position of the secondary cursor
    // on a bidi boundary.
    // A cursor Pos(line, char, "before") is on the same visual line as `char - 1`
    // and after `char - 1` in writing order of `char - 1`
    // A cursor Pos(line, char, "after") is on the same visual line as `char`
    // and before `char` in writing order of `char`
    // Examples (upper-case letters are RTL, lower-case are LTR):
    //     Pos(0, 1, ...)
    //     before   after
    // ab     a|b     a|b
    // aB     a|B     aB|
    // Ab     |Ab     A|b
    // AB     B|A     B|A
    // Every position after the last character on a line is considered to stick
    // to the last character on the line.
    function cursorCoords(cm, pos, context, lineObj, preparedMeasure, varHeight) {
      lineObj = lineObj || getLine(cm.doc, pos.line);
      if (!preparedMeasure) { preparedMeasure = prepareMeasureForLine(cm, lineObj); }
      function get(ch, right) {
        var m = measureCharPrepared(cm, preparedMeasure, ch, right ? "right" : "left", varHeight);
        if (right) { m.left = m.right; } else { m.right = m.left; }
        return intoCoordSystem(cm, lineObj, m, context)
      }
      var order = getOrder(lineObj, cm.doc.direction), ch = pos.ch, sticky = pos.sticky;
      if (ch >= lineObj.text.length) {
        ch = lineObj.text.length;
        sticky = "before";
      } else if (ch <= 0) {
        ch = 0;
        sticky = "after";
      }
      if (!order) { return get(sticky == "before" ? ch - 1 : ch, sticky == "before") }
  
      function getBidi(ch, partPos, invert) {
        var part = order[partPos], right = part.level == 1;
        return get(invert ? ch - 1 : ch, right != invert)
      }
      var partPos = getBidiPartAt(order, ch, sticky);
      var other = bidiOther;
      var val = getBidi(ch, partPos, sticky == "before");
      if (other != null) { val.other = getBidi(ch, other, sticky != "before"); }
      return val
    }
  
    // Used to cheaply estimate the coordinates for a position. Used for
    // intermediate scroll updates.
    function estimateCoords(cm, pos) {
      var left = 0;
      pos = clipPos(cm.doc, pos);
      if (!cm.options.lineWrapping) { left = charWidth(cm.display) * pos.ch; }
      var lineObj = getLine(cm.doc, pos.line);
      var top = heightAtLine(lineObj) + paddingTop(cm.display);
      return {left: left, right: left, top: top, bottom: top + lineObj.height}
    }
  
    // Positions returned by coordsChar contain some extra information.
    // xRel is the relative x position of the input coordinates compared
    // to the found position (so xRel > 0 means the coordinates are to
    // the right of the character position, for example). When outside
    // is true, that means the coordinates lie outside the line's
    // vertical range.
    function PosWithInfo(line, ch, sticky, outside, xRel) {
      var pos = Pos(line, ch, sticky);
      pos.xRel = xRel;
      if (outside) { pos.outside = outside; }
      return pos
    }
  
    // Compute the character position closest to the given coordinates.
    // Input must be lineSpace-local ("div" coordinate system).
    function coordsChar(cm, x, y) {
      var doc = cm.doc;
      y += cm.display.viewOffset;
      if (y < 0) { return PosWithInfo(doc.first, 0, null, -1, -1) }
      var lineN = lineAtHeight(doc, y), last = doc.first + doc.size - 1;
      if (lineN > last)
        { return PosWithInfo(doc.first + doc.size - 1, getLine(doc, last).text.length, null, 1, 1) }
      if (x < 0) { x = 0; }
  
      var lineObj = getLine(doc, lineN);
      for (;;) {
        var found = coordsCharInner(cm, lineObj, lineN, x, y);
        var collapsed = collapsedSpanAround(lineObj, found.ch + (found.xRel > 0 || found.outside > 0 ? 1 : 0));
        if (!collapsed) { return found }
        var rangeEnd = collapsed.find(1);
        if (rangeEnd.line == lineN) { return rangeEnd }
        lineObj = getLine(doc, lineN = rangeEnd.line);
      }
    }
  
    function wrappedLineExtent(cm, lineObj, preparedMeasure, y) {
      y -= widgetTopHeight(lineObj);
      var end = lineObj.text.length;
      var begin = findFirst(function (ch) { return measureCharPrepared(cm, preparedMeasure, ch - 1).bottom <= y; }, end, 0);
      end = findFirst(function (ch) { return measureCharPrepared(cm, preparedMeasure, ch).top > y; }, begin, end);
      return {begin: begin, end: end}
    }
  
    function wrappedLineExtentChar(cm, lineObj, preparedMeasure, target) {
      if (!preparedMeasure) { preparedMeasure = prepareMeasureForLine(cm, lineObj); }
      var targetTop = intoCoordSystem(cm, lineObj, measureCharPrepared(cm, preparedMeasure, target), "line").top;
      return wrappedLineExtent(cm, lineObj, preparedMeasure, targetTop)
    }
  
    // Returns true if the given side of a box is after the given
    // coordinates, in top-to-bottom, left-to-right order.
    function boxIsAfter(box, x, y, left) {
      return box.bottom <= y ? false : box.top > y ? true : (left ? box.left : box.right) > x
    }
  
    function coordsCharInner(cm, lineObj, lineNo$$1, x, y) {
      // Move y into line-local coordinate space
      y -= heightAtLine(lineObj);
      var preparedMeasure = prepareMeasureForLine(cm, lineObj);
      // When directly calling `measureCharPrepared`, we have to adjust
      // for the widgets at this line.
      var widgetHeight$$1 = widgetTopHeight(lineObj);
      var begin = 0, end = lineObj.text.length, ltr = true;
  
      var order = getOrder(lineObj, cm.doc.direction);
      // If the line isn't plain left-to-right text, first figure out
      // which bidi section the coordinates fall into.
      if (order) {
        var part = (cm.options.lineWrapping ? coordsBidiPartWrapped : coordsBidiPart)
                     (cm, lineObj, lineNo$$1, preparedMeasure, order, x, y);
        ltr = part.level != 1;
        // The awkward -1 offsets are needed because findFirst (called
        // on these below) will treat its first bound as inclusive,
        // second as exclusive, but we want to actually address the
        // characters in the part's range
        begin = ltr ? part.from : part.to - 1;
        end = ltr ? part.to : part.from - 1;
      }
  
      // A binary search to find the first character whose bounding box
      // starts after the coordinates. If we run across any whose box wrap
      // the coordinates, store that.
      var chAround = null, boxAround = null;
      var ch = findFirst(function (ch) {
        var box = measureCharPrepared(cm, preparedMeasure, ch);
        box.top += widgetHeight$$1; box.bottom += widgetHeight$$1;
        if (!boxIsAfter(box, x, y, false)) { return false }
        if (box.top <= y && box.left <= x) {
          chAround = ch;
          boxAround = box;
        }
        return true
      }, begin, end);
  
      var baseX, sticky, outside = false;
      // If a box around the coordinates was found, use that
      if (boxAround) {
        // Distinguish coordinates nearer to the left or right side of the box
        var atLeft = x - boxAround.left < boxAround.right - x, atStart = atLeft == ltr;
        ch = chAround + (atStart ? 0 : 1);
        sticky = atStart ? "after" : "before";
        baseX = atLeft ? boxAround.left : boxAround.right;
      } else {
        // (Adjust for extended bound, if necessary.)
        if (!ltr && (ch == end || ch == begin)) { ch++; }
        // To determine which side to associate with, get the box to the
        // left of the character and compare it's vertical position to the
        // coordinates
        sticky = ch == 0 ? "after" : ch == lineObj.text.length ? "before" :
          (measureCharPrepared(cm, preparedMeasure, ch - (ltr ? 1 : 0)).bottom + widgetHeight$$1 <= y) == ltr ?
          "after" : "before";
        // Now get accurate coordinates for this place, in order to get a
        // base X position
        var coords = cursorCoords(cm, Pos(lineNo$$1, ch, sticky), "line", lineObj, preparedMeasure);
        baseX = coords.left;
        outside = y < coords.top ? -1 : y >= coords.bottom ? 1 : 0;
      }
  
      ch = skipExtendingChars(lineObj.text, ch, 1);
      return PosWithInfo(lineNo$$1, ch, sticky, outside, x - baseX)
    }
  
    function coordsBidiPart(cm, lineObj, lineNo$$1, preparedMeasure, order, x, y) {
      // Bidi parts are sorted left-to-right, and in a non-line-wrapping
      // situation, we can take this ordering to correspond to the visual
      // ordering. This finds the first part whose end is after the given
      // coordinates.
      var index = findFirst(function (i) {
        var part = order[i], ltr = part.level != 1;
        return boxIsAfter(cursorCoords(cm, Pos(lineNo$$1, ltr ? part.to : part.from, ltr ? "before" : "after"),
                                       "line", lineObj, preparedMeasure), x, y, true)
      }, 0, order.length - 1);
      var part = order[index];
      // If this isn't the first part, the part's start is also after
      // the coordinates, and the coordinates aren't on the same line as
      // that start, move one part back.
      if (index > 0) {
        var ltr = part.level != 1;
        var start = cursorCoords(cm, Pos(lineNo$$1, ltr ? part.from : part.to, ltr ? "after" : "before"),
                                 "line", lineObj, preparedMeasure);
        if (boxIsAfter(start, x, y, true) && start.top > y)
          { part = order[index - 1]; }
      }
      return part
    }
  
    function coordsBidiPartWrapped(cm, lineObj, _lineNo, preparedMeasure, order, x, y) {
      // In a wrapped line, rtl text on wrapping boundaries can do things
      // that don't correspond to the ordering in our `order` array at
      // all, so a binary search doesn't work, and we want to return a
      // part that only spans one line so that the binary search in
      // coordsCharInner is safe. As such, we first find the extent of the
      // wrapped line, and then do a flat search in which we discard any
      // spans that aren't on the line.
      var ref = wrappedLineExtent(cm, lineObj, preparedMeasure, y);
      var begin = ref.begin;
      var end = ref.end;
      if (/\s/.test(lineObj.text.charAt(end - 1))) { end--; }
      var part = null, closestDist = null;
      for (var i = 0; i < order.length; i++) {
        var p = order[i];
        if (p.from >= end || p.to <= begin) { continue }
        var ltr = p.level != 1;
        var endX = measureCharPrepared(cm, preparedMeasure, ltr ? Math.min(end, p.to) - 1 : Math.max(begin, p.from)).right;
        // Weigh against spans ending before this, so that they are only
        // picked if nothing ends after
        var dist = endX < x ? x - endX + 1e9 : endX - x;
        if (!part || closestDist > dist) {
          part = p;
          closestDist = dist;
        }
      }
      if (!part) { part = order[order.length - 1]; }
      // Clip the part to the wrapped line.
      if (part.from < begin) { part = {from: begin, to: part.to, level: part.level}; }
      if (part.to > end) { part = {from: part.from, to: end, level: part.level}; }
      return part
    }
  
    var measureText;
    // Compute the default text height.
    function textHeight(display) {
      if (display.cachedTextHeight != null) { return display.cachedTextHeight }
      if (measureText == null) {
        measureText = elt("pre", null, "CodeMirror-line-like");
        // Measure a bunch of lines, for browsers that compute
        // fractional heights.
        for (var i = 0; i < 49; ++i) {
          measureText.appendChild(document.createTextNode("x"));
          measureText.appendChild(elt("br"));
        }
        measureText.appendChild(document.createTextNode("x"));
      }
      removeChildrenAndAdd(display.measure, measureText);
      var height = measureText.offsetHeight / 50;
      if (height > 3) { display.cachedTextHeight = height; }
      removeChildren(display.measure);
      return height || 1
    }
  
    // Compute the default character width.
    function charWidth(display) {
      if (display.cachedCharWidth != null) { return display.cachedCharWidth }
      var anchor = elt("span", "xxxxxxxxxx");
      var pre = elt("pre", [anchor], "CodeMirror-line-like");
      removeChildrenAndAdd(display.measure, pre);
      var rect = anchor.getBoundingClientRect(), width = (rect.right - rect.left) / 10;
      if (width > 2) { display.cachedCharWidth = width; }
      return width || 10
    }
  
    // Do a bulk-read of the DOM positions and sizes needed to draw the
    // view, so that we don't interleave reading and writing to the DOM.
    function getDimensions(cm) {
      var d = cm.display, left = {}, width = {};
      var gutterLeft = d.gutters.clientLeft;
      for (var n = d.gutters.firstChild, i = 0; n; n = n.nextSibling, ++i) {
        var id = cm.display.gutterSpecs[i].className;
        left[id] = n.offsetLeft + n.clientLeft + gutterLeft;
        width[id] = n.clientWidth;
      }
      return {fixedPos: compensateForHScroll(d),
              gutterTotalWidth: d.gutters.offsetWidth,
              gutterLeft: left,
              gutterWidth: width,
              wrapperWidth: d.wrapper.clientWidth}
    }
  
    // Computes display.scroller.scrollLeft + display.gutters.offsetWidth,
    // but using getBoundingClientRect to get a sub-pixel-accurate
    // result.
    function compensateForHScroll(display) {
      return display.scroller.getBoundingClientRect().left - display.sizer.getBoundingClientRect().left
    }
  
    // Returns a function that estimates the height of a line, to use as
    // first approximation until the line becomes visible (and is thus
    // properly measurable).
    function estimateHeight(cm) {
      var th = textHeight(cm.display), wrapping = cm.options.lineWrapping;
      var perLine = wrapping && Math.max(5, cm.display.scroller.clientWidth / charWidth(cm.display) - 3);
      return function (line) {
        if (lineIsHidden(cm.doc, line)) { return 0 }
  
        var widgetsHeight = 0;
        if (line.widgets) { for (var i = 0; i < line.widgets.length; i++) {
          if (line.widgets[i].height) { widgetsHeight += line.widgets[i].height; }
        } }
  
        if (wrapping)
          { return widgetsHeight + (Math.ceil(line.text.length / perLine) || 1) * th }
        else
          { return widgetsHeight + th }
      }
    }
  
    function estimateLineHeights(cm) {
      var doc = cm.doc, est = estimateHeight(cm);
      doc.iter(function (line) {
        var estHeight = est(line);
        if (estHeight != line.height) { updateLineHeight(line, estHeight); }
      });
    }
  
    // Given a mouse event, find the corresponding position. If liberal
    // is false, it checks whether a gutter or scrollbar was clicked,
    // and returns null if it was. forRect is used by rectangular
    // selections, and tries to estimate a character position even for
    // coordinates beyond the right of the text.
    function posFromMouse(cm, e, liberal, forRect) {
      var display = cm.display;
      if (!liberal && e_target(e).getAttribute("cm-not-content") == "true") { return null }
  
      var x, y, space = display.lineSpace.getBoundingClientRect();
      // Fails unpredictably on IE[67] when mouse is dragged around quickly.
      try { x = e.clientX - space.left; y = e.clientY - space.top; }
      catch (e) { return null }
      var coords = coordsChar(cm, x, y), line;
      if (forRect && coords.xRel > 0 && (line = getLine(cm.doc, coords.line).text).length == coords.ch) {
        var colDiff = countColumn(line, line.length, cm.options.tabSize) - line.length;
        coords = Pos(coords.line, Math.max(0, Math.round((x - paddingH(cm.display).left) / charWidth(cm.display)) - colDiff));
      }
      return coords
    }
  
    // Find the view element corresponding to a given line. Return null
    // when the line isn't visible.
    function findViewIndex(cm, n) {
      if (n >= cm.display.viewTo) { return null }
      n -= cm.display.viewFrom;
      if (n < 0) { return null }
      var view = cm.display.view;
      for (var i = 0; i < view.length; i++) {
        n -= view[i].size;
        if (n < 0) { return i }
      }
    }
  
    // Updates the display.view data structure for a given change to the
    // document. From and to are in pre-change coordinates. Lendiff is
    // the amount of lines added or subtracted by the change. This is
    // used for changes that span multiple lines, or change the way
    // lines are divided into visual lines. regLineChange (below)
    // registers single-line changes.
    function regChange(cm, from, to, lendiff) {
      if (from == null) { from = cm.doc.first; }
      if (to == null) { to = cm.doc.first + cm.doc.size; }
      if (!lendiff) { lendiff = 0; }
  
      var display = cm.display;
      if (lendiff && to < display.viewTo &&
          (display.updateLineNumbers == null || display.updateLineNumbers > from))
        { display.updateLineNumbers = from; }
  
      cm.curOp.viewChanged = true;
  
      if (from >= display.viewTo) { // Change after
        if (sawCollapsedSpans && visualLineNo(cm.doc, from) < display.viewTo)
          { resetView(cm); }
      } else if (to <= display.viewFrom) { // Change before
        if (sawCollapsedSpans && visualLineEndNo(cm.doc, to + lendiff) > display.viewFrom) {
          resetView(cm);
        } else {
          display.viewFrom += lendiff;
          display.viewTo += lendiff;
        }
      } else if (from <= display.viewFrom && to >= display.viewTo) { // Full overlap
        resetView(cm);
      } else if (from <= display.viewFrom) { // Top overlap
        var cut = viewCuttingPoint(cm, to, to + lendiff, 1);
        if (cut) {
          display.view = display.view.slice(cut.index);
          display.viewFrom = cut.lineN;
          display.viewTo += lendiff;
        } else {
          resetView(cm);
        }
      } else if (to >= display.viewTo) { // Bottom overlap
        var cut$1 = viewCuttingPoint(cm, from, from, -1);
        if (cut$1) {
          display.view = display.view.slice(0, cut$1.index);
          display.viewTo = cut$1.lineN;
        } else {
          resetView(cm);
        }
      } else { // Gap in the middle
        var cutTop = viewCuttingPoint(cm, from, from, -1);
        var cutBot = viewCuttingPoint(cm, to, to + lendiff, 1);
        if (cutTop && cutBot) {
          display.view = display.view.slice(0, cutTop.index)
            .concat(buildViewArray(cm, cutTop.lineN, cutBot.lineN))
            .concat(display.view.slice(cutBot.index));
          display.viewTo += lendiff;
        } else {
          resetView(cm);
        }
      }
  
      var ext = display.externalMeasured;
      if (ext) {
        if (to < ext.lineN)
          { ext.lineN += lendiff; }
        else if (from < ext.lineN + ext.size)
          { display.externalMeasured = null; }
      }
    }
  
    // Register a change to a single line. Type must be one of "text",
    // "gutter", "class", "widget"
    function regLineChange(cm, line, type) {
      cm.curOp.viewChanged = true;
      var display = cm.display, ext = cm.display.externalMeasured;
      if (ext && line >= ext.lineN && line < ext.lineN + ext.size)
        { display.externalMeasured = null; }
  
      if (line < display.viewFrom || line >= display.viewTo) { return }
      var lineView = display.view[findViewIndex(cm, line)];
      if (lineView.node == null) { return }
      var arr = lineView.changes || (lineView.changes = []);
      if (indexOf(arr, type) == -1) { arr.push(type); }
    }
  
    // Clear the view.
    function resetView(cm) {
      cm.display.viewFrom = cm.display.viewTo = cm.doc.first;
      cm.display.view = [];
      cm.display.viewOffset = 0;
    }
  
    function viewCuttingPoint(cm, oldN, newN, dir) {
      var index = findViewIndex(cm, oldN), diff, view = cm.display.view;
      if (!sawCollapsedSpans || newN == cm.doc.first + cm.doc.size)
        { return {index: index, lineN: newN} }
      var n = cm.display.viewFrom;
      for (var i = 0; i < index; i++)
        { n += view[i].size; }
      if (n != oldN) {
        if (dir > 0) {
          if (index == view.length - 1) { return null }
          diff = (n + view[index].size) - oldN;
          index++;
        } else {
          diff = n - oldN;
        }
        oldN += diff; newN += diff;
      }
      while (visualLineNo(cm.doc, newN) != newN) {
        if (index == (dir < 0 ? 0 : view.length - 1)) { return null }
        newN += dir * view[index - (dir < 0 ? 1 : 0)].size;
        index += dir;
      }
      return {index: index, lineN: newN}
    }
  
    // Force the view to cover a given range, adding empty view element
    // or clipping off existing ones as needed.
    function adjustView(cm, from, to) {
      var display = cm.display, view = display.view;
      if (view.length == 0 || from >= display.viewTo || to <= display.viewFrom) {
        display.view = buildViewArray(cm, from, to);
        display.viewFrom = from;
      } else {
        if (display.viewFrom > from)
          { display.view = buildViewArray(cm, from, display.viewFrom).concat(display.view); }
        else if (display.viewFrom < from)
          { display.view = display.view.slice(findViewIndex(cm, from)); }
        display.viewFrom = from;
        if (display.viewTo < to)
          { display.view = display.view.concat(buildViewArray(cm, display.viewTo, to)); }
        else if (display.viewTo > to)
          { display.view = display.view.slice(0, findViewIndex(cm, to)); }
      }
      display.viewTo = to;
    }
  
    // Count the number of lines in the view whose DOM representation is
    // out of date (or nonexistent).
    function countDirtyView(cm) {
      var view = cm.display.view, dirty = 0;
      for (var i = 0; i < view.length; i++) {
        var lineView = view[i];
        if (!lineView.hidden && (!lineView.node || lineView.changes)) { ++dirty; }
      }
      return dirty
    }
  
    function updateSelection(cm) {
      cm.display.input.showSelection(cm.display.input.prepareSelection());
    }
  
    function prepareSelection(cm, primary) {
      if ( primary === void 0 ) primary = true;
  
      var doc = cm.doc, result = {};
      var curFragment = result.cursors = document.createDocumentFragment();
      var selFragment = result.selection = document.createDocumentFragment();
  
      for (var i = 0; i < doc.sel.ranges.length; i++) {
        if (!primary && i == doc.sel.primIndex) { continue }
        var range$$1 = doc.sel.ranges[i];
        if (range$$1.from().line >= cm.display.viewTo || range$$1.to().line < cm.display.viewFrom) { continue }
        var collapsed = range$$1.empty();
        if (collapsed || cm.options.showCursorWhenSelecting)
          { drawSelectionCursor(cm, range$$1.head, curFragment); }
        if (!collapsed)
          { drawSelectionRange(cm, range$$1, selFragment); }
      }
      return result
    }
  
    // Draws a cursor for the given range
    function drawSelectionCursor(cm, head, output) {
      var pos = cursorCoords(cm, head, "div", null, null, !cm.options.singleCursorHeightPerLine);
  
      var cursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor"));
      cursor.style.left = pos.left + "px";
      cursor.style.top = pos.top + "px";
      cursor.style.height = Math.max(0, pos.bottom - pos.top) * cm.options.cursorHeight + "px";
  
      if (pos.other) {
        // Secondary cursor, shown when on a 'jump' in bi-directional text
        var otherCursor = output.appendChild(elt("div", "\u00a0", "CodeMirror-cursor CodeMirror-secondarycursor"));
        otherCursor.style.display = "";
        otherCursor.style.left = pos.other.left + "px";
        otherCursor.style.top = pos.other.top + "px";
        otherCursor.style.height = (pos.other.bottom - pos.other.top) * .85 + "px";
      }
    }
  
    function cmpCoords(a, b) { return a.top - b.top || a.left - b.left }
  
    // Draws the given range as a highlighted selection
    function drawSelectionRange(cm, range$$1, output) {
      var display = cm.display, doc = cm.doc;
      var fragment = document.createDocumentFragment();
      var padding = paddingH(cm.display), leftSide = padding.left;
      var rightSide = Math.max(display.sizerWidth, displayWidth(cm) - display.sizer.offsetLeft) - padding.right;
      var docLTR = doc.direction == "ltr";
  
      function add(left, top, width, bottom) {
        if (top < 0) { top = 0; }
        top = Math.round(top);
        bottom = Math.round(bottom);
        fragment.appendChild(elt("div", null, "CodeMirror-selected", ("position: absolute; left: " + left + "px;\n                             top: " + top + "px; width: " + (width == null ? rightSide - left : width) + "px;\n                             height: " + (bottom - top) + "px")));
      }
  
      function drawForLine(line, fromArg, toArg) {
        var lineObj = getLine(doc, line);
        var lineLen = lineObj.text.length;
        var start, end;
        function coords(ch, bias) {
          return charCoords(cm, Pos(line, ch), "div", lineObj, bias)
        }
  
        function wrapX(pos, dir, side) {
          var extent = wrappedLineExtentChar(cm, lineObj, null, pos);
          var prop = (dir == "ltr") == (side == "after") ? "left" : "right";
          var ch = side == "after" ? extent.begin : extent.end - (/\s/.test(lineObj.text.charAt(extent.end - 1)) ? 2 : 1);
          return coords(ch, prop)[prop]
        }
  
        var order = getOrder(lineObj, doc.direction);
        iterateBidiSections(order, fromArg || 0, toArg == null ? lineLen : toArg, function (from, to, dir, i) {
          var ltr = dir == "ltr";
          var fromPos = coords(from, ltr ? "left" : "right");
          var toPos = coords(to - 1, ltr ? "right" : "left");
  
          var openStart = fromArg == null && from == 0, openEnd = toArg == null && to == lineLen;
          var first = i == 0, last = !order || i == order.length - 1;
          if (toPos.top - fromPos.top <= 3) { // Single line
            var openLeft = (docLTR ? openStart : openEnd) && first;
            var openRight = (docLTR ? openEnd : openStart) && last;
            var left = openLeft ? leftSide : (ltr ? fromPos : toPos).left;
            var right = openRight ? rightSide : (ltr ? toPos : fromPos).right;
            add(left, fromPos.top, right - left, fromPos.bottom);
          } else { // Multiple lines
            var topLeft, topRight, botLeft, botRight;
            if (ltr) {
              topLeft = docLTR && openStart && first ? leftSide : fromPos.left;
              topRight = docLTR ? rightSide : wrapX(from, dir, "before");
              botLeft = docLTR ? leftSide : wrapX(to, dir, "after");
              botRight = docLTR && openEnd && last ? rightSide : toPos.right;
            } else {
              topLeft = !docLTR ? leftSide : wrapX(from, dir, "before");
              topRight = !docLTR && openStart && first ? rightSide : fromPos.right;
              botLeft = !docLTR && openEnd && last ? leftSide : toPos.left;
              botRight = !docLTR ? rightSide : wrapX(to, dir, "after");
            }
            add(topLeft, fromPos.top, topRight - topLeft, fromPos.bottom);
            if (fromPos.bottom < toPos.top) { add(leftSide, fromPos.bottom, null, toPos.top); }
            add(botLeft, toPos.top, botRight - botLeft, toPos.bottom);
          }
  
          if (!start || cmpCoords(fromPos, start) < 0) { start = fromPos; }
          if (cmpCoords(toPos, start) < 0) { start = toPos; }
          if (!end || cmpCoords(fromPos, end) < 0) { end = fromPos; }
          if (cmpCoords(toPos, end) < 0) { end = toPos; }
        });
        return {start: start, end: end}
      }
  
      var sFrom = range$$1.from(), sTo = range$$1.to();
      if (sFrom.line == sTo.line) {
        drawForLine(sFrom.line, sFrom.ch, sTo.ch);
      } else {
        var fromLine = getLine(doc, sFrom.line), toLine = getLine(doc, sTo.line);
        var singleVLine = visualLine(fromLine) == visualLine(toLine);
        var leftEnd = drawForLine(sFrom.line, sFrom.ch, singleVLine ? fromLine.text.length + 1 : null).end;
        var rightStart = drawForLine(sTo.line, singleVLine ? 0 : null, sTo.ch).start;
        if (singleVLine) {
          if (leftEnd.top < rightStart.top - 2) {
            add(leftEnd.right, leftEnd.top, null, leftEnd.bottom);
            add(leftSide, rightStart.top, rightStart.left, rightStart.bottom);
          } else {
            add(leftEnd.right, leftEnd.top, rightStart.left - leftEnd.right, leftEnd.bottom);
          }
        }
        if (leftEnd.bottom < rightStart.top)
          { add(leftSide, leftEnd.bottom, null, rightStart.top); }
      }
  
      output.appendChild(fragment);
    }
  
    // Cursor-blinking
    function restartBlink(cm) {
      if (!cm.state.focused) { return }
      var display = cm.display;
      clearInterval(display.blinker);
      var on = true;
      display.cursorDiv.style.visibility = "";
      if (cm.options.cursorBlinkRate > 0)
        { display.blinker = setInterval(function () { return display.cursorDiv.style.visibility = (on = !on) ? "" : "hidden"; },
          cm.options.cursorBlinkRate); }
      else if (cm.options.cursorBlinkRate < 0)
        { display.cursorDiv.style.visibility = "hidden"; }
    }
  
    function ensureFocus(cm) {
      if (!cm.state.focused) { cm.display.input.focus(); onFocus(cm); }
    }
  
    function delayBlurEvent(cm) {
      cm.state.delayingBlurEvent = true;
      setTimeout(function () { if (cm.state.delayingBlurEvent) {
        cm.state.delayingBlurEvent = false;
        onBlur(cm);
      } }, 100);
    }
  
    function onFocus(cm, e) {
      if (cm.state.delayingBlurEvent) { cm.state.delayingBlurEvent = false; }
  
      if (cm.options.readOnly == "nocursor") { return }
      if (!cm.state.focused) {
        signal(cm, "focus", cm, e);
        cm.state.focused = true;
        addClass(cm.display.wrapper, "CodeMirror-focused");
        // This test prevents this from firing when a context
        // menu is closed (since the input reset would kill the
        // select-all detection hack)
        if (!cm.curOp && cm.display.selForContextMenu != cm.doc.sel) {
          cm.display.input.reset();
          if (webkit) { setTimeout(function () { return cm.display.input.reset(true); }, 20); } // Issue #1730
        }
        cm.display.input.receivedFocus();
      }
      restartBlink(cm);
    }
    function onBlur(cm, e) {
      if (cm.state.delayingBlurEvent) { return }
  
      if (cm.state.focused) {
        signal(cm, "blur", cm, e);
        cm.state.focused = false;
        rmClass(cm.display.wrapper, "CodeMirror-focused");
      }
      clearInterval(cm.display.blinker);
      setTimeout(function () { if (!cm.state.focused) { cm.display.shift = false; } }, 150);
    }
  
    // Read the actual heights of the rendered lines, and update their
    // stored heights to match.
    function updateHeightsInViewport(cm) {
      var display = cm.display;
      var prevBottom = display.lineDiv.offsetTop;
      for (var i = 0; i < display.view.length; i++) {
        var cur = display.view[i], wrapping = cm.options.lineWrapping;
        var height = (void 0), width = 0;
        if (cur.hidden) { continue }
        if (ie && ie_version < 8) {
          var bot = cur.node.offsetTop + cur.node.offsetHeight;
          height = bot - prevBottom;
          prevBottom = bot;
        } else {
          var box = cur.node.getBoundingClientRect();
          height = box.bottom - box.top;
          // Check that lines don't extend past the right of the current
          // editor width
          if (!wrapping && cur.text.firstChild)
            { width = cur.text.firstChild.getBoundingClientRect().right - box.left - 1; }
        }
        var diff = cur.line.height - height;
        if (diff > .005 || diff < -.005) {
          updateLineHeight(cur.line, height);
          updateWidgetHeight(cur.line);
          if (cur.rest) { for (var j = 0; j < cur.rest.length; j++)
            { updateWidgetHeight(cur.rest[j]); } }
        }
        if (width > cm.display.sizerWidth) {
          var chWidth = Math.ceil(width / charWidth(cm.display));
          if (chWidth > cm.display.maxLineLength) {
            cm.display.maxLineLength = chWidth;
            cm.display.maxLine = cur.line;
            cm.display.maxLineChanged = true;
          }
        }
      }
    }
  
    // Read and store the height of line widgets associated with the
    // given line.
    function updateWidgetHeight(line) {
      if (line.widgets) { for (var i = 0; i < line.widgets.length; ++i) {
        var w = line.widgets[i], parent = w.node.parentNode;
        if (parent) { w.height = parent.offsetHeight; }
      } }
    }
  
    // Compute the lines that are visible in a given viewport (defaults
    // the the current scroll position). viewport may contain top,
    // height, and ensure (see op.scrollToPos) properties.
    function visibleLines(display, doc, viewport) {
      var top = viewport && viewport.top != null ? Math.max(0, viewport.top) : display.scroller.scrollTop;
      top = Math.floor(top - paddingTop(display));
      var bottom = viewport && viewport.bottom != null ? viewport.bottom : top + display.wrapper.clientHeight;
  
      var from = lineAtHeight(doc, top), to = lineAtHeight(doc, bottom);
      // Ensure is a {from: {line, ch}, to: {line, ch}} object, and
      // forces those lines into the viewport (if possible).
      if (viewport && viewport.ensure) {
        var ensureFrom = viewport.ensure.from.line, ensureTo = viewport.ensure.to.line;
        if (ensureFrom < from) {
          from = ensureFrom;
          to = lineAtHeight(doc, heightAtLine(getLine(doc, ensureFrom)) + display.wrapper.clientHeight);
        } else if (Math.min(ensureTo, doc.lastLine()) >= to) {
          from = lineAtHeight(doc, heightAtLine(getLine(doc, ensureTo)) - display.wrapper.clientHeight);
          to = ensureTo;
        }
      }
      return {from: from, to: Math.max(to, from + 1)}
    }
  
    // SCROLLING THINGS INTO VIEW
  
    // If an editor sits on the top or bottom of the window, partially
    // scrolled out of view, this ensures that the cursor is visible.
    function maybeScrollWindow(cm, rect) {
      if (signalDOMEvent(cm, "scrollCursorIntoView")) { return }
  
      var display = cm.display, box = display.sizer.getBoundingClientRect(), doScroll = null;
      if (rect.top + box.top < 0) { doScroll = true; }
      else if (rect.bottom + box.top > (window.innerHeight || document.documentElement.clientHeight)) { doScroll = false; }
      if (doScroll != null && !phantom) {
        var scrollNode = elt("div", "\u200b", null, ("position: absolute;\n                         top: " + (rect.top - display.viewOffset - paddingTop(cm.display)) + "px;\n                         height: " + (rect.bottom - rect.top + scrollGap(cm) + display.barHeight) + "px;\n                         left: " + (rect.left) + "px; width: " + (Math.max(2, rect.right - rect.left)) + "px;"));
        cm.display.lineSpace.appendChild(scrollNode);
        scrollNode.scrollIntoView(doScroll);
        cm.display.lineSpace.removeChild(scrollNode);
      }
    }
  
    // Scroll a given position into view (immediately), verifying that
    // it actually became visible (as line heights are accurately
    // measured, the position of something may 'drift' during drawing).
    function scrollPosIntoView(cm, pos, end, margin) {
      if (margin == null) { margin = 0; }
      var rect;
      if (!cm.options.lineWrapping && pos == end) {
        // Set pos and end to the cursor positions around the character pos sticks to
        // If pos.sticky == "before", that is around pos.ch - 1, otherwise around pos.ch
        // If pos == Pos(_, 0, "before"), pos and end are unchanged
        pos = pos.ch ? Pos(pos.line, pos.sticky == "before" ? pos.ch - 1 : pos.ch, "after") : pos;
        end = pos.sticky == "before" ? Pos(pos.line, pos.ch + 1, "before") : pos;
      }
      for (var limit = 0; limit < 5; limit++) {
        var changed = false;
        var coords = cursorCoords(cm, pos);
        var endCoords = !end || end == pos ? coords : cursorCoords(cm, end);
        rect = {left: Math.min(coords.left, endCoords.left),
                top: Math.min(coords.top, endCoords.top) - margin,
                right: Math.max(coords.left, endCoords.left),
                bottom: Math.max(coords.bottom, endCoords.bottom) + margin};
        var scrollPos = calculateScrollPos(cm, rect);
        var startTop = cm.doc.scrollTop, startLeft = cm.doc.scrollLeft;
        if (scrollPos.scrollTop != null) {
          updateScrollTop(cm, scrollPos.scrollTop);
          if (Math.abs(cm.doc.scrollTop - startTop) > 1) { changed = true; }
        }
        if (scrollPos.scrollLeft != null) {
          setScrollLeft(cm, scrollPos.scrollLeft);
          if (Math.abs(cm.doc.scrollLeft - startLeft) > 1) { changed = true; }
        }
        if (!changed) { break }
      }
      return rect
    }
  
    // Scroll a given set of coordinates into view (immediately).
    function scrollIntoView(cm, rect) {
      var scrollPos = calculateScrollPos(cm, rect);
      if (scrollPos.scrollTop != null) { updateScrollTop(cm, scrollPos.scrollTop); }
      if (scrollPos.scrollLeft != null) { setScrollLeft(cm, scrollPos.scrollLeft); }
    }
  
    // Calculate a new scroll position needed to scroll the given
    // rectangle into view. Returns an object with scrollTop and
    // scrollLeft properties. When these are undefined, the
    // vertical/horizontal position does not need to be adjusted.
    function calculateScrollPos(cm, rect) {
      var display = cm.display, snapMargin = textHeight(cm.display);
      if (rect.top < 0) { rect.top = 0; }
      var screentop = cm.curOp && cm.curOp.scrollTop != null ? cm.curOp.scrollTop : display.scroller.scrollTop;
      var screen = displayHeight(cm), result = {};
      if (rect.bottom - rect.top > screen) { rect.bottom = rect.top + screen; }
      var docBottom = cm.doc.height + paddingVert(display);
      var atTop = rect.top < snapMargin, atBottom = rect.bottom > docBottom - snapMargin;
      if (rect.top < screentop) {
        result.scrollTop = atTop ? 0 : rect.top;
      } else if (rect.bottom > screentop + screen) {
        var newTop = Math.min(rect.top, (atBottom ? docBottom : rect.bottom) - screen);
        if (newTop != screentop) { result.scrollTop = newTop; }
      }
  
      var screenleft = cm.curOp && cm.curOp.scrollLeft != null ? cm.curOp.scrollLeft : display.scroller.scrollLeft;
      var screenw = displayWidth(cm) - (cm.options.fixedGutter ? display.gutters.offsetWidth : 0);
      var tooWide = rect.right - rect.left > screenw;
      if (tooWide) { rect.right = rect.left + screenw; }
      if (rect.left < 10)
        { result.scrollLeft = 0; }
      else if (rect.left < screenleft)
        { result.scrollLeft = Math.max(0, rect.left - (tooWide ? 0 : 10)); }
      else if (rect.right > screenw + screenleft - 3)
        { result.scrollLeft = rect.right + (tooWide ? 0 : 10) - screenw; }
      return result
    }
  
    // Store a relative adjustment to the scroll position in the current
    // operation (to be applied when the operation finishes).
    function addToScrollTop(cm, top) {
      if (top == null) { return }
      resolveScrollToPos(cm);
      cm.curOp.scrollTop = (cm.curOp.scrollTop == null ? cm.doc.scrollTop : cm.curOp.scrollTop) + top;
    }
  
    // Make sure that at the end of the operation the current cursor is
    // shown.
    function ensureCursorVisible(cm) {
      resolveScrollToPos(cm);
      var cur = cm.getCursor();
      cm.curOp.scrollToPos = {from: cur, to: cur, margin: cm.options.cursorScrollMargin};
    }
  
    function scrollToCoords(cm, x, y) {
      if (x != null || y != null) { resolveScrollToPos(cm); }
      if (x != null) { cm.curOp.scrollLeft = x; }
      if (y != null) { cm.curOp.scrollTop = y; }
    }
  
    function scrollToRange(cm, range$$1) {
      resolveScrollToPos(cm);
      cm.curOp.scrollToPos = range$$1;
    }
  
    // When an operation has its scrollToPos property set, and another
    // scroll action is applied before the end of the operation, this
    // 'simulates' scrolling that position into view in a cheap way, so
    // that the effect of intermediate scroll commands is not ignored.
    function resolveScrollToPos(cm) {
      var range$$1 = cm.curOp.scrollToPos;
      if (range$$1) {
        cm.curOp.scrollToPos = null;
        var from = estimateCoords(cm, range$$1.from), to = estimateCoords(cm, range$$1.to);
        scrollToCoordsRange(cm, from, to, range$$1.margin);
      }
    }
  
    function scrollToCoordsRange(cm, from, to, margin) {
      var sPos = calculateScrollPos(cm, {
        left: Math.min(from.left, to.left),
        top: Math.min(from.top, to.top) - margin,
        right: Math.max(from.right, to.right),
        bottom: Math.max(from.bottom, to.bottom) + margin
      });
      scrollToCoords(cm, sPos.scrollLeft, sPos.scrollTop);
    }
  
    // Sync the scrollable area and scrollbars, ensure the viewport
    // covers the visible area.
    function updateScrollTop(cm, val) {
      if (Math.abs(cm.doc.scrollTop - val) < 2) { return }
      if (!gecko) { updateDisplaySimple(cm, {top: val}); }
      setScrollTop(cm, val, true);
      if (gecko) { updateDisplaySimple(cm); }
      startWorker(cm, 100);
    }
  
    function setScrollTop(cm, val, forceScroll) {
      val = Math.max(0, Math.min(cm.display.scroller.scrollHeight - cm.display.scroller.clientHeight, val));
      if (cm.display.scroller.scrollTop == val && !forceScroll) { return }
      cm.doc.scrollTop = val;
      cm.display.scrollbars.setScrollTop(val);
      if (cm.display.scroller.scrollTop != val) { cm.display.scroller.scrollTop = val; }
    }
  
    // Sync scroller and scrollbar, ensure the gutter elements are
    // aligned.
    function setScrollLeft(cm, val, isScroller, forceScroll) {
      val = Math.max(0, Math.min(val, cm.display.scroller.scrollWidth - cm.display.scroller.clientWidth));
      if ((isScroller ? val == cm.doc.scrollLeft : Math.abs(cm.doc.scrollLeft - val) < 2) && !forceScroll) { return }
      cm.doc.scrollLeft = val;
      alignHorizontally(cm);
      if (cm.display.scroller.scrollLeft != val) { cm.display.scroller.scrollLeft = val; }
      cm.display.scrollbars.setScrollLeft(val);
    }
  
    // SCROLLBARS
  
    // Prepare DOM reads needed to update the scrollbars. Done in one
    // shot to minimize update/measure roundtrips.
    function measureForScrollbars(cm) {
      var d = cm.display, gutterW = d.gutters.offsetWidth;
      var docH = Math.round(cm.doc.height + paddingVert(cm.display));
      return {
        clientHeight: d.scroller.clientHeight,
        viewHeight: d.wrapper.clientHeight,
        scrollWidth: d.scroller.scrollWidth, clientWidth: d.scroller.clientWidth,
        viewWidth: d.wrapper.clientWidth,
        barLeft: cm.options.fixedGutter ? gutterW : 0,
        docHeight: docH,
        scrollHeight: docH + scrollGap(cm) + d.barHeight,
        nativeBarWidth: d.nativeBarWidth,
        gutterWidth: gutterW
      }
    }
  
    var NativeScrollbars = function(place, scroll, cm) {
      this.cm = cm;
      var vert = this.vert = elt("div", [elt("div", null, null, "min-width: 1px")], "CodeMirror-vscrollbar");
      var horiz = this.horiz = elt("div", [elt("div", null, null, "height: 100%; min-height: 1px")], "CodeMirror-hscrollbar");
      vert.tabIndex = horiz.tabIndex = -1;
      place(vert); place(horiz);
  
      on(vert, "scroll", function () {
        if (vert.clientHeight) { scroll(vert.scrollTop, "vertical"); }
      });
      on(horiz, "scroll", function () {
        if (horiz.clientWidth) { scroll(horiz.scrollLeft, "horizontal"); }
      });
  
      this.checkedZeroWidth = false;
      // Need to set a minimum width to see the scrollbar on IE7 (but must not set it on IE8).
      if (ie && ie_version < 8) { this.horiz.style.minHeight = this.vert.style.minWidth = "18px"; }
    };
  
    NativeScrollbars.prototype.update = function (measure) {
      var needsH = measure.scrollWidth > measure.clientWidth + 1;
      var needsV = measure.scrollHeight > measure.clientHeight + 1;
      var sWidth = measure.nativeBarWidth;
  
      if (needsV) {
        this.vert.style.display = "block";
        this.vert.style.bottom = needsH ? sWidth + "px" : "0";
        var totalHeight = measure.viewHeight - (needsH ? sWidth : 0);
        // A bug in IE8 can cause this value to be negative, so guard it.
        this.vert.firstChild.style.height =
          Math.max(0, measure.scrollHeight - measure.clientHeight + totalHeight) + "px";
      } else {
        this.vert.style.display = "";
        this.vert.firstChild.style.height = "0";
      }
  
      if (needsH) {
        this.horiz.style.display = "block";
        this.horiz.style.right = needsV ? sWidth + "px" : "0";
        this.horiz.style.left = measure.barLeft + "px";
        var totalWidth = measure.viewWidth - measure.barLeft - (needsV ? sWidth : 0);
        this.horiz.firstChild.style.width =
          Math.max(0, measure.scrollWidth - measure.clientWidth + totalWidth) + "px";
      } else {
        this.horiz.style.display = "";
        this.horiz.firstChild.style.width = "0";
      }
  
      if (!this.checkedZeroWidth && measure.clientHeight > 0) {
        if (sWidth == 0) { this.zeroWidthHack(); }
        this.checkedZeroWidth = true;
      }
  
      return {right: needsV ? sWidth : 0, bottom: needsH ? sWidth : 0}
    };
  
    NativeScrollbars.prototype.setScrollLeft = function (pos) {
      if (this.horiz.scrollLeft != pos) { this.horiz.scrollLeft = pos; }
      if (this.disableHoriz) { this.enableZeroWidthBar(this.horiz, this.disableHoriz, "horiz"); }
    };
  
    NativeScrollbars.prototype.setScrollTop = function (pos) {
      if (this.vert.scrollTop != pos) { this.vert.scrollTop = pos; }
      if (this.disableVert) { this.enableZeroWidthBar(this.vert, this.disableVert, "vert"); }
    };
  
    NativeScrollbars.prototype.zeroWidthHack = function () {
      var w = mac && !mac_geMountainLion ? "12px" : "18px";
      this.horiz.style.height = this.vert.style.width = w;
      this.horiz.style.pointerEvents = this.vert.style.pointerEvents = "none";
      this.disableHoriz = new Delayed;
      this.disableVert = new Delayed;
    };
  
    NativeScrollbars.prototype.enableZeroWidthBar = function (bar, delay, type) {
      bar.style.pointerEvents = "auto";
      function maybeDisable() {
        // To find out whether the scrollbar is still visible, we
        // check whether the element under the pixel in the bottom
        // right corner of the scrollbar box is the scrollbar box
        // itself (when the bar is still visible) or its filler child
        // (when the bar is hidden). If it is still visible, we keep
        // it enabled, if it's hidden, we disable pointer events.
        var box = bar.getBoundingClientRect();
        var elt$$1 = type == "vert" ? document.elementFromPoint(box.right - 1, (box.top + box.bottom) / 2)
            : document.elementFromPoint((box.right + box.left) / 2, box.bottom - 1);
        if (elt$$1 != bar) { bar.style.pointerEvents = "none"; }
        else { delay.set(1000, maybeDisable); }
      }
      delay.set(1000, maybeDisable);
    };
  
    NativeScrollbars.prototype.clear = function () {
      var parent = this.horiz.parentNode;
      parent.removeChild(this.horiz);
      parent.removeChild(this.vert);
    };
  
    var NullScrollbars = function () {};
  
    NullScrollbars.prototype.update = function () { return {bottom: 0, right: 0} };
    NullScrollbars.prototype.setScrollLeft = function () {};
    NullScrollbars.prototype.setScrollTop = function () {};
    NullScrollbars.prototype.clear = function () {};
  
    function updateScrollbars(cm, measure) {
      if (!measure) { measure = measureForScrollbars(cm); }
      var startWidth = cm.display.barWidth, startHeight = cm.display.barHeight;
      updateScrollbarsInner(cm, measure);
      for (var i = 0; i < 4 && startWidth != cm.display.barWidth || startHeight != cm.display.barHeight; i++) {
        if (startWidth != cm.display.barWidth && cm.options.lineWrapping)
          { updateHeightsInViewport(cm); }
        updateScrollbarsInner(cm, measureForScrollbars(cm));
        startWidth = cm.display.barWidth; startHeight = cm.display.barHeight;
      }
    }
  
    // Re-synchronize the fake scrollbars with the actual size of the
    // content.
    function updateScrollbarsInner(cm, measure) {
      var d = cm.display;
      var sizes = d.scrollbars.update(measure);
  
      d.sizer.style.paddingRight = (d.barWidth = sizes.right) + "px";
      d.sizer.style.paddingBottom = (d.barHeight = sizes.bottom) + "px";
      d.heightForcer.style.borderBottom = sizes.bottom + "px solid transparent";
  
      if (sizes.right && sizes.bottom) {
        d.scrollbarFiller.style.display = "block";
        d.scrollbarFiller.style.height = sizes.bottom + "px";
        d.scrollbarFiller.style.width = sizes.right + "px";
      } else { d.scrollbarFiller.style.display = ""; }
      if (sizes.bottom && cm.options.coverGutterNextToScrollbar && cm.options.fixedGutter) {
        d.gutterFiller.style.display = "block";
        d.gutterFiller.style.height = sizes.bottom + "px";
        d.gutterFiller.style.width = measure.gutterWidth + "px";
      } else { d.gutterFiller.style.display = ""; }
    }
  
    var scrollbarModel = {"native": NativeScrollbars, "null": NullScrollbars};
  
    function initScrollbars(cm) {
      if (cm.display.scrollbars) {
        cm.display.scrollbars.clear();
        if (cm.display.scrollbars.addClass)
          { rmClass(cm.display.wrapper, cm.display.scrollbars.addClass); }
      }
  
      cm.display.scrollbars = new scrollbarModel[cm.options.scrollbarStyle](function (node) {
        cm.display.wrapper.insertBefore(node, cm.display.scrollbarFiller);
        // Prevent clicks in the scrollbars from killing focus
        on(node, "mousedown", function () {
          if (cm.state.focused) { setTimeout(function () { return cm.display.input.focus(); }, 0); }
        });
        node.setAttribute("cm-not-content", "true");
      }, function (pos, axis) {
        if (axis == "horizontal") { setScrollLeft(cm, pos); }
        else { updateScrollTop(cm, pos); }
      }, cm);
      if (cm.display.scrollbars.addClass)
        { addClass(cm.display.wrapper, cm.display.scrollbars.addClass); }
    }
  
    // Operations are used to wrap a series of changes to the editor
    // state in such a way that each change won't have to update the
    // cursor and display (which would be awkward, slow, and
    // error-prone). Instead, display updates are batched and then all
    // combined and executed at once.
  
    var nextOpId = 0;
    // Start a new operation.
    function startOperation(cm) {
      cm.curOp = {
        cm: cm,
        viewChanged: false,      // Flag that indicates that lines might need to be redrawn
        startHeight: cm.doc.height, // Used to detect need to update scrollbar
        forceUpdate: false,      // Used to force a redraw
        updateInput: 0,       // Whether to reset the input textarea
        typing: false,           // Whether this reset should be careful to leave existing text (for compositing)
        changeObjs: null,        // Accumulated changes, for firing change events
        cursorActivityHandlers: null, // Set of handlers to fire cursorActivity on
        cursorActivityCalled: 0, // Tracks which cursorActivity handlers have been called already
        selectionChanged: false, // Whether the selection needs to be redrawn
        updateMaxLine: false,    // Set when the widest line needs to be determined anew
        scrollLeft: null, scrollTop: null, // Intermediate scroll position, not pushed to DOM yet
        scrollToPos: null,       // Used to scroll to a specific position
        focus: false,
        id: ++nextOpId           // Unique ID
      };
      pushOperation(cm.curOp);
    }
  
    // Finish an operation, updating the display and signalling delayed events
    function endOperation(cm) {
      var op = cm.curOp;
      if (op) { finishOperation(op, function (group) {
        for (var i = 0; i < group.ops.length; i++)
          { group.ops[i].cm.curOp = null; }
        endOperations(group);
      }); }
    }
  
    // The DOM updates done when an operation finishes are batched so
    // that the minimum number of relayouts are required.
    function endOperations(group) {
      var ops = group.ops;
      for (var i = 0; i < ops.length; i++) // Read DOM
        { endOperation_R1(ops[i]); }
      for (var i$1 = 0; i$1 < ops.length; i$1++) // Write DOM (maybe)
        { endOperation_W1(ops[i$1]); }
      for (var i$2 = 0; i$2 < ops.length; i$2++) // Read DOM
        { endOperation_R2(ops[i$2]); }
      for (var i$3 = 0; i$3 < ops.length; i$3++) // Write DOM (maybe)
        { endOperation_W2(ops[i$3]); }
      for (var i$4 = 0; i$4 < ops.length; i$4++) // Read DOM
        { endOperation_finish(ops[i$4]); }
    }
  
    function endOperation_R1(op) {
      var cm = op.cm, display = cm.display;
      maybeClipScrollbars(cm);
      if (op.updateMaxLine) { findMaxLine(cm); }
  
      op.mustUpdate = op.viewChanged || op.forceUpdate || op.scrollTop != null ||
        op.scrollToPos && (op.scrollToPos.from.line < display.viewFrom ||
                           op.scrollToPos.to.line >= display.viewTo) ||
        display.maxLineChanged && cm.options.lineWrapping;
      op.update = op.mustUpdate &&
        new DisplayUpdate(cm, op.mustUpdate && {top: op.scrollTop, ensure: op.scrollToPos}, op.forceUpdate);
    }
  
    function endOperation_W1(op) {
      op.updatedDisplay = op.mustUpdate && updateDisplayIfNeeded(op.cm, op.update);
    }
  
    function endOperation_R2(op) {
      var cm = op.cm, display = cm.display;
      if (op.updatedDisplay) { updateHeightsInViewport(cm); }
  
      op.barMeasure = measureForScrollbars(cm);
  
      // If the max line changed since it was last measured, measure it,
      // and ensure the document's width matches it.
      // updateDisplay_W2 will use these properties to do the actual resizing
      if (display.maxLineChanged && !cm.options.lineWrapping) {
        op.adjustWidthTo = measureChar(cm, display.maxLine, display.maxLine.text.length).left + 3;
        cm.display.sizerWidth = op.adjustWidthTo;
        op.barMeasure.scrollWidth =
          Math.max(display.scroller.clientWidth, display.sizer.offsetLeft + op.adjustWidthTo + scrollGap(cm) + cm.display.barWidth);
        op.maxScrollLeft = Math.max(0, display.sizer.offsetLeft + op.adjustWidthTo - displayWidth(cm));
      }
  
      if (op.updatedDisplay || op.selectionChanged)
        { op.preparedSelection = display.input.prepareSelection(); }
    }
  
    function endOperation_W2(op) {
      var cm = op.cm;
  
      if (op.adjustWidthTo != null) {
        cm.display.sizer.style.minWidth = op.adjustWidthTo + "px";
        if (op.maxScrollLeft < cm.doc.scrollLeft)
          { setScrollLeft(cm, Math.min(cm.display.scroller.scrollLeft, op.maxScrollLeft), true); }
        cm.display.maxLineChanged = false;
      }
  
      var takeFocus = op.focus && op.focus == activeElt();
      if (op.preparedSelection)
        { cm.display.input.showSelection(op.preparedSelection, takeFocus); }
      if (op.updatedDisplay || op.startHeight != cm.doc.height)
        { updateScrollbars(cm, op.barMeasure); }
      if (op.updatedDisplay)
        { setDocumentHeight(cm, op.barMeasure); }
  
      if (op.selectionChanged) { restartBlink(cm); }
  
      if (cm.state.focused && op.updateInput)
        { cm.display.input.reset(op.typing); }
      if (takeFocus) { ensureFocus(op.cm); }
    }
  
    function endOperation_finish(op) {
      var cm = op.cm, display = cm.display, doc = cm.doc;
  
      if (op.updatedDisplay) { postUpdateDisplay(cm, op.update); }
  
      // Abort mouse wheel delta measurement, when scrolling explicitly
      if (display.wheelStartX != null && (op.scrollTop != null || op.scrollLeft != null || op.scrollToPos))
        { display.wheelStartX = display.wheelStartY = null; }
  
      // Propagate the scroll position to the actual DOM scroller
      if (op.scrollTop != null) { setScrollTop(cm, op.scrollTop, op.forceScroll); }
  
      if (op.scrollLeft != null) { setScrollLeft(cm, op.scrollLeft, true, true); }
      // If we need to scroll a specific position into view, do so.
      if (op.scrollToPos) {
        var rect = scrollPosIntoView(cm, clipPos(doc, op.scrollToPos.from),
                                     clipPos(doc, op.scrollToPos.to), op.scrollToPos.margin);
        maybeScrollWindow(cm, rect);
      }
  
      // Fire events for markers that are hidden/unidden by editing or
      // undoing
      var hidden = op.maybeHiddenMarkers, unhidden = op.maybeUnhiddenMarkers;
      if (hidden) { for (var i = 0; i < hidden.length; ++i)
        { if (!hidden[i].lines.length) { signal(hidden[i], "hide"); } } }
      if (unhidden) { for (var i$1 = 0; i$1 < unhidden.length; ++i$1)
        { if (unhidden[i$1].lines.length) { signal(unhidden[i$1], "unhide"); } } }
  
      if (display.wrapper.offsetHeight)
        { doc.scrollTop = cm.display.scroller.scrollTop; }
  
      // Fire change events, and delayed event handlers
      if (op.changeObjs)
        { signal(cm, "changes", cm, op.changeObjs); }
      if (op.update)
        { op.update.finish(); }
    }
  
    // Run the given function in an operation
    function runInOp(cm, f) {
      if (cm.curOp) { return f() }
      startOperation(cm);
      try { return f() }
      finally { endOperation(cm); }
    }
    // Wraps a function in an operation. Returns the wrapped function.
    function operation(cm, f) {
      return function() {
        if (cm.curOp) { return f.apply(cm, arguments) }
        startOperation(cm);
        try { return f.apply(cm, arguments) }
        finally { endOperation(cm); }
      }
    }
    // Used to add methods to editor and doc instances, wrapping them in
    // operations.
    function methodOp(f) {
      return function() {
        if (this.curOp) { return f.apply(this, arguments) }
        startOperation(this);
        try { return f.apply(this, arguments) }
        finally { endOperation(this); }
      }
    }
    function docMethodOp(f) {
      return function() {
        var cm = this.cm;
        if (!cm || cm.curOp) { return f.apply(this, arguments) }
        startOperation(cm);
        try { return f.apply(this, arguments) }
        finally { endOperation(cm); }
      }
    }
  
    // HIGHLIGHT WORKER
  
    function startWorker(cm, time) {
      if (cm.doc.highlightFrontier < cm.display.viewTo)
        { cm.state.highlight.set(time, bind(highlightWorker, cm)); }
    }
  
    function highlightWorker(cm) {
      var doc = cm.doc;
      if (doc.highlightFrontier >= cm.display.viewTo) { return }
      var end = +new Date + cm.options.workTime;
      var context = getContextBefore(cm, doc.highlightFrontier);
      var changedLines = [];
  
      doc.iter(context.line, Math.min(doc.first + doc.size, cm.display.viewTo + 500), function (line) {
        if (context.line >= cm.display.viewFrom) { // Visible
          var oldStyles = line.styles;
          var resetState = line.text.length > cm.options.maxHighlightLength ? copyState(doc.mode, context.state) : null;
          var highlighted = highlightLine(cm, line, context, true);
          if (resetState) { context.state = resetState; }
          line.styles = highlighted.styles;
          var oldCls = line.styleClasses, newCls = highlighted.classes;
          if (newCls) { line.styleClasses = newCls; }
          else if (oldCls) { line.styleClasses = null; }
          var ischange = !oldStyles || oldStyles.length != line.styles.length ||
            oldCls != newCls && (!oldCls || !newCls || oldCls.bgClass != newCls.bgClass || oldCls.textClass != newCls.textClass);
          for (var i = 0; !ischange && i < oldStyles.length; ++i) { ischange = oldStyles[i] != line.styles[i]; }
          if (ischange) { changedLines.push(context.line); }
          line.stateAfter = context.save();
          context.nextLine();
        } else {
          if (line.text.length <= cm.options.maxHighlightLength)
            { processLine(cm, line.text, context); }
          line.stateAfter = context.line % 5 == 0 ? context.save() : null;
          context.nextLine();
        }
        if (+new Date > end) {
          startWorker(cm, cm.options.workDelay);
          return true
        }
      });
      doc.highlightFrontier = context.line;
      doc.modeFrontier = Math.max(doc.modeFrontier, context.line);
      if (changedLines.length) { runInOp(cm, function () {
        for (var i = 0; i < changedLines.length; i++)
          { regLineChange(cm, changedLines[i], "text"); }
      }); }
    }
  
    // DISPLAY DRAWING
  
    var DisplayUpdate = function(cm, viewport, force) {
      var display = cm.display;
  
      this.viewport = viewport;
      // Store some values that we'll need later (but don't want to force a relayout for)
      this.visible = visibleLines(display, cm.doc, viewport);
      this.editorIsHidden = !display.wrapper.offsetWidth;
      this.wrapperHeight = display.wrapper.clientHeight;
      this.wrapperWidth = display.wrapper.clientWidth;
      this.oldDisplayWidth = displayWidth(cm);
      this.force = force;
      this.dims = getDimensions(cm);
      this.events = [];
    };
  
    DisplayUpdate.prototype.signal = function (emitter, type) {
      if (hasHandler(emitter, type))
        { this.events.push(arguments); }
    };
    DisplayUpdate.prototype.finish = function () {
        var this$1 = this;
  
      for (var i = 0; i < this.events.length; i++)
        { signal.apply(null, this$1.events[i]); }
    };
  
    function maybeClipScrollbars(cm) {
      var display = cm.display;
      if (!display.scrollbarsClipped && display.scroller.offsetWidth) {
        display.nativeBarWidth = display.scroller.offsetWidth - display.scroller.clientWidth;
        display.heightForcer.style.height = scrollGap(cm) + "px";
        display.sizer.style.marginBottom = -display.nativeBarWidth + "px";
        display.sizer.style.borderRightWidth = scrollGap(cm) + "px";
        display.scrollbarsClipped = true;
      }
    }
  
    function selectionSnapshot(cm) {
      if (cm.hasFocus()) { return null }
      var active = activeElt();
      if (!active || !contains(cm.display.lineDiv, active)) { return null }
      var result = {activeElt: active};
      if (window.getSelection) {
        var sel = window.getSelection();
        if (sel.anchorNode && sel.extend && contains(cm.display.lineDiv, sel.anchorNode)) {
          result.anchorNode = sel.anchorNode;
          result.anchorOffset = sel.anchorOffset;
          result.focusNode = sel.focusNode;
          result.focusOffset = sel.focusOffset;
        }
      }
      return result
    }
  
    function restoreSelection(snapshot) {
      if (!snapshot || !snapshot.activeElt || snapshot.activeElt == activeElt()) { return }
      snapshot.activeElt.focus();
      if (snapshot.anchorNode && contains(document.body, snapshot.anchorNode) && contains(document.body, snapshot.focusNode)) {
        var sel = window.getSelection(), range$$1 = document.createRange();
        range$$1.setEnd(snapshot.anchorNode, snapshot.anchorOffset);
        range$$1.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range$$1);
        sel.extend(snapshot.focusNode, snapshot.focusOffset);
      }
    }
  
    // Does the actual updating of the line display. Bails out
    // (returning false) when there is nothing to be done and forced is
    // false.
    function updateDisplayIfNeeded(cm, update) {
      var display = cm.display, doc = cm.doc;
  
      if (update.editorIsHidden) {
        resetView(cm);
        return false
      }
  
      // Bail out if the visible area is already rendered and nothing changed.
      if (!update.force &&
          update.visible.from >= display.viewFrom && update.visible.to <= display.viewTo &&
          (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo) &&
          display.renderedView == display.view && countDirtyView(cm) == 0)
        { return false }
  
      if (maybeUpdateLineNumberWidth(cm)) {
        resetView(cm);
        update.dims = getDimensions(cm);
      }
  
      // Compute a suitable new viewport (from & to)
      var end = doc.first + doc.size;
      var from = Math.max(update.visible.from - cm.options.viewportMargin, doc.first);
      var to = Math.min(end, update.visible.to + cm.options.viewportMargin);
      if (display.viewFrom < from && from - display.viewFrom < 20) { from = Math.max(doc.first, display.viewFrom); }
      if (display.viewTo > to && display.viewTo - to < 20) { to = Math.min(end, display.viewTo); }
      if (sawCollapsedSpans) {
        from = visualLineNo(cm.doc, from);
        to = visualLineEndNo(cm.doc, to);
      }
  
      var different = from != display.viewFrom || to != display.viewTo ||
        display.lastWrapHeight != update.wrapperHeight || display.lastWrapWidth != update.wrapperWidth;
      adjustView(cm, from, to);
  
      display.viewOffset = heightAtLine(getLine(cm.doc, display.viewFrom));
      // Position the mover div to align with the current scroll position
      cm.display.mover.style.top = display.viewOffset + "px";
  
      var toUpdate = countDirtyView(cm);
      if (!different && toUpdate == 0 && !update.force && display.renderedView == display.view &&
          (display.updateLineNumbers == null || display.updateLineNumbers >= display.viewTo))
        { return false }
  
      // For big changes, we hide the enclosing element during the
      // update, since that speeds up the operations on most browsers.
      var selSnapshot = selectionSnapshot(cm);
      if (toUpdate > 4) { display.lineDiv.style.display = "none"; }
      patchDisplay(cm, display.updateLineNumbers, update.dims);
      if (toUpdate > 4) { display.lineDiv.style.display = ""; }
      display.renderedView = display.view;
      // There might have been a widget with a focused element that got
      // hidden or updated, if so re-focus it.
      restoreSelection(selSnapshot);
  
      // Prevent selection and cursors from interfering with the scroll
      // width and height.
      removeChildren(display.cursorDiv);
      removeChildren(display.selectionDiv);
      display.gutters.style.height = display.sizer.style.minHeight = 0;
  
      if (different) {
        display.lastWrapHeight = update.wrapperHeight;
        display.lastWrapWidth = update.wrapperWidth;
        startWorker(cm, 400);
      }
  
      display.updateLineNumbers = null;
  
      return true
    }
  
    function postUpdateDisplay(cm, update) {
      var viewport = update.viewport;
  
      for (var first = true;; first = false) {
        if (!first || !cm.options.lineWrapping || update.oldDisplayWidth == displayWidth(cm)) {
          // Clip forced viewport to actual scrollable area.
          if (viewport && viewport.top != null)
            { viewport = {top: Math.min(cm.doc.height + paddingVert(cm.display) - displayHeight(cm), viewport.top)}; }
          // Updated line heights might result in the drawn area not
          // actually covering the viewport. Keep looping until it does.
          update.visible = visibleLines(cm.display, cm.doc, viewport);
          if (update.visible.from >= cm.display.viewFrom && update.visible.to <= cm.display.viewTo)
            { break }
        } else if (first) {
          update.visible = visibleLines(cm.display, cm.doc, viewport);
        }
        if (!updateDisplayIfNeeded(cm, update)) { break }
        updateHeightsInViewport(cm);
        var barMeasure = measureForScrollbars(cm);
        updateSelection(cm);
        updateScrollbars(cm, barMeasure);
        setDocumentHeight(cm, barMeasure);
        update.force = false;
      }
  
      update.signal(cm, "update", cm);
      if (cm.display.viewFrom != cm.display.reportedViewFrom || cm.display.viewTo != cm.display.reportedViewTo) {
        update.signal(cm, "viewportChange", cm, cm.display.viewFrom, cm.display.viewTo);
        cm.display.reportedViewFrom = cm.display.viewFrom; cm.display.reportedViewTo = cm.display.viewTo;
      }
    }
  
    function updateDisplaySimple(cm, viewport) {
      var update = new DisplayUpdate(cm, viewport);
      if (updateDisplayIfNeeded(cm, update)) {
        updateHeightsInViewport(cm);
        postUpdateDisplay(cm, update);
        var barMeasure = measureForScrollbars(cm);
        updateSelection(cm);
        updateScrollbars(cm, barMeasure);
        setDocumentHeight(cm, barMeasure);
        update.finish();
      }
    }
  
    // Sync the actual display DOM structure with display.view, removing
    // nodes for lines that are no longer in view, and creating the ones
    // that are not there yet, and updating the ones that are out of
    // date.
    function patchDisplay(cm, updateNumbersFrom, dims) {
      var display = cm.display, lineNumbers = cm.options.lineNumbers;
      var container = display.lineDiv, cur = container.firstChild;
  
      function rm(node) {
        var next = node.nextSibling;
        // Works around a throw-scroll bug in OS X Webkit
        if (webkit && mac && cm.display.currentWheelTarget == node)
          { node.style.display = "none"; }
        else
          { node.parentNode.removeChild(node); }
        return next
      }
  
      var view = display.view, lineN = display.viewFrom;
      // Loop over the elements in the view, syncing cur (the DOM nodes
      // in display.lineDiv) with the view as we go.
      for (var i = 0; i < view.length; i++) {
        var lineView = view[i];
        if (lineView.hidden) ; else if (!lineView.node || lineView.node.parentNode != container) { // Not drawn yet
          var node = buildLineElement(cm, lineView, lineN, dims);
          container.insertBefore(node, cur);
        } else { // Already drawn
          while (cur != lineView.node) { cur = rm(cur); }
          var updateNumber = lineNumbers && updateNumbersFrom != null &&
            updateNumbersFrom <= lineN && lineView.lineNumber;
          if (lineView.changes) {
            if (indexOf(lineView.changes, "gutter") > -1) { updateNumber = false; }
            updateLineForChanges(cm, lineView, lineN, dims);
          }
          if (updateNumber) {
            removeChildren(lineView.lineNumber);
            lineView.lineNumber.appendChild(document.createTextNode(lineNumberFor(cm.options, lineN)));
          }
          cur = lineView.node.nextSibling;
        }
        lineN += lineView.size;
      }
      while (cur) { cur = rm(cur); }
    }
  
    function updateGutterSpace(display) {
      var width = display.gutters.offsetWidth;
      display.sizer.style.marginLeft = width + "px";
    }
  
    function setDocumentHeight(cm, measure) {
      cm.display.sizer.style.minHeight = measure.docHeight + "px";
      cm.display.heightForcer.style.top = measure.docHeight + "px";
      cm.display.gutters.style.height = (measure.docHeight + cm.display.barHeight + scrollGap(cm)) + "px";
    }
  
    // Re-align line numbers and gutter marks to compensate for
    // horizontal scrolling.
    function alignHorizontally(cm) {
      var display = cm.display, view = display.view;
      if (!display.alignWidgets && (!display.gutters.firstChild || !cm.options.fixedGutter)) { return }
      var comp = compensateForHScroll(display) - display.scroller.scrollLeft + cm.doc.scrollLeft;
      var gutterW = display.gutters.offsetWidth, left = comp + "px";
      for (var i = 0; i < view.length; i++) { if (!view[i].hidden) {
        if (cm.options.fixedGutter) {
          if (view[i].gutter)
            { view[i].gutter.style.left = left; }
          if (view[i].gutterBackground)
            { view[i].gutterBackground.style.left = left; }
        }
        var align = view[i].alignable;
        if (align) { for (var j = 0; j < align.length; j++)
          { align[j].style.left = left; } }
      } }
      if (cm.options.fixedGutter)
        { display.gutters.style.left = (comp + gutterW) + "px"; }
    }
  
    // Used to ensure that the line number gutter is still the right
    // size for the current document size. Returns true when an update
    // is needed.
    function maybeUpdateLineNumberWidth(cm) {
      if (!cm.options.lineNumbers) { return false }
      var doc = cm.doc, last = lineNumberFor(cm.options, doc.first + doc.size - 1), display = cm.display;
      if (last.length != display.lineNumChars) {
        var test = display.measure.appendChild(elt("div", [elt("div", last)],
                                                   "CodeMirror-linenumber CodeMirror-gutter-elt"));
        var innerW = test.firstChild.offsetWidth, padding = test.offsetWidth - innerW;
        display.lineGutter.style.width = "";
        display.lineNumInnerWidth = Math.max(innerW, display.lineGutter.offsetWidth - padding) + 1;
        display.lineNumWidth = display.lineNumInnerWidth + padding;
        display.lineNumChars = display.lineNumInnerWidth ? last.length : -1;
        display.lineGutter.style.width = display.lineNumWidth + "px";
        updateGutterSpace(cm.display);
        return true
      }
      return false
    }
  
    function getGutters(gutters, lineNumbers) {
      var result = [], sawLineNumbers = false;
      for (var i = 0; i < gutters.length; i++) {
        var name = gutters[i], style = null;
        if (typeof name != "string") { style = name.style; name = name.className; }
        if (name == "CodeMirror-linenumbers") {
          if (!lineNumbers) { continue }
          else { sawLineNumbers = true; }
        }
        result.push({className: name, style: style});
      }
      if (lineNumbers && !sawLineNumbers) { result.push({className: "CodeMirror-linenumbers", style: null}); }
      return result
    }
  
    // Rebuild the gutter elements, ensure the margin to the left of the
    // code matches their width.
    function renderGutters(display) {
      var gutters = display.gutters, specs = display.gutterSpecs;
      removeChildren(gutters);
      display.lineGutter = null;
      for (var i = 0; i < specs.length; ++i) {
        var ref = specs[i];
        var className = ref.className;
        var style = ref.style;
        var gElt = gutters.appendChild(elt("div", null, "CodeMirror-gutter " + className));
        if (style) { gElt.style.cssText = style; }
        if (className == "CodeMirror-linenumbers") {
          display.lineGutter = gElt;
          gElt.style.width = (display.lineNumWidth || 1) + "px";
        }
      }
      gutters.style.display = specs.length ? "" : "none";
      updateGutterSpace(display);
    }
  
    function updateGutters(cm) {
      renderGutters(cm.display);
      regChange(cm);
      alignHorizontally(cm);
    }
  
    // The display handles the DOM integration, both for input reading
    // and content drawing. It holds references to DOM nodes and
    // display-related state.
  
    function Display(place, doc, input, options) {
      var d = this;
      this.input = input;
  
      // Covers bottom-right square when both scrollbars are present.
      d.scrollbarFiller = elt("div", null, "CodeMirror-scrollbar-filler");
      d.scrollbarFiller.setAttribute("cm-not-content", "true");
      // Covers bottom of gutter when coverGutterNextToScrollbar is on
      // and h scrollbar is present.
      d.gutterFiller = elt("div", null, "CodeMirror-gutter-filler");
      d.gutterFiller.setAttribute("cm-not-content", "true");
      // Will contain the actual code, positioned to cover the viewport.
      d.lineDiv = eltP("div", null, "CodeMirror-code");
      // Elements are added to these to represent selection and cursors.
      d.selectionDiv = elt("div", null, null, "position: relative; z-index: 1");
      d.cursorDiv = elt("div", null, "CodeMirror-cursors");
      // A visibility: hidden element used to find the size of things.
      d.measure = elt("div", null, "CodeMirror-measure");
      // When lines outside of the viewport are measured, they are drawn in this.
      d.lineMeasure = elt("div", null, "CodeMirror-measure");
      // Wraps everything that needs to exist inside the vertically-padded coordinate system
      d.lineSpace = eltP("div", [d.measure, d.lineMeasure, d.selectionDiv, d.cursorDiv, d.lineDiv],
                        null, "position: relative; outline: none");
      var lines = eltP("div", [d.lineSpace], "CodeMirror-lines");
      // Moved around its parent to cover visible view.
      d.mover = elt("div", [lines], null, "position: relative");
      // Set to the height of the document, allowing scrolling.
      d.sizer = elt("div", [d.mover], "CodeMirror-sizer");
      d.sizerWidth = null;
      // Behavior of elts with overflow: auto and padding is
      // inconsistent across browsers. This is used to ensure the
      // scrollable area is big enough.
      d.heightForcer = elt("div", null, null, "position: absolute; height: " + scrollerGap + "px; width: 1px;");
      // Will contain the gutters, if any.
      d.gutters = elt("div", null, "CodeMirror-gutters");
      d.lineGutter = null;
      // Actual scrollable element.
      d.scroller = elt("div", [d.sizer, d.heightForcer, d.gutters], "CodeMirror-scroll");
      d.scroller.setAttribute("tabIndex", "-1");
      // The element in which the editor lives.
      d.wrapper = elt("div", [d.scrollbarFiller, d.gutterFiller, d.scroller], "CodeMirror");
  
      // Work around IE7 z-index bug (not perfect, hence IE7 not really being supported)
      if (ie && ie_version < 8) { d.gutters.style.zIndex = -1; d.scroller.style.paddingRight = 0; }
      if (!webkit && !(gecko && mobile)) { d.scroller.draggable = true; }
  
      if (place) {
        if (place.appendChild) { place.appendChild(d.wrapper); }
        else { place(d.wrapper); }
      }
  
      // Current rendered range (may be bigger than the view window).
      d.viewFrom = d.viewTo = doc.first;
      d.reportedViewFrom = d.reportedViewTo = doc.first;
      // Information about the rendered lines.
      d.view = [];
      d.renderedView = null;
      // Holds info about a single rendered line when it was rendered
      // for measurement, while not in view.
      d.externalMeasured = null;
      // Empty space (in pixels) above the view
      d.viewOffset = 0;
      d.lastWrapHeight = d.lastWrapWidth = 0;
      d.updateLineNumbers = null;
  
      d.nativeBarWidth = d.barHeight = d.barWidth = 0;
      d.scrollbarsClipped = false;
  
      // Used to only resize the line number gutter when necessary (when
      // the amount of lines crosses a boundary that makes its width change)
      d.lineNumWidth = d.lineNumInnerWidth = d.lineNumChars = null;
      // Set to true when a non-horizontal-scrolling line widget is
      // added. As an optimization, line widget aligning is skipped when
      // this is false.
      d.alignWidgets = false;
  
      d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
  
      // Tracks the maximum line length so that the horizontal scrollbar
      // can be kept static when scrolling.
      d.maxLine = null;
      d.maxLineLength = 0;
      d.maxLineChanged = false;
  
      // Used for measuring wheel scrolling granularity
      d.wheelDX = d.wheelDY = d.wheelStartX = d.wheelStartY = null;
  
      // True when shift is held down.
      d.shift = false;
  
      // Used to track whether anything happened since the context menu
      // was opened.
      d.selForContextMenu = null;
  
      d.activeTouch = null;
  
      d.gutterSpecs = getGutters(options.gutters, options.lineNumbers);
      renderGutters(d);
  
      input.init(d);
    }
  
    // Since the delta values reported on mouse wheel events are
    // unstandardized between browsers and even browser versions, and
    // generally horribly unpredictable, this code starts by measuring
    // the scroll effect that the first few mouse wheel events have,
    // and, from that, detects the way it can convert deltas to pixel
    // offsets afterwards.
    //
    // The reason we want to know the amount a wheel event will scroll
    // is that it gives us a chance to update the display before the
    // actual scrolling happens, reducing flickering.
  
    var wheelSamples = 0, wheelPixelsPerUnit = null;
    // Fill in a browser-detected starting value on browsers where we
    // know one. These don't have to be accurate -- the result of them
    // being wrong would just be a slight flicker on the first wheel
    // scroll (if it is large enough).
    if (ie) { wheelPixelsPerUnit = -.53; }
    else if (gecko) { wheelPixelsPerUnit = 15; }
    else if (chrome) { wheelPixelsPerUnit = -.7; }
    else if (safari) { wheelPixelsPerUnit = -1/3; }
  
    function wheelEventDelta(e) {
      var dx = e.wheelDeltaX, dy = e.wheelDeltaY;
      if (dx == null && e.detail && e.axis == e.HORIZONTAL_AXIS) { dx = e.detail; }
      if (dy == null && e.detail && e.axis == e.VERTICAL_AXIS) { dy = e.detail; }
      else if (dy == null) { dy = e.wheelDelta; }
      return {x: dx, y: dy}
    }
    function wheelEventPixels(e) {
      var delta = wheelEventDelta(e);
      delta.x *= wheelPixelsPerUnit;
      delta.y *= wheelPixelsPerUnit;
      return delta
    }
  
    function onScrollWheel(cm, e) {
      var delta = wheelEventDelta(e), dx = delta.x, dy = delta.y;
  
      var display = cm.display, scroll = display.scroller;
      // Quit if there's nothing to scroll here
      var canScrollX = scroll.scrollWidth > scroll.clientWidth;
      var canScrollY = scroll.scrollHeight > scroll.clientHeight;
      if (!(dx && canScrollX || dy && canScrollY)) { return }
  
      // Webkit browsers on OS X abort momentum scrolls when the target
      // of the scroll event is removed from the scrollable element.
      // This hack (see related code in patchDisplay) makes sure the
      // element is kept around.
      if (dy && mac && webkit) {
        outer: for (var cur = e.target, view = display.view; cur != scroll; cur = cur.parentNode) {
          for (var i = 0; i < view.length; i++) {
            if (view[i].node == cur) {
              cm.display.currentWheelTarget = cur;
              break outer
            }
          }
        }
      }
  
      // On some browsers, horizontal scrolling will cause redraws to
      // happen before the gutter has been realigned, causing it to
      // wriggle around in a most unseemly way. When we have an
      // estimated pixels/delta value, we just handle horizontal
      // scrolling entirely here. It'll be slightly off from native, but
      // better than glitching out.
      if (dx && !gecko && !presto && wheelPixelsPerUnit != null) {
        if (dy && canScrollY)
          { updateScrollTop(cm, Math.max(0, scroll.scrollTop + dy * wheelPixelsPerUnit)); }
        setScrollLeft(cm, Math.max(0, scroll.scrollLeft + dx * wheelPixelsPerUnit));
        // Only prevent default scrolling if vertical scrolling is
        // actually possible. Otherwise, it causes vertical scroll
        // jitter on OSX trackpads when deltaX is small and deltaY
        // is large (issue #3579)
        if (!dy || (dy && canScrollY))
          { e_preventDefault(e); }
        display.wheelStartX = null; // Abort measurement, if in progress
        return
      }
  
      // 'Project' the visible viewport to cover the area that is being
      // scrolled into view (if we know enough to estimate it).
      if (dy && wheelPixelsPerUnit != null) {
        var pixels = dy * wheelPixelsPerUnit;
        var top = cm.doc.scrollTop, bot = top + display.wrapper.clientHeight;
        if (pixels < 0) { top = Math.max(0, top + pixels - 50); }
        else { bot = Math.min(cm.doc.height, bot + pixels + 50); }
        updateDisplaySimple(cm, {top: top, bottom: bot});
      }
  
      if (wheelSamples < 20) {
        if (display.wheelStartX == null) {
          display.wheelStartX = scroll.scrollLeft; display.wheelStartY = scroll.scrollTop;
          display.wheelDX = dx; display.wheelDY = dy;
          setTimeout(function () {
            if (display.wheelStartX == null) { return }
            var movedX = scroll.scrollLeft - display.wheelStartX;
            var movedY = scroll.scrollTop - display.wheelStartY;
            var sample = (movedY && display.wheelDY && movedY / display.wheelDY) ||
              (movedX && display.wheelDX && movedX / display.wheelDX);
            display.wheelStartX = display.wheelStartY = null;
            if (!sample) { return }
            wheelPixelsPerUnit = (wheelPixelsPerUnit * wheelSamples + sample) / (wheelSamples + 1);
            ++wheelSamples;
          }, 200);
        } else {
          display.wheelDX += dx; display.wheelDY += dy;
        }
      }
    }
  
    // Selection objects are immutable. A new one is created every time
    // the selection changes. A selection is one or more non-overlapping
    // (and non-touching) ranges, sorted, and an integer that indicates
    // which one is the primary selection (the one that's scrolled into
    // view, that getCursor returns, etc).
    var Selection = function(ranges, primIndex) {
      this.ranges = ranges;
      this.primIndex = primIndex;
    };
  
    Selection.prototype.primary = function () { return this.ranges[this.primIndex] };
  
    Selection.prototype.equals = function (other) {
        var this$1 = this;
  
      if (other == this) { return true }
      if (other.primIndex != this.primIndex || other.ranges.length != this.ranges.length) { return false }
      for (var i = 0; i < this.ranges.length; i++) {
        var here = this$1.ranges[i], there = other.ranges[i];
        if (!equalCursorPos(here.anchor, there.anchor) || !equalCursorPos(here.head, there.head)) { return false }
      }
      return true
    };
  
    Selection.prototype.deepCopy = function () {
        var this$1 = this;
  
      var out = [];
      for (var i = 0; i < this.ranges.length; i++)
        { out[i] = new Range(copyPos(this$1.ranges[i].anchor), copyPos(this$1.ranges[i].head)); }
      return new Selection(out, this.primIndex)
    };
  
    Selection.prototype.somethingSelected = function () {
        var this$1 = this;
  
      for (var i = 0; i < this.ranges.length; i++)
        { if (!this$1.ranges[i].empty()) { return true } }
      return false
    };
  
    Selection.prototype.contains = function (pos, end) {
        var this$1 = this;
  
      if (!end) { end = pos; }
      for (var i = 0; i < this.ranges.length; i++) {
        var range = this$1.ranges[i];
        if (cmp(end, range.from()) >= 0 && cmp(pos, range.to()) <= 0)
          { return i }
      }
      return -1
    };
  
    var Range = function(anchor, head) {
      this.anchor = anchor; this.head = head;
    };
  
    Range.prototype.from = function () { return minPos(this.anchor, this.head) };
    Range.prototype.to = function () { return maxPos(this.anchor, this.head) };
    Range.prototype.empty = function () { return this.head.line == this.anchor.line && this.head.ch == this.anchor.ch };
  
    // Take an unsorted, potentially overlapping set of ranges, and
    // build a selection out of it. 'Consumes' ranges array (modifying
    // it).
    function normalizeSelection(cm, ranges, primIndex) {
      var mayTouch = cm && cm.options.selectionsMayTouch;
      var prim = ranges[primIndex];
      ranges.sort(function (a, b) { return cmp(a.from(), b.from()); });
      primIndex = indexOf(ranges, prim);
      for (var i = 1; i < ranges.length; i++) {
        var cur = ranges[i], prev = ranges[i - 1];
        var diff = cmp(prev.to(), cur.from());
        if (mayTouch && !cur.empty() ? diff > 0 : diff >= 0) {
          var from = minPos(prev.from(), cur.from()), to = maxPos(prev.to(), cur.to());
          var inv = prev.empty() ? cur.from() == cur.head : prev.from() == prev.head;
          if (i <= primIndex) { --primIndex; }
          ranges.splice(--i, 2, new Range(inv ? to : from, inv ? from : to));
        }
      }
      return new Selection(ranges, primIndex)
    }
  
    function simpleSelection(anchor, head) {
      return new Selection([new Range(anchor, head || anchor)], 0)
    }
  
    // Compute the position of the end of a change (its 'to' property
    // refers to the pre-change end).
    function changeEnd(change) {
      if (!change.text) { return change.to }
      return Pos(change.from.line + change.text.length - 1,
                 lst(change.text).length + (change.text.length == 1 ? change.from.ch : 0))
    }
  
    // Adjust a position to refer to the post-change position of the
    // same text, or the end of the change if the change covers it.
    function adjustForChange(pos, change) {
      if (cmp(pos, change.from) < 0) { return pos }
      if (cmp(pos, change.to) <= 0) { return changeEnd(change) }
  
      var line = pos.line + change.text.length - (change.to.line - change.from.line) - 1, ch = pos.ch;
      if (pos.line == change.to.line) { ch += changeEnd(change).ch - change.to.ch; }
      return Pos(line, ch)
    }
  
    function computeSelAfterChange(doc, change) {
      var out = [];
      for (var i = 0; i < doc.sel.ranges.length; i++) {
        var range = doc.sel.ranges[i];
        out.push(new Range(adjustForChange(range.anchor, change),
                           adjustForChange(range.head, change)));
      }
      return normalizeSelection(doc.cm, out, doc.sel.primIndex)
    }
  
    function offsetPos(pos, old, nw) {
      if (pos.line == old.line)
        { return Pos(nw.line, pos.ch - old.ch + nw.ch) }
      else
        { return Pos(nw.line + (pos.line - old.line), pos.ch) }
    }
  
    // Used by replaceSelections to allow moving the selection to the
    // start or around the replaced test. Hint may be "start" or "around".
    function computeReplacedSel(doc, changes, hint) {
      var out = [];
      var oldPrev = Pos(doc.first, 0), newPrev = oldPrev;
      for (var i = 0; i < changes.length; i++) {
        var change = changes[i];
        var from = offsetPos(change.from, oldPrev, newPrev);
        var to = offsetPos(changeEnd(change), oldPrev, newPrev);
        oldPrev = change.to;
        newPrev = to;
        if (hint == "around") {
          var range = doc.sel.ranges[i], inv = cmp(range.head, range.anchor) < 0;
          out[i] = new Range(inv ? to : from, inv ? from : to);
        } else {
          out[i] = new Range(from, from);
        }
      }
      return new Selection(out, doc.sel.primIndex)
    }
  
    // Used to get the editor into a consistent state again when options change.
  
    function loadMode(cm) {
      cm.doc.mode = getMode(cm.options, cm.doc.modeOption);
      resetModeState(cm);
    }
  
    function resetModeState(cm) {
      cm.doc.iter(function (line) {
        if (line.stateAfter) { line.stateAfter = null; }
        if (line.styles) { line.styles = null; }
      });
      cm.doc.modeFrontier = cm.doc.highlightFrontier = cm.doc.first;
      startWorker(cm, 100);
      cm.state.modeGen++;
      if (cm.curOp) { regChange(cm); }
    }
  
    // DOCUMENT DATA STRUCTURE
  
    // By default, updates that start and end at the beginning of a line
    // are treated specially, in order to make the association of line
    // widgets and marker elements with the text behave more intuitive.
    function isWholeLineUpdate(doc, change) {
      return change.from.ch == 0 && change.to.ch == 0 && lst(change.text) == "" &&
        (!doc.cm || doc.cm.options.wholeLineUpdateBefore)
    }
  
    // Perform a change on the document data structure.
    function updateDoc(doc, change, markedSpans, estimateHeight$$1) {
      function spansFor(n) {return markedSpans ? markedSpans[n] : null}
      function update(line, text, spans) {
        updateLine(line, text, spans, estimateHeight$$1);
        signalLater(line, "change", line, change);
      }
      function linesFor(start, end) {
        var result = [];
        for (var i = start; i < end; ++i)
          { result.push(new Line(text[i], spansFor(i), estimateHeight$$1)); }
        return result
      }
  
      var from = change.from, to = change.to, text = change.text;
      var firstLine = getLine(doc, from.line), lastLine = getLine(doc, to.line);
      var lastText = lst(text), lastSpans = spansFor(text.length - 1), nlines = to.line - from.line;
  
      // Adjust the line structure
      if (change.full) {
        doc.insert(0, linesFor(0, text.length));
        doc.remove(text.length, doc.size - text.length);
      } else if (isWholeLineUpdate(doc, change)) {
        // This is a whole-line replace. Treated specially to make
        // sure line objects move the way they are supposed to.
        var added = linesFor(0, text.length - 1);
        update(lastLine, lastLine.text, lastSpans);
        if (nlines) { doc.remove(from.line, nlines); }
        if (added.length) { doc.insert(from.line, added); }
      } else if (firstLine == lastLine) {
        if (text.length == 1) {
          update(firstLine, firstLine.text.slice(0, from.ch) + lastText + firstLine.text.slice(to.ch), lastSpans);
        } else {
          var added$1 = linesFor(1, text.length - 1);
          added$1.push(new Line(lastText + firstLine.text.slice(to.ch), lastSpans, estimateHeight$$1));
          update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
          doc.insert(from.line + 1, added$1);
        }
      } else if (text.length == 1) {
        update(firstLine, firstLine.text.slice(0, from.ch) + text[0] + lastLine.text.slice(to.ch), spansFor(0));
        doc.remove(from.line + 1, nlines);
      } else {
        update(firstLine, firstLine.text.slice(0, from.ch) + text[0], spansFor(0));
        update(lastLine, lastText + lastLine.text.slice(to.ch), lastSpans);
        var added$2 = linesFor(1, text.length - 1);
        if (nlines > 1) { doc.remove(from.line + 1, nlines - 1); }
        doc.insert(from.line + 1, added$2);
      }
  
      signalLater(doc, "change", doc, change);
    }
  
    // Call f for all linked documents.
    function linkedDocs(doc, f, sharedHistOnly) {
      function propagate(doc, skip, sharedHist) {
        if (doc.linked) { for (var i = 0; i < doc.linked.length; ++i) {
          var rel = doc.linked[i];
          if (rel.doc == skip) { continue }
          var shared = sharedHist && rel.sharedHist;
          if (sharedHistOnly && !shared) { continue }
          f(rel.doc, shared);
          propagate(rel.doc, doc, shared);
        } }
      }
      propagate(doc, null, true);
    }
  
    // Attach a document to an editor.
    function attachDoc(cm, doc) {
      if (doc.cm) { throw new Error("This document is already in use.") }
      cm.doc = doc;
      doc.cm = cm;
      estimateLineHeights(cm);
      loadMode(cm);
      setDirectionClass(cm);
      if (!cm.options.lineWrapping) { findMaxLine(cm); }
      cm.options.mode = doc.modeOption;
      regChange(cm);
    }
  
    function setDirectionClass(cm) {
    (cm.doc.direction == "rtl" ? addClass : rmClass)(cm.display.lineDiv, "CodeMirror-rtl");
    }
  
    function directionChanged(cm) {
      runInOp(cm, function () {
        setDirectionClass(cm);
        regChange(cm);
      });
    }
  
    function History(startGen) {
      // Arrays of change events and selections. Doing something adds an
      // event to done and clears undo. Undoing moves events from done
      // to undone, redoing moves them in the other direction.
      this.done = []; this.undone = [];
      this.undoDepth = Infinity;
      // Used to track when changes can be merged into a single undo
      // event
      this.lastModTime = this.lastSelTime = 0;
      this.lastOp = this.lastSelOp = null;
      this.lastOrigin = this.lastSelOrigin = null;
      // Used by the isClean() method
      this.generation = this.maxGeneration = startGen || 1;
    }
  
    // Create a history change event from an updateDoc-style change
    // object.
    function historyChangeFromChange(doc, change) {
      var histChange = {from: copyPos(change.from), to: changeEnd(change), text: getBetween(doc, change.from, change.to)};
      attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1);
      linkedDocs(doc, function (doc) { return attachLocalSpans(doc, histChange, change.from.line, change.to.line + 1); }, true);
      return histChange
    }
  
    // Pop all selection events off the end of a history array. Stop at
    // a change event.
    function clearSelectionEvents(array) {
      while (array.length) {
        var last = lst(array);
        if (last.ranges) { array.pop(); }
        else { break }
      }
    }
  
    // Find the top change event in the history. Pop off selection
    // events that are in the way.
    function lastChangeEvent(hist, force) {
      if (force) {
        clearSelectionEvents(hist.done);
        return lst(hist.done)
      } else if (hist.done.length && !lst(hist.done).ranges) {
        return lst(hist.done)
      } else if (hist.done.length > 1 && !hist.done[hist.done.length - 2].ranges) {
        hist.done.pop();
        return lst(hist.done)
      }
    }
  
    // Register a change in the history. Merges changes that are within
    // a single operation, or are close together with an origin that
    // allows merging (starting with "+") into a single event.
    function addChangeToHistory(doc, change, selAfter, opId) {
      var hist = doc.history;
      hist.undone.length = 0;
      var time = +new Date, cur;
      var last;
  
      if ((hist.lastOp == opId ||
           hist.lastOrigin == change.origin && change.origin &&
           ((change.origin.charAt(0) == "+" && hist.lastModTime > time - (doc.cm ? doc.cm.options.historyEventDelay : 500)) ||
            change.origin.charAt(0) == "*")) &&
          (cur = lastChangeEvent(hist, hist.lastOp == opId))) {
        // Merge this change into the last event
        last = lst(cur.changes);
        if (cmp(change.from, change.to) == 0 && cmp(change.from, last.to) == 0) {
          // Optimized case for simple insertion -- don't want to add
          // new changesets for every character typed
          last.to = changeEnd(change);
        } else {
          // Add new sub-event
          cur.changes.push(historyChangeFromChange(doc, change));
        }
      } else {
        // Can not be merged, start a new event.
        var before = lst(hist.done);
        if (!before || !before.ranges)
          { pushSelectionToHistory(doc.sel, hist.done); }
        cur = {changes: [historyChangeFromChange(doc, change)],
               generation: hist.generation};
        hist.done.push(cur);
        while (hist.done.length > hist.undoDepth) {
          hist.done.shift();
          if (!hist.done[0].ranges) { hist.done.shift(); }
        }
      }
      hist.done.push(selAfter);
      hist.generation = ++hist.maxGeneration;
      hist.lastModTime = hist.lastSelTime = time;
      hist.lastOp = hist.lastSelOp = opId;
      hist.lastOrigin = hist.lastSelOrigin = change.origin;
  
      if (!last) { signal(doc, "historyAdded"); }
    }
  
    function selectionEventCanBeMerged(doc, origin, prev, sel) {
      var ch = origin.charAt(0);
      return ch == "*" ||
        ch == "+" &&
        prev.ranges.length == sel.ranges.length &&
        prev.somethingSelected() == sel.somethingSelected() &&
        new Date - doc.history.lastSelTime <= (doc.cm ? doc.cm.options.historyEventDelay : 500)
    }
  
    // Called whenever the selection changes, sets the new selection as
    // the pending selection in the history, and pushes the old pending
    // selection into the 'done' array when it was significantly
    // different (in number of selected ranges, emptiness, or time).
    function addSelectionToHistory(doc, sel, opId, options) {
      var hist = doc.history, origin = options && options.origin;
  
      // A new event is started when the previous origin does not match
      // the current, or the origins don't allow matching. Origins
      // starting with * are always merged, those starting with + are
      // merged when similar and close together in time.
      if (opId == hist.lastSelOp ||
          (origin && hist.lastSelOrigin == origin &&
           (hist.lastModTime == hist.lastSelTime && hist.lastOrigin == origin ||
            selectionEventCanBeMerged(doc, origin, lst(hist.done), sel))))
        { hist.done[hist.done.length - 1] = sel; }
      else
        { pushSelectionToHistory(sel, hist.done); }
  
      hist.lastSelTime = +new Date;
      hist.lastSelOrigin = origin;
      hist.lastSelOp = opId;
      if (options && options.clearRedo !== false)
        { clearSelectionEvents(hist.undone); }
    }
  
    function pushSelectionToHistory(sel, dest) {
      var top = lst(dest);
      if (!(top && top.ranges && top.equals(sel)))
        { dest.push(sel); }
    }
  
    // Used to store marked span information in the history.
    function attachLocalSpans(doc, change, from, to) {
      var existing = change["spans_" + doc.id], n = 0;
      doc.iter(Math.max(doc.first, from), Math.min(doc.first + doc.size, to), function (line) {
        if (line.markedSpans)
          { (existing || (existing = change["spans_" + doc.id] = {}))[n] = line.markedSpans; }
        ++n;
      });
    }
  
    // When un/re-doing restores text containing marked spans, those
    // that have been explicitly cleared should not be restored.
    function removeClearedSpans(spans) {
      if (!spans) { return null }
      var out;
      for (var i = 0; i < spans.length; ++i) {
        if (spans[i].marker.explicitlyCleared) { if (!out) { out = spans.slice(0, i); } }
        else if (out) { out.push(spans[i]); }
      }
      return !out ? spans : out.length ? out : null
    }
  
    // Retrieve and filter the old marked spans stored in a change event.
    function getOldSpans(doc, change) {
      var found = change["spans_" + doc.id];
      if (!found) { return null }
      var nw = [];
      for (var i = 0; i < change.text.length; ++i)
        { nw.push(removeClearedSpans(found[i])); }
      return nw
    }
  
    // Used for un/re-doing changes from the history. Combines the
    // result of computing the existing spans with the set of spans that
    // existed in the history (so that deleting around a span and then
    // undoing brings back the span).
    function mergeOldSpans(doc, change) {
      var old = getOldSpans(doc, change);
      var stretched = stretchSpansOverChange(doc, change);
      if (!old) { return stretched }
      if (!stretched) { return old }
  
      for (var i = 0; i < old.length; ++i) {
        var oldCur = old[i], stretchCur = stretched[i];
        if (oldCur && stretchCur) {
          spans: for (var j = 0; j < stretchCur.length; ++j) {
            var span = stretchCur[j];
            for (var k = 0; k < oldCur.length; ++k)
              { if (oldCur[k].marker == span.marker) { continue spans } }
            oldCur.push(span);
          }
        } else if (stretchCur) {
          old[i] = stretchCur;
        }
      }
      return old
    }
  
    // Used both to provide a JSON-safe object in .getHistory, and, when
    // detaching a document, to split the history in two
    function copyHistoryArray(events, newGroup, instantiateSel) {
      var copy = [];
      for (var i = 0; i < events.length; ++i) {
        var event = events[i];
        if (event.ranges) {
          copy.push(instantiateSel ? Selection.prototype.deepCopy.call(event) : event);
          continue
        }
        var changes = event.changes, newChanges = [];
        copy.push({changes: newChanges});
        for (var j = 0; j < changes.length; ++j) {
          var change = changes[j], m = (void 0);
          newChanges.push({from: change.from, to: change.to, text: change.text});
          if (newGroup) { for (var prop in change) { if (m = prop.match(/^spans_(\d+)$/)) {
            if (indexOf(newGroup, Number(m[1])) > -1) {
              lst(newChanges)[prop] = change[prop];
              delete change[prop];
            }
          } } }
        }
      }
      return copy
    }
  
    // The 'scroll' parameter given to many of these indicated whether
    // the new cursor position should be scrolled into view after
    // modifying the selection.
  
    // If shift is held or the extend flag is set, extends a range to
    // include a given position (and optionally a second position).
    // Otherwise, simply returns the range between the given positions.
    // Used for cursor motion and such.
    function extendRange(range, head, other, extend) {
      if (extend) {
        var anchor = range.anchor;
        if (other) {
          var posBefore = cmp(head, anchor) < 0;
          if (posBefore != (cmp(other, anchor) < 0)) {
            anchor = head;
            head = other;
          } else if (posBefore != (cmp(head, other) < 0)) {
            head = other;
          }
        }
        return new Range(anchor, head)
      } else {
        return new Range(other || head, head)
      }
    }
  
    // Extend the primary selection range, discard the rest.
    function extendSelection(doc, head, other, options, extend) {
      if (extend == null) { extend = doc.cm && (doc.cm.display.shift || doc.extend); }
      setSelection(doc, new Selection([extendRange(doc.sel.primary(), head, other, extend)], 0), options);
    }
  
    // Extend all selections (pos is an array of selections with length
    // equal the number of selections)
    function extendSelections(doc, heads, options) {
      var out = [];
      var extend = doc.cm && (doc.cm.display.shift || doc.extend);
      for (var i = 0; i < doc.sel.ranges.length; i++)
        { out[i] = extendRange(doc.sel.ranges[i], heads[i], null, extend); }
      var newSel = normalizeSelection(doc.cm, out, doc.sel.primIndex);
      setSelection(doc, newSel, options);
    }
  
    // Updates a single range in the selection.
    function replaceOneSelection(doc, i, range, options) {
      var ranges = doc.sel.ranges.slice(0);
      ranges[i] = range;
      setSelection(doc, normalizeSelection(doc.cm, ranges, doc.sel.primIndex), options);
    }
  
    // Reset the selection to a single range.
    function setSimpleSelection(doc, anchor, head, options) {
      setSelection(doc, simpleSelection(anchor, head), options);
    }
  
    // Give beforeSelectionChange handlers a change to influence a
    // selection update.
    function filterSelectionChange(doc, sel, options) {
      var obj = {
        ranges: sel.ranges,
        update: function(ranges) {
          var this$1 = this;
  
          this.ranges = [];
          for (var i = 0; i < ranges.length; i++)
            { this$1.ranges[i] = new Range(clipPos(doc, ranges[i].anchor),
                                       clipPos(doc, ranges[i].head)); }
        },
        origin: options && options.origin
      };
      signal(doc, "beforeSelectionChange", doc, obj);
      if (doc.cm) { signal(doc.cm, "beforeSelectionChange", doc.cm, obj); }
      if (obj.ranges != sel.ranges) { return normalizeSelection(doc.cm, obj.ranges, obj.ranges.length - 1) }
      else { return sel }
    }
  
    function setSelectionReplaceHistory(doc, sel, options) {
      var done = doc.history.done, last = lst(done);
      if (last && last.ranges) {
        done[done.length - 1] = sel;
        setSelectionNoUndo(doc, sel, options);
      } else {
        setSelection(doc, sel, options);
      }
    }
  
    // Set a new selection.
    function setSelection(doc, sel, options) {
      setSelectionNoUndo(doc, sel, options);
      addSelectionToHistory(doc, doc.sel, doc.cm ? doc.cm.curOp.id : NaN, options);
    }
  
    function setSelectionNoUndo(doc, sel, options) {
      if (hasHandler(doc, "beforeSelectionChange") || doc.cm && hasHandler(doc.cm, "beforeSelectionChange"))
        { sel = filterSelectionChange(doc, sel, options); }
  
      var bias = options && options.bias ||
        (cmp(sel.primary().head, doc.sel.primary().head) < 0 ? -1 : 1);
      setSelectionInner(doc, skipAtomicInSelection(doc, sel, bias, true));
  
      if (!(options && options.scroll === false) && doc.cm)
        { ensureCursorVisible(doc.cm); }
    }
  
    function setSelectionInner(doc, sel) {
      if (sel.equals(doc.sel)) { return }
  
      doc.sel = sel;
  
      if (doc.cm) {
        doc.cm.curOp.updateInput = 1;
        doc.cm.curOp.selectionChanged = true;
        signalCursorActivity(doc.cm);
      }
      signalLater(doc, "cursorActivity", doc);
    }
  
    // Verify that the selection does not partially select any atomic
    // marked ranges.
    function reCheckSelection(doc) {
      setSelectionInner(doc, skipAtomicInSelection(doc, doc.sel, null, false));
    }
  
    // Return a selection that does not partially select any atomic
    // ranges.
    function skipAtomicInSelection(doc, sel, bias, mayClear) {
      var out;
      for (var i = 0; i < sel.ranges.length; i++) {
        var range = sel.ranges[i];
        var old = sel.ranges.length == doc.sel.ranges.length && doc.sel.ranges[i];
        var newAnchor = skipAtomic(doc, range.anchor, old && old.anchor, bias, mayClear);
        var newHead = skipAtomic(doc, range.head, old && old.head, bias, mayClear);
        if (out || newAnchor != range.anchor || newHead != range.head) {
          if (!out) { out = sel.ranges.slice(0, i); }
          out[i] = new Range(newAnchor, newHead);
        }
      }
      return out ? normalizeSelection(doc.cm, out, sel.primIndex) : sel
    }
  
    function skipAtomicInner(doc, pos, oldPos, dir, mayClear) {
      var line = getLine(doc, pos.line);
      if (line.markedSpans) { for (var i = 0; i < line.markedSpans.length; ++i) {
        var sp = line.markedSpans[i], m = sp.marker;
  
        // Determine if we should prevent the cursor being placed to the left/right of an atomic marker
        // Historically this was determined using the inclusiveLeft/Right option, but the new way to control it
        // is with selectLeft/Right
        var preventCursorLeft = ("selectLeft" in m) ? !m.selectLeft : m.inclusiveLeft;
        var preventCursorRight = ("selectRight" in m) ? !m.selectRight : m.inclusiveRight;
  
        if ((sp.from == null || (preventCursorLeft ? sp.from <= pos.ch : sp.from < pos.ch)) &&
            (sp.to == null || (preventCursorRight ? sp.to >= pos.ch : sp.to > pos.ch))) {
          if (mayClear) {
            signal(m, "beforeCursorEnter");
            if (m.explicitlyCleared) {
              if (!line.markedSpans) { break }
              else {--i; continue}
            }
          }
          if (!m.atomic) { continue }
  
          if (oldPos) {
            var near = m.find(dir < 0 ? 1 : -1), diff = (void 0);
            if (dir < 0 ? preventCursorRight : preventCursorLeft)
              { near = movePos(doc, near, -dir, near && near.line == pos.line ? line : null); }
            if (near && near.line == pos.line && (diff = cmp(near, oldPos)) && (dir < 0 ? diff < 0 : diff > 0))
              { return skipAtomicInner(doc, near, pos, dir, mayClear) }
          }
  
          var far = m.find(dir < 0 ? -1 : 1);
          if (dir < 0 ? preventCursorLeft : preventCursorRight)
            { far = movePos(doc, far, dir, far.line == pos.line ? line : null); }
          return far ? skipAtomicInner(doc, far, pos, dir, mayClear) : null
        }
      } }
      return pos
    }
  
    // Ensure a given position is not inside an atomic range.
    function skipAtomic(doc, pos, oldPos, bias, mayClear) {
      var dir = bias || 1;
      var found = skipAtomicInner(doc, pos, oldPos, dir, mayClear) ||
          (!mayClear && skipAtomicInner(doc, pos, oldPos, dir, true)) ||
          skipAtomicInner(doc, pos, oldPos, -dir, mayClear) ||
          (!mayClear && skipAtomicInner(doc, pos, oldPos, -dir, true));
      if (!found) {
        doc.cantEdit = true;
        return Pos(doc.first, 0)
      }
      return found
    }
  
    function movePos(doc, pos, dir, line) {
      if (dir < 0 && pos.ch == 0) {
        if (pos.line > doc.first) { return clipPos(doc, Pos(pos.line - 1)) }
        else { return null }
      } else if (dir > 0 && pos.ch == (line || getLine(doc, pos.line)).text.length) {
        if (pos.line < doc.first + doc.size - 1) { return Pos(pos.line + 1, 0) }
        else { return null }
      } else {
        return new Pos(pos.line, pos.ch + dir)
      }
    }
  
    function selectAll(cm) {
      cm.setSelection(Pos(cm.firstLine(), 0), Pos(cm.lastLine()), sel_dontScroll);
    }
  
    // UPDATING
  
    // Allow "beforeChange" event handlers to influence a change
    function filterChange(doc, change, update) {
      var obj = {
        canceled: false,
        from: change.from,
        to: change.to,
        text: change.text,
        origin: change.origin,
        cancel: function () { return obj.canceled = true; }
      };
      if (update) { obj.update = function (from, to, text, origin) {
        if (from) { obj.from = clipPos(doc, from); }
        if (to) { obj.to = clipPos(doc, to); }
        if (text) { obj.text = text; }
        if (origin !== undefined) { obj.origin = origin; }
      }; }
      signal(doc, "beforeChange", doc, obj);
      if (doc.cm) { signal(doc.cm, "beforeChange", doc.cm, obj); }
  
      if (obj.canceled) {
        if (doc.cm) { doc.cm.curOp.updateInput = 2; }
        return null
      }
      return {from: obj.from, to: obj.to, text: obj.text, origin: obj.origin}
    }
  
    // Apply a change to a document, and add it to the document's
    // history, and propagating it to all linked documents.
    function makeChange(doc, change, ignoreReadOnly) {
      if (doc.cm) {
        if (!doc.cm.curOp) { return operation(doc.cm, makeChange)(doc, change, ignoreReadOnly) }
        if (doc.cm.state.suppressEdits) { return }
      }
  
      if (hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange")) {
        change = filterChange(doc, change, true);
        if (!change) { return }
      }
  
      // Possibly split or suppress the update based on the presence
      // of read-only spans in its range.
      var split = sawReadOnlySpans && !ignoreReadOnly && removeReadOnlyRanges(doc, change.from, change.to);
      if (split) {
        for (var i = split.length - 1; i >= 0; --i)
          { makeChangeInner(doc, {from: split[i].from, to: split[i].to, text: i ? [""] : change.text, origin: change.origin}); }
      } else {
        makeChangeInner(doc, change);
      }
    }
  
    function makeChangeInner(doc, change) {
      if (change.text.length == 1 && change.text[0] == "" && cmp(change.from, change.to) == 0) { return }
      var selAfter = computeSelAfterChange(doc, change);
      addChangeToHistory(doc, change, selAfter, doc.cm ? doc.cm.curOp.id : NaN);
  
      makeChangeSingleDoc(doc, change, selAfter, stretchSpansOverChange(doc, change));
      var rebased = [];
  
      linkedDocs(doc, function (doc, sharedHist) {
        if (!sharedHist && indexOf(rebased, doc.history) == -1) {
          rebaseHist(doc.history, change);
          rebased.push(doc.history);
        }
        makeChangeSingleDoc(doc, change, null, stretchSpansOverChange(doc, change));
      });
    }
  
    // Revert a change stored in a document's history.
    function makeChangeFromHistory(doc, type, allowSelectionOnly) {
      var suppress = doc.cm && doc.cm.state.suppressEdits;
      if (suppress && !allowSelectionOnly) { return }
  
      var hist = doc.history, event, selAfter = doc.sel;
      var source = type == "undo" ? hist.done : hist.undone, dest = type == "undo" ? hist.undone : hist.done;
  
      // Verify that there is a useable event (so that ctrl-z won't
      // needlessly clear selection events)
      var i = 0;
      for (; i < source.length; i++) {
        event = source[i];
        if (allowSelectionOnly ? event.ranges && !event.equals(doc.sel) : !event.ranges)
          { break }
      }
      if (i == source.length) { return }
      hist.lastOrigin = hist.lastSelOrigin = null;
  
      for (;;) {
        event = source.pop();
        if (event.ranges) {
          pushSelectionToHistory(event, dest);
          if (allowSelectionOnly && !event.equals(doc.sel)) {
            setSelection(doc, event, {clearRedo: false});
            return
          }
          selAfter = event;
        } else if (suppress) {
          source.push(event);
          return
        } else { break }
      }
  
      // Build up a reverse change object to add to the opposite history
      // stack (redo when undoing, and vice versa).
      var antiChanges = [];
      pushSelectionToHistory(selAfter, dest);
      dest.push({changes: antiChanges, generation: hist.generation});
      hist.generation = event.generation || ++hist.maxGeneration;
  
      var filter = hasHandler(doc, "beforeChange") || doc.cm && hasHandler(doc.cm, "beforeChange");
  
      var loop = function ( i ) {
        var change = event.changes[i];
        change.origin = type;
        if (filter && !filterChange(doc, change, false)) {
          source.length = 0;
          return {}
        }
  
        antiChanges.push(historyChangeFromChange(doc, change));
  
        var after = i ? computeSelAfterChange(doc, change) : lst(source);
        makeChangeSingleDoc(doc, change, after, mergeOldSpans(doc, change));
        if (!i && doc.cm) { doc.cm.scrollIntoView({from: change.from, to: changeEnd(change)}); }
        var rebased = [];
  
        // Propagate to the linked documents
        linkedDocs(doc, function (doc, sharedHist) {
          if (!sharedHist && indexOf(rebased, doc.history) == -1) {
            rebaseHist(doc.history, change);
            rebased.push(doc.history);
          }
          makeChangeSingleDoc(doc, change, null, mergeOldSpans(doc, change));
        });
      };
  
      for (var i$1 = event.changes.length - 1; i$1 >= 0; --i$1) {
        var returned = loop( i$1 );
  
        if ( returned ) return returned.v;
      }
    }
  
    // Sub-views need their line numbers shifted when text is added
    // above or below them in the parent document.
    function shiftDoc(doc, distance) {
      if (distance == 0) { return }
      doc.first += distance;
      doc.sel = new Selection(map(doc.sel.ranges, function (range) { return new Range(
        Pos(range.anchor.line + distance, range.anchor.ch),
        Pos(range.head.line + distance, range.head.ch)
      ); }), doc.sel.primIndex);
      if (doc.cm) {
        regChange(doc.cm, doc.first, doc.first - distance, distance);
        for (var d = doc.cm.display, l = d.viewFrom; l < d.viewTo; l++)
          { regLineChange(doc.cm, l, "gutter"); }
      }
    }
  
    // More lower-level change function, handling only a single document
    // (not linked ones).
    function makeChangeSingleDoc(doc, change, selAfter, spans) {
      if (doc.cm && !doc.cm.curOp)
        { return operation(doc.cm, makeChangeSingleDoc)(doc, change, selAfter, spans) }
  
      if (change.to.line < doc.first) {
        shiftDoc(doc, change.text.length - 1 - (change.to.line - change.from.line));
        return
      }
      if (change.from.line > doc.lastLine()) { return }
  
      // Clip the change to the size of this doc
      if (change.from.line < doc.first) {
        var shift = change.text.length - 1 - (doc.first - change.from.line);
        shiftDoc(doc, shift);
        change = {from: Pos(doc.first, 0), to: Pos(change.to.line + shift, change.to.ch),
                  text: [lst(change.text)], origin: change.origin};
      }
      var last = doc.lastLine();
      if (change.to.line > last) {
        change = {from: change.from, to: Pos(last, getLine(doc, last).text.length),
                  text: [change.text[0]], origin: change.origin};
      }
  
      change.removed = getBetween(doc, change.from, change.to);
  
      if (!selAfter) { selAfter = computeSelAfterChange(doc, change); }
      if (doc.cm) { makeChangeSingleDocInEditor(doc.cm, change, spans); }
      else { updateDoc(doc, change, spans); }
      setSelectionNoUndo(doc, selAfter, sel_dontScroll);
  
      if (doc.cantEdit && skipAtomic(doc, Pos(doc.firstLine(), 0)))
        { doc.cantEdit = false; }
    }
  
    // Handle the interaction of a change to a document with the editor
    // that this document is part of.
    function makeChangeSingleDocInEditor(cm, change, spans) {
      var doc = cm.doc, display = cm.display, from = change.from, to = change.to;
  
      var recomputeMaxLength = false, checkWidthStart = from.line;
      if (!cm.options.lineWrapping) {
        checkWidthStart = lineNo(visualLine(getLine(doc, from.line)));
        doc.iter(checkWidthStart, to.line + 1, function (line) {
          if (line == display.maxLine) {
            recomputeMaxLength = true;
            return true
          }
        });
      }
  
      if (doc.sel.contains(change.from, change.to) > -1)
        { signalCursorActivity(cm); }
  
      updateDoc(doc, change, spans, estimateHeight(cm));
  
      if (!cm.options.lineWrapping) {
        doc.iter(checkWidthStart, from.line + change.text.length, function (line) {
          var len = lineLength(line);
          if (len > display.maxLineLength) {
            display.maxLine = line;
            display.maxLineLength = len;
            display.maxLineChanged = true;
            recomputeMaxLength = false;
          }
        });
        if (recomputeMaxLength) { cm.curOp.updateMaxLine = true; }
      }
  
      retreatFrontier(doc, from.line);
      startWorker(cm, 400);
  
      var lendiff = change.text.length - (to.line - from.line) - 1;
      // Remember that these lines changed, for updating the display
      if (change.full)
        { regChange(cm); }
      else if (from.line == to.line && change.text.length == 1 && !isWholeLineUpdate(cm.doc, change))
        { regLineChange(cm, from.line, "text"); }
      else
        { regChange(cm, from.line, to.line + 1, lendiff); }
  
      var changesHandler = hasHandler(cm, "changes"), changeHandler = hasHandler(cm, "change");
      if (changeHandler || changesHandler) {
        var obj = {
          from: from, to: to,
          text: change.text,
          removed: change.removed,
          origin: change.origin
        };
        if (changeHandler) { signalLater(cm, "change", cm, obj); }
        if (changesHandler) { (cm.curOp.changeObjs || (cm.curOp.changeObjs = [])).push(obj); }
      }
      cm.display.selForContextMenu = null;
    }
  
    function replaceRange(doc, code, from, to, origin) {
      var assign;
  
      if (!to) { to = from; }
      if (cmp(to, from) < 0) { (assign = [to, from], from = assign[0], to = assign[1]); }
      if (typeof code == "string") { code = doc.splitLines(code); }
      makeChange(doc, {from: from, to: to, text: code, origin: origin});
    }
  
    // Rebasing/resetting history to deal with externally-sourced changes
  
    function rebaseHistSelSingle(pos, from, to, diff) {
      if (to < pos.line) {
        pos.line += diff;
      } else if (from < pos.line) {
        pos.line = from;
        pos.ch = 0;
      }
    }
  
    // Tries to rebase an array of history events given a change in the
    // document. If the change touches the same lines as the event, the
    // event, and everything 'behind' it, is discarded. If the change is
    // before the event, the event's positions are updated. Uses a
    // copy-on-write scheme for the positions, to avoid having to
    // reallocate them all on every rebase, but also avoid problems with
    // shared position objects being unsafely updated.
    function rebaseHistArray(array, from, to, diff) {
      for (var i = 0; i < array.length; ++i) {
        var sub = array[i], ok = true;
        if (sub.ranges) {
          if (!sub.copied) { sub = array[i] = sub.deepCopy(); sub.copied = true; }
          for (var j = 0; j < sub.ranges.length; j++) {
            rebaseHistSelSingle(sub.ranges[j].anchor, from, to, diff);
            rebaseHistSelSingle(sub.ranges[j].head, from, to, diff);
          }
          continue
        }
        for (var j$1 = 0; j$1 < sub.changes.length; ++j$1) {
          var cur = sub.changes[j$1];
          if (to < cur.from.line) {
            cur.from = Pos(cur.from.line + diff, cur.from.ch);
            cur.to = Pos(cur.to.line + diff, cur.to.ch);
          } else if (from <= cur.to.line) {
            ok = false;
            break
          }
        }
        if (!ok) {
          array.splice(0, i + 1);
          i = 0;
        }
      }
    }
  
    function rebaseHist(hist, change) {
      var from = change.from.line, to = change.to.line, diff = change.text.length - (to - from) - 1;
      rebaseHistArray(hist.done, from, to, diff);
      rebaseHistArray(hist.undone, from, to, diff);
    }
  
    // Utility for applying a change to a line by handle or number,
    // returning the number and optionally registering the line as
    // changed.
    function changeLine(doc, handle, changeType, op) {
      var no = handle, line = handle;
      if (typeof handle == "number") { line = getLine(doc, clipLine(doc, handle)); }
      else { no = lineNo(handle); }
      if (no == null) { return null }
      if (op(line, no) && doc.cm) { regLineChange(doc.cm, no, changeType); }
      return line
    }
  
    // The document is represented as a BTree consisting of leaves, with
    // chunk of lines in them, and branches, with up to ten leaves or
    // other branch nodes below them. The top node is always a branch
    // node, and is the document object itself (meaning it has
    // additional methods and properties).
    //
    // All nodes have parent links. The tree is used both to go from
    // line numbers to line objects, and to go from objects to numbers.
    // It also indexes by height, and is used to convert between height
    // and line object, and to find the total height of the document.
    //
    // See also http://marijnhaverbeke.nl/blog/codemirror-line-tree.html
  
    function LeafChunk(lines) {
      var this$1 = this;
  
      this.lines = lines;
      this.parent = null;
      var height = 0;
      for (var i = 0; i < lines.length; ++i) {
        lines[i].parent = this$1;
        height += lines[i].height;
      }
      this.height = height;
    }
  
    LeafChunk.prototype = {
      chunkSize: function() { return this.lines.length },
  
      // Remove the n lines at offset 'at'.
      removeInner: function(at, n) {
        var this$1 = this;
  
        for (var i = at, e = at + n; i < e; ++i) {
          var line = this$1.lines[i];
          this$1.height -= line.height;
          cleanUpLine(line);
          signalLater(line, "delete");
        }
        this.lines.splice(at, n);
      },
  
      // Helper used to collapse a small branch into a single leaf.
      collapse: function(lines) {
        lines.push.apply(lines, this.lines);
      },
  
      // Insert the given array of lines at offset 'at', count them as
      // having the given height.
      insertInner: function(at, lines, height) {
        var this$1 = this;
  
        this.height += height;
        this.lines = this.lines.slice(0, at).concat(lines).concat(this.lines.slice(at));
        for (var i = 0; i < lines.length; ++i) { lines[i].parent = this$1; }
      },
  
      // Used to iterate over a part of the tree.
      iterN: function(at, n, op) {
        var this$1 = this;
  
        for (var e = at + n; at < e; ++at)
          { if (op(this$1.lines[at])) { return true } }
      }
    };
  
    function BranchChunk(children) {
      var this$1 = this;
  
      this.children = children;
      var size = 0, height = 0;
      for (var i = 0; i < children.length; ++i) {
        var ch = children[i];
        size += ch.chunkSize(); height += ch.height;
        ch.parent = this$1;
      }
      this.size = size;
      this.height = height;
      this.parent = null;
    }
  
    BranchChunk.prototype = {
      chunkSize: function() { return this.size },
  
      removeInner: function(at, n) {
        var this$1 = this;
  
        this.size -= n;
        for (var i = 0; i < this.children.length; ++i) {
          var child = this$1.children[i], sz = child.chunkSize();
          if (at < sz) {
            var rm = Math.min(n, sz - at), oldHeight = child.height;
            child.removeInner(at, rm);
            this$1.height -= oldHeight - child.height;
            if (sz == rm) { this$1.children.splice(i--, 1); child.parent = null; }
            if ((n -= rm) == 0) { break }
            at = 0;
          } else { at -= sz; }
        }
        // If the result is smaller than 25 lines, ensure that it is a
        // single leaf node.
        if (this.size - n < 25 &&
            (this.children.length > 1 || !(this.children[0] instanceof LeafChunk))) {
          var lines = [];
          this.collapse(lines);
          this.children = [new LeafChunk(lines)];
          this.children[0].parent = this;
        }
      },
  
      collapse: function(lines) {
        var this$1 = this;
  
        for (var i = 0; i < this.children.length; ++i) { this$1.children[i].collapse(lines); }
      },
  
      insertInner: function(at, lines, height) {
        var this$1 = this;
  
        this.size += lines.length;
        this.height += height;
        for (var i = 0; i < this.children.length; ++i) {
          var child = this$1.children[i], sz = child.chunkSize();
          if (at <= sz) {
            child.insertInner(at, lines, height);
            if (child.lines && child.lines.length > 50) {
              // To avoid memory thrashing when child.lines is huge (e.g. first view of a large file), it's never spliced.
              // Instead, small slices are taken. They're taken in order because sequential memory accesses are fastest.
              var remaining = child.lines.length % 25 + 25;
              for (var pos = remaining; pos < child.lines.length;) {
                var leaf = new LeafChunk(child.lines.slice(pos, pos += 25));
                child.height -= leaf.height;
                this$1.children.splice(++i, 0, leaf);
                leaf.parent = this$1;
              }
              child.lines = child.lines.slice(0, remaining);
              this$1.maybeSpill();
            }
            break
          }
          at -= sz;
        }
      },
  
      // When a node has grown, check whether it should be split.
      maybeSpill: function() {
        if (this.children.length <= 10) { return }
        var me = this;
        do {
          var spilled = me.children.splice(me.children.length - 5, 5);
          var sibling = new BranchChunk(spilled);
          if (!me.parent) { // Become the parent node
            var copy = new BranchChunk(me.children);
            copy.parent = me;
            me.children = [copy, sibling];
            me = copy;
         } else {
            me.size -= sibling.size;
            me.height -= sibling.height;
            var myIndex = indexOf(me.parent.children, me);
            me.parent.children.splice(myIndex + 1, 0, sibling);
          }
          sibling.parent = me.parent;
        } while (me.children.length > 10)
        me.parent.maybeSpill();
      },
  
      iterN: function(at, n, op) {
        var this$1 = this;
  
        for (var i = 0; i < this.children.length; ++i) {
          var child = this$1.children[i], sz = child.chunkSize();
          if (at < sz) {
            var used = Math.min(n, sz - at);
            if (child.iterN(at, used, op)) { return true }
            if ((n -= used) == 0) { break }
            at = 0;
          } else { at -= sz; }
        }
      }
    };
  
    // Line widgets are block elements displayed above or below a line.
  
    var LineWidget = function(doc, node, options) {
      var this$1 = this;
  
      if (options) { for (var opt in options) { if (options.hasOwnProperty(opt))
        { this$1[opt] = options[opt]; } } }
      this.doc = doc;
      this.node = node;
    };
  
    LineWidget.prototype.clear = function () {
        var this$1 = this;
  
      var cm = this.doc.cm, ws = this.line.widgets, line = this.line, no = lineNo(line);
      if (no == null || !ws) { return }
      for (var i = 0; i < ws.length; ++i) { if (ws[i] == this$1) { ws.splice(i--, 1); } }
      if (!ws.length) { line.widgets = null; }
      var height = widgetHeight(this);
      updateLineHeight(line, Math.max(0, line.height - height));
      if (cm) {
        runInOp(cm, function () {
          adjustScrollWhenAboveVisible(cm, line, -height);
          regLineChange(cm, no, "widget");
        });
        signalLater(cm, "lineWidgetCleared", cm, this, no);
      }
    };
  
    LineWidget.prototype.changed = function () {
        var this$1 = this;
  
      var oldH = this.height, cm = this.doc.cm, line = this.line;
      this.height = null;
      var diff = widgetHeight(this) - oldH;
      if (!diff) { return }
      if (!lineIsHidden(this.doc, line)) { updateLineHeight(line, line.height + diff); }
      if (cm) {
        runInOp(cm, function () {
          cm.curOp.forceUpdate = true;
          adjustScrollWhenAboveVisible(cm, line, diff);
          signalLater(cm, "lineWidgetChanged", cm, this$1, lineNo(line));
        });
      }
    };
    eventMixin(LineWidget);
  
    function adjustScrollWhenAboveVisible(cm, line, diff) {
      if (heightAtLine(line) < ((cm.curOp && cm.curOp.scrollTop) || cm.doc.scrollTop))
        { addToScrollTop(cm, diff); }
    }
  
    function addLineWidget(doc, handle, node, options) {
      var widget = new LineWidget(doc, node, options);
      var cm = doc.cm;
      if (cm && widget.noHScroll) { cm.display.alignWidgets = true; }
      changeLine(doc, handle, "widget", function (line) {
        var widgets = line.widgets || (line.widgets = []);
        if (widget.insertAt == null) { widgets.push(widget); }
        else { widgets.splice(Math.min(widgets.length - 1, Math.max(0, widget.insertAt)), 0, widget); }
        widget.line = line;
        if (cm && !lineIsHidden(doc, line)) {
          var aboveVisible = heightAtLine(line) < doc.scrollTop;
          updateLineHeight(line, line.height + widgetHeight(widget));
          if (aboveVisible) { addToScrollTop(cm, widget.height); }
          cm.curOp.forceUpdate = true;
        }
        return true
      });
      if (cm) { signalLater(cm, "lineWidgetAdded", cm, widget, typeof handle == "number" ? handle : lineNo(handle)); }
      return widget
    }
  
    // TEXTMARKERS
  
    // Created with markText and setBookmark methods. A TextMarker is a
    // handle that can be used to clear or find a marked position in the
    // document. Line objects hold arrays (markedSpans) containing
    // {from, to, marker} object pointing to such marker objects, and
    // indicating that such a marker is present on that line. Multiple
    // lines may point to the same marker when it spans across lines.
    // The spans will have null for their from/to properties when the
    // marker continues beyond the start/end of the line. Markers have
    // links back to the lines they currently touch.
  
    // Collapsed markers have unique ids, in order to be able to order
    // them, which is needed for uniquely determining an outer marker
    // when they overlap (they may nest, but not partially overlap).
    var nextMarkerId = 0;
  
    var TextMarker = function(doc, type) {
      this.lines = [];
      this.type = type;
      this.doc = doc;
      this.id = ++nextMarkerId;
    };
  
    // Clear the marker.
    TextMarker.prototype.clear = function () {
        var this$1 = this;
  
      if (this.explicitlyCleared) { return }
      var cm = this.doc.cm, withOp = cm && !cm.curOp;
      if (withOp) { startOperation(cm); }
      if (hasHandler(this, "clear")) {
        var found = this.find();
        if (found) { signalLater(this, "clear", found.from, found.to); }
      }
      var min = null, max = null;
      for (var i = 0; i < this.lines.length; ++i) {
        var line = this$1.lines[i];
        var span = getMarkedSpanFor(line.markedSpans, this$1);
        if (cm && !this$1.collapsed) { regLineChange(cm, lineNo(line), "text"); }
        else if (cm) {
          if (span.to != null) { max = lineNo(line); }
          if (span.from != null) { min = lineNo(line); }
        }
        line.markedSpans = removeMarkedSpan(line.markedSpans, span);
        if (span.from == null && this$1.collapsed && !lineIsHidden(this$1.doc, line) && cm)
          { updateLineHeight(line, textHeight(cm.display)); }
      }
      if (cm && this.collapsed && !cm.options.lineWrapping) { for (var i$1 = 0; i$1 < this.lines.length; ++i$1) {
        var visual = visualLine(this$1.lines[i$1]), len = lineLength(visual);
        if (len > cm.display.maxLineLength) {
          cm.display.maxLine = visual;
          cm.display.maxLineLength = len;
          cm.display.maxLineChanged = true;
        }
      } }
  
      if (min != null && cm && this.collapsed) { regChange(cm, min, max + 1); }
      this.lines.length = 0;
      this.explicitlyCleared = true;
      if (this.atomic && this.doc.cantEdit) {
        this.doc.cantEdit = false;
        if (cm) { reCheckSelection(cm.doc); }
      }
      if (cm) { signalLater(cm, "markerCleared", cm, this, min, max); }
      if (withOp) { endOperation(cm); }
      if (this.parent) { this.parent.clear(); }
    };
  
    // Find the position of the marker in the document. Returns a {from,
    // to} object by default. Side can be passed to get a specific side
    // -- 0 (both), -1 (left), or 1 (right). When lineObj is true, the
    // Pos objects returned contain a line object, rather than a line
    // number (used to prevent looking up the same line twice).
    TextMarker.prototype.find = function (side, lineObj) {
        var this$1 = this;
  
      if (side == null && this.type == "bookmark") { side = 1; }
      var from, to;
      for (var i = 0; i < this.lines.length; ++i) {
        var line = this$1.lines[i];
        var span = getMarkedSpanFor(line.markedSpans, this$1);
        if (span.from != null) {
          from = Pos(lineObj ? line : lineNo(line), span.from);
          if (side == -1) { return from }
        }
        if (span.to != null) {
          to = Pos(lineObj ? line : lineNo(line), span.to);
          if (side == 1) { return to }
        }
      }
      return from && {from: from, to: to}
    };
  
    // Signals that the marker's widget changed, and surrounding layout
    // should be recomputed.
    TextMarker.prototype.changed = function () {
        var this$1 = this;
  
      var pos = this.find(-1, true), widget = this, cm = this.doc.cm;
      if (!pos || !cm) { return }
      runInOp(cm, function () {
        var line = pos.line, lineN = lineNo(pos.line);
        var view = findViewForLine(cm, lineN);
        if (view) {
          clearLineMeasurementCacheFor(view);
          cm.curOp.selectionChanged = cm.curOp.forceUpdate = true;
        }
        cm.curOp.updateMaxLine = true;
        if (!lineIsHidden(widget.doc, line) && widget.height != null) {
          var oldHeight = widget.height;
          widget.height = null;
          var dHeight = widgetHeight(widget) - oldHeight;
          if (dHeight)
            { updateLineHeight(line, line.height + dHeight); }
        }
        signalLater(cm, "markerChanged", cm, this$1);
      });
    };
  
    TextMarker.prototype.attachLine = function (line) {
      if (!this.lines.length && this.doc.cm) {
        var op = this.doc.cm.curOp;
        if (!op.maybeHiddenMarkers || indexOf(op.maybeHiddenMarkers, this) == -1)
          { (op.maybeUnhiddenMarkers || (op.maybeUnhiddenMarkers = [])).push(this); }
      }
      this.lines.push(line);
    };
  
    TextMarker.prototype.detachLine = function (line) {
      this.lines.splice(indexOf(this.lines, line), 1);
      if (!this.lines.length && this.doc.cm) {
        var op = this.doc.cm.curOp
        ;(op.maybeHiddenMarkers || (op.maybeHiddenMarkers = [])).push(this);
      }
    };
    eventMixin(TextMarker);
  
    // Create a marker, wire it up to the right lines, and
    function markText(doc, from, to, options, type) {
      // Shared markers (across linked documents) are handled separately
      // (markTextShared will call out to this again, once per
      // document).
      if (options && options.shared) { return markTextShared(doc, from, to, options, type) }
      // Ensure we are in an operation.
      if (doc.cm && !doc.cm.curOp) { return operation(doc.cm, markText)(doc, from, to, options, type) }
  
      var marker = new TextMarker(doc, type), diff = cmp(from, to);
      if (options) { copyObj(options, marker, false); }
      // Don't connect empty markers unless clearWhenEmpty is false
      if (diff > 0 || diff == 0 && marker.clearWhenEmpty !== false)
        { return marker }
      if (marker.replacedWith) {
        // Showing up as a widget implies collapsed (widget replaces text)
        marker.collapsed = true;
        marker.widgetNode = eltP("span", [marker.replacedWith], "CodeMirror-widget");
        if (!options.handleMouseEvents) { marker.widgetNode.setAttribute("cm-ignore-events", "true"); }
        if (options.insertLeft) { marker.widgetNode.insertLeft = true; }
      }
      if (marker.collapsed) {
        if (conflictingCollapsedRange(doc, from.line, from, to, marker) ||
            from.line != to.line && conflictingCollapsedRange(doc, to.line, from, to, marker))
          { throw new Error("Inserting collapsed marker partially overlapping an existing one") }
        seeCollapsedSpans();
      }
  
      if (marker.addToHistory)
        { addChangeToHistory(doc, {from: from, to: to, origin: "markText"}, doc.sel, NaN); }
  
      var curLine = from.line, cm = doc.cm, updateMaxLine;
      doc.iter(curLine, to.line + 1, function (line) {
        if (cm && marker.collapsed && !cm.options.lineWrapping && visualLine(line) == cm.display.maxLine)
          { updateMaxLine = true; }
        if (marker.collapsed && curLine != from.line) { updateLineHeight(line, 0); }
        addMarkedSpan(line, new MarkedSpan(marker,
                                           curLine == from.line ? from.ch : null,
                                           curLine == to.line ? to.ch : null));
        ++curLine;
      });
      // lineIsHidden depends on the presence of the spans, so needs a second pass
      if (marker.collapsed) { doc.iter(from.line, to.line + 1, function (line) {
        if (lineIsHidden(doc, line)) { updateLineHeight(line, 0); }
      }); }
  
      if (marker.clearOnEnter) { on(marker, "beforeCursorEnter", function () { return marker.clear(); }); }
  
      if (marker.readOnly) {
        seeReadOnlySpans();
        if (doc.history.done.length || doc.history.undone.length)
          { doc.clearHistory(); }
      }
      if (marker.collapsed) {
        marker.id = ++nextMarkerId;
        marker.atomic = true;
      }
      if (cm) {
        // Sync editor state
        if (updateMaxLine) { cm.curOp.updateMaxLine = true; }
        if (marker.collapsed)
          { regChange(cm, from.line, to.line + 1); }
        else if (marker.className || marker.startStyle || marker.endStyle || marker.css ||
                 marker.attributes || marker.title)
          { for (var i = from.line; i <= to.line; i++) { regLineChange(cm, i, "text"); } }
        if (marker.atomic) { reCheckSelection(cm.doc); }
        signalLater(cm, "markerAdded", cm, marker);
      }
      return marker
    }
  
    // SHARED TEXTMARKERS
  
    // A shared marker spans multiple linked documents. It is
    // implemented as a meta-marker-object controlling multiple normal
    // markers.
    var SharedTextMarker = function(markers, primary) {
      var this$1 = this;
  
      this.markers = markers;
      this.primary = primary;
      for (var i = 0; i < markers.length; ++i)
        { markers[i].parent = this$1; }
    };
  
    SharedTextMarker.prototype.clear = function () {
        var this$1 = this;
  
      if (this.explicitlyCleared) { return }
      this.explicitlyCleared = true;
      for (var i = 0; i < this.markers.length; ++i)
        { this$1.markers[i].clear(); }
      signalLater(this, "clear");
    };
  
    SharedTextMarker.prototype.find = function (side, lineObj) {
      return this.primary.find(side, lineObj)
    };
    eventMixin(SharedTextMarker);
  
    function markTextShared(doc, from, to, options, type) {
      options = copyObj(options);
      options.shared = false;
      var markers = [markText(doc, from, to, options, type)], primary = markers[0];
      var widget = options.widgetNode;
      linkedDocs(doc, function (doc) {
        if (widget) { options.widgetNode = widget.cloneNode(true); }
        markers.push(markText(doc, clipPos(doc, from), clipPos(doc, to), options, type));
        for (var i = 0; i < doc.linked.length; ++i)
          { if (doc.linked[i].isParent) { return } }
        primary = lst(markers);
      });
      return new SharedTextMarker(markers, primary)
    }
  
    function findSharedMarkers(doc) {
      return doc.findMarks(Pos(doc.first, 0), doc.clipPos(Pos(doc.lastLine())), function (m) { return m.parent; })
    }
  
    function copySharedMarkers(doc, markers) {
      for (var i = 0; i < markers.length; i++) {
        var marker = markers[i], pos = marker.find();
        var mFrom = doc.clipPos(pos.from), mTo = doc.clipPos(pos.to);
        if (cmp(mFrom, mTo)) {
          var subMark = markText(doc, mFrom, mTo, marker.primary, marker.primary.type);
          marker.markers.push(subMark);
          subMark.parent = marker;
        }
      }
    }
  
    function detachSharedMarkers(markers) {
      var loop = function ( i ) {
        var marker = markers[i], linked = [marker.primary.doc];
        linkedDocs(marker.primary.doc, function (d) { return linked.push(d); });
        for (var j = 0; j < marker.markers.length; j++) {
          var subMarker = marker.markers[j];
          if (indexOf(linked, subMarker.doc) == -1) {
            subMarker.parent = null;
            marker.markers.splice(j--, 1);
          }
        }
      };
  
      for (var i = 0; i < markers.length; i++) loop( i );
    }
  
    var nextDocId = 0;
    var Doc = function(text, mode, firstLine, lineSep, direction) {
      if (!(this instanceof Doc)) { return new Doc(text, mode, firstLine, lineSep, direction) }
      if (firstLine == null) { firstLine = 0; }
  
      BranchChunk.call(this, [new LeafChunk([new Line("", null)])]);
      this.first = firstLine;
      this.scrollTop = this.scrollLeft = 0;
      this.cantEdit = false;
      this.cleanGeneration = 1;
      this.modeFrontier = this.highlightFrontier = firstLine;
      var start = Pos(firstLine, 0);
      this.sel = simpleSelection(start);
      this.history = new History(null);
      this.id = ++nextDocId;
      this.modeOption = mode;
      this.lineSep = lineSep;
      this.direction = (direction == "rtl") ? "rtl" : "ltr";
      this.extend = false;
  
      if (typeof text == "string") { text = this.splitLines(text); }
      updateDoc(this, {from: start, to: start, text: text});
      setSelection(this, simpleSelection(start), sel_dontScroll);
    };
  
    Doc.prototype = createObj(BranchChunk.prototype, {
      constructor: Doc,
      // Iterate over the document. Supports two forms -- with only one
      // argument, it calls that for each line in the document. With
      // three, it iterates over the range given by the first two (with
      // the second being non-inclusive).
      iter: function(from, to, op) {
        if (op) { this.iterN(from - this.first, to - from, op); }
        else { this.iterN(this.first, this.first + this.size, from); }
      },
  
      // Non-public interface for adding and removing lines.
      insert: function(at, lines) {
        var height = 0;
        for (var i = 0; i < lines.length; ++i) { height += lines[i].height; }
        this.insertInner(at - this.first, lines, height);
      },
      remove: function(at, n) { this.removeInner(at - this.first, n); },
  
      // From here, the methods are part of the public interface. Most
      // are also available from CodeMirror (editor) instances.
  
      getValue: function(lineSep) {
        var lines = getLines(this, this.first, this.first + this.size);
        if (lineSep === false) { return lines }
        return lines.join(lineSep || this.lineSeparator())
      },
      setValue: docMethodOp(function(code) {
        var top = Pos(this.first, 0), last = this.first + this.size - 1;
        makeChange(this, {from: top, to: Pos(last, getLine(this, last).text.length),
                          text: this.splitLines(code), origin: "setValue", full: true}, true);
        if (this.cm) { scrollToCoords(this.cm, 0, 0); }
        setSelection(this, simpleSelection(top), sel_dontScroll);
      }),
      replaceRange: function(code, from, to, origin) {
        from = clipPos(this, from);
        to = to ? clipPos(this, to) : from;
        replaceRange(this, code, from, to, origin);
      },
      getRange: function(from, to, lineSep) {
        var lines = getBetween(this, clipPos(this, from), clipPos(this, to));
        if (lineSep === false) { return lines }
        return lines.join(lineSep || this.lineSeparator())
      },
  
      getLine: function(line) {var l = this.getLineHandle(line); return l && l.text},
  
      getLineHandle: function(line) {if (isLine(this, line)) { return getLine(this, line) }},
      getLineNumber: function(line) {return lineNo(line)},
  
      getLineHandleVisualStart: function(line) {
        if (typeof line == "number") { line = getLine(this, line); }
        return visualLine(line)
      },
  
      lineCount: function() {return this.size},
      firstLine: function() {return this.first},
      lastLine: function() {return this.first + this.size - 1},
  
      clipPos: function(pos) {return clipPos(this, pos)},
  
      getCursor: function(start) {
        var range$$1 = this.sel.primary(), pos;
        if (start == null || start == "head") { pos = range$$1.head; }
        else if (start == "anchor") { pos = range$$1.anchor; }
        else if (start == "end" || start == "to" || start === false) { pos = range$$1.to(); }
        else { pos = range$$1.from(); }
        return pos
      },
      listSelections: function() { return this.sel.ranges },
      somethingSelected: function() {return this.sel.somethingSelected()},
  
      setCursor: docMethodOp(function(line, ch, options) {
        setSimpleSelection(this, clipPos(this, typeof line == "number" ? Pos(line, ch || 0) : line), null, options);
      }),
      setSelection: docMethodOp(function(anchor, head, options) {
        setSimpleSelection(this, clipPos(this, anchor), clipPos(this, head || anchor), options);
      }),
      extendSelection: docMethodOp(function(head, other, options) {
        extendSelection(this, clipPos(this, head), other && clipPos(this, other), options);
      }),
      extendSelections: docMethodOp(function(heads, options) {
        extendSelections(this, clipPosArray(this, heads), options);
      }),
      extendSelectionsBy: docMethodOp(function(f, options) {
        var heads = map(this.sel.ranges, f);
        extendSelections(this, clipPosArray(this, heads), options);
      }),
      setSelections: docMethodOp(function(ranges, primary, options) {
        var this$1 = this;
  
        if (!ranges.length) { return }
        var out = [];
        for (var i = 0; i < ranges.length; i++)
          { out[i] = new Range(clipPos(this$1, ranges[i].anchor),
                             clipPos(this$1, ranges[i].head)); }
        if (primary == null) { primary = Math.min(ranges.length - 1, this.sel.primIndex); }
        setSelection(this, normalizeSelection(this.cm, out, primary), options);
      }),
      addSelection: docMethodOp(function(anchor, head, options) {
        var ranges = this.sel.ranges.slice(0);
        ranges.push(new Range(clipPos(this, anchor), clipPos(this, head || anchor)));
        setSelection(this, normalizeSelection(this.cm, ranges, ranges.length - 1), options);
      }),
  
      getSelection: function(lineSep) {
        var this$1 = this;
  
        var ranges = this.sel.ranges, lines;
        for (var i = 0; i < ranges.length; i++) {
          var sel = getBetween(this$1, ranges[i].from(), ranges[i].to());
          lines = lines ? lines.concat(sel) : sel;
        }
        if (lineSep === false) { return lines }
        else { return lines.join(lineSep || this.lineSeparator()) }
      },
      getSelections: function(lineSep) {
        var this$1 = this;
  
        var parts = [], ranges = this.sel.ranges;
        for (var i = 0; i < ranges.length; i++) {
          var sel = getBetween(this$1, ranges[i].from(), ranges[i].to());
          if (lineSep !== false) { sel = sel.join(lineSep || this$1.lineSeparator()); }
          parts[i] = sel;
        }
        return parts
      },
      replaceSelection: function(code, collapse, origin) {
        var dup = [];
        for (var i = 0; i < this.sel.ranges.length; i++)
          { dup[i] = code; }
        this.replaceSelections(dup, collapse, origin || "+input");
      },
      replaceSelections: docMethodOp(function(code, collapse, origin) {
        var this$1 = this;
  
        var changes = [], sel = this.sel;
        for (var i = 0; i < sel.ranges.length; i++) {
          var range$$1 = sel.ranges[i];
          changes[i] = {from: range$$1.from(), to: range$$1.to(), text: this$1.splitLines(code[i]), origin: origin};
        }
        var newSel = collapse && collapse != "end" && computeReplacedSel(this, changes, collapse);
        for (var i$1 = changes.length - 1; i$1 >= 0; i$1--)
          { makeChange(this$1, changes[i$1]); }
        if (newSel) { setSelectionReplaceHistory(this, newSel); }
        else if (this.cm) { ensureCursorVisible(this.cm); }
      }),
      undo: docMethodOp(function() {makeChangeFromHistory(this, "undo");}),
      redo: docMethodOp(function() {makeChangeFromHistory(this, "redo");}),
      undoSelection: docMethodOp(function() {makeChangeFromHistory(this, "undo", true);}),
      redoSelection: docMethodOp(function() {makeChangeFromHistory(this, "redo", true);}),
  
      setExtending: function(val) {this.extend = val;},
      getExtending: function() {return this.extend},
  
      historySize: function() {
        var hist = this.history, done = 0, undone = 0;
        for (var i = 0; i < hist.done.length; i++) { if (!hist.done[i].ranges) { ++done; } }
        for (var i$1 = 0; i$1 < hist.undone.length; i$1++) { if (!hist.undone[i$1].ranges) { ++undone; } }
        return {undo: done, redo: undone}
      },
      clearHistory: function() {
        var this$1 = this;
  
        this.history = new History(this.history.maxGeneration);
        linkedDocs(this, function (doc) { return doc.history = this$1.history; }, true);
      },
  
      markClean: function() {
        this.cleanGeneration = this.changeGeneration(true);
      },
      changeGeneration: function(forceSplit) {
        if (forceSplit)
          { this.history.lastOp = this.history.lastSelOp = this.history.lastOrigin = null; }
        return this.history.generation
      },
      isClean: function (gen) {
        return this.history.generation == (gen || this.cleanGeneration)
      },
  
      getHistory: function() {
        return {done: copyHistoryArray(this.history.done),
                undone: copyHistoryArray(this.history.undone)}
      },
      setHistory: function(histData) {
        var hist = this.history = new History(this.history.maxGeneration);
        hist.done = copyHistoryArray(histData.done.slice(0), null, true);
        hist.undone = copyHistoryArray(histData.undone.slice(0), null, true);
      },
  
      setGutterMarker: docMethodOp(function(line, gutterID, value) {
        return changeLine(this, line, "gutter", function (line) {
          var markers = line.gutterMarkers || (line.gutterMarkers = {});
          markers[gutterID] = value;
          if (!value && isEmpty(markers)) { line.gutterMarkers = null; }
          return true
        })
      }),
  
      clearGutter: docMethodOp(function(gutterID) {
        var this$1 = this;
  
        this.iter(function (line) {
          if (line.gutterMarkers && line.gutterMarkers[gutterID]) {
            changeLine(this$1, line, "gutter", function () {
              line.gutterMarkers[gutterID] = null;
              if (isEmpty(line.gutterMarkers)) { line.gutterMarkers = null; }
              return true
            });
          }
        });
      }),
  
      lineInfo: function(line) {
        var n;
        if (typeof line == "number") {
          if (!isLine(this, line)) { return null }
          n = line;
          line = getLine(this, line);
          if (!line) { return null }
        } else {
          n = lineNo(line);
          if (n == null) { return null }
        }
        return {line: n, handle: line, text: line.text, gutterMarkers: line.gutterMarkers,
                textClass: line.textClass, bgClass: line.bgClass, wrapClass: line.wrapClass,
                widgets: line.widgets}
      },
  
      addLineClass: docMethodOp(function(handle, where, cls) {
        return changeLine(this, handle, where == "gutter" ? "gutter" : "class", function (line) {
          var prop = where == "text" ? "textClass"
                   : where == "background" ? "bgClass"
                   : where == "gutter" ? "gutterClass" : "wrapClass";
          if (!line[prop]) { line[prop] = cls; }
          else if (classTest(cls).test(line[prop])) { return false }
          else { line[prop] += " " + cls; }
          return true
        })
      }),
      removeLineClass: docMethodOp(function(handle, where, cls) {
        return changeLine(this, handle, where == "gutter" ? "gutter" : "class", function (line) {
          var prop = where == "text" ? "textClass"
                   : where == "background" ? "bgClass"
                   : where == "gutter" ? "gutterClass" : "wrapClass";
          var cur = line[prop];
          if (!cur) { return false }
          else if (cls == null) { line[prop] = null; }
          else {
            var found = cur.match(classTest(cls));
            if (!found) { return false }
            var end = found.index + found[0].length;
            line[prop] = cur.slice(0, found.index) + (!found.index || end == cur.length ? "" : " ") + cur.slice(end) || null;
          }
          return true
        })
      }),
  
      addLineWidget: docMethodOp(function(handle, node, options) {
        return addLineWidget(this, handle, node, options)
      }),
      removeLineWidget: function(widget) { widget.clear(); },
  
      markText: function(from, to, options) {
        return markText(this, clipPos(this, from), clipPos(this, to), options, options && options.type || "range")
      },
      setBookmark: function(pos, options) {
        var realOpts = {replacedWith: options && (options.nodeType == null ? options.widget : options),
                        insertLeft: options && options.insertLeft,
                        clearWhenEmpty: false, shared: options && options.shared,
                        handleMouseEvents: options && options.handleMouseEvents};
        pos = clipPos(this, pos);
        return markText(this, pos, pos, realOpts, "bookmark")
      },
      findMarksAt: function(pos) {
        pos = clipPos(this, pos);
        var markers = [], spans = getLine(this, pos.line).markedSpans;
        if (spans) { for (var i = 0; i < spans.length; ++i) {
          var span = spans[i];
          if ((span.from == null || span.from <= pos.ch) &&
              (span.to == null || span.to >= pos.ch))
            { markers.push(span.marker.parent || span.marker); }
        } }
        return markers
      },
      findMarks: function(from, to, filter) {
        from = clipPos(this, from); to = clipPos(this, to);
        var found = [], lineNo$$1 = from.line;
        this.iter(from.line, to.line + 1, function (line) {
          var spans = line.markedSpans;
          if (spans) { for (var i = 0; i < spans.length; i++) {
            var span = spans[i];
            if (!(span.to != null && lineNo$$1 == from.line && from.ch >= span.to ||
                  span.from == null && lineNo$$1 != from.line ||
                  span.from != null && lineNo$$1 == to.line && span.from >= to.ch) &&
                (!filter || filter(span.marker)))
              { found.push(span.marker.parent || span.marker); }
          } }
          ++lineNo$$1;
        });
        return found
      },
      getAllMarks: function() {
        var markers = [];
        this.iter(function (line) {
          var sps = line.markedSpans;
          if (sps) { for (var i = 0; i < sps.length; ++i)
            { if (sps[i].from != null) { markers.push(sps[i].marker); } } }
        });
        return markers
      },
  
      posFromIndex: function(off) {
        var ch, lineNo$$1 = this.first, sepSize = this.lineSeparator().length;
        this.iter(function (line) {
          var sz = line.text.length + sepSize;
          if (sz > off) { ch = off; return true }
          off -= sz;
          ++lineNo$$1;
        });
        return clipPos(this, Pos(lineNo$$1, ch))
      },
      indexFromPos: function (coords) {
        coords = clipPos(this, coords);
        var index = coords.ch;
        if (coords.line < this.first || coords.ch < 0) { return 0 }
        var sepSize = this.lineSeparator().length;
        this.iter(this.first, coords.line, function (line) { // iter aborts when callback returns a truthy value
          index += line.text.length + sepSize;
        });
        return index
      },
  
      copy: function(copyHistory) {
        var doc = new Doc(getLines(this, this.first, this.first + this.size),
                          this.modeOption, this.first, this.lineSep, this.direction);
        doc.scrollTop = this.scrollTop; doc.scrollLeft = this.scrollLeft;
        doc.sel = this.sel;
        doc.extend = false;
        if (copyHistory) {
          doc.history.undoDepth = this.history.undoDepth;
          doc.setHistory(this.getHistory());
        }
        return doc
      },
  
      linkedDoc: function(options) {
        if (!options) { options = {}; }
        var from = this.first, to = this.first + this.size;
        if (options.from != null && options.from > from) { from = options.from; }
        if (options.to != null && options.to < to) { to = options.to; }
        var copy = new Doc(getLines(this, from, to), options.mode || this.modeOption, from, this.lineSep, this.direction);
        if (options.sharedHist) { copy.history = this.history
        ; }(this.linked || (this.linked = [])).push({doc: copy, sharedHist: options.sharedHist});
        copy.linked = [{doc: this, isParent: true, sharedHist: options.sharedHist}];
        copySharedMarkers(copy, findSharedMarkers(this));
        return copy
      },
      unlinkDoc: function(other) {
        var this$1 = this;
  
        if (other instanceof CodeMirror) { other = other.doc; }
        if (this.linked) { for (var i = 0; i < this.linked.length; ++i) {
          var link = this$1.linked[i];
          if (link.doc != other) { continue }
          this$1.linked.splice(i, 1);
          other.unlinkDoc(this$1);
          detachSharedMarkers(findSharedMarkers(this$1));
          break
        } }
        // If the histories were shared, split them again
        if (other.history == this.history) {
          var splitIds = [other.id];
          linkedDocs(other, function (doc) { return splitIds.push(doc.id); }, true);
          other.history = new History(null);
          other.history.done = copyHistoryArray(this.history.done, splitIds);
          other.history.undone = copyHistoryArray(this.history.undone, splitIds);
        }
      },
      iterLinkedDocs: function(f) {linkedDocs(this, f);},
  
      getMode: function() {return this.mode},
      getEditor: function() {return this.cm},
  
      splitLines: function(str) {
        if (this.lineSep) { return str.split(this.lineSep) }
        return splitLinesAuto(str)
      },
      lineSeparator: function() { return this.lineSep || "\n" },
  
      setDirection: docMethodOp(function (dir) {
        if (dir != "rtl") { dir = "ltr"; }
        if (dir == this.direction) { return }
        this.direction = dir;
        this.iter(function (line) { return line.order = null; });
        if (this.cm) { directionChanged(this.cm); }
      })
    });
  
    // Public alias.
    Doc.prototype.eachLine = Doc.prototype.iter;
  
    // Kludge to work around strange IE behavior where it'll sometimes
    // re-fire a series of drag-related events right after the drop (#1551)
    var lastDrop = 0;
  
    function onDrop(e) {
      var cm = this;
      clearDragCursor(cm);
      if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e))
        { return }
      e_preventDefault(e);
      if (ie) { lastDrop = +new Date; }
      var pos = posFromMouse(cm, e, true), files = e.dataTransfer.files;
      if (!pos || cm.isReadOnly()) { return }
      // Might be a file drop, in which case we simply extract the text
      // and insert it.
      if (files && files.length && window.FileReader && window.File) {
        var n = files.length, text = Array(n), read = 0;
        var markAsReadAndPasteIfAllFilesAreRead = function () {
          if (++read == n) {
            operation(cm, function () {
              pos = clipPos(cm.doc, pos);
              var change = {from: pos, to: pos,
                            text: cm.doc.splitLines(
                                text.filter(function (t) { return t != null; }).join(cm.doc.lineSeparator())),
                            origin: "paste"};
              makeChange(cm.doc, change);
              setSelectionReplaceHistory(cm.doc, simpleSelection(clipPos(cm.doc, pos), clipPos(cm.doc, changeEnd(change))));
            })();
          }
        };
        var readTextFromFile = function (file, i) {
          if (cm.options.allowDropFileTypes &&
              indexOf(cm.options.allowDropFileTypes, file.type) == -1) {
            markAsReadAndPasteIfAllFilesAreRead();
            return
          }
          var reader = new FileReader;
          reader.onerror = function () { return markAsReadAndPasteIfAllFilesAreRead(); };
          reader.onload = function () {
            var content = reader.result;
            if (/[\x00-\x08\x0e-\x1f]{2}/.test(content)) {
              markAsReadAndPasteIfAllFilesAreRead();
              return
            }
            text[i] = content;
            markAsReadAndPasteIfAllFilesAreRead();
          };
          reader.readAsText(file);
        };
        for (var i = 0; i < files.length; i++) { readTextFromFile(files[i], i); }
      } else { // Normal drop
        // Don't do a replace if the drop happened inside of the selected text.
        if (cm.state.draggingText && cm.doc.sel.contains(pos) > -1) {
          cm.state.draggingText(e);
          // Ensure the editor is re-focused
          setTimeout(function () { return cm.display.input.focus(); }, 20);
          return
        }
        try {
          var text$1 = e.dataTransfer.getData("Text");
          if (text$1) {
            var selected;
            if (cm.state.draggingText && !cm.state.draggingText.copy)
              { selected = cm.listSelections(); }
            setSelectionNoUndo(cm.doc, simpleSelection(pos, pos));
            if (selected) { for (var i$1 = 0; i$1 < selected.length; ++i$1)
              { replaceRange(cm.doc, "", selected[i$1].anchor, selected[i$1].head, "drag"); } }
            cm.replaceSelection(text$1, "around", "paste");
            cm.display.input.focus();
          }
        }
        catch(e){}
      }
    }
  
    function onDragStart(cm, e) {
      if (ie && (!cm.state.draggingText || +new Date - lastDrop < 100)) { e_stop(e); return }
      if (signalDOMEvent(cm, e) || eventInWidget(cm.display, e)) { return }
  
      e.dataTransfer.setData("Text", cm.getSelection());
      e.dataTransfer.effectAllowed = "copyMove";
  
      // Use dummy image instead of default browsers image.
      // Recent Safari (~6.0.2) have a tendency to segfault when this happens, so we don't do it there.
      if (e.dataTransfer.setDragImage && !safari) {
        var img = elt("img", null, null, "position: fixed; left: 0; top: 0;");
        img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
        if (presto) {
          img.width = img.height = 1;
          cm.display.wrapper.appendChild(img);
          // Force a relayout, or Opera won't use our image for some obscure reason
          img._top = img.offsetTop;
        }
        e.dataTransfer.setDragImage(img, 0, 0);
        if (presto) { img.parentNode.removeChild(img); }
      }
    }
  
    function onDragOver(cm, e) {
      var pos = posFromMouse(cm, e);
      if (!pos) { return }
      var frag = document.createDocumentFragment();
      drawSelectionCursor(cm, pos, frag);
      if (!cm.display.dragCursor) {
        cm.display.dragCursor = elt("div", null, "CodeMirror-cursors CodeMirror-dragcursors");
        cm.display.lineSpace.insertBefore(cm.display.dragCursor, cm.display.cursorDiv);
      }
      removeChildrenAndAdd(cm.display.dragCursor, frag);
    }
  
    function clearDragCursor(cm) {
      if (cm.display.dragCursor) {
        cm.display.lineSpace.removeChild(cm.display.dragCursor);
        cm.display.dragCursor = null;
      }
    }
  
    // These must be handled carefully, because naively registering a
    // handler for each editor will cause the editors to never be
    // garbage collected.
  
    function forEachCodeMirror(f) {
      if (!document.getElementsByClassName) { return }
      var byClass = document.getElementsByClassName("CodeMirror"), editors = [];
      for (var i = 0; i < byClass.length; i++) {
        var cm = byClass[i].CodeMirror;
        if (cm) { editors.push(cm); }
      }
      if (editors.length) { editors[0].operation(function () {
        for (var i = 0; i < editors.length; i++) { f(editors[i]); }
      }); }
    }
  
    var globalsRegistered = false;
    function ensureGlobalHandlers() {
      if (globalsRegistered) { return }
      registerGlobalHandlers();
      globalsRegistered = true;
    }
    function registerGlobalHandlers() {
      // When the window resizes, we need to refresh active editors.
      var resizeTimer;
      on(window, "resize", function () {
        if (resizeTimer == null) { resizeTimer = setTimeout(function () {
          resizeTimer = null;
          forEachCodeMirror(onResize);
        }, 100); }
      });
      // When the window loses focus, we want to show the editor as blurred
      on(window, "blur", function () { return forEachCodeMirror(onBlur); });
    }
    // Called when the window resizes
    function onResize(cm) {
      var d = cm.display;
      // Might be a text scaling operation, clear size caches.
      d.cachedCharWidth = d.cachedTextHeight = d.cachedPaddingH = null;
      d.scrollbarsClipped = false;
      cm.setSize();
    }
  
    var keyNames = {
      3: "Pause", 8: "Backspace", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt",
      19: "Pause", 20: "CapsLock", 27: "Esc", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End",
      36: "Home", 37: "Left", 38: "Up", 39: "Right", 40: "Down", 44: "PrintScrn", 45: "Insert",
      46: "Delete", 59: ";", 61: "=", 91: "Mod", 92: "Mod", 93: "Mod",
      106: "*", 107: "=", 109: "-", 110: ".", 111: "/", 145: "ScrollLock",
      173: "-", 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\",
      221: "]", 222: "'", 63232: "Up", 63233: "Down", 63234: "Left", 63235: "Right", 63272: "Delete",
      63273: "Home", 63275: "End", 63276: "PageUp", 63277: "PageDown", 63302: "Insert"
    };
  
    // Number keys
    for (var i = 0; i < 10; i++) { keyNames[i + 48] = keyNames[i + 96] = String(i); }
    // Alphabetic keys
    for (var i$1 = 65; i$1 <= 90; i$1++) { keyNames[i$1] = String.fromCharCode(i$1); }
    // Function keys
    for (var i$2 = 1; i$2 <= 12; i$2++) { keyNames[i$2 + 111] = keyNames[i$2 + 63235] = "F" + i$2; }
  
    var keyMap = {};
  
    keyMap.basic = {
      "Left": "goCharLeft", "Right": "goCharRight", "Up": "goLineUp", "Down": "goLineDown",
      "End": "goLineEnd", "Home": "goLineStartSmart", "PageUp": "goPageUp", "PageDown": "goPageDown",
      "Delete": "delCharAfter", "Backspace": "delCharBefore", "Shift-Backspace": "delCharBefore",
      "Tab": "defaultTab", "Shift-Tab": "indentAuto",
      "Enter": "newlineAndIndent", "Insert": "toggleOverwrite",
      "Esc": "singleSelection"
    };
    // Note that the save and find-related commands aren't defined by
    // default. User code or addons can define them. Unknown commands
    // are simply ignored.
    keyMap.pcDefault = {
      "Ctrl-A": "selectAll", "Ctrl-D": "deleteLine", "Ctrl-Z": "undo", "Shift-Ctrl-Z": "redo", "Ctrl-Y": "redo",
      "Ctrl-Home": "goDocStart", "Ctrl-End": "goDocEnd", "Ctrl-Up": "goLineUp", "Ctrl-Down": "goLineDown",
      "Ctrl-Left": "goGroupLeft", "Ctrl-Right": "goGroupRight", "Alt-Left": "goLineStart", "Alt-Right": "goLineEnd",
      "Ctrl-Backspace": "delGroupBefore", "Ctrl-Delete": "delGroupAfter", "Ctrl-S": "save", "Ctrl-F": "find",
      "Ctrl-G": "findNext", "Shift-Ctrl-G": "findPrev", "Shift-Ctrl-F": "replace", "Shift-Ctrl-R": "replaceAll",
      "Ctrl-[": "indentLess", "Ctrl-]": "indentMore",
      "Ctrl-U": "undoSelection", "Shift-Ctrl-U": "redoSelection", "Alt-U": "redoSelection",
      "fallthrough": "basic"
    };
    // Very basic readline/emacs-style bindings, which are standard on Mac.
    keyMap.emacsy = {
      "Ctrl-F": "goCharRight", "Ctrl-B": "goCharLeft", "Ctrl-P": "goLineUp", "Ctrl-N": "goLineDown",
      "Alt-F": "goWordRight", "Alt-B": "goWordLeft", "Ctrl-A": "goLineStart", "Ctrl-E": "goLineEnd",
      "Ctrl-V": "goPageDown", "Shift-Ctrl-V": "goPageUp", "Ctrl-D": "delCharAfter", "Ctrl-H": "delCharBefore",
      "Alt-D": "delWordAfter", "Alt-Backspace": "delWordBefore", "Ctrl-K": "killLine", "Ctrl-T": "transposeChars",
      "Ctrl-O": "openLine"
    };
    keyMap.macDefault = {
      "Cmd-A": "selectAll", "Cmd-D": "deleteLine", "Cmd-Z": "undo", "Shift-Cmd-Z": "redo", "Cmd-Y": "redo",
      "Cmd-Home": "goDocStart", "Cmd-Up": "goDocStart", "Cmd-End": "goDocEnd", "Cmd-Down": "goDocEnd", "Alt-Left": "goGroupLeft",
      "Alt-Right": "goGroupRight", "Cmd-Left": "goLineLeft", "Cmd-Right": "goLineRight", "Alt-Backspace": "delGroupBefore",
      "Ctrl-Alt-Backspace": "delGroupAfter", "Alt-Delete": "delGroupAfter", "Cmd-S": "save", "Cmd-F": "find",
      "Cmd-G": "findNext", "Shift-Cmd-G": "findPrev", "Cmd-Alt-F": "replace", "Shift-Cmd-Alt-F": "replaceAll",
      "Cmd-[": "indentLess", "Cmd-]": "indentMore", "Cmd-Backspace": "delWrappedLineLeft", "Cmd-Delete": "delWrappedLineRight",
      "Cmd-U": "undoSelection", "Shift-Cmd-U": "redoSelection", "Ctrl-Up": "goDocStart", "Ctrl-Down": "goDocEnd",
      "fallthrough": ["basic", "emacsy"]
    };
    keyMap["default"] = mac ? keyMap.macDefault : keyMap.pcDefault;
  
    // KEYMAP DISPATCH
  
    function normalizeKeyName(name) {
      var parts = name.split(/-(?!$)/);
      name = parts[parts.length - 1];
      var alt, ctrl, shift, cmd;
      for (var i = 0; i < parts.length - 1; i++) {
        var mod = parts[i];
        if (/^(cmd|meta|m)$/i.test(mod)) { cmd = true; }
        else if (/^a(lt)?$/i.test(mod)) { alt = true; }
        else if (/^(c|ctrl|control)$/i.test(mod)) { ctrl = true; }
        else if (/^s(hift)?$/i.test(mod)) { shift = true; }
        else { throw new Error("Unrecognized modifier name: " + mod) }
      }
      if (alt) { name = "Alt-" + name; }
      if (ctrl) { name = "Ctrl-" + name; }
      if (cmd) { name = "Cmd-" + name; }
      if (shift) { name = "Shift-" + name; }
      return name
    }
  
    // This is a kludge to keep keymaps mostly working as raw objects
    // (backwards compatibility) while at the same time support features
    // like normalization and multi-stroke key bindings. It compiles a
    // new normalized keymap, and then updates the old object to reflect
    // this.
    function normalizeKeyMap(keymap) {
      var copy = {};
      for (var keyname in keymap) { if (keymap.hasOwnProperty(keyname)) {
        var value = keymap[keyname];
        if (/^(name|fallthrough|(de|at)tach)$/.test(keyname)) { continue }
        if (value == "...") { delete keymap[keyname]; continue }
  
        var keys = map(keyname.split(" "), normalizeKeyName);
        for (var i = 0; i < keys.length; i++) {
          var val = (void 0), name = (void 0);
          if (i == keys.length - 1) {
            name = keys.join(" ");
            val = value;
          } else {
            name = keys.slice(0, i + 1).join(" ");
            val = "...";
          }
          var prev = copy[name];
          if (!prev) { copy[name] = val; }
          else if (prev != val) { throw new Error("Inconsistent bindings for " + name) }
        }
        delete keymap[keyname];
      } }
      for (var prop in copy) { keymap[prop] = copy[prop]; }
      return keymap
    }
  
    function lookupKey(key, map$$1, handle, context) {
      map$$1 = getKeyMap(map$$1);
      var found = map$$1.call ? map$$1.call(key, context) : map$$1[key];
      if (found === false) { return "nothing" }
      if (found === "...") { return "multi" }
      if (found != null && handle(found)) { return "handled" }
  
      if (map$$1.fallthrough) {
        if (Object.prototype.toString.call(map$$1.fallthrough) != "[object Array]")
          { return lookupKey(key, map$$1.fallthrough, handle, context) }
        for (var i = 0; i < map$$1.fallthrough.length; i++) {
          var result = lookupKey(key, map$$1.fallthrough[i], handle, context);
          if (result) { return result }
        }
      }
    }
  
    // Modifier key presses don't count as 'real' key presses for the
    // purpose of keymap fallthrough.
    function isModifierKey(value) {
      var name = typeof value == "string" ? value : keyNames[value.keyCode];
      return name == "Ctrl" || name == "Alt" || name == "Shift" || name == "Mod"
    }
  
    function addModifierNames(name, event, noShift) {
      var base = name;
      if (event.altKey && base != "Alt") { name = "Alt-" + name; }
      if ((flipCtrlCmd ? event.metaKey : event.ctrlKey) && base != "Ctrl") { name = "Ctrl-" + name; }
      if ((flipCtrlCmd ? event.ctrlKey : event.metaKey) && base != "Cmd") { name = "Cmd-" + name; }
      if (!noShift && event.shiftKey && base != "Shift") { name = "Shift-" + name; }
      return name
    }
  
    // Look up the name of a key as indicated by an event object.
    function keyName(event, noShift) {
      if (presto && event.keyCode == 34 && event["char"]) { return false }
      var name = keyNames[event.keyCode];
      if (name == null || event.altGraphKey) { return false }
      // Ctrl-ScrollLock has keyCode 3, same as Ctrl-Pause,
      // so we'll use event.code when available (Chrome 48+, FF 38+, Safari 10.1+)
      if (event.keyCode == 3 && event.code) { name = event.code; }
      return addModifierNames(name, event, noShift)
    }
  
    function getKeyMap(val) {
      return typeof val == "string" ? keyMap[val] : val
    }
  
    // Helper for deleting text near the selection(s), used to implement
    // backspace, delete, and similar functionality.
    function deleteNearSelection(cm, compute) {
      var ranges = cm.doc.sel.ranges, kill = [];
      // Build up a set of ranges to kill first, merging overlapping
      // ranges.
      for (var i = 0; i < ranges.length; i++) {
        var toKill = compute(ranges[i]);
        while (kill.length && cmp(toKill.from, lst(kill).to) <= 0) {
          var replaced = kill.pop();
          if (cmp(replaced.from, toKill.from) < 0) {
            toKill.from = replaced.from;
            break
          }
        }
        kill.push(toKill);
      }
      // Next, remove those actual ranges.
      runInOp(cm, function () {
        for (var i = kill.length - 1; i >= 0; i--)
          { replaceRange(cm.doc, "", kill[i].from, kill[i].to, "+delete"); }
        ensureCursorVisible(cm);
      });
    }
  
    function moveCharLogically(line, ch, dir) {
      var target = skipExtendingChars(line.text, ch + dir, dir);
      return target < 0 || target > line.text.length ? null : target
    }
  
    function moveLogically(line, start, dir) {
      var ch = moveCharLogically(line, start.ch, dir);
      return ch == null ? null : new Pos(start.line, ch, dir < 0 ? "after" : "before")
    }
  
    function endOfLine(visually, cm, lineObj, lineNo, dir) {
      if (visually) {
        if (cm.doc.direction == "rtl") { dir = -dir; }
        var order = getOrder(lineObj, cm.doc.direction);
        if (order) {
          var part = dir < 0 ? lst(order) : order[0];
          var moveInStorageOrder = (dir < 0) == (part.level == 1);
          var sticky = moveInStorageOrder ? "after" : "before";
          var ch;
          // With a wrapped rtl chunk (possibly spanning multiple bidi parts),
          // it could be that the last bidi part is not on the last visual line,
          // since visual lines contain content order-consecutive chunks.
          // Thus, in rtl, we are looking for the first (content-order) character
          // in the rtl chunk that is on the last line (that is, the same line
          // as the last (content-order) character).
          if (part.level > 0 || cm.doc.direction == "rtl") {
            var prep = prepareMeasureForLine(cm, lineObj);
            ch = dir < 0 ? lineObj.text.length - 1 : 0;
            var targetTop = measureCharPrepared(cm, prep, ch).top;
            ch = findFirst(function (ch) { return measureCharPrepared(cm, prep, ch).top == targetTop; }, (dir < 0) == (part.level == 1) ? part.from : part.to - 1, ch);
            if (sticky == "before") { ch = moveCharLogically(lineObj, ch, 1); }
          } else { ch = dir < 0 ? part.to : part.from; }
          return new Pos(lineNo, ch, sticky)
        }
      }
      return new Pos(lineNo, dir < 0 ? lineObj.text.length : 0, dir < 0 ? "before" : "after")
    }
  
    function moveVisually(cm, line, start, dir) {
      var bidi = getOrder(line, cm.doc.direction);
      if (!bidi) { return moveLogically(line, start, dir) }
      if (start.ch >= line.text.length) {
        start.ch = line.text.length;
        start.sticky = "before";
      } else if (start.ch <= 0) {
        start.ch = 0;
        start.sticky = "after";
      }
      var partPos = getBidiPartAt(bidi, start.ch, start.sticky), part = bidi[partPos];
      if (cm.doc.direction == "ltr" && part.level % 2 == 0 && (dir > 0 ? part.to > start.ch : part.from < start.ch)) {
        // Case 1: We move within an ltr part in an ltr editor. Even with wrapped lines,
        // nothing interesting happens.
        return moveLogically(line, start, dir)
      }
  
      var mv = function (pos, dir) { return moveCharLogically(line, pos instanceof Pos ? pos.ch : pos, dir); };
      var prep;
      var getWrappedLineExtent = function (ch) {
        if (!cm.options.lineWrapping) { return {begin: 0, end: line.text.length} }
        prep = prep || prepareMeasureForLine(cm, line);
        return wrappedLineExtentChar(cm, line, prep, ch)
      };
      var wrappedLineExtent = getWrappedLineExtent(start.sticky == "before" ? mv(start, -1) : start.ch);
  
      if (cm.doc.direction == "rtl" || part.level == 1) {
        var moveInStorageOrder = (part.level == 1) == (dir < 0);
        var ch = mv(start, moveInStorageOrder ? 1 : -1);
        if (ch != null && (!moveInStorageOrder ? ch >= part.from && ch >= wrappedLineExtent.begin : ch <= part.to && ch <= wrappedLineExtent.end)) {
          // Case 2: We move within an rtl part or in an rtl editor on the same visual line
          var sticky = moveInStorageOrder ? "before" : "after";
          return new Pos(start.line, ch, sticky)
        }
      }
  
      // Case 3: Could not move within this bidi part in this visual line, so leave
      // the current bidi part
  
      var searchInVisualLine = function (partPos, dir, wrappedLineExtent) {
        var getRes = function (ch, moveInStorageOrder) { return moveInStorageOrder
          ? new Pos(start.line, mv(ch, 1), "before")
          : new Pos(start.line, ch, "after"); };
  
        for (; partPos >= 0 && partPos < bidi.length; partPos += dir) {
          var part = bidi[partPos];
          var moveInStorageOrder = (dir > 0) == (part.level != 1);
          var ch = moveInStorageOrder ? wrappedLineExtent.begin : mv(wrappedLineExtent.end, -1);
          if (part.from <= ch && ch < part.to) { return getRes(ch, moveInStorageOrder) }
          ch = moveInStorageOrder ? part.from : mv(part.to, -1);
          if (wrappedLineExtent.begin <= ch && ch < wrappedLineExtent.end) { return getRes(ch, moveInStorageOrder) }
        }
      };
  
      // Case 3a: Look for other bidi parts on the same visual line
      var res = searchInVisualLine(partPos + dir, dir, wrappedLineExtent);
      if (res) { return res }
  
      // Case 3b: Look for other bidi parts on the next visual line
      var nextCh = dir > 0 ? wrappedLineExtent.end : mv(wrappedLineExtent.begin, -1);
      if (nextCh != null && !(dir > 0 && nextCh == line.text.length)) {
        res = searchInVisualLine(dir > 0 ? 0 : bidi.length - 1, dir, getWrappedLineExtent(nextCh));
        if (res) { return res }
      }
  
      // Case 4: Nowhere to move
      return null
    }
  
    // Commands are parameter-less actions that can be performed on an
    // editor, mostly used for keybindings.
    var commands = {
      selectAll: selectAll,
      singleSelection: function (cm) { return cm.setSelection(cm.getCursor("anchor"), cm.getCursor("head"), sel_dontScroll); },
      killLine: function (cm) { return deleteNearSelection(cm, function (range) {
        if (range.empty()) {
          var len = getLine(cm.doc, range.head.line).text.length;
          if (range.head.ch == len && range.head.line < cm.lastLine())
            { return {from: range.head, to: Pos(range.head.line + 1, 0)} }
          else
            { return {from: range.head, to: Pos(range.head.line, len)} }
        } else {
          return {from: range.from(), to: range.to()}
        }
      }); },
      deleteLine: function (cm) { return deleteNearSelection(cm, function (range) { return ({
        from: Pos(range.from().line, 0),
        to: clipPos(cm.doc, Pos(range.to().line + 1, 0))
      }); }); },
      delLineLeft: function (cm) { return deleteNearSelection(cm, function (range) { return ({
        from: Pos(range.from().line, 0), to: range.from()
      }); }); },
      delWrappedLineLeft: function (cm) { return deleteNearSelection(cm, function (range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        var leftPos = cm.coordsChar({left: 0, top: top}, "div");
        return {from: leftPos, to: range.from()}
      }); },
      delWrappedLineRight: function (cm) { return deleteNearSelection(cm, function (range) {
        var top = cm.charCoords(range.head, "div").top + 5;
        var rightPos = cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div");
        return {from: range.from(), to: rightPos }
      }); },
      undo: function (cm) { return cm.undo(); },
      redo: function (cm) { return cm.redo(); },
      undoSelection: function (cm) { return cm.undoSelection(); },
      redoSelection: function (cm) { return cm.redoSelection(); },
      goDocStart: function (cm) { return cm.extendSelection(Pos(cm.firstLine(), 0)); },
      goDocEnd: function (cm) { return cm.extendSelection(Pos(cm.lastLine())); },
      goLineStart: function (cm) { return cm.extendSelectionsBy(function (range) { return lineStart(cm, range.head.line); },
        {origin: "+move", bias: 1}
      ); },
      goLineStartSmart: function (cm) { return cm.extendSelectionsBy(function (range) { return lineStartSmart(cm, range.head); },
        {origin: "+move", bias: 1}
      ); },
      goLineEnd: function (cm) { return cm.extendSelectionsBy(function (range) { return lineEnd(cm, range.head.line); },
        {origin: "+move", bias: -1}
      ); },
      goLineRight: function (cm) { return cm.extendSelectionsBy(function (range) {
        var top = cm.cursorCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: cm.display.lineDiv.offsetWidth + 100, top: top}, "div")
      }, sel_move); },
      goLineLeft: function (cm) { return cm.extendSelectionsBy(function (range) {
        var top = cm.cursorCoords(range.head, "div").top + 5;
        return cm.coordsChar({left: 0, top: top}, "div")
      }, sel_move); },
      goLineLeftSmart: function (cm) { return cm.extendSelectionsBy(function (range) {
        var top = cm.cursorCoords(range.head, "div").top + 5;
        var pos = cm.coordsChar({left: 0, top: top}, "div");
        if (pos.ch < cm.getLine(pos.line).search(/\S/)) { return lineStartSmart(cm, range.head) }
        return pos
      }, sel_move); },
      goLineUp: function (cm) { return cm.moveV(-1, "line"); },
      goLineDown: function (cm) { return cm.moveV(1, "line"); },
      goPageUp: function (cm) { return cm.moveV(-1, "page"); },
      goPageDown: function (cm) { return cm.moveV(1, "page"); },
      goCharLeft: function (cm) { return cm.moveH(-1, "char"); },
      goCharRight: function (cm) { return cm.moveH(1, "char"); },
      goColumnLeft: function (cm) { return cm.moveH(-1, "column"); },
      goColumnRight: function (cm) { return cm.moveH(1, "column"); },
      goWordLeft: function (cm) { return cm.moveH(-1, "word"); },
      goGroupRight: function (cm) { return cm.moveH(1, "group"); },
      goGroupLeft: function (cm) { return cm.moveH(-1, "group"); },
      goWordRight: function (cm) { return cm.moveH(1, "word"); },
      delCharBefore: function (cm) { return cm.deleteH(-1, "char"); },
      delCharAfter: function (cm) { return cm.deleteH(1, "char"); },
      delWordBefore: function (cm) { return cm.deleteH(-1, "word"); },
      delWordAfter: function (cm) { return cm.deleteH(1, "word"); },
      delGroupBefore: function (cm) { return cm.deleteH(-1, "group"); },
      delGroupAfter: function (cm) { return cm.deleteH(1, "group"); },
      indentAuto: function (cm) { return cm.indentSelection("smart"); },
      indentMore: function (cm) { return cm.indentSelection("add"); },
      indentLess: function (cm) { return cm.indentSelection("subtract"); },
      insertTab: function (cm) { return cm.replaceSelection("\t"); },
      insertSoftTab: function (cm) {
        var spaces = [], ranges = cm.listSelections(), tabSize = cm.options.tabSize;
        for (var i = 0; i < ranges.length; i++) {
          var pos = ranges[i].from();
          var col = countColumn(cm.getLine(pos.line), pos.ch, tabSize);
          spaces.push(spaceStr(tabSize - col % tabSize));
        }
        cm.replaceSelections(spaces);
      },
      defaultTab: function (cm) {
        if (cm.somethingSelected()) { cm.indentSelection("add"); }
        else { cm.execCommand("insertTab"); }
      },
      // Swap the two chars left and right of each selection's head.
      // Move cursor behind the two swapped characters afterwards.
      //
      // Doesn't consider line feeds a character.
      // Doesn't scan more than one line above to find a character.
      // Doesn't do anything on an empty line.
      // Doesn't do anything with non-empty selections.
      transposeChars: function (cm) { return runInOp(cm, function () {
        var ranges = cm.listSelections(), newSel = [];
        for (var i = 0; i < ranges.length; i++) {
          if (!ranges[i].empty()) { continue }
          var cur = ranges[i].head, line = getLine(cm.doc, cur.line).text;
          if (line) {
            if (cur.ch == line.length) { cur = new Pos(cur.line, cur.ch - 1); }
            if (cur.ch > 0) {
              cur = new Pos(cur.line, cur.ch + 1);
              cm.replaceRange(line.charAt(cur.ch - 1) + line.charAt(cur.ch - 2),
                              Pos(cur.line, cur.ch - 2), cur, "+transpose");
            } else if (cur.line > cm.doc.first) {
              var prev = getLine(cm.doc, cur.line - 1).text;
              if (prev) {
                cur = new Pos(cur.line, 1);
                cm.replaceRange(line.charAt(0) + cm.doc.lineSeparator() +
                                prev.charAt(prev.length - 1),
                                Pos(cur.line - 1, prev.length - 1), cur, "+transpose");
              }
            }
          }
          newSel.push(new Range(cur, cur));
        }
        cm.setSelections(newSel);
      }); },
      newlineAndIndent: function (cm) { return runInOp(cm, function () {
        var sels = cm.listSelections();
        for (var i = sels.length - 1; i >= 0; i--)
          { cm.replaceRange(cm.doc.lineSeparator(), sels[i].anchor, sels[i].head, "+input"); }
        sels = cm.listSelections();
        for (var i$1 = 0; i$1 < sels.length; i$1++)
          { cm.indentLine(sels[i$1].from().line, null, true); }
        ensureCursorVisible(cm);
      }); },
      openLine: function (cm) { return cm.replaceSelection("\n", "start"); },
      toggleOverwrite: function (cm) { return cm.toggleOverwrite(); }
    };
  
  
    function lineStart(cm, lineN) {
      var line = getLine(cm.doc, lineN);
      var visual = visualLine(line);
      if (visual != line) { lineN = lineNo(visual); }
      return endOfLine(true, cm, visual, lineN, 1)
    }
    function lineEnd(cm, lineN) {
      var line = getLine(cm.doc, lineN);
      var visual = visualLineEnd(line);
      if (visual != line) { lineN = lineNo(visual); }
      return endOfLine(true, cm, line, lineN, -1)
    }
    function lineStartSmart(cm, pos) {
      var start = lineStart(cm, pos.line);
      var line = getLine(cm.doc, start.line);
      var order = getOrder(line, cm.doc.direction);
      if (!order || order[0].level == 0) {
        var firstNonWS = Math.max(start.ch, line.text.search(/\S/));
        var inWS = pos.line == start.line && pos.ch <= firstNonWS && pos.ch;
        return Pos(start.line, inWS ? 0 : firstNonWS, start.sticky)
      }
      return start
    }
  
    // Run a handler that was bound to a key.
    function doHandleBinding(cm, bound, dropShift) {
      if (typeof bound == "string") {
        bound = commands[bound];
        if (!bound) { return false }
      }
      // Ensure previous input has been read, so that the handler sees a
      // consistent view of the document
      cm.display.input.ensurePolled();
      var prevShift = cm.display.shift, done = false;
      try {
        if (cm.isReadOnly()) { cm.state.suppressEdits = true; }
        if (dropShift) { cm.display.shift = false; }
        done = bound(cm) != Pass;
      } finally {
        cm.display.shift = prevShift;
        cm.state.suppressEdits = false;
      }
      return done
    }
  
    function lookupKeyForEditor(cm, name, handle) {
      for (var i = 0; i < cm.state.keyMaps.length; i++) {
        var result = lookupKey(name, cm.state.keyMaps[i], handle, cm);
        if (result) { return result }
      }
      return (cm.options.extraKeys && lookupKey(name, cm.options.extraKeys, handle, cm))
        || lookupKey(name, cm.options.keyMap, handle, cm)
    }
  
    // Note that, despite the name, this function is also used to check
    // for bound mouse clicks.
  
    var stopSeq = new Delayed;
  
    function dispatchKey(cm, name, e, handle) {
      var seq = cm.state.keySeq;
      if (seq) {
        if (isModifierKey(name)) { return "handled" }
        if (/\'$/.test(name))
          { cm.state.keySeq = null; }
        else
          { stopSeq.set(50, function () {
            if (cm.state.keySeq == seq) {
              cm.state.keySeq = null;
              cm.display.input.reset();
            }
          }); }
        if (dispatchKeyInner(cm, seq + " " + name, e, handle)) { return true }
      }
      return dispatchKeyInner(cm, name, e, handle)
    }
  
    function dispatchKeyInner(cm, name, e, handle) {
      var result = lookupKeyForEditor(cm, name, handle);
  
      if (result == "multi")
        { cm.state.keySeq = name; }
      if (result == "handled")
        { signalLater(cm, "keyHandled", cm, name, e); }
  
      if (result == "handled" || result == "multi") {
        e_preventDefault(e);
        restartBlink(cm);
      }
  
      return !!result
    }
  
    // Handle a key from the keydown event.
    function handleKeyBinding(cm, e) {
      var name = keyName(e, true);
      if (!name) { return false }
  
      if (e.shiftKey && !cm.state.keySeq) {
        // First try to resolve full name (including 'Shift-'). Failing
        // that, see if there is a cursor-motion command (starting with
        // 'go') bound to the keyname without 'Shift-'.
        return dispatchKey(cm, "Shift-" + name, e, function (b) { return doHandleBinding(cm, b, true); })
            || dispatchKey(cm, name, e, function (b) {
                 if (typeof b == "string" ? /^go[A-Z]/.test(b) : b.motion)
                   { return doHandleBinding(cm, b) }
               })
      } else {
        return dispatchKey(cm, name, e, function (b) { return doHandleBinding(cm, b); })
      }
    }
  
    // Handle a key from the keypress event
    function handleCharBinding(cm, e, ch) {
      return dispatchKey(cm, "'" + ch + "'", e, function (b) { return doHandleBinding(cm, b, true); })
    }
  
    var lastStoppedKey = null;
    function onKeyDown(e) {
      var cm = this;
      cm.curOp.focus = activeElt();
      if (signalDOMEvent(cm, e)) { return }
      // IE does strange things with escape.
      if (ie && ie_version < 11 && e.keyCode == 27) { e.returnValue = false; }
      var code = e.keyCode;
      cm.display.shift = code == 16 || e.shiftKey;
      var handled = handleKeyBinding(cm, e);
      if (presto) {
        lastStoppedKey = handled ? code : null;
        // Opera has no cut event... we try to at least catch the key combo
        if (!handled && code == 88 && !hasCopyEvent && (mac ? e.metaKey : e.ctrlKey))
          { cm.replaceSelection("", null, "cut"); }
      }
      if (gecko && !mac && !handled && code == 46 && e.shiftKey && !e.ctrlKey && document.execCommand)
        { document.execCommand("cut"); }
  
      // Turn mouse into crosshair when Alt is held on Mac.
      if (code == 18 && !/\bCodeMirror-crosshair\b/.test(cm.display.lineDiv.className))
        { showCrossHair(cm); }
    }
  
    function showCrossHair(cm) {
      var lineDiv = cm.display.lineDiv;
      addClass(lineDiv, "CodeMirror-crosshair");
  
      function up(e) {
        if (e.keyCode == 18 || !e.altKey) {
          rmClass(lineDiv, "CodeMirror-crosshair");
          off(document, "keyup", up);
          off(document, "mouseover", up);
        }
      }
      on(document, "keyup", up);
      on(document, "mouseover", up);
    }
  
    function onKeyUp(e) {
      if (e.keyCode == 16) { this.doc.sel.shift = false; }
      signalDOMEvent(this, e);
    }
  
    function onKeyPress(e) {
      var cm = this;
      if (eventInWidget(cm.display, e) || signalDOMEvent(cm, e) || e.ctrlKey && !e.altKey || mac && e.metaKey) { return }
      var keyCode = e.keyCode, charCode = e.charCode;
      if (presto && keyCode == lastStoppedKey) {lastStoppedKey = null; e_preventDefault(e); return}
      if ((presto && (!e.which || e.which < 10)) && handleKeyBinding(cm, e)) { return }
      var ch = String.fromCharCode(charCode == null ? keyCode : charCode);
      // Some browsers fire keypress events for backspace
      if (ch == "\x08") { return }
      if (handleCharBinding(cm, e, ch)) { return }
      cm.display.input.onKeyPress(e);
    }
  
    var DOUBLECLICK_DELAY = 400;
  
    var PastClick = function(time, pos, button) {
      this.time = time;
      this.pos = pos;
      this.button = button;
    };
  
    PastClick.prototype.compare = function (time, pos, button) {
      return this.time + DOUBLECLICK_DELAY > time &&
        cmp(pos, this.pos) == 0 && button == this.button
    };
  
    var lastClick, lastDoubleClick;
    function clickRepeat(pos, button) {
      var now = +new Date;
      if (lastDoubleClick && lastDoubleClick.compare(now, pos, button)) {
        lastClick = lastDoubleClick = null;
        return "triple"
      } else if (lastClick && lastClick.compare(now, pos, button)) {
        lastDoubleClick = new PastClick(now, pos, button);
        lastClick = null;
        return "double"
      } else {
        lastClick = new PastClick(now, pos, button);
        lastDoubleClick = null;
        return "single"
      }
    }
  
    // A mouse down can be a single click, double click, triple click,
    // start of selection drag, start of text drag, new cursor
    // (ctrl-click), rectangle drag (alt-drag), or xwin
    // middle-click-paste. Or it might be a click on something we should
    // not interfere with, such as a scrollbar or widget.
    function onMouseDown(e) {
      var cm = this, display = cm.display;
      if (signalDOMEvent(cm, e) || display.activeTouch && display.input.supportsTouch()) { return }
      display.input.ensurePolled();
      display.shift = e.shiftKey;
  
      if (eventInWidget(display, e)) {
        if (!webkit) {
          // Briefly turn off draggability, to allow widgets to do
          // normal dragging things.
          display.scroller.draggable = false;
          setTimeout(function () { return display.scroller.draggable = true; }, 100);
        }
        return
      }
      if (clickInGutter(cm, e)) { return }
      var pos = posFromMouse(cm, e), button = e_button(e), repeat = pos ? clickRepeat(pos, button) : "single";
      window.focus();
  
      // #3261: make sure, that we're not starting a second selection
      if (button == 1 && cm.state.selectingText)
        { cm.state.selectingText(e); }
  
      if (pos && handleMappedButton(cm, button, pos, repeat, e)) { return }
  
      if (button == 1) {
        if (pos) { leftButtonDown(cm, pos, repeat, e); }
        else if (e_target(e) == display.scroller) { e_preventDefault(e); }
      } else if (button == 2) {
        if (pos) { extendSelection(cm.doc, pos); }
        setTimeout(function () { return display.input.focus(); }, 20);
      } else if (button == 3) {
        if (captureRightClick) { cm.display.input.onContextMenu(e); }
        else { delayBlurEvent(cm); }
      }
    }
  
    function handleMappedButton(cm, button, pos, repeat, event) {
      var name = "Click";
      if (repeat == "double") { name = "Double" + name; }
      else if (repeat == "triple") { name = "Triple" + name; }
      name = (button == 1 ? "Left" : button == 2 ? "Middle" : "Right") + name;
  
      return dispatchKey(cm,  addModifierNames(name, event), event, function (bound) {
        if (typeof bound == "string") { bound = commands[bound]; }
        if (!bound) { return false }
        var done = false;
        try {
          if (cm.isReadOnly()) { cm.state.suppressEdits = true; }
          done = bound(cm, pos) != Pass;
        } finally {
          cm.state.suppressEdits = false;
        }
        return done
      })
    }
  
    function configureMouse(cm, repeat, event) {
      var option = cm.getOption("configureMouse");
      var value = option ? option(cm, repeat, event) : {};
      if (value.unit == null) {
        var rect = chromeOS ? event.shiftKey && event.metaKey : event.altKey;
        value.unit = rect ? "rectangle" : repeat == "single" ? "char" : repeat == "double" ? "word" : "line";
      }
      if (value.extend == null || cm.doc.extend) { value.extend = cm.doc.extend || event.shiftKey; }
      if (value.addNew == null) { value.addNew = mac ? event.metaKey : event.ctrlKey; }
      if (value.moveOnDrag == null) { value.moveOnDrag = !(mac ? event.altKey : event.ctrlKey); }
      return value
    }
  
    function leftButtonDown(cm, pos, repeat, event) {
      if (ie) { setTimeout(bind(ensureFocus, cm), 0); }
      else { cm.curOp.focus = activeElt(); }
  
      var behavior = configureMouse(cm, repeat, event);
  
      var sel = cm.doc.sel, contained;
      if (cm.options.dragDrop && dragAndDrop && !cm.isReadOnly() &&
          repeat == "single" && (contained = sel.contains(pos)) > -1 &&
          (cmp((contained = sel.ranges[contained]).from(), pos) < 0 || pos.xRel > 0) &&
          (cmp(contained.to(), pos) > 0 || pos.xRel < 0))
        { leftButtonStartDrag(cm, event, pos, behavior); }
      else
        { leftButtonSelect(cm, event, pos, behavior); }
    }
  
    // Start a text drag. When it ends, see if any dragging actually
    // happen, and treat as a click if it didn't.
    function leftButtonStartDrag(cm, event, pos, behavior) {
      var display = cm.display, moved = false;
      var dragEnd = operation(cm, function (e) {
        if (webkit) { display.scroller.draggable = false; }
        cm.state.draggingText = false;
        off(display.wrapper.ownerDocument, "mouseup", dragEnd);
        off(display.wrapper.ownerDocument, "mousemove", mouseMove);
        off(display.scroller, "dragstart", dragStart);
        off(display.scroller, "drop", dragEnd);
        if (!moved) {
          e_preventDefault(e);
          if (!behavior.addNew)
            { extendSelection(cm.doc, pos, null, null, behavior.extend); }
          // Work around unexplainable focus problem in IE9 (#2127) and Chrome (#3081)
          if (webkit || ie && ie_version == 9)
            { setTimeout(function () {display.wrapper.ownerDocument.body.focus(); display.input.focus();}, 20); }
          else
            { display.input.focus(); }
        }
      });
      var mouseMove = function(e2) {
        moved = moved || Math.abs(event.clientX - e2.clientX) + Math.abs(event.clientY - e2.clientY) >= 10;
      };
      var dragStart = function () { return moved = true; };
      // Let the drag handler handle this.
      if (webkit) { display.scroller.draggable = true; }
      cm.state.draggingText = dragEnd;
      dragEnd.copy = !behavior.moveOnDrag;
      // IE's approach to draggable
      if (display.scroller.dragDrop) { display.scroller.dragDrop(); }
      on(display.wrapper.ownerDocument, "mouseup", dragEnd);
      on(display.wrapper.ownerDocument, "mousemove", mouseMove);
      on(display.scroller, "dragstart", dragStart);
      on(display.scroller, "drop", dragEnd);
  
      delayBlurEvent(cm);
      setTimeout(function () { return display.input.focus(); }, 20);
    }
  
    function rangeForUnit(cm, pos, unit) {
      if (unit == "char") { return new Range(pos, pos) }
      if (unit == "word") { return cm.findWordAt(pos) }
      if (unit == "line") { return new Range(Pos(pos.line, 0), clipPos(cm.doc, Pos(pos.line + 1, 0))) }
      var result = unit(cm, pos);
      return new Range(result.from, result.to)
    }
  
    // Normal selection, as opposed to text dragging.
    function leftButtonSelect(cm, event, start, behavior) {
      var display = cm.display, doc = cm.doc;
      e_preventDefault(event);
  
      var ourRange, ourIndex, startSel = doc.sel, ranges = startSel.ranges;
      if (behavior.addNew && !behavior.extend) {
        ourIndex = doc.sel.contains(start);
        if (ourIndex > -1)
          { ourRange = ranges[ourIndex]; }
        else
          { ourRange = new Range(start, start); }
      } else {
        ourRange = doc.sel.primary();
        ourIndex = doc.sel.primIndex;
      }
  
      if (behavior.unit == "rectangle") {
        if (!behavior.addNew) { ourRange = new Range(start, start); }
        start = posFromMouse(cm, event, true, true);
        ourIndex = -1;
      } else {
        var range$$1 = rangeForUnit(cm, start, behavior.unit);
        if (behavior.extend)
          { ourRange = extendRange(ourRange, range$$1.anchor, range$$1.head, behavior.extend); }
        else
          { ourRange = range$$1; }
      }
  
      if (!behavior.addNew) {
        ourIndex = 0;
        setSelection(doc, new Selection([ourRange], 0), sel_mouse);
        startSel = doc.sel;
      } else if (ourIndex == -1) {
        ourIndex = ranges.length;
        setSelection(doc, normalizeSelection(cm, ranges.concat([ourRange]), ourIndex),
                     {scroll: false, origin: "*mouse"});
      } else if (ranges.length > 1 && ranges[ourIndex].empty() && behavior.unit == "char" && !behavior.extend) {
        setSelection(doc, normalizeSelection(cm, ranges.slice(0, ourIndex).concat(ranges.slice(ourIndex + 1)), 0),
                     {scroll: false, origin: "*mouse"});
        startSel = doc.sel;
      } else {
        replaceOneSelection(doc, ourIndex, ourRange, sel_mouse);
      }
  
      var lastPos = start;
      function extendTo(pos) {
        if (cmp(lastPos, pos) == 0) { return }
        lastPos = pos;
  
        if (behavior.unit == "rectangle") {
          var ranges = [], tabSize = cm.options.tabSize;
          var startCol = countColumn(getLine(doc, start.line).text, start.ch, tabSize);
          var posCol = countColumn(getLine(doc, pos.line).text, pos.ch, tabSize);
          var left = Math.min(startCol, posCol), right = Math.max(startCol, posCol);
          for (var line = Math.min(start.line, pos.line), end = Math.min(cm.lastLine(), Math.max(start.line, pos.line));
               line <= end; line++) {
            var text = getLine(doc, line).text, leftPos = findColumn(text, left, tabSize);
            if (left == right)
              { ranges.push(new Range(Pos(line, leftPos), Pos(line, leftPos))); }
            else if (text.length > leftPos)
              { ranges.push(new Range(Pos(line, leftPos), Pos(line, findColumn(text, right, tabSize)))); }
          }
          if (!ranges.length) { ranges.push(new Range(start, start)); }
          setSelection(doc, normalizeSelection(cm, startSel.ranges.slice(0, ourIndex).concat(ranges), ourIndex),
                       {origin: "*mouse", scroll: false});
          cm.scrollIntoView(pos);
        } else {
          var oldRange = ourRange;
          var range$$1 = rangeForUnit(cm, pos, behavior.unit);
          var anchor = oldRange.anchor, head;
          if (cmp(range$$1.anchor, anchor) > 0) {
            head = range$$1.head;
            anchor = minPos(oldRange.from(), range$$1.anchor);
          } else {
            head = range$$1.anchor;
            anchor = maxPos(oldRange.to(), range$$1.head);
          }
          var ranges$1 = startSel.ranges.slice(0);
          ranges$1[ourIndex] = bidiSimplify(cm, new Range(clipPos(doc, anchor), head));
          setSelection(doc, normalizeSelection(cm, ranges$1, ourIndex), sel_mouse);
        }
      }
  
      var editorSize = display.wrapper.getBoundingClientRect();
      // Used to ensure timeout re-tries don't fire when another extend
      // happened in the meantime (clearTimeout isn't reliable -- at
      // least on Chrome, the timeouts still happen even when cleared,
      // if the clear happens after their scheduled firing time).
      var counter = 0;
  
      function extend(e) {
        var curCount = ++counter;
        var cur = posFromMouse(cm, e, true, behavior.unit == "rectangle");
        if (!cur) { return }
        if (cmp(cur, lastPos) != 0) {
          cm.curOp.focus = activeElt();
          extendTo(cur);
          var visible = visibleLines(display, doc);
          if (cur.line >= visible.to || cur.line < visible.from)
            { setTimeout(operation(cm, function () {if (counter == curCount) { extend(e); }}), 150); }
        } else {
          var outside = e.clientY < editorSize.top ? -20 : e.clientY > editorSize.bottom ? 20 : 0;
          if (outside) { setTimeout(operation(cm, function () {
            if (counter != curCount) { return }
            display.scroller.scrollTop += outside;
            extend(e);
          }), 50); }
        }
      }
  
      function done(e) {
        cm.state.selectingText = false;
        counter = Infinity;
        // If e is null or undefined we interpret this as someone trying
        // to explicitly cancel the selection rather than the user
        // letting go of the mouse button.
        if (e) {
          e_preventDefault(e);
          display.input.focus();
        }
        off(display.wrapper.ownerDocument, "mousemove", move);
        off(display.wrapper.ownerDocument, "mouseup", up);
        doc.history.lastSelOrigin = null;
      }
  
      var move = operation(cm, function (e) {
        if (e.buttons === 0 || !e_button(e)) { done(e); }
        else { extend(e); }
      });
      var up = operation(cm, done);
      cm.state.selectingText = up;
      on(display.wrapper.ownerDocument, "mousemove", move);
      on(display.wrapper.ownerDocument, "mouseup", up);
    }
  
    // Used when mouse-selecting to adjust the anchor to the proper side
    // of a bidi jump depending on the visual position of the head.
    function bidiSimplify(cm, range$$1) {
      var anchor = range$$1.anchor;
      var head = range$$1.head;
      var anchorLine = getLine(cm.doc, anchor.line);
      if (cmp(anchor, head) == 0 && anchor.sticky == head.sticky) { return range$$1 }
      var order = getOrder(anchorLine);
      if (!order) { return range$$1 }
      var index = getBidiPartAt(order, anchor.ch, anchor.sticky), part = order[index];
      if (part.from != anchor.ch && part.to != anchor.ch) { return range$$1 }
      var boundary = index + ((part.from == anchor.ch) == (part.level != 1) ? 0 : 1);
      if (boundary == 0 || boundary == order.length) { return range$$1 }
  
      // Compute the relative visual position of the head compared to the
      // anchor (<0 is to the left, >0 to the right)
      var leftSide;
      if (head.line != anchor.line) {
        leftSide = (head.line - anchor.line) * (cm.doc.direction == "ltr" ? 1 : -1) > 0;
      } else {
        var headIndex = getBidiPartAt(order, head.ch, head.sticky);
        var dir = headIndex - index || (head.ch - anchor.ch) * (part.level == 1 ? -1 : 1);
        if (headIndex == boundary - 1 || headIndex == boundary)
          { leftSide = dir < 0; }
        else
          { leftSide = dir > 0; }
      }
  
      var usePart = order[boundary + (leftSide ? -1 : 0)];
      var from = leftSide == (usePart.level == 1);
      var ch = from ? usePart.from : usePart.to, sticky = from ? "after" : "before";
      return anchor.ch == ch && anchor.sticky == sticky ? range$$1 : new Range(new Pos(anchor.line, ch, sticky), head)
    }
  
  
    // Determines whether an event happened in the gutter, and fires the
    // handlers for the corresponding event.
    function gutterEvent(cm, e, type, prevent) {
      var mX, mY;
      if (e.touches) {
        mX = e.touches[0].clientX;
        mY = e.touches[0].clientY;
      } else {
        try { mX = e.clientX; mY = e.clientY; }
        catch(e) { return false }
      }
      if (mX >= Math.floor(cm.display.gutters.getBoundingClientRect().right)) { return false }
      if (prevent) { e_preventDefault(e); }
  
      var display = cm.display;
      var lineBox = display.lineDiv.getBoundingClientRect();
  
      if (mY > lineBox.bottom || !hasHandler(cm, type)) { return e_defaultPrevented(e) }
      mY -= lineBox.top - display.viewOffset;
  
      for (var i = 0; i < cm.display.gutterSpecs.length; ++i) {
        var g = display.gutters.childNodes[i];
        if (g && g.getBoundingClientRect().right >= mX) {
          var line = lineAtHeight(cm.doc, mY);
          var gutter = cm.display.gutterSpecs[i];
          signal(cm, type, cm, line, gutter.className, e);
          return e_defaultPrevented(e)
        }
      }
    }
  
    function clickInGutter(cm, e) {
      return gutterEvent(cm, e, "gutterClick", true)
    }
  
    // CONTEXT MENU HANDLING
  
    // To make the context menu work, we need to briefly unhide the
    // textarea (making it as unobtrusive as possible) to let the
    // right-click take effect on it.
    function onContextMenu(cm, e) {
      if (eventInWidget(cm.display, e) || contextMenuInGutter(cm, e)) { return }
      if (signalDOMEvent(cm, e, "contextmenu")) { return }
      if (!captureRightClick) { cm.display.input.onContextMenu(e); }
    }
  
    function contextMenuInGutter(cm, e) {
      if (!hasHandler(cm, "gutterContextMenu")) { return false }
      return gutterEvent(cm, e, "gutterContextMenu", false)
    }
  
    function themeChanged(cm) {
      cm.display.wrapper.className = cm.display.wrapper.className.replace(/\s*cm-s-\S+/g, "") +
        cm.options.theme.replace(/(^|\s)\s*/g, " cm-s-");
      clearCaches(cm);
    }
  
    var Init = {toString: function(){return "CodeMirror.Init"}};
  
    var defaults = {};
    var optionHandlers = {};
  
    function defineOptions(CodeMirror) {
      var optionHandlers = CodeMirror.optionHandlers;
  
      function option(name, deflt, handle, notOnInit) {
        CodeMirror.defaults[name] = deflt;
        if (handle) { optionHandlers[name] =
          notOnInit ? function (cm, val, old) {if (old != Init) { handle(cm, val, old); }} : handle; }
      }
  
      CodeMirror.defineOption = option;
  
      // Passed to option handlers when there is no old value.
      CodeMirror.Init = Init;
  
      // These two are, on init, called from the constructor because they
      // have to be initialized before the editor can start at all.
      option("value", "", function (cm, val) { return cm.setValue(val); }, true);
      option("mode", null, function (cm, val) {
        cm.doc.modeOption = val;
        loadMode(cm);
      }, true);
  
      option("indentUnit", 2, loadMode, true);
      option("indentWithTabs", false);
      option("smartIndent", true);
      option("tabSize", 4, function (cm) {
        resetModeState(cm);
        clearCaches(cm);
        regChange(cm);
      }, true);
  
      option("lineSeparator", null, function (cm, val) {
        cm.doc.lineSep = val;
        if (!val) { return }
        var newBreaks = [], lineNo = cm.doc.first;
        cm.doc.iter(function (line) {
          for (var pos = 0;;) {
            var found = line.text.indexOf(val, pos);
            if (found == -1) { break }
            pos = found + val.length;
            newBreaks.push(Pos(lineNo, found));
          }
          lineNo++;
        });
        for (var i = newBreaks.length - 1; i >= 0; i--)
          { replaceRange(cm.doc, val, newBreaks[i], Pos(newBreaks[i].line, newBreaks[i].ch + val.length)); }
      });
      option("specialChars", /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff\ufff9-\ufffc]/g, function (cm, val, old) {
        cm.state.specialChars = new RegExp(val.source + (val.test("\t") ? "" : "|\t"), "g");
        if (old != Init) { cm.refresh(); }
      });
      option("specialCharPlaceholder", defaultSpecialCharPlaceholder, function (cm) { return cm.refresh(); }, true);
      option("electricChars", true);
      option("inputStyle", mobile ? "contenteditable" : "textarea", function () {
        throw new Error("inputStyle can not (yet) be changed in a running editor") // FIXME
      }, true);
      option("spellcheck", false, function (cm, val) { return cm.getInputField().spellcheck = val; }, true);
      option("autocorrect", false, function (cm, val) { return cm.getInputField().autocorrect = val; }, true);
      option("autocapitalize", false, function (cm, val) { return cm.getInputField().autocapitalize = val; }, true);
      option("rtlMoveVisually", !windows);
      option("wholeLineUpdateBefore", true);
  
      option("theme", "default", function (cm) {
        themeChanged(cm);
        updateGutters(cm);
      }, true);
      option("keyMap", "default", function (cm, val, old) {
        var next = getKeyMap(val);
        var prev = old != Init && getKeyMap(old);
        if (prev && prev.detach) { prev.detach(cm, next); }
        if (next.attach) { next.attach(cm, prev || null); }
      });
      option("extraKeys", null);
      option("configureMouse", null);
  
      option("lineWrapping", false, wrappingChanged, true);
      option("gutters", [], function (cm, val) {
        cm.display.gutterSpecs = getGutters(val, cm.options.lineNumbers);
        updateGutters(cm);
      }, true);
      option("fixedGutter", true, function (cm, val) {
        cm.display.gutters.style.left = val ? compensateForHScroll(cm.display) + "px" : "0";
        cm.refresh();
      }, true);
      option("coverGutterNextToScrollbar", false, function (cm) { return updateScrollbars(cm); }, true);
      option("scrollbarStyle", "native", function (cm) {
        initScrollbars(cm);
        updateScrollbars(cm);
        cm.display.scrollbars.setScrollTop(cm.doc.scrollTop);
        cm.display.scrollbars.setScrollLeft(cm.doc.scrollLeft);
      }, true);
      option("lineNumbers", false, function (cm, val) {
        cm.display.gutterSpecs = getGutters(cm.options.gutters, val);
        updateGutters(cm);
      }, true);
      option("firstLineNumber", 1, updateGutters, true);
      option("lineNumberFormatter", function (integer) { return integer; }, updateGutters, true);
      option("showCursorWhenSelecting", false, updateSelection, true);
  
      option("resetSelectionOnContextMenu", true);
      option("lineWiseCopyCut", true);
      option("pasteLinesPerSelection", true);
      option("selectionsMayTouch", false);
  
      option("readOnly", false, function (cm, val) {
        if (val == "nocursor") {
          onBlur(cm);
          cm.display.input.blur();
        }
        cm.display.input.readOnlyChanged(val);
      });
  
      option("screenReaderLabel", null, function (cm, val) {
        val = (val === '') ? null : val;
        cm.display.input.screenReaderLabelChanged(val);
      });
  
      option("disableInput", false, function (cm, val) {if (!val) { cm.display.input.reset(); }}, true);
      option("dragDrop", true, dragDropChanged);
      option("allowDropFileTypes", null);
  
      option("cursorBlinkRate", 530);
      option("cursorScrollMargin", 0);
      option("cursorHeight", 1, updateSelection, true);
      option("singleCursorHeightPerLine", true, updateSelection, true);
      option("workTime", 100);
      option("workDelay", 100);
      option("flattenSpans", true, resetModeState, true);
      option("addModeClass", false, resetModeState, true);
      option("pollInterval", 100);
      option("undoDepth", 200, function (cm, val) { return cm.doc.history.undoDepth = val; });
      option("historyEventDelay", 1250);
      option("viewportMargin", 10, function (cm) { return cm.refresh(); }, true);
      option("maxHighlightLength", 10000, resetModeState, true);
      option("moveInputWithCursor", true, function (cm, val) {
        if (!val) { cm.display.input.resetPosition(); }
      });
  
      option("tabindex", null, function (cm, val) { return cm.display.input.getField().tabIndex = val || ""; });
      option("autofocus", null);
      option("direction", "ltr", function (cm, val) { return cm.doc.setDirection(val); }, true);
      option("phrases", null);
    }
  
    function dragDropChanged(cm, value, old) {
      var wasOn = old && old != Init;
      if (!value != !wasOn) {
        var funcs = cm.display.dragFunctions;
        var toggle = value ? on : off;
        toggle(cm.display.scroller, "dragstart", funcs.start);
        toggle(cm.display.scroller, "dragenter", funcs.enter);
        toggle(cm.display.scroller, "dragover", funcs.over);
        toggle(cm.display.scroller, "dragleave", funcs.leave);
        toggle(cm.display.scroller, "drop", funcs.drop);
      }
    }
  
    function wrappingChanged(cm) {
      if (cm.options.lineWrapping) {
        addClass(cm.display.wrapper, "CodeMirror-wrap");
        cm.display.sizer.style.minWidth = "";
        cm.display.sizerWidth = null;
      } else {
        rmClass(cm.display.wrapper, "CodeMirror-wrap");
        findMaxLine(cm);
      }
      estimateLineHeights(cm);
      regChange(cm);
      clearCaches(cm);
      setTimeout(function () { return updateScrollbars(cm); }, 100);
    }
  
    // A CodeMirror instance represents an editor. This is the object
    // that user code is usually dealing with.
  
    function CodeMirror(place, options) {
      var this$1 = this;
  
      if (!(this instanceof CodeMirror)) { return new CodeMirror(place, options) }
  
      this.options = options = options ? copyObj(options) : {};
      // Determine effective options based on given values and defaults.
      copyObj(defaults, options, false);
  
      var doc = options.value;
      if (typeof doc == "string") { doc = new Doc(doc, options.mode, null, options.lineSeparator, options.direction); }
      else if (options.mode) { doc.modeOption = options.mode; }
      this.doc = doc;
  
      var input = new CodeMirror.inputStyles[options.inputStyle](this);
      var display = this.display = new Display(place, doc, input, options);
      display.wrapper.CodeMirror = this;
      themeChanged(this);
      if (options.lineWrapping)
        { this.display.wrapper.className += " CodeMirror-wrap"; }
      initScrollbars(this);
  
      this.state = {
        keyMaps: [],  // stores maps added by addKeyMap
        overlays: [], // highlighting overlays, as added by addOverlay
        modeGen: 0,   // bumped when mode/overlay changes, used to invalidate highlighting info
        overwrite: false,
        delayingBlurEvent: false,
        focused: false,
        suppressEdits: false, // used to disable editing during key handlers when in readOnly mode
        pasteIncoming: -1, cutIncoming: -1, // help recognize paste/cut edits in input.poll
        selectingText: false,
        draggingText: false,
        highlight: new Delayed(), // stores highlight worker timeout
        keySeq: null,  // Unfinished key sequence
        specialChars: null
      };
  
      if (options.autofocus && !mobile) { display.input.focus(); }
  
      // Override magic textarea content restore that IE sometimes does
      // on our hidden textarea on reload
      if (ie && ie_version < 11) { setTimeout(function () { return this$1.display.input.reset(true); }, 20); }
  
      registerEventHandlers(this);
      ensureGlobalHandlers();
  
      startOperation(this);
      this.curOp.forceUpdate = true;
      attachDoc(this, doc);
  
      if ((options.autofocus && !mobile) || this.hasFocus())
        { setTimeout(bind(onFocus, this), 20); }
      else
        { onBlur(this); }
  
      for (var opt in optionHandlers) { if (optionHandlers.hasOwnProperty(opt))
        { optionHandlers[opt](this$1, options[opt], Init); } }
      maybeUpdateLineNumberWidth(this);
      if (options.finishInit) { options.finishInit(this); }
      for (var i = 0; i < initHooks.length; ++i) { initHooks[i](this$1); }
      endOperation(this);
      // Suppress optimizelegibility in Webkit, since it breaks text
      // measuring on line wrapping boundaries.
      if (webkit && options.lineWrapping &&
          getComputedStyle(display.lineDiv).textRendering == "optimizelegibility")
        { display.lineDiv.style.textRendering = "auto"; }
    }
  
    // The default configuration options.
    CodeMirror.defaults = defaults;
    // Functions to run when options are changed.
    CodeMirror.optionHandlers = optionHandlers;
  
    // Attach the necessary event handlers when initializing the editor
    function registerEventHandlers(cm) {
      var d = cm.display;
      on(d.scroller, "mousedown", operation(cm, onMouseDown));
      // Older IE's will not fire a second mousedown for a double click
      if (ie && ie_version < 11)
        { on(d.scroller, "dblclick", operation(cm, function (e) {
          if (signalDOMEvent(cm, e)) { return }
          var pos = posFromMouse(cm, e);
          if (!pos || clickInGutter(cm, e) || eventInWidget(cm.display, e)) { return }
          e_preventDefault(e);
          var word = cm.findWordAt(pos);
          extendSelection(cm.doc, word.anchor, word.head);
        })); }
      else
        { on(d.scroller, "dblclick", function (e) { return signalDOMEvent(cm, e) || e_preventDefault(e); }); }
      // Some browsers fire contextmenu *after* opening the menu, at
      // which point we can't mess with it anymore. Context menu is
      // handled in onMouseDown for these browsers.
      on(d.scroller, "contextmenu", function (e) { return onContextMenu(cm, e); });
      on(d.input.getField(), "contextmenu", function (e) {
        if (!d.scroller.contains(e.target)) { onContextMenu(cm, e); }
      });
  
      // Used to suppress mouse event handling when a touch happens
      var touchFinished, prevTouch = {end: 0};
      function finishTouch() {
        if (d.activeTouch) {
          touchFinished = setTimeout(function () { return d.activeTouch = null; }, 1000);
          prevTouch = d.activeTouch;
          prevTouch.end = +new Date;
        }
      }
      function isMouseLikeTouchEvent(e) {
        if (e.touches.length != 1) { return false }
        var touch = e.touches[0];
        return touch.radiusX <= 1 && touch.radiusY <= 1
      }
      function farAway(touch, other) {
        if (other.left == null) { return true }
        var dx = other.left - touch.left, dy = other.top - touch.top;
        return dx * dx + dy * dy > 20 * 20
      }
      on(d.scroller, "touchstart", function (e) {
        if (!signalDOMEvent(cm, e) && !isMouseLikeTouchEvent(e) && !clickInGutter(cm, e)) {
          d.input.ensurePolled();
          clearTimeout(touchFinished);
          var now = +new Date;
          d.activeTouch = {start: now, moved: false,
                           prev: now - prevTouch.end <= 300 ? prevTouch : null};
          if (e.touches.length == 1) {
            d.activeTouch.left = e.touches[0].pageX;
            d.activeTouch.top = e.touches[0].pageY;
          }
        }
      });
      on(d.scroller, "touchmove", function () {
        if (d.activeTouch) { d.activeTouch.moved = true; }
      });
      on(d.scroller, "touchend", function (e) {
        var touch = d.activeTouch;
        if (touch && !eventInWidget(d, e) && touch.left != null &&
            !touch.moved && new Date - touch.start < 300) {
          var pos = cm.coordsChar(d.activeTouch, "page"), range;
          if (!touch.prev || farAway(touch, touch.prev)) // Single tap
            { range = new Range(pos, pos); }
          else if (!touch.prev.prev || farAway(touch, touch.prev.prev)) // Double tap
            { range = cm.findWordAt(pos); }
          else // Triple tap
            { range = new Range(Pos(pos.line, 0), clipPos(cm.doc, Pos(pos.line + 1, 0))); }
          cm.setSelection(range.anchor, range.head);
          cm.focus();
          e_preventDefault(e);
        }
        finishTouch();
      });
      on(d.scroller, "touchcancel", finishTouch);
  
      // Sync scrolling between fake scrollbars and real scrollable
      // area, ensure viewport is updated when scrolling.
      on(d.scroller, "scroll", function () {
        if (d.scroller.clientHeight) {
          updateScrollTop(cm, d.scroller.scrollTop);
          setScrollLeft(cm, d.scroller.scrollLeft, true);
          signal(cm, "scroll", cm);
        }
      });
  
      // Listen to wheel events in order to try and update the viewport on time.
      on(d.scroller, "mousewheel", function (e) { return onScrollWheel(cm, e); });
      on(d.scroller, "DOMMouseScroll", function (e) { return onScrollWheel(cm, e); });
  
      // Prevent wrapper from ever scrolling
      on(d.wrapper, "scroll", function () { return d.wrapper.scrollTop = d.wrapper.scrollLeft = 0; });
  
      d.dragFunctions = {
        enter: function (e) {if (!signalDOMEvent(cm, e)) { e_stop(e); }},
        over: function (e) {if (!signalDOMEvent(cm, e)) { onDragOver(cm, e); e_stop(e); }},
        start: function (e) { return onDragStart(cm, e); },
        drop: operation(cm, onDrop),
        leave: function (e) {if (!signalDOMEvent(cm, e)) { clearDragCursor(cm); }}
      };
  
      var inp = d.input.getField();
      on(inp, "keyup", function (e) { return onKeyUp.call(cm, e); });
      on(inp, "keydown", operation(cm, onKeyDown));
      on(inp, "keypress", operation(cm, onKeyPress));
      on(inp, "focus", function (e) { return onFocus(cm, e); });
      on(inp, "blur", function (e) { return onBlur(cm, e); });
    }
  
    var initHooks = [];
    CodeMirror.defineInitHook = function (f) { return initHooks.push(f); };
  
    // Indent the given line. The how parameter can be "smart",
    // "add"/null, "subtract", or "prev". When aggressive is false
    // (typically set to true for forced single-line indents), empty
    // lines are not indented, and places where the mode returns Pass
    // are left alone.
    function indentLine(cm, n, how, aggressive) {
      var doc = cm.doc, state;
      if (how == null) { how = "add"; }
      if (how == "smart") {
        // Fall back to "prev" when the mode doesn't have an indentation
        // method.
        if (!doc.mode.indent) { how = "prev"; }
        else { state = getContextBefore(cm, n).state; }
      }
  
      var tabSize = cm.options.tabSize;
      var line = getLine(doc, n), curSpace = countColumn(line.text, null, tabSize);
      if (line.stateAfter) { line.stateAfter = null; }
      var curSpaceString = line.text.match(/^\s*/)[0], indentation;
      if (!aggressive && !/\S/.test(line.text)) {
        indentation = 0;
        how = "not";
      } else if (how == "smart") {
        indentation = doc.mode.indent(state, line.text.slice(curSpaceString.length), line.text);
        if (indentation == Pass || indentation > 150) {
          if (!aggressive) { return }
          how = "prev";
        }
      }
      if (how == "prev") {
        if (n > doc.first) { indentation = countColumn(getLine(doc, n-1).text, null, tabSize); }
        else { indentation = 0; }
      } else if (how == "add") {
        indentation = curSpace + cm.options.indentUnit;
      } else if (how == "subtract") {
        indentation = curSpace - cm.options.indentUnit;
      } else if (typeof how == "number") {
        indentation = curSpace + how;
      }
      indentation = Math.max(0, indentation);
  
      var indentString = "", pos = 0;
      if (cm.options.indentWithTabs)
        { for (var i = Math.floor(indentation / tabSize); i; --i) {pos += tabSize; indentString += "\t";} }
      if (pos < indentation) { indentString += spaceStr(indentation - pos); }
  
      if (indentString != curSpaceString) {
        replaceRange(doc, indentString, Pos(n, 0), Pos(n, curSpaceString.length), "+input");
        line.stateAfter = null;
        return true
      } else {
        // Ensure that, if the cursor was in the whitespace at the start
        // of the line, it is moved to the end of that space.
        for (var i$1 = 0; i$1 < doc.sel.ranges.length; i$1++) {
          var range = doc.sel.ranges[i$1];
          if (range.head.line == n && range.head.ch < curSpaceString.length) {
            var pos$1 = Pos(n, curSpaceString.length);
            replaceOneSelection(doc, i$1, new Range(pos$1, pos$1));
            break
          }
        }
      }
    }
  
    // This will be set to a {lineWise: bool, text: [string]} object, so
    // that, when pasting, we know what kind of selections the copied
    // text was made out of.
    var lastCopied = null;
  
    function setLastCopied(newLastCopied) {
      lastCopied = newLastCopied;
    }
  
    function applyTextInput(cm, inserted, deleted, sel, origin) {
      var doc = cm.doc;
      cm.display.shift = false;
      if (!sel) { sel = doc.sel; }
  
      var recent = +new Date - 200;
      var paste = origin == "paste" || cm.state.pasteIncoming > recent;
      var textLines = splitLinesAuto(inserted), multiPaste = null;
      // When pasting N lines into N selections, insert one line per selection
      if (paste && sel.ranges.length > 1) {
        if (lastCopied && lastCopied.text.join("\n") == inserted) {
          if (sel.ranges.length % lastCopied.text.length == 0) {
            multiPaste = [];
            for (var i = 0; i < lastCopied.text.length; i++)
              { multiPaste.push(doc.splitLines(lastCopied.text[i])); }
          }
        } else if (textLines.length == sel.ranges.length && cm.options.pasteLinesPerSelection) {
          multiPaste = map(textLines, function (l) { return [l]; });
        }
      }
  
      var updateInput = cm.curOp.updateInput;
      // Normal behavior is to insert the new text into every selection
      for (var i$1 = sel.ranges.length - 1; i$1 >= 0; i$1--) {
        var range$$1 = sel.ranges[i$1];
        var from = range$$1.from(), to = range$$1.to();
        if (range$$1.empty()) {
          if (deleted && deleted > 0) // Handle deletion
            { from = Pos(from.line, from.ch - deleted); }
          else if (cm.state.overwrite && !paste) // Handle overwrite
            { to = Pos(to.line, Math.min(getLine(doc, to.line).text.length, to.ch + lst(textLines).length)); }
          else if (paste && lastCopied && lastCopied.lineWise && lastCopied.text.join("\n") == inserted)
            { from = to = Pos(from.line, 0); }
        }
        var changeEvent = {from: from, to: to, text: multiPaste ? multiPaste[i$1 % multiPaste.length] : textLines,
                           origin: origin || (paste ? "paste" : cm.state.cutIncoming > recent ? "cut" : "+input")};
        makeChange(cm.doc, changeEvent);
        signalLater(cm, "inputRead", cm, changeEvent);
      }
      if (inserted && !paste)
        { triggerElectric(cm, inserted); }
  
      ensureCursorVisible(cm);
      if (cm.curOp.updateInput < 2) { cm.curOp.updateInput = updateInput; }
      cm.curOp.typing = true;
      cm.state.pasteIncoming = cm.state.cutIncoming = -1;
    }
  
    function handlePaste(e, cm) {
      var pasted = e.clipboardData && e.clipboardData.getData("Text");
      if (pasted) {
        e.preventDefault();
        if (!cm.isReadOnly() && !cm.options.disableInput)
          { runInOp(cm, function () { return applyTextInput(cm, pasted, 0, null, "paste"); }); }
        return true
      }
    }
  
    function triggerElectric(cm, inserted) {
      // When an 'electric' character is inserted, immediately trigger a reindent
      if (!cm.options.electricChars || !cm.options.smartIndent) { return }
      var sel = cm.doc.sel;
  
      for (var i = sel.ranges.length - 1; i >= 0; i--) {
        var range$$1 = sel.ranges[i];
        if (range$$1.head.ch > 100 || (i && sel.ranges[i - 1].head.line == range$$1.head.line)) { continue }
        var mode = cm.getModeAt(range$$1.head);
        var indented = false;
        if (mode.electricChars) {
          for (var j = 0; j < mode.electricChars.length; j++)
            { if (inserted.indexOf(mode.electricChars.charAt(j)) > -1) {
              indented = indentLine(cm, range$$1.head.line, "smart");
              break
            } }
        } else if (mode.electricInput) {
          if (mode.electricInput.test(getLine(cm.doc, range$$1.head.line).text.slice(0, range$$1.head.ch)))
            { indented = indentLine(cm, range$$1.head.line, "smart"); }
        }
        if (indented) { signalLater(cm, "electricInput", cm, range$$1.head.line); }
      }
    }
  
    function copyableRanges(cm) {
      var text = [], ranges = [];
      for (var i = 0; i < cm.doc.sel.ranges.length; i++) {
        var line = cm.doc.sel.ranges[i].head.line;
        var lineRange = {anchor: Pos(line, 0), head: Pos(line + 1, 0)};
        ranges.push(lineRange);
        text.push(cm.getRange(lineRange.anchor, lineRange.head));
      }
      return {text: text, ranges: ranges}
    }
  
    function disableBrowserMagic(field, spellcheck, autocorrect, autocapitalize) {
      field.setAttribute("autocorrect", autocorrect ? "" : "off");
      field.setAttribute("autocapitalize", autocapitalize ? "" : "off");
      field.setAttribute("spellcheck", !!spellcheck);
    }
  
    function hiddenTextarea() {
      var te = elt("textarea", null, null, "position: absolute; bottom: -1em; padding: 0; width: 1px; height: 1em; outline: none");
      var div = elt("div", [te], null, "overflow: hidden; position: relative; width: 3px; height: 0px;");
      // The textarea is kept positioned near the cursor to prevent the
      // fact that it'll be scrolled into view on input from scrolling
      // our fake cursor out of view. On webkit, when wrap=off, paste is
      // very slow. So make the area wide instead.
      if (webkit) { te.style.width = "1000px"; }
      else { te.setAttribute("wrap", "off"); }
      // If border: 0; -- iOS fails to open keyboard (issue #1287)
      if (ios) { te.style.border = "1px solid black"; }
      disableBrowserMagic(te);
      return div
    }
  
    // The publicly visible API. Note that methodOp(f) means
    // 'wrap f in an operation, performed on its `this` parameter'.
  
    // This is not the complete set of editor methods. Most of the
    // methods defined on the Doc type are also injected into
    // CodeMirror.prototype, for backwards compatibility and
    // convenience.
  
    function addEditorMethods(CodeMirror) {
      var optionHandlers = CodeMirror.optionHandlers;
  
      var helpers = CodeMirror.helpers = {};
  
      CodeMirror.prototype = {
        constructor: CodeMirror,
        focus: function(){window.focus(); this.display.input.focus();},
  
        setOption: function(option, value) {
          var options = this.options, old = options[option];
          if (options[option] == value && option != "mode") { return }
          options[option] = value;
          if (optionHandlers.hasOwnProperty(option))
            { operation(this, optionHandlers[option])(this, value, old); }
          signal(this, "optionChange", this, option);
        },
  
        getOption: function(option) {return this.options[option]},
        getDoc: function() {return this.doc},
  
        addKeyMap: function(map$$1, bottom) {
          this.state.keyMaps[bottom ? "push" : "unshift"](getKeyMap(map$$1));
        },
        removeKeyMap: function(map$$1) {
          var maps = this.state.keyMaps;
          for (var i = 0; i < maps.length; ++i)
            { if (maps[i] == map$$1 || maps[i].name == map$$1) {
              maps.splice(i, 1);
              return true
            } }
        },
  
        addOverlay: methodOp(function(spec, options) {
          var mode = spec.token ? spec : CodeMirror.getMode(this.options, spec);
          if (mode.startState) { throw new Error("Overlays may not be stateful.") }
          insertSorted(this.state.overlays,
                       {mode: mode, modeSpec: spec, opaque: options && options.opaque,
                        priority: (options && options.priority) || 0},
                       function (overlay) { return overlay.priority; });
          this.state.modeGen++;
          regChange(this);
        }),
        removeOverlay: methodOp(function(spec) {
          var this$1 = this;
  
          var overlays = this.state.overlays;
          for (var i = 0; i < overlays.length; ++i) {
            var cur = overlays[i].modeSpec;
            if (cur == spec || typeof spec == "string" && cur.name == spec) {
              overlays.splice(i, 1);
              this$1.state.modeGen++;
              regChange(this$1);
              return
            }
          }
        }),
  
        indentLine: methodOp(function(n, dir, aggressive) {
          if (typeof dir != "string" && typeof dir != "number") {
            if (dir == null) { dir = this.options.smartIndent ? "smart" : "prev"; }
            else { dir = dir ? "add" : "subtract"; }
          }
          if (isLine(this.doc, n)) { indentLine(this, n, dir, aggressive); }
        }),
        indentSelection: methodOp(function(how) {
          var this$1 = this;
  
          var ranges = this.doc.sel.ranges, end = -1;
          for (var i = 0; i < ranges.length; i++) {
            var range$$1 = ranges[i];
            if (!range$$1.empty()) {
              var from = range$$1.from(), to = range$$1.to();
              var start = Math.max(end, from.line);
              end = Math.min(this$1.lastLine(), to.line - (to.ch ? 0 : 1)) + 1;
              for (var j = start; j < end; ++j)
                { indentLine(this$1, j, how); }
              var newRanges = this$1.doc.sel.ranges;
              if (from.ch == 0 && ranges.length == newRanges.length && newRanges[i].from().ch > 0)
                { replaceOneSelection(this$1.doc, i, new Range(from, newRanges[i].to()), sel_dontScroll); }
            } else if (range$$1.head.line > end) {
              indentLine(this$1, range$$1.head.line, how, true);
              end = range$$1.head.line;
              if (i == this$1.doc.sel.primIndex) { ensureCursorVisible(this$1); }
            }
          }
        }),
  
        // Fetch the parser token for a given character. Useful for hacks
        // that want to inspect the mode state (say, for completion).
        getTokenAt: function(pos, precise) {
          return takeToken(this, pos, precise)
        },
  
        getLineTokens: function(line, precise) {
          return takeToken(this, Pos(line), precise, true)
        },
  
        getTokenTypeAt: function(pos) {
          pos = clipPos(this.doc, pos);
          var styles = getLineStyles(this, getLine(this.doc, pos.line));
          var before = 0, after = (styles.length - 1) / 2, ch = pos.ch;
          var type;
          if (ch == 0) { type = styles[2]; }
          else { for (;;) {
            var mid = (before + after) >> 1;
            if ((mid ? styles[mid * 2 - 1] : 0) >= ch) { after = mid; }
            else if (styles[mid * 2 + 1] < ch) { before = mid + 1; }
            else { type = styles[mid * 2 + 2]; break }
          } }
          var cut = type ? type.indexOf("overlay ") : -1;
          return cut < 0 ? type : cut == 0 ? null : type.slice(0, cut - 1)
        },
  
        getModeAt: function(pos) {
          var mode = this.doc.mode;
          if (!mode.innerMode) { return mode }
          return CodeMirror.innerMode(mode, this.getTokenAt(pos).state).mode
        },
  
        getHelper: function(pos, type) {
          return this.getHelpers(pos, type)[0]
        },
  
        getHelpers: function(pos, type) {
          var this$1 = this;
  
          var found = [];
          if (!helpers.hasOwnProperty(type)) { return found }
          var help = helpers[type], mode = this.getModeAt(pos);
          if (typeof mode[type] == "string") {
            if (help[mode[type]]) { found.push(help[mode[type]]); }
          } else if (mode[type]) {
            for (var i = 0; i < mode[type].length; i++) {
              var val = help[mode[type][i]];
              if (val) { found.push(val); }
            }
          } else if (mode.helperType && help[mode.helperType]) {
            found.push(help[mode.helperType]);
          } else if (help[mode.name]) {
            found.push(help[mode.name]);
          }
          for (var i$1 = 0; i$1 < help._global.length; i$1++) {
            var cur = help._global[i$1];
            if (cur.pred(mode, this$1) && indexOf(found, cur.val) == -1)
              { found.push(cur.val); }
          }
          return found
        },
  
        getStateAfter: function(line, precise) {
          var doc = this.doc;
          line = clipLine(doc, line == null ? doc.first + doc.size - 1: line);
          return getContextBefore(this, line + 1, precise).state
        },
  
        cursorCoords: function(start, mode) {
          var pos, range$$1 = this.doc.sel.primary();
          if (start == null) { pos = range$$1.head; }
          else if (typeof start == "object") { pos = clipPos(this.doc, start); }
          else { pos = start ? range$$1.from() : range$$1.to(); }
          return cursorCoords(this, pos, mode || "page")
        },
  
        charCoords: function(pos, mode) {
          return charCoords(this, clipPos(this.doc, pos), mode || "page")
        },
  
        coordsChar: function(coords, mode) {
          coords = fromCoordSystem(this, coords, mode || "page");
          return coordsChar(this, coords.left, coords.top)
        },
  
        lineAtHeight: function(height, mode) {
          height = fromCoordSystem(this, {top: height, left: 0}, mode || "page").top;
          return lineAtHeight(this.doc, height + this.display.viewOffset)
        },
        heightAtLine: function(line, mode, includeWidgets) {
          var end = false, lineObj;
          if (typeof line == "number") {
            var last = this.doc.first + this.doc.size - 1;
            if (line < this.doc.first) { line = this.doc.first; }
            else if (line > last) { line = last; end = true; }
            lineObj = getLine(this.doc, line);
          } else {
            lineObj = line;
          }
          return intoCoordSystem(this, lineObj, {top: 0, left: 0}, mode || "page", includeWidgets || end).top +
            (end ? this.doc.height - heightAtLine(lineObj) : 0)
        },
  
        defaultTextHeight: function() { return textHeight(this.display) },
        defaultCharWidth: function() { return charWidth(this.display) },
  
        getViewport: function() { return {from: this.display.viewFrom, to: this.display.viewTo}},
  
        addWidget: function(pos, node, scroll, vert, horiz) {
          var display = this.display;
          pos = cursorCoords(this, clipPos(this.doc, pos));
          var top = pos.bottom, left = pos.left;
          node.style.position = "absolute";
          node.setAttribute("cm-ignore-events", "true");
          this.display.input.setUneditable(node);
          display.sizer.appendChild(node);
          if (vert == "over") {
            top = pos.top;
          } else if (vert == "above" || vert == "near") {
            var vspace = Math.max(display.wrapper.clientHeight, this.doc.height),
            hspace = Math.max(display.sizer.clientWidth, display.lineSpace.clientWidth);
            // Default to positioning above (if specified and possible); otherwise default to positioning below
            if ((vert == 'above' || pos.bottom + node.offsetHeight > vspace) && pos.top > node.offsetHeight)
              { top = pos.top - node.offsetHeight; }
            else if (pos.bottom + node.offsetHeight <= vspace)
              { top = pos.bottom; }
            if (left + node.offsetWidth > hspace)
              { left = hspace - node.offsetWidth; }
          }
          node.style.top = top + "px";
          node.style.left = node.style.right = "";
          if (horiz == "right") {
            left = display.sizer.clientWidth - node.offsetWidth;
            node.style.right = "0px";
          } else {
            if (horiz == "left") { left = 0; }
            else if (horiz == "middle") { left = (display.sizer.clientWidth - node.offsetWidth) / 2; }
            node.style.left = left + "px";
          }
          if (scroll)
            { scrollIntoView(this, {left: left, top: top, right: left + node.offsetWidth, bottom: top + node.offsetHeight}); }
        },
  
        triggerOnKeyDown: methodOp(onKeyDown),
        triggerOnKeyPress: methodOp(onKeyPress),
        triggerOnKeyUp: onKeyUp,
        triggerOnMouseDown: methodOp(onMouseDown),
  
        execCommand: function(cmd) {
          if (commands.hasOwnProperty(cmd))
            { return commands[cmd].call(null, this) }
        },
  
        triggerElectric: methodOp(function(text) { triggerElectric(this, text); }),
  
        findPosH: function(from, amount, unit, visually) {
          var this$1 = this;
  
          var dir = 1;
          if (amount < 0) { dir = -1; amount = -amount; }
          var cur = clipPos(this.doc, from);
          for (var i = 0; i < amount; ++i) {
            cur = findPosH(this$1.doc, cur, dir, unit, visually);
            if (cur.hitSide) { break }
          }
          return cur
        },
  
        moveH: methodOp(function(dir, unit) {
          var this$1 = this;
  
          this.extendSelectionsBy(function (range$$1) {
            if (this$1.display.shift || this$1.doc.extend || range$$1.empty())
              { return findPosH(this$1.doc, range$$1.head, dir, unit, this$1.options.rtlMoveVisually) }
            else
              { return dir < 0 ? range$$1.from() : range$$1.to() }
          }, sel_move);
        }),
  
        deleteH: methodOp(function(dir, unit) {
          var sel = this.doc.sel, doc = this.doc;
          if (sel.somethingSelected())
            { doc.replaceSelection("", null, "+delete"); }
          else
            { deleteNearSelection(this, function (range$$1) {
              var other = findPosH(doc, range$$1.head, dir, unit, false);
              return dir < 0 ? {from: other, to: range$$1.head} : {from: range$$1.head, to: other}
            }); }
        }),
  
        findPosV: function(from, amount, unit, goalColumn) {
          var this$1 = this;
  
          var dir = 1, x = goalColumn;
          if (amount < 0) { dir = -1; amount = -amount; }
          var cur = clipPos(this.doc, from);
          for (var i = 0; i < amount; ++i) {
            var coords = cursorCoords(this$1, cur, "div");
            if (x == null) { x = coords.left; }
            else { coords.left = x; }
            cur = findPosV(this$1, coords, dir, unit);
            if (cur.hitSide) { break }
          }
          return cur
        },
  
        moveV: methodOp(function(dir, unit) {
          var this$1 = this;
  
          var doc = this.doc, goals = [];
          var collapse = !this.display.shift && !doc.extend && doc.sel.somethingSelected();
          doc.extendSelectionsBy(function (range$$1) {
            if (collapse)
              { return dir < 0 ? range$$1.from() : range$$1.to() }
            var headPos = cursorCoords(this$1, range$$1.head, "div");
            if (range$$1.goalColumn != null) { headPos.left = range$$1.goalColumn; }
            goals.push(headPos.left);
            var pos = findPosV(this$1, headPos, dir, unit);
            if (unit == "page" && range$$1 == doc.sel.primary())
              { addToScrollTop(this$1, charCoords(this$1, pos, "div").top - headPos.top); }
            return pos
          }, sel_move);
          if (goals.length) { for (var i = 0; i < doc.sel.ranges.length; i++)
            { doc.sel.ranges[i].goalColumn = goals[i]; } }
        }),
  
        // Find the word at the given position (as returned by coordsChar).
        findWordAt: function(pos) {
          var doc = this.doc, line = getLine(doc, pos.line).text;
          var start = pos.ch, end = pos.ch;
          if (line) {
            var helper = this.getHelper(pos, "wordChars");
            if ((pos.sticky == "before" || end == line.length) && start) { --start; } else { ++end; }
            var startChar = line.charAt(start);
            var check = isWordChar(startChar, helper)
              ? function (ch) { return isWordChar(ch, helper); }
              : /\s/.test(startChar) ? function (ch) { return /\s/.test(ch); }
              : function (ch) { return (!/\s/.test(ch) && !isWordChar(ch)); };
            while (start > 0 && check(line.charAt(start - 1))) { --start; }
            while (end < line.length && check(line.charAt(end))) { ++end; }
          }
          return new Range(Pos(pos.line, start), Pos(pos.line, end))
        },
  
        toggleOverwrite: function(value) {
          if (value != null && value == this.state.overwrite) { return }
          if (this.state.overwrite = !this.state.overwrite)
            { addClass(this.display.cursorDiv, "CodeMirror-overwrite"); }
          else
            { rmClass(this.display.cursorDiv, "CodeMirror-overwrite"); }
  
          signal(this, "overwriteToggle", this, this.state.overwrite);
        },
        hasFocus: function() { return this.display.input.getField() == activeElt() },
        isReadOnly: function() { return !!(this.options.readOnly || this.doc.cantEdit) },
  
        scrollTo: methodOp(function (x, y) { scrollToCoords(this, x, y); }),
        getScrollInfo: function() {
          var scroller = this.display.scroller;
          return {left: scroller.scrollLeft, top: scroller.scrollTop,
                  height: scroller.scrollHeight - scrollGap(this) - this.display.barHeight,
                  width: scroller.scrollWidth - scrollGap(this) - this.display.barWidth,
                  clientHeight: displayHeight(this), clientWidth: displayWidth(this)}
        },
  
        scrollIntoView: methodOp(function(range$$1, margin) {
          if (range$$1 == null) {
            range$$1 = {from: this.doc.sel.primary().head, to: null};
            if (margin == null) { margin = this.options.cursorScrollMargin; }
          } else if (typeof range$$1 == "number") {
            range$$1 = {from: Pos(range$$1, 0), to: null};
          } else if (range$$1.from == null) {
            range$$1 = {from: range$$1, to: null};
          }
          if (!range$$1.to) { range$$1.to = range$$1.from; }
          range$$1.margin = margin || 0;
  
          if (range$$1.from.line != null) {
            scrollToRange(this, range$$1);
          } else {
            scrollToCoordsRange(this, range$$1.from, range$$1.to, range$$1.margin);
          }
        }),
  
        setSize: methodOp(function(width, height) {
          var this$1 = this;
  
          var interpret = function (val) { return typeof val == "number" || /^\d+$/.test(String(val)) ? val + "px" : val; };
          if (width != null) { this.display.wrapper.style.width = interpret(width); }
          if (height != null) { this.display.wrapper.style.height = interpret(height); }
          if (this.options.lineWrapping) { clearLineMeasurementCache(this); }
          var lineNo$$1 = this.display.viewFrom;
          this.doc.iter(lineNo$$1, this.display.viewTo, function (line) {
            if (line.widgets) { for (var i = 0; i < line.widgets.length; i++)
              { if (line.widgets[i].noHScroll) { regLineChange(this$1, lineNo$$1, "widget"); break } } }
            ++lineNo$$1;
          });
          this.curOp.forceUpdate = true;
          signal(this, "refresh", this);
        }),
  
        operation: function(f){return runInOp(this, f)},
        startOperation: function(){return startOperation(this)},
        endOperation: function(){return endOperation(this)},
  
        refresh: methodOp(function() {
          var oldHeight = this.display.cachedTextHeight;
          regChange(this);
          this.curOp.forceUpdate = true;
          clearCaches(this);
          scrollToCoords(this, this.doc.scrollLeft, this.doc.scrollTop);
          updateGutterSpace(this.display);
          if (oldHeight == null || Math.abs(oldHeight - textHeight(this.display)) > .5 || this.options.lineWrapping)
            { estimateLineHeights(this); }
          signal(this, "refresh", this);
        }),
  
        swapDoc: methodOp(function(doc) {
          var old = this.doc;
          old.cm = null;
          // Cancel the current text selection if any (#5821)
          if (this.state.selectingText) { this.state.selectingText(); }
          attachDoc(this, doc);
          clearCaches(this);
          this.display.input.reset();
          scrollToCoords(this, doc.scrollLeft, doc.scrollTop);
          this.curOp.forceScroll = true;
          signalLater(this, "swapDoc", this, old);
          return old
        }),
  
        phrase: function(phraseText) {
          var phrases = this.options.phrases;
          return phrases && Object.prototype.hasOwnProperty.call(phrases, phraseText) ? phrases[phraseText] : phraseText
        },
  
        getInputField: function(){return this.display.input.getField()},
        getWrapperElement: function(){return this.display.wrapper},
        getScrollerElement: function(){return this.display.scroller},
        getGutterElement: function(){return this.display.gutters}
      };
      eventMixin(CodeMirror);
  
      CodeMirror.registerHelper = function(type, name, value) {
        if (!helpers.hasOwnProperty(type)) { helpers[type] = CodeMirror[type] = {_global: []}; }
        helpers[type][name] = value;
      };
      CodeMirror.registerGlobalHelper = function(type, name, predicate, value) {
        CodeMirror.registerHelper(type, name, value);
        helpers[type]._global.push({pred: predicate, val: value});
      };
    }
  
    // Used for horizontal relative motion. Dir is -1 or 1 (left or
    // right), unit can be "char", "column" (like char, but doesn't
    // cross line boundaries), "word" (across next word), or "group" (to
    // the start of next group of word or non-word-non-whitespace
    // chars). The visually param controls whether, in right-to-left
    // text, direction 1 means to move towards the next index in the
    // string, or towards the character to the right of the current
    // position. The resulting position will have a hitSide=true
    // property if it reached the end of the document.
    function findPosH(doc, pos, dir, unit, visually) {
      var oldPos = pos;
      var origDir = dir;
      var lineObj = getLine(doc, pos.line);
      var lineDir = visually && doc.direction == "rtl" ? -dir : dir;
      function findNextLine() {
        var l = pos.line + lineDir;
        if (l < doc.first || l >= doc.first + doc.size) { return false }
        pos = new Pos(l, pos.ch, pos.sticky);
        return lineObj = getLine(doc, l)
      }
      function moveOnce(boundToLine) {
        var next;
        if (visually) {
          next = moveVisually(doc.cm, lineObj, pos, dir);
        } else {
          next = moveLogically(lineObj, pos, dir);
        }
        if (next == null) {
          if (!boundToLine && findNextLine())
            { pos = endOfLine(visually, doc.cm, lineObj, pos.line, lineDir); }
          else
            { return false }
        } else {
          pos = next;
        }
        return true
      }
  
      if (unit == "char") {
        moveOnce();
      } else if (unit == "column") {
        moveOnce(true);
      } else if (unit == "word" || unit == "group") {
        var sawType = null, group = unit == "group";
        var helper = doc.cm && doc.cm.getHelper(pos, "wordChars");
        for (var first = true;; first = false) {
          if (dir < 0 && !moveOnce(!first)) { break }
          var cur = lineObj.text.charAt(pos.ch) || "\n";
          var type = isWordChar(cur, helper) ? "w"
            : group && cur == "\n" ? "n"
            : !group || /\s/.test(cur) ? null
            : "p";
          if (group && !first && !type) { type = "s"; }
          if (sawType && sawType != type) {
            if (dir < 0) {dir = 1; moveOnce(); pos.sticky = "after";}
            break
          }
  
          if (type) { sawType = type; }
          if (dir > 0 && !moveOnce(!first)) { break }
        }
      }
      var result = skipAtomic(doc, pos, oldPos, origDir, true);
      if (equalCursorPos(oldPos, result)) { result.hitSide = true; }
      return result
    }
  
    // For relative vertical movement. Dir may be -1 or 1. Unit can be
    // "page" or "line". The resulting position will have a hitSide=true
    // property if it reached the end of the document.
    function findPosV(cm, pos, dir, unit) {
      var doc = cm.doc, x = pos.left, y;
      if (unit == "page") {
        var pageSize = Math.min(cm.display.wrapper.clientHeight, window.innerHeight || document.documentElement.clientHeight);
        var moveAmount = Math.max(pageSize - .5 * textHeight(cm.display), 3);
        y = (dir > 0 ? pos.bottom : pos.top) + dir * moveAmount;
  
      } else if (unit == "line") {
        y = dir > 0 ? pos.bottom + 3 : pos.top - 3;
      }
      var target;
      for (;;) {
        target = coordsChar(cm, x, y);
        if (!target.outside) { break }
        if (dir < 0 ? y <= 0 : y >= doc.height) { target.hitSide = true; break }
        y += dir * 5;
      }
      return target
    }
  
    // CONTENTEDITABLE INPUT STYLE
  
    var ContentEditableInput = function(cm) {
      this.cm = cm;
      this.lastAnchorNode = this.lastAnchorOffset = this.lastFocusNode = this.lastFocusOffset = null;
      this.polling = new Delayed();
      this.composing = null;
      this.gracePeriod = false;
      this.readDOMTimeout = null;
    };
  
    ContentEditableInput.prototype.init = function (display) {
        var this$1 = this;
  
      var input = this, cm = input.cm;
      var div = input.div = display.lineDiv;
      disableBrowserMagic(div, cm.options.spellcheck, cm.options.autocorrect, cm.options.autocapitalize);
  
      on(div, "paste", function (e) {
        if (signalDOMEvent(cm, e) || handlePaste(e, cm)) { return }
        // IE doesn't fire input events, so we schedule a read for the pasted content in this way
        if (ie_version <= 11) { setTimeout(operation(cm, function () { return this$1.updateFromDOM(); }), 20); }
      });
  
      on(div, "compositionstart", function (e) {
        this$1.composing = {data: e.data, done: false};
      });
      on(div, "compositionupdate", function (e) {
        if (!this$1.composing) { this$1.composing = {data: e.data, done: false}; }
      });
      on(div, "compositionend", function (e) {
        if (this$1.composing) {
          if (e.data != this$1.composing.data) { this$1.readFromDOMSoon(); }
          this$1.composing.done = true;
        }
      });
  
      on(div, "touchstart", function () { return input.forceCompositionEnd(); });
  
      on(div, "input", function () {
        if (!this$1.composing) { this$1.readFromDOMSoon(); }
      });
  
      function onCopyCut(e) {
        if (signalDOMEvent(cm, e)) { return }
        if (cm.somethingSelected()) {
          setLastCopied({lineWise: false, text: cm.getSelections()});
          if (e.type == "cut") { cm.replaceSelection("", null, "cut"); }
        } else if (!cm.options.lineWiseCopyCut) {
          return
        } else {
          var ranges = copyableRanges(cm);
          setLastCopied({lineWise: true, text: ranges.text});
          if (e.type == "cut") {
            cm.operation(function () {
              cm.setSelections(ranges.ranges, 0, sel_dontScroll);
              cm.replaceSelection("", null, "cut");
            });
          }
        }
        if (e.clipboardData) {
          e.clipboardData.clearData();
          var content = lastCopied.text.join("\n");
          // iOS exposes the clipboard API, but seems to discard content inserted into it
          e.clipboardData.setData("Text", content);
          if (e.clipboardData.getData("Text") == content) {
            e.preventDefault();
            return
          }
        }
        // Old-fashioned briefly-focus-a-textarea hack
        var kludge = hiddenTextarea(), te = kludge.firstChild;
        cm.display.lineSpace.insertBefore(kludge, cm.display.lineSpace.firstChild);
        te.value = lastCopied.text.join("\n");
        var hadFocus = document.activeElement;
        selectInput(te);
        setTimeout(function () {
          cm.display.lineSpace.removeChild(kludge);
          hadFocus.focus();
          if (hadFocus == div) { input.showPrimarySelection(); }
        }, 50);
      }
      on(div, "copy", onCopyCut);
      on(div, "cut", onCopyCut);
    };
  
    ContentEditableInput.prototype.screenReaderLabelChanged = function (label) {
      // Label for screenreaders, accessibility
      if(label) {
        this.div.setAttribute('aria-label', label);
      } else {
        this.div.removeAttribute('aria-label');
      }
    };
  
    ContentEditableInput.prototype.prepareSelection = function () {
      var result = prepareSelection(this.cm, false);
      result.focus = document.activeElement == this.div;
      return result
    };
  
    ContentEditableInput.prototype.showSelection = function (info, takeFocus) {
      if (!info || !this.cm.display.view.length) { return }
      if (info.focus || takeFocus) { this.showPrimarySelection(); }
      this.showMultipleSelections(info);
    };
  
    ContentEditableInput.prototype.getSelection = function () {
      return this.cm.display.wrapper.ownerDocument.getSelection()
    };
  
    ContentEditableInput.prototype.showPrimarySelection = function () {
      var sel = this.getSelection(), cm = this.cm, prim = cm.doc.sel.primary();
      var from = prim.from(), to = prim.to();
  
      if (cm.display.viewTo == cm.display.viewFrom || from.line >= cm.display.viewTo || to.line < cm.display.viewFrom) {
        sel.removeAllRanges();
        return
      }
  
      var curAnchor = domToPos(cm, sel.anchorNode, sel.anchorOffset);
      var curFocus = domToPos(cm, sel.focusNode, sel.focusOffset);
      if (curAnchor && !curAnchor.bad && curFocus && !curFocus.bad &&
          cmp(minPos(curAnchor, curFocus), from) == 0 &&
          cmp(maxPos(curAnchor, curFocus), to) == 0)
        { return }
  
      var view = cm.display.view;
      var start = (from.line >= cm.display.viewFrom && posToDOM(cm, from)) ||
          {node: view[0].measure.map[2], offset: 0};
      var end = to.line < cm.display.viewTo && posToDOM(cm, to);
      if (!end) {
        var measure = view[view.length - 1].measure;
        var map$$1 = measure.maps ? measure.maps[measure.maps.length - 1] : measure.map;
        end = {node: map$$1[map$$1.length - 1], offset: map$$1[map$$1.length - 2] - map$$1[map$$1.length - 3]};
      }
  
      if (!start || !end) {
        sel.removeAllRanges();
        return
      }
  
      var old = sel.rangeCount && sel.getRangeAt(0), rng;
      try { rng = range(start.node, start.offset, end.offset, end.node); }
      catch(e) {} // Our model of the DOM might be outdated, in which case the range we try to set can be impossible
      if (rng) {
        if (!gecko && cm.state.focused) {
          sel.collapse(start.node, start.offset);
          if (!rng.collapsed) {
            sel.removeAllRanges();
            sel.addRange(rng);
          }
        } else {
          sel.removeAllRanges();
          sel.addRange(rng);
        }
        if (old && sel.anchorNode == null) { sel.addRange(old); }
        else if (gecko) { this.startGracePeriod(); }
      }
      this.rememberSelection();
    };
  
    ContentEditableInput.prototype.startGracePeriod = function () {
        var this$1 = this;
  
      clearTimeout(this.gracePeriod);
      this.gracePeriod = setTimeout(function () {
        this$1.gracePeriod = false;
        if (this$1.selectionChanged())
          { this$1.cm.operation(function () { return this$1.cm.curOp.selectionChanged = true; }); }
      }, 20);
    };
  
    ContentEditableInput.prototype.showMultipleSelections = function (info) {
      removeChildrenAndAdd(this.cm.display.cursorDiv, info.cursors);
      removeChildrenAndAdd(this.cm.display.selectionDiv, info.selection);
    };
  
    ContentEditableInput.prototype.rememberSelection = function () {
      var sel = this.getSelection();
      this.lastAnchorNode = sel.anchorNode; this.lastAnchorOffset = sel.anchorOffset;
      this.lastFocusNode = sel.focusNode; this.lastFocusOffset = sel.focusOffset;
    };
  
    ContentEditableInput.prototype.selectionInEditor = function () {
      var sel = this.getSelection();
      if (!sel.rangeCount) { return false }
      var node = sel.getRangeAt(0).commonAncestorContainer;
      return contains(this.div, node)
    };
  
    ContentEditableInput.prototype.focus = function () {
      if (this.cm.options.readOnly != "nocursor") {
        if (!this.selectionInEditor() || document.activeElement != this.div)
          { this.showSelection(this.prepareSelection(), true); }
        this.div.focus();
      }
    };
    ContentEditableInput.prototype.blur = function () { this.div.blur(); };
    ContentEditableInput.prototype.getField = function () { return this.div };
  
    ContentEditableInput.prototype.supportsTouch = function () { return true };
  
    ContentEditableInput.prototype.receivedFocus = function () {
      var input = this;
      if (this.selectionInEditor())
        { this.pollSelection(); }
      else
        { runInOp(this.cm, function () { return input.cm.curOp.selectionChanged = true; }); }
  
      function poll() {
        if (input.cm.state.focused) {
          input.pollSelection();
          input.polling.set(input.cm.options.pollInterval, poll);
        }
      }
      this.polling.set(this.cm.options.pollInterval, poll);
    };
  
    ContentEditableInput.prototype.selectionChanged = function () {
      var sel = this.getSelection();
      return sel.anchorNode != this.lastAnchorNode || sel.anchorOffset != this.lastAnchorOffset ||
        sel.focusNode != this.lastFocusNode || sel.focusOffset != this.lastFocusOffset
    };
  
    ContentEditableInput.prototype.pollSelection = function () {
      if (this.readDOMTimeout != null || this.gracePeriod || !this.selectionChanged()) { return }
      var sel = this.getSelection(), cm = this.cm;
      // On Android Chrome (version 56, at least), backspacing into an
      // uneditable block element will put the cursor in that element,
      // and then, because it's not editable, hide the virtual keyboard.
      // Because Android doesn't allow us to actually detect backspace
      // presses in a sane way, this code checks for when that happens
      // and simulates a backspace press in this case.
      if (android && chrome && this.cm.display.gutterSpecs.length && isInGutter(sel.anchorNode)) {
        this.cm.triggerOnKeyDown({type: "keydown", keyCode: 8, preventDefault: Math.abs});
        this.blur();
        this.focus();
        return
      }
      if (this.composing) { return }
      this.rememberSelection();
      var anchor = domToPos(cm, sel.anchorNode, sel.anchorOffset);
      var head = domToPos(cm, sel.focusNode, sel.focusOffset);
      if (anchor && head) { runInOp(cm, function () {
        setSelection(cm.doc, simpleSelection(anchor, head), sel_dontScroll);
        if (anchor.bad || head.bad) { cm.curOp.selectionChanged = true; }
      }); }
    };
  
    ContentEditableInput.prototype.pollContent = function () {
      if (this.readDOMTimeout != null) {
        clearTimeout(this.readDOMTimeout);
        this.readDOMTimeout = null;
      }
  
      var cm = this.cm, display = cm.display, sel = cm.doc.sel.primary();
      var from = sel.from(), to = sel.to();
      if (from.ch == 0 && from.line > cm.firstLine())
        { from = Pos(from.line - 1, getLine(cm.doc, from.line - 1).length); }
      if (to.ch == getLine(cm.doc, to.line).text.length && to.line < cm.lastLine())
        { to = Pos(to.line + 1, 0); }
      if (from.line < display.viewFrom || to.line > display.viewTo - 1) { return false }
  
      var fromIndex, fromLine, fromNode;
      if (from.line == display.viewFrom || (fromIndex = findViewIndex(cm, from.line)) == 0) {
        fromLine = lineNo(display.view[0].line);
        fromNode = display.view[0].node;
      } else {
        fromLine = lineNo(display.view[fromIndex].line);
        fromNode = display.view[fromIndex - 1].node.nextSibling;
      }
      var toIndex = findViewIndex(cm, to.line);
      var toLine, toNode;
      if (toIndex == display.view.length - 1) {
        toLine = display.viewTo - 1;
        toNode = display.lineDiv.lastChild;
      } else {
        toLine = lineNo(display.view[toIndex + 1].line) - 1;
        toNode = display.view[toIndex + 1].node.previousSibling;
      }
  
      if (!fromNode) { return false }
      var newText = cm.doc.splitLines(domTextBetween(cm, fromNode, toNode, fromLine, toLine));
      var oldText = getBetween(cm.doc, Pos(fromLine, 0), Pos(toLine, getLine(cm.doc, toLine).text.length));
      while (newText.length > 1 && oldText.length > 1) {
        if (lst(newText) == lst(oldText)) { newText.pop(); oldText.pop(); toLine--; }
        else if (newText[0] == oldText[0]) { newText.shift(); oldText.shift(); fromLine++; }
        else { break }
      }
  
      var cutFront = 0, cutEnd = 0;
      var newTop = newText[0], oldTop = oldText[0], maxCutFront = Math.min(newTop.length, oldTop.length);
      while (cutFront < maxCutFront && newTop.charCodeAt(cutFront) == oldTop.charCodeAt(cutFront))
        { ++cutFront; }
      var newBot = lst(newText), oldBot = lst(oldText);
      var maxCutEnd = Math.min(newBot.length - (newText.length == 1 ? cutFront : 0),
                               oldBot.length - (oldText.length == 1 ? cutFront : 0));
      while (cutEnd < maxCutEnd &&
             newBot.charCodeAt(newBot.length - cutEnd - 1) == oldBot.charCodeAt(oldBot.length - cutEnd - 1))
        { ++cutEnd; }
      // Try to move start of change to start of selection if ambiguous
      if (newText.length == 1 && oldText.length == 1 && fromLine == from.line) {
        while (cutFront && cutFront > from.ch &&
               newBot.charCodeAt(newBot.length - cutEnd - 1) == oldBot.charCodeAt(oldBot.length - cutEnd - 1)) {
          cutFront--;
          cutEnd++;
        }
      }
  
      newText[newText.length - 1] = newBot.slice(0, newBot.length - cutEnd).replace(/^\u200b+/, "");
      newText[0] = newText[0].slice(cutFront).replace(/\u200b+$/, "");
  
      var chFrom = Pos(fromLine, cutFront);
      var chTo = Pos(toLine, oldText.length ? lst(oldText).length - cutEnd : 0);
      if (newText.length > 1 || newText[0] || cmp(chFrom, chTo)) {
        replaceRange(cm.doc, newText, chFrom, chTo, "+input");
        return true
      }
    };
  
    ContentEditableInput.prototype.ensurePolled = function () {
      this.forceCompositionEnd();
    };
    ContentEditableInput.prototype.reset = function () {
      this.forceCompositionEnd();
    };
    ContentEditableInput.prototype.forceCompositionEnd = function () {
      if (!this.composing) { return }
      clearTimeout(this.readDOMTimeout);
      this.composing = null;
      this.updateFromDOM();
      this.div.blur();
      this.div.focus();
    };
    ContentEditableInput.prototype.readFromDOMSoon = function () {
        var this$1 = this;
  
      if (this.readDOMTimeout != null) { return }
      this.readDOMTimeout = setTimeout(function () {
        this$1.readDOMTimeout = null;
        if (this$1.composing) {
          if (this$1.composing.done) { this$1.composing = null; }
          else { return }
        }
        this$1.updateFromDOM();
      }, 80);
    };
  
    ContentEditableInput.prototype.updateFromDOM = function () {
        var this$1 = this;
  
      if (this.cm.isReadOnly() || !this.pollContent())
        { runInOp(this.cm, function () { return regChange(this$1.cm); }); }
    };
  
    ContentEditableInput.prototype.setUneditable = function (node) {
      node.contentEditable = "false";
    };
  
    ContentEditableInput.prototype.onKeyPress = function (e) {
      if (e.charCode == 0 || this.composing) { return }
      e.preventDefault();
      if (!this.cm.isReadOnly())
        { operation(this.cm, applyTextInput)(this.cm, String.fromCharCode(e.charCode == null ? e.keyCode : e.charCode), 0); }
    };
  
    ContentEditableInput.prototype.readOnlyChanged = function (val) {
      this.div.contentEditable = String(val != "nocursor");
    };
  
    ContentEditableInput.prototype.onContextMenu = function () {};
    ContentEditableInput.prototype.resetPosition = function () {};
  
    ContentEditableInput.prototype.needsContentAttribute = true;
  
    function posToDOM(cm, pos) {
      var view = findViewForLine(cm, pos.line);
      if (!view || view.hidden) { return null }
      var line = getLine(cm.doc, pos.line);
      var info = mapFromLineView(view, line, pos.line);
  
      var order = getOrder(line, cm.doc.direction), side = "left";
      if (order) {
        var partPos = getBidiPartAt(order, pos.ch);
        side = partPos % 2 ? "right" : "left";
      }
      var result = nodeAndOffsetInLineMap(info.map, pos.ch, side);
      result.offset = result.collapse == "right" ? result.end : result.start;
      return result
    }
  
    function isInGutter(node) {
      for (var scan = node; scan; scan = scan.parentNode)
        { if (/CodeMirror-gutter-wrapper/.test(scan.className)) { return true } }
      return false
    }
  
    function badPos(pos, bad) { if (bad) { pos.bad = true; } return pos }
  
    function domTextBetween(cm, from, to, fromLine, toLine) {
      var text = "", closing = false, lineSep = cm.doc.lineSeparator(), extraLinebreak = false;
      function recognizeMarker(id) { return function (marker) { return marker.id == id; } }
      function close() {
        if (closing) {
          text += lineSep;
          if (extraLinebreak) { text += lineSep; }
          closing = extraLinebreak = false;
        }
      }
      function addText(str) {
        if (str) {
          close();
          text += str;
        }
      }
      function walk(node) {
        if (node.nodeType == 1) {
          var cmText = node.getAttribute("cm-text");
          if (cmText) {
            addText(cmText);
            return
          }
          var markerID = node.getAttribute("cm-marker"), range$$1;
          if (markerID) {
            var found = cm.findMarks(Pos(fromLine, 0), Pos(toLine + 1, 0), recognizeMarker(+markerID));
            if (found.length && (range$$1 = found[0].find(0)))
              { addText(getBetween(cm.doc, range$$1.from, range$$1.to).join(lineSep)); }
            return
          }
          if (node.getAttribute("contenteditable") == "false") { return }
          var isBlock = /^(pre|div|p|li|table|br)$/i.test(node.nodeName);
          if (!/^br$/i.test(node.nodeName) && node.textContent.length == 0) { return }
  
          if (isBlock) { close(); }
          for (var i = 0; i < node.childNodes.length; i++)
            { walk(node.childNodes[i]); }
  
          if (/^(pre|p)$/i.test(node.nodeName)) { extraLinebreak = true; }
          if (isBlock) { closing = true; }
        } else if (node.nodeType == 3) {
          addText(node.nodeValue.replace(/\u200b/g, "").replace(/\u00a0/g, " "));
        }
      }
      for (;;) {
        walk(from);
        if (from == to) { break }
        from = from.nextSibling;
        extraLinebreak = false;
      }
      return text
    }
  
    function domToPos(cm, node, offset) {
      var lineNode;
      if (node == cm.display.lineDiv) {
        lineNode = cm.display.lineDiv.childNodes[offset];
        if (!lineNode) { return badPos(cm.clipPos(Pos(cm.display.viewTo - 1)), true) }
        node = null; offset = 0;
      } else {
        for (lineNode = node;; lineNode = lineNode.parentNode) {
          if (!lineNode || lineNode == cm.display.lineDiv) { return null }
          if (lineNode.parentNode && lineNode.parentNode == cm.display.lineDiv) { break }
        }
      }
      for (var i = 0; i < cm.display.view.length; i++) {
        var lineView = cm.display.view[i];
        if (lineView.node == lineNode)
          { return locateNodeInLineView(lineView, node, offset) }
      }
    }
  
    function locateNodeInLineView(lineView, node, offset) {
      var wrapper = lineView.text.firstChild, bad = false;
      if (!node || !contains(wrapper, node)) { return badPos(Pos(lineNo(lineView.line), 0), true) }
      if (node == wrapper) {
        bad = true;
        node = wrapper.childNodes[offset];
        offset = 0;
        if (!node) {
          var line = lineView.rest ? lst(lineView.rest) : lineView.line;
          return badPos(Pos(lineNo(line), line.text.length), bad)
        }
      }
  
      var textNode = node.nodeType == 3 ? node : null, topNode = node;
      if (!textNode && node.childNodes.length == 1 && node.firstChild.nodeType == 3) {
        textNode = node.firstChild;
        if (offset) { offset = textNode.nodeValue.length; }
      }
      while (topNode.parentNode != wrapper) { topNode = topNode.parentNode; }
      var measure = lineView.measure, maps = measure.maps;
  
      function find(textNode, topNode, offset) {
        for (var i = -1; i < (maps ? maps.length : 0); i++) {
          var map$$1 = i < 0 ? measure.map : maps[i];
          for (var j = 0; j < map$$1.length; j += 3) {
            var curNode = map$$1[j + 2];
            if (curNode == textNode || curNode == topNode) {
              var line = lineNo(i < 0 ? lineView.line : lineView.rest[i]);
              var ch = map$$1[j] + offset;
              if (offset < 0 || curNode != textNode) { ch = map$$1[j + (offset ? 1 : 0)]; }
              return Pos(line, ch)
            }
          }
        }
      }
      var found = find(textNode, topNode, offset);
      if (found) { return badPos(found, bad) }
  
      // FIXME this is all really shaky. might handle the few cases it needs to handle, but likely to cause problems
      for (var after = topNode.nextSibling, dist = textNode ? textNode.nodeValue.length - offset : 0; after; after = after.nextSibling) {
        found = find(after, after.firstChild, 0);
        if (found)
          { return badPos(Pos(found.line, found.ch - dist), bad) }
        else
          { dist += after.textContent.length; }
      }
      for (var before = topNode.previousSibling, dist$1 = offset; before; before = before.previousSibling) {
        found = find(before, before.firstChild, -1);
        if (found)
          { return badPos(Pos(found.line, found.ch + dist$1), bad) }
        else
          { dist$1 += before.textContent.length; }
      }
    }
  
    // TEXTAREA INPUT STYLE
  
    var TextareaInput = function(cm) {
      this.cm = cm;
      // See input.poll and input.reset
      this.prevInput = "";
  
      // Flag that indicates whether we expect input to appear real soon
      // now (after some event like 'keypress' or 'input') and are
      // polling intensively.
      this.pollingFast = false;
      // Self-resetting timeout for the poller
      this.polling = new Delayed();
      // Used to work around IE issue with selection being forgotten when focus moves away from textarea
      this.hasSelection = false;
      this.composing = null;
    };
  
    TextareaInput.prototype.init = function (display) {
        var this$1 = this;
  
      var input = this, cm = this.cm;
      this.createField(display);
      var te = this.textarea;
  
      display.wrapper.insertBefore(this.wrapper, display.wrapper.firstChild);
  
      // Needed to hide big blue blinking cursor on Mobile Safari (doesn't seem to work in iOS 8 anymore)
      if (ios) { te.style.width = "0px"; }
  
      on(te, "input", function () {
        if (ie && ie_version >= 9 && this$1.hasSelection) { this$1.hasSelection = null; }
        input.poll();
      });
  
      on(te, "paste", function (e) {
        if (signalDOMEvent(cm, e) || handlePaste(e, cm)) { return }
  
        cm.state.pasteIncoming = +new Date;
        input.fastPoll();
      });
  
      function prepareCopyCut(e) {
        if (signalDOMEvent(cm, e)) { return }
        if (cm.somethingSelected()) {
          setLastCopied({lineWise: false, text: cm.getSelections()});
        } else if (!cm.options.lineWiseCopyCut) {
          return
        } else {
          var ranges = copyableRanges(cm);
          setLastCopied({lineWise: true, text: ranges.text});
          if (e.type == "cut") {
            cm.setSelections(ranges.ranges, null, sel_dontScroll);
          } else {
            input.prevInput = "";
            te.value = ranges.text.join("\n");
            selectInput(te);
          }
        }
        if (e.type == "cut") { cm.state.cutIncoming = +new Date; }
      }
      on(te, "cut", prepareCopyCut);
      on(te, "copy", prepareCopyCut);
  
      on(display.scroller, "paste", function (e) {
        if (eventInWidget(display, e) || signalDOMEvent(cm, e)) { return }
        if (!te.dispatchEvent) {
          cm.state.pasteIncoming = +new Date;
          input.focus();
          return
        }
  
        // Pass the `paste` event to the textarea so it's handled by its event listener.
        var event = new Event("paste");
        event.clipboardData = e.clipboardData;
        te.dispatchEvent(event);
      });
  
      // Prevent normal selection in the editor (we handle our own)
      on(display.lineSpace, "selectstart", function (e) {
        if (!eventInWidget(display, e)) { e_preventDefault(e); }
      });
  
      on(te, "compositionstart", function () {
        var start = cm.getCursor("from");
        if (input.composing) { input.composing.range.clear(); }
        input.composing = {
          start: start,
          range: cm.markText(start, cm.getCursor("to"), {className: "CodeMirror-composing"})
        };
      });
      on(te, "compositionend", function () {
        if (input.composing) {
          input.poll();
          input.composing.range.clear();
          input.composing = null;
        }
      });
    };
  
    TextareaInput.prototype.createField = function (_display) {
      // Wraps and hides input textarea
      this.wrapper = hiddenTextarea();
      // The semihidden textarea that is focused when the editor is
      // focused, and receives input.
      this.textarea = this.wrapper.firstChild;
    };
  
    TextareaInput.prototype.screenReaderLabelChanged = function (label) {
      // Label for screenreaders, accessibility
      if(label) {
        this.textarea.setAttribute('aria-label', label);
      } else {
        this.textarea.removeAttribute('aria-label');
      }
    };
  
    TextareaInput.prototype.prepareSelection = function () {
      // Redraw the selection and/or cursor
      var cm = this.cm, display = cm.display, doc = cm.doc;
      var result = prepareSelection(cm);
  
      // Move the hidden textarea near the cursor to prevent scrolling artifacts
      if (cm.options.moveInputWithCursor) {
        var headPos = cursorCoords(cm, doc.sel.primary().head, "div");
        var wrapOff = display.wrapper.getBoundingClientRect(), lineOff = display.lineDiv.getBoundingClientRect();
        result.teTop = Math.max(0, Math.min(display.wrapper.clientHeight - 10,
                                            headPos.top + lineOff.top - wrapOff.top));
        result.teLeft = Math.max(0, Math.min(display.wrapper.clientWidth - 10,
                                             headPos.left + lineOff.left - wrapOff.left));
      }
  
      return result
    };
  
    TextareaInput.prototype.showSelection = function (drawn) {
      var cm = this.cm, display = cm.display;
      removeChildrenAndAdd(display.cursorDiv, drawn.cursors);
      removeChildrenAndAdd(display.selectionDiv, drawn.selection);
      if (drawn.teTop != null) {
        this.wrapper.style.top = drawn.teTop + "px";
        this.wrapper.style.left = drawn.teLeft + "px";
      }
    };
  
    // Reset the input to correspond to the selection (or to be empty,
    // when not typing and nothing is selected)
    TextareaInput.prototype.reset = function (typing) {
      if (this.contextMenuPending || this.composing) { return }
      var cm = this.cm;
      if (cm.somethingSelected()) {
        this.prevInput = "";
        var content = cm.getSelection();
        this.textarea.value = content;
        if (cm.state.focused) { selectInput(this.textarea); }
        if (ie && ie_version >= 9) { this.hasSelection = content; }
      } else if (!typing) {
        this.prevInput = this.textarea.value = "";
        if (ie && ie_version >= 9) { this.hasSelection = null; }
      }
    };
  
    TextareaInput.prototype.getField = function () { return this.textarea };
  
    TextareaInput.prototype.supportsTouch = function () { return false };
  
    TextareaInput.prototype.focus = function () {
      if (this.cm.options.readOnly != "nocursor" && (!mobile || activeElt() != this.textarea)) {
        try { this.textarea.focus(); }
        catch (e) {} // IE8 will throw if the textarea is display: none or not in DOM
      }
    };
  
    TextareaInput.prototype.blur = function () { this.textarea.blur(); };
  
    TextareaInput.prototype.resetPosition = function () {
      this.wrapper.style.top = this.wrapper.style.left = 0;
    };
  
    TextareaInput.prototype.receivedFocus = function () { this.slowPoll(); };
  
    // Poll for input changes, using the normal rate of polling. This
    // runs as long as the editor is focused.
    TextareaInput.prototype.slowPoll = function () {
        var this$1 = this;
  
      if (this.pollingFast) { return }
      this.polling.set(this.cm.options.pollInterval, function () {
        this$1.poll();
        if (this$1.cm.state.focused) { this$1.slowPoll(); }
      });
    };
  
    // When an event has just come in that is likely to add or change
    // something in the input textarea, we poll faster, to ensure that
    // the change appears on the screen quickly.
    TextareaInput.prototype.fastPoll = function () {
      var missed = false, input = this;
      input.pollingFast = true;
      function p() {
        var changed = input.poll();
        if (!changed && !missed) {missed = true; input.polling.set(60, p);}
        else {input.pollingFast = false; input.slowPoll();}
      }
      input.polling.set(20, p);
    };
  
    // Read input from the textarea, and update the document to match.
    // When something is selected, it is present in the textarea, and
    // selected (unless it is huge, in which case a placeholder is
    // used). When nothing is selected, the cursor sits after previously
    // seen text (can be empty), which is stored in prevInput (we must
    // not reset the textarea when typing, because that breaks IME).
    TextareaInput.prototype.poll = function () {
        var this$1 = this;
  
      var cm = this.cm, input = this.textarea, prevInput = this.prevInput;
      // Since this is called a *lot*, try to bail out as cheaply as
      // possible when it is clear that nothing happened. hasSelection
      // will be the case when there is a lot of text in the textarea,
      // in which case reading its value would be expensive.
      if (this.contextMenuPending || !cm.state.focused ||
          (hasSelection(input) && !prevInput && !this.composing) ||
          cm.isReadOnly() || cm.options.disableInput || cm.state.keySeq)
        { return false }
  
      var text = input.value;
      // If nothing changed, bail.
      if (text == prevInput && !cm.somethingSelected()) { return false }
      // Work around nonsensical selection resetting in IE9/10, and
      // inexplicable appearance of private area unicode characters on
      // some key combos in Mac (#2689).
      if (ie && ie_version >= 9 && this.hasSelection === text ||
          mac && /[\uf700-\uf7ff]/.test(text)) {
        cm.display.input.reset();
        return false
      }
  
      if (cm.doc.sel == cm.display.selForContextMenu) {
        var first = text.charCodeAt(0);
        if (first == 0x200b && !prevInput) { prevInput = "\u200b"; }
        if (first == 0x21da) { this.reset(); return this.cm.execCommand("undo") }
      }
      // Find the part of the input that is actually new
      var same = 0, l = Math.min(prevInput.length, text.length);
      while (same < l && prevInput.charCodeAt(same) == text.charCodeAt(same)) { ++same; }
  
      runInOp(cm, function () {
        applyTextInput(cm, text.slice(same), prevInput.length - same,
                       null, this$1.composing ? "*compose" : null);
  
        // Don't leave long text in the textarea, since it makes further polling slow
        if (text.length > 1000 || text.indexOf("\n") > -1) { input.value = this$1.prevInput = ""; }
        else { this$1.prevInput = text; }
  
        if (this$1.composing) {
          this$1.composing.range.clear();
          this$1.composing.range = cm.markText(this$1.composing.start, cm.getCursor("to"),
                                             {className: "CodeMirror-composing"});
        }
      });
      return true
    };
  
    TextareaInput.prototype.ensurePolled = function () {
      if (this.pollingFast && this.poll()) { this.pollingFast = false; }
    };
  
    TextareaInput.prototype.onKeyPress = function () {
      if (ie && ie_version >= 9) { this.hasSelection = null; }
      this.fastPoll();
    };
  
    TextareaInput.prototype.onContextMenu = function (e) {
      var input = this, cm = input.cm, display = cm.display, te = input.textarea;
      if (input.contextMenuPending) { input.contextMenuPending(); }
      var pos = posFromMouse(cm, e), scrollPos = display.scroller.scrollTop;
      if (!pos || presto) { return } // Opera is difficult.
  
      // Reset the current text selection only if the click is done outside of the selection
      // and 'resetSelectionOnContextMenu' option is true.
      var reset = cm.options.resetSelectionOnContextMenu;
      if (reset && cm.doc.sel.contains(pos) == -1)
        { operation(cm, setSelection)(cm.doc, simpleSelection(pos), sel_dontScroll); }
  
      var oldCSS = te.style.cssText, oldWrapperCSS = input.wrapper.style.cssText;
      var wrapperBox = input.wrapper.offsetParent.getBoundingClientRect();
      input.wrapper.style.cssText = "position: static";
      te.style.cssText = "position: absolute; width: 30px; height: 30px;\n      top: " + (e.clientY - wrapperBox.top - 5) + "px; left: " + (e.clientX - wrapperBox.left - 5) + "px;\n      z-index: 1000; background: " + (ie ? "rgba(255, 255, 255, .05)" : "transparent") + ";\n      outline: none; border-width: 0; outline: none; overflow: hidden; opacity: .05; filter: alpha(opacity=5);";
      var oldScrollY;
      if (webkit) { oldScrollY = window.scrollY; } // Work around Chrome issue (#2712)
      display.input.focus();
      if (webkit) { window.scrollTo(null, oldScrollY); }
      display.input.reset();
      // Adds "Select all" to context menu in FF
      if (!cm.somethingSelected()) { te.value = input.prevInput = " "; }
      input.contextMenuPending = rehide;
      display.selForContextMenu = cm.doc.sel;
      clearTimeout(display.detectingSelectAll);
  
      // Select-all will be greyed out if there's nothing to select, so
      // this adds a zero-width space so that we can later check whether
      // it got selected.
      function prepareSelectAllHack() {
        if (te.selectionStart != null) {
          var selected = cm.somethingSelected();
          var extval = "\u200b" + (selected ? te.value : "");
          te.value = "\u21da"; // Used to catch context-menu undo
          te.value = extval;
          input.prevInput = selected ? "" : "\u200b";
          te.selectionStart = 1; te.selectionEnd = extval.length;
          // Re-set this, in case some other handler touched the
          // selection in the meantime.
          display.selForContextMenu = cm.doc.sel;
        }
      }
      function rehide() {
        if (input.contextMenuPending != rehide) { return }
        input.contextMenuPending = false;
        input.wrapper.style.cssText = oldWrapperCSS;
        te.style.cssText = oldCSS;
        if (ie && ie_version < 9) { display.scrollbars.setScrollTop(display.scroller.scrollTop = scrollPos); }
  
        // Try to detect the user choosing select-all
        if (te.selectionStart != null) {
          if (!ie || (ie && ie_version < 9)) { prepareSelectAllHack(); }
          var i = 0, poll = function () {
            if (display.selForContextMenu == cm.doc.sel && te.selectionStart == 0 &&
                te.selectionEnd > 0 && input.prevInput == "\u200b") {
              operation(cm, selectAll)(cm);
            } else if (i++ < 10) {
              display.detectingSelectAll = setTimeout(poll, 500);
            } else {
              display.selForContextMenu = null;
              display.input.reset();
            }
          };
          display.detectingSelectAll = setTimeout(poll, 200);
        }
      }
  
      if (ie && ie_version >= 9) { prepareSelectAllHack(); }
      if (captureRightClick) {
        e_stop(e);
        var mouseup = function () {
          off(window, "mouseup", mouseup);
          setTimeout(rehide, 20);
        };
        on(window, "mouseup", mouseup);
      } else {
        setTimeout(rehide, 50);
      }
    };
  
    TextareaInput.prototype.readOnlyChanged = function (val) {
      if (!val) { this.reset(); }
      this.textarea.disabled = val == "nocursor";
    };
  
    TextareaInput.prototype.setUneditable = function () {};
  
    TextareaInput.prototype.needsContentAttribute = false;
  
    function fromTextArea(textarea, options) {
      options = options ? copyObj(options) : {};
      options.value = textarea.value;
      if (!options.tabindex && textarea.tabIndex)
        { options.tabindex = textarea.tabIndex; }
      if (!options.placeholder && textarea.placeholder)
        { options.placeholder = textarea.placeholder; }
      // Set autofocus to true if this textarea is focused, or if it has
      // autofocus and no other element is focused.
      if (options.autofocus == null) {
        var hasFocus = activeElt();
        options.autofocus = hasFocus == textarea ||
          textarea.getAttribute("autofocus") != null && hasFocus == document.body;
      }
  
      function save() {textarea.value = cm.getValue();}
  
      var realSubmit;
      if (textarea.form) {
        on(textarea.form, "submit", save);
        // Deplorable hack to make the submit method do the right thing.
        if (!options.leaveSubmitMethodAlone) {
          var form = textarea.form;
          realSubmit = form.submit;
          try {
            var wrappedSubmit = form.submit = function () {
              save();
              form.submit = realSubmit;
              form.submit();
              form.submit = wrappedSubmit;
            };
          } catch(e) {}
        }
      }
  
      options.finishInit = function (cm) {
        cm.save = save;
        cm.getTextArea = function () { return textarea; };
        cm.toTextArea = function () {
          cm.toTextArea = isNaN; // Prevent this from being ran twice
          save();
          textarea.parentNode.removeChild(cm.getWrapperElement());
          textarea.style.display = "";
          if (textarea.form) {
            off(textarea.form, "submit", save);
            if (!options.leaveSubmitMethodAlone && typeof textarea.form.submit == "function")
              { textarea.form.submit = realSubmit; }
          }
        };
      };
  
      textarea.style.display = "none";
      var cm = CodeMirror(function (node) { return textarea.parentNode.insertBefore(node, textarea.nextSibling); },
        options);
      return cm
    }
  
    function addLegacyProps(CodeMirror) {
      CodeMirror.off = off;
      CodeMirror.on = on;
      CodeMirror.wheelEventPixels = wheelEventPixels;
      CodeMirror.Doc = Doc;
      CodeMirror.splitLines = splitLinesAuto;
      CodeMirror.countColumn = countColumn;
      CodeMirror.findColumn = findColumn;
      CodeMirror.isWordChar = isWordCharBasic;
      CodeMirror.Pass = Pass;
      CodeMirror.signal = signal;
      CodeMirror.Line = Line;
      CodeMirror.changeEnd = changeEnd;
      CodeMirror.scrollbarModel = scrollbarModel;
      CodeMirror.Pos = Pos;
      CodeMirror.cmpPos = cmp;
      CodeMirror.modes = modes;
      CodeMirror.mimeModes = mimeModes;
      CodeMirror.resolveMode = resolveMode;
      CodeMirror.getMode = getMode;
      CodeMirror.modeExtensions = modeExtensions;
      CodeMirror.extendMode = extendMode;
      CodeMirror.copyState = copyState;
      CodeMirror.startState = startState;
      CodeMirror.innerMode = innerMode;
      CodeMirror.commands = commands;
      CodeMirror.keyMap = keyMap;
      CodeMirror.keyName = keyName;
      CodeMirror.isModifierKey = isModifierKey;
      CodeMirror.lookupKey = lookupKey;
      CodeMirror.normalizeKeyMap = normalizeKeyMap;
      CodeMirror.StringStream = StringStream;
      CodeMirror.SharedTextMarker = SharedTextMarker;
      CodeMirror.TextMarker = TextMarker;
      CodeMirror.LineWidget = LineWidget;
      CodeMirror.e_preventDefault = e_preventDefault;
      CodeMirror.e_stopPropagation = e_stopPropagation;
      CodeMirror.e_stop = e_stop;
      CodeMirror.addClass = addClass;
      CodeMirror.contains = contains;
      CodeMirror.rmClass = rmClass;
      CodeMirror.keyNames = keyNames;
    }
  
    // EDITOR CONSTRUCTOR
  
    defineOptions(CodeMirror);
  
    addEditorMethods(CodeMirror);
  
    // Set up methods on CodeMirror's prototype to redirect to the editor's document.
    var dontDelegate = "iter insert remove copy getEditor constructor".split(" ");
    for (var prop in Doc.prototype) { if (Doc.prototype.hasOwnProperty(prop) && indexOf(dontDelegate, prop) < 0)
      { CodeMirror.prototype[prop] = (function(method) {
        return function() {return method.apply(this.doc, arguments)}
      })(Doc.prototype[prop]); } }
  
    eventMixin(Doc);
    CodeMirror.inputStyles = {"textarea": TextareaInput, "contenteditable": ContentEditableInput};
  
    // Extra arguments are stored as the mode's dependencies, which is
    // used by (legacy) mechanisms like loadmode.js to automatically
    // load a mode. (Preferred mechanism is the require/define calls.)
    CodeMirror.defineMode = function(name/*, mode, …*/) {
      if (!CodeMirror.defaults.mode && name != "null") { CodeMirror.defaults.mode = name; }
      defineMode.apply(this, arguments);
    };
  
    CodeMirror.defineMIME = defineMIME;
  
    // Minimal default mode.
    CodeMirror.defineMode("null", function () { return ({token: function (stream) { return stream.skipToEnd(); }}); });
    CodeMirror.defineMIME("text/plain", "null");
  
    // EXTENSIONS
  
    CodeMirror.defineExtension = function (name, func) {
      CodeMirror.prototype[name] = func;
    };
    CodeMirror.defineDocExtension = function (name, func) {
      Doc.prototype[name] = func;
    };
  
    CodeMirror.fromTextArea = fromTextArea;
  
    addLegacyProps(CodeMirror);
  
    CodeMirror.version = "5.53.2";
  
    return CodeMirror;
  
  })));
  // CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/LICENSE

(function(mod) {
    if (typeof exports == "object" && typeof module == "object") // CommonJS
      mod(require("../lib/codemirror"));
    else if (typeof define == "function" && define.amd) // AMD
      define(["../lib/codemirror"], mod);
    else // Plain browser env
      mod(CodeMirror);
  })(function(CodeMirror) {
    "use strict";
  
    var Pos = CodeMirror.Pos;
    function posEq(a, b) { return a.line == b.line && a.ch == b.ch; }
  
    // Kill 'ring'
  
    var killRing = [];
    function addToRing(str) {
      killRing.push(str);
      if (killRing.length > 50) killRing.shift();
    }
    function growRingTop(str) {
      if (!killRing.length) return addToRing(str);
      killRing[killRing.length - 1] += str;
    }
    function getFromRing(n) { return killRing[killRing.length - (n ? Math.min(n, 1) : 1)] || ""; }
    function popFromRing() { if (killRing.length > 1) killRing.pop(); return getFromRing(); }
  
    var lastKill = null;
  
    function kill(cm, from, to, ring, text) {
      if (text == null) text = cm.getRange(from, to);
  
      if (ring == "grow" && lastKill && lastKill.cm == cm && posEq(from, lastKill.pos) && cm.isClean(lastKill.gen))
        growRingTop(text);
      else if (ring !== false)
        addToRing(text);
      cm.replaceRange("", from, to, "+delete");
  
      if (ring == "grow") lastKill = {cm: cm, pos: from, gen: cm.changeGeneration()};
      else lastKill = null;
    }
  
    // Boundaries of various units
  
    function byChar(cm, pos, dir) {
      return cm.findPosH(pos, dir, "char", true);
    }
  
    function byWord(cm, pos, dir) {
      return cm.findPosH(pos, dir, "word", true);
    }
  
    function byLine(cm, pos, dir) {
      return cm.findPosV(pos, dir, "line", cm.doc.sel.goalColumn);
    }
  
    function byPage(cm, pos, dir) {
      return cm.findPosV(pos, dir, "page", cm.doc.sel.goalColumn);
    }
  
    function byParagraph(cm, pos, dir) {
      var no = pos.line, line = cm.getLine(no);
      var sawText = /\S/.test(dir < 0 ? line.slice(0, pos.ch) : line.slice(pos.ch));
      var fst = cm.firstLine(), lst = cm.lastLine();
      for (;;) {
        no += dir;
        if (no < fst || no > lst)
          return cm.clipPos(Pos(no - dir, dir < 0 ? 0 : null));
        line = cm.getLine(no);
        var hasText = /\S/.test(line);
        if (hasText) sawText = true;
        else if (sawText) return Pos(no, 0);
      }
    }
  
    function bySentence(cm, pos, dir) {
      var line = pos.line, ch = pos.ch;
      var text = cm.getLine(pos.line), sawWord = false;
      for (;;) {
        var next = text.charAt(ch + (dir < 0 ? -1 : 0));
        if (!next) { // End/beginning of line reached
          if (line == (dir < 0 ? cm.firstLine() : cm.lastLine())) return Pos(line, ch);
          text = cm.getLine(line + dir);
          if (!/\S/.test(text)) return Pos(line, ch);
          line += dir;
          ch = dir < 0 ? text.length : 0;
          continue;
        }
        if (sawWord && /[!?.]/.test(next)) return Pos(line, ch + (dir > 0 ? 1 : 0));
        if (!sawWord) sawWord = /\w/.test(next);
        ch += dir;
      }
    }
  
    function byExpr(cm, pos, dir) {
      var wrap;
      if (cm.findMatchingBracket && (wrap = cm.findMatchingBracket(pos, {strict: true}))
          && wrap.match && (wrap.forward ? 1 : -1) == dir)
        return dir > 0 ? Pos(wrap.to.line, wrap.to.ch + 1) : wrap.to;
  
      for (var first = true;; first = false) {
        var token = cm.getTokenAt(pos);
        var after = Pos(pos.line, dir < 0 ? token.start : token.end);
        if (first && dir > 0 && token.end == pos.ch || !/\w/.test(token.string)) {
          var newPos = cm.findPosH(after, dir, "char");
          if (posEq(after, newPos)) return pos;
          else pos = newPos;
        } else {
          return after;
        }
      }
    }
  
    // Prefixes (only crudely supported)
  
    function getPrefix(cm, precise) {
      var digits = cm.state.emacsPrefix;
      if (!digits) return precise ? null : 1;
      clearPrefix(cm);
      return digits == "-" ? -1 : Number(digits);
    }
  
    function repeated(cmd) {
      var f = typeof cmd == "string" ? function(cm) { cm.execCommand(cmd); } : cmd;
      return function(cm) {
        var prefix = getPrefix(cm);
        f(cm);
        for (var i = 1; i < prefix; ++i) f(cm);
      };
    }
  
    function findEnd(cm, pos, by, dir) {
      var prefix = getPrefix(cm);
      if (prefix < 0) { dir = -dir; prefix = -prefix; }
      for (var i = 0; i < prefix; ++i) {
        var newPos = by(cm, pos, dir);
        if (posEq(newPos, pos)) break;
        pos = newPos;
      }
      return pos;
    }
  
    function move(by, dir) {
      var f = function(cm) {
        cm.extendSelection(findEnd(cm, cm.getCursor(), by, dir));
      };
      f.motion = true;
      return f;
    }
  
    function killTo(cm, by, dir, ring) {
      var selections = cm.listSelections(), cursor;
      var i = selections.length;
      while (i--) {
        cursor = selections[i].head;
        kill(cm, cursor, findEnd(cm, cursor, by, dir), ring);
      }
    }
  
    function killRegion(cm, ring) {
      if (cm.somethingSelected()) {
        var selections = cm.listSelections(), selection;
        var i = selections.length;
        while (i--) {
          selection = selections[i];
          kill(cm, selection.anchor, selection.head, ring);
        }
        return true;
      }
    }
  
    function addPrefix(cm, digit) {
      if (cm.state.emacsPrefix) {
        if (digit != "-") cm.state.emacsPrefix += digit;
        return;
      }
      // Not active yet
      cm.state.emacsPrefix = digit;
      cm.on("keyHandled", maybeClearPrefix);
      cm.on("inputRead", maybeDuplicateInput);
    }
  
    var prefixPreservingKeys = {"Alt-G": true, "Ctrl-X": true, "Ctrl-Q": true, "Ctrl-U": true};
  
    function maybeClearPrefix(cm, arg) {
      if (!cm.state.emacsPrefixMap && !prefixPreservingKeys.hasOwnProperty(arg))
        clearPrefix(cm);
    }
  
    function clearPrefix(cm) {
      cm.state.emacsPrefix = null;
      cm.off("keyHandled", maybeClearPrefix);
      cm.off("inputRead", maybeDuplicateInput);
    }
  
    function maybeDuplicateInput(cm, event) {
      var dup = getPrefix(cm);
      if (dup > 1 && event.origin == "+input") {
        var one = event.text.join("\n"), txt = "";
        for (var i = 1; i < dup; ++i) txt += one;
        cm.replaceSelection(txt);
      }
    }
  
    function addPrefixMap(cm) {
      cm.state.emacsPrefixMap = true;
      cm.addKeyMap(prefixMap);
      cm.on("keyHandled", maybeRemovePrefixMap);
      cm.on("inputRead", maybeRemovePrefixMap);
    }
  
    function maybeRemovePrefixMap(cm, arg) {
      if (typeof arg == "string" && (/^\d$/.test(arg) || arg == "Ctrl-U")) return;
      cm.removeKeyMap(prefixMap);
      cm.state.emacsPrefixMap = false;
      cm.off("keyHandled", maybeRemovePrefixMap);
      cm.off("inputRead", maybeRemovePrefixMap);
    }
  
    // Utilities
  
    function setMark(cm) {
      cm.setCursor(cm.getCursor());
      cm.setExtending(!cm.getExtending());
      cm.on("change", function() { cm.setExtending(false); });
    }
  
    function clearMark(cm) {
      cm.setExtending(false);
      cm.setCursor(cm.getCursor());
    }
  
    function getInput(cm, msg, f) {
      if (cm.openDialog)
        cm.openDialog(msg + ": <input type=\"text\" style=\"width: 10em\"/>", f, {bottom: true});
      else
        f(prompt(msg, ""));
    }
  
    function operateOnWord(cm, op) {
      var start = cm.getCursor(), end = cm.findPosH(start, 1, "word");
      cm.replaceRange(op(cm.getRange(start, end)), start, end);
      cm.setCursor(end);
    }
  
    function toEnclosingExpr(cm) {
      var pos = cm.getCursor(), line = pos.line, ch = pos.ch;
      var stack = [];
      while (line >= cm.firstLine()) {
        var text = cm.getLine(line);
        for (var i = ch == null ? text.length : ch; i > 0;) {
          var ch = text.charAt(--i);
          if (ch == ")")
            stack.push("(");
          else if (ch == "]")
            stack.push("[");
          else if (ch == "}")
            stack.push("{");
          else if (/[\(\{\[]/.test(ch) && (!stack.length || stack.pop() != ch))
            return cm.extendSelection(Pos(line, i));
        }
        --line; ch = null;
      }
    }
  
    function quit(cm) {
      cm.execCommand("clearSearch");
      clearMark(cm);
    }
  
    CodeMirror.emacs = {kill: kill, killRegion: killRegion, repeated: repeated};
  
    // Actual keymap
  
    var keyMap = CodeMirror.keyMap.emacs = CodeMirror.normalizeKeyMap({
      "Ctrl-W": function(cm) {kill(cm, cm.getCursor("start"), cm.getCursor("end"), true);},
      "Ctrl-K": repeated(function(cm) {
        var start = cm.getCursor(), end = cm.clipPos(Pos(start.line));
        var text = cm.getRange(start, end);
        if (!/\S/.test(text)) {
          text += "\n";
          end = Pos(start.line + 1, 0);
        }
        kill(cm, start, end, "grow", text);
      }),
      "Alt-W": function(cm) {
        addToRing(cm.getSelection());
        clearMark(cm);
      },
      "Ctrl-Y": function(cm) {
        var start = cm.getCursor();
        cm.replaceRange(getFromRing(getPrefix(cm)), start, start, "paste");
        cm.setSelection(start, cm.getCursor());
      },
      "Alt-Y": function(cm) {cm.replaceSelection(popFromRing(), "around", "paste");},
  
      "Ctrl-Space": setMark, "Ctrl-Shift-2": setMark,
  
      "Ctrl-F": move(byChar, 1), "Ctrl-B": move(byChar, -1),
      "Right": move(byChar, 1), "Left": move(byChar, -1),
      "Ctrl-D": function(cm) { killTo(cm, byChar, 1, false); },
      "Delete": function(cm) { killRegion(cm, false) || killTo(cm, byChar, 1, false); },
      "Ctrl-H": function(cm) { killTo(cm, byChar, -1, false); },
      "Backspace": function(cm) { killRegion(cm, false) || killTo(cm, byChar, -1, false); },
  
      "Alt-F": move(byWord, 1), "Alt-B": move(byWord, -1),
      "Alt-Right": move(byWord, 1), "Alt-Left": move(byWord, -1),
      "Alt-D": function(cm) { killTo(cm, byWord, 1, "grow"); },
      "Alt-Backspace": function(cm) { killTo(cm, byWord, -1, "grow"); },
  
      "Ctrl-N": move(byLine, 1), "Ctrl-P": move(byLine, -1),
      "Down": move(byLine, 1), "Up": move(byLine, -1),
      "Ctrl-A": "goLineStart", "Ctrl-E": "goLineEnd",
      "End": "goLineEnd", "Home": "goLineStart",
  
      "Alt-V": move(byPage, -1), "Ctrl-V": move(byPage, 1),
      "PageUp": move(byPage, -1), "PageDown": move(byPage, 1),
  
      "Ctrl-Up": move(byParagraph, -1), "Ctrl-Down": move(byParagraph, 1),
  
      "Alt-A": move(bySentence, -1), "Alt-E": move(bySentence, 1),
      "Alt-K": function(cm) { killTo(cm, bySentence, 1, "grow"); },
  
      "Ctrl-Alt-K": function(cm) { killTo(cm, byExpr, 1, "grow"); },
      "Ctrl-Alt-Backspace": function(cm) { killTo(cm, byExpr, -1, "grow"); },
      "Ctrl-Alt-F": move(byExpr, 1), "Ctrl-Alt-B": move(byExpr, -1, "grow"),
  
      "Shift-Ctrl-Alt-2": function(cm) {
        var cursor = cm.getCursor();
        cm.setSelection(findEnd(cm, cursor, byExpr, 1), cursor);
      },
      "Ctrl-Alt-T": function(cm) {
        var leftStart = byExpr(cm, cm.getCursor(), -1), leftEnd = byExpr(cm, leftStart, 1);
        var rightEnd = byExpr(cm, leftEnd, 1), rightStart = byExpr(cm, rightEnd, -1);
        cm.replaceRange(cm.getRange(rightStart, rightEnd) + cm.getRange(leftEnd, rightStart) +
                        cm.getRange(leftStart, leftEnd), leftStart, rightEnd);
      },
      "Ctrl-Alt-U": repeated(toEnclosingExpr),
  
      "Alt-Space": function(cm) {
        var pos = cm.getCursor(), from = pos.ch, to = pos.ch, text = cm.getLine(pos.line);
        while (from && /\s/.test(text.charAt(from - 1))) --from;
        while (to < text.length && /\s/.test(text.charAt(to))) ++to;
        cm.replaceRange(" ", Pos(pos.line, from), Pos(pos.line, to));
      },
      "Ctrl-O": repeated(function(cm) { cm.replaceSelection("\n", "start"); }),
      "Ctrl-T": repeated(function(cm) {
        cm.execCommand("transposeChars");
      }),
  
      "Alt-C": repeated(function(cm) {
        operateOnWord(cm, function(w) {
          var letter = w.search(/\w/);
          if (letter == -1) return w;
          return w.slice(0, letter) + w.charAt(letter).toUpperCase() + w.slice(letter + 1).toLowerCase();
        });
      }),
      "Alt-U": repeated(function(cm) {
        operateOnWord(cm, function(w) { return w.toUpperCase(); });
      }),
      "Alt-L": repeated(function(cm) {
        operateOnWord(cm, function(w) { return w.toLowerCase(); });
      }),
  
      "Alt-;": "toggleComment",
  
      "Ctrl-/": repeated("undo"), "Shift-Ctrl--": repeated("undo"),
      "Ctrl-Z": repeated("undo"), "Cmd-Z": repeated("undo"),
      "Shift-Ctrl-Z": "redo",
      "Shift-Alt-,": "goDocStart", "Shift-Alt-.": "goDocEnd",
      "Ctrl-S": "findPersistentNext", "Ctrl-R": "findPersistentPrev", "Ctrl-G": quit, "Shift-Alt-5": "replace",
      "Alt-/": "autocomplete",
      "Enter": "newlineAndIndent",
      "Ctrl-J": repeated(function(cm) { cm.replaceSelection("\n", "end"); }),
      "Tab": "indentAuto",
  
      "Alt-G G": function(cm) {
        var prefix = getPrefix(cm, true);
        if (prefix != null && prefix > 0) return cm.setCursor(prefix - 1);
  
        getInput(cm, "Goto line", function(str) {
          var num;
          if (str && !isNaN(num = Number(str)) && num == (num|0) && num > 0)
            cm.setCursor(num - 1);
        });
      },
  
      "Ctrl-X Tab": function(cm) {
        cm.indentSelection(getPrefix(cm, true) || cm.getOption("indentUnit"));
      },
      "Ctrl-X Ctrl-X": function(cm) {
        cm.setSelection(cm.getCursor("head"), cm.getCursor("anchor"));
      },
      "Ctrl-X Ctrl-S": "save",
      "Ctrl-X Ctrl-W": "save",
      "Ctrl-X S": "saveAll",
      "Ctrl-X F": "open",
      "Ctrl-X U": repeated("undo"),
      "Ctrl-X K": "close",
      "Ctrl-X Delete": function(cm) { kill(cm, cm.getCursor(), bySentence(cm, cm.getCursor(), 1), "grow"); },
      "Ctrl-X H": "selectAll",
  
      "Ctrl-Q Tab": repeated("insertTab"),
      "Ctrl-U": addPrefixMap,
      "fallthrough": "default"
    });
  
    var prefixMap = {"Ctrl-G": clearPrefix};
    function regPrefix(d) {
      prefixMap[d] = function(cm) { addPrefix(cm, d); };
      keyMap["Ctrl-" + d] = function(cm) { addPrefix(cm, d); };
      prefixPreservingKeys["Ctrl-" + d] = true;
    }
    for (var i = 0; i < 10; ++i) regPrefix(String(i));
    regPrefix("-");
  });
  // CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/LICENSE

/**
 * Supported keybindings:
 *   Too many to list. Refer to defaultKeymap below.
 *
 * Supported Ex commands:
 *   Refer to defaultExCommandMap below.
 *
 * Registers: unnamed, -, a-z, A-Z, 0-9
 *   (Does not respect the special case for number registers when delete
 *    operator is made with these commands: %, (, ),  , /, ?, n, N, {, } )
 *   TODO: Implement the remaining registers.
 *
 * Marks: a-z, A-Z, and 0-9
 *   TODO: Implement the remaining special marks. They have more complex
 *       behavior.
 *
 * Events:
 *  'vim-mode-change' - raised on the editor anytime the current mode changes,
 *                      Event object: {mode: "visual", subMode: "linewise"}
 *
 * Code structure:
 *  1. Default keymap
 *  2. Variable declarations and short basic helpers
 *  3. Instance (External API) implementation
 *  4. Internal state tracking objects (input state, counter) implementation
 *     and instantiation
 *  5. Key handler (the main command dispatcher) implementation
 *  6. Motion, operator, and action implementations
 *  7. Helper functions for the key handler, motions, operators, and actions
 *  8. Set up Vim to work as a keymap for CodeMirror.
 *  9. Ex command implementations.
 */

(function(mod) {
    if (typeof exports == "object" && typeof module == "object") // CommonJS
      mod(require("../lib/codemirror"), require("../addon/search/searchcursor"), require("../addon/dialog/dialog"), require("../addon/edit/matchbrackets.js"));
    else if (typeof define == "function" && define.amd) // AMD
      define(["../lib/codemirror", "../addon/search/searchcursor", "../addon/dialog/dialog", "../addon/edit/matchbrackets"], mod);
    else // Plain browser env
      mod(CodeMirror);
  })(function(CodeMirror) {
    'use strict';
  
    var defaultKeymap = [
      // Key to key mapping. This goes first to make it possible to override
      // existing mappings.
      { keys: '<Left>', type: 'keyToKey', toKeys: 'h' },
      { keys: '<Right>', type: 'keyToKey', toKeys: 'l' },
      { keys: '<Up>', type: 'keyToKey', toKeys: 'k' },
      { keys: '<Down>', type: 'keyToKey', toKeys: 'j' },
      { keys: '<Space>', type: 'keyToKey', toKeys: 'l' },
      { keys: '<BS>', type: 'keyToKey', toKeys: 'h', context: 'normal'},
      { keys: '<Del>', type: 'keyToKey', toKeys: 'x', context: 'normal'},
      { keys: '<C-Space>', type: 'keyToKey', toKeys: 'W' },
      { keys: '<C-BS>', type: 'keyToKey', toKeys: 'B', context: 'normal' },
      { keys: '<S-Space>', type: 'keyToKey', toKeys: 'w' },
      { keys: '<S-BS>', type: 'keyToKey', toKeys: 'b', context: 'normal' },
      { keys: '<C-n>', type: 'keyToKey', toKeys: 'j' },
      { keys: '<C-p>', type: 'keyToKey', toKeys: 'k' },
      { keys: '<C-[>', type: 'keyToKey', toKeys: '<Esc>' },
      { keys: '<C-c>', type: 'keyToKey', toKeys: '<Esc>' },
      { keys: '<C-[>', type: 'keyToKey', toKeys: '<Esc>', context: 'insert' },
      { keys: '<C-c>', type: 'keyToKey', toKeys: '<Esc>', context: 'insert' },
      { keys: 's', type: 'keyToKey', toKeys: 'cl', context: 'normal' },
      { keys: 's', type: 'keyToKey', toKeys: 'c', context: 'visual'},
      { keys: 'S', type: 'keyToKey', toKeys: 'cc', context: 'normal' },
      { keys: 'S', type: 'keyToKey', toKeys: 'VdO', context: 'visual' },
      { keys: '<Home>', type: 'keyToKey', toKeys: '0' },
      { keys: '<End>', type: 'keyToKey', toKeys: '$' },
      { keys: '<PageUp>', type: 'keyToKey', toKeys: '<C-b>' },
      { keys: '<PageDown>', type: 'keyToKey', toKeys: '<C-f>' },
      { keys: '<CR>', type: 'keyToKey', toKeys: 'j^', context: 'normal' },
      { keys: '<Ins>', type: 'action', action: 'toggleOverwrite', context: 'insert' },
      // Motions
      { keys: 'H', type: 'motion', motion: 'moveToTopLine', motionArgs: { linewise: true, toJumplist: true }},
      { keys: 'M', type: 'motion', motion: 'moveToMiddleLine', motionArgs: { linewise: true, toJumplist: true }},
      { keys: 'L', type: 'motion', motion: 'moveToBottomLine', motionArgs: { linewise: true, toJumplist: true }},
      { keys: 'h', type: 'motion', motion: 'moveByCharacters', motionArgs: { forward: false }},
      { keys: 'l', type: 'motion', motion: 'moveByCharacters', motionArgs: { forward: true }},
      { keys: 'j', type: 'motion', motion: 'moveByLines', motionArgs: { forward: true, linewise: true }},
      { keys: 'k', type: 'motion', motion: 'moveByLines', motionArgs: { forward: false, linewise: true }},
      { keys: 'gj', type: 'motion', motion: 'moveByDisplayLines', motionArgs: { forward: true }},
      { keys: 'gk', type: 'motion', motion: 'moveByDisplayLines', motionArgs: { forward: false }},
      { keys: 'w', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: false }},
      { keys: 'W', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: false, bigWord: true }},
      { keys: 'e', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: true, inclusive: true }},
      { keys: 'E', type: 'motion', motion: 'moveByWords', motionArgs: { forward: true, wordEnd: true, bigWord: true, inclusive: true }},
      { keys: 'b', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: false }},
      { keys: 'B', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: false, bigWord: true }},
      { keys: 'ge', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: true, inclusive: true }},
      { keys: 'gE', type: 'motion', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: true, bigWord: true, inclusive: true }},
      { keys: '{', type: 'motion', motion: 'moveByParagraph', motionArgs: { forward: false, toJumplist: true }},
      { keys: '}', type: 'motion', motion: 'moveByParagraph', motionArgs: { forward: true, toJumplist: true }},
      { keys: '(', type: 'motion', motion: 'moveBySentence', motionArgs: { forward: false }},
      { keys: ')', type: 'motion', motion: 'moveBySentence', motionArgs: { forward: true }},
      { keys: '<C-f>', type: 'motion', motion: 'moveByPage', motionArgs: { forward: true }},
      { keys: '<C-b>', type: 'motion', motion: 'moveByPage', motionArgs: { forward: false }},
      { keys: '<C-d>', type: 'motion', motion: 'moveByScroll', motionArgs: { forward: true, explicitRepeat: true }},
      { keys: '<C-u>', type: 'motion', motion: 'moveByScroll', motionArgs: { forward: false, explicitRepeat: true }},
      { keys: 'gg', type: 'motion', motion: 'moveToLineOrEdgeOfDocument', motionArgs: { forward: false, explicitRepeat: true, linewise: true, toJumplist: true }},
      { keys: 'G', type: 'motion', motion: 'moveToLineOrEdgeOfDocument', motionArgs: { forward: true, explicitRepeat: true, linewise: true, toJumplist: true }},
      { keys: '0', type: 'motion', motion: 'moveToStartOfLine' },
      { keys: '^', type: 'motion', motion: 'moveToFirstNonWhiteSpaceCharacter' },
      { keys: '+', type: 'motion', motion: 'moveByLines', motionArgs: { forward: true, toFirstChar:true }},
      { keys: '-', type: 'motion', motion: 'moveByLines', motionArgs: { forward: false, toFirstChar:true }},
      { keys: '_', type: 'motion', motion: 'moveByLines', motionArgs: { forward: true, toFirstChar:true, repeatOffset:-1 }},
      { keys: '$', type: 'motion', motion: 'moveToEol', motionArgs: { inclusive: true }},
      { keys: '%', type: 'motion', motion: 'moveToMatchedSymbol', motionArgs: { inclusive: true, toJumplist: true }},
      { keys: 'f<character>', type: 'motion', motion: 'moveToCharacter', motionArgs: { forward: true , inclusive: true }},
      { keys: 'F<character>', type: 'motion', motion: 'moveToCharacter', motionArgs: { forward: false }},
      { keys: 't<character>', type: 'motion', motion: 'moveTillCharacter', motionArgs: { forward: true, inclusive: true }},
      { keys: 'T<character>', type: 'motion', motion: 'moveTillCharacter', motionArgs: { forward: false }},
      { keys: ';', type: 'motion', motion: 'repeatLastCharacterSearch', motionArgs: { forward: true }},
      { keys: ',', type: 'motion', motion: 'repeatLastCharacterSearch', motionArgs: { forward: false }},
      { keys: '\'<character>', type: 'motion', motion: 'goToMark', motionArgs: {toJumplist: true, linewise: true}},
      { keys: '`<character>', type: 'motion', motion: 'goToMark', motionArgs: {toJumplist: true}},
      { keys: ']`', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: true } },
      { keys: '[`', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: false } },
      { keys: ']\'', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: true, linewise: true } },
      { keys: '[\'', type: 'motion', motion: 'jumpToMark', motionArgs: { forward: false, linewise: true } },
      // the next two aren't motions but must come before more general motion declarations
      { keys: ']p', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: true, isEdit: true, matchIndent: true}},
      { keys: '[p', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: false, isEdit: true, matchIndent: true}},
      { keys: ']<character>', type: 'motion', motion: 'moveToSymbol', motionArgs: { forward: true, toJumplist: true}},
      { keys: '[<character>', type: 'motion', motion: 'moveToSymbol', motionArgs: { forward: false, toJumplist: true}},
      { keys: '|', type: 'motion', motion: 'moveToColumn'},
      { keys: 'o', type: 'motion', motion: 'moveToOtherHighlightedEnd', context:'visual'},
      { keys: 'O', type: 'motion', motion: 'moveToOtherHighlightedEnd', motionArgs: {sameLine: true}, context:'visual'},
      // Operators
      { keys: 'd', type: 'operator', operator: 'delete' },
      { keys: 'y', type: 'operator', operator: 'yank' },
      { keys: 'c', type: 'operator', operator: 'change' },
      { keys: '=', type: 'operator', operator: 'indentAuto' },
      { keys: '>', type: 'operator', operator: 'indent', operatorArgs: { indentRight: true }},
      { keys: '<', type: 'operator', operator: 'indent', operatorArgs: { indentRight: false }},
      { keys: 'g~', type: 'operator', operator: 'changeCase' },
      { keys: 'gu', type: 'operator', operator: 'changeCase', operatorArgs: {toLower: true}, isEdit: true },
      { keys: 'gU', type: 'operator', operator: 'changeCase', operatorArgs: {toLower: false}, isEdit: true },
      { keys: 'n', type: 'motion', motion: 'findNext', motionArgs: { forward: true, toJumplist: true }},
      { keys: 'N', type: 'motion', motion: 'findNext', motionArgs: { forward: false, toJumplist: true }},
      // Operator-Motion dual commands
      { keys: 'x', type: 'operatorMotion', operator: 'delete', motion: 'moveByCharacters', motionArgs: { forward: true }, operatorMotionArgs: { visualLine: false }},
      { keys: 'X', type: 'operatorMotion', operator: 'delete', motion: 'moveByCharacters', motionArgs: { forward: false }, operatorMotionArgs: { visualLine: true }},
      { keys: 'D', type: 'operatorMotion', operator: 'delete', motion: 'moveToEol', motionArgs: { inclusive: true }, context: 'normal'},
      { keys: 'D', type: 'operator', operator: 'delete', operatorArgs: { linewise: true }, context: 'visual'},
      { keys: 'Y', type: 'operatorMotion', operator: 'yank', motion: 'expandToLine', motionArgs: { linewise: true }, context: 'normal'},
      { keys: 'Y', type: 'operator', operator: 'yank', operatorArgs: { linewise: true }, context: 'visual'},
      { keys: 'C', type: 'operatorMotion', operator: 'change', motion: 'moveToEol', motionArgs: { inclusive: true }, context: 'normal'},
      { keys: 'C', type: 'operator', operator: 'change', operatorArgs: { linewise: true }, context: 'visual'},
      { keys: '~', type: 'operatorMotion', operator: 'changeCase', motion: 'moveByCharacters', motionArgs: { forward: true }, operatorArgs: { shouldMoveCursor: true }, context: 'normal'},
      { keys: '~', type: 'operator', operator: 'changeCase', context: 'visual'},
      { keys: '<C-w>', type: 'operatorMotion', operator: 'delete', motion: 'moveByWords', motionArgs: { forward: false, wordEnd: false }, context: 'insert' },
      //ignore C-w in normal mode
      { keys: '<C-w>', type: 'idle', context: 'normal' },
      // Actions
      { keys: '<C-i>', type: 'action', action: 'jumpListWalk', actionArgs: { forward: true }},
      { keys: '<C-o>', type: 'action', action: 'jumpListWalk', actionArgs: { forward: false }},
      { keys: '<C-e>', type: 'action', action: 'scroll', actionArgs: { forward: true, linewise: true }},
      { keys: '<C-y>', type: 'action', action: 'scroll', actionArgs: { forward: false, linewise: true }},
      { keys: 'a', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'charAfter' }, context: 'normal' },
      { keys: 'A', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'eol' }, context: 'normal' },
      { keys: 'A', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'endOfSelectedArea' }, context: 'visual' },
      { keys: 'i', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'inplace' }, context: 'normal' },
      { keys: 'gi', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'lastEdit' }, context: 'normal' },
      { keys: 'I', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'firstNonBlank'}, context: 'normal' },
      { keys: 'gI', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'bol'}, context: 'normal' },
      { keys: 'I', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { insertAt: 'startOfSelectedArea' }, context: 'visual' },
      { keys: 'o', type: 'action', action: 'newLineAndEnterInsertMode', isEdit: true, interlaceInsertRepeat: true, actionArgs: { after: true }, context: 'normal' },
      { keys: 'O', type: 'action', action: 'newLineAndEnterInsertMode', isEdit: true, interlaceInsertRepeat: true, actionArgs: { after: false }, context: 'normal' },
      { keys: 'v', type: 'action', action: 'toggleVisualMode' },
      { keys: 'V', type: 'action', action: 'toggleVisualMode', actionArgs: { linewise: true }},
      { keys: '<C-v>', type: 'action', action: 'toggleVisualMode', actionArgs: { blockwise: true }},
      { keys: '<C-q>', type: 'action', action: 'toggleVisualMode', actionArgs: { blockwise: true }},
      { keys: 'gv', type: 'action', action: 'reselectLastSelection' },
      { keys: 'J', type: 'action', action: 'joinLines', isEdit: true },
      { keys: 'gJ', type: 'action', action: 'joinLines', actionArgs: { keepSpaces: true }, isEdit: true },
      { keys: 'p', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: true, isEdit: true }},
      { keys: 'P', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: false, isEdit: true }},
      { keys: 'r<character>', type: 'action', action: 'replace', isEdit: true },
      { keys: '@<character>', type: 'action', action: 'replayMacro' },
      { keys: 'q<character>', type: 'action', action: 'enterMacroRecordMode' },
      // Handle Replace-mode as a special case of insert mode.
      { keys: 'R', type: 'action', action: 'enterInsertMode', isEdit: true, actionArgs: { replace: true }, context: 'normal'},
      { keys: 'R', type: 'operator', operator: 'change', operatorArgs: { linewise: true, fullLine: true }, context: 'visual', exitVisualBlock: true},
      { keys: 'u', type: 'action', action: 'undo', context: 'normal' },
      { keys: 'u', type: 'operator', operator: 'changeCase', operatorArgs: {toLower: true}, context: 'visual', isEdit: true },
      { keys: 'U', type: 'operator', operator: 'changeCase', operatorArgs: {toLower: false}, context: 'visual', isEdit: true },
      { keys: '<C-r>', type: 'action', action: 'redo' },
      { keys: 'm<character>', type: 'action', action: 'setMark' },
      { keys: '"<character>', type: 'action', action: 'setRegister' },
      { keys: 'zz', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'center' }},
      { keys: 'z.', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'center' }, motion: 'moveToFirstNonWhiteSpaceCharacter' },
      { keys: 'zt', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'top' }},
      { keys: 'z<CR>', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'top' }, motion: 'moveToFirstNonWhiteSpaceCharacter' },
      { keys: 'z-', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'bottom' }},
      { keys: 'zb', type: 'action', action: 'scrollToCursor', actionArgs: { position: 'bottom' }, motion: 'moveToFirstNonWhiteSpaceCharacter' },
      { keys: '.', type: 'action', action: 'repeatLastEdit' },
      { keys: '<C-a>', type: 'action', action: 'incrementNumberToken', isEdit: true, actionArgs: {increase: true, backtrack: false}},
      { keys: '<C-x>', type: 'action', action: 'incrementNumberToken', isEdit: true, actionArgs: {increase: false, backtrack: false}},
      { keys: '<C-t>', type: 'action', action: 'indent', actionArgs: { indentRight: true }, context: 'insert' },
      { keys: '<C-d>', type: 'action', action: 'indent', actionArgs: { indentRight: false }, context: 'insert' },
      // Text object motions
      { keys: 'a<character>', type: 'motion', motion: 'textObjectManipulation' },
      { keys: 'i<character>', type: 'motion', motion: 'textObjectManipulation', motionArgs: { textObjectInner: true }},
      // Search
      { keys: '/', type: 'search', searchArgs: { forward: true, querySrc: 'prompt', toJumplist: true }},
      { keys: '?', type: 'search', searchArgs: { forward: false, querySrc: 'prompt', toJumplist: true }},
      { keys: '*', type: 'search', searchArgs: { forward: true, querySrc: 'wordUnderCursor', wholeWordOnly: true, toJumplist: true }},
      { keys: '#', type: 'search', searchArgs: { forward: false, querySrc: 'wordUnderCursor', wholeWordOnly: true, toJumplist: true }},
      { keys: 'g*', type: 'search', searchArgs: { forward: true, querySrc: 'wordUnderCursor', toJumplist: true }},
      { keys: 'g#', type: 'search', searchArgs: { forward: false, querySrc: 'wordUnderCursor', toJumplist: true }},
      // Ex command
      { keys: ':', type: 'ex' }
    ];
    var defaultKeymapLength = defaultKeymap.length;
  
    /**
     * Ex commands
     * Care must be taken when adding to the default Ex command map. For any
     * pair of commands that have a shared prefix, at least one of their
     * shortNames must not match the prefix of the other command.
     */
    var defaultExCommandMap = [
      { name: 'colorscheme', shortName: 'colo' },
      { name: 'map' },
      { name: 'imap', shortName: 'im' },
      { name: 'nmap', shortName: 'nm' },
      { name: 'vmap', shortName: 'vm' },
      { name: 'unmap' },
      { name: 'write', shortName: 'w' },
      { name: 'undo', shortName: 'u' },
      { name: 'redo', shortName: 'red' },
      { name: 'set', shortName: 'se' },
      { name: 'setlocal', shortName: 'setl' },
      { name: 'setglobal', shortName: 'setg' },
      { name: 'sort', shortName: 'sor' },
      { name: 'substitute', shortName: 's', possiblyAsync: true },
      { name: 'nohlsearch', shortName: 'noh' },
      { name: 'yank', shortName: 'y' },
      { name: 'delmarks', shortName: 'delm' },
      { name: 'registers', shortName: 'reg', excludeFromCommandHistory: true },
      { name: 'global', shortName: 'g' }
    ];
  
    var Pos = CodeMirror.Pos;
  
    var Vim = function() {
      function enterVimMode(cm) {
        cm.setOption('disableInput', true);
        cm.setOption('showCursorWhenSelecting', false);
        CodeMirror.signal(cm, "vim-mode-change", {mode: "normal"});
        cm.on('cursorActivity', onCursorActivity);
        maybeInitVimState(cm);
        CodeMirror.on(cm.getInputField(), 'paste', getOnPasteFn(cm));
      }
  
      function leaveVimMode(cm) {
        cm.setOption('disableInput', false);
        cm.off('cursorActivity', onCursorActivity);
        CodeMirror.off(cm.getInputField(), 'paste', getOnPasteFn(cm));
        cm.state.vim = null;
      }
  
      function detachVimMap(cm, next) {
        if (this == CodeMirror.keyMap.vim) {
          CodeMirror.rmClass(cm.getWrapperElement(), "cm-fat-cursor");
          if (cm.getOption("inputStyle") == "contenteditable" && document.body.style.caretColor != null) {
            disableFatCursorMark(cm);
            cm.getInputField().style.caretColor = "";
          }
        }
  
        if (!next || next.attach != attachVimMap)
          leaveVimMode(cm);
      }
      function attachVimMap(cm, prev) {
        if (this == CodeMirror.keyMap.vim) {
          CodeMirror.addClass(cm.getWrapperElement(), "cm-fat-cursor");
          if (cm.getOption("inputStyle") == "contenteditable" && document.body.style.caretColor != null) {
            enableFatCursorMark(cm);
            cm.getInputField().style.caretColor = "transparent";
          }
        }
  
        if (!prev || prev.attach != attachVimMap)
          enterVimMode(cm);
      }
  
      function updateFatCursorMark(cm) {
        if (!cm.state.fatCursorMarks) return;
        clearFatCursorMark(cm);
        var ranges = cm.listSelections(), result = []
        for (var i = 0; i < ranges.length; i++) {
          var range = ranges[i];
          if (range.empty()) {
            var lineLength = cm.getLine(range.anchor.line).length;
            if (range.anchor.ch < lineLength) {
              result.push(cm.markText(range.anchor, Pos(range.anchor.line, range.anchor.ch + 1),
                                      {className: "cm-fat-cursor-mark"}));
            } else {
              result.push(cm.markText(Pos(range.anchor.line, lineLength - 1),
                                      Pos(range.anchor.line, lineLength),
                                      {className: "cm-fat-cursor-mark"}));
            }
          }
        }
        cm.state.fatCursorMarks = result;
      }
  
      function clearFatCursorMark(cm) {
        var marks = cm.state.fatCursorMarks;
        if (marks) for (var i = 0; i < marks.length; i++) marks[i].clear();
      }
  
      function enableFatCursorMark(cm) {
        cm.state.fatCursorMarks = [];
        updateFatCursorMark(cm)
        cm.on("cursorActivity", updateFatCursorMark)
      }
  
      function disableFatCursorMark(cm) {
        clearFatCursorMark(cm);
        cm.off("cursorActivity", updateFatCursorMark);
        // explicitly set fatCursorMarks to null because event listener above
        // can be invoke after removing it, if off is called from operation
        cm.state.fatCursorMarks = null;
      }
  
      // Deprecated, simply setting the keymap works again.
      CodeMirror.defineOption('vimMode', false, function(cm, val, prev) {
        if (val && cm.getOption("keyMap") != "vim")
          cm.setOption("keyMap", "vim");
        else if (!val && prev != CodeMirror.Init && /^vim/.test(cm.getOption("keyMap")))
          cm.setOption("keyMap", "default");
      });
  
      function cmKey(key, cm) {
        if (!cm) { return undefined; }
        if (this[key]) { return this[key]; }
        var vimKey = cmKeyToVimKey(key);
        if (!vimKey) {
          return false;
        }
        var cmd = CodeMirror.Vim.findKey(cm, vimKey);
        if (typeof cmd == 'function') {
          CodeMirror.signal(cm, 'vim-keypress', vimKey);
        }
        return cmd;
      }
  
      var modifiers = {'Shift': 'S', 'Ctrl': 'C', 'Alt': 'A', 'Cmd': 'D', 'Mod': 'A'};
      var specialKeys = {Enter:'CR',Backspace:'BS',Delete:'Del',Insert:'Ins'};
      function cmKeyToVimKey(key) {
        if (key.charAt(0) == '\'') {
          // Keypress character binding of format "'a'"
          return key.charAt(1);
        }
        var pieces = key.split(/-(?!$)/);
        var lastPiece = pieces[pieces.length - 1];
        if (pieces.length == 1 && pieces[0].length == 1) {
          // No-modifier bindings use literal character bindings above. Skip.
          return false;
        } else if (pieces.length == 2 && pieces[0] == 'Shift' && lastPiece.length == 1) {
          // Ignore Shift+char bindings as they should be handled by literal character.
          return false;
        }
        var hasCharacter = false;
        for (var i = 0; i < pieces.length; i++) {
          var piece = pieces[i];
          if (piece in modifiers) { pieces[i] = modifiers[piece]; }
          else { hasCharacter = true; }
          if (piece in specialKeys) { pieces[i] = specialKeys[piece]; }
        }
        if (!hasCharacter) {
          // Vim does not support modifier only keys.
          return false;
        }
        // TODO: Current bindings expect the character to be lower case, but
        // it looks like vim key notation uses upper case.
        if (isUpperCase(lastPiece)) {
          pieces[pieces.length - 1] = lastPiece.toLowerCase();
        }
        return '<' + pieces.join('-') + '>';
      }
  
      function getOnPasteFn(cm) {
        var vim = cm.state.vim;
        if (!vim.onPasteFn) {
          vim.onPasteFn = function() {
            if (!vim.insertMode) {
              cm.setCursor(offsetCursor(cm.getCursor(), 0, 1));
              actions.enterInsertMode(cm, {}, vim);
            }
          };
        }
        return vim.onPasteFn;
      }
  
      var numberRegex = /[\d]/;
      var wordCharTest = [CodeMirror.isWordChar, function(ch) {
        return ch && !CodeMirror.isWordChar(ch) && !/\s/.test(ch);
      }], bigWordCharTest = [function(ch) {
        return /\S/.test(ch);
      }];
      function makeKeyRange(start, size) {
        var keys = [];
        for (var i = start; i < start + size; i++) {
          keys.push(String.fromCharCode(i));
        }
        return keys;
      }
      var upperCaseAlphabet = makeKeyRange(65, 26);
      var lowerCaseAlphabet = makeKeyRange(97, 26);
      var numbers = makeKeyRange(48, 10);
      var validMarks = [].concat(upperCaseAlphabet, lowerCaseAlphabet, numbers, ['<', '>']);
      var validRegisters = [].concat(upperCaseAlphabet, lowerCaseAlphabet, numbers, ['-', '"', '.', ':', '/']);
  
      function isLine(cm, line) {
        return line >= cm.firstLine() && line <= cm.lastLine();
      }
      function isLowerCase(k) {
        return (/^[a-z]$/).test(k);
      }
      function isMatchableSymbol(k) {
        return '()[]{}'.indexOf(k) != -1;
      }
      function isNumber(k) {
        return numberRegex.test(k);
      }
      function isUpperCase(k) {
        return (/^[A-Z]$/).test(k);
      }
      function isWhiteSpaceString(k) {
        return (/^\s*$/).test(k);
      }
      function isEndOfSentenceSymbol(k) {
        return '.?!'.indexOf(k) != -1;
      }
      function inArray(val, arr) {
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] == val) {
            return true;
          }
        }
        return false;
      }
  
      var options = {};
      function defineOption(name, defaultValue, type, aliases, callback) {
        if (defaultValue === undefined && !callback) {
          throw Error('defaultValue is required unless callback is provided');
        }
        if (!type) { type = 'string'; }
        options[name] = {
          type: type,
          defaultValue: defaultValue,
          callback: callback
        };
        if (aliases) {
          for (var i = 0; i < aliases.length; i++) {
            options[aliases[i]] = options[name];
          }
        }
        if (defaultValue) {
          setOption(name, defaultValue);
        }
      }
  
      function setOption(name, value, cm, cfg) {
        var option = options[name];
        cfg = cfg || {};
        var scope = cfg.scope;
        if (!option) {
          return new Error('Unknown option: ' + name);
        }
        if (option.type == 'boolean') {
          if (value && value !== true) {
            return new Error('Invalid argument: ' + name + '=' + value);
          } else if (value !== false) {
            // Boolean options are set to true if value is not defined.
            value = true;
          }
        }
        if (option.callback) {
          if (scope !== 'local') {
            option.callback(value, undefined);
          }
          if (scope !== 'global' && cm) {
            option.callback(value, cm);
          }
        } else {
          if (scope !== 'local') {
            option.value = option.type == 'boolean' ? !!value : value;
          }
          if (scope !== 'global' && cm) {
            cm.state.vim.options[name] = {value: value};
          }
        }
      }
  
      function getOption(name, cm, cfg) {
        var option = options[name];
        cfg = cfg || {};
        var scope = cfg.scope;
        if (!option) {
          return new Error('Unknown option: ' + name);
        }
        if (option.callback) {
          var local = cm && option.callback(undefined, cm);
          if (scope !== 'global' && local !== undefined) {
            return local;
          }
          if (scope !== 'local') {
            return option.callback();
          }
          return;
        } else {
          var local = (scope !== 'global') && (cm && cm.state.vim.options[name]);
          return (local || (scope !== 'local') && option || {}).value;
        }
      }
  
      defineOption('filetype', undefined, 'string', ['ft'], function(name, cm) {
        // Option is local. Do nothing for global.
        if (cm === undefined) {
          return;
        }
        // The 'filetype' option proxies to the CodeMirror 'mode' option.
        if (name === undefined) {
          var mode = cm.getOption('mode');
          return mode == 'null' ? '' : mode;
        } else {
          var mode = name == '' ? 'null' : name;
          cm.setOption('mode', mode);
        }
      });
  
      var createCircularJumpList = function() {
        var size = 100;
        var pointer = -1;
        var head = 0;
        var tail = 0;
        var buffer = new Array(size);
        function add(cm, oldCur, newCur) {
          var current = pointer % size;
          var curMark = buffer[current];
          function useNextSlot(cursor) {
            var next = ++pointer % size;
            var trashMark = buffer[next];
            if (trashMark) {
              trashMark.clear();
            }
            buffer[next] = cm.setBookmark(cursor);
          }
          if (curMark) {
            var markPos = curMark.find();
            // avoid recording redundant cursor position
            if (markPos && !cursorEqual(markPos, oldCur)) {
              useNextSlot(oldCur);
            }
          } else {
            useNextSlot(oldCur);
          }
          useNextSlot(newCur);
          head = pointer;
          tail = pointer - size + 1;
          if (tail < 0) {
            tail = 0;
          }
        }
        function move(cm, offset) {
          pointer += offset;
          if (pointer > head) {
            pointer = head;
          } else if (pointer < tail) {
            pointer = tail;
          }
          var mark = buffer[(size + pointer) % size];
          // skip marks that are temporarily removed from text buffer
          if (mark && !mark.find()) {
            var inc = offset > 0 ? 1 : -1;
            var newCur;
            var oldCur = cm.getCursor();
            do {
              pointer += inc;
              mark = buffer[(size + pointer) % size];
              // skip marks that are the same as current position
              if (mark &&
                  (newCur = mark.find()) &&
                  !cursorEqual(oldCur, newCur)) {
                break;
              }
            } while (pointer < head && pointer > tail);
          }
          return mark;
        }
        function find(cm, offset) {
          var oldPointer = pointer;
          var mark = move(cm, offset);
          pointer = oldPointer;
          return mark && mark.find();
        }
        return {
          cachedCursor: undefined, //used for # and * jumps
          add: add,
          find: find,
          move: move
        };
      };
  
      // Returns an object to track the changes associated insert mode.  It
      // clones the object that is passed in, or creates an empty object one if
      // none is provided.
      var createInsertModeChanges = function(c) {
        if (c) {
          // Copy construction
          return {
            changes: c.changes,
            expectCursorActivityForChange: c.expectCursorActivityForChange
          };
        }
        return {
          // Change list
          changes: [],
          // Set to true on change, false on cursorActivity.
          expectCursorActivityForChange: false
        };
      };
  
      function MacroModeState() {
        this.latestRegister = undefined;
        this.isPlaying = false;
        this.isRecording = false;
        this.replaySearchQueries = [];
        this.onRecordingDone = undefined;
        this.lastInsertModeChanges = createInsertModeChanges();
      }
      MacroModeState.prototype = {
        exitMacroRecordMode: function() {
          var macroModeState = vimGlobalState.macroModeState;
          if (macroModeState.onRecordingDone) {
            macroModeState.onRecordingDone(); // close dialog
          }
          macroModeState.onRecordingDone = undefined;
          macroModeState.isRecording = false;
        },
        enterMacroRecordMode: function(cm, registerName) {
          var register =
              vimGlobalState.registerController.getRegister(registerName);
          if (register) {
            register.clear();
            this.latestRegister = registerName;
            if (cm.openDialog) {
              this.onRecordingDone = cm.openDialog(
                  '(recording)['+registerName+']', null, {bottom:true});
            }
            this.isRecording = true;
          }
        }
      };
  
      function maybeInitVimState(cm) {
        if (!cm.state.vim) {
          // Store instance state in the CodeMirror object.
          cm.state.vim = {
            inputState: new InputState(),
            // Vim's input state that triggered the last edit, used to repeat
            // motions and operators with '.'.
            lastEditInputState: undefined,
            // Vim's action command before the last edit, used to repeat actions
            // with '.' and insert mode repeat.
            lastEditActionCommand: undefined,
            // When using jk for navigation, if you move from a longer line to a
            // shorter line, the cursor may clip to the end of the shorter line.
            // If j is pressed again and cursor goes to the next line, the
            // cursor should go back to its horizontal position on the longer
            // line if it can. This is to keep track of the horizontal position.
            lastHPos: -1,
            // Doing the same with screen-position for gj/gk
            lastHSPos: -1,
            // The last motion command run. Cleared if a non-motion command gets
            // executed in between.
            lastMotion: null,
            marks: {},
            // Mark for rendering fake cursor for visual mode.
            fakeCursor: null,
            insertMode: false,
            // Repeat count for changes made in insert mode, triggered by key
            // sequences like 3,i. Only exists when insertMode is true.
            insertModeRepeat: undefined,
            visualMode: false,
            // If we are in visual line mode. No effect if visualMode is false.
            visualLine: false,
            visualBlock: false,
            lastSelection: null,
            lastPastedText: null,
            sel: {},
            // Buffer-local/window-local values of vim options.
            options: {}
          };
        }
        return cm.state.vim;
      }
      var vimGlobalState;
      function resetVimGlobalState() {
        vimGlobalState = {
          // The current search query.
          searchQuery: null,
          // Whether we are searching backwards.
          searchIsReversed: false,
          // Replace part of the last substituted pattern
          lastSubstituteReplacePart: undefined,
          jumpList: createCircularJumpList(),
          macroModeState: new MacroModeState,
          // Recording latest f, t, F or T motion command.
          lastCharacterSearch: {increment:0, forward:true, selectedCharacter:''},
          registerController: new RegisterController({}),
          // search history buffer
          searchHistoryController: new HistoryController(),
          // ex Command history buffer
          exCommandHistoryController : new HistoryController()
        };
        for (var optionName in options) {
          var option = options[optionName];
          option.value = option.defaultValue;
        }
      }
  
      var lastInsertModeKeyTimer;
      var vimApi= {
        buildKeyMap: function() {
          // TODO: Convert keymap into dictionary format for fast lookup.
        },
        // Testing hook, though it might be useful to expose the register
        // controller anyways.
        getRegisterController: function() {
          return vimGlobalState.registerController;
        },
        // Testing hook.
        resetVimGlobalState_: resetVimGlobalState,
  
        // Testing hook.
        getVimGlobalState_: function() {
          return vimGlobalState;
        },
  
        // Testing hook.
        maybeInitVimState_: maybeInitVimState,
  
        suppressErrorLogging: false,
  
        InsertModeKey: InsertModeKey,
        map: function(lhs, rhs, ctx) {
          // Add user defined key bindings.
          exCommandDispatcher.map(lhs, rhs, ctx);
        },
        unmap: function(lhs, ctx) {
          exCommandDispatcher.unmap(lhs, ctx);
        },
        // Non-recursive map function.
        // NOTE: This will not create mappings to key maps that aren't present
        // in the default key map. See TODO at bottom of function.
        noremap: function(lhs, rhs, ctx) {
          function toCtxArray(ctx) {
            return ctx ? [ctx] : ['normal', 'insert', 'visual'];
          }
          var ctxsToMap = toCtxArray(ctx);
          // Look through all actual defaults to find a map candidate.
          var actualLength = defaultKeymap.length, origLength = defaultKeymapLength;
          for (var i = actualLength - origLength;
               i < actualLength && ctxsToMap.length;
               i++) {
            var mapping = defaultKeymap[i];
            // Omit mappings that operate in the wrong context(s) and those of invalid type.
            if (mapping.keys == rhs &&
                (!ctx || !mapping.context || mapping.context === ctx) &&
                mapping.type.substr(0, 2) !== 'ex' &&
                mapping.type.substr(0, 3) !== 'key') {
              // Make a shallow copy of the original keymap entry.
              var newMapping = {};
              for (var key in mapping) {
                newMapping[key] = mapping[key];
              }
              // Modify it point to the new mapping with the proper context.
              newMapping.keys = lhs;
              if (ctx && !newMapping.context) {
                newMapping.context = ctx;
              }
              // Add it to the keymap with a higher priority than the original.
              this._mapCommand(newMapping);
              // Record the mapped contexts as complete.
              var mappedCtxs = toCtxArray(mapping.context);
              ctxsToMap = ctxsToMap.filter(function(el) { return mappedCtxs.indexOf(el) === -1; });
            }
          }
          // TODO: Create non-recursive keyToKey mappings for the unmapped contexts once those exist.
        },
        // Remove all user-defined mappings for the provided context.
        mapclear: function(ctx) {
          // Partition the existing keymap into user-defined and true defaults.
          var actualLength = defaultKeymap.length,
              origLength = defaultKeymapLength;
          var userKeymap = defaultKeymap.slice(0, actualLength - origLength);
          defaultKeymap = defaultKeymap.slice(actualLength - origLength);
          if (ctx) {
            // If a specific context is being cleared, we need to keep mappings
            // from all other contexts.
            for (var i = userKeymap.length - 1; i >= 0; i--) {
              var mapping = userKeymap[i];
              if (ctx !== mapping.context) {
                if (mapping.context) {
                  this._mapCommand(mapping);
                } else {
                  // `mapping` applies to all contexts so create keymap copies
                  // for each context except the one being cleared.
                  var contexts = ['normal', 'insert', 'visual'];
                  for (var j in contexts) {
                    if (contexts[j] !== ctx) {
                      var newMapping = {};
                      for (var key in mapping) {
                        newMapping[key] = mapping[key];
                      }
                      newMapping.context = contexts[j];
                      this._mapCommand(newMapping);
                    }
                  }
                }
              }
            }
          }
        },
        // TODO: Expose setOption and getOption as instance methods. Need to decide how to namespace
        // them, or somehow make them work with the existing CodeMirror setOption/getOption API.
        setOption: setOption,
        getOption: getOption,
        defineOption: defineOption,
        defineEx: function(name, prefix, func){
          if (!prefix) {
            prefix = name;
          } else if (name.indexOf(prefix) !== 0) {
            throw new Error('(Vim.defineEx) "'+prefix+'" is not a prefix of "'+name+'", command not registered');
          }
          exCommands[name]=func;
          exCommandDispatcher.commandMap_[prefix]={name:name, shortName:prefix, type:'api'};
        },
        handleKey: function (cm, key, origin) {
          var command = this.findKey(cm, key, origin);
          if (typeof command === 'function') {
            return command();
          }
        },
        /**
         * This is the outermost function called by CodeMirror, after keys have
         * been mapped to their Vim equivalents.
         *
         * Finds a command based on the key (and cached keys if there is a
         * multi-key sequence). Returns `undefined` if no key is matched, a noop
         * function if a partial match is found (multi-key), and a function to
         * execute the bound command if a a key is matched. The function always
         * returns true.
         */
        findKey: function(cm, key, origin) {
          var vim = maybeInitVimState(cm);
          function handleMacroRecording() {
            var macroModeState = vimGlobalState.macroModeState;
            if (macroModeState.isRecording) {
              if (key == 'q') {
                macroModeState.exitMacroRecordMode();
                clearInputState(cm);
                return true;
              }
              if (origin != 'mapping') {
                logKey(macroModeState, key);
              }
            }
          }
          function handleEsc() {
            if (key == '<Esc>') {
              // Clear input state and get back to normal mode.
              clearInputState(cm);
              if (vim.visualMode) {
                exitVisualMode(cm);
              } else if (vim.insertMode) {
                exitInsertMode(cm);
              }
              return true;
            }
          }
          function doKeyToKey(keys) {
            // TODO: prevent infinite recursion.
            var match;
            while (keys) {
              // Pull off one command key, which is either a single character
              // or a special sequence wrapped in '<' and '>', e.g. '<Space>'.
              match = (/<\w+-.+?>|<\w+>|./).exec(keys);
              key = match[0];
              keys = keys.substring(match.index + key.length);
              CodeMirror.Vim.handleKey(cm, key, 'mapping');
            }
          }
  
          function handleKeyInsertMode() {
            if (handleEsc()) { return true; }
            var keys = vim.inputState.keyBuffer = vim.inputState.keyBuffer + key;
            var keysAreChars = key.length == 1;
            var match = commandDispatcher.matchCommand(keys, defaultKeymap, vim.inputState, 'insert');
            // Need to check all key substrings in insert mode.
            while (keys.length > 1 && match.type != 'full') {
              var keys = vim.inputState.keyBuffer = keys.slice(1);
              var thisMatch = commandDispatcher.matchCommand(keys, defaultKeymap, vim.inputState, 'insert');
              if (thisMatch.type != 'none') { match = thisMatch; }
            }
            if (match.type == 'none') { clearInputState(cm); return false; }
            else if (match.type == 'partial') {
              if (lastInsertModeKeyTimer) { window.clearTimeout(lastInsertModeKeyTimer); }
              lastInsertModeKeyTimer = window.setTimeout(
                function() { if (vim.insertMode && vim.inputState.keyBuffer) { clearInputState(cm); } },
                getOption('insertModeEscKeysTimeout'));
              return !keysAreChars;
            }
  
            if (lastInsertModeKeyTimer) { window.clearTimeout(lastInsertModeKeyTimer); }
            if (keysAreChars) {
              var selections = cm.listSelections();
              for (var i = 0; i < selections.length; i++) {
                var here = selections[i].head;
                cm.replaceRange('', offsetCursor(here, 0, -(keys.length - 1)), here, '+input');
              }
              vimGlobalState.macroModeState.lastInsertModeChanges.changes.pop();
            }
            clearInputState(cm);
            return match.command;
          }
  
          function handleKeyNonInsertMode() {
            if (handleMacroRecording() || handleEsc()) { return true; }
  
            var keys = vim.inputState.keyBuffer = vim.inputState.keyBuffer + key;
            if (/^[1-9]\d*$/.test(keys)) { return true; }
  
            var keysMatcher = /^(\d*)(.*)$/.exec(keys);
            if (!keysMatcher) { clearInputState(cm); return false; }
            var context = vim.visualMode ? 'visual' :
                                           'normal';
            var match = commandDispatcher.matchCommand(keysMatcher[2] || keysMatcher[1], defaultKeymap, vim.inputState, context);
            if (match.type == 'none') { clearInputState(cm); return false; }
            else if (match.type == 'partial') { return true; }
  
            vim.inputState.keyBuffer = '';
            var keysMatcher = /^(\d*)(.*)$/.exec(keys);
            if (keysMatcher[1] && keysMatcher[1] != '0') {
              vim.inputState.pushRepeatDigit(keysMatcher[1]);
            }
            return match.command;
          }
  
          var command;
          if (vim.insertMode) { command = handleKeyInsertMode(); }
          else { command = handleKeyNonInsertMode(); }
          if (command === false) {
            return !vim.insertMode && key.length === 1 ? function() { return true; } : undefined;
          } else if (command === true) {
            // TODO: Look into using CodeMirror's multi-key handling.
            // Return no-op since we are caching the key. Counts as handled, but
            // don't want act on it just yet.
            return function() { return true; };
          } else {
            return function() {
              return cm.operation(function() {
                cm.curOp.isVimOp = true;
                try {
                  if (command.type == 'keyToKey') {
                    doKeyToKey(command.toKeys);
                  } else {
                    commandDispatcher.processCommand(cm, vim, command);
                  }
                } catch (e) {
                  // clear VIM state in case it's in a bad state.
                  cm.state.vim = undefined;
                  maybeInitVimState(cm);
                  if (!CodeMirror.Vim.suppressErrorLogging) {
                    console['log'](e);
                  }
                  throw e;
                }
                return true;
              });
            };
          }
        },
        handleEx: function(cm, input) {
          exCommandDispatcher.processCommand(cm, input);
        },
  
        defineMotion: defineMotion,
        defineAction: defineAction,
        defineOperator: defineOperator,
        mapCommand: mapCommand,
        _mapCommand: _mapCommand,
  
        defineRegister: defineRegister,
  
        exitVisualMode: exitVisualMode,
        exitInsertMode: exitInsertMode
      };
  
      // Represents the current input state.
      function InputState() {
        this.prefixRepeat = [];
        this.motionRepeat = [];
  
        this.operator = null;
        this.operatorArgs = null;
        this.motion = null;
        this.motionArgs = null;
        this.keyBuffer = []; // For matching multi-key commands.
        this.registerName = null; // Defaults to the unnamed register.
      }
      InputState.prototype.pushRepeatDigit = function(n) {
        if (!this.operator) {
          this.prefixRepeat = this.prefixRepeat.concat(n);
        } else {
          this.motionRepeat = this.motionRepeat.concat(n);
        }
      };
      InputState.prototype.getRepeat = function() {
        var repeat = 0;
        if (this.prefixRepeat.length > 0 || this.motionRepeat.length > 0) {
          repeat = 1;
          if (this.prefixRepeat.length > 0) {
            repeat *= parseInt(this.prefixRepeat.join(''), 10);
          }
          if (this.motionRepeat.length > 0) {
            repeat *= parseInt(this.motionRepeat.join(''), 10);
          }
        }
        return repeat;
      };
  
      function clearInputState(cm, reason) {
        cm.state.vim.inputState = new InputState();
        CodeMirror.signal(cm, 'vim-command-done', reason);
      }
  
      /*
       * Register stores information about copy and paste registers.  Besides
       * text, a register must store whether it is linewise (i.e., when it is
       * pasted, should it insert itself into a new line, or should the text be
       * inserted at the cursor position.)
       */
      function Register(text, linewise, blockwise) {
        this.clear();
        this.keyBuffer = [text || ''];
        this.insertModeChanges = [];
        this.searchQueries = [];
        this.linewise = !!linewise;
        this.blockwise = !!blockwise;
      }
      Register.prototype = {
        setText: function(text, linewise, blockwise) {
          this.keyBuffer = [text || ''];
          this.linewise = !!linewise;
          this.blockwise = !!blockwise;
        },
        pushText: function(text, linewise) {
          // if this register has ever been set to linewise, use linewise.
          if (linewise) {
            if (!this.linewise) {
              this.keyBuffer.push('\n');
            }
            this.linewise = true;
          }
          this.keyBuffer.push(text);
        },
        pushInsertModeChanges: function(changes) {
          this.insertModeChanges.push(createInsertModeChanges(changes));
        },
        pushSearchQuery: function(query) {
          this.searchQueries.push(query);
        },
        clear: function() {
          this.keyBuffer = [];
          this.insertModeChanges = [];
          this.searchQueries = [];
          this.linewise = false;
        },
        toString: function() {
          return this.keyBuffer.join('');
        }
      };
  
      /**
       * Defines an external register.
       *
       * The name should be a single character that will be used to reference the register.
       * The register should support setText, pushText, clear, and toString(). See Register
       * for a reference implementation.
       */
      function defineRegister(name, register) {
        var registers = vimGlobalState.registerController.registers;
        if (!name || name.length != 1) {
          throw Error('Register name must be 1 character');
        }
        if (registers[name]) {
          throw Error('Register already defined ' + name);
        }
        registers[name] = register;
        validRegisters.push(name);
      }
  
      /*
       * vim registers allow you to keep many independent copy and paste buffers.
       * See http://usevim.com/2012/04/13/registers/ for an introduction.
       *
       * RegisterController keeps the state of all the registers.  An initial
       * state may be passed in.  The unnamed register '"' will always be
       * overridden.
       */
      function RegisterController(registers) {
        this.registers = registers;
        this.unnamedRegister = registers['"'] = new Register();
        registers['.'] = new Register();
        registers[':'] = new Register();
        registers['/'] = new Register();
      }
      RegisterController.prototype = {
        pushText: function(registerName, operator, text, linewise, blockwise) {
          if (linewise && text.charAt(text.length - 1) !== '\n'){
            text += '\n';
          }
          // Lowercase and uppercase registers refer to the same register.
          // Uppercase just means append.
          var register = this.isValidRegister(registerName) ?
              this.getRegister(registerName) : null;
          // if no register/an invalid register was specified, things go to the
          // default registers
          if (!register) {
            switch (operator) {
              case 'yank':
                // The 0 register contains the text from the most recent yank.
                this.registers['0'] = new Register(text, linewise, blockwise);
                break;
              case 'delete':
              case 'change':
                if (text.indexOf('\n') == -1) {
                  // Delete less than 1 line. Update the small delete register.
                  this.registers['-'] = new Register(text, linewise);
                } else {
                  // Shift down the contents of the numbered registers and put the
                  // deleted text into register 1.
                  this.shiftNumericRegisters_();
                  this.registers['1'] = new Register(text, linewise);
                }
                break;
            }
            // Make sure the unnamed register is set to what just happened
            this.unnamedRegister.setText(text, linewise, blockwise);
            return;
          }
  
          // If we've gotten to this point, we've actually specified a register
          var append = isUpperCase(registerName);
          if (append) {
            register.pushText(text, linewise);
          } else {
            register.setText(text, linewise, blockwise);
          }
          // The unnamed register always has the same value as the last used
          // register.
          this.unnamedRegister.setText(register.toString(), linewise);
        },
        // Gets the register named @name.  If one of @name doesn't already exist,
        // create it.  If @name is invalid, return the unnamedRegister.
        getRegister: function(name) {
          if (!this.isValidRegister(name)) {
            return this.unnamedRegister;
          }
          name = name.toLowerCase();
          if (!this.registers[name]) {
            this.registers[name] = new Register();
          }
          return this.registers[name];
        },
        isValidRegister: function(name) {
          return name && inArray(name, validRegisters);
        },
        shiftNumericRegisters_: function() {
          for (var i = 9; i >= 2; i--) {
            this.registers[i] = this.getRegister('' + (i - 1));
          }
        }
      };
      function HistoryController() {
          this.historyBuffer = [];
          this.iterator = 0;
          this.initialPrefix = null;
      }
      HistoryController.prototype = {
        // the input argument here acts a user entered prefix for a small time
        // until we start autocompletion in which case it is the autocompleted.
        nextMatch: function (input, up) {
          var historyBuffer = this.historyBuffer;
          var dir = up ? -1 : 1;
          if (this.initialPrefix === null) this.initialPrefix = input;
          for (var i = this.iterator + dir; up ? i >= 0 : i < historyBuffer.length; i+= dir) {
            var element = historyBuffer[i];
            for (var j = 0; j <= element.length; j++) {
              if (this.initialPrefix == element.substring(0, j)) {
                this.iterator = i;
                return element;
              }
            }
          }
          // should return the user input in case we reach the end of buffer.
          if (i >= historyBuffer.length) {
            this.iterator = historyBuffer.length;
            return this.initialPrefix;
          }
          // return the last autocompleted query or exCommand as it is.
          if (i < 0 ) return input;
        },
        pushInput: function(input) {
          var index = this.historyBuffer.indexOf(input);
          if (index > -1) this.historyBuffer.splice(index, 1);
          if (input.length) this.historyBuffer.push(input);
        },
        reset: function() {
          this.initialPrefix = null;
          this.iterator = this.historyBuffer.length;
        }
      };
      var commandDispatcher = {
        matchCommand: function(keys, keyMap, inputState, context) {
          var matches = commandMatches(keys, keyMap, context, inputState);
          if (!matches.full && !matches.partial) {
            return {type: 'none'};
          } else if (!matches.full && matches.partial) {
            return {type: 'partial'};
          }
  
          var bestMatch;
          for (var i = 0; i < matches.full.length; i++) {
            var match = matches.full[i];
            if (!bestMatch) {
              bestMatch = match;
            }
          }
          if (bestMatch.keys.slice(-11) == '<character>') {
            var character = lastChar(keys);
            if (!character) return {type: 'none'};
            inputState.selectedCharacter = character;
          }
          return {type: 'full', command: bestMatch};
        },
        processCommand: function(cm, vim, command) {
          vim.inputState.repeatOverride = command.repeatOverride;
          switch (command.type) {
            case 'motion':
              this.processMotion(cm, vim, command);
              break;
            case 'operator':
              this.processOperator(cm, vim, command);
              break;
            case 'operatorMotion':
              this.processOperatorMotion(cm, vim, command);
              break;
            case 'action':
              this.processAction(cm, vim, command);
              break;
            case 'search':
              this.processSearch(cm, vim, command);
              break;
            case 'ex':
            case 'keyToEx':
              this.processEx(cm, vim, command);
              break;
            default:
              break;
          }
        },
        processMotion: function(cm, vim, command) {
          vim.inputState.motion = command.motion;
          vim.inputState.motionArgs = copyArgs(command.motionArgs);
          this.evalInput(cm, vim);
        },
        processOperator: function(cm, vim, command) {
          var inputState = vim.inputState;
          if (inputState.operator) {
            if (inputState.operator == command.operator) {
              // Typing an operator twice like 'dd' makes the operator operate
              // linewise
              inputState.motion = 'expandToLine';
              inputState.motionArgs = { linewise: true };
              this.evalInput(cm, vim);
              return;
            } else {
              // 2 different operators in a row doesn't make sense.
              clearInputState(cm);
            }
          }
          inputState.operator = command.operator;
          inputState.operatorArgs = copyArgs(command.operatorArgs);
          if (command.exitVisualBlock) {
              vim.visualBlock = false;
              updateCmSelection(cm);
          }
          if (vim.visualMode) {
            // Operating on a selection in visual mode. We don't need a motion.
            this.evalInput(cm, vim);
          }
        },
        processOperatorMotion: function(cm, vim, command) {
          var visualMode = vim.visualMode;
          var operatorMotionArgs = copyArgs(command.operatorMotionArgs);
          if (operatorMotionArgs) {
            // Operator motions may have special behavior in visual mode.
            if (visualMode && operatorMotionArgs.visualLine) {
              vim.visualLine = true;
            }
          }
          this.processOperator(cm, vim, command);
          if (!visualMode) {
            this.processMotion(cm, vim, command);
          }
        },
        processAction: function(cm, vim, command) {
          var inputState = vim.inputState;
          var repeat = inputState.getRepeat();
          var repeatIsExplicit = !!repeat;
          var actionArgs = copyArgs(command.actionArgs) || {};
          if (inputState.selectedCharacter) {
            actionArgs.selectedCharacter = inputState.selectedCharacter;
          }
          // Actions may or may not have motions and operators. Do these first.
          if (command.operator) {
            this.processOperator(cm, vim, command);
          }
          if (command.motion) {
            this.processMotion(cm, vim, command);
          }
          if (command.motion || command.operator) {
            this.evalInput(cm, vim);
          }
          actionArgs.repeat = repeat || 1;
          actionArgs.repeatIsExplicit = repeatIsExplicit;
          actionArgs.registerName = inputState.registerName;
          clearInputState(cm);
          vim.lastMotion = null;
          if (command.isEdit) {
            this.recordLastEdit(vim, inputState, command);
          }
          actions[command.action](cm, actionArgs, vim);
        },
        processSearch: function(cm, vim, command) {
          if (!cm.getSearchCursor) {
            // Search depends on SearchCursor.
            return;
          }
          var forward = command.searchArgs.forward;
          var wholeWordOnly = command.searchArgs.wholeWordOnly;
          getSearchState(cm).setReversed(!forward);
          var promptPrefix = (forward) ? '/' : '?';
          var originalQuery = getSearchState(cm).getQuery();
          var originalScrollPos = cm.getScrollInfo();
          function handleQuery(query, ignoreCase, smartCase) {
            vimGlobalState.searchHistoryController.pushInput(query);
            vimGlobalState.searchHistoryController.reset();
            try {
              updateSearchQuery(cm, query, ignoreCase, smartCase);
            } catch (e) {
              showConfirm(cm, 'Invalid regex: ' + query);
              clearInputState(cm);
              return;
            }
            commandDispatcher.processMotion(cm, vim, {
              type: 'motion',
              motion: 'findNext',
              motionArgs: { forward: true, toJumplist: command.searchArgs.toJumplist }
            });
          }
          function onPromptClose(query) {
            cm.scrollTo(originalScrollPos.left, originalScrollPos.top);
            handleQuery(query, true /** ignoreCase */, true /** smartCase */);
            var macroModeState = vimGlobalState.macroModeState;
            if (macroModeState.isRecording) {
              logSearchQuery(macroModeState, query);
            }
          }
          function onPromptKeyUp(e, query, close) {
            var keyName = CodeMirror.keyName(e), up, offset;
            if (keyName == 'Up' || keyName == 'Down') {
              up = keyName == 'Up' ? true : false;
              offset = e.target ? e.target.selectionEnd : 0;
              query = vimGlobalState.searchHistoryController.nextMatch(query, up) || '';
              close(query);
              if (offset && e.target) e.target.selectionEnd = e.target.selectionStart = Math.min(offset, e.target.value.length);
            } else {
              if ( keyName != 'Left' && keyName != 'Right' && keyName != 'Ctrl' && keyName != 'Alt' && keyName != 'Shift')
                vimGlobalState.searchHistoryController.reset();
            }
            var parsedQuery;
            try {
              parsedQuery = updateSearchQuery(cm, query,
                  true /** ignoreCase */, true /** smartCase */);
            } catch (e) {
              // Swallow bad regexes for incremental search.
            }
            if (parsedQuery) {
              cm.scrollIntoView(findNext(cm, !forward, parsedQuery), 30);
            } else {
              clearSearchHighlight(cm);
              cm.scrollTo(originalScrollPos.left, originalScrollPos.top);
            }
          }
          function onPromptKeyDown(e, query, close) {
            var keyName = CodeMirror.keyName(e);
            if (keyName == 'Esc' || keyName == 'Ctrl-C' || keyName == 'Ctrl-[' ||
                (keyName == 'Backspace' && query == '')) {
              vimGlobalState.searchHistoryController.pushInput(query);
              vimGlobalState.searchHistoryController.reset();
              updateSearchQuery(cm, originalQuery);
              clearSearchHighlight(cm);
              cm.scrollTo(originalScrollPos.left, originalScrollPos.top);
              CodeMirror.e_stop(e);
              clearInputState(cm);
              close();
              cm.focus();
            } else if (keyName == 'Up' || keyName == 'Down') {
              CodeMirror.e_stop(e);
            } else if (keyName == 'Ctrl-U') {
              // Ctrl-U clears input.
              CodeMirror.e_stop(e);
              close('');
            }
          }
          switch (command.searchArgs.querySrc) {
            case 'prompt':
              var macroModeState = vimGlobalState.macroModeState;
              if (macroModeState.isPlaying) {
                var query = macroModeState.replaySearchQueries.shift();
                handleQuery(query, true /** ignoreCase */, false /** smartCase */);
              } else {
                showPrompt(cm, {
                    onClose: onPromptClose,
                    prefix: promptPrefix,
                    desc: searchPromptDesc,
                    onKeyUp: onPromptKeyUp,
                    onKeyDown: onPromptKeyDown
                });
              }
              break;
            case 'wordUnderCursor':
              var word = expandWordUnderCursor(cm, false /** inclusive */,
                  true /** forward */, false /** bigWord */,
                  true /** noSymbol */);
              var isKeyword = true;
              if (!word) {
                word = expandWordUnderCursor(cm, false /** inclusive */,
                    true /** forward */, false /** bigWord */,
                    false /** noSymbol */);
                isKeyword = false;
              }
              if (!word) {
                return;
              }
              var query = cm.getLine(word.start.line).substring(word.start.ch,
                  word.end.ch);
              if (isKeyword && wholeWordOnly) {
                  query = '\\b' + query + '\\b';
              } else {
                query = escapeRegex(query);
              }
  
              // cachedCursor is used to save the old position of the cursor
              // when * or # causes vim to seek for the nearest word and shift
              // the cursor before entering the motion.
              vimGlobalState.jumpList.cachedCursor = cm.getCursor();
              cm.setCursor(word.start);
  
              handleQuery(query, true /** ignoreCase */, false /** smartCase */);
              break;
          }
        },
        processEx: function(cm, vim, command) {
          function onPromptClose(input) {
            // Give the prompt some time to close so that if processCommand shows
            // an error, the elements don't overlap.
            vimGlobalState.exCommandHistoryController.pushInput(input);
            vimGlobalState.exCommandHistoryController.reset();
            exCommandDispatcher.processCommand(cm, input);
          }
          function onPromptKeyDown(e, input, close) {
            var keyName = CodeMirror.keyName(e), up, offset;
            if (keyName == 'Esc' || keyName == 'Ctrl-C' || keyName == 'Ctrl-[' ||
                (keyName == 'Backspace' && input == '')) {
              vimGlobalState.exCommandHistoryController.pushInput(input);
              vimGlobalState.exCommandHistoryController.reset();
              CodeMirror.e_stop(e);
              clearInputState(cm);
              close();
              cm.focus();
            }
            if (keyName == 'Up' || keyName == 'Down') {
              CodeMirror.e_stop(e);
              up = keyName == 'Up' ? true : false;
              offset = e.target ? e.target.selectionEnd : 0;
              input = vimGlobalState.exCommandHistoryController.nextMatch(input, up) || '';
              close(input);
              if (offset && e.target) e.target.selectionEnd = e.target.selectionStart = Math.min(offset, e.target.value.length);
            } else if (keyName == 'Ctrl-U') {
              // Ctrl-U clears input.
              CodeMirror.e_stop(e);
              close('');
            } else {
              if ( keyName != 'Left' && keyName != 'Right' && keyName != 'Ctrl' && keyName != 'Alt' && keyName != 'Shift')
                vimGlobalState.exCommandHistoryController.reset();
            }
          }
          if (command.type == 'keyToEx') {
            // Handle user defined Ex to Ex mappings
            exCommandDispatcher.processCommand(cm, command.exArgs.input);
          } else {
            if (vim.visualMode) {
              showPrompt(cm, { onClose: onPromptClose, prefix: ':', value: '\'<,\'>',
                  onKeyDown: onPromptKeyDown, selectValueOnOpen: false});
            } else {
              showPrompt(cm, { onClose: onPromptClose, prefix: ':',
                  onKeyDown: onPromptKeyDown});
            }
          }
        },
        evalInput: function(cm, vim) {
          // If the motion command is set, execute both the operator and motion.
          // Otherwise return.
          var inputState = vim.inputState;
          var motion = inputState.motion;
          var motionArgs = inputState.motionArgs || {};
          var operator = inputState.operator;
          var operatorArgs = inputState.operatorArgs || {};
          var registerName = inputState.registerName;
          var sel = vim.sel;
          // TODO: Make sure cm and vim selections are identical outside visual mode.
          var origHead = copyCursor(vim.visualMode ? clipCursorToContent(cm, sel.head): cm.getCursor('head'));
          var origAnchor = copyCursor(vim.visualMode ? clipCursorToContent(cm, sel.anchor) : cm.getCursor('anchor'));
          var oldHead = copyCursor(origHead);
          var oldAnchor = copyCursor(origAnchor);
          var newHead, newAnchor;
          var repeat;
          if (operator) {
            this.recordLastEdit(vim, inputState);
          }
          if (inputState.repeatOverride !== undefined) {
            // If repeatOverride is specified, that takes precedence over the
            // input state's repeat. Used by Ex mode and can be user defined.
            repeat = inputState.repeatOverride;
          } else {
            repeat = inputState.getRepeat();
          }
          if (repeat > 0 && motionArgs.explicitRepeat) {
            motionArgs.repeatIsExplicit = true;
          } else if (motionArgs.noRepeat ||
              (!motionArgs.explicitRepeat && repeat === 0)) {
            repeat = 1;
            motionArgs.repeatIsExplicit = false;
          }
          if (inputState.selectedCharacter) {
            // If there is a character input, stick it in all of the arg arrays.
            motionArgs.selectedCharacter = operatorArgs.selectedCharacter =
                inputState.selectedCharacter;
          }
          motionArgs.repeat = repeat;
          clearInputState(cm);
          if (motion) {
            var motionResult = motions[motion](cm, origHead, motionArgs, vim);
            vim.lastMotion = motions[motion];
            if (!motionResult) {
              return;
            }
            if (motionArgs.toJumplist) {
              var jumpList = vimGlobalState.jumpList;
              // if the current motion is # or *, use cachedCursor
              var cachedCursor = jumpList.cachedCursor;
              if (cachedCursor) {
                recordJumpPosition(cm, cachedCursor, motionResult);
                delete jumpList.cachedCursor;
              } else {
                recordJumpPosition(cm, origHead, motionResult);
              }
            }
            if (motionResult instanceof Array) {
              newAnchor = motionResult[0];
              newHead = motionResult[1];
            } else {
              newHead = motionResult;
            }
            // TODO: Handle null returns from motion commands better.
            if (!newHead) {
              newHead = copyCursor(origHead);
            }
            if (vim.visualMode) {
              if (!(vim.visualBlock && newHead.ch === Infinity)) {
                newHead = clipCursorToContent(cm, newHead);
              }
              if (newAnchor) {
                newAnchor = clipCursorToContent(cm, newAnchor);
              }
              newAnchor = newAnchor || oldAnchor;
              sel.anchor = newAnchor;
              sel.head = newHead;
              updateCmSelection(cm);
              updateMark(cm, vim, '<',
                  cursorIsBefore(newAnchor, newHead) ? newAnchor
                      : newHead);
              updateMark(cm, vim, '>',
                  cursorIsBefore(newAnchor, newHead) ? newHead
                      : newAnchor);
            } else if (!operator) {
              newHead = clipCursorToContent(cm, newHead);
              cm.setCursor(newHead.line, newHead.ch);
            }
          }
          if (operator) {
            if (operatorArgs.lastSel) {
              // Replaying a visual mode operation
              newAnchor = oldAnchor;
              var lastSel = operatorArgs.lastSel;
              var lineOffset = Math.abs(lastSel.head.line - lastSel.anchor.line);
              var chOffset = Math.abs(lastSel.head.ch - lastSel.anchor.ch);
              if (lastSel.visualLine) {
                // Linewise Visual mode: The same number of lines.
                newHead = Pos(oldAnchor.line + lineOffset, oldAnchor.ch);
              } else if (lastSel.visualBlock) {
                // Blockwise Visual mode: The same number of lines and columns.
                newHead = Pos(oldAnchor.line + lineOffset, oldAnchor.ch + chOffset);
              } else if (lastSel.head.line == lastSel.anchor.line) {
                // Normal Visual mode within one line: The same number of characters.
                newHead = Pos(oldAnchor.line, oldAnchor.ch + chOffset);
              } else {
                // Normal Visual mode with several lines: The same number of lines, in the
                // last line the same number of characters as in the last line the last time.
                newHead = Pos(oldAnchor.line + lineOffset, oldAnchor.ch);
              }
              vim.visualMode = true;
              vim.visualLine = lastSel.visualLine;
              vim.visualBlock = lastSel.visualBlock;
              sel = vim.sel = {
                anchor: newAnchor,
                head: newHead
              };
              updateCmSelection(cm);
            } else if (vim.visualMode) {
              operatorArgs.lastSel = {
                anchor: copyCursor(sel.anchor),
                head: copyCursor(sel.head),
                visualBlock: vim.visualBlock,
                visualLine: vim.visualLine
              };
            }
            var curStart, curEnd, linewise, mode;
            var cmSel;
            if (vim.visualMode) {
              // Init visual op
              curStart = cursorMin(sel.head, sel.anchor);
              curEnd = cursorMax(sel.head, sel.anchor);
              linewise = vim.visualLine || operatorArgs.linewise;
              mode = vim.visualBlock ? 'block' :
                     linewise ? 'line' :
                     'char';
              cmSel = makeCmSelection(cm, {
                anchor: curStart,
                head: curEnd
              }, mode);
              if (linewise) {
                var ranges = cmSel.ranges;
                if (mode == 'block') {
                  // Linewise operators in visual block mode extend to end of line
                  for (var i = 0; i < ranges.length; i++) {
                    ranges[i].head.ch = lineLength(cm, ranges[i].head.line);
                  }
                } else if (mode == 'line') {
                  ranges[0].head = Pos(ranges[0].head.line + 1, 0);
                }
              }
            } else {
              // Init motion op
              curStart = copyCursor(newAnchor || oldAnchor);
              curEnd = copyCursor(newHead || oldHead);
              if (cursorIsBefore(curEnd, curStart)) {
                var tmp = curStart;
                curStart = curEnd;
                curEnd = tmp;
              }
              linewise = motionArgs.linewise || operatorArgs.linewise;
              if (linewise) {
                // Expand selection to entire line.
                expandSelectionToLine(cm, curStart, curEnd);
              } else if (motionArgs.forward) {
                // Clip to trailing newlines only if the motion goes forward.
                clipToLine(cm, curStart, curEnd);
              }
              mode = 'char';
              var exclusive = !motionArgs.inclusive || linewise;
              cmSel = makeCmSelection(cm, {
                anchor: curStart,
                head: curEnd
              }, mode, exclusive);
            }
            cm.setSelections(cmSel.ranges, cmSel.primary);
            vim.lastMotion = null;
            operatorArgs.repeat = repeat; // For indent in visual mode.
            operatorArgs.registerName = registerName;
            // Keep track of linewise as it affects how paste and change behave.
            operatorArgs.linewise = linewise;
            var operatorMoveTo = operators[operator](
              cm, operatorArgs, cmSel.ranges, oldAnchor, newHead);
            if (vim.visualMode) {
              exitVisualMode(cm, operatorMoveTo != null);
            }
            if (operatorMoveTo) {
              cm.setCursor(operatorMoveTo);
            }
          }
        },
        recordLastEdit: function(vim, inputState, actionCommand) {
          var macroModeState = vimGlobalState.macroModeState;
          if (macroModeState.isPlaying) { return; }
          vim.lastEditInputState = inputState;
          vim.lastEditActionCommand = actionCommand;
          macroModeState.lastInsertModeChanges.changes = [];
          macroModeState.lastInsertModeChanges.expectCursorActivityForChange = false;
          macroModeState.lastInsertModeChanges.visualBlock = vim.visualBlock ? vim.sel.head.line - vim.sel.anchor.line : 0;
        }
      };
  
      /**
       * typedef {Object{line:number,ch:number}} Cursor An object containing the
       *     position of the cursor.
       */
      // All of the functions below return Cursor objects.
      var motions = {
        moveToTopLine: function(cm, _head, motionArgs) {
          var line = getUserVisibleLines(cm).top + motionArgs.repeat -1;
          return Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)));
        },
        moveToMiddleLine: function(cm) {
          var range = getUserVisibleLines(cm);
          var line = Math.floor((range.top + range.bottom) * 0.5);
          return Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)));
        },
        moveToBottomLine: function(cm, _head, motionArgs) {
          var line = getUserVisibleLines(cm).bottom - motionArgs.repeat +1;
          return Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)));
        },
        expandToLine: function(_cm, head, motionArgs) {
          // Expands forward to end of line, and then to next line if repeat is
          // >1. Does not handle backward motion!
          var cur = head;
          return Pos(cur.line + motionArgs.repeat - 1, Infinity);
        },
        findNext: function(cm, _head, motionArgs) {
          var state = getSearchState(cm);
          var query = state.getQuery();
          if (!query) {
            return;
          }
          var prev = !motionArgs.forward;
          // If search is initiated with ? instead of /, negate direction.
          prev = (state.isReversed()) ? !prev : prev;
          highlightSearchMatches(cm, query);
          return findNext(cm, prev/** prev */, query, motionArgs.repeat);
        },
        goToMark: function(cm, _head, motionArgs, vim) {
          var pos = getMarkPos(cm, vim, motionArgs.selectedCharacter);
          if (pos) {
            return motionArgs.linewise ? { line: pos.line, ch: findFirstNonWhiteSpaceCharacter(cm.getLine(pos.line)) } : pos;
          }
          return null;
        },
        moveToOtherHighlightedEnd: function(cm, _head, motionArgs, vim) {
          if (vim.visualBlock && motionArgs.sameLine) {
            var sel = vim.sel;
            return [
              clipCursorToContent(cm, Pos(sel.anchor.line, sel.head.ch)),
              clipCursorToContent(cm, Pos(sel.head.line, sel.anchor.ch))
            ];
          } else {
            return ([vim.sel.head, vim.sel.anchor]);
          }
        },
        jumpToMark: function(cm, head, motionArgs, vim) {
          var best = head;
          for (var i = 0; i < motionArgs.repeat; i++) {
            var cursor = best;
            for (var key in vim.marks) {
              if (!isLowerCase(key)) {
                continue;
              }
              var mark = vim.marks[key].find();
              var isWrongDirection = (motionArgs.forward) ?
                cursorIsBefore(mark, cursor) : cursorIsBefore(cursor, mark);
  
              if (isWrongDirection) {
                continue;
              }
              if (motionArgs.linewise && (mark.line == cursor.line)) {
                continue;
              }
  
              var equal = cursorEqual(cursor, best);
              var between = (motionArgs.forward) ?
                cursorIsBetween(cursor, mark, best) :
                cursorIsBetween(best, mark, cursor);
  
              if (equal || between) {
                best = mark;
              }
            }
          }
  
          if (motionArgs.linewise) {
            // Vim places the cursor on the first non-whitespace character of
            // the line if there is one, else it places the cursor at the end
            // of the line, regardless of whether a mark was found.
            best = Pos(best.line, findFirstNonWhiteSpaceCharacter(cm.getLine(best.line)));
          }
          return best;
        },
        moveByCharacters: function(_cm, head, motionArgs) {
          var cur = head;
          var repeat = motionArgs.repeat;
          var ch = motionArgs.forward ? cur.ch + repeat : cur.ch - repeat;
          return Pos(cur.line, ch);
        },
        moveByLines: function(cm, head, motionArgs, vim) {
          var cur = head;
          var endCh = cur.ch;
          // Depending what our last motion was, we may want to do different
          // things. If our last motion was moving vertically, we want to
          // preserve the HPos from our last horizontal move.  If our last motion
          // was going to the end of a line, moving vertically we should go to
          // the end of the line, etc.
          switch (vim.lastMotion) {
            case this.moveByLines:
            case this.moveByDisplayLines:
            case this.moveByScroll:
            case this.moveToColumn:
            case this.moveToEol:
              endCh = vim.lastHPos;
              break;
            default:
              vim.lastHPos = endCh;
          }
          var repeat = motionArgs.repeat+(motionArgs.repeatOffset||0);
          var line = motionArgs.forward ? cur.line + repeat : cur.line - repeat;
          var first = cm.firstLine();
          var last = cm.lastLine();
          var posV = cm.findPosV(cur, (motionArgs.forward ? repeat : -repeat), 'line', vim.lastHSPos);
          var hasMarkedText = motionArgs.forward ? posV.line > line : posV.line < line;
          if (hasMarkedText) {
            line = posV.line;
            endCh = posV.ch;
          }
          // Vim go to line begin or line end when cursor at first/last line and
          // move to previous/next line is triggered.
          if (line < first && cur.line == first){
            return this.moveToStartOfLine(cm, head, motionArgs, vim);
          }else if (line > last && cur.line == last){
              return this.moveToEol(cm, head, motionArgs, vim, true);
          }
          if (motionArgs.toFirstChar){
            endCh=findFirstNonWhiteSpaceCharacter(cm.getLine(line));
            vim.lastHPos = endCh;
          }
          vim.lastHSPos = cm.charCoords(Pos(line, endCh),'div').left;
          return Pos(line, endCh);
        },
        moveByDisplayLines: function(cm, head, motionArgs, vim) {
          var cur = head;
          switch (vim.lastMotion) {
            case this.moveByDisplayLines:
            case this.moveByScroll:
            case this.moveByLines:
            case this.moveToColumn:
            case this.moveToEol:
              break;
            default:
              vim.lastHSPos = cm.charCoords(cur,'div').left;
          }
          var repeat = motionArgs.repeat;
          var res=cm.findPosV(cur,(motionArgs.forward ? repeat : -repeat),'line',vim.lastHSPos);
          if (res.hitSide) {
            if (motionArgs.forward) {
              var lastCharCoords = cm.charCoords(res, 'div');
              var goalCoords = { top: lastCharCoords.top + 8, left: vim.lastHSPos };
              var res = cm.coordsChar(goalCoords, 'div');
            } else {
              var resCoords = cm.charCoords(Pos(cm.firstLine(), 0), 'div');
              resCoords.left = vim.lastHSPos;
              res = cm.coordsChar(resCoords, 'div');
            }
          }
          vim.lastHPos = res.ch;
          return res;
        },
        moveByPage: function(cm, head, motionArgs) {
          // CodeMirror only exposes functions that move the cursor page down, so
          // doing this bad hack to move the cursor and move it back. evalInput
          // will move the cursor to where it should be in the end.
          var curStart = head;
          var repeat = motionArgs.repeat;
          return cm.findPosV(curStart, (motionArgs.forward ? repeat : -repeat), 'page');
        },
        moveByParagraph: function(cm, head, motionArgs) {
          var dir = motionArgs.forward ? 1 : -1;
          return findParagraph(cm, head, motionArgs.repeat, dir);
        },
        moveBySentence: function(cm, head, motionArgs) {
          var dir = motionArgs.forward ? 1 : -1;
          return findSentence(cm, head, motionArgs.repeat, dir);
        },
        moveByScroll: function(cm, head, motionArgs, vim) {
          var scrollbox = cm.getScrollInfo();
          var curEnd = null;
          var repeat = motionArgs.repeat;
          if (!repeat) {
            repeat = scrollbox.clientHeight / (2 * cm.defaultTextHeight());
          }
          var orig = cm.charCoords(head, 'local');
          motionArgs.repeat = repeat;
          var curEnd = motions.moveByDisplayLines(cm, head, motionArgs, vim);
          if (!curEnd) {
            return null;
          }
          var dest = cm.charCoords(curEnd, 'local');
          cm.scrollTo(null, scrollbox.top + dest.top - orig.top);
          return curEnd;
        },
        moveByWords: function(cm, head, motionArgs) {
          return moveToWord(cm, head, motionArgs.repeat, !!motionArgs.forward,
              !!motionArgs.wordEnd, !!motionArgs.bigWord);
        },
        moveTillCharacter: function(cm, _head, motionArgs) {
          var repeat = motionArgs.repeat;
          var curEnd = moveToCharacter(cm, repeat, motionArgs.forward,
              motionArgs.selectedCharacter);
          var increment = motionArgs.forward ? -1 : 1;
          recordLastCharacterSearch(increment, motionArgs);
          if (!curEnd) return null;
          curEnd.ch += increment;
          return curEnd;
        },
        moveToCharacter: function(cm, head, motionArgs) {
          var repeat = motionArgs.repeat;
          recordLastCharacterSearch(0, motionArgs);
          return moveToCharacter(cm, repeat, motionArgs.forward,
              motionArgs.selectedCharacter) || head;
        },
        moveToSymbol: function(cm, head, motionArgs) {
          var repeat = motionArgs.repeat;
          return findSymbol(cm, repeat, motionArgs.forward,
              motionArgs.selectedCharacter) || head;
        },
        moveToColumn: function(cm, head, motionArgs, vim) {
          var repeat = motionArgs.repeat;
          // repeat is equivalent to which column we want to move to!
          vim.lastHPos = repeat - 1;
          vim.lastHSPos = cm.charCoords(head,'div').left;
          return moveToColumn(cm, repeat);
        },
        moveToEol: function(cm, head, motionArgs, vim, keepHPos) {
          var cur = head;
          var retval= Pos(cur.line + motionArgs.repeat - 1, Infinity);
          var end=cm.clipPos(retval);
          end.ch--;
          if (!keepHPos) {
            vim.lastHPos = Infinity;
            vim.lastHSPos = cm.charCoords(end,'div').left;
          }
          return retval;
        },
        moveToFirstNonWhiteSpaceCharacter: function(cm, head) {
          // Go to the start of the line where the text begins, or the end for
          // whitespace-only lines
          var cursor = head;
          return Pos(cursor.line,
                     findFirstNonWhiteSpaceCharacter(cm.getLine(cursor.line)));
        },
        moveToMatchedSymbol: function(cm, head) {
          var cursor = head;
          var line = cursor.line;
          var ch = cursor.ch;
          var lineText = cm.getLine(line);
          var symbol;
          for (; ch < lineText.length; ch++) {
            symbol = lineText.charAt(ch);
            if (symbol && isMatchableSymbol(symbol)) {
              var style = cm.getTokenTypeAt(Pos(line, ch + 1));
              if (style !== "string" && style !== "comment") {
                break;
              }
            }
          }
          if (ch < lineText.length) {
            // Only include angle brackets in analysis if they are being matched.
            var re = (ch === '<' || ch === '>') ? /[(){}[\]<>]/ : /[(){}[\]]/;
            var matched = cm.findMatchingBracket(Pos(line, ch), {bracketRegex: re});
            return matched.to;
          } else {
            return cursor;
          }
        },
        moveToStartOfLine: function(_cm, head) {
          return Pos(head.line, 0);
        },
        moveToLineOrEdgeOfDocument: function(cm, _head, motionArgs) {
          var lineNum = motionArgs.forward ? cm.lastLine() : cm.firstLine();
          if (motionArgs.repeatIsExplicit) {
            lineNum = motionArgs.repeat - cm.getOption('firstLineNumber');
          }
          return Pos(lineNum,
                     findFirstNonWhiteSpaceCharacter(cm.getLine(lineNum)));
        },
        textObjectManipulation: function(cm, head, motionArgs, vim) {
          // TODO: lots of possible exceptions that can be thrown here. Try da(
          //     outside of a () block.
          var mirroredPairs = {'(': ')', ')': '(',
                               '{': '}', '}': '{',
                               '[': ']', ']': '[',
                               '<': '>', '>': '<'};
          var selfPaired = {'\'': true, '"': true, '`': true};
  
          var character = motionArgs.selectedCharacter;
          // 'b' refers to  '()' block.
          // 'B' refers to  '{}' block.
          if (character == 'b') {
            character = '(';
          } else if (character == 'B') {
            character = '{';
          }
  
          // Inclusive is the difference between a and i
          // TODO: Instead of using the additional text object map to perform text
          //     object operations, merge the map into the defaultKeyMap and use
          //     motionArgs to define behavior. Define separate entries for 'aw',
          //     'iw', 'a[', 'i[', etc.
          var inclusive = !motionArgs.textObjectInner;
  
          var tmp;
          if (mirroredPairs[character]) {
            tmp = selectCompanionObject(cm, head, character, inclusive);
          } else if (selfPaired[character]) {
            tmp = findBeginningAndEnd(cm, head, character, inclusive);
          } else if (character === 'W') {
            tmp = expandWordUnderCursor(cm, inclusive, true /** forward */,
                                                       true /** bigWord */);
          } else if (character === 'w') {
            tmp = expandWordUnderCursor(cm, inclusive, true /** forward */,
                                                       false /** bigWord */);
          } else if (character === 'p') {
            tmp = findParagraph(cm, head, motionArgs.repeat, 0, inclusive);
            motionArgs.linewise = true;
            if (vim.visualMode) {
              if (!vim.visualLine) { vim.visualLine = true; }
            } else {
              var operatorArgs = vim.inputState.operatorArgs;
              if (operatorArgs) { operatorArgs.linewise = true; }
              tmp.end.line--;
            }
          } else {
            // No text object defined for this, don't move.
            return null;
          }
  
          if (!cm.state.vim.visualMode) {
            return [tmp.start, tmp.end];
          } else {
            return expandSelection(cm, tmp.start, tmp.end);
          }
        },
  
        repeatLastCharacterSearch: function(cm, head, motionArgs) {
          var lastSearch = vimGlobalState.lastCharacterSearch;
          var repeat = motionArgs.repeat;
          var forward = motionArgs.forward === lastSearch.forward;
          var increment = (lastSearch.increment ? 1 : 0) * (forward ? -1 : 1);
          cm.moveH(-increment, 'char');
          motionArgs.inclusive = forward ? true : false;
          var curEnd = moveToCharacter(cm, repeat, forward, lastSearch.selectedCharacter);
          if (!curEnd) {
            cm.moveH(increment, 'char');
            return head;
          }
          curEnd.ch += increment;
          return curEnd;
        }
      };
  
      function defineMotion(name, fn) {
        motions[name] = fn;
      }
  
      function fillArray(val, times) {
        var arr = [];
        for (var i = 0; i < times; i++) {
          arr.push(val);
        }
        return arr;
      }
      /**
       * An operator acts on a text selection. It receives the list of selections
       * as input. The corresponding CodeMirror selection is guaranteed to
      * match the input selection.
       */
      var operators = {
        change: function(cm, args, ranges) {
          var finalHead, text;
          var vim = cm.state.vim;
          var anchor = ranges[0].anchor,
              head = ranges[0].head;
          if (!vim.visualMode) {
            text = cm.getRange(anchor, head);
            var lastState = vim.lastEditInputState || {};
            if (lastState.motion == "moveByWords" && !isWhiteSpaceString(text)) {
              // Exclude trailing whitespace if the range is not all whitespace.
              var match = (/\s+$/).exec(text);
              if (match && lastState.motionArgs && lastState.motionArgs.forward) {
                head = offsetCursor(head, 0, - match[0].length);
                text = text.slice(0, - match[0].length);
              }
            }
            var prevLineEnd = new Pos(anchor.line - 1, Number.MAX_VALUE);
            var wasLastLine = cm.firstLine() == cm.lastLine();
            if (head.line > cm.lastLine() && args.linewise && !wasLastLine) {
              cm.replaceRange('', prevLineEnd, head);
            } else {
              cm.replaceRange('', anchor, head);
            }
            if (args.linewise) {
              // Push the next line back down, if there is a next line.
              if (!wasLastLine) {
                cm.setCursor(prevLineEnd);
                CodeMirror.commands.newlineAndIndent(cm);
              }
              // make sure cursor ends up at the end of the line.
              anchor.ch = Number.MAX_VALUE;
            }
            finalHead = anchor;
          } else if (args.fullLine) {
              head.ch = Number.MAX_VALUE;
              head.line--;
              cm.setSelection(anchor, head)
              text = cm.getSelection();
              cm.replaceSelection("");
              finalHead = anchor;
          } else {
            text = cm.getSelection();
            var replacement = fillArray('', ranges.length);
            cm.replaceSelections(replacement);
            finalHead = cursorMin(ranges[0].head, ranges[0].anchor);
          }
          vimGlobalState.registerController.pushText(
              args.registerName, 'change', text,
              args.linewise, ranges.length > 1);
          actions.enterInsertMode(cm, {head: finalHead}, cm.state.vim);
        },
        // delete is a javascript keyword.
        'delete': function(cm, args, ranges) {
          var finalHead, text;
          var vim = cm.state.vim;
          if (!vim.visualBlock) {
            var anchor = ranges[0].anchor,
                head = ranges[0].head;
            if (args.linewise &&
                head.line != cm.firstLine() &&
                anchor.line == cm.lastLine() &&
                anchor.line == head.line - 1) {
              // Special case for dd on last line (and first line).
              if (anchor.line == cm.firstLine()) {
                anchor.ch = 0;
              } else {
                anchor = Pos(anchor.line - 1, lineLength(cm, anchor.line - 1));
              }
            }
            text = cm.getRange(anchor, head);
            cm.replaceRange('', anchor, head);
            finalHead = anchor;
            if (args.linewise) {
              finalHead = motions.moveToFirstNonWhiteSpaceCharacter(cm, anchor);
            }
          } else {
            text = cm.getSelection();
            var replacement = fillArray('', ranges.length);
            cm.replaceSelections(replacement);
            finalHead = ranges[0].anchor;
          }
          vimGlobalState.registerController.pushText(
              args.registerName, 'delete', text,
              args.linewise, vim.visualBlock);
          return clipCursorToContent(cm, finalHead);
        },
        indent: function(cm, args, ranges) {
          var vim = cm.state.vim;
          var startLine = ranges[0].anchor.line;
          var endLine = vim.visualBlock ?
            ranges[ranges.length - 1].anchor.line :
            ranges[0].head.line;
          // In visual mode, n> shifts the selection right n times, instead of
          // shifting n lines right once.
          var repeat = (vim.visualMode) ? args.repeat : 1;
          if (args.linewise) {
            // The only way to delete a newline is to delete until the start of
            // the next line, so in linewise mode evalInput will include the next
            // line. We don't want this in indent, so we go back a line.
            endLine--;
          }
          for (var i = startLine; i <= endLine; i++) {
            for (var j = 0; j < repeat; j++) {
              cm.indentLine(i, args.indentRight);
            }
          }
          return motions.moveToFirstNonWhiteSpaceCharacter(cm, ranges[0].anchor);
        },
        indentAuto: function(cm, _args, ranges) {
          cm.execCommand("indentAuto");
          return motions.moveToFirstNonWhiteSpaceCharacter(cm, ranges[0].anchor);
        },
        changeCase: function(cm, args, ranges, oldAnchor, newHead) {
          var selections = cm.getSelections();
          var swapped = [];
          var toLower = args.toLower;
          for (var j = 0; j < selections.length; j++) {
            var toSwap = selections[j];
            var text = '';
            if (toLower === true) {
              text = toSwap.toLowerCase();
            } else if (toLower === false) {
              text = toSwap.toUpperCase();
            } else {
              for (var i = 0; i < toSwap.length; i++) {
                var character = toSwap.charAt(i);
                text += isUpperCase(character) ? character.toLowerCase() :
                    character.toUpperCase();
              }
            }
            swapped.push(text);
          }
          cm.replaceSelections(swapped);
          if (args.shouldMoveCursor){
            return newHead;
          } else if (!cm.state.vim.visualMode && args.linewise && ranges[0].anchor.line + 1 == ranges[0].head.line) {
            return motions.moveToFirstNonWhiteSpaceCharacter(cm, oldAnchor);
          } else if (args.linewise){
            return oldAnchor;
          } else {
            return cursorMin(ranges[0].anchor, ranges[0].head);
          }
        },
        yank: function(cm, args, ranges, oldAnchor) {
          var vim = cm.state.vim;
          var text = cm.getSelection();
          var endPos = vim.visualMode
            ? cursorMin(vim.sel.anchor, vim.sel.head, ranges[0].head, ranges[0].anchor)
            : oldAnchor;
          vimGlobalState.registerController.pushText(
              args.registerName, 'yank',
              text, args.linewise, vim.visualBlock);
          return endPos;
        }
      };
  
      function defineOperator(name, fn) {
        operators[name] = fn;
      }
  
      var actions = {
        jumpListWalk: function(cm, actionArgs, vim) {
          if (vim.visualMode) {
            return;
          }
          var repeat = actionArgs.repeat;
          var forward = actionArgs.forward;
          var jumpList = vimGlobalState.jumpList;
  
          var mark = jumpList.move(cm, forward ? repeat : -repeat);
          var markPos = mark ? mark.find() : undefined;
          markPos = markPos ? markPos : cm.getCursor();
          cm.setCursor(markPos);
        },
        scroll: function(cm, actionArgs, vim) {
          if (vim.visualMode) {
            return;
          }
          var repeat = actionArgs.repeat || 1;
          var lineHeight = cm.defaultTextHeight();
          var top = cm.getScrollInfo().top;
          var delta = lineHeight * repeat;
          var newPos = actionArgs.forward ? top + delta : top - delta;
          var cursor = copyCursor(cm.getCursor());
          var cursorCoords = cm.charCoords(cursor, 'local');
          if (actionArgs.forward) {
            if (newPos > cursorCoords.top) {
               cursor.line += (newPos - cursorCoords.top) / lineHeight;
               cursor.line = Math.ceil(cursor.line);
               cm.setCursor(cursor);
               cursorCoords = cm.charCoords(cursor, 'local');
               cm.scrollTo(null, cursorCoords.top);
            } else {
               // Cursor stays within bounds.  Just reposition the scroll window.
               cm.scrollTo(null, newPos);
            }
          } else {
            var newBottom = newPos + cm.getScrollInfo().clientHeight;
            if (newBottom < cursorCoords.bottom) {
               cursor.line -= (cursorCoords.bottom - newBottom) / lineHeight;
               cursor.line = Math.floor(cursor.line);
               cm.setCursor(cursor);
               cursorCoords = cm.charCoords(cursor, 'local');
               cm.scrollTo(
                   null, cursorCoords.bottom - cm.getScrollInfo().clientHeight);
            } else {
               // Cursor stays within bounds.  Just reposition the scroll window.
               cm.scrollTo(null, newPos);
            }
          }
        },
        scrollToCursor: function(cm, actionArgs) {
          var lineNum = cm.getCursor().line;
          var charCoords = cm.charCoords(Pos(lineNum, 0), 'local');
          var height = cm.getScrollInfo().clientHeight;
          var y = charCoords.top;
          var lineHeight = charCoords.bottom - y;
          switch (actionArgs.position) {
            case 'center': y = y - (height / 2) + lineHeight;
              break;
            case 'bottom': y = y - height + lineHeight;
              break;
          }
          cm.scrollTo(null, y);
        },
        replayMacro: function(cm, actionArgs, vim) {
          var registerName = actionArgs.selectedCharacter;
          var repeat = actionArgs.repeat;
          var macroModeState = vimGlobalState.macroModeState;
          if (registerName == '@') {
            registerName = macroModeState.latestRegister;
          } else {
            macroModeState.latestRegister = registerName;
          }
          while(repeat--){
            executeMacroRegister(cm, vim, macroModeState, registerName);
          }
        },
        enterMacroRecordMode: function(cm, actionArgs) {
          var macroModeState = vimGlobalState.macroModeState;
          var registerName = actionArgs.selectedCharacter;
          if (vimGlobalState.registerController.isValidRegister(registerName)) {
            macroModeState.enterMacroRecordMode(cm, registerName);
          }
        },
        toggleOverwrite: function(cm) {
          if (!cm.state.overwrite) {
            cm.toggleOverwrite(true);
            cm.setOption('keyMap', 'vim-replace');
            CodeMirror.signal(cm, "vim-mode-change", {mode: "replace"});
          } else {
            cm.toggleOverwrite(false);
            cm.setOption('keyMap', 'vim-insert');
            CodeMirror.signal(cm, "vim-mode-change", {mode: "insert"});
          }
        },
        enterInsertMode: function(cm, actionArgs, vim) {
          if (cm.getOption('readOnly')) { return; }
          vim.insertMode = true;
          vim.insertModeRepeat = actionArgs && actionArgs.repeat || 1;
          var insertAt = (actionArgs) ? actionArgs.insertAt : null;
          var sel = vim.sel;
          var head = actionArgs.head || cm.getCursor('head');
          var height = cm.listSelections().length;
          if (insertAt == 'eol') {
            head = Pos(head.line, lineLength(cm, head.line));
          } else if (insertAt == 'bol') {
            head = Pos(head.line, 0);
          } else if (insertAt == 'charAfter') {
            head = offsetCursor(head, 0, 1);
          } else if (insertAt == 'firstNonBlank') {
            head = motions.moveToFirstNonWhiteSpaceCharacter(cm, head);
          } else if (insertAt == 'startOfSelectedArea') {
            if (!vim.visualMode)
                return;
            if (!vim.visualBlock) {
              if (sel.head.line < sel.anchor.line) {
                head = sel.head;
              } else {
                head = Pos(sel.anchor.line, 0);
              }
            } else {
              head = Pos(
                  Math.min(sel.head.line, sel.anchor.line),
                  Math.min(sel.head.ch, sel.anchor.ch));
              height = Math.abs(sel.head.line - sel.anchor.line) + 1;
            }
          } else if (insertAt == 'endOfSelectedArea') {
              if (!vim.visualMode)
                return;
            if (!vim.visualBlock) {
              if (sel.head.line >= sel.anchor.line) {
                head = offsetCursor(sel.head, 0, 1);
              } else {
                head = Pos(sel.anchor.line, 0);
              }
            } else {
              head = Pos(
                  Math.min(sel.head.line, sel.anchor.line),
                  Math.max(sel.head.ch + 1, sel.anchor.ch));
              height = Math.abs(sel.head.line - sel.anchor.line) + 1;
            }
          } else if (insertAt == 'inplace') {
            if (vim.visualMode){
              return;
            }
          } else if (insertAt == 'lastEdit') {
            head = getLastEditPos(cm) || head;
          }
          cm.setOption('disableInput', false);
          if (actionArgs && actionArgs.replace) {
            // Handle Replace-mode as a special case of insert mode.
            cm.toggleOverwrite(true);
            cm.setOption('keyMap', 'vim-replace');
            CodeMirror.signal(cm, "vim-mode-change", {mode: "replace"});
          } else {
            cm.toggleOverwrite(false);
            cm.setOption('keyMap', 'vim-insert');
            CodeMirror.signal(cm, "vim-mode-change", {mode: "insert"});
          }
          if (!vimGlobalState.macroModeState.isPlaying) {
            // Only record if not replaying.
            cm.on('change', onChange);
            CodeMirror.on(cm.getInputField(), 'keydown', onKeyEventTargetKeyDown);
          }
          if (vim.visualMode) {
            exitVisualMode(cm);
          }
          selectForInsert(cm, head, height);
        },
        toggleVisualMode: function(cm, actionArgs, vim) {
          var repeat = actionArgs.repeat;
          var anchor = cm.getCursor();
          var head;
          // TODO: The repeat should actually select number of characters/lines
          //     equal to the repeat times the size of the previous visual
          //     operation.
          if (!vim.visualMode) {
            // Entering visual mode
            vim.visualMode = true;
            vim.visualLine = !!actionArgs.linewise;
            vim.visualBlock = !!actionArgs.blockwise;
            head = clipCursorToContent(
                cm, Pos(anchor.line, anchor.ch + repeat - 1));
            vim.sel = {
              anchor: anchor,
              head: head
            };
            CodeMirror.signal(cm, "vim-mode-change", {mode: "visual", subMode: vim.visualLine ? "linewise" : vim.visualBlock ? "blockwise" : ""});
            updateCmSelection(cm);
            updateMark(cm, vim, '<', cursorMin(anchor, head));
            updateMark(cm, vim, '>', cursorMax(anchor, head));
          } else if (vim.visualLine ^ actionArgs.linewise ||
              vim.visualBlock ^ actionArgs.blockwise) {
            // Toggling between modes
            vim.visualLine = !!actionArgs.linewise;
            vim.visualBlock = !!actionArgs.blockwise;
            CodeMirror.signal(cm, "vim-mode-change", {mode: "visual", subMode: vim.visualLine ? "linewise" : vim.visualBlock ? "blockwise" : ""});
            updateCmSelection(cm);
          } else {
            exitVisualMode(cm);
          }
        },
        reselectLastSelection: function(cm, _actionArgs, vim) {
          var lastSelection = vim.lastSelection;
          if (vim.visualMode) {
            updateLastSelection(cm, vim);
          }
          if (lastSelection) {
            var anchor = lastSelection.anchorMark.find();
            var head = lastSelection.headMark.find();
            if (!anchor || !head) {
              // If the marks have been destroyed due to edits, do nothing.
              return;
            }
            vim.sel = {
              anchor: anchor,
              head: head
            };
            vim.visualMode = true;
            vim.visualLine = lastSelection.visualLine;
            vim.visualBlock = lastSelection.visualBlock;
            updateCmSelection(cm);
            updateMark(cm, vim, '<', cursorMin(anchor, head));
            updateMark(cm, vim, '>', cursorMax(anchor, head));
            CodeMirror.signal(cm, 'vim-mode-change', {
              mode: 'visual',
              subMode: vim.visualLine ? 'linewise' :
                       vim.visualBlock ? 'blockwise' : ''});
          }
        },
        joinLines: function(cm, actionArgs, vim) {
          var curStart, curEnd;
          if (vim.visualMode) {
            curStart = cm.getCursor('anchor');
            curEnd = cm.getCursor('head');
            if (cursorIsBefore(curEnd, curStart)) {
              var tmp = curEnd;
              curEnd = curStart;
              curStart = tmp;
            }
            curEnd.ch = lineLength(cm, curEnd.line) - 1;
          } else {
            // Repeat is the number of lines to join. Minimum 2 lines.
            var repeat = Math.max(actionArgs.repeat, 2);
            curStart = cm.getCursor();
            curEnd = clipCursorToContent(cm, Pos(curStart.line + repeat - 1,
                                                 Infinity));
          }
          var finalCh = 0;
          for (var i = curStart.line; i < curEnd.line; i++) {
            finalCh = lineLength(cm, curStart.line);
            var tmp = Pos(curStart.line + 1,
                          lineLength(cm, curStart.line + 1));
            var text = cm.getRange(curStart, tmp);
            text = actionArgs.keepSpaces
              ? text.replace(/\n\r?/g, '')
              : text.replace(/\n\s*/g, ' ');
            cm.replaceRange(text, curStart, tmp);
          }
          var curFinalPos = Pos(curStart.line, finalCh);
          if (vim.visualMode) {
            exitVisualMode(cm, false);
          }
          cm.setCursor(curFinalPos);
        },
        newLineAndEnterInsertMode: function(cm, actionArgs, vim) {
          vim.insertMode = true;
          var insertAt = copyCursor(cm.getCursor());
          if (insertAt.line === cm.firstLine() && !actionArgs.after) {
            // Special case for inserting newline before start of document.
            cm.replaceRange('\n', Pos(cm.firstLine(), 0));
            cm.setCursor(cm.firstLine(), 0);
          } else {
            insertAt.line = (actionArgs.after) ? insertAt.line :
                insertAt.line - 1;
            insertAt.ch = lineLength(cm, insertAt.line);
            cm.setCursor(insertAt);
            var newlineFn = CodeMirror.commands.newlineAndIndentContinueComment ||
                CodeMirror.commands.newlineAndIndent;
            newlineFn(cm);
          }
          this.enterInsertMode(cm, { repeat: actionArgs.repeat }, vim);
        },
        paste: function(cm, actionArgs, vim) {
          var cur = copyCursor(cm.getCursor());
          var register = vimGlobalState.registerController.getRegister(
              actionArgs.registerName);
          var text = register.toString();
          if (!text) {
            return;
          }
          if (actionArgs.matchIndent) {
            var tabSize = cm.getOption("tabSize");
            // length that considers tabs and tabSize
            var whitespaceLength = function(str) {
              var tabs = (str.split("\t").length - 1);
              var spaces = (str.split(" ").length - 1);
              return tabs * tabSize + spaces * 1;
            };
            var currentLine = cm.getLine(cm.getCursor().line);
            var indent = whitespaceLength(currentLine.match(/^\s*/)[0]);
            // chomp last newline b/c don't want it to match /^\s*/gm
            var chompedText = text.replace(/\n$/, '');
            var wasChomped = text !== chompedText;
            var firstIndent = whitespaceLength(text.match(/^\s*/)[0]);
            var text = chompedText.replace(/^\s*/gm, function(wspace) {
              var newIndent = indent + (whitespaceLength(wspace) - firstIndent);
              if (newIndent < 0) {
                return "";
              }
              else if (cm.getOption("indentWithTabs")) {
                var quotient = Math.floor(newIndent / tabSize);
                return Array(quotient + 1).join('\t');
              }
              else {
                return Array(newIndent + 1).join(' ');
              }
            });
            text += wasChomped ? "\n" : "";
          }
          if (actionArgs.repeat > 1) {
            var text = Array(actionArgs.repeat + 1).join(text);
          }
          var linewise = register.linewise;
          var blockwise = register.blockwise;
          if (blockwise) {
            text = text.split('\n');
            if (linewise) {
                text.pop();
            }
            for (var i = 0; i < text.length; i++) {
              text[i] = (text[i] == '') ? ' ' : text[i];
            }
            cur.ch += actionArgs.after ? 1 : 0;
            cur.ch = Math.min(lineLength(cm, cur.line), cur.ch);
          } else if (linewise) {
            if(vim.visualMode) {
              text = vim.visualLine ? text.slice(0, -1) : '\n' + text.slice(0, text.length - 1) + '\n';
            } else if (actionArgs.after) {
              // Move the newline at the end to the start instead, and paste just
              // before the newline character of the line we are on right now.
              text = '\n' + text.slice(0, text.length - 1);
              cur.ch = lineLength(cm, cur.line);
            } else {
              cur.ch = 0;
            }
          } else {
            cur.ch += actionArgs.after ? 1 : 0;
          }
          var curPosFinal;
          var idx;
          if (vim.visualMode) {
            //  save the pasted text for reselection if the need arises
            vim.lastPastedText = text;
            var lastSelectionCurEnd;
            var selectedArea = getSelectedAreaRange(cm, vim);
            var selectionStart = selectedArea[0];
            var selectionEnd = selectedArea[1];
            var selectedText = cm.getSelection();
            var selections = cm.listSelections();
            var emptyStrings = new Array(selections.length).join('1').split('1');
            // save the curEnd marker before it get cleared due to cm.replaceRange.
            if (vim.lastSelection) {
              lastSelectionCurEnd = vim.lastSelection.headMark.find();
            }
            // push the previously selected text to unnamed register
            vimGlobalState.registerController.unnamedRegister.setText(selectedText);
            if (blockwise) {
              // first delete the selected text
              cm.replaceSelections(emptyStrings);
              // Set new selections as per the block length of the yanked text
              selectionEnd = Pos(selectionStart.line + text.length-1, selectionStart.ch);
              cm.setCursor(selectionStart);
              selectBlock(cm, selectionEnd);
              cm.replaceSelections(text);
              curPosFinal = selectionStart;
            } else if (vim.visualBlock) {
              cm.replaceSelections(emptyStrings);
              cm.setCursor(selectionStart);
              cm.replaceRange(text, selectionStart, selectionStart);
              curPosFinal = selectionStart;
            } else {
              cm.replaceRange(text, selectionStart, selectionEnd);
              curPosFinal = cm.posFromIndex(cm.indexFromPos(selectionStart) + text.length - 1);
            }
            // restore the the curEnd marker
            if(lastSelectionCurEnd) {
              vim.lastSelection.headMark = cm.setBookmark(lastSelectionCurEnd);
            }
            if (linewise) {
              curPosFinal.ch=0;
            }
          } else {
            if (blockwise) {
              cm.setCursor(cur);
              for (var i = 0; i < text.length; i++) {
                var line = cur.line+i;
                if (line > cm.lastLine()) {
                  cm.replaceRange('\n',  Pos(line, 0));
                }
                var lastCh = lineLength(cm, line);
                if (lastCh < cur.ch) {
                  extendLineToColumn(cm, line, cur.ch);
                }
              }
              cm.setCursor(cur);
              selectBlock(cm, Pos(cur.line + text.length-1, cur.ch));
              cm.replaceSelections(text);
              curPosFinal = cur;
            } else {
              cm.replaceRange(text, cur);
              // Now fine tune the cursor to where we want it.
              if (linewise && actionArgs.after) {
                curPosFinal = Pos(
                cur.line + 1,
                findFirstNonWhiteSpaceCharacter(cm.getLine(cur.line + 1)));
              } else if (linewise && !actionArgs.after) {
                curPosFinal = Pos(
                  cur.line,
                  findFirstNonWhiteSpaceCharacter(cm.getLine(cur.line)));
              } else if (!linewise && actionArgs.after) {
                idx = cm.indexFromPos(cur);
                curPosFinal = cm.posFromIndex(idx + text.length - 1);
              } else {
                idx = cm.indexFromPos(cur);
                curPosFinal = cm.posFromIndex(idx + text.length);
              }
            }
          }
          if (vim.visualMode) {
            exitVisualMode(cm, false);
          }
          cm.setCursor(curPosFinal);
        },
        undo: function(cm, actionArgs) {
          cm.operation(function() {
            repeatFn(cm, CodeMirror.commands.undo, actionArgs.repeat)();
            cm.setCursor(cm.getCursor('anchor'));
          });
        },
        redo: function(cm, actionArgs) {
          repeatFn(cm, CodeMirror.commands.redo, actionArgs.repeat)();
        },
        setRegister: function(_cm, actionArgs, vim) {
          vim.inputState.registerName = actionArgs.selectedCharacter;
        },
        setMark: function(cm, actionArgs, vim) {
          var markName = actionArgs.selectedCharacter;
          updateMark(cm, vim, markName, cm.getCursor());
        },
        replace: function(cm, actionArgs, vim) {
          var replaceWith = actionArgs.selectedCharacter;
          var curStart = cm.getCursor();
          var replaceTo;
          var curEnd;
          var selections = cm.listSelections();
          if (vim.visualMode) {
            curStart = cm.getCursor('start');
            curEnd = cm.getCursor('end');
          } else {
            var line = cm.getLine(curStart.line);
            replaceTo = curStart.ch + actionArgs.repeat;
            if (replaceTo > line.length) {
              replaceTo=line.length;
            }
            curEnd = Pos(curStart.line, replaceTo);
          }
          if (replaceWith=='\n') {
            if (!vim.visualMode) cm.replaceRange('', curStart, curEnd);
            // special case, where vim help says to replace by just one line-break
            (CodeMirror.commands.newlineAndIndentContinueComment || CodeMirror.commands.newlineAndIndent)(cm);
          } else {
            var replaceWithStr = cm.getRange(curStart, curEnd);
            //replace all characters in range by selected, but keep linebreaks
            replaceWithStr = replaceWithStr.replace(/[^\n]/g, replaceWith);
            if (vim.visualBlock) {
              // Tabs are split in visua block before replacing
              var spaces = new Array(cm.getOption("tabSize")+1).join(' ');
              replaceWithStr = cm.getSelection();
              replaceWithStr = replaceWithStr.replace(/\t/g, spaces).replace(/[^\n]/g, replaceWith).split('\n');
              cm.replaceSelections(replaceWithStr);
            } else {
              cm.replaceRange(replaceWithStr, curStart, curEnd);
            }
            if (vim.visualMode) {
              curStart = cursorIsBefore(selections[0].anchor, selections[0].head) ?
                           selections[0].anchor : selections[0].head;
              cm.setCursor(curStart);
              exitVisualMode(cm, false);
            } else {
              cm.setCursor(offsetCursor(curEnd, 0, -1));
            }
          }
        },
        incrementNumberToken: function(cm, actionArgs) {
          var cur = cm.getCursor();
          var lineStr = cm.getLine(cur.line);
          var re = /(-?)(?:(0x)([\da-f]+)|(0b|0|)(\d+))/gi;
          var match;
          var start;
          var end;
          var numberStr;
          while ((match = re.exec(lineStr)) !== null) {
            start = match.index;
            end = start + match[0].length;
            if (cur.ch < end)break;
          }
          if (!actionArgs.backtrack && (end <= cur.ch))return;
          if (match) {
            var baseStr = match[2] || match[4]
            var digits = match[3] || match[5]
            var increment = actionArgs.increase ? 1 : -1;
            var base = {'0b': 2, '0': 8, '': 10, '0x': 16}[baseStr.toLowerCase()];
            var number = parseInt(match[1] + digits, base) + (increment * actionArgs.repeat);
            numberStr = number.toString(base);
            var zeroPadding = baseStr ? new Array(digits.length - numberStr.length + 1 + match[1].length).join('0') : ''
            if (numberStr.charAt(0) === '-') {
              numberStr = '-' + baseStr + zeroPadding + numberStr.substr(1);
            } else {
              numberStr = baseStr + zeroPadding + numberStr;
            }
            var from = Pos(cur.line, start);
            var to = Pos(cur.line, end);
            cm.replaceRange(numberStr, from, to);
          } else {
            return;
          }
          cm.setCursor(Pos(cur.line, start + numberStr.length - 1));
        },
        repeatLastEdit: function(cm, actionArgs, vim) {
          var lastEditInputState = vim.lastEditInputState;
          if (!lastEditInputState) { return; }
          var repeat = actionArgs.repeat;
          if (repeat && actionArgs.repeatIsExplicit) {
            vim.lastEditInputState.repeatOverride = repeat;
          } else {
            repeat = vim.lastEditInputState.repeatOverride || repeat;
          }
          repeatLastEdit(cm, vim, repeat, false /** repeatForInsert */);
        },
        indent: function(cm, actionArgs) {
          cm.indentLine(cm.getCursor().line, actionArgs.indentRight);
        },
        exitInsertMode: exitInsertMode
      };
  
      function defineAction(name, fn) {
        actions[name] = fn;
      }
  
      /*
       * Below are miscellaneous utility functions used by vim.js
       */
  
      /**
       * Clips cursor to ensure that line is within the buffer's range
       * If includeLineBreak is true, then allow cur.ch == lineLength.
       */
      function clipCursorToContent(cm, cur) {
        var vim = cm.state.vim;
        var includeLineBreak = vim.insertMode || vim.visualMode;
        var line = Math.min(Math.max(cm.firstLine(), cur.line), cm.lastLine() );
        var maxCh = lineLength(cm, line) - 1 + !!includeLineBreak;
        var ch = Math.min(Math.max(0, cur.ch), maxCh);
        return Pos(line, ch);
      }
      function copyArgs(args) {
        var ret = {};
        for (var prop in args) {
          if (args.hasOwnProperty(prop)) {
            ret[prop] = args[prop];
          }
        }
        return ret;
      }
      function offsetCursor(cur, offsetLine, offsetCh) {
        if (typeof offsetLine === 'object') {
          offsetCh = offsetLine.ch;
          offsetLine = offsetLine.line;
        }
        return Pos(cur.line + offsetLine, cur.ch + offsetCh);
      }
      function commandMatches(keys, keyMap, context, inputState) {
        // Partial matches are not applied. They inform the key handler
        // that the current key sequence is a subsequence of a valid key
        // sequence, so that the key buffer is not cleared.
        var match, partial = [], full = [];
        for (var i = 0; i < keyMap.length; i++) {
          var command = keyMap[i];
          if (context == 'insert' && command.context != 'insert' ||
              command.context && command.context != context ||
              inputState.operator && command.type == 'action' ||
              !(match = commandMatch(keys, command.keys))) { continue; }
          if (match == 'partial') { partial.push(command); }
          if (match == 'full') { full.push(command); }
        }
        return {
          partial: partial.length && partial,
          full: full.length && full
        };
      }
      function commandMatch(pressed, mapped) {
        if (mapped.slice(-11) == '<character>') {
          // Last character matches anything.
          var prefixLen = mapped.length - 11;
          var pressedPrefix = pressed.slice(0, prefixLen);
          var mappedPrefix = mapped.slice(0, prefixLen);
          return pressedPrefix == mappedPrefix && pressed.length > prefixLen ? 'full' :
                 mappedPrefix.indexOf(pressedPrefix) == 0 ? 'partial' : false;
        } else {
          return pressed == mapped ? 'full' :
                 mapped.indexOf(pressed) == 0 ? 'partial' : false;
        }
      }
      function lastChar(keys) {
        var match = /^.*(<[^>]+>)$/.exec(keys);
        var selectedCharacter = match ? match[1] : keys.slice(-1);
        if (selectedCharacter.length > 1){
          switch(selectedCharacter){
            case '<CR>':
              selectedCharacter='\n';
              break;
            case '<Space>':
              selectedCharacter=' ';
              break;
            default:
              selectedCharacter='';
              break;
          }
        }
        return selectedCharacter;
      }
      function repeatFn(cm, fn, repeat) {
        return function() {
          for (var i = 0; i < repeat; i++) {
            fn(cm);
          }
        };
      }
      function copyCursor(cur) {
        return Pos(cur.line, cur.ch);
      }
      function cursorEqual(cur1, cur2) {
        return cur1.ch == cur2.ch && cur1.line == cur2.line;
      }
      function cursorIsBefore(cur1, cur2) {
        if (cur1.line < cur2.line) {
          return true;
        }
        if (cur1.line == cur2.line && cur1.ch < cur2.ch) {
          return true;
        }
        return false;
      }
      function cursorMin(cur1, cur2) {
        if (arguments.length > 2) {
          cur2 = cursorMin.apply(undefined, Array.prototype.slice.call(arguments, 1));
        }
        return cursorIsBefore(cur1, cur2) ? cur1 : cur2;
      }
      function cursorMax(cur1, cur2) {
        if (arguments.length > 2) {
          cur2 = cursorMax.apply(undefined, Array.prototype.slice.call(arguments, 1));
        }
        return cursorIsBefore(cur1, cur2) ? cur2 : cur1;
      }
      function cursorIsBetween(cur1, cur2, cur3) {
        // returns true if cur2 is between cur1 and cur3.
        var cur1before2 = cursorIsBefore(cur1, cur2);
        var cur2before3 = cursorIsBefore(cur2, cur3);
        return cur1before2 && cur2before3;
      }
      function lineLength(cm, lineNum) {
        return cm.getLine(lineNum).length;
      }
      function trim(s) {
        if (s.trim) {
          return s.trim();
        }
        return s.replace(/^\s+|\s+$/g, '');
      }
      function escapeRegex(s) {
        return s.replace(/([.?*+$\[\]\/\\(){}|\-])/g, '\\$1');
      }
      function extendLineToColumn(cm, lineNum, column) {
        var endCh = lineLength(cm, lineNum);
        var spaces = new Array(column-endCh+1).join(' ');
        cm.setCursor(Pos(lineNum, endCh));
        cm.replaceRange(spaces, cm.getCursor());
      }
      // This functions selects a rectangular block
      // of text with selectionEnd as any of its corner
      // Height of block:
      // Difference in selectionEnd.line and first/last selection.line
      // Width of the block:
      // Distance between selectionEnd.ch and any(first considered here) selection.ch
      function selectBlock(cm, selectionEnd) {
        var selections = [], ranges = cm.listSelections();
        var head = copyCursor(cm.clipPos(selectionEnd));
        var isClipped = !cursorEqual(selectionEnd, head);
        var curHead = cm.getCursor('head');
        var primIndex = getIndex(ranges, curHead);
        var wasClipped = cursorEqual(ranges[primIndex].head, ranges[primIndex].anchor);
        var max = ranges.length - 1;
        var index = max - primIndex > primIndex ? max : 0;
        var base = ranges[index].anchor;
  
        var firstLine = Math.min(base.line, head.line);
        var lastLine = Math.max(base.line, head.line);
        var baseCh = base.ch, headCh = head.ch;
  
        var dir = ranges[index].head.ch - baseCh;
        var newDir = headCh - baseCh;
        if (dir > 0 && newDir <= 0) {
          baseCh++;
          if (!isClipped) { headCh--; }
        } else if (dir < 0 && newDir >= 0) {
          baseCh--;
          if (!wasClipped) { headCh++; }
        } else if (dir < 0 && newDir == -1) {
          baseCh--;
          headCh++;
        }
        for (var line = firstLine; line <= lastLine; line++) {
          var range = {anchor: new Pos(line, baseCh), head: new Pos(line, headCh)};
          selections.push(range);
        }
        cm.setSelections(selections);
        selectionEnd.ch = headCh;
        base.ch = baseCh;
        return base;
      }
      function selectForInsert(cm, head, height) {
        var sel = [];
        for (var i = 0; i < height; i++) {
          var lineHead = offsetCursor(head, i, 0);
          sel.push({anchor: lineHead, head: lineHead});
        }
        cm.setSelections(sel, 0);
      }
      // getIndex returns the index of the cursor in the selections.
      function getIndex(ranges, cursor, end) {
        for (var i = 0; i < ranges.length; i++) {
          var atAnchor = end != 'head' && cursorEqual(ranges[i].anchor, cursor);
          var atHead = end != 'anchor' && cursorEqual(ranges[i].head, cursor);
          if (atAnchor || atHead) {
            return i;
          }
        }
        return -1;
      }
      function getSelectedAreaRange(cm, vim) {
        var lastSelection = vim.lastSelection;
        var getCurrentSelectedAreaRange = function() {
          var selections = cm.listSelections();
          var start =  selections[0];
          var end = selections[selections.length-1];
          var selectionStart = cursorIsBefore(start.anchor, start.head) ? start.anchor : start.head;
          var selectionEnd = cursorIsBefore(end.anchor, end.head) ? end.head : end.anchor;
          return [selectionStart, selectionEnd];
        };
        var getLastSelectedAreaRange = function() {
          var selectionStart = cm.getCursor();
          var selectionEnd = cm.getCursor();
          var block = lastSelection.visualBlock;
          if (block) {
            var width = block.width;
            var height = block.height;
            selectionEnd = Pos(selectionStart.line + height, selectionStart.ch + width);
            var selections = [];
            // selectBlock creates a 'proper' rectangular block.
            // We do not want that in all cases, so we manually set selections.
            for (var i = selectionStart.line; i < selectionEnd.line; i++) {
              var anchor = Pos(i, selectionStart.ch);
              var head = Pos(i, selectionEnd.ch);
              var range = {anchor: anchor, head: head};
              selections.push(range);
            }
            cm.setSelections(selections);
          } else {
            var start = lastSelection.anchorMark.find();
            var end = lastSelection.headMark.find();
            var line = end.line - start.line;
            var ch = end.ch - start.ch;
            selectionEnd = {line: selectionEnd.line + line, ch: line ? selectionEnd.ch : ch + selectionEnd.ch};
            if (lastSelection.visualLine) {
              selectionStart = Pos(selectionStart.line, 0);
              selectionEnd = Pos(selectionEnd.line, lineLength(cm, selectionEnd.line));
            }
            cm.setSelection(selectionStart, selectionEnd);
          }
          return [selectionStart, selectionEnd];
        };
        if (!vim.visualMode) {
        // In case of replaying the action.
          return getLastSelectedAreaRange();
        } else {
          return getCurrentSelectedAreaRange();
        }
      }
      // Updates the previous selection with the current selection's values. This
      // should only be called in visual mode.
      function updateLastSelection(cm, vim) {
        var anchor = vim.sel.anchor;
        var head = vim.sel.head;
        // To accommodate the effect of lastPastedText in the last selection
        if (vim.lastPastedText) {
          head = cm.posFromIndex(cm.indexFromPos(anchor) + vim.lastPastedText.length);
          vim.lastPastedText = null;
        }
        vim.lastSelection = {'anchorMark': cm.setBookmark(anchor),
                             'headMark': cm.setBookmark(head),
                             'anchor': copyCursor(anchor),
                             'head': copyCursor(head),
                             'visualMode': vim.visualMode,
                             'visualLine': vim.visualLine,
                             'visualBlock': vim.visualBlock};
      }
      function expandSelection(cm, start, end) {
        var sel = cm.state.vim.sel;
        var head = sel.head;
        var anchor = sel.anchor;
        var tmp;
        if (cursorIsBefore(end, start)) {
          tmp = end;
          end = start;
          start = tmp;
        }
        if (cursorIsBefore(head, anchor)) {
          head = cursorMin(start, head);
          anchor = cursorMax(anchor, end);
        } else {
          anchor = cursorMin(start, anchor);
          head = cursorMax(head, end);
          head = offsetCursor(head, 0, -1);
          if (head.ch == -1 && head.line != cm.firstLine()) {
            head = Pos(head.line - 1, lineLength(cm, head.line - 1));
          }
        }
        return [anchor, head];
      }
      /**
       * Updates the CodeMirror selection to match the provided vim selection.
       * If no arguments are given, it uses the current vim selection state.
       */
      function updateCmSelection(cm, sel, mode) {
        var vim = cm.state.vim;
        sel = sel || vim.sel;
        var mode = mode ||
          vim.visualLine ? 'line' : vim.visualBlock ? 'block' : 'char';
        var cmSel = makeCmSelection(cm, sel, mode);
        cm.setSelections(cmSel.ranges, cmSel.primary);
        updateFakeCursor(cm);
      }
      function makeCmSelection(cm, sel, mode, exclusive) {
        var head = copyCursor(sel.head);
        var anchor = copyCursor(sel.anchor);
        if (mode == 'char') {
          var headOffset = !exclusive && !cursorIsBefore(sel.head, sel.anchor) ? 1 : 0;
          var anchorOffset = cursorIsBefore(sel.head, sel.anchor) ? 1 : 0;
          head = offsetCursor(sel.head, 0, headOffset);
          anchor = offsetCursor(sel.anchor, 0, anchorOffset);
          return {
            ranges: [{anchor: anchor, head: head}],
            primary: 0
          };
        } else if (mode == 'line') {
          if (!cursorIsBefore(sel.head, sel.anchor)) {
            anchor.ch = 0;
  
            var lastLine = cm.lastLine();
            if (head.line > lastLine) {
              head.line = lastLine;
            }
            head.ch = lineLength(cm, head.line);
          } else {
            head.ch = 0;
            anchor.ch = lineLength(cm, anchor.line);
          }
          return {
            ranges: [{anchor: anchor, head: head}],
            primary: 0
          };
        } else if (mode == 'block') {
          var top = Math.min(anchor.line, head.line),
              left = Math.min(anchor.ch, head.ch),
              bottom = Math.max(anchor.line, head.line),
              right = Math.max(anchor.ch, head.ch) + 1;
          var height = bottom - top + 1;
          var primary = head.line == top ? 0 : height - 1;
          var ranges = [];
          for (var i = 0; i < height; i++) {
            ranges.push({
              anchor: Pos(top + i, left),
              head: Pos(top + i, right)
            });
          }
          return {
            ranges: ranges,
            primary: primary
          };
        }
      }
      function getHead(cm) {
        var cur = cm.getCursor('head');
        if (cm.getSelection().length == 1) {
          // Small corner case when only 1 character is selected. The "real"
          // head is the left of head and anchor.
          cur = cursorMin(cur, cm.getCursor('anchor'));
        }
        return cur;
      }
  
      /**
       * If moveHead is set to false, the CodeMirror selection will not be
       * touched. The caller assumes the responsibility of putting the cursor
      * in the right place.
       */
      function exitVisualMode(cm, moveHead) {
        var vim = cm.state.vim;
        if (moveHead !== false) {
          cm.setCursor(clipCursorToContent(cm, vim.sel.head));
        }
        updateLastSelection(cm, vim);
        vim.visualMode = false;
        vim.visualLine = false;
        vim.visualBlock = false;
        CodeMirror.signal(cm, "vim-mode-change", {mode: "normal"});
        clearFakeCursor(vim);
      }
  
      // Remove any trailing newlines from the selection. For
      // example, with the caret at the start of the last word on the line,
      // 'dw' should word, but not the newline, while 'w' should advance the
      // caret to the first character of the next line.
      function clipToLine(cm, curStart, curEnd) {
        var selection = cm.getRange(curStart, curEnd);
        // Only clip if the selection ends with trailing newline + whitespace
        if (/\n\s*$/.test(selection)) {
          var lines = selection.split('\n');
          // We know this is all whitespace.
          lines.pop();
  
          // Cases:
          // 1. Last word is an empty line - do not clip the trailing '\n'
          // 2. Last word is not an empty line - clip the trailing '\n'
          var line;
          // Find the line containing the last word, and clip all whitespace up
          // to it.
          for (var line = lines.pop(); lines.length > 0 && line && isWhiteSpaceString(line); line = lines.pop()) {
            curEnd.line--;
            curEnd.ch = 0;
          }
          // If the last word is not an empty line, clip an additional newline
          if (line) {
            curEnd.line--;
            curEnd.ch = lineLength(cm, curEnd.line);
          } else {
            curEnd.ch = 0;
          }
        }
      }
  
      // Expand the selection to line ends.
      function expandSelectionToLine(_cm, curStart, curEnd) {
        curStart.ch = 0;
        curEnd.ch = 0;
        curEnd.line++;
      }
  
      function findFirstNonWhiteSpaceCharacter(text) {
        if (!text) {
          return 0;
        }
        var firstNonWS = text.search(/\S/);
        return firstNonWS == -1 ? text.length : firstNonWS;
      }
  
      function expandWordUnderCursor(cm, inclusive, _forward, bigWord, noSymbol) {
        var cur = getHead(cm);
        var line = cm.getLine(cur.line);
        var idx = cur.ch;
  
        // Seek to first word or non-whitespace character, depending on if
        // noSymbol is true.
        var test = noSymbol ? wordCharTest[0] : bigWordCharTest [0];
        while (!test(line.charAt(idx))) {
          idx++;
          if (idx >= line.length) { return null; }
        }
  
        if (bigWord) {
          test = bigWordCharTest[0];
        } else {
          test = wordCharTest[0];
          if (!test(line.charAt(idx))) {
            test = wordCharTest[1];
          }
        }
  
        var end = idx, start = idx;
        while (test(line.charAt(end)) && end < line.length) { end++; }
        while (test(line.charAt(start)) && start >= 0) { start--; }
        start++;
  
        if (inclusive) {
          // If present, include all whitespace after word.
          // Otherwise, include all whitespace before word, except indentation.
          var wordEnd = end;
          while (/\s/.test(line.charAt(end)) && end < line.length) { end++; }
          if (wordEnd == end) {
            var wordStart = start;
            while (/\s/.test(line.charAt(start - 1)) && start > 0) { start--; }
            if (!start) { start = wordStart; }
          }
        }
        return { start: Pos(cur.line, start), end: Pos(cur.line, end) };
      }
  
      function recordJumpPosition(cm, oldCur, newCur) {
        if (!cursorEqual(oldCur, newCur)) {
          vimGlobalState.jumpList.add(cm, oldCur, newCur);
        }
      }
  
      function recordLastCharacterSearch(increment, args) {
          vimGlobalState.lastCharacterSearch.increment = increment;
          vimGlobalState.lastCharacterSearch.forward = args.forward;
          vimGlobalState.lastCharacterSearch.selectedCharacter = args.selectedCharacter;
      }
  
      var symbolToMode = {
          '(': 'bracket', ')': 'bracket', '{': 'bracket', '}': 'bracket',
          '[': 'section', ']': 'section',
          '*': 'comment', '/': 'comment',
          'm': 'method', 'M': 'method',
          '#': 'preprocess'
      };
      var findSymbolModes = {
        bracket: {
          isComplete: function(state) {
            if (state.nextCh === state.symb) {
              state.depth++;
              if (state.depth >= 1)return true;
            } else if (state.nextCh === state.reverseSymb) {
              state.depth--;
            }
            return false;
          }
        },
        section: {
          init: function(state) {
            state.curMoveThrough = true;
            state.symb = (state.forward ? ']' : '[') === state.symb ? '{' : '}';
          },
          isComplete: function(state) {
            return state.index === 0 && state.nextCh === state.symb;
          }
        },
        comment: {
          isComplete: function(state) {
            var found = state.lastCh === '*' && state.nextCh === '/';
            state.lastCh = state.nextCh;
            return found;
          }
        },
        // TODO: The original Vim implementation only operates on level 1 and 2.
        // The current implementation doesn't check for code block level and
        // therefore it operates on any levels.
        method: {
          init: function(state) {
            state.symb = (state.symb === 'm' ? '{' : '}');
            state.reverseSymb = state.symb === '{' ? '}' : '{';
          },
          isComplete: function(state) {
            if (state.nextCh === state.symb)return true;
            return false;
          }
        },
        preprocess: {
          init: function(state) {
            state.index = 0;
          },
          isComplete: function(state) {
            if (state.nextCh === '#') {
              var token = state.lineText.match(/#(\w+)/)[1];
              if (token === 'endif') {
                if (state.forward && state.depth === 0) {
                  return true;
                }
                state.depth++;
              } else if (token === 'if') {
                if (!state.forward && state.depth === 0) {
                  return true;
                }
                state.depth--;
              }
              if (token === 'else' && state.depth === 0)return true;
            }
            return false;
          }
        }
      };
      function findSymbol(cm, repeat, forward, symb) {
        var cur = copyCursor(cm.getCursor());
        var increment = forward ? 1 : -1;
        var endLine = forward ? cm.lineCount() : -1;
        var curCh = cur.ch;
        var line = cur.line;
        var lineText = cm.getLine(line);
        var state = {
          lineText: lineText,
          nextCh: lineText.charAt(curCh),
          lastCh: null,
          index: curCh,
          symb: symb,
          reverseSymb: (forward ?  { ')': '(', '}': '{' } : { '(': ')', '{': '}' })[symb],
          forward: forward,
          depth: 0,
          curMoveThrough: false
        };
        var mode = symbolToMode[symb];
        if (!mode)return cur;
        var init = findSymbolModes[mode].init;
        var isComplete = findSymbolModes[mode].isComplete;
        if (init) { init(state); }
        while (line !== endLine && repeat) {
          state.index += increment;
          state.nextCh = state.lineText.charAt(state.index);
          if (!state.nextCh) {
            line += increment;
            state.lineText = cm.getLine(line) || '';
            if (increment > 0) {
              state.index = 0;
            } else {
              var lineLen = state.lineText.length;
              state.index = (lineLen > 0) ? (lineLen-1) : 0;
            }
            state.nextCh = state.lineText.charAt(state.index);
          }
          if (isComplete(state)) {
            cur.line = line;
            cur.ch = state.index;
            repeat--;
          }
        }
        if (state.nextCh || state.curMoveThrough) {
          return Pos(line, state.index);
        }
        return cur;
      }
  
      /*
       * Returns the boundaries of the next word. If the cursor in the middle of
       * the word, then returns the boundaries of the current word, starting at
       * the cursor. If the cursor is at the start/end of a word, and we are going
       * forward/backward, respectively, find the boundaries of the next word.
       *
       * @param {CodeMirror} cm CodeMirror object.
       * @param {Cursor} cur The cursor position.
       * @param {boolean} forward True to search forward. False to search
       *     backward.
       * @param {boolean} bigWord True if punctuation count as part of the word.
       *     False if only [a-zA-Z0-9] characters count as part of the word.
       * @param {boolean} emptyLineIsWord True if empty lines should be treated
       *     as words.
       * @return {Object{from:number, to:number, line: number}} The boundaries of
       *     the word, or null if there are no more words.
       */
      function findWord(cm, cur, forward, bigWord, emptyLineIsWord) {
        var lineNum = cur.line;
        var pos = cur.ch;
        var line = cm.getLine(lineNum);
        var dir = forward ? 1 : -1;
        var charTests = bigWord ? bigWordCharTest: wordCharTest;
  
        if (emptyLineIsWord && line == '') {
          lineNum += dir;
          line = cm.getLine(lineNum);
          if (!isLine(cm, lineNum)) {
            return null;
          }
          pos = (forward) ? 0 : line.length;
        }
  
        while (true) {
          if (emptyLineIsWord && line == '') {
            return { from: 0, to: 0, line: lineNum };
          }
          var stop = (dir > 0) ? line.length : -1;
          var wordStart = stop, wordEnd = stop;
          // Find bounds of next word.
          while (pos != stop) {
            var foundWord = false;
            for (var i = 0; i < charTests.length && !foundWord; ++i) {
              if (charTests[i](line.charAt(pos))) {
                wordStart = pos;
                // Advance to end of word.
                while (pos != stop && charTests[i](line.charAt(pos))) {
                  pos += dir;
                }
                wordEnd = pos;
                foundWord = wordStart != wordEnd;
                if (wordStart == cur.ch && lineNum == cur.line &&
                    wordEnd == wordStart + dir) {
                  // We started at the end of a word. Find the next one.
                  continue;
                } else {
                  return {
                    from: Math.min(wordStart, wordEnd + 1),
                    to: Math.max(wordStart, wordEnd),
                    line: lineNum };
                }
              }
            }
            if (!foundWord) {
              pos += dir;
            }
          }
          // Advance to next/prev line.
          lineNum += dir;
          if (!isLine(cm, lineNum)) {
            return null;
          }
          line = cm.getLine(lineNum);
          pos = (dir > 0) ? 0 : line.length;
        }
      }
  
      /**
       * @param {CodeMirror} cm CodeMirror object.
       * @param {Pos} cur The position to start from.
       * @param {int} repeat Number of words to move past.
       * @param {boolean} forward True to search forward. False to search
       *     backward.
       * @param {boolean} wordEnd True to move to end of word. False to move to
       *     beginning of word.
       * @param {boolean} bigWord True if punctuation count as part of the word.
       *     False if only alphabet characters count as part of the word.
       * @return {Cursor} The position the cursor should move to.
       */
      function moveToWord(cm, cur, repeat, forward, wordEnd, bigWord) {
        var curStart = copyCursor(cur);
        var words = [];
        if (forward && !wordEnd || !forward && wordEnd) {
          repeat++;
        }
        // For 'e', empty lines are not considered words, go figure.
        var emptyLineIsWord = !(forward && wordEnd);
        for (var i = 0; i < repeat; i++) {
          var word = findWord(cm, cur, forward, bigWord, emptyLineIsWord);
          if (!word) {
            var eodCh = lineLength(cm, cm.lastLine());
            words.push(forward
                ? {line: cm.lastLine(), from: eodCh, to: eodCh}
                : {line: 0, from: 0, to: 0});
            break;
          }
          words.push(word);
          cur = Pos(word.line, forward ? (word.to - 1) : word.from);
        }
        var shortCircuit = words.length != repeat;
        var firstWord = words[0];
        var lastWord = words.pop();
        if (forward && !wordEnd) {
          // w
          if (!shortCircuit && (firstWord.from != curStart.ch || firstWord.line != curStart.line)) {
            // We did not start in the middle of a word. Discard the extra word at the end.
            lastWord = words.pop();
          }
          return Pos(lastWord.line, lastWord.from);
        } else if (forward && wordEnd) {
          return Pos(lastWord.line, lastWord.to - 1);
        } else if (!forward && wordEnd) {
          // ge
          if (!shortCircuit && (firstWord.to != curStart.ch || firstWord.line != curStart.line)) {
            // We did not start in the middle of a word. Discard the extra word at the end.
            lastWord = words.pop();
          }
          return Pos(lastWord.line, lastWord.to);
        } else {
          // b
          return Pos(lastWord.line, lastWord.from);
        }
      }
  
      function moveToCharacter(cm, repeat, forward, character) {
        var cur = cm.getCursor();
        var start = cur.ch;
        var idx;
        for (var i = 0; i < repeat; i ++) {
          var line = cm.getLine(cur.line);
          idx = charIdxInLine(start, line, character, forward, true);
          if (idx == -1) {
            return null;
          }
          start = idx;
        }
        return Pos(cm.getCursor().line, idx);
      }
  
      function moveToColumn(cm, repeat) {
        // repeat is always >= 1, so repeat - 1 always corresponds
        // to the column we want to go to.
        var line = cm.getCursor().line;
        return clipCursorToContent(cm, Pos(line, repeat - 1));
      }
  
      function updateMark(cm, vim, markName, pos) {
        if (!inArray(markName, validMarks)) {
          return;
        }
        if (vim.marks[markName]) {
          vim.marks[markName].clear();
        }
        vim.marks[markName] = cm.setBookmark(pos);
      }
  
      function charIdxInLine(start, line, character, forward, includeChar) {
        // Search for char in line.
        // motion_options: {forward, includeChar}
        // If includeChar = true, include it too.
        // If forward = true, search forward, else search backwards.
        // If char is not found on this line, do nothing
        var idx;
        if (forward) {
          idx = line.indexOf(character, start + 1);
          if (idx != -1 && !includeChar) {
            idx -= 1;
          }
        } else {
          idx = line.lastIndexOf(character, start - 1);
          if (idx != -1 && !includeChar) {
            idx += 1;
          }
        }
        return idx;
      }
  
      function findParagraph(cm, head, repeat, dir, inclusive) {
        var line = head.line;
        var min = cm.firstLine();
        var max = cm.lastLine();
        var start, end, i = line;
        function isEmpty(i) { return !cm.getLine(i); }
        function isBoundary(i, dir, any) {
          if (any) { return isEmpty(i) != isEmpty(i + dir); }
          return !isEmpty(i) && isEmpty(i + dir);
        }
        if (dir) {
          while (min <= i && i <= max && repeat > 0) {
            if (isBoundary(i, dir)) { repeat--; }
            i += dir;
          }
          return new Pos(i, 0);
        }
  
        var vim = cm.state.vim;
        if (vim.visualLine && isBoundary(line, 1, true)) {
          var anchor = vim.sel.anchor;
          if (isBoundary(anchor.line, -1, true)) {
            if (!inclusive || anchor.line != line) {
              line += 1;
            }
          }
        }
        var startState = isEmpty(line);
        for (i = line; i <= max && repeat; i++) {
          if (isBoundary(i, 1, true)) {
            if (!inclusive || isEmpty(i) != startState) {
              repeat--;
            }
          }
        }
        end = new Pos(i, 0);
        // select boundary before paragraph for the last one
        if (i > max && !startState) { startState = true; }
        else { inclusive = false; }
        for (i = line; i > min; i--) {
          if (!inclusive || isEmpty(i) == startState || i == line) {
            if (isBoundary(i, -1, true)) { break; }
          }
        }
        start = new Pos(i, 0);
        return { start: start, end: end };
      }
  
      function findSentence(cm, cur, repeat, dir) {
  
        /*
          Takes an index object
          {
            line: the line string,
            ln: line number,
            pos: index in line,
            dir: direction of traversal (-1 or 1)
          }
          and modifies the line, ln, and pos members to represent the
          next valid position or sets them to null if there are
          no more valid positions.
         */
        function nextChar(cm, idx) {
          if (idx.pos + idx.dir < 0 || idx.pos + idx.dir >= idx.line.length) {
            idx.ln += idx.dir;
            if (!isLine(cm, idx.ln)) {
              idx.line = null;
              idx.ln = null;
              idx.pos = null;
              return;
            }
            idx.line = cm.getLine(idx.ln);
            idx.pos = (idx.dir > 0) ? 0 : idx.line.length - 1;
          }
          else {
            idx.pos += idx.dir;
          }
        }
  
        /*
          Performs one iteration of traversal in forward direction
          Returns an index object of the new location
         */
        function forward(cm, ln, pos, dir) {
          var line = cm.getLine(ln);
          var stop = (line === "");
  
          var curr = {
            line: line,
            ln: ln,
            pos: pos,
            dir: dir,
          }
  
          var last_valid = {
            ln: curr.ln,
            pos: curr.pos,
          }
  
          var skip_empty_lines = (curr.line === "");
  
          // Move one step to skip character we start on
          nextChar(cm, curr);
  
          while (curr.line !== null) {
            last_valid.ln = curr.ln;
            last_valid.pos = curr.pos;
  
            if (curr.line === "" && !skip_empty_lines) {
              return { ln: curr.ln, pos: curr.pos, };
            }
            else if (stop && curr.line !== "" && !isWhiteSpaceString(curr.line[curr.pos])) {
              return { ln: curr.ln, pos: curr.pos, };
            }
            else if (isEndOfSentenceSymbol(curr.line[curr.pos])
              && !stop
              && (curr.pos === curr.line.length - 1
                || isWhiteSpaceString(curr.line[curr.pos + 1]))) {
              stop = true;
            }
  
            nextChar(cm, curr);
          }
  
          /*
            Set the position to the last non whitespace character on the last
            valid line in the case that we reach the end of the document.
          */
          var line = cm.getLine(last_valid.ln);
          last_valid.pos = 0;
          for(var i = line.length - 1; i >= 0; --i) {
            if (!isWhiteSpaceString(line[i])) {
              last_valid.pos = i;
              break;
            }
          }
  
          return last_valid;
  
        }
  
        /*
          Performs one iteration of traversal in reverse direction
          Returns an index object of the new location
         */
        function reverse(cm, ln, pos, dir) {
          var line = cm.getLine(ln);
  
          var curr = {
            line: line,
            ln: ln,
            pos: pos,
            dir: dir,
          }
  
          var last_valid = {
            ln: curr.ln,
            pos: null,
          };
  
          var skip_empty_lines = (curr.line === "");
  
          // Move one step to skip character we start on
          nextChar(cm, curr);
  
          while (curr.line !== null) {
  
            if (curr.line === "" && !skip_empty_lines) {
              if (last_valid.pos !== null) {
                return last_valid;
              }
              else {
                return { ln: curr.ln, pos: curr.pos };
              }
            }
            else if (isEndOfSentenceSymbol(curr.line[curr.pos])
                && last_valid.pos !== null
                && !(curr.ln === last_valid.ln && curr.pos + 1 === last_valid.pos)) {
              return last_valid;
            }
            else if (curr.line !== "" && !isWhiteSpaceString(curr.line[curr.pos])) {
              skip_empty_lines = false;
              last_valid = { ln: curr.ln, pos: curr.pos }
            }
  
            nextChar(cm, curr);
          }
  
          /*
            Set the position to the first non whitespace character on the last
            valid line in the case that we reach the beginning of the document.
          */
          var line = cm.getLine(last_valid.ln);
          last_valid.pos = 0;
          for(var i = 0; i < line.length; ++i) {
            if (!isWhiteSpaceString(line[i])) {
              last_valid.pos = i;
              break;
            }
          }
          return last_valid;
        }
  
        var curr_index = {
          ln: cur.line,
          pos: cur.ch,
        };
  
        while (repeat > 0) {
          if (dir < 0) {
            curr_index = reverse(cm, curr_index.ln, curr_index.pos, dir);
          }
          else {
            curr_index = forward(cm, curr_index.ln, curr_index.pos, dir);
          }
          repeat--;
        }
  
        return Pos(curr_index.ln, curr_index.pos);
      }
  
      // TODO: perhaps this finagling of start and end positions belonds
      // in codemirror/replaceRange?
      function selectCompanionObject(cm, head, symb, inclusive) {
        var cur = head, start, end;
  
        var bracketRegexp = ({
          '(': /[()]/, ')': /[()]/,
          '[': /[[\]]/, ']': /[[\]]/,
          '{': /[{}]/, '}': /[{}]/,
          '<': /[<>]/, '>': /[<>]/})[symb];
        var openSym = ({
          '(': '(', ')': '(',
          '[': '[', ']': '[',
          '{': '{', '}': '{',
          '<': '<', '>': '<'})[symb];
        var curChar = cm.getLine(cur.line).charAt(cur.ch);
        // Due to the behavior of scanForBracket, we need to add an offset if the
        // cursor is on a matching open bracket.
        var offset = curChar === openSym ? 1 : 0;
  
        start = cm.scanForBracket(Pos(cur.line, cur.ch + offset), -1, undefined, {'bracketRegex': bracketRegexp});
        end = cm.scanForBracket(Pos(cur.line, cur.ch + offset), 1, undefined, {'bracketRegex': bracketRegexp});
  
        if (!start || !end) {
          return { start: cur, end: cur };
        }
  
        start = start.pos;
        end = end.pos;
  
        if ((start.line == end.line && start.ch > end.ch)
            || (start.line > end.line)) {
          var tmp = start;
          start = end;
          end = tmp;
        }
  
        if (inclusive) {
          end.ch += 1;
        } else {
          start.ch += 1;
        }
  
        return { start: start, end: end };
      }
  
      // Takes in a symbol and a cursor and tries to simulate text objects that
      // have identical opening and closing symbols
      // TODO support across multiple lines
      function findBeginningAndEnd(cm, head, symb, inclusive) {
        var cur = copyCursor(head);
        var line = cm.getLine(cur.line);
        var chars = line.split('');
        var start, end, i, len;
        var firstIndex = chars.indexOf(symb);
  
        // the decision tree is to always look backwards for the beginning first,
        // but if the cursor is in front of the first instance of the symb,
        // then move the cursor forward
        if (cur.ch < firstIndex) {
          cur.ch = firstIndex;
          // Why is this line even here???
          // cm.setCursor(cur.line, firstIndex+1);
        }
        // otherwise if the cursor is currently on the closing symbol
        else if (firstIndex < cur.ch && chars[cur.ch] == symb) {
          end = cur.ch; // assign end to the current cursor
          --cur.ch; // make sure to look backwards
        }
  
        // if we're currently on the symbol, we've got a start
        if (chars[cur.ch] == symb && !end) {
          start = cur.ch + 1; // assign start to ahead of the cursor
        } else {
          // go backwards to find the start
          for (i = cur.ch; i > -1 && !start; i--) {
            if (chars[i] == symb) {
              start = i + 1;
            }
          }
        }
  
        // look forwards for the end symbol
        if (start && !end) {
          for (i = start, len = chars.length; i < len && !end; i++) {
            if (chars[i] == symb) {
              end = i;
            }
          }
        }
  
        // nothing found
        if (!start || !end) {
          return { start: cur, end: cur };
        }
  
        // include the symbols
        if (inclusive) {
          --start; ++end;
        }
  
        return {
          start: Pos(cur.line, start),
          end: Pos(cur.line, end)
        };
      }
  
      // Search functions
      defineOption('pcre', true, 'boolean');
      function SearchState() {}
      SearchState.prototype = {
        getQuery: function() {
          return vimGlobalState.query;
        },
        setQuery: function(query) {
          vimGlobalState.query = query;
        },
        getOverlay: function() {
          return this.searchOverlay;
        },
        setOverlay: function(overlay) {
          this.searchOverlay = overlay;
        },
        isReversed: function() {
          return vimGlobalState.isReversed;
        },
        setReversed: function(reversed) {
          vimGlobalState.isReversed = reversed;
        },
        getScrollbarAnnotate: function() {
          return this.annotate;
        },
        setScrollbarAnnotate: function(annotate) {
          this.annotate = annotate;
        }
      };
      function getSearchState(cm) {
        var vim = cm.state.vim;
        return vim.searchState_ || (vim.searchState_ = new SearchState());
      }
      function dialog(cm, template, shortText, onClose, options) {
        if (cm.openDialog) {
          cm.openDialog(template, onClose, { bottom: true, value: options.value,
              onKeyDown: options.onKeyDown, onKeyUp: options.onKeyUp,
              selectValueOnOpen: false});
        }
        else {
          onClose(prompt(shortText, ''));
        }
      }
      function splitBySlash(argString) {
        return splitBySeparator(argString, '/');
      }
  
      function findUnescapedSlashes(argString) {
        return findUnescapedSeparators(argString, '/');
      }
  
      function splitBySeparator(argString, separator) {
        var slashes = findUnescapedSeparators(argString, separator) || [];
        if (!slashes.length) return [];
        var tokens = [];
        // in case of strings like foo/bar
        if (slashes[0] !== 0) return;
        for (var i = 0; i < slashes.length; i++) {
          if (typeof slashes[i] == 'number')
            tokens.push(argString.substring(slashes[i] + 1, slashes[i+1]));
        }
        return tokens;
      }
  
      function findUnescapedSeparators(str, separator) {
        if (!separator)
          separator = '/';
  
        var escapeNextChar = false;
        var slashes = [];
        for (var i = 0; i < str.length; i++) {
          var c = str.charAt(i);
          if (!escapeNextChar && c == separator) {
            slashes.push(i);
          }
          escapeNextChar = !escapeNextChar && (c == '\\');
        }
        return slashes;
      }
  
      // Translates a search string from ex (vim) syntax into javascript form.
      function translateRegex(str) {
        // When these match, add a '\' if unescaped or remove one if escaped.
        var specials = '|(){';
        // Remove, but never add, a '\' for these.
        var unescape = '}';
        var escapeNextChar = false;
        var out = [];
        for (var i = -1; i < str.length; i++) {
          var c = str.charAt(i) || '';
          var n = str.charAt(i+1) || '';
          var specialComesNext = (n && specials.indexOf(n) != -1);
          if (escapeNextChar) {
            if (c !== '\\' || !specialComesNext) {
              out.push(c);
            }
            escapeNextChar = false;
          } else {
            if (c === '\\') {
              escapeNextChar = true;
              // Treat the unescape list as special for removing, but not adding '\'.
              if (n && unescape.indexOf(n) != -1) {
                specialComesNext = true;
              }
              // Not passing this test means removing a '\'.
              if (!specialComesNext || n === '\\') {
                out.push(c);
              }
            } else {
              out.push(c);
              if (specialComesNext && n !== '\\') {
                out.push('\\');
              }
            }
          }
        }
        return out.join('');
      }
  
      // Translates the replace part of a search and replace from ex (vim) syntax into
      // javascript form.  Similar to translateRegex, but additionally fixes back references
      // (translates '\[0..9]' to '$[0..9]') and follows different rules for escaping '$'.
      var charUnescapes = {'\\n': '\n', '\\r': '\r', '\\t': '\t'};
      function translateRegexReplace(str) {
        var escapeNextChar = false;
        var out = [];
        for (var i = -1; i < str.length; i++) {
          var c = str.charAt(i) || '';
          var n = str.charAt(i+1) || '';
          if (charUnescapes[c + n]) {
            out.push(charUnescapes[c+n]);
            i++;
          } else if (escapeNextChar) {
            // At any point in the loop, escapeNextChar is true if the previous
            // character was a '\' and was not escaped.
            out.push(c);
            escapeNextChar = false;
          } else {
            if (c === '\\') {
              escapeNextChar = true;
              if ((isNumber(n) || n === '$')) {
                out.push('$');
              } else if (n !== '/' && n !== '\\') {
                out.push('\\');
              }
            } else {
              if (c === '$') {
                out.push('$');
              }
              out.push(c);
              if (n === '/') {
                out.push('\\');
              }
            }
          }
        }
        return out.join('');
      }
  
      // Unescape \ and / in the replace part, for PCRE mode.
      var unescapes = {'\\/': '/', '\\\\': '\\', '\\n': '\n', '\\r': '\r', '\\t': '\t', '\\&':'&'};
      function unescapeRegexReplace(str) {
        var stream = new CodeMirror.StringStream(str);
        var output = [];
        while (!stream.eol()) {
          // Search for \.
          while (stream.peek() && stream.peek() != '\\') {
            output.push(stream.next());
          }
          var matched = false;
          for (var matcher in unescapes) {
            if (stream.match(matcher, true)) {
              matched = true;
              output.push(unescapes[matcher]);
              break;
            }
          }
          if (!matched) {
            // Don't change anything
            output.push(stream.next());
          }
        }
        return output.join('');
      }
  
      /**
       * Extract the regular expression from the query and return a Regexp object.
       * Returns null if the query is blank.
       * If ignoreCase is passed in, the Regexp object will have the 'i' flag set.
       * If smartCase is passed in, and the query contains upper case letters,
       *   then ignoreCase is overridden, and the 'i' flag will not be set.
       * If the query contains the /i in the flag part of the regular expression,
       *   then both ignoreCase and smartCase are ignored, and 'i' will be passed
       *   through to the Regex object.
       */
      function parseQuery(query, ignoreCase, smartCase) {
        // First update the last search register
        var lastSearchRegister = vimGlobalState.registerController.getRegister('/');
        lastSearchRegister.setText(query);
        // Check if the query is already a regex.
        if (query instanceof RegExp) { return query; }
        // First try to extract regex + flags from the input. If no flags found,
        // extract just the regex. IE does not accept flags directly defined in
        // the regex string in the form /regex/flags
        var slashes = findUnescapedSlashes(query);
        var regexPart;
        var forceIgnoreCase;
        if (!slashes.length) {
          // Query looks like 'regexp'
          regexPart = query;
        } else {
          // Query looks like 'regexp/...'
          regexPart = query.substring(0, slashes[0]);
          var flagsPart = query.substring(slashes[0]);
          forceIgnoreCase = (flagsPart.indexOf('i') != -1);
        }
        if (!regexPart) {
          return null;
        }
        if (!getOption('pcre')) {
          regexPart = translateRegex(regexPart);
        }
        if (smartCase) {
          ignoreCase = (/^[^A-Z]*$/).test(regexPart);
        }
        var regexp = new RegExp(regexPart,
            (ignoreCase || forceIgnoreCase) ? 'i' : undefined);
        return regexp;
      }
      function showConfirm(cm, text) {
        if (cm.openNotification) {
          cm.openNotification('<span style="color: red">' + text + '</span>',
                              {bottom: true, duration: 5000});
        } else {
          alert(text);
        }
      }
      function makePrompt(prefix, desc) {
        var raw = '<span style="font-family: monospace; white-space: pre">' +
            (prefix || "") + '<input type="text" autocorrect="off" ' +
            'autocapitalize="off" spellcheck="false"></span>';
        if (desc)
          raw += ' <span style="color: #888">' + desc + '</span>';
        return raw;
      }
      var searchPromptDesc = '(Javascript regexp)';
      function showPrompt(cm, options) {
        var shortText = (options.prefix || '') + ' ' + (options.desc || '');
        var prompt = makePrompt(options.prefix, options.desc);
        dialog(cm, prompt, shortText, options.onClose, options);
      }
      function regexEqual(r1, r2) {
        if (r1 instanceof RegExp && r2 instanceof RegExp) {
            var props = ['global', 'multiline', 'ignoreCase', 'source'];
            for (var i = 0; i < props.length; i++) {
                var prop = props[i];
                if (r1[prop] !== r2[prop]) {
                    return false;
                }
            }
            return true;
        }
        return false;
      }
      // Returns true if the query is valid.
      function updateSearchQuery(cm, rawQuery, ignoreCase, smartCase) {
        if (!rawQuery) {
          return;
        }
        var state = getSearchState(cm);
        var query = parseQuery(rawQuery, !!ignoreCase, !!smartCase);
        if (!query) {
          return;
        }
        highlightSearchMatches(cm, query);
        if (regexEqual(query, state.getQuery())) {
          return query;
        }
        state.setQuery(query);
        return query;
      }
      function searchOverlay(query) {
        if (query.source.charAt(0) == '^') {
          var matchSol = true;
        }
        return {
          token: function(stream) {
            if (matchSol && !stream.sol()) {
              stream.skipToEnd();
              return;
            }
            var match = stream.match(query, false);
            if (match) {
              if (match[0].length == 0) {
                // Matched empty string, skip to next.
                stream.next();
                return 'searching';
              }
              if (!stream.sol()) {
                // Backtrack 1 to match \b
                stream.backUp(1);
                if (!query.exec(stream.next() + match[0])) {
                  stream.next();
                  return null;
                }
              }
              stream.match(query);
              return 'searching';
            }
            while (!stream.eol()) {
              stream.next();
              if (stream.match(query, false)) break;
            }
          },
          query: query
        };
      }
      var highlightTimeout = 0;
      function highlightSearchMatches(cm, query) {
        clearTimeout(highlightTimeout);
        highlightTimeout = setTimeout(function() {
          var searchState = getSearchState(cm);
          var overlay = searchState.getOverlay();
          if (!overlay || query != overlay.query) {
            if (overlay) {
              cm.removeOverlay(overlay);
            }
            overlay = searchOverlay(query);
            cm.addOverlay(overlay);
            if (cm.showMatchesOnScrollbar) {
              if (searchState.getScrollbarAnnotate()) {
                searchState.getScrollbarAnnotate().clear();
              }
              searchState.setScrollbarAnnotate(cm.showMatchesOnScrollbar(query));
            }
            searchState.setOverlay(overlay);
          }
        }, 50);
      }
      function findNext(cm, prev, query, repeat) {
        if (repeat === undefined) { repeat = 1; }
        return cm.operation(function() {
          var pos = cm.getCursor();
          var cursor = cm.getSearchCursor(query, pos);
          for (var i = 0; i < repeat; i++) {
            var found = cursor.find(prev);
            if (i == 0 && found && cursorEqual(cursor.from(), pos)) { found = cursor.find(prev); }
            if (!found) {
              // SearchCursor may have returned null because it hit EOF, wrap
              // around and try again.
              cursor = cm.getSearchCursor(query,
                  (prev) ? Pos(cm.lastLine()) : Pos(cm.firstLine(), 0) );
              if (!cursor.find(prev)) {
                return;
              }
            }
          }
          return cursor.from();
        });
      }
      function clearSearchHighlight(cm) {
        var state = getSearchState(cm);
        cm.removeOverlay(getSearchState(cm).getOverlay());
        state.setOverlay(null);
        if (state.getScrollbarAnnotate()) {
          state.getScrollbarAnnotate().clear();
          state.setScrollbarAnnotate(null);
        }
      }
      /**
       * Check if pos is in the specified range, INCLUSIVE.
       * Range can be specified with 1 or 2 arguments.
       * If the first range argument is an array, treat it as an array of line
       * numbers. Match pos against any of the lines.
       * If the first range argument is a number,
       *   if there is only 1 range argument, check if pos has the same line
       *       number
       *   if there are 2 range arguments, then check if pos is in between the two
       *       range arguments.
       */
      function isInRange(pos, start, end) {
        if (typeof pos != 'number') {
          // Assume it is a cursor position. Get the line number.
          pos = pos.line;
        }
        if (start instanceof Array) {
          return inArray(pos, start);
        } else {
          if (end) {
            return (pos >= start && pos <= end);
          } else {
            return pos == start;
          }
        }
      }
      function getUserVisibleLines(cm) {
        var scrollInfo = cm.getScrollInfo();
        var occludeToleranceTop = 6;
        var occludeToleranceBottom = 10;
        var from = cm.coordsChar({left:0, top: occludeToleranceTop + scrollInfo.top}, 'local');
        var bottomY = scrollInfo.clientHeight - occludeToleranceBottom + scrollInfo.top;
        var to = cm.coordsChar({left:0, top: bottomY}, 'local');
        return {top: from.line, bottom: to.line};
      }
  
      function getMarkPos(cm, vim, markName) {
        if (markName == '\'' || markName == '`') {
          return vimGlobalState.jumpList.find(cm, -1) || Pos(0, 0);
        } else if (markName == '.') {
          return getLastEditPos(cm);
        }
  
        var mark = vim.marks[markName];
        return mark && mark.find();
      }
  
      function getLastEditPos(cm) {
        var done = cm.doc.history.done;
        for (var i = done.length; i--;) {
          if (done[i].changes) {
            return copyCursor(done[i].changes[0].to);
          }
        }
      }
  
      var ExCommandDispatcher = function() {
        this.buildCommandMap_();
      };
      ExCommandDispatcher.prototype = {
        processCommand: function(cm, input, opt_params) {
          var that = this;
          cm.operation(function () {
            cm.curOp.isVimOp = true;
            that._processCommand(cm, input, opt_params);
          });
        },
        _processCommand: function(cm, input, opt_params) {
          var vim = cm.state.vim;
          var commandHistoryRegister = vimGlobalState.registerController.getRegister(':');
          var previousCommand = commandHistoryRegister.toString();
          if (vim.visualMode) {
            exitVisualMode(cm);
          }
          var inputStream = new CodeMirror.StringStream(input);
          // update ": with the latest command whether valid or invalid
          commandHistoryRegister.setText(input);
          var params = opt_params || {};
          params.input = input;
          try {
            this.parseInput_(cm, inputStream, params);
          } catch(e) {
            showConfirm(cm, e);
            throw e;
          }
          var command;
          var commandName;
          if (!params.commandName) {
            // If only a line range is defined, move to the line.
            if (params.line !== undefined) {
              commandName = 'move';
            }
          } else {
            command = this.matchCommand_(params.commandName);
            if (command) {
              commandName = command.name;
              if (command.excludeFromCommandHistory) {
                commandHistoryRegister.setText(previousCommand);
              }
              this.parseCommandArgs_(inputStream, params, command);
              if (command.type == 'exToKey') {
                // Handle Ex to Key mapping.
                for (var i = 0; i < command.toKeys.length; i++) {
                  CodeMirror.Vim.handleKey(cm, command.toKeys[i], 'mapping');
                }
                return;
              } else if (command.type == 'exToEx') {
                // Handle Ex to Ex mapping.
                this.processCommand(cm, command.toInput);
                return;
              }
            }
          }
          if (!commandName) {
            showConfirm(cm, 'Not an editor command ":' + input + '"');
            return;
          }
          try {
            exCommands[commandName](cm, params);
            // Possibly asynchronous commands (e.g. substitute, which might have a
            // user confirmation), are responsible for calling the callback when
            // done. All others have it taken care of for them here.
            if ((!command || !command.possiblyAsync) && params.callback) {
              params.callback();
            }
          } catch(e) {
            showConfirm(cm, e);
            throw e;
          }
        },
        parseInput_: function(cm, inputStream, result) {
          inputStream.eatWhile(':');
          // Parse range.
          if (inputStream.eat('%')) {
            result.line = cm.firstLine();
            result.lineEnd = cm.lastLine();
          } else {
            result.line = this.parseLineSpec_(cm, inputStream);
            if (result.line !== undefined && inputStream.eat(',')) {
              result.lineEnd = this.parseLineSpec_(cm, inputStream);
            }
          }
  
          // Parse command name.
          var commandMatch = inputStream.match(/^(\w+|!!|@@|[!#&*<=>@~])/);
          if (commandMatch) {
            result.commandName = commandMatch[1];
          } else {
            result.commandName = inputStream.match(/.*/)[0];
          }
  
          return result;
        },
        parseLineSpec_: function(cm, inputStream) {
          var numberMatch = inputStream.match(/^(\d+)/);
          if (numberMatch) {
            // Absolute line number plus offset (N+M or N-M) is probably a typo,
            // not something the user actually wanted. (NB: vim does allow this.)
            return parseInt(numberMatch[1], 10) - 1;
          }
          switch (inputStream.next()) {
            case '.':
              return this.parseLineSpecOffset_(inputStream, cm.getCursor().line);
            case '$':
              return this.parseLineSpecOffset_(inputStream, cm.lastLine());
            case '\'':
              var markName = inputStream.next();
              var markPos = getMarkPos(cm, cm.state.vim, markName);
              if (!markPos) throw new Error('Mark not set');
              return this.parseLineSpecOffset_(inputStream, markPos.line);
            case '-':
            case '+':
              inputStream.backUp(1);
              // Offset is relative to current line if not otherwise specified.
              return this.parseLineSpecOffset_(inputStream, cm.getCursor().line);
            default:
              inputStream.backUp(1);
              return undefined;
          }
        },
        parseLineSpecOffset_: function(inputStream, line) {
          var offsetMatch = inputStream.match(/^([+-])?(\d+)/);
          if (offsetMatch) {
            var offset = parseInt(offsetMatch[2], 10);
            if (offsetMatch[1] == "-") {
              line -= offset;
            } else {
              line += offset;
            }
          }
          return line;
        },
        parseCommandArgs_: function(inputStream, params, command) {
          if (inputStream.eol()) {
            return;
          }
          params.argString = inputStream.match(/.*/)[0];
          // Parse command-line arguments
          var delim = command.argDelimiter || /\s+/;
          var args = trim(params.argString).split(delim);
          if (args.length && args[0]) {
            params.args = args;
          }
        },
        matchCommand_: function(commandName) {
          // Return the command in the command map that matches the shortest
          // prefix of the passed in command name. The match is guaranteed to be
          // unambiguous if the defaultExCommandMap's shortNames are set up
          // correctly. (see @code{defaultExCommandMap}).
          for (var i = commandName.length; i > 0; i--) {
            var prefix = commandName.substring(0, i);
            if (this.commandMap_[prefix]) {
              var command = this.commandMap_[prefix];
              if (command.name.indexOf(commandName) === 0) {
                return command;
              }
            }
          }
          return null;
        },
        buildCommandMap_: function() {
          this.commandMap_ = {};
          for (var i = 0; i < defaultExCommandMap.length; i++) {
            var command = defaultExCommandMap[i];
            var key = command.shortName || command.name;
            this.commandMap_[key] = command;
          }
        },
        map: function(lhs, rhs, ctx) {
          if (lhs != ':' && lhs.charAt(0) == ':') {
            if (ctx) { throw Error('Mode not supported for ex mappings'); }
            var commandName = lhs.substring(1);
            if (rhs != ':' && rhs.charAt(0) == ':') {
              // Ex to Ex mapping
              this.commandMap_[commandName] = {
                name: commandName,
                type: 'exToEx',
                toInput: rhs.substring(1),
                user: true
              };
            } else {
              // Ex to key mapping
              this.commandMap_[commandName] = {
                name: commandName,
                type: 'exToKey',
                toKeys: rhs,
                user: true
              };
            }
          } else {
            if (rhs != ':' && rhs.charAt(0) == ':') {
              // Key to Ex mapping.
              var mapping = {
                keys: lhs,
                type: 'keyToEx',
                exArgs: { input: rhs.substring(1) }
              };
              if (ctx) { mapping.context = ctx; }
              defaultKeymap.unshift(mapping);
            } else {
              // Key to key mapping
              var mapping = {
                keys: lhs,
                type: 'keyToKey',
                toKeys: rhs
              };
              if (ctx) { mapping.context = ctx; }
              defaultKeymap.unshift(mapping);
            }
          }
        },
        unmap: function(lhs, ctx) {
          if (lhs != ':' && lhs.charAt(0) == ':') {
            // Ex to Ex or Ex to key mapping
            if (ctx) { throw Error('Mode not supported for ex mappings'); }
            var commandName = lhs.substring(1);
            if (this.commandMap_[commandName] && this.commandMap_[commandName].user) {
              delete this.commandMap_[commandName];
              return;
            }
          } else {
            // Key to Ex or key to key mapping
            var keys = lhs;
            for (var i = 0; i < defaultKeymap.length; i++) {
              if (keys == defaultKeymap[i].keys
                  && defaultKeymap[i].context === ctx) {
                defaultKeymap.splice(i, 1);
                return;
              }
            }
          }
          throw Error('No such mapping.');
        }
      };
  
      var exCommands = {
        colorscheme: function(cm, params) {
          if (!params.args || params.args.length < 1) {
            showConfirm(cm, cm.getOption('theme'));
            return;
          }
          cm.setOption('theme', params.args[0]);
        },
        map: function(cm, params, ctx) {
          var mapArgs = params.args;
          if (!mapArgs || mapArgs.length < 2) {
            if (cm) {
              showConfirm(cm, 'Invalid mapping: ' + params.input);
            }
            return;
          }
          exCommandDispatcher.map(mapArgs[0], mapArgs[1], ctx);
        },
        imap: function(cm, params) { this.map(cm, params, 'insert'); },
        nmap: function(cm, params) { this.map(cm, params, 'normal'); },
        vmap: function(cm, params) { this.map(cm, params, 'visual'); },
        unmap: function(cm, params, ctx) {
          var mapArgs = params.args;
          if (!mapArgs || mapArgs.length < 1) {
            if (cm) {
              showConfirm(cm, 'No such mapping: ' + params.input);
            }
            return;
          }
          exCommandDispatcher.unmap(mapArgs[0], ctx);
        },
        move: function(cm, params) {
          commandDispatcher.processCommand(cm, cm.state.vim, {
              type: 'motion',
              motion: 'moveToLineOrEdgeOfDocument',
              motionArgs: { forward: false, explicitRepeat: true,
                linewise: true },
              repeatOverride: params.line+1});
        },
        set: function(cm, params) {
          var setArgs = params.args;
          // Options passed through to the setOption/getOption calls. May be passed in by the
          // local/global versions of the set command
          var setCfg = params.setCfg || {};
          if (!setArgs || setArgs.length < 1) {
            if (cm) {
              showConfirm(cm, 'Invalid mapping: ' + params.input);
            }
            return;
          }
          var expr = setArgs[0].split('=');
          var optionName = expr[0];
          var value = expr[1];
          var forceGet = false;
  
          if (optionName.charAt(optionName.length - 1) == '?') {
            // If post-fixed with ?, then the set is actually a get.
            if (value) { throw Error('Trailing characters: ' + params.argString); }
            optionName = optionName.substring(0, optionName.length - 1);
            forceGet = true;
          }
          if (value === undefined && optionName.substring(0, 2) == 'no') {
            // To set boolean options to false, the option name is prefixed with
            // 'no'.
            optionName = optionName.substring(2);
            value = false;
          }
  
          var optionIsBoolean = options[optionName] && options[optionName].type == 'boolean';
          if (optionIsBoolean && value == undefined) {
            // Calling set with a boolean option sets it to true.
            value = true;
          }
          // If no value is provided, then we assume this is a get.
          if (!optionIsBoolean && value === undefined || forceGet) {
            var oldValue = getOption(optionName, cm, setCfg);
            if (oldValue instanceof Error) {
              showConfirm(cm, oldValue.message);
            } else if (oldValue === true || oldValue === false) {
              showConfirm(cm, ' ' + (oldValue ? '' : 'no') + optionName);
            } else {
              showConfirm(cm, '  ' + optionName + '=' + oldValue);
            }
          } else {
            var setOptionReturn = setOption(optionName, value, cm, setCfg);
            if (setOptionReturn instanceof Error) {
              showConfirm(cm, setOptionReturn.message);
            }
          }
        },
        setlocal: function (cm, params) {
          // setCfg is passed through to setOption
          params.setCfg = {scope: 'local'};
          this.set(cm, params);
        },
        setglobal: function (cm, params) {
          // setCfg is passed through to setOption
          params.setCfg = {scope: 'global'};
          this.set(cm, params);
        },
        registers: function(cm, params) {
          var regArgs = params.args;
          var registers = vimGlobalState.registerController.registers;
          var regInfo = '----------Registers----------<br><br>';
          if (!regArgs) {
            for (var registerName in registers) {
              var text = registers[registerName].toString();
              if (text.length) {
                regInfo += '"' + registerName + '    ' + text + '<br>';
              }
            }
          } else {
            var registerName;
            regArgs = regArgs.join('');
            for (var i = 0; i < regArgs.length; i++) {
              registerName = regArgs.charAt(i);
              if (!vimGlobalState.registerController.isValidRegister(registerName)) {
                continue;
              }
              var register = registers[registerName] || new Register();
              regInfo += '"' + registerName + '    ' + register.toString() + '<br>';
            }
          }
          showConfirm(cm, regInfo);
        },
        sort: function(cm, params) {
          var reverse, ignoreCase, unique, number, pattern;
          function parseArgs() {
            if (params.argString) {
              var args = new CodeMirror.StringStream(params.argString);
              if (args.eat('!')) { reverse = true; }
              if (args.eol()) { return; }
              if (!args.eatSpace()) { return 'Invalid arguments'; }
              var opts = args.match(/([dinuox]+)?\s*(\/.+\/)?\s*/);
              if (!opts && !args.eol()) { return 'Invalid arguments'; }
              if (opts[1]) {
                ignoreCase = opts[1].indexOf('i') != -1;
                unique = opts[1].indexOf('u') != -1;
                var decimal = opts[1].indexOf('d') != -1 || opts[1].indexOf('n') != -1 && 1;
                var hex = opts[1].indexOf('x') != -1 && 1;
                var octal = opts[1].indexOf('o') != -1 && 1;
                if (decimal + hex + octal > 1) { return 'Invalid arguments'; }
                number = decimal && 'decimal' || hex && 'hex' || octal && 'octal';
              }
              if (opts[2]) {
                pattern = new RegExp(opts[2].substr(1, opts[2].length - 2), ignoreCase ? 'i' : '');
              }
            }
          }
          var err = parseArgs();
          if (err) {
            showConfirm(cm, err + ': ' + params.argString);
            return;
          }
          var lineStart = params.line || cm.firstLine();
          var lineEnd = params.lineEnd || params.line || cm.lastLine();
          if (lineStart == lineEnd) { return; }
          var curStart = Pos(lineStart, 0);
          var curEnd = Pos(lineEnd, lineLength(cm, lineEnd));
          var text = cm.getRange(curStart, curEnd).split('\n');
          var numberRegex = pattern ? pattern :
             (number == 'decimal') ? /(-?)([\d]+)/ :
             (number == 'hex') ? /(-?)(?:0x)?([0-9a-f]+)/i :
             (number == 'octal') ? /([0-7]+)/ : null;
          var radix = (number == 'decimal') ? 10 : (number == 'hex') ? 16 : (number == 'octal') ? 8 : null;
          var numPart = [], textPart = [];
          if (number || pattern) {
            for (var i = 0; i < text.length; i++) {
              var matchPart = pattern ? text[i].match(pattern) : null;
              if (matchPart && matchPart[0] != '') {
                numPart.push(matchPart);
              } else if (!pattern && numberRegex.exec(text[i])) {
                numPart.push(text[i]);
              } else {
                textPart.push(text[i]);
              }
            }
          } else {
            textPart = text;
          }
          function compareFn(a, b) {
            if (reverse) { var tmp; tmp = a; a = b; b = tmp; }
            if (ignoreCase) { a = a.toLowerCase(); b = b.toLowerCase(); }
            var anum = number && numberRegex.exec(a);
            var bnum = number && numberRegex.exec(b);
            if (!anum) { return a < b ? -1 : 1; }
            anum = parseInt((anum[1] + anum[2]).toLowerCase(), radix);
            bnum = parseInt((bnum[1] + bnum[2]).toLowerCase(), radix);
            return anum - bnum;
          }
          function comparePatternFn(a, b) {
            if (reverse) { var tmp; tmp = a; a = b; b = tmp; }
            if (ignoreCase) { a[0] = a[0].toLowerCase(); b[0] = b[0].toLowerCase(); }
            return (a[0] < b[0]) ? -1 : 1;
          }
          numPart.sort(pattern ? comparePatternFn : compareFn);
          if (pattern) {
            for (var i = 0; i < numPart.length; i++) {
              numPart[i] = numPart[i].input;
            }
          } else if (!number) { textPart.sort(compareFn); }
          text = (!reverse) ? textPart.concat(numPart) : numPart.concat(textPart);
          if (unique) { // Remove duplicate lines
            var textOld = text;
            var lastLine;
            text = [];
            for (var i = 0; i < textOld.length; i++) {
              if (textOld[i] != lastLine) {
                text.push(textOld[i]);
              }
              lastLine = textOld[i];
            }
          }
          cm.replaceRange(text.join('\n'), curStart, curEnd);
        },
        global: function(cm, params) {
          // a global command is of the form
          // :[range]g/pattern/[cmd]
          // argString holds the string /pattern/[cmd]
          var argString = params.argString;
          if (!argString) {
            showConfirm(cm, 'Regular Expression missing from global');
            return;
          }
          // range is specified here
          var lineStart = (params.line !== undefined) ? params.line : cm.firstLine();
          var lineEnd = params.lineEnd || params.line || cm.lastLine();
          // get the tokens from argString
          var tokens = splitBySlash(argString);
          var regexPart = argString, cmd;
          if (tokens.length) {
            regexPart = tokens[0];
            cmd = tokens.slice(1, tokens.length).join('/');
          }
          if (regexPart) {
            // If regex part is empty, then use the previous query. Otherwise
            // use the regex part as the new query.
            try {
             updateSearchQuery(cm, regexPart, true /** ignoreCase */,
               true /** smartCase */);
            } catch (e) {
             showConfirm(cm, 'Invalid regex: ' + regexPart);
             return;
            }
          }
          // now that we have the regexPart, search for regex matches in the
          // specified range of lines
          var query = getSearchState(cm).getQuery();
          var matchedLines = [], content = '';
          for (var i = lineStart; i <= lineEnd; i++) {
            var matched = query.test(cm.getLine(i));
            if (matched) {
              matchedLines.push(i+1);
              content+= cm.getLine(i) + '<br>';
            }
          }
          // if there is no [cmd], just display the list of matched lines
          if (!cmd) {
            showConfirm(cm, content);
            return;
          }
          var index = 0;
          var nextCommand = function() {
            if (index < matchedLines.length) {
              var command = matchedLines[index] + cmd;
              exCommandDispatcher.processCommand(cm, command, {
                callback: nextCommand
              });
            }
            index++;
          };
          nextCommand();
        },
        substitute: function(cm, params) {
          if (!cm.getSearchCursor) {
            throw new Error('Search feature not available. Requires searchcursor.js or ' +
                'any other getSearchCursor implementation.');
          }
          var argString = params.argString;
          var tokens = argString ? splitBySeparator(argString, argString[0]) : [];
          var regexPart, replacePart = '', trailing, flagsPart, count;
          var confirm = false; // Whether to confirm each replace.
          var global = false; // True to replace all instances on a line, false to replace only 1.
          if (tokens.length) {
            regexPart = tokens[0];
            if (getOption('pcre') && regexPart !== '') {
                regexPart = new RegExp(regexPart).source; //normalize not escaped characters
            }
            replacePart = tokens[1];
            if (regexPart && regexPart[regexPart.length - 1] === '$') {
              regexPart = regexPart.slice(0, regexPart.length - 1) + '\\n';
              replacePart = replacePart ? replacePart + '\n' : '\n';
            }
            if (replacePart !== undefined) {
              if (getOption('pcre')) {
                replacePart = unescapeRegexReplace(replacePart.replace(/([^\\])&/g,"$1$$&"));
              } else {
                replacePart = translateRegexReplace(replacePart);
              }
              vimGlobalState.lastSubstituteReplacePart = replacePart;
            }
            trailing = tokens[2] ? tokens[2].split(' ') : [];
          } else {
            // either the argString is empty or its of the form ' hello/world'
            // actually splitBySlash returns a list of tokens
            // only if the string starts with a '/'
            if (argString && argString.length) {
              showConfirm(cm, 'Substitutions should be of the form ' +
                  ':s/pattern/replace/');
              return;
            }
          }
          // After the 3rd slash, we can have flags followed by a space followed
          // by count.
          if (trailing) {
            flagsPart = trailing[0];
            count = parseInt(trailing[1]);
            if (flagsPart) {
              if (flagsPart.indexOf('c') != -1) {
                confirm = true;
                flagsPart.replace('c', '');
              }
              if (flagsPart.indexOf('g') != -1) {
                global = true;
                flagsPart.replace('g', '');
              }
              if (getOption('pcre')) {
                 regexPart = regexPart + '/' + flagsPart;
              } else {
                 regexPart = regexPart.replace(/\//g, "\\/") + '/' + flagsPart;
              }
            }
          }
          if (regexPart) {
            // If regex part is empty, then use the previous query. Otherwise use
            // the regex part as the new query.
            try {
              updateSearchQuery(cm, regexPart, true /** ignoreCase */,
                true /** smartCase */);
            } catch (e) {
              showConfirm(cm, 'Invalid regex: ' + regexPart);
              return;
            }
          }
          replacePart = replacePart || vimGlobalState.lastSubstituteReplacePart;
          if (replacePart === undefined) {
            showConfirm(cm, 'No previous substitute regular expression');
            return;
          }
          var state = getSearchState(cm);
          var query = state.getQuery();
          var lineStart = (params.line !== undefined) ? params.line : cm.getCursor().line;
          var lineEnd = params.lineEnd || lineStart;
          if (lineStart == cm.firstLine() && lineEnd == cm.lastLine()) {
            lineEnd = Infinity;
          }
          if (count) {
            lineStart = lineEnd;
            lineEnd = lineStart + count - 1;
          }
          var startPos = clipCursorToContent(cm, Pos(lineStart, 0));
          var cursor = cm.getSearchCursor(query, startPos);
          doReplace(cm, confirm, global, lineStart, lineEnd, cursor, query, replacePart, params.callback);
        },
        redo: CodeMirror.commands.redo,
        undo: CodeMirror.commands.undo,
        write: function(cm) {
          if (CodeMirror.commands.save) {
            // If a save command is defined, call it.
            CodeMirror.commands.save(cm);
          } else if (cm.save) {
            // Saves to text area if no save command is defined and cm.save() is available.
            cm.save();
          }
        },
        nohlsearch: function(cm) {
          clearSearchHighlight(cm);
        },
        yank: function (cm) {
          var cur = copyCursor(cm.getCursor());
          var line = cur.line;
          var lineText = cm.getLine(line);
          vimGlobalState.registerController.pushText(
            '0', 'yank', lineText, true, true);
        },
        delmarks: function(cm, params) {
          if (!params.argString || !trim(params.argString)) {
            showConfirm(cm, 'Argument required');
            return;
          }
  
          var state = cm.state.vim;
          var stream = new CodeMirror.StringStream(trim(params.argString));
          while (!stream.eol()) {
            stream.eatSpace();
  
            // Record the streams position at the beginning of the loop for use
            // in error messages.
            var count = stream.pos;
  
            if (!stream.match(/[a-zA-Z]/, false)) {
              showConfirm(cm, 'Invalid argument: ' + params.argString.substring(count));
              return;
            }
  
            var sym = stream.next();
            // Check if this symbol is part of a range
            if (stream.match('-', true)) {
              // This symbol is part of a range.
  
              // The range must terminate at an alphabetic character.
              if (!stream.match(/[a-zA-Z]/, false)) {
                showConfirm(cm, 'Invalid argument: ' + params.argString.substring(count));
                return;
              }
  
              var startMark = sym;
              var finishMark = stream.next();
              // The range must terminate at an alphabetic character which
              // shares the same case as the start of the range.
              if (isLowerCase(startMark) && isLowerCase(finishMark) ||
                  isUpperCase(startMark) && isUpperCase(finishMark)) {
                var start = startMark.charCodeAt(0);
                var finish = finishMark.charCodeAt(0);
                if (start >= finish) {
                  showConfirm(cm, 'Invalid argument: ' + params.argString.substring(count));
                  return;
                }
  
                // Because marks are always ASCII values, and we have
                // determined that they are the same case, we can use
                // their char codes to iterate through the defined range.
                for (var j = 0; j <= finish - start; j++) {
                  var mark = String.fromCharCode(start + j);
                  delete state.marks[mark];
                }
              } else {
                showConfirm(cm, 'Invalid argument: ' + startMark + '-');
                return;
              }
            } else {
              // This symbol is a valid mark, and is not part of a range.
              delete state.marks[sym];
            }
          }
        }
      };
  
      var exCommandDispatcher = new ExCommandDispatcher();
  
      /**
      * @param {CodeMirror} cm CodeMirror instance we are in.
      * @param {boolean} confirm Whether to confirm each replace.
      * @param {Cursor} lineStart Line to start replacing from.
      * @param {Cursor} lineEnd Line to stop replacing at.
      * @param {RegExp} query Query for performing matches with.
      * @param {string} replaceWith Text to replace matches with. May contain $1,
      *     $2, etc for replacing captured groups using Javascript replace.
      * @param {function()} callback A callback for when the replace is done.
      */
      function doReplace(cm, confirm, global, lineStart, lineEnd, searchCursor, query,
          replaceWith, callback) {
        // Set up all the functions.
        cm.state.vim.exMode = true;
        var done = false;
        var lastPos = searchCursor.from();
        function replaceAll() {
          cm.operation(function() {
            while (!done) {
              replace();
              next();
            }
            stop();
          });
        }
        function replace() {
          var text = cm.getRange(searchCursor.from(), searchCursor.to());
          var newText = text.replace(query, replaceWith);
          searchCursor.replace(newText);
        }
        function next() {
          // The below only loops to skip over multiple occurrences on the same
          // line when 'global' is not true.
          while(searchCursor.findNext() &&
                isInRange(searchCursor.from(), lineStart, lineEnd)) {
            if (!global && lastPos && searchCursor.from().line == lastPos.line) {
              continue;
            }
            cm.scrollIntoView(searchCursor.from(), 30);
            cm.setSelection(searchCursor.from(), searchCursor.to());
            lastPos = searchCursor.from();
            done = false;
            return;
          }
          done = true;
        }
        function stop(close) {
          if (close) { close(); }
          cm.focus();
          if (lastPos) {
            cm.setCursor(lastPos);
            var vim = cm.state.vim;
            vim.exMode = false;
            vim.lastHPos = vim.lastHSPos = lastPos.ch;
          }
          if (callback) { callback(); }
        }
        function onPromptKeyDown(e, _value, close) {
          // Swallow all keys.
          CodeMirror.e_stop(e);
          var keyName = CodeMirror.keyName(e);
          switch (keyName) {
            case 'Y':
              replace(); next(); break;
            case 'N':
              next(); break;
            case 'A':
              // replaceAll contains a call to close of its own. We don't want it
              // to fire too early or multiple times.
              var savedCallback = callback;
              callback = undefined;
              cm.operation(replaceAll);
              callback = savedCallback;
              break;
            case 'L':
              replace();
              // fall through and exit.
            case 'Q':
            case 'Esc':
            case 'Ctrl-C':
            case 'Ctrl-[':
              stop(close);
              break;
          }
          if (done) { stop(close); }
          return true;
        }
  
        // Actually do replace.
        next();
        if (done) {
          showConfirm(cm, 'No matches for ' + query.source);
          return;
        }
        if (!confirm) {
          replaceAll();
          if (callback) { callback(); }
          return;
        }
        showPrompt(cm, {
          prefix: 'replace with <strong>' + replaceWith + '</strong> (y/n/a/q/l)',
          onKeyDown: onPromptKeyDown
        });
      }
  
      CodeMirror.keyMap.vim = {
        attach: attachVimMap,
        detach: detachVimMap,
        call: cmKey
      };
  
      function exitInsertMode(cm) {
        var vim = cm.state.vim;
        var macroModeState = vimGlobalState.macroModeState;
        var insertModeChangeRegister = vimGlobalState.registerController.getRegister('.');
        var isPlaying = macroModeState.isPlaying;
        var lastChange = macroModeState.lastInsertModeChanges;
        if (!isPlaying) {
          cm.off('change', onChange);
          CodeMirror.off(cm.getInputField(), 'keydown', onKeyEventTargetKeyDown);
        }
        if (!isPlaying && vim.insertModeRepeat > 1) {
          // Perform insert mode repeat for commands like 3,a and 3,o.
          repeatLastEdit(cm, vim, vim.insertModeRepeat - 1,
              true /** repeatForInsert */);
          vim.lastEditInputState.repeatOverride = vim.insertModeRepeat;
        }
        delete vim.insertModeRepeat;
        vim.insertMode = false;
        cm.setCursor(cm.getCursor().line, cm.getCursor().ch-1);
        cm.setOption('keyMap', 'vim');
        cm.setOption('disableInput', true);
        cm.toggleOverwrite(false); // exit replace mode if we were in it.
        // update the ". register before exiting insert mode
        insertModeChangeRegister.setText(lastChange.changes.join(''));
        CodeMirror.signal(cm, "vim-mode-change", {mode: "normal"});
        if (macroModeState.isRecording) {
          logInsertModeChange(macroModeState);
        }
      }
  
      function _mapCommand(command) {
        defaultKeymap.unshift(command);
      }
  
      function mapCommand(keys, type, name, args, extra) {
        var command = {keys: keys, type: type};
        command[type] = name;
        command[type + "Args"] = args;
        for (var key in extra)
          command[key] = extra[key];
        _mapCommand(command);
      }
  
      // The timeout in milliseconds for the two-character ESC keymap should be
      // adjusted according to your typing speed to prevent false positives.
      defineOption('insertModeEscKeysTimeout', 200, 'number');
  
      CodeMirror.keyMap['vim-insert'] = {
        // TODO: override navigation keys so that Esc will cancel automatic
        // indentation from o, O, i_<CR>
        fallthrough: ['default'],
        attach: attachVimMap,
        detach: detachVimMap,
        call: cmKey
      };
  
      CodeMirror.keyMap['vim-replace'] = {
        'Backspace': 'goCharLeft',
        fallthrough: ['vim-insert'],
        attach: attachVimMap,
        detach: detachVimMap,
        call: cmKey
      };
  
      function executeMacroRegister(cm, vim, macroModeState, registerName) {
        var register = vimGlobalState.registerController.getRegister(registerName);
        if (registerName == ':') {
          // Read-only register containing last Ex command.
          if (register.keyBuffer[0]) {
            exCommandDispatcher.processCommand(cm, register.keyBuffer[0]);
          }
          macroModeState.isPlaying = false;
          return;
        }
        var keyBuffer = register.keyBuffer;
        var imc = 0;
        macroModeState.isPlaying = true;
        macroModeState.replaySearchQueries = register.searchQueries.slice(0);
        for (var i = 0; i < keyBuffer.length; i++) {
          var text = keyBuffer[i];
          var match, key;
          while (text) {
            // Pull off one command key, which is either a single character
            // or a special sequence wrapped in '<' and '>', e.g. '<Space>'.
            match = (/<\w+-.+?>|<\w+>|./).exec(text);
            key = match[0];
            text = text.substring(match.index + key.length);
            CodeMirror.Vim.handleKey(cm, key, 'macro');
            if (vim.insertMode) {
              var changes = register.insertModeChanges[imc++].changes;
              vimGlobalState.macroModeState.lastInsertModeChanges.changes =
                  changes;
              repeatInsertModeChanges(cm, changes, 1);
              exitInsertMode(cm);
            }
          }
        }
        macroModeState.isPlaying = false;
      }
  
      function logKey(macroModeState, key) {
        if (macroModeState.isPlaying) { return; }
        var registerName = macroModeState.latestRegister;
        var register = vimGlobalState.registerController.getRegister(registerName);
        if (register) {
          register.pushText(key);
        }
      }
  
      function logInsertModeChange(macroModeState) {
        if (macroModeState.isPlaying) { return; }
        var registerName = macroModeState.latestRegister;
        var register = vimGlobalState.registerController.getRegister(registerName);
        if (register && register.pushInsertModeChanges) {
          register.pushInsertModeChanges(macroModeState.lastInsertModeChanges);
        }
      }
  
      function logSearchQuery(macroModeState, query) {
        if (macroModeState.isPlaying) { return; }
        var registerName = macroModeState.latestRegister;
        var register = vimGlobalState.registerController.getRegister(registerName);
        if (register && register.pushSearchQuery) {
          register.pushSearchQuery(query);
        }
      }
  
      /**
       * Listens for changes made in insert mode.
       * Should only be active in insert mode.
       */
      function onChange(cm, changeObj) {
        var macroModeState = vimGlobalState.macroModeState;
        var lastChange = macroModeState.lastInsertModeChanges;
        if (!macroModeState.isPlaying) {
          while(changeObj) {
            lastChange.expectCursorActivityForChange = true;
            if (lastChange.ignoreCount > 1) {
              lastChange.ignoreCount--;
            } else if (changeObj.origin == '+input' || changeObj.origin == 'paste'
                || changeObj.origin === undefined /* only in testing */) {
              var selectionCount = cm.listSelections().length;
              if (selectionCount > 1)
                lastChange.ignoreCount = selectionCount;
              var text = changeObj.text.join('\n');
              if (lastChange.maybeReset) {
                lastChange.changes = [];
                lastChange.maybeReset = false;
              }
              if (text) {
                if (cm.state.overwrite && !/\n/.test(text)) {
                  lastChange.changes.push([text]);
                } else {
                  lastChange.changes.push(text);
                }
              }
            }
            // Change objects may be chained with next.
            changeObj = changeObj.next;
          }
        }
      }
  
      /**
      * Listens for any kind of cursor activity on CodeMirror.
      */
      function onCursorActivity(cm) {
        var vim = cm.state.vim;
        if (vim.insertMode) {
          // Tracking cursor activity in insert mode (for macro support).
          var macroModeState = vimGlobalState.macroModeState;
          if (macroModeState.isPlaying) { return; }
          var lastChange = macroModeState.lastInsertModeChanges;
          if (lastChange.expectCursorActivityForChange) {
            lastChange.expectCursorActivityForChange = false;
          } else {
            // Cursor moved outside the context of an edit. Reset the change.
            lastChange.maybeReset = true;
          }
        } else if (!cm.curOp.isVimOp) {
          handleExternalSelection(cm, vim);
        }
        if (vim.visualMode) {
          updateFakeCursor(cm);
        }
      }
      /**
       * Keeps track of a fake cursor to support visual mode cursor behavior.
       */
      function updateFakeCursor(cm) {
        var className = 'cm-animate-fat-cursor';
        var vim = cm.state.vim;
        var from = clipCursorToContent(cm, copyCursor(vim.sel.head));
        var to = offsetCursor(from, 0, 1);
        clearFakeCursor(vim);
        // In visual mode, the cursor may be positioned over EOL.
        if (from.ch == cm.getLine(from.line).length) {
          var widget = document.createElement("span");
          widget.textContent = "\u00a0";
          widget.className = className;
          vim.fakeCursorBookmark = cm.setBookmark(from, {widget: widget});
        } else {
          vim.fakeCursor = cm.markText(from, to, {className: className});
        }
      }
      function clearFakeCursor(vim) {
        if (vim.fakeCursor) {
          vim.fakeCursor.clear();
          vim.fakeCursor = null;
        }
        if (vim.fakeCursorBookmark) {
          vim.fakeCursorBookmark.clear();
          vim.fakeCursorBookmark = null;
        }
      }
      function handleExternalSelection(cm, vim) {
        var anchor = cm.getCursor('anchor');
        var head = cm.getCursor('head');
        // Enter or exit visual mode to match mouse selection.
        if (vim.visualMode && !cm.somethingSelected()) {
          exitVisualMode(cm, false);
        } else if (!vim.visualMode && !vim.insertMode && cm.somethingSelected()) {
          vim.visualMode = true;
          vim.visualLine = false;
          CodeMirror.signal(cm, "vim-mode-change", {mode: "visual"});
        }
        if (vim.visualMode) {
          // Bind CodeMirror selection model to vim selection model.
          // Mouse selections are considered visual characterwise.
          var headOffset = !cursorIsBefore(head, anchor) ? -1 : 0;
          var anchorOffset = cursorIsBefore(head, anchor) ? -1 : 0;
          head = offsetCursor(head, 0, headOffset);
          anchor = offsetCursor(anchor, 0, anchorOffset);
          vim.sel = {
            anchor: anchor,
            head: head
          };
          updateMark(cm, vim, '<', cursorMin(head, anchor));
          updateMark(cm, vim, '>', cursorMax(head, anchor));
        } else if (!vim.insertMode) {
          // Reset lastHPos if selection was modified by something outside of vim mode e.g. by mouse.
          vim.lastHPos = cm.getCursor().ch;
        }
      }
  
      /** Wrapper for special keys pressed in insert mode */
      function InsertModeKey(keyName) {
        this.keyName = keyName;
      }
  
      /**
      * Handles raw key down events from the text area.
      * - Should only be active in insert mode.
      * - For recording deletes in insert mode.
      */
      function onKeyEventTargetKeyDown(e) {
        var macroModeState = vimGlobalState.macroModeState;
        var lastChange = macroModeState.lastInsertModeChanges;
        var keyName = CodeMirror.keyName(e);
        if (!keyName) { return; }
        function onKeyFound() {
          if (lastChange.maybeReset) {
            lastChange.changes = [];
            lastChange.maybeReset = false;
          }
          lastChange.changes.push(new InsertModeKey(keyName));
          return true;
        }
        if (keyName.indexOf('Delete') != -1 || keyName.indexOf('Backspace') != -1) {
          CodeMirror.lookupKey(keyName, 'vim-insert', onKeyFound);
        }
      }
  
      /**
       * Repeats the last edit, which includes exactly 1 command and at most 1
       * insert. Operator and motion commands are read from lastEditInputState,
       * while action commands are read from lastEditActionCommand.
       *
       * If repeatForInsert is true, then the function was called by
       * exitInsertMode to repeat the insert mode changes the user just made. The
       * corresponding enterInsertMode call was made with a count.
       */
      function repeatLastEdit(cm, vim, repeat, repeatForInsert) {
        var macroModeState = vimGlobalState.macroModeState;
        macroModeState.isPlaying = true;
        var isAction = !!vim.lastEditActionCommand;
        var cachedInputState = vim.inputState;
        function repeatCommand() {
          if (isAction) {
            commandDispatcher.processAction(cm, vim, vim.lastEditActionCommand);
          } else {
            commandDispatcher.evalInput(cm, vim);
          }
        }
        function repeatInsert(repeat) {
          if (macroModeState.lastInsertModeChanges.changes.length > 0) {
            // For some reason, repeat cw in desktop VIM does not repeat
            // insert mode changes. Will conform to that behavior.
            repeat = !vim.lastEditActionCommand ? 1 : repeat;
            var changeObject = macroModeState.lastInsertModeChanges;
            repeatInsertModeChanges(cm, changeObject.changes, repeat);
          }
        }
        vim.inputState = vim.lastEditInputState;
        if (isAction && vim.lastEditActionCommand.interlaceInsertRepeat) {
          // o and O repeat have to be interlaced with insert repeats so that the
          // insertions appear on separate lines instead of the last line.
          for (var i = 0; i < repeat; i++) {
            repeatCommand();
            repeatInsert(1);
          }
        } else {
          if (!repeatForInsert) {
            // Hack to get the cursor to end up at the right place. If I is
            // repeated in insert mode repeat, cursor will be 1 insert
            // change set left of where it should be.
            repeatCommand();
          }
          repeatInsert(repeat);
        }
        vim.inputState = cachedInputState;
        if (vim.insertMode && !repeatForInsert) {
          // Don't exit insert mode twice. If repeatForInsert is set, then we
          // were called by an exitInsertMode call lower on the stack.
          exitInsertMode(cm);
        }
        macroModeState.isPlaying = false;
      }
  
      function repeatInsertModeChanges(cm, changes, repeat) {
        function keyHandler(binding) {
          if (typeof binding == 'string') {
            CodeMirror.commands[binding](cm);
          } else {
            binding(cm);
          }
          return true;
        }
        var head = cm.getCursor('head');
        var visualBlock = vimGlobalState.macroModeState.lastInsertModeChanges.visualBlock;
        if (visualBlock) {
          // Set up block selection again for repeating the changes.
          selectForInsert(cm, head, visualBlock + 1);
          repeat = cm.listSelections().length;
          cm.setCursor(head);
        }
        for (var i = 0; i < repeat; i++) {
          if (visualBlock) {
            cm.setCursor(offsetCursor(head, i, 0));
          }
          for (var j = 0; j < changes.length; j++) {
            var change = changes[j];
            if (change instanceof InsertModeKey) {
              CodeMirror.lookupKey(change.keyName, 'vim-insert', keyHandler);
            } else if (typeof change == "string") {
              var cur = cm.getCursor();
              cm.replaceRange(change, cur, cur);
            } else {
              var start = cm.getCursor();
              var end = offsetCursor(start, 0, change[0].length);
              cm.replaceRange(change[0], start, end);
            }
          }
        }
        if (visualBlock) {
          cm.setCursor(offsetCursor(head, 0, 1));
        }
      }
  
      resetVimGlobalState();
      return vimApi;
    };
    // Initialize Vim and make it available as an API.
    CodeMirror.Vim = Vim();
  });
  // CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/LICENSE

// A rough approximation of Sublime Text's keybindings
// Depends on addon/search/searchcursor.js and optionally addon/dialog/dialogs.js

(function(mod) {
    if (typeof exports == "object" && typeof module == "object") // CommonJS
      mod(require("../lib/codemirror"), require("../addon/search/searchcursor"), require("../addon/edit/matchbrackets"));
    else if (typeof define == "function" && define.amd) // AMD
      define(["../lib/codemirror", "../addon/search/searchcursor", "../addon/edit/matchbrackets"], mod);
    else // Plain browser env
      mod(CodeMirror);
  })(function(CodeMirror) {
    "use strict";
  
    var cmds = CodeMirror.commands;
    var Pos = CodeMirror.Pos;
  
    // This is not exactly Sublime's algorithm. I couldn't make heads or tails of that.
    function findPosSubword(doc, start, dir) {
      if (dir < 0 && start.ch == 0) return doc.clipPos(Pos(start.line - 1));
      var line = doc.getLine(start.line);
      if (dir > 0 && start.ch >= line.length) return doc.clipPos(Pos(start.line + 1, 0));
      var state = "start", type, startPos = start.ch;
      for (var pos = startPos, e = dir < 0 ? 0 : line.length, i = 0; pos != e; pos += dir, i++) {
        var next = line.charAt(dir < 0 ? pos - 1 : pos);
        var cat = next != "_" && CodeMirror.isWordChar(next) ? "w" : "o";
        if (cat == "w" && next.toUpperCase() == next) cat = "W";
        if (state == "start") {
          if (cat != "o") { state = "in"; type = cat; }
          else startPos = pos + dir
        } else if (state == "in") {
          if (type != cat) {
            if (type == "w" && cat == "W" && dir < 0) pos--;
            if (type == "W" && cat == "w" && dir > 0) { // From uppercase to lowercase
              if (pos == startPos + 1) { type = "w"; continue; }
              else pos--;
            }
            break;
          }
        }
      }
      return Pos(start.line, pos);
    }
  
    function moveSubword(cm, dir) {
      cm.extendSelectionsBy(function(range) {
        if (cm.display.shift || cm.doc.extend || range.empty())
          return findPosSubword(cm.doc, range.head, dir);
        else
          return dir < 0 ? range.from() : range.to();
      });
    }
  
    cmds.goSubwordLeft = function(cm) { moveSubword(cm, -1); };
    cmds.goSubwordRight = function(cm) { moveSubword(cm, 1); };
  
    cmds.scrollLineUp = function(cm) {
      var info = cm.getScrollInfo();
      if (!cm.somethingSelected()) {
        var visibleBottomLine = cm.lineAtHeight(info.top + info.clientHeight, "local");
        if (cm.getCursor().line >= visibleBottomLine)
          cm.execCommand("goLineUp");
      }
      cm.scrollTo(null, info.top - cm.defaultTextHeight());
    };
    cmds.scrollLineDown = function(cm) {
      var info = cm.getScrollInfo();
      if (!cm.somethingSelected()) {
        var visibleTopLine = cm.lineAtHeight(info.top, "local")+1;
        if (cm.getCursor().line <= visibleTopLine)
          cm.execCommand("goLineDown");
      }
      cm.scrollTo(null, info.top + cm.defaultTextHeight());
    };
  
    cmds.splitSelectionByLine = function(cm) {
      var ranges = cm.listSelections(), lineRanges = [];
      for (var i = 0; i < ranges.length; i++) {
        var from = ranges[i].from(), to = ranges[i].to();
        for (var line = from.line; line <= to.line; ++line)
          if (!(to.line > from.line && line == to.line && to.ch == 0))
            lineRanges.push({anchor: line == from.line ? from : Pos(line, 0),
                             head: line == to.line ? to : Pos(line)});
      }
      cm.setSelections(lineRanges, 0);
    };
  
    cmds.singleSelectionTop = function(cm) {
      var range = cm.listSelections()[0];
      cm.setSelection(range.anchor, range.head, {scroll: false});
    };
  
    cmds.selectLine = function(cm) {
      var ranges = cm.listSelections(), extended = [];
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        extended.push({anchor: Pos(range.from().line, 0),
                       head: Pos(range.to().line + 1, 0)});
      }
      cm.setSelections(extended);
    };
  
    function insertLine(cm, above) {
      if (cm.isReadOnly()) return CodeMirror.Pass
      cm.operation(function() {
        var len = cm.listSelections().length, newSelection = [], last = -1;
        for (var i = 0; i < len; i++) {
          var head = cm.listSelections()[i].head;
          if (head.line <= last) continue;
          var at = Pos(head.line + (above ? 0 : 1), 0);
          cm.replaceRange("\n", at, null, "+insertLine");
          cm.indentLine(at.line, null, true);
          newSelection.push({head: at, anchor: at});
          last = head.line + 1;
        }
        cm.setSelections(newSelection);
      });
      cm.execCommand("indentAuto");
    }
  
    cmds.insertLineAfter = function(cm) { return insertLine(cm, false); };
  
    cmds.insertLineBefore = function(cm) { return insertLine(cm, true); };
  
    function wordAt(cm, pos) {
      var start = pos.ch, end = start, line = cm.getLine(pos.line);
      while (start && CodeMirror.isWordChar(line.charAt(start - 1))) --start;
      while (end < line.length && CodeMirror.isWordChar(line.charAt(end))) ++end;
      return {from: Pos(pos.line, start), to: Pos(pos.line, end), word: line.slice(start, end)};
    }
  
    cmds.selectNextOccurrence = function(cm) {
      var from = cm.getCursor("from"), to = cm.getCursor("to");
      var fullWord = cm.state.sublimeFindFullWord == cm.doc.sel;
      if (CodeMirror.cmpPos(from, to) == 0) {
        var word = wordAt(cm, from);
        if (!word.word) return;
        cm.setSelection(word.from, word.to);
        fullWord = true;
      } else {
        var text = cm.getRange(from, to);
        var query = fullWord ? new RegExp("\\b" + text + "\\b") : text;
        var cur = cm.getSearchCursor(query, to);
        var found = cur.findNext();
        if (!found) {
          cur = cm.getSearchCursor(query, Pos(cm.firstLine(), 0));
          found = cur.findNext();
        }
        if (!found || isSelectedRange(cm.listSelections(), cur.from(), cur.to())) return
        cm.addSelection(cur.from(), cur.to());
      }
      if (fullWord)
        cm.state.sublimeFindFullWord = cm.doc.sel;
    };
  
    cmds.skipAndSelectNextOccurrence = function(cm) {
      var prevAnchor = cm.getCursor("anchor"), prevHead = cm.getCursor("head");
      cmds.selectNextOccurrence(cm);
      if (CodeMirror.cmpPos(prevAnchor, prevHead) != 0) {
        cm.doc.setSelections(cm.doc.listSelections()
            .filter(function (sel) {
              return sel.anchor != prevAnchor || sel.head != prevHead;
            }));
      }
    }
  
    function addCursorToSelection(cm, dir) {
      var ranges = cm.listSelections(), newRanges = [];
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var newAnchor = cm.findPosV(
            range.anchor, dir, "line", range.anchor.goalColumn);
        var newHead = cm.findPosV(
            range.head, dir, "line", range.head.goalColumn);
        newAnchor.goalColumn = range.anchor.goalColumn != null ?
            range.anchor.goalColumn : cm.cursorCoords(range.anchor, "div").left;
        newHead.goalColumn = range.head.goalColumn != null ?
            range.head.goalColumn : cm.cursorCoords(range.head, "div").left;
        var newRange = {anchor: newAnchor, head: newHead};
        newRanges.push(range);
        newRanges.push(newRange);
      }
      cm.setSelections(newRanges);
    }
    cmds.addCursorToPrevLine = function(cm) { addCursorToSelection(cm, -1); };
    cmds.addCursorToNextLine = function(cm) { addCursorToSelection(cm, 1); };
  
    function isSelectedRange(ranges, from, to) {
      for (var i = 0; i < ranges.length; i++)
        if (CodeMirror.cmpPos(ranges[i].from(), from) == 0 &&
            CodeMirror.cmpPos(ranges[i].to(), to) == 0) return true
      return false
    }
  
    var mirror = "(){}[]";
    function selectBetweenBrackets(cm) {
      var ranges = cm.listSelections(), newRanges = []
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i], pos = range.head, opening = cm.scanForBracket(pos, -1);
        if (!opening) return false;
        for (;;) {
          var closing = cm.scanForBracket(pos, 1);
          if (!closing) return false;
          if (closing.ch == mirror.charAt(mirror.indexOf(opening.ch) + 1)) {
            var startPos = Pos(opening.pos.line, opening.pos.ch + 1);
            if (CodeMirror.cmpPos(startPos, range.from()) == 0 &&
                CodeMirror.cmpPos(closing.pos, range.to()) == 0) {
              opening = cm.scanForBracket(opening.pos, -1);
              if (!opening) return false;
            } else {
              newRanges.push({anchor: startPos, head: closing.pos});
              break;
            }
          }
          pos = Pos(closing.pos.line, closing.pos.ch + 1);
        }
      }
      cm.setSelections(newRanges);
      return true;
    }
  
    cmds.selectScope = function(cm) {
      selectBetweenBrackets(cm) || cm.execCommand("selectAll");
    };
    cmds.selectBetweenBrackets = function(cm) {
      if (!selectBetweenBrackets(cm)) return CodeMirror.Pass;
    };
  
    function puncType(type) {
      return !type ? null : /\bpunctuation\b/.test(type) ? type : undefined
    }
  
    cmds.goToBracket = function(cm) {
      cm.extendSelectionsBy(function(range) {
        var next = cm.scanForBracket(range.head, 1, puncType(cm.getTokenTypeAt(range.head)));
        if (next && CodeMirror.cmpPos(next.pos, range.head) != 0) return next.pos;
        var prev = cm.scanForBracket(range.head, -1, puncType(cm.getTokenTypeAt(Pos(range.head.line, range.head.ch + 1))));
        return prev && Pos(prev.pos.line, prev.pos.ch + 1) || range.head;
      });
    };
  
    cmds.swapLineUp = function(cm) {
      if (cm.isReadOnly()) return CodeMirror.Pass
      var ranges = cm.listSelections(), linesToMove = [], at = cm.firstLine() - 1, newSels = [];
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i], from = range.from().line - 1, to = range.to().line;
        newSels.push({anchor: Pos(range.anchor.line - 1, range.anchor.ch),
                      head: Pos(range.head.line - 1, range.head.ch)});
        if (range.to().ch == 0 && !range.empty()) --to;
        if (from > at) linesToMove.push(from, to);
        else if (linesToMove.length) linesToMove[linesToMove.length - 1] = to;
        at = to;
      }
      cm.operation(function() {
        for (var i = 0; i < linesToMove.length; i += 2) {
          var from = linesToMove[i], to = linesToMove[i + 1];
          var line = cm.getLine(from);
          cm.replaceRange("", Pos(from, 0), Pos(from + 1, 0), "+swapLine");
          if (to > cm.lastLine())
            cm.replaceRange("\n" + line, Pos(cm.lastLine()), null, "+swapLine");
          else
            cm.replaceRange(line + "\n", Pos(to, 0), null, "+swapLine");
        }
        cm.setSelections(newSels);
        cm.scrollIntoView();
      });
    };
  
    cmds.swapLineDown = function(cm) {
      if (cm.isReadOnly()) return CodeMirror.Pass
      var ranges = cm.listSelections(), linesToMove = [], at = cm.lastLine() + 1;
      for (var i = ranges.length - 1; i >= 0; i--) {
        var range = ranges[i], from = range.to().line + 1, to = range.from().line;
        if (range.to().ch == 0 && !range.empty()) from--;
        if (from < at) linesToMove.push(from, to);
        else if (linesToMove.length) linesToMove[linesToMove.length - 1] = to;
        at = to;
      }
      cm.operation(function() {
        for (var i = linesToMove.length - 2; i >= 0; i -= 2) {
          var from = linesToMove[i], to = linesToMove[i + 1];
          var line = cm.getLine(from);
          if (from == cm.lastLine())
            cm.replaceRange("", Pos(from - 1), Pos(from), "+swapLine");
          else
            cm.replaceRange("", Pos(from, 0), Pos(from + 1, 0), "+swapLine");
          cm.replaceRange(line + "\n", Pos(to, 0), null, "+swapLine");
        }
        cm.scrollIntoView();
      });
    };
  
    cmds.toggleCommentIndented = function(cm) {
      cm.toggleComment({ indent: true });
    }
  
    cmds.joinLines = function(cm) {
      var ranges = cm.listSelections(), joined = [];
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i], from = range.from();
        var start = from.line, end = range.to().line;
        while (i < ranges.length - 1 && ranges[i + 1].from().line == end)
          end = ranges[++i].to().line;
        joined.push({start: start, end: end, anchor: !range.empty() && from});
      }
      cm.operation(function() {
        var offset = 0, ranges = [];
        for (var i = 0; i < joined.length; i++) {
          var obj = joined[i];
          var anchor = obj.anchor && Pos(obj.anchor.line - offset, obj.anchor.ch), head;
          for (var line = obj.start; line <= obj.end; line++) {
            var actual = line - offset;
            if (line == obj.end) head = Pos(actual, cm.getLine(actual).length + 1);
            if (actual < cm.lastLine()) {
              cm.replaceRange(" ", Pos(actual), Pos(actual + 1, /^\s*/.exec(cm.getLine(actual + 1))[0].length));
              ++offset;
            }
          }
          ranges.push({anchor: anchor || head, head: head});
        }
        cm.setSelections(ranges, 0);
      });
    };
  
    cmds.duplicateLine = function(cm) {
      cm.operation(function() {
        var rangeCount = cm.listSelections().length;
        for (var i = 0; i < rangeCount; i++) {
          var range = cm.listSelections()[i];
          if (range.empty())
            cm.replaceRange(cm.getLine(range.head.line) + "\n", Pos(range.head.line, 0));
          else
            cm.replaceRange(cm.getRange(range.from(), range.to()), range.from());
        }
        cm.scrollIntoView();
      });
    };
  
  
    function sortLines(cm, caseSensitive) {
      if (cm.isReadOnly()) return CodeMirror.Pass
      var ranges = cm.listSelections(), toSort = [], selected;
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (range.empty()) continue;
        var from = range.from().line, to = range.to().line;
        while (i < ranges.length - 1 && ranges[i + 1].from().line == to)
          to = ranges[++i].to().line;
        if (!ranges[i].to().ch) to--;
        toSort.push(from, to);
      }
      if (toSort.length) selected = true;
      else toSort.push(cm.firstLine(), cm.lastLine());
  
      cm.operation(function() {
        var ranges = [];
        for (var i = 0; i < toSort.length; i += 2) {
          var from = toSort[i], to = toSort[i + 1];
          var start = Pos(from, 0), end = Pos(to);
          var lines = cm.getRange(start, end, false);
          if (caseSensitive)
            lines.sort();
          else
            lines.sort(function(a, b) {
              var au = a.toUpperCase(), bu = b.toUpperCase();
              if (au != bu) { a = au; b = bu; }
              return a < b ? -1 : a == b ? 0 : 1;
            });
          cm.replaceRange(lines, start, end);
          if (selected) ranges.push({anchor: start, head: Pos(to + 1, 0)});
        }
        if (selected) cm.setSelections(ranges, 0);
      });
    }
  
    cmds.sortLines = function(cm) { sortLines(cm, true); };
    cmds.sortLinesInsensitive = function(cm) { sortLines(cm, false); };
  
    cmds.nextBookmark = function(cm) {
      var marks = cm.state.sublimeBookmarks;
      if (marks) while (marks.length) {
        var current = marks.shift();
        var found = current.find();
        if (found) {
          marks.push(current);
          return cm.setSelection(found.from, found.to);
        }
      }
    };
  
    cmds.prevBookmark = function(cm) {
      var marks = cm.state.sublimeBookmarks;
      if (marks) while (marks.length) {
        marks.unshift(marks.pop());
        var found = marks[marks.length - 1].find();
        if (!found)
          marks.pop();
        else
          return cm.setSelection(found.from, found.to);
      }
    };
  
    cmds.toggleBookmark = function(cm) {
      var ranges = cm.listSelections();
      var marks = cm.state.sublimeBookmarks || (cm.state.sublimeBookmarks = []);
      for (var i = 0; i < ranges.length; i++) {
        var from = ranges[i].from(), to = ranges[i].to();
        var found = ranges[i].empty() ? cm.findMarksAt(from) : cm.findMarks(from, to);
        for (var j = 0; j < found.length; j++) {
          if (found[j].sublimeBookmark) {
            found[j].clear();
            for (var k = 0; k < marks.length; k++)
              if (marks[k] == found[j])
                marks.splice(k--, 1);
            break;
          }
        }
        if (j == found.length)
          marks.push(cm.markText(from, to, {sublimeBookmark: true, clearWhenEmpty: false}));
      }
    };
  
    cmds.clearBookmarks = function(cm) {
      var marks = cm.state.sublimeBookmarks;
      if (marks) for (var i = 0; i < marks.length; i++) marks[i].clear();
      marks.length = 0;
    };
  
    cmds.selectBookmarks = function(cm) {
      var marks = cm.state.sublimeBookmarks, ranges = [];
      if (marks) for (var i = 0; i < marks.length; i++) {
        var found = marks[i].find();
        if (!found)
          marks.splice(i--, 0);
        else
          ranges.push({anchor: found.from, head: found.to});
      }
      if (ranges.length)
        cm.setSelections(ranges, 0);
    };
  
    function modifyWordOrSelection(cm, mod) {
      cm.operation(function() {
        var ranges = cm.listSelections(), indices = [], replacements = [];
        for (var i = 0; i < ranges.length; i++) {
          var range = ranges[i];
          if (range.empty()) { indices.push(i); replacements.push(""); }
          else replacements.push(mod(cm.getRange(range.from(), range.to())));
        }
        cm.replaceSelections(replacements, "around", "case");
        for (var i = indices.length - 1, at; i >= 0; i--) {
          var range = ranges[indices[i]];
          if (at && CodeMirror.cmpPos(range.head, at) > 0) continue;
          var word = wordAt(cm, range.head);
          at = word.from;
          cm.replaceRange(mod(word.word), word.from, word.to);
        }
      });
    }
  
    cmds.smartBackspace = function(cm) {
      if (cm.somethingSelected()) return CodeMirror.Pass;
  
      cm.operation(function() {
        var cursors = cm.listSelections();
        var indentUnit = cm.getOption("indentUnit");
  
        for (var i = cursors.length - 1; i >= 0; i--) {
          var cursor = cursors[i].head;
          var toStartOfLine = cm.getRange({line: cursor.line, ch: 0}, cursor);
          var column = CodeMirror.countColumn(toStartOfLine, null, cm.getOption("tabSize"));
  
          // Delete by one character by default
          var deletePos = cm.findPosH(cursor, -1, "char", false);
  
          if (toStartOfLine && !/\S/.test(toStartOfLine) && column % indentUnit == 0) {
            var prevIndent = new Pos(cursor.line,
              CodeMirror.findColumn(toStartOfLine, column - indentUnit, indentUnit));
  
            // Smart delete only if we found a valid prevIndent location
            if (prevIndent.ch != cursor.ch) deletePos = prevIndent;
          }
  
          cm.replaceRange("", deletePos, cursor, "+delete");
        }
      });
    };
  
    cmds.delLineRight = function(cm) {
      cm.operation(function() {
        var ranges = cm.listSelections();
        for (var i = ranges.length - 1; i >= 0; i--)
          cm.replaceRange("", ranges[i].anchor, Pos(ranges[i].to().line), "+delete");
        cm.scrollIntoView();
      });
    };
  
    cmds.upcaseAtCursor = function(cm) {
      modifyWordOrSelection(cm, function(str) { return str.toUpperCase(); });
    };
    cmds.downcaseAtCursor = function(cm) {
      modifyWordOrSelection(cm, function(str) { return str.toLowerCase(); });
    };
  
    cmds.setSublimeMark = function(cm) {
      if (cm.state.sublimeMark) cm.state.sublimeMark.clear();
      cm.state.sublimeMark = cm.setBookmark(cm.getCursor());
    };
    cmds.selectToSublimeMark = function(cm) {
      var found = cm.state.sublimeMark && cm.state.sublimeMark.find();
      if (found) cm.setSelection(cm.getCursor(), found);
    };
    cmds.deleteToSublimeMark = function(cm) {
      var found = cm.state.sublimeMark && cm.state.sublimeMark.find();
      if (found) {
        var from = cm.getCursor(), to = found;
        if (CodeMirror.cmpPos(from, to) > 0) { var tmp = to; to = from; from = tmp; }
        cm.state.sublimeKilled = cm.getRange(from, to);
        cm.replaceRange("", from, to);
      }
    };
    cmds.swapWithSublimeMark = function(cm) {
      var found = cm.state.sublimeMark && cm.state.sublimeMark.find();
      if (found) {
        cm.state.sublimeMark.clear();
        cm.state.sublimeMark = cm.setBookmark(cm.getCursor());
        cm.setCursor(found);
      }
    };
    cmds.sublimeYank = function(cm) {
      if (cm.state.sublimeKilled != null)
        cm.replaceSelection(cm.state.sublimeKilled, null, "paste");
    };
  
    cmds.showInCenter = function(cm) {
      var pos = cm.cursorCoords(null, "local");
      cm.scrollTo(null, (pos.top + pos.bottom) / 2 - cm.getScrollInfo().clientHeight / 2);
    };
  
    function getTarget(cm) {
      var from = cm.getCursor("from"), to = cm.getCursor("to");
      if (CodeMirror.cmpPos(from, to) == 0) {
        var word = wordAt(cm, from);
        if (!word.word) return;
        from = word.from;
        to = word.to;
      }
      return {from: from, to: to, query: cm.getRange(from, to), word: word};
    }
  
    function findAndGoTo(cm, forward) {
      var target = getTarget(cm);
      if (!target) return;
      var query = target.query;
      var cur = cm.getSearchCursor(query, forward ? target.to : target.from);
  
      if (forward ? cur.findNext() : cur.findPrevious()) {
        cm.setSelection(cur.from(), cur.to());
      } else {
        cur = cm.getSearchCursor(query, forward ? Pos(cm.firstLine(), 0)
                                                : cm.clipPos(Pos(cm.lastLine())));
        if (forward ? cur.findNext() : cur.findPrevious())
          cm.setSelection(cur.from(), cur.to());
        else if (target.word)
          cm.setSelection(target.from, target.to);
      }
    };
    cmds.findUnder = function(cm) { findAndGoTo(cm, true); };
    cmds.findUnderPrevious = function(cm) { findAndGoTo(cm,false); };
    cmds.findAllUnder = function(cm) {
      var target = getTarget(cm);
      if (!target) return;
      var cur = cm.getSearchCursor(target.query);
      var matches = [];
      var primaryIndex = -1;
      while (cur.findNext()) {
        matches.push({anchor: cur.from(), head: cur.to()});
        if (cur.from().line <= target.from.line && cur.from().ch <= target.from.ch)
          primaryIndex++;
      }
      cm.setSelections(matches, primaryIndex);
    };
  
  
    var keyMap = CodeMirror.keyMap;
    keyMap.macSublime = {
      "Cmd-Left": "goLineStartSmart",
      "Shift-Tab": "indentLess",
      "Shift-Ctrl-K": "deleteLine",
      "Alt-Q": "wrapLines",
      "Ctrl-Left": "goSubwordLeft",
      "Ctrl-Right": "goSubwordRight",
      "Ctrl-Alt-Up": "scrollLineUp",
      "Ctrl-Alt-Down": "scrollLineDown",
      "Cmd-L": "selectLine",
      "Shift-Cmd-L": "splitSelectionByLine",
      "Esc": "singleSelectionTop",
      "Cmd-Enter": "insertLineAfter",
      "Shift-Cmd-Enter": "insertLineBefore",
      "Cmd-D": "selectNextOccurrence",
      "Shift-Cmd-Space": "selectScope",
      "Shift-Cmd-M": "selectBetweenBrackets",
      "Cmd-M": "goToBracket",
      "Cmd-Ctrl-Up": "swapLineUp",
      "Cmd-Ctrl-Down": "swapLineDown",
      "Cmd-/": "toggleCommentIndented",
      "Cmd-J": "joinLines",
      "Shift-Cmd-D": "duplicateLine",
      "F5": "sortLines",
      "Cmd-F5": "sortLinesInsensitive",
      "F2": "nextBookmark",
      "Shift-F2": "prevBookmark",
      "Cmd-F2": "toggleBookmark",
      "Shift-Cmd-F2": "clearBookmarks",
      "Alt-F2": "selectBookmarks",
      "Backspace": "smartBackspace",
      "Cmd-K Cmd-D": "skipAndSelectNextOccurrence",
      "Cmd-K Cmd-K": "delLineRight",
      "Cmd-K Cmd-U": "upcaseAtCursor",
      "Cmd-K Cmd-L": "downcaseAtCursor",
      "Cmd-K Cmd-Space": "setSublimeMark",
      "Cmd-K Cmd-A": "selectToSublimeMark",
      "Cmd-K Cmd-W": "deleteToSublimeMark",
      "Cmd-K Cmd-X": "swapWithSublimeMark",
      "Cmd-K Cmd-Y": "sublimeYank",
      "Cmd-K Cmd-C": "showInCenter",
      "Cmd-K Cmd-G": "clearBookmarks",
      "Cmd-K Cmd-Backspace": "delLineLeft",
      "Cmd-K Cmd-1": "foldAll",
      "Cmd-K Cmd-0": "unfoldAll",
      "Cmd-K Cmd-J": "unfoldAll",
      "Ctrl-Shift-Up": "addCursorToPrevLine",
      "Ctrl-Shift-Down": "addCursorToNextLine",
      "Cmd-F3": "findUnder",
      "Shift-Cmd-F3": "findUnderPrevious",
      "Alt-F3": "findAllUnder",
      "Shift-Cmd-[": "fold",
      "Shift-Cmd-]": "unfold",
      "Cmd-I": "findIncremental",
      "Shift-Cmd-I": "findIncrementalReverse",
      "Cmd-H": "replace",
      "F3": "findNext",
      "Shift-F3": "findPrev",
      "fallthrough": "macDefault"
    };
    CodeMirror.normalizeKeyMap(keyMap.macSublime);
  
    keyMap.pcSublime = {
      "Shift-Tab": "indentLess",
      "Shift-Ctrl-K": "deleteLine",
      "Alt-Q": "wrapLines",
      "Ctrl-T": "transposeChars",
      "Alt-Left": "goSubwordLeft",
      "Alt-Right": "goSubwordRight",
      "Ctrl-Up": "scrollLineUp",
      "Ctrl-Down": "scrollLineDown",
      "Ctrl-L": "selectLine",
      "Shift-Ctrl-L": "splitSelectionByLine",
      "Esc": "singleSelectionTop",
      "Ctrl-Enter": "insertLineAfter",
      "Shift-Ctrl-Enter": "insertLineBefore",
      "Ctrl-D": "selectNextOccurrence",
      "Shift-Ctrl-Space": "selectScope",
      "Shift-Ctrl-M": "selectBetweenBrackets",
      "Ctrl-M": "goToBracket",
      "Shift-Ctrl-Up": "swapLineUp",
      "Shift-Ctrl-Down": "swapLineDown",
      "Ctrl-/": "toggleCommentIndented",
      "Ctrl-J": "joinLines",
      "Shift-Ctrl-D": "duplicateLine",
      "F9": "sortLines",
      "Ctrl-F9": "sortLinesInsensitive",
      "F2": "nextBookmark",
      "Shift-F2": "prevBookmark",
      "Ctrl-F2": "toggleBookmark",
      "Shift-Ctrl-F2": "clearBookmarks",
      "Alt-F2": "selectBookmarks",
      "Backspace": "smartBackspace",
      "Ctrl-K Ctrl-D": "skipAndSelectNextOccurrence",
      "Ctrl-K Ctrl-K": "delLineRight",
      "Ctrl-K Ctrl-U": "upcaseAtCursor",
      "Ctrl-K Ctrl-L": "downcaseAtCursor",
      "Ctrl-K Ctrl-Space": "setSublimeMark",
      "Ctrl-K Ctrl-A": "selectToSublimeMark",
      "Ctrl-K Ctrl-W": "deleteToSublimeMark",
      "Ctrl-K Ctrl-X": "swapWithSublimeMark",
      "Ctrl-K Ctrl-Y": "sublimeYank",
      "Ctrl-K Ctrl-C": "showInCenter",
      "Ctrl-K Ctrl-G": "clearBookmarks",
      "Ctrl-K Ctrl-Backspace": "delLineLeft",
      "Ctrl-K Ctrl-1": "foldAll",
      "Ctrl-K Ctrl-0": "unfoldAll",
      "Ctrl-K Ctrl-J": "unfoldAll",
      "Ctrl-Alt-Up": "addCursorToPrevLine",
      "Ctrl-Alt-Down": "addCursorToNextLine",
      "Ctrl-F3": "findUnder",
      "Shift-Ctrl-F3": "findUnderPrevious",
      "Alt-F3": "findAllUnder",
      "Shift-Ctrl-[": "fold",
      "Shift-Ctrl-]": "unfold",
      "Ctrl-I": "findIncremental",
      "Shift-Ctrl-I": "findIncrementalReverse",
      "Ctrl-H": "replace",
      "F3": "findNext",
      "Shift-F3": "findPrev",
      "fallthrough": "pcDefault"
    };
    CodeMirror.normalizeKeyMap(keyMap.pcSublime);
  
    var mac = keyMap.default == keyMap.macDefault;
    keyMap.sublime = mac ? keyMap.macSublime : keyMap.pcSublime;
  });
  "use strict";function q(a){throw a;}var t=void 0,u=!1;var sjcl={cipher:{},hash:{},keyexchange:{},mode:{},misc:{},codec:{},exception:{corrupt:function(a){this.toString=function(){return"CORRUPT: "+this.message};this.message=a},invalid:function(a){this.toString=function(){return"INVALID: "+this.message};this.message=a},bug:function(a){this.toString=function(){return"BUG: "+this.message};this.message=a},notReady:function(a){this.toString=function(){return"NOT READY: "+this.message};this.message=a}}};
"undefined"!=typeof module&&module.exports&&(module.exports=sjcl);
sjcl.cipher.aes=function(a){this.j[0][0][0]||this.D();var b,c,d,e,f=this.j[0][4],g=this.j[1];b=a.length;var h=1;4!==b&&(6!==b&&8!==b)&&q(new sjcl.exception.invalid("invalid aes key size"));this.a=[d=a.slice(0),e=[]];for(a=b;a<4*b+28;a++){c=d[a-1];if(0===a%b||8===b&&4===a%b)c=f[c>>>24]<<24^f[c>>16&255]<<16^f[c>>8&255]<<8^f[c&255],0===a%b&&(c=c<<8^c>>>24^h<<24,h=h<<1^283*(h>>7));d[a]=d[a-b]^c}for(b=0;a;b++,a--)c=d[b&3?a:a-4],e[b]=4>=a||4>b?c:g[0][f[c>>>24]]^g[1][f[c>>16&255]]^g[2][f[c>>8&255]]^g[3][f[c&
255]]};
sjcl.cipher.aes.prototype={encrypt:function(a){return y(this,a,0)},decrypt:function(a){return y(this,a,1)},j:[[[],[],[],[],[]],[[],[],[],[],[]]],D:function(){var a=this.j[0],b=this.j[1],c=a[4],d=b[4],e,f,g,h=[],l=[],k,n,m,p;for(e=0;0x100>e;e++)l[(h[e]=e<<1^283*(e>>7))^e]=e;for(f=g=0;!c[f];f^=k||1,g=l[g]||1){m=g^g<<1^g<<2^g<<3^g<<4;m=m>>8^m&255^99;c[f]=m;d[m]=f;n=h[e=h[k=h[f]]];p=0x1010101*n^0x10001*e^0x101*k^0x1010100*f;n=0x101*h[m]^0x1010100*m;for(e=0;4>e;e++)a[e][f]=n=n<<24^n>>>8,b[e][m]=p=p<<24^p>>>8}for(e=
0;5>e;e++)a[e]=a[e].slice(0),b[e]=b[e].slice(0)}};
function y(a,b,c){4!==b.length&&q(new sjcl.exception.invalid("invalid aes block size"));var d=a.a[c],e=b[0]^d[0],f=b[c?3:1]^d[1],g=b[2]^d[2];b=b[c?1:3]^d[3];var h,l,k,n=d.length/4-2,m,p=4,s=[0,0,0,0];h=a.j[c];a=h[0];var r=h[1],v=h[2],w=h[3],x=h[4];for(m=0;m<n;m++)h=a[e>>>24]^r[f>>16&255]^v[g>>8&255]^w[b&255]^d[p],l=a[f>>>24]^r[g>>16&255]^v[b>>8&255]^w[e&255]^d[p+1],k=a[g>>>24]^r[b>>16&255]^v[e>>8&255]^w[f&255]^d[p+2],b=a[b>>>24]^r[e>>16&255]^v[f>>8&255]^w[g&255]^d[p+3],p+=4,e=h,f=l,g=k;for(m=0;4>
m;m++)s[c?3&-m:m]=x[e>>>24]<<24^x[f>>16&255]<<16^x[g>>8&255]<<8^x[b&255]^d[p++],h=e,e=f,f=g,g=b,b=h;return s}
sjcl.bitArray={bitSlice:function(a,b,c){a=sjcl.bitArray.O(a.slice(b/32),32-(b&31)).slice(1);return c===t?a:sjcl.bitArray.clamp(a,c-b)},extract:function(a,b,c){var d=Math.floor(-b-c&31);return((b+c-1^b)&-32?a[b/32|0]<<32-d^a[b/32+1|0]>>>d:a[b/32|0]>>>d)&(1<<c)-1},concat:function(a,b){if(0===a.length||0===b.length)return a.concat(b);var c=a[a.length-1],d=sjcl.bitArray.getPartial(c);return 32===d?a.concat(b):sjcl.bitArray.O(b,d,c|0,a.slice(0,a.length-1))},bitLength:function(a){var b=a.length;return 0===
b?0:32*(b-1)+sjcl.bitArray.getPartial(a[b-1])},clamp:function(a,b){if(32*a.length<b)return a;a=a.slice(0,Math.ceil(b/32));var c=a.length;b&=31;0<c&&b&&(a[c-1]=sjcl.bitArray.partial(b,a[c-1]&2147483648>>b-1,1));return a},partial:function(a,b,c){return 32===a?b:(c?b|0:b<<32-a)+0x10000000000*a},getPartial:function(a){return Math.round(a/0x10000000000)||32},equal:function(a,b){if(sjcl.bitArray.bitLength(a)!==sjcl.bitArray.bitLength(b))return u;var c=0,d;for(d=0;d<a.length;d++)c|=a[d]^b[d];return 0===
c},O:function(a,b,c,d){var e;e=0;for(d===t&&(d=[]);32<=b;b-=32)d.push(c),c=0;if(0===b)return d.concat(a);for(e=0;e<a.length;e++)d.push(c|a[e]>>>b),c=a[e]<<32-b;e=a.length?a[a.length-1]:0;a=sjcl.bitArray.getPartial(e);d.push(sjcl.bitArray.partial(b+a&31,32<b+a?c:d.pop(),1));return d},k:function(a,b){return[a[0]^b[0],a[1]^b[1],a[2]^b[2],a[3]^b[3]]}};
sjcl.codec.utf8String={fromBits:function(a){var b="",c=sjcl.bitArray.bitLength(a),d,e;for(d=0;d<c/8;d++)0===(d&3)&&(e=a[d/4]),b+=String.fromCharCode(e>>>24),e<<=8;return decodeURIComponent(escape(b))},toBits:function(a){a=unescape(encodeURIComponent(a));var b=[],c,d=0;for(c=0;c<a.length;c++)d=d<<8|a.charCodeAt(c),3===(c&3)&&(b.push(d),d=0);c&3&&b.push(sjcl.bitArray.partial(8*(c&3),d));return b}};
sjcl.codec.hex={fromBits:function(a){var b="",c;for(c=0;c<a.length;c++)b+=((a[c]|0)+0xf00000000000).toString(16).substr(4);return b.substr(0,sjcl.bitArray.bitLength(a)/4)},toBits:function(a){var b,c=[],d;a=a.replace(/\s|0x/g,"");d=a.length;a+="00000000";for(b=0;b<a.length;b+=8)c.push(parseInt(a.substr(b,8),16)^0);return sjcl.bitArray.clamp(c,4*d)}};
sjcl.codec.base64={I:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",fromBits:function(a,b,c){var d="",e=0,f=sjcl.codec.base64.I,g=0,h=sjcl.bitArray.bitLength(a);c&&(f=f.substr(0,62)+"-_");for(c=0;6*d.length<h;)d+=f.charAt((g^a[c]>>>e)>>>26),6>e?(g=a[c]<<6-e,e+=26,c++):(g<<=6,e-=6);for(;d.length&3&&!b;)d+="=";return d},toBits:function(a,b){a=a.replace(/\s|=/g,"");var c=[],d,e=0,f=sjcl.codec.base64.I,g=0,h;b&&(f=f.substr(0,62)+"-_");for(d=0;d<a.length;d++)h=f.indexOf(a.charAt(d)),
0>h&&q(new sjcl.exception.invalid("this isn't base64!")),26<e?(e-=26,c.push(g^h>>>e),g=h<<32-e):(e+=6,g^=h<<32-e);e&56&&c.push(sjcl.bitArray.partial(e&56,g,1));return c}};sjcl.codec.base64url={fromBits:function(a){return sjcl.codec.base64.fromBits(a,1,1)},toBits:function(a){return sjcl.codec.base64.toBits(a,1)}};sjcl.hash.sha256=function(a){this.a[0]||this.D();a?(this.q=a.q.slice(0),this.m=a.m.slice(0),this.g=a.g):this.reset()};sjcl.hash.sha256.hash=function(a){return(new sjcl.hash.sha256).update(a).finalize()};
sjcl.hash.sha256.prototype={blockSize:512,reset:function(){this.q=this.M.slice(0);this.m=[];this.g=0;return this},update:function(a){"string"===typeof a&&(a=sjcl.codec.utf8String.toBits(a));var b,c=this.m=sjcl.bitArray.concat(this.m,a);b=this.g;a=this.g=b+sjcl.bitArray.bitLength(a);for(b=512+b&-512;b<=a;b+=512)z(this,c.splice(0,16));return this},finalize:function(){var a,b=this.m,c=this.q,b=sjcl.bitArray.concat(b,[sjcl.bitArray.partial(1,1)]);for(a=b.length+2;a&15;a++)b.push(0);b.push(Math.floor(this.g/
4294967296));for(b.push(this.g|0);b.length;)z(this,b.splice(0,16));this.reset();return c},M:[],a:[],D:function(){function a(a){return 0x100000000*(a-Math.floor(a))|0}var b=0,c=2,d;a:for(;64>b;c++){for(d=2;d*d<=c;d++)if(0===c%d)continue a;8>b&&(this.M[b]=a(Math.pow(c,0.5)));this.a[b]=a(Math.pow(c,1/3));b++}}};
function z(a,b){var c,d,e,f=b.slice(0),g=a.q,h=a.a,l=g[0],k=g[1],n=g[2],m=g[3],p=g[4],s=g[5],r=g[6],v=g[7];for(c=0;64>c;c++)16>c?d=f[c]:(d=f[c+1&15],e=f[c+14&15],d=f[c&15]=(d>>>7^d>>>18^d>>>3^d<<25^d<<14)+(e>>>17^e>>>19^e>>>10^e<<15^e<<13)+f[c&15]+f[c+9&15]|0),d=d+v+(p>>>6^p>>>11^p>>>25^p<<26^p<<21^p<<7)+(r^p&(s^r))+h[c],v=r,r=s,s=p,p=m+d|0,m=n,n=k,k=l,l=d+(k&n^m&(k^n))+(k>>>2^k>>>13^k>>>22^k<<30^k<<19^k<<10)|0;g[0]=g[0]+l|0;g[1]=g[1]+k|0;g[2]=g[2]+n|0;g[3]=g[3]+m|0;g[4]=g[4]+p|0;g[5]=g[5]+s|0;g[6]=
g[6]+r|0;g[7]=g[7]+v|0}
sjcl.mode.ccm={name:"ccm",encrypt:function(a,b,c,d,e){var f,g=b.slice(0),h=sjcl.bitArray,l=h.bitLength(c)/8,k=h.bitLength(g)/8;e=e||64;d=d||[];7>l&&q(new sjcl.exception.invalid("ccm: iv must be at least 7 bytes"));for(f=2;4>f&&k>>>8*f;f++);f<15-l&&(f=15-l);c=h.clamp(c,8*(15-f));b=sjcl.mode.ccm.K(a,b,c,d,e,f);g=sjcl.mode.ccm.n(a,g,c,b,e,f);return h.concat(g.data,g.tag)},decrypt:function(a,b,c,d,e){e=e||64;d=d||[];var f=sjcl.bitArray,g=f.bitLength(c)/8,h=f.bitLength(b),l=f.clamp(b,h-e),k=f.bitSlice(b,
h-e),h=(h-e)/8;7>g&&q(new sjcl.exception.invalid("ccm: iv must be at least 7 bytes"));for(b=2;4>b&&h>>>8*b;b++);b<15-g&&(b=15-g);c=f.clamp(c,8*(15-b));l=sjcl.mode.ccm.n(a,l,c,k,e,b);a=sjcl.mode.ccm.K(a,l.data,c,d,e,b);f.equal(l.tag,a)||q(new sjcl.exception.corrupt("ccm: tag doesn't match"));return l.data},K:function(a,b,c,d,e,f){var g=[],h=sjcl.bitArray,l=h.k;e/=8;(e%2||4>e||16<e)&&q(new sjcl.exception.invalid("ccm: invalid tag length"));(0xffffffff<d.length||0xffffffff<b.length)&&q(new sjcl.exception.bug("ccm: can't deal with 4GiB or more data"));
f=[h.partial(8,(d.length?64:0)|e-2<<2|f-1)];f=h.concat(f,c);f[3]|=h.bitLength(b)/8;f=a.encrypt(f);if(d.length){c=h.bitLength(d)/8;65279>=c?g=[h.partial(16,c)]:0xffffffff>=c&&(g=h.concat([h.partial(16,65534)],[c]));g=h.concat(g,d);for(d=0;d<g.length;d+=4)f=a.encrypt(l(f,g.slice(d,d+4).concat([0,0,0])))}for(d=0;d<b.length;d+=4)f=a.encrypt(l(f,b.slice(d,d+4).concat([0,0,0])));return h.clamp(f,8*e)},n:function(a,b,c,d,e,f){var g,h=sjcl.bitArray;g=h.k;var l=b.length,k=h.bitLength(b);c=h.concat([h.partial(8,
f-1)],c).concat([0,0,0]).slice(0,4);d=h.bitSlice(g(d,a.encrypt(c)),0,e);if(!l)return{tag:d,data:[]};for(g=0;g<l;g+=4)c[3]++,e=a.encrypt(c),b[g]^=e[0],b[g+1]^=e[1],b[g+2]^=e[2],b[g+3]^=e[3];return{tag:d,data:h.clamp(b,k)}}};
sjcl.mode.ocb2={name:"ocb2",encrypt:function(a,b,c,d,e,f){128!==sjcl.bitArray.bitLength(c)&&q(new sjcl.exception.invalid("ocb iv must be 128 bits"));var g,h=sjcl.mode.ocb2.G,l=sjcl.bitArray,k=l.k,n=[0,0,0,0];c=h(a.encrypt(c));var m,p=[];d=d||[];e=e||64;for(g=0;g+4<b.length;g+=4)m=b.slice(g,g+4),n=k(n,m),p=p.concat(k(c,a.encrypt(k(c,m)))),c=h(c);m=b.slice(g);b=l.bitLength(m);g=a.encrypt(k(c,[0,0,0,b]));m=l.clamp(k(m.concat([0,0,0]),g),b);n=k(n,k(m.concat([0,0,0]),g));n=a.encrypt(k(n,k(c,h(c))));d.length&&
(n=k(n,f?d:sjcl.mode.ocb2.pmac(a,d)));return p.concat(l.concat(m,l.clamp(n,e)))},decrypt:function(a,b,c,d,e,f){128!==sjcl.bitArray.bitLength(c)&&q(new sjcl.exception.invalid("ocb iv must be 128 bits"));e=e||64;var g=sjcl.mode.ocb2.G,h=sjcl.bitArray,l=h.k,k=[0,0,0,0],n=g(a.encrypt(c)),m,p,s=sjcl.bitArray.bitLength(b)-e,r=[];d=d||[];for(c=0;c+4<s/32;c+=4)m=l(n,a.decrypt(l(n,b.slice(c,c+4)))),k=l(k,m),r=r.concat(m),n=g(n);p=s-32*c;m=a.encrypt(l(n,[0,0,0,p]));m=l(m,h.clamp(b.slice(c),p).concat([0,0,0]));
k=l(k,m);k=a.encrypt(l(k,l(n,g(n))));d.length&&(k=l(k,f?d:sjcl.mode.ocb2.pmac(a,d)));h.equal(h.clamp(k,e),h.bitSlice(b,s))||q(new sjcl.exception.corrupt("ocb: tag doesn't match"));return r.concat(h.clamp(m,p))},pmac:function(a,b){var c,d=sjcl.mode.ocb2.G,e=sjcl.bitArray,f=e.k,g=[0,0,0,0],h=a.encrypt([0,0,0,0]),h=f(h,d(d(h)));for(c=0;c+4<b.length;c+=4)h=d(h),g=f(g,a.encrypt(f(h,b.slice(c,c+4))));c=b.slice(c);128>e.bitLength(c)&&(h=f(h,d(h)),c=e.concat(c,[-2147483648,0,0,0]));g=f(g,c);return a.encrypt(f(d(f(h,
d(h))),g))},G:function(a){return[a[0]<<1^a[1]>>>31,a[1]<<1^a[2]>>>31,a[2]<<1^a[3]>>>31,a[3]<<1^135*(a[0]>>>31)]}};
sjcl.mode.gcm={name:"gcm",encrypt:function(a,b,c,d,e){var f=b.slice(0);b=sjcl.bitArray;d=d||[];a=sjcl.mode.gcm.n(!0,a,f,d,c,e||128);return b.concat(a.data,a.tag)},decrypt:function(a,b,c,d,e){var f=b.slice(0),g=sjcl.bitArray,h=g.bitLength(f);e=e||128;d=d||[];e<=h?(b=g.bitSlice(f,h-e),f=g.bitSlice(f,0,h-e)):(b=f,f=[]);a=sjcl.mode.gcm.n(u,a,f,d,c,e);g.equal(a.tag,b)||q(new sjcl.exception.corrupt("gcm: tag doesn't match"));return a.data},U:function(a,b){var c,d,e,f,g,h=sjcl.bitArray.k;e=[0,0,0,0];f=b.slice(0);
for(c=0;128>c;c++){(d=0!==(a[Math.floor(c/32)]&1<<31-c%32))&&(e=h(e,f));g=0!==(f[3]&1);for(d=3;0<d;d--)f[d]=f[d]>>>1|(f[d-1]&1)<<31;f[0]>>>=1;g&&(f[0]^=-0x1f000000)}return e},f:function(a,b,c){var d,e=c.length;b=b.slice(0);for(d=0;d<e;d+=4)b[0]^=0xffffffff&c[d],b[1]^=0xffffffff&c[d+1],b[2]^=0xffffffff&c[d+2],b[3]^=0xffffffff&c[d+3],b=sjcl.mode.gcm.U(b,a);return b},n:function(a,b,c,d,e,f){var g,h,l,k,n,m,p,s,r=sjcl.bitArray;m=c.length;p=r.bitLength(c);s=r.bitLength(d);h=r.bitLength(e);g=b.encrypt([0,
0,0,0]);96===h?(e=e.slice(0),e=r.concat(e,[1])):(e=sjcl.mode.gcm.f(g,[0,0,0,0],e),e=sjcl.mode.gcm.f(g,e,[0,0,Math.floor(h/0x100000000),h&0xffffffff]));h=sjcl.mode.gcm.f(g,[0,0,0,0],d);n=e.slice(0);d=h.slice(0);a||(d=sjcl.mode.gcm.f(g,h,c));for(k=0;k<m;k+=4)n[3]++,l=b.encrypt(n),c[k]^=l[0],c[k+1]^=l[1],c[k+2]^=l[2],c[k+3]^=l[3];c=r.clamp(c,p);a&&(d=sjcl.mode.gcm.f(g,h,c));a=[Math.floor(s/0x100000000),s&0xffffffff,Math.floor(p/0x100000000),p&0xffffffff];d=sjcl.mode.gcm.f(g,d,a);l=b.encrypt(e);d[0]^=l[0];
d[1]^=l[1];d[2]^=l[2];d[3]^=l[3];return{tag:r.bitSlice(d,0,f),data:c}}};sjcl.misc.hmac=function(a,b){this.L=b=b||sjcl.hash.sha256;var c=[[],[]],d,e=b.prototype.blockSize/32;this.o=[new b,new b];a.length>e&&(a=b.hash(a));for(d=0;d<e;d++)c[0][d]=a[d]^909522486,c[1][d]=a[d]^1549556828;this.o[0].update(c[0]);this.o[1].update(c[1])};sjcl.misc.hmac.prototype.encrypt=sjcl.misc.hmac.prototype.mac=function(a){a=(new this.L(this.o[0])).update(a).finalize();return(new this.L(this.o[1])).update(a).finalize()};
sjcl.misc.pbkdf2=function(a,b,c,d,e){c=c||1E3;(0>d||0>c)&&q(sjcl.exception.invalid("invalid params to pbkdf2"));"string"===typeof a&&(a=sjcl.codec.utf8String.toBits(a));e=e||sjcl.misc.hmac;a=new e(a);var f,g,h,l,k=[],n=sjcl.bitArray;for(l=1;32*k.length<(d||1);l++){e=f=a.encrypt(n.concat(b,[l]));for(g=1;g<c;g++){f=a.encrypt(f);for(h=0;h<f.length;h++)e[h]^=f[h]}k=k.concat(e)}d&&(k=n.clamp(k,d));return k};
sjcl.prng=function(a){this.b=[new sjcl.hash.sha256];this.h=[0];this.F=0;this.t={};this.C=0;this.J={};this.N=this.c=this.i=this.T=0;this.a=[0,0,0,0,0,0,0,0];this.e=[0,0,0,0];this.A=t;this.B=a;this.p=u;this.z={progress:{},seeded:{}};this.l=this.S=0;this.u=1;this.w=2;this.Q=0x10000;this.H=[0,48,64,96,128,192,0x100,384,512,768,1024];this.R=3E4;this.P=80};
sjcl.prng.prototype={randomWords:function(a,b){var c=[],d;d=this.isReady(b);var e;d===this.l&&q(new sjcl.exception.notReady("generator isn't seeded"));if(d&this.w){d=!(d&this.u);e=[];var f=0,g;this.N=e[0]=(new Date).valueOf()+this.R;for(g=0;16>g;g++)e.push(0x100000000*Math.random()|0);for(g=0;g<this.b.length&&!(e=e.concat(this.b[g].finalize()),f+=this.h[g],this.h[g]=0,!d&&this.F&1<<g);g++);this.F>=1<<this.b.length&&(this.b.push(new sjcl.hash.sha256),this.h.push(0));this.c-=f;f>this.i&&(this.i=f);this.F++;
this.a=sjcl.hash.sha256.hash(this.a.concat(e));this.A=new sjcl.cipher.aes(this.a);for(d=0;4>d&&!(this.e[d]=this.e[d]+1|0,this.e[d]);d++);}for(d=0;d<a;d+=4)0===(d+1)%this.Q&&A(this),e=B(this),c.push(e[0],e[1],e[2],e[3]);A(this);return c.slice(0,a)},setDefaultParanoia:function(a){this.B=a},addEntropy:function(a,b,c){c=c||"user";var d,e,f=(new Date).valueOf(),g=this.t[c],h=this.isReady(),l=0;d=this.J[c];d===t&&(d=this.J[c]=this.T++);g===t&&(g=this.t[c]=0);this.t[c]=(this.t[c]+1)%this.b.length;switch(typeof a){case "number":b===
t&&(b=1);this.b[g].update([d,this.C++,1,b,f,1,a|0]);break;case "object":c=Object.prototype.toString.call(a);if("[object Uint32Array]"===c){e=[];for(c=0;c<a.length;c++)e.push(a[c]);a=e}else{"[object Array]"!==c&&(l=1);for(c=0;c<a.length&&!l;c++)"number"!=typeof a[c]&&(l=1)}if(!l){if(b===t)for(c=b=0;c<a.length;c++)for(e=a[c];0<e;)b++,e>>>=1;this.b[g].update([d,this.C++,2,b,f,a.length].concat(a))}break;case "string":b===t&&(b=a.length);this.b[g].update([d,this.C++,3,b,f,a.length]);this.b[g].update(a);
break;default:l=1}l&&q(new sjcl.exception.bug("random: addEntropy only supports number, array of numbers or string"));this.h[g]+=b;this.c+=b;h===this.l&&(this.isReady()!==this.l&&C("seeded",Math.max(this.i,this.c)),C("progress",this.getProgress()))},isReady:function(a){a=this.H[a!==t?a:this.B];return this.i&&this.i>=a?this.h[0]>this.P&&(new Date).valueOf()>this.N?this.w|this.u:this.u:this.c>=a?this.w|this.l:this.l},getProgress:function(a){a=this.H[a?a:this.B];return this.i>=a?1:this.c>a?1:this.c/
a},startCollectors:function(){this.p||(window.addEventListener?(window.addEventListener("load",this.r,u),window.addEventListener("mousemove",this.s,u)):document.attachEvent?(document.attachEvent("onload",this.r),document.attachEvent("onmousemove",this.s)):q(new sjcl.exception.bug("can't attach event")),this.p=!0)},stopCollectors:function(){this.p&&(window.removeEventListener?(window.removeEventListener("load",this.r,u),window.removeEventListener("mousemove",this.s,u)):window.detachEvent&&(window.detachEvent("onload",
this.r),window.detachEvent("onmousemove",this.s)),this.p=u)},addEventListener:function(a,b){this.z[a][this.S++]=b},removeEventListener:function(a,b){var c,d,e=this.z[a],f=[];for(d in e)e.hasOwnProperty(d)&&e[d]===b&&f.push(d);for(c=0;c<f.length;c++)d=f[c],delete e[d]},s:function(a){sjcl.random.addEntropy([a.x||a.clientX||a.offsetX||0,a.y||a.clientY||a.offsetY||0],2,"mouse")},r:function(){sjcl.random.addEntropy((new Date).valueOf(),2,"loadtime")}};
function C(a,b){var c,d=sjcl.random.z[a],e=[];for(c in d)d.hasOwnProperty(c)&&e.push(d[c]);for(c=0;c<e.length;c++)e[c](b)}function A(a){a.a=B(a).concat(B(a));a.A=new sjcl.cipher.aes(a.a)}function B(a){for(var b=0;4>b&&!(a.e[b]=a.e[b]+1|0,a.e[b]);b++);return a.A.encrypt(a.e)}sjcl.random=new sjcl.prng(6);try{var D=new Uint32Array(32);crypto.getRandomValues(D);sjcl.random.addEntropy(D,1024,"crypto['getRandomValues']")}catch(E){}
sjcl.json={defaults:{v:1,iter:1E3,ks:256,ts:64,mode:"ccm",adata:"",cipher:"aes"},encrypt:function(a,b,c,d){c=c||{};d=d||{};var e=sjcl.json,f=e.d({iv:sjcl.random.randomWords(4,0)},e.defaults),g;e.d(f,c);c=f.adata;"string"===typeof f.salt&&(f.salt=sjcl.codec.base64.toBits(f.salt));"string"===typeof f.iv&&(f.iv=sjcl.codec.base64.toBits(f.iv));(!sjcl.mode[f.mode]||!sjcl.cipher[f.cipher]||"string"===typeof a&&100>=f.iter||64!==f.ts&&96!==f.ts&&128!==f.ts||128!==f.ks&&192!==f.ks&&0x100!==f.ks||2>f.iv.length||
4<f.iv.length)&&q(new sjcl.exception.invalid("json encrypt: invalid parameters"));"string"===typeof a&&(g=sjcl.misc.cachedPbkdf2(a,f),a=g.key.slice(0,f.ks/32),f.salt=g.salt);"string"===typeof b&&(b=sjcl.codec.utf8String.toBits(b));"string"===typeof c&&(c=sjcl.codec.utf8String.toBits(c));g=new sjcl.cipher[f.cipher](a);e.d(d,f);d.key=a;f.ct=sjcl.mode[f.mode].encrypt(g,b,f.iv,c,f.ts);return e.encode(f)},decrypt:function(a,b,c,d){c=c||{};d=d||{};var e=sjcl.json;b=e.d(e.d(e.d({},e.defaults),e.decode(b)),
c,!0);var f;c=b.adata;"string"===typeof b.salt&&(b.salt=sjcl.codec.base64.toBits(b.salt));"string"===typeof b.iv&&(b.iv=sjcl.codec.base64.toBits(b.iv));(!sjcl.mode[b.mode]||!sjcl.cipher[b.cipher]||"string"===typeof a&&100>=b.iter||64!==b.ts&&96!==b.ts&&128!==b.ts||128!==b.ks&&192!==b.ks&&0x100!==b.ks||!b.iv||2>b.iv.length||4<b.iv.length)&&q(new sjcl.exception.invalid("json decrypt: invalid parameters"));"string"===typeof a&&(f=sjcl.misc.cachedPbkdf2(a,b),a=f.key.slice(0,b.ks/32),b.salt=f.salt);"string"===
typeof c&&(c=sjcl.codec.utf8String.toBits(c));f=new sjcl.cipher[b.cipher](a);c=sjcl.mode[b.mode].decrypt(f,b.ct,b.iv,c,b.ts);e.d(d,b);d.key=a;return sjcl.codec.utf8String.fromBits(c)},encode:function(a){var b,c="{",d="";for(b in a)if(a.hasOwnProperty(b))switch(b.match(/^[a-z0-9]+$/i)||q(new sjcl.exception.invalid("json encode: invalid property name")),c+=d+'"'+b+'":',d=",",typeof a[b]){case "number":case "boolean":c+=a[b];break;case "string":c+='"'+escape(a[b])+'"';break;case "object":c+='"'+sjcl.codec.base64.fromBits(a[b],
0)+'"';break;default:q(new sjcl.exception.bug("json encode: unsupported type"))}return c+"}"},decode:function(a){a=a.replace(/\s/g,"");a.match(/^\{.*\}$/)||q(new sjcl.exception.invalid("json decode: this isn't json!"));a=a.replace(/^\{|\}$/g,"").split(/,/);var b={},c,d;for(c=0;c<a.length;c++)(d=a[c].match(/^(?:(["']?)([a-z][a-z0-9]*)\1):(?:(\d+)|"([a-z0-9+\/%*_.@=\-]*)")$/i))||q(new sjcl.exception.invalid("json decode: this isn't json!")),b[d[2]]=d[3]?parseInt(d[3],10):d[2].match(/^(ct|salt|iv)$/)?
sjcl.codec.base64.toBits(d[4]):unescape(d[4]);return b},d:function(a,b,c){a===t&&(a={});if(b===t)return a;for(var d in b)b.hasOwnProperty(d)&&(c&&(a[d]!==t&&a[d]!==b[d])&&q(new sjcl.exception.invalid("required parameter overridden")),a[d]=b[d]);return a},X:function(a,b){var c={},d;for(d in a)a.hasOwnProperty(d)&&a[d]!==b[d]&&(c[d]=a[d]);return c},W:function(a,b){var c={},d;for(d=0;d<b.length;d++)a[b[d]]!==t&&(c[b[d]]=a[b[d]]);return c}};sjcl.encrypt=sjcl.json.encrypt;sjcl.decrypt=sjcl.json.decrypt;
sjcl.misc.V={};sjcl.misc.cachedPbkdf2=function(a,b){var c=sjcl.misc.V,d;b=b||{};d=b.iter||1E3;c=c[a]=c[a]||{};d=c[d]=c[d]||{firstSalt:b.salt&&b.salt.length?b.salt.slice(0):sjcl.random.randomWords(2,0)};c=b.salt===t?d.firstSalt:b.salt;d[c]=d[c]||sjcl.misc.pbkdf2(a,c,b.iter);return{key:d[c].slice(0),salt:c.slice(0)}};
